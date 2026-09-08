# `verrex` — the framework runtime

What the user actually imports from when writing components.
Public surface (from `index.ts`):

- `h` — the view factory for INTRINSIC elements only (the compile target
  for lowercase `<div>` source syntax; component tags lower to direct
  calls) + `h.reader` (the compiler hook for `get(...)` expressions)
- `Component` — `Component.make`, the canonical component constructor
  (a thin seam over `Effect.fn`; see "`Component.make`" below)
- `atom` / `fn` — effect-atom's `Atom.make` / `Atom.fn` with `R`/`E` owned by
  the CALLER (`atom.ts`). No
  `Atom.runtime(layer)`: the wrapper captures the constructing fiber's
  Context and provides it UNDER the atom's own services (`Context.merge(ctx,
own)` — the atom keeps its own `Scope`/`AtomRegistry`, so an atom-body
  resource dies with the atom, not the component; the component's span is
  captured too, so atom bodies trace under it). `R` rides to `mount`; a
  forgotten Layer is a compile error at the root; `E` sits on the
  `AsyncResult`. Result `R` = `Exclude<R, Scope | AtomRegistry> | AtomRegistry
| Scope` because the wrapper `Atom.mount`s the atom on the caller's Scope —
  that is what makes teardown cascade (row Scope closes → unmount → refcount
  0 → node disposed one dispatcher tick later → atom's own Scope closes,
  fibers interrupted) and keeps a handler-only `fn` alive between calls.
  `fn` returns a CALLABLE `AtomResultFn` (`send(arg)`, `send.interrupt`,
  `send.reset`; still `isAtom`, `Atom.map`, `get(send)`): the callable
  `Atom.set`s ITSELF (targeting the inner atom would create a second node
  and run the body twice). Footgun: Atom combinators (`keepAlive`,
  `withEquality`, …) return a NON-callable copy — use `Atom.set` on those.
  Deps inside bodies are `get(...)` (atoms only; no AtomRef bridge). Pinned by
  `atom.test-d.ts`
  (channels, missing-Layer compile error) and `testing/atom-fn.test.ts`
  (services vs own scope, lifetime, once-per-call, interrupt/reset, stream
  latest, span parent).
- `mount` — DOM renderer. **Requires `Effect<View<never>, never, R>`** (every
  error discharged), returns `Effect<void, never, R | AtomRegistry | Scope>`
- `For` — the keyed reactive list component (`View.List` IR node, `ListSource` = `Collection` | `Keyed`). Two
  overloads: `each: AtomRef.Collection<T>` (rows are the refs, keyed by
  identity, no `key`) and `each: Atom<ReadonlyArray<T>>` + `key` (rows are
  per-key `Atom<T>`s: `Atom.family` over an index-Map atom, `withEquality(
Equal.equals)` INSIDE the family fn — applied at the use site the
  combinator's new object would churn node identity — and a removed key holds
  its last value via `get.self()` because its row atom recomputes before the
  structural reconcile tears the row down). `children` is a 1-tuple (the
  compiler emits `children: [ … ]`). Row `E` (Effect or `View<E>`) is LIVE on
  the result — rows build on insert, after construction — and row `R` minus
  the runtime `Scope` folds. Pinned by `testing/for.test.ts` (both sources,
  DOM identity across moves, Equal-dedup = 0 cell recompute, row Scope
  release, channel pins).
- `On` — `<On value={x} Tag={(v) => …} … />`
  (`on.ts`): render a tagged value — or an atom/ref of one — by tag,
  with FAILURES BUBBLING BY DEFAULT. Generic over anything `_tag`ged
  (`Option`, `Result`, `AsyncResult`, `Exit`, a `Data.TaggedEnum` state
  union). Arms are PROPS. Every tag arm is optional (missing → nothing);
  `Waiting` (offered only for waiting-capable values, AsyncResult) wins over
  the tag arms while `waiting` is true — `builder.onWaiting` semantics,
  covers the first fetch too. EXCEPT a
  failure-carrying variant (`{ _tag: "Failure"; cause }` or `{ …; failure }`
  — the only two special-cased shapes): unhandled, it escalates as
  `View<E>`; the ERROR'S tags are arms too (`HttpError={(e, f) => …}` —
  leaf-handled, residual `Exclude<E, {_tag}>` rides to the nearest `Catch`;
  keyed by `K` = the arm keys present), and `Failure` takes the variant with
  its error NARROWED by the error-tag arms beside it (all handled → `never`). Dispatch: error-tag arm first,
  then `Failure`, else escalate. Interrupt-only causes are dropped. Handler
  returns fold (E live, R). Runtime: one `Atom.readable` (reads `on`,
  bridging a ref) whose emission is the handler result or an
  `Effect.failCause` — the fold's phase switch types it. THE idiom for
  rendering tagged / async values; the explicit alternatives
  (`AsyncResult.builder`, `Match.valueTags`) stay as an escape hatch for
  custom states. Pinned by `testing/on.test.ts`.
- `Catch` — view-level error boundary, a JSX tag with the same arm KEYS as `On` (`Tag={…}` = tag-selective, `Failure={…}` = catch-all; mirrors `Effect.catch*`; see "`Catch`" below). Handler signatures differ: `Catch` arms get `(error, reset)` / `(cause, reset)`; `On` arms get `(error, variant)` / `(variant)`.
- `Fragment` — `<>...</>` compile target (a direct-call component:
  `Fragment({ children: [...] })`, generic over the children tuple —
  also the canonical pattern for effectful-children components)
- Types: `View<E>`, `Props`, `FoldE`/`FoldLiveE`/`FoldR` (there is no
  `Tag*` family — component channels are ordinary child folds),
  `FoldPropsLiveE`/`FoldPropsR` (the props fold), `ArmR`/`FoldArmsR`
  (the arms fold),
  `IntrinsicProps`, `HtmlEventHandlers`, `OnArms`/`OnResidual` (`On`'s
  arm map + what rides on), `CatchArms` (`Catch`'s arm map), `Get` (the
  `get` reader signature), `Fn`/`AtomOptions`/`FnOptions` (`atom`/`fn` shapes), `RootSink`
  (the root cause sink reference `mount` installs)

This is where the **channel propagation contract lives** —
`h()`'s signature uses the fold conditional types to union every child's
channels into the result. Errors split by phase: **construction** errors
(`FoldE`) ride the result Effect's `E`; **live** errors a rendered
subtree can still produce (`FoldLiveE`) ride the `View<E>` success.
`R` unifies (`FoldR`). A component tag is not a fold case of its own:
the compiler lowers `<MyComp/>` to the direct call `MyComp({...})`, so a
component's channels surface as an ordinary Effect child of the
surrounding `h()`. **Props fold too**: `h`'s `_props` parameter is
generic (constrained by `IntrinsicProps`, which is what contextually types
the event argument), and an `on*` handler returning `Effect<_, E, R>`
contributes `E` to the element's LIVE channel (`FoldPropsLiveE` — the
element is already rendered when a handler runs, so live is the only honest
home) and `R` to its requirements (`FoldPropsR`). Only `on*`-keyed props
fold, EXCLUDING the bare key `on` — runtime parity: `applyProp` runs
returned Effects only for `on*` keys with `length > 2`; any other
function-valued attr is stringified, never invoked. Two more parity rules
live in `HandlerChannels` (Fold.ts): an `any`-typed handler/return is INERT
(unguarded it infers `unknown`, which silently swallows sibling handlers'
errors one fold up and poisons `R`), and an AtomRef-valued handler folds
THROUGH to the inner function (applyProp's AtomRef branch unwraps and
re-applies it live). Extracted handlers should be annotated with the
exported `EventHandler<Ev, E, R>` — a wider hand annotation erases the
channels (see Html.ts).
**Phase switch at the Atom/AtomRef boundary**: whatever an `Atom`/`AtomRef` EMITS runs after construction — mount
re-coerces each emission and executes an emitted Effect at render time via
`coerceSync` — so `ChildE<Atom<T>> = never` and `ChildLiveE<Atom<T>> =
ChildE<T> | ChildLiveE<T>`. An `Atom<Effect<View, E>>` child is a `View<E>`.
This is what makes an unhandled `On` failure (or the escape-hatch
`Atom.map(result, r => AsyncResult.builder(r)….onFailure(Effect.failCause)
.exhaustive())`) escalate a typed failure to the nearest `Catch` with no
extra boundary primitive — and what closes the old
"reactive re-render whose Effect fails is caught only at runtime" hole.
Pinned by Fold.test-d §6/§28 and `testing/atom-escalate.test.ts`.
`mount` requires both error channels `never`;
`Catch` discharges them. A forgotten boundary is a compile error that
names the error — the runtime counterpart of a forgotten Layer naming a
service. See [`types/Fold.ts`](./types/Fold.ts).

### Compiler-slot parameter naming — coupled to the TS plugin

The `HFn` type's parameters are `_tag`, `_props`, `_children` (in
`h.ts`) and `Component.make`'s name slot is `_name` (in `Component.ts`)
— underscore prefix marks a compiler-filled slot. This is **coupled to
[`@verrex/ts-plugin`](../../../ts-plugin/AGENTS.md)** — the plugin's
inlay-hint filter drops any hint matching
`/^(?:_?(?:tag|props|children)|_name):?$/i`, so these labels never
appear in the editor margin (without the filter, the injected name
argument's `_name:` hint would render after the call's `})`). `_name`
is matched underscore-only — bare `name:` is a common user parameter
and keeps its hint. If you rename a slot, update the regex.

## Files

| File                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `h.ts`                 | `h()` factory; re-exports `get` and exposes `reader.ts`'s `reader` as `h.reader` (the compiler's `get(...)`-expression wrap)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `reader.ts`            | The ambient reader: the `null`-frame stack, `get`, the guarded readable behind `h.reader`, `readSource` (Atom/AtomRef/plain through a registry get), `guardRegistryRead` (throw → `Effect.die`), and the `rootSinks` WeakMap + `bindRootSink` (a reader's re-render throw reports to the mount's ROOT sink as a non-fatal defect — see "Runtime error routing")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tag-dispatch.ts`      | The shared tag-map rule: `matchTagArm` (which arm a cause hits) + `assertHandlerMap` (plain-object / function-valued guard), consumed by `Catch` and `On`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `on.ts`                | `On` — render a tagged value (`AsyncResult`, `Result`, `Option`, `Exit`, own unions): value-tag arms, error-tag arms, `Failure`, `Waiting`; unhandled failures ride `View<E>`. Types: `TagHandlers`, `Residual`, `NarrowFailure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `atom.ts`              | `atom` / `fn` — caller-owned-`R` wrappers over `Atom.make` / `Atom.fn` (context capture UNDER own services, `Atom.mount` on the caller's Scope, callable `fn`); see the surface bullet above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Component.ts`         | `Component.make` — the canonical component constructor (traced `Effect.fn` seam + compiler-filled name slot). `Component.test.ts` pins the span-in-Cause; `Component.test-d.ts` pins the channel inference and generic preservation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `coerce.ts`            | `coerceAsync` (any child shape → `Effect<View>`) and `coerceSync` (render-time emission → `View`; takes a `SyncRunner` — runs on the owning node's context, with an `Exit` fast path so `Effect.succeed` children don't spin a fiber). Internal; not re-exported from `index.ts`. Owns `isAtomRef` (brand check against `AtomRef.TypeId`), `isHandlerKey` (THE handler-key gate, shared with `applyProp` + `h()`'s capture predicate, mirrored by the type fold), and `bridgeAtom` (the AtomRef→Atom bridge `h.reader`'s `get(ref)` goes through)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `View.ts`              | `View<E>` IR. The runtime shape is `ViewNode` — a hand-written union of 7 phantom-free named interfaces (`ViewText`…`ViewBoundary`, `ViewEmpty`); constructors via `Data.taggedEnum<ViewNode>()`. `View<E = never> = ViewNode & ViewErr<E>` layers the runtime-error channel on via a covariant phantom (`ViewErr`), so `View<HttpError>` ⊄ `View<never>` (mount can require it) while a `ViewNode` ⊂ any `View<E>` (constructors need no casts). Plus `isView`, `VIEW_TAGS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mount.ts`             | DOM renderer. `buildDom(view, ctx, scope) → Node` (`ctx: BuildCtx = { registry, context, sink, runSyncExit, ownerScope }` — `runSyncExit` is a context-paired `Effect.runSyncExitWith` cache for `coerceSync`; `ownerScope` is the handler-dispatch owner; the Element handler path takes `context`/`sink`/`registry`/`ownerScope` directly, never the ctx), `mount(app, el)`. Cleanup is delegated to `Scope` — every subscription/listener/release registers a finalizer on the scope it was created in, and parent-fork cascade tears them down on close. Owns `buildScopedChild` (the one place a dynamic subtree gets a parent-linked child scope), the `List` **interpreter** that applies a `reconcile.ts` plan to real DOM + scopes, and the error **sink** (runs event-handler Effects + routes runtime failures). Form-control props (`value`/`checked`/`selected`/`indeterminate`) write DOM _properties_ — post-dirty-flag, attributes stop mirroring — with initial writes deferred past the children loop (`select.value` needs its `<option>`s) and guarded against no-op writes (caret); pins in `testing/form-props.test.ts`. **Known limitation (#156):** options arriving _after_ the value write silently reset the select to its first option |
| `reconcile.ts`         | Pure keyed-list diff. `plan(prevKeys, nextKeys) → ReconcileOp[]` over opaque keys — no DOM, no `Scope`, no `Effect`. The runtime's highest-bug-density logic, made exhaustively unit-testable. `mount`'s `List` case interprets the ops                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `index.ts`             | Public exports + `For` (keyed list over a `ListSource`), `Catch` (one signature, tag arms + `Failure`, over an internal `makeBoundary`), `Fragment`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `coerce.test.ts`       | Vitest suite for `coerceAsync` / `coerceSync` (parity + the sync/async asymmetry pin)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `reconcile.test.ts`    | Pure diff tests — an apply-to-array oracle (plan turns `prev` into `next`) plus exact op-sequence pins (move-minimality; index updates on shift)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `types/Fold.ts`        | `ChildE`/`ChildLiveE`/`ChildR` + `FoldE`/`FoldLiveE`/`FoldR` — the channel-fold conditional types. Two error families: construction (`*E`, Effect channel) vs live (`*LiveE`, `View<E>` channel). No `Tag*` family — component tags are direct calls. Plus the props fold: `FoldPropsLiveE`/`FoldPropsR` — an `on*` handler's `Effect` return contributes live `E` + `R`, via ONE cached `[E, R]` pass (`FoldPropsChannels`) with a zero-handler fast path, an `any`-guard, a bare-`on` exclusion, and AtomRef fold-through. Hard-won pin: the pair is read through a naked type param (`PairE`/`PairR`) — a non-distributive `never extends [infer E, any]` silently resolves to `unknown`. Plus the arms fold: `ArmR`/`FoldArmsR` — an `On` arm or `Catch` arm's `R` (minus `Scope`) folds onto the boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `types/Html.ts`        | `IntrinsicProps`/`HtmlEventHandlers` — typed event handlers for HTML intrinsics. Handlers return `unknown` (the honest `applyProp` contract: an `Effect` return is run, anything else ignored); the precise `E`/`R` are read off the _inferred_ props type by the props fold, not off this constraint. A typed `on*` slot also accepts an `Atom`/`AtomRef` holding the handler (reactive handler; `applyProp` re-applies the current function; the fold peels the wrapper) — any prop may be reactive, pinned by `testing/reactive-props.test.ts` + Fold.test-d §28                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `types/Fold.test-d.ts` | `assertEquals` matrix — every channel-fold shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## `Component.make` — the canonical component constructor

A thin **seam** over `Effect.fn`, not an abstraction. Exactly three jobs —
if it grows past these, it's grown too much:

1. **Traced by default.** Component bodies run once at construction
   (fine-grained model), so the span costs per-mount, not per-update — and
   buys component stack traces in a failure `Cause` (the boundary fallback
   can show _where_: `App > ProfilePage > UserCard`) plus OTel spans that
   join UI to backend (an `atom` body captures the construction context
   inherits the span context, so refetches nest under the component).
   Opt-out: write a plain `Effect.fnUntraced` function — components are
   just functions; `make` is a seam, not a gate. (Note `Effect.fnUntraced`
   iterates the body's result unconditionally — generator bodies only.)
   Framework internals stay untraced.
2. **Signature-preserving type.** Two overloads: an Effect-returning
   component hits the identity-typed one (`(f: F) => F`), so a
   _generic_ component survives with its type parameter intact — which
   `Effect.fn`'s overloads don't guarantee. Generator bodies (the common
   case) hit the second, which re-derives the channels the way `Effect.fn`
   does. TS cannot carry a generator's own type parameter through that one
   — write generic components in the Effect-returning form.
3. **A name slot the compiler fills.** In `.vx`,
   `const Counter = Component.make(fn)` is rewritten to
   `Component.make(fn, "Counter")` (see compiler AGENTS.md). Fails soft:
   no name → no span (the anonymous `Effect.fn` form never calls
   `useSpan`), but failures still carry definition + call-site stack
   frames via `CurrentStackFrame`. In plain `.ts` (tests, harnesses) pass
   the name explicitly. The parameter is `_name` — see "Compiler-slot
   parameter naming" above for the inlay-hint coupling.

Runtime: `Effect.fn` accepts both body shapes (it checks
`isEffect(body(...))` before iterating), so one implementation serves both
overloads.

The body takes **at most one** props object. A propless component takes no
parameter at all — `function* ()`: a zero-param tag still satisfies `h`
(fewer params is assignable) and `TagProps` folds it to the empty object.
Pinned in `Component.test-d.ts`.

## Reactivity model

Reactivity is `effect/unstable/reactivity`, used as effect-atom is used —
`Atom.make`, `Atom.fn`, `Atom.readable`, `Atom.family`, `AsyncResult`,
`Atom.Interrupt`/`Reset` are the vocabulary. The one thing verrex changes:
**`R` and `E` are the caller's responsibility.** There is no
`Atom.runtime(layer)`: a component captures its own `Context` and provides
it to the atoms it builds (`atom.ts`), so `R` rides the component's Effect to
`mount`, and an atom's failure rides `View<E>` (the phase switch) to the
nearest `Catch`. Do NOT build an **own signal core** (verrex would own a
scheduler for nothing the atom API lacks), a **fiber/Stream per reactive
hole** (`zipLatest` joins land on `setImmediate`; diamonds glitch), or a
**keys/cache layer of our own** (when wanted it is `Atom.family` +
`Reactivity`, no new concept).

Not now, additive later: **`View<E, R>` for resumable SSR.** Re-execution
hydration needs nothing new (construction re-runs on the client; effect-atom
`Hydration`/`Atom.serializable` carry data). Resumable SSR (no client re-run)
is the one case where live code has requirements no construction discharges
— then `View<E, R = never>` (a second covariant phantom, a `ChildLiveR` fold
mirroring `ChildLiveE`) and `resume(view, el): Effect<void, never, R_live>`.

- `Atom.make(x)` — the DEFAULT cell (a `Writable`; writes are
  `Atom.set/update` Effects; `mount` provides the `AtomRegistry`). Derived:
  `Atom.map` / `Atom.readable`. Async: `atom(...)`, `fn(...)` (caller-owned
  `R`, see the surface bullet).
- `AtomRef` — the ROW model only: `AtomRef.Collection` in `<For>`
  (`row.prop`/`row.map`/`row.set`), never an atom dependency, no bridge into
  atom bodies. Both kinds are equally fine-grained; the split is
  composability vs per-cell cost.
- In JSX, an `Atom`/`AtomRef` IS a value: `{label}`, `value={prompt}` —
  the renderer subscribes (`Reactive` node / `applyProp`). Expressions use
  `get(...)`: `{get(count) * 2}` — the compiler lowers it to
  `h.reader(() => …)` (see below).

`mount` owns its `AtomRegistry` — it creates one per mount, provides it
to the app effect (discharging `AtomRegistry` from the app's `R`), and
disposes it on scope close. Nothing needs to provide a registry.

## `h.reader` + `get` — the reactive expression

`h.reader(() => expr)` is what the compiler emits for a JSX expression
calling verrex's `get(...)` (compiler AGENTS.md "The one reactive
rewrite"). It is `Atom.readable` under the hood — a demand-driven derived
the registry owns by refcount (never mounted → never subscribes; unmount →
released).
`get` is a REAL exported function (auto-imported like `h`; hover /
go-to-def / rename are plain tsc, nothing is injected into the expression)
that reads through the AMBIENT reader: `h.reader` pushes the node's read
context on a small stack for the synchronous duration of `read()`, `get`
reads via the top of it, and throws with a clear message when no reader is
active (a handler, after an `await`, a plain function). Inside an
`atom((get) => …)` body effect-atom's explicit param shadows the import —
both coexist. `get` accepts an `Atom` (registry read) or an `AtomRef` — a
ref is bridged INSIDE the reader's own read (`bridgeAtom` in coerce.ts: an
Atom that subscribes to the ref, pushes via `setSelf`, unsubscribes in its
node finalizer; memoized per ref because the graph keys deps by atom
identity). This is the ONE place verrex still bridges refs into the
registry graph. Pinned by `h.test.ts` (incl. "get outside a reader throws").

**Invariant: a throwing reader stays node-local.** `AtomRegistry` has no
try/catch around a node's read; an escaping exception aborts the notify
cascade — the parent's REMAINING dependents are dropped from its children
set for good (siblings freeze silently) and the throw lands in the writer
(a handler → its sink). One transient bad frame (`get(user)!.name` while
`user` is briefly null) is common in JSX, so `h.reader` catches: keep the
last good value (`ctx.self()`), stay subscribed to whatever the failed run
did read, report, recover on the next dep change; a FIRST-read
throw has no last value and becomes `Effect.die(error)` — a live defect for
the nearest `Catch` / root sink (a nested reader's first read usually happens
INSIDE a notify cascade, so rethrowing would freeze siblings just the same).
`On`'s readable applies the same rule via `guardRegistryRead` (an arm that
throws → `Effect.die`). While a reader reads a source, the ambient-reader
stack holds a `null` frame, so a verrex `get(...)` reached synchronously from
inside an `Atom.map`/`Atom.readable` body throws ("outside a reactive
expression") instead of silently recording its dep on the outer reader. All
of this — the ambient stack, `get`, the guarded readable, `readSource`,
`guardRegistryRead` — lives in `reader.ts`; `h.reader` re-exposes its
`reader`. Pinned by `h.test.ts` / `on.test.ts`. User-written `Atom.readable`s get Effect's
behaviour (upstream issue). Do NOT "simplify" this back to letting the throw
propagate.

**Timing:** dep-change propagation (write → reader recompute → mount
listener) is synchronous. Handler dispatch batches its synchronous prefix
(see "Handler dispatch is batched"). Orphaned-node disposal is scheduled
(registry dispatcher), so a dropped reader's bridge unsubscribes a tick
after the subtree goes away — tests asserting teardown await a tick (full
registry dispose at scope close is synchronous).

**Property (by construction): the registry executes user Effects only with
`R` already provided.** `h.reader` runs a sync thunk; `atom`/`fn` provide
the captured construction context under the atom's own services
(`atom.ts`); an emitted Effect is executed by mount (`coerceSync`) on the
node's captured context. All `R` is type-tracked to the root.

## View IR

The intermediate representation between "arbitrary JSX child value"
and "DOM nodes." `coerceAsync` (in `coerce.ts`) coerces inputs to
View at `h()` call time; `coerceSync` (also in `coerce.ts`) coerces
render-time emissions from Reactive sources; `buildDom` (in
`mount.ts`) switches on the variant tag and produces DOM. Closed-
for-now at 7 variants:

- `Text { value }` — plain text node
- `Element { tag, props, children }` — DOM element
- `Fragment { children }` — group of views, no DOM container
- `Reactive { source: Atom | AtomRef.ReadonlyRef }` — subscribe to
  source, swap rendered child on emit
- `List { source: ListSource, render }` — keyed reactive list (`For`); `ListSource` = `Collection` | `Keyed` (any array atom + key fn)
- `Boundary { state, handler, reset, report, setAmbient }` — error boundary;
  renders the child subtree (with `report` swapped in as the subtree's error sink)
  or, on a caught failure, `handler(cause, reset)`. `setAmbient` lets `mount` hand
  it the parent sink for escalation. `state` is a `BoundaryState` carrying a
  monotonic `gen` (so `AtomRef`'s `Equal`-dedup can't drop a reset into an
  identical state). Built by `Catch` (see below). The one variant that carries
  behavior, not just data.
- `Empty {}` — comment placeholder (used for `false`/`null` children)

### Why hand-written interfaces (not `Data.TaggedEnum<{...}>`)

`View` is declared as a union of named `interface`s, not as
`Data.TaggedEnum<{ Text: {...}, Element: {...}, ... }>`. The
shorthand form is more compact, but it runs every variant through
`Types.Simplify`, which strips the `View` alias name and causes TS
to inline the entire union in every hover (`Effect<{ _tag: "Text";
... } | { _tag: "Element"; ... } | ..., never, never>` — roughly
30 lines per component signature). Named interfaces anchor the
alias, so hovers show the concise `Effect<View, never, never>`.

Constructors still come from `Data.taggedEnum<View>()` — the
runtime behavior is identical. Don't "simplify" this back to the
inline form.

### Closed-for-now, not closed-forever

The current 7 variants cover everything we need to render. Adding
a variant is a coordinated edit across two files:

- `buildDom` (mount.ts) — exhaustive `switch (view._tag)` forces
  a new case (TS will tell you)
- `coerce.ts` — `coerceAsync` if it can be authored from JSX,
  and/or `coerceSync` if it can be emitted from a Reactive
  source. Often one of the two is enough.
- **Context capture** — if the variant runs user code AFTER
  construction (re-renders, rows, fallbacks, handlers), it MUST
  capture the construction context. A DYNAMIC-render variant (built
  via `coerceSync`) builds through `withContext`; the Element
  handler path instead passes `view.context`/`sink` straight to
  `applyProps` (handlers need only those) — see the variant matrix
  in "Per-NODE context capture" below. Nothing forces this (the
  `context` field is optional and mount silently falls back to the
  root context), so a missed capture is the
  rows-die-under-mid-tree-provide bug class all over again.

Channels are unaffected — they're folded at the `h()` call site
via `FoldE`/`FoldR`, which operate on input child _shapes_
(Effect, Atom, array, …), not on the IR. (Recall: there is no
"JSX call site" in the emitted code — the compiler turns every
`<div>...</div>` into a plain `h(...)` call before tsc sees it.
See root [AGENTS.md](../../../../AGENTS.md) on JSX-as-syntax-only.) By
the time `coerceAsync` returns a View, all channels have been
hoisted into the surrounding Effect.

Good candidates if a need arises: `Portal` (render children to a
different DOM root). Note `On` did **not** need a new
variant (it builds a `Reactive` — see below), but the _error_
boundary **did** (`Boundary`): it has to redirect the error sink for its
child subtree, which only `buildDom` can do when it descends into the
node — not expressible by `Reactive`-over-a-ref alone. Anti-pattern:
convenience wrappers like `Card`/`Heading` — those are components, not IR.

## Async data: `atom` / `fn` + `On`

Errors-as-values (à la effect-atom): `atom(effect)` / `fn(f)` expose an
`AsyncResult<A, E>` you match where it is consumed — never a
throw-and-catch boundary. THE idiom is `On`: "handle some, bubble the rest":

```tsx
<On
  value={user}
  Waiting={() => <p>loading…</p>}
  NotFound={() => <p>no such user</p>} // handled here; E narrows
  Success={(s) => <b>{s.value.name}</b>}
/> // residual failures → live E → nearest Catch
```

An unhandled failure makes `On`'s atom EMIT an `Effect<never, E>`; the
fold's phase switch (above, "Phase switch at the Atom/AtomRef boundary")
puts that `E` on `View<E>`, so `mount` refuses the tree without a `Catch`
naming it — one boundary primitive for both phases. Retry = `Catch`'s
`reset` + `Atom.refresh(x)`.

Escape hatch for custom states: `Atom.map(user, r => AsyncResult.builder(r)
….onFailure(Effect.failCause).exhaustive())` — the same phase switch types
it. Never `.render()` (it throws the squashed cause, bypassing the typed
channel). Pinned by `testing/atom-escalate.test.ts`.

## `Catch` — the view-level error boundary

`Catch` mirrors Effect's `catch*`: recover the **failure** side of a view
subtree, let success pass through (the children render themselves). Contrast
`On`, which matches a tagged value and renders _every_ state — a boundary only
supplies the failure fallback. **A JSX tag, same shape as `On`**: the subtree
is the children, the handling is the arm props — one prop per error `_tag`, plus
`Failure` as the catch-all — and the compiler lowers it to the direct call
`Catch({ children: [...], HttpError: … })`. Multiple children are wrapped in a
`Fragment`. Two kinds of arm:

- **tag arms** — `<Catch Tag={(error, reset) => …}>…</Catch>`. Handle a subset of
  the children's error tags (each handler gets the unwrapped tagged error) and
  **narrow** both channels by `Exclude<E, { _tag }>` (`CatchResidual<E, K>`,
  over `K` = the arm keys present). Keys are constrained to the children's
  actual error tags — an unknown key is a compile error. A leftover tag must
  still be discharged before `mount`.
- **catch-all** — `<Catch Failure={(cause, reset) => fallback}>…</Catch>`. Gets
  the _precise_ `Cause<EC | EV>` (both the construction `EC` and live `EV` of the
  children — not `Cause<unknown>`), **narrowed by the tag arms beside it** —
  `catchTag` then `catchCause`: `<Catch HttpError={…} Failure={(cause) => …}>`
  gives `Cause<Exclude<E, { _tag: "HttpError" }>>` — and discharges everything
  to `Effect<View<never>, never, R | Scope>`.

  How the types do it (`CatchArms<E, K>`): ONE mapped type over `K`, the arm
  keys ACTUALLY PRESENT (inferred from the props' keys, default `never`), not
  over every tag of `E` — that is what lets `Failure`'s parameter mention the
  sibling arms. `NoInfer<K>` inside `Failure`'s parameter keeps it from feeding
  `K`; `"children"` sits in `K`'s key space (mapped to `unknown`) so the props'
  own key doesn't push inference to the fallback constraint; a separate `const H`
  captures the literal arm types for `FoldArmsR`. One mapped type (not
  `tags & { Failure }`) is also what keeps a GENERIC child `E` (the demo's
  `setupDemo<E>`) resolvable. `On` uses the same scheme (`TagHandlers<T, K>`,
  `Residual<T, K>`, `NarrowFailure` for the variant's `cause`/`failure`).

Dispatch order: tag arm first, then `Failure`, else escalate. The tag-matching
rule (`matchTagArm`) and the handler-map guard (`assertHandlerMap`) live in
`tag-dispatch.ts`, shared verbatim by `Catch` and `On` (On skips the
`"Failure"` tag — that key is its whole-variant arm). The guard runs on the
props object itself (a rest-spread would hide its prototype).

`Catch` runs over the internal `makeBoundary(child, accepts, handler)` (builds the
`Boundary` node, drives `state`); `accepts` is `Failure` present = always,
else `_tag ∈ keys`. A cause a tag-map doesn't
`accept` is **escalated**: at construction it re-raises on the Effect channel (its
residual rides `EC`, so a parent boundary / `mount` still sees it); when live it
goes to the ambient sink (the parent boundary — `mount` hands it over via the
node's `setAmbient`). Tag-selective only catches errors in the _type_; an untyped
event-handler/reactive error needs the catch-all form.

A subtree with undischarged errors won't pass `mount` — that's the thesis. (The
fallback's `R` folds — `ArmR<H>` for the catch-all, `FoldArmsR<Handlers>` for
the tag map — like `On`'s arms; its own `E` is permissive and its
success must be `View<never>`.)

Catches **both phases** through one fallback:

- **construction** — `child`'s build Effect is run under `Effect.catchCause`; an
  accepted failure becomes the initial `error` state. Run **inline** in the gen
  (folds `R`, no first-paint flash), so a forgotten `Layer` is still a compile
  error at `mount`.
- **live** — a post-mount failure inside the rendered subtree (a reactive
  re-render via `coerceSync`, or an event-handler Effect) is routed to the
  boundary's `report` sink, which `buildDom` swaps in as `ctx.sink` for the child
  subtree (see "Runtime error routing"). The fallback itself renders with the
  _ambient_ sink, so a failure in the fallback bubbles to the next boundary out.

`reset()` re-runs construction. **`report` and `reset` both go through a `Queue`
drained by a `forkScoped` loop** — never mutating boundary
state synchronously inside the child's render, which would close the child scope
mid-render (reentrant). The runtime impl runs on a deliberately wider, untyped
signature (`Cause<unknown>` sink); the precise types live in the public
`Catch` signature that fronts it.

**Two lifecycle details that are easy to get wrong (and were):**

- **Generation stamp.** Each `BoundaryState` carries a monotonic `gen`. Without
  it, `AtomRef.set` dedups via `Equal.equals`, and a reset that re-fails with a
  structurally-identical `Cause` is `Equal`-equal to the current state → no notify
  → a _dead retry button_. `gen` makes every emission distinct. Nuance: an
  `Effect.fn` child's causes are never `Equal`-equal in practice (each run's span
  annotation differs), so the hazard bites only span-less subtrees — which is why
  the `testing/catch.test.ts` gen-counter test uses an `Effect.fnUntraced` child; an `Effect.fn`
  child would pass vacuously.
- **Per-build construction scope.** Each child build (initial + every reset) runs
  in a fresh scope forked from the mount scope (`Scope.forkUnsafe` + `provideService(Scope.Scope, …)`),
  so a child's construction-time effects (a forked fiber + its
  finalizers, `acquireRelease`) are released when we swap away or reset — not
  leaked onto the mount scope. The prior build's scope is closed on swap/reset
  (`adopt`); the live one closes on teardown via the fork cascade. A build that
  fails with an _accepted_ cause closes its scope immediately (nothing renders
  from it — error content holds no live scope). A reset whose rebuild is
  rejected (non-accepted tag) discards its just-built scope and keeps the
  current content; a rejected cause that is interrupt-only (rebuild torn down
  mid-flight) is dropped, not escalated.

This **is** a View IR variant (`Boundary`) — the sink-swap for the child
subtree is a `buildDom`-time concern an existing `Reactive` can't express.

**Scope/fiber lifetime is uniform across the runtime** — internalize this when
touching any of it: construction effects bind to a per-build scope (above),
event-handler fibers are `forkIn`'d into their OWNER scope with a
per-dispatch child for resources (`runHandlerEffect`; the full contract is
"Handler-scope semantics" below), reactive/list subtrees go through
`buildScopedChild`. Render-path
sinks guard `Cause.hasInterruptsOnly` so a teardown interrupt isn't surfaced
as a failure. **Handler dispatch is the exception:** `runHandlerEffect`
observes every non-success exit via `onExit` and hands an interrupt-only
cause to the sink too. `Catch.report` does not flip on it; it escalates it
to the ambient sink unchanged. Mount's default root sink logs it at debug
level with a hint (below the default `Info` level, so raise the log level to
see it). A user-provided `RootSink` (a `Context.Reference`, so it never
shows in `R`) gets it raw. The testing harness
collects it on `ui.sinkCauses`. The reason: a handler interrupted mid-flight
by its element's teardown was invisible. Teardown is not an error, but "the handler never finished"
must be observable. Anything forked must be tied to a scope that closes when
its owning subtree does.

## mount internals — invariants

**`BuildCtx` carries the scope-independent deps; `Scope` is threaded
separately.** Signature: `buildDom(view, ctx: BuildCtx, scope: Scope.Scope)
→ Node`, where `BuildCtx = { registry, context, sink, runSyncExit,
ownerScope }`.
`registry` is the `AtomRegistry`; `context` is the ambient Effect context —
captured at `mount` for the root ctx, then re-derived PER NODE by
`withContext` for any IR node that captured its own (see "Per-NODE context
capture"); `sink` is the error sink (see "Runtime error routing" below);
`runSyncExit` is a context-paired `Effect.runSyncExitWith` cache for
`coerceSync`, and MUST be recomputed whenever `context` changes — go through
`withContext`, never a hand-built `{ ...ctx, context }` spread; `ownerScope`
is the handler-dispatch owner, changed only through `withOwner`
(directly at the mount root/Reactive sites, or via `buildScopedChild`'s
`handlerOwner: "child" | "inherit"`) — the per-node table is in
"Handler-scope semantics" below. `registry` and
`sink` are stable for the whole tree; `scope` is passed alongside because it
changes per dynamic subtree. Every subscription, event listener, and per-row
`Effect.acquireRelease` release registers a finalizer on the scope (directly
via `Scope.addFinalizer`, or via a forked child for sub-trees that need their
own lifetime). On scope close, parent-fork cascade tears everything down.
There is no `{ node, cleanup }` wrapper return type — closing the surrounding
scope IS the cleanup.

**Per-NODE context capture.** The invariant: every
path that runs user code AFTER construction must run it on the context that
was ambient WHERE the node was constructed — that's what makes a mid-tree
`Effect.provide` sound against the channels the fold claims (`FoldPropsR`,
`For`'s row `R`). The variant matrix (get this right when adding an IR
variant — the "new variant" checklist below points here):

| Variant                   | Captures where                                                                                               | Consumed by                                                                                                                                                            | Why / why not                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Element`                 | `h()`, ONLY when a handler prop exists (`hasHandlerProp` over the shared `isHandlerKey` gate, own keys only) | handler dispatch — `applyProps` gets the `HandlerDeps` quartet (`context`/`sink`/`registry`/`ownerScope`) DIRECTLY; the static-element path derives no node ctx/runner | handler-less elements stay pure data                                                       |
| `Reactive`                | `coerceAsync`'s reactive-source branch; `On`                                                                 | every re-render (`buildScopedChild` with the node-scoped ctx)                                                                                                          | re-renders run through `coerceSync`, not the construction fiber                            |
| `List`                    | `For()` (an Effect precisely so it can capture)                                                              | every row build, incl. post-mount inserts                                                                                                                              | rows materialize at reconcile time                                                         |
| `Boundary`                | `makeBoundary`                                                                                               | the FALLBACK arm only                                                                                                                                                  | ok content is rebuilt by the drain fiber, which inherits the construction context natively |
| `Text`/`Fragment`/`Empty` | —                                                                                                            | —                                                                                                                                                                      | no post-construction user code                                                             |

Mechanics live at the definition sites: `withContext` (mount.ts — derives
the node-scoped `BuildCtx` for the DYNAMIC-render variants that go through
`coerceSync`; reference-equal captures keep the parent ctx; its `runSyncExit`
is a per-context cache that stays paired with `context` — only mount-root and
`withContext` set it), `SyncRunner` (coerce.ts), the per-variant `context`
docs in View.ts.
**Handler dispatch is batched (sync prefix only).** `runHandlerEffect`
runs the fiber with `forkIn(…, { startImmediately: true })` inside
`Atom.batch`, so a handler write fanning through the registry graph (a
diamond `a → b, a → c, d = b + c`) recomputes `d` once — pinned by
`testing/handler-batch.test.ts` (2 → 1 recomputes; no glitch value). Two
rules: `startImmediately` is load-bearing (without it the fiber starts on the
dispatcher after the batch closed), and the batch opens ONLY when none is
open (`batchState.depth === 0`, an `@internal` runtime export read loosely) —
`Registry.batch` does not restore its phase in `finally`, so a batch opened
during an outer batch's COMMIT strands invalidations. Writes past the first
suspension, from atom bodies, streams or timers stay unbatched.

**Handler-scope semantics — the canonical statement; code
comments point here.** A dispatch has two lifetimes:

- _Resources_: `runHandlerEffect` forks a PER-DISPATCH scope from the
  element's `ownerScope`, runs the handler under it with `Scope.use` (closed
  on exit — success, failure, or interruption). `acquireRelease` inside a
  handler releases per dispatch. Corollary: **the handler's Scope is
  dispatch-lifetime** — `Effect.forkScoped`, or an `atom`/`fn`
  created inside a handler, dies the moment the handler returns. Work that
  must outlive the click forks INTO a scope captured at construction
  (`const s = yield* Effect.scope`, then `Effect.forkIn(work, s)`) or
  `forkDaemon`s; create `atom`/`fn` at construction, not in a
  handler. Handlers have NO ambient route to the app scope.
- _Interruption_: the fiber is `forkIn(ownerScope)` — the scope of the node
  that RAN the element's construction, set per call site (`withOwner`):

  | Element built by    | Owner                      | So that…                                                                                     |
  | ------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
  | mount root          | the mount scope            | a static element is interrupted only at app teardown                                         |
  | a Reactive emission | the NODE's scope           | a handler survives the re-emit its own write triggers (pending→run→settle)                   |
  | Boundary content    | the per-FLIP content scope | a flip interrupts prior-generation handlers — a stale failure can't re-flip a reset boundary |
  | a List row          | the rowScope               | a row handler survives moves, dies on removal                                                |

  For a REACTIVE handler prop (an AtomRef value) the rolling child scope
  swaps only the LISTENER; a dispatch in flight when the prop re-binds runs
  to completion, new clicks go to the new handler.

What still interrupts — unchanged from before this rule, which only
_narrowed_ interruption: anything that tears down the OWNER itself. A write
that re-renders an ANCESTOR dynamic node; a list-row handler that removes
its OWN row (confirm-then-remove); a `Catch` fallback handler that keeps
running after calling `reset` (the flip closes the fallback's content
scope). Rule of thumb: do the async work first, then flip/remove/reset.
Each of those interrupts reaches the root sink as an interrupt-only cause
(debug log by default; `ui.sinkCauses` in tests) — see "Runtime error
routing".

Don't revert any of this to
bare runners or to mount's root context: the types promise all of it.
Pinned by `testing/context-capture.test.ts` (one test per capture-consuming
path in the matrix, plus the owner-teardown discriminator) and
`testing/handler-scope.test.ts` (the dispatch-scope pins: self-triggered re-render,
Catch corollary, per-dispatch release, self-interrupt release, reactive-prop
re-bind, dispatch-lifetime Scope, row reorder-vs-removal, boundary
generation isolation); handler DISPATCH
pins stay in `testing/event-handlers.test.ts`. Two known limits: (1) a View
built OUTSIDE mount (`Effect.runSync(h(...))` at module level) carries its
own — possibly poorer — capture for ambient reads; (2) a SCOPED mid-tree
layer (`Effect.provide(subtree, Layer.scoped(...))`) closes its scope when
the subtree's CONSTRUCTION completes (`Effect.provide`'s own semantics) —
sound for resource-free layers (`Layer.succeed`); provide resource-backed
layers at the root.

**Runtime error routing — the sink.** A post-mount failure has no Effect `E`
channel to land on (the component's build Effect already succeeded), so it is
routed to `ctx.sink: (cause: Cause<unknown>) => void` instead of being
swallowed. Two producers: (1) a **reactive re-render** whose Effect fails —
`coerceSync` calls `sink(cause)` and renders `Empty` (never stringifies the
cause into the DOM); (2) an **event handler** that returns an
Effect — `applyProp` runs it on the element's captured context (falling back
to mount's; see "Per-NODE context capture") forked into the element's
`ownerScope` (`Effect.forkIn`, so the fiber is interrupted when the owning
dynamic subtree — not the element itself — is torn down), with
`Effect.matchCause` routing its failure to the same sink.
Both guard with `Cause.hasInterruptsOnly` — a pure-interrupt cause is scope
teardown, not an error, and is dropped. The root sink (`mount`) logs via
`Effect.logError` on the captured context; a `Catch` boundary replaces the
sink per-subtree (`buildDom` swaps in the boundary's `report` for the child — see
"`Catch`"). A handler that returns a non-Effect value runs as a plain
imperative callback, unchanged. Producer (2) is also _typed_: the
handler's `E` rides the element's `View<E>` (the props fold), so an
unboundaried failing handler is a compile error at `mount` — the sink is
the runtime backstop, not the only line of defense. The reactive
re-render producer (1) remains runtime-only. A third REPORTER (not a routing
producer): a **reader's re-render throw** keeps its last value and recovers
node-locally, so it must not reach a boundary's `report` (that would flip the
boundary and change recovery) — it goes straight to the ROOT sink as a
non-fatal `Cause.die`, via a `WeakMap<AtomRegistry, ErrorSink>` in `reader.ts`
that `mount` populates (`bindRootSink`; the reader finds its registry through
`ctx.registry`). A reader under a bare registry (no mount — unit tests) falls
back to `console.error`. The binding is never unbound — the WeakMap entry is
GC-eligible with the mount-owned registry. Caveat: the sink runs INSIDE the
notify cascade (`runForkWith` executes the sync prefix immediately), so a
user-provided `RootSink` must not synchronously write atoms — that re-enters
the registry mid-notify. The default sink (logging) is safe.

**`subscribeRefScoped` / `subscribeAtomScoped`** are the only two
ways to subscribe to a reactive source from inside `mount.ts`.
They register the `dispose` callback as a `Scope.addFinalizer`
finalizer. Don't subscribe outside these helpers — the dispose
function would have no scope to bind to and would leak on teardown.
Consumers don't call them directly either:
**`applyAndSubscribeSource`** is the single Atom-vs-AtomRef dispatch
(initial read — immediate or deferred — plus scoped subscribe) that
both reactive consumers (`applyProp`, the Reactive child case) share;
a third source shape extends it, not a new dispatch site.

**Reactive props accept `Atom` or `AtomRef`.** Pass the atom itself as the
attr value (or a `get(...)` expression, which the compiler lowers to a
reader Atom), deriving the final attr string with `Atom.map`. When an Atom's source needs services, the **component owns
the requirements**: extract instances up front (`const http = yield* Http`)
or capture context (`yield* Effect.context<R>()`), then build the Atom
from those, so the source is context-free and a forgotten Layer is
still a compile error at `mount`. `Atom.runtime` stays the anti-pattern
(bakes the Layer, discharges `R`). Pinned by
`testing/atom-attr.test.ts` and the Atom-carrier pin in
`apps/demo/src/channels.test-d.ts`.

**Fragments wrap in `<span style="display: contents">`.** Not a
`DocumentFragment`, because `DocumentFragment` is consumed on insert
— a later `replaceChild(fragment, ...)` would fail. The wrapper
keeps a stable parent reference; `display:contents` makes the
wrapper invisible to CSS so children inherit the real parent's
styling (e.g., `<ul>` styling for `<li>` rows). Don't replace this
with a Fragment.

**Reactive nodes render a placeholder comment first**, then swap on
the first emit (synchronous if the source is already populated).
Source can be `Atom` or `AtomRef.ReadonlyRef`; dispatch on
`Atom.isAtom` / `isAtomRef`. `coerceSync` (from `coerce.ts`) coerces
the emitted value into a `View` — including `Effect`, which is run
with the per-render child scope so `Effect.acquireRelease`
registers releases on _that_ render's scope. A failing render Effect
is routed to the `sink` (passed as `coerceSync`'s third arg) and renders
`Empty` — see "Runtime error routing" above. `coerceSync` is
deliberately asymmetric vs. `coerceAsync`: at this point in the
render path the Atom/AtomRef has already been peeled, so it does
NOT recurse into Atom/AtomRef. Don't "fix" that — the unwrap contract
belongs upstream. And NEITHER path peels Effect's value containers
(Option / Result / Chunk / AsyncResult): those are values the author maps
explicitly (`Option.getOrNull`, `Result.match`, `AsyncResult.builder`) —
an implicit peel hid a channel (a `Result.Failure` rendered nothing, error
dropped) and read as magic. Arrays DO peel: they are structure (how a JSX
expression yields several children), not a value container. Pinned in
`coerce.test.ts` and the demo's `channels.test-d.ts` container-parity block.

**Reactive ordering: build NEW → swap DOM → close OLD.** Per emit,
fork a fresh child scope from the Reactive's scope, build the new
subtree into it (subscribing whatever refs the new subtree needs),
swap into the DOM via `replaceChild`, THEN close the previous
emit's child scope. The reverse order (close OLD first, then build
NEW) would unsubscribe many refs and resubscribe many during a
single `notify` loop on the source — the same "diff, not
unsub-all-then-resub" hazard.

**List reconciles by AtomRef identity.** Not by index, not by value
equality. Each row's `AtomRef` is the key; on `subscribe`, only
structural changes (length differs or identity at any index differs)
trigger reconciliation. Per-value updates inside a row are handled
by the row's own reactive bindings — re-reconciling on those would
tear down DOM unnecessarily.

**The diff is pure; the `List` case is only its interpreter.** The
keyed-diff decision lives in [`reconcile.ts`](./reconcile.ts) —
`plan(prevKeys, nextKeys)` returns `remove`/`insert`/`move`/`keep` ops
over opaque keys, with zero DOM/`Scope`/`Effect` dependency, so the
runtime's most bug-prone logic is unit-testable without mounting
(see `reconcile.test.ts`). Each op drives exactly one DOM mutation,
deterministically — same nodes, same order. `mount`'s `List` case interprets the
ops against real DOM nodes and per-row scopes: `remove` closes-then-
detaches, `insert` calls `buildScopedChild`, `move` repositions, `keep`
is index-only. Don't reintroduce the diff inline in `mount` — the seam
is what gives it a test surface.

> **`move` is currently unreachable through `AtomRef.Collection`.** Its
> public mutators (`push`/`insertAt`/`remove`) each mint or drop a row's
> `AtomRef`, so existing rows never change position relative to each other
> — reordering surfaces as `remove` + `insert` of fresh keys, never `move`.
> The `move` branch is kept for a future reordering API and is covered by
> the pure `reconcile.test.ts` (synthetic key arrays), not by an integration
> test — don't go looking for one.

**Row index is reactive.** `render(item, index)` receives `index` as
an `AtomRef.ReadonlyRef<number>`, not a plain number. The planner emits
the next-order index on every retained row (`move`/`keep`), and the
interpreter pushes it into the row's index ref (guarded by an equality
check so unchanged indices don't notify). A moved or shifted row's
`{index}` / `{get(index)}` therefore updates **without re-rendering the
row**. A reorder/shift never rebuilds a row's DOM; only
`insert` builds and `remove` tears down.

**List snapshot must be a copy, not a reference.** Effect's
`CollectionImpl` mutates its internal array in place on `push`/
`remove`, so storing the collection's `.value` and later comparing
references would always say "no change." `snapshot = Array.from(next)`
is critical.

**List per-row Scope is a `Scope.forkUnsafe` child of the List's
scope** — not an orphan `Scope.makeUnsafe`. The row's render Effect
runs in that scope so `Effect.acquireRelease(acquire, release)`
inside the row component registers `release` on the row scope. On
row removal, `Scope.closeUnsafe(rowScope, Exit.void)` fires the
releases; on full teardown, the parent-fork cascade closes any
remaining rows automatically — leak-safe by construction. The
`Effect.runFork(closeExit)` shape is intentional: row releases can
be async, and fire-and-forget matches the surrounding DOM
synchronicity. Lifecycle.vx exercises this mechanism, and
`scripts/probe-lifecycle.mjs` exercises both row-removal and the
full-teardown cascade.

**`mount`** captures the ambient `Scope` via `yield* Effect.scope`,
threads it into `buildDom`, and adds one finalizer of its own
(removes the rendered root from the DOM). All other cleanup is
inside the scope. Callers must provide a scope (`Effect.scoped`
typically) and keep it alive for the lifetime of the rendered UI.

## Anti-patterns

- Don't add View IR variants as convenience wrappers (`Card`,
  `Heading`, etc.) — those are components, not IR. New variants
  are for new DOM-materialization shapes (`Portal`, `Suspense`)
  and require coordinated edits across `buildDom` and `coerce.ts`.
  See "Closed-for-now, not closed-forever" above.
- Don't normalize Reactive sources eagerly. `coerceSync` is
  synchronous on purpose; subscribing first then rendering would
  flash a comment in the DOM.
- Don't peel Effect's value containers (Option/Result/Chunk/AsyncResult)
  in either coerce path, and don't make `coerceSync` peel Atom/AtomRef.
  Values are mapped by the author; nested reactive sources are unwrapped
  upstream of the Reactive render path.
- Don't return `DocumentFragment` from `buildDom`. Stable replacement
  needs a real parent node.
- Don't return `{ node, cleanup }` (or any wrapper around `Node`)
  from `buildDom`. Cleanup is the scope's job — adding a tuple back
  reintroduces parallel cleanup conventions that the scope-threading
  refactor consolidated. If you need teardown for something, register
  it via `Scope.addFinalizer` (or one of the `subscribe*Scoped`
  helpers).
- Don't call `Scope.makeUnsafe()` from inside `buildDom` to make an
  orphan scope for a sub-tree. Use `Scope.forkUnsafe(parent, ...)`
  so the sub-scope is parent-linked — closing the surrounding scope
  cascades into the sub-scope. Orphan scopes leak finalizers on
  unexpected teardown paths. In practice, route every dynamic subtree
  (a Reactive emit, a List `insert`) through `buildScopedChild` — it
  owns the `forkUnsafe → coerceSync → buildDom` triple, so the
  parent-linked-scope invariant has exactly one home.
- Don't extend `h.reader`/the compiler's `get` rule to fire on other shapes
  — the compiler decides what's rewritten; the runtime just executes.
- Don't subscribe to `AtomRef.Collection` per-item-value events
  (only to structural events). Rows do their own value reactivity.
- Don't expose helpers that wrap Effect's own combinators
  (`Effect.map`, `Atom.map`, etc.). API surface is intentionally
  minimal — users compose with native Effect primitives.

## Known limits

### Generic components DO survive JSX tags — one caveat

Component tags lower to direct calls (`<Row item={x}/>` →
`Row({ item: x })`), so a generic component's `T` infers natively at
the call site. `<For>` is the keyed reconciliation primitive only —
not a generics workaround.

The caveat: a **reader attr** is an `Atom`. An attr value containing a
free `get(...)` is lowered to `h.reader(() => …)`, whose type is
`Atom<T>` — so `<Row item={get(ref)}/>` passes `item: Atom<string>`
rather than a `string`. That is honest (it IS reactive) and it folds; a
component wanting the value takes `Atom<T>` (or the ref itself:
`<Row item={ref}/>`). Static attrs pass through untouched (no `get` →
no wrap — purely syntactic, so generics survive), and so do
function-valued attrs (handlers, callbacks): a free `get` inside a handler
is a compile error, never a wrap, which is what lets a handler's `E`/`R`
reach the props fold. A reactive HANDLER is an `Atom`/`AtomRef` holding the
function (`onclick={handlerAtom}`; typed slots accept it, `applyProp`
re-applies live).

Don't "fix" anything here by widening `h()`'s signature — `h` is
intrinsic-only and the narrow signature is what makes child
folding work (see the root [AGENTS.md](../../../../AGENTS.md)
anti-pattern about pluggable JSX backends).

### Children-accepting components: be generic, never `Child[]`

A component that accepts arbitrary effectful children declares a
GENERIC children tuple and folds it (Fragment in `index.ts` is the
canonical implementation):

```ts
const Layout = Component.make(<Cs extends ReadonlyArray<unknown>>(
  props: { readonly children?: Cs },
) => … /* embed {props.children}; folds Fold*<Cs> */)
```

Direct calls make the inference precise. Typing the prop as the
non-generic `Child[]` is an anti-pattern: `Child` includes
`Effect<View, any, any>`, and folding `any` poisons `E` — an `any`
error channel is assignable to `never`, which silently defeats the
`mount` gate. Children arrive RAW (any child shape `h` accepts) and
coerce where embedded.

## Channel-fold quick check

If you change `h()`'s signature or any of the `Fold*` types, run:

```
pnpm --filter @verrex/core typecheck
# and (for end-to-end JSX shape coverage):
pnpm --filter verrex-demo typecheck
```

The `channels.test-d.ts` files (`types/Fold.test-d.ts`
and `apps/demo/src/channels.test-d.ts`) are compile-time proofs
that the fold works for the JSX shapes we care about. Failing
`assertEquals` checks are real regressions.
