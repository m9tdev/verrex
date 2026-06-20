# `verrex` — the framework runtime

What the user actually imports from when writing components.
Public surface (from `index.ts`):

- `h` — the view factory for INTRINSIC elements only (the compile target
  for lowercase `<div>` source syntax; component tags lower to direct
  calls since #71) + `h.track`/`h.read` (compiler hooks)
- `Component` — `Component.make`, the canonical component constructor
  (a thin seam over `Effect.fn`; see "`Component.make`" below)
- `mount` — DOM renderer. **Requires `Effect<View<never>, never, R>`** (every
  error discharged), returns `Effect<void, never, R | AtomRegistry | Scope>`
- `list` — keyed reactive list helper (`View.List` IR node)
- `Async` / `asyncRef` / `AsyncHandle` — async render boundary + primitive returning `{ state, refetch }` (errors-as-values; see "`asyncRef` / `Async`" below)
- `streamRef` — `asyncRef`'s push sibling: `streamRef(stream, initial?)` runs
  the stream on the mount fiber (`R` folds; same design rationale as
  `asyncRef` — never `Atom.make(stream)`, whose source must be context-free)
  and returns a `ReadonlyRef<A>` updated per emission; the fiber is
  `forkScoped`-d, so the Scope IS the unsubscribe. `initial` mirrors the pull
  side's blocking-vs-placeholder split: omitted → construction WAITS for the
  first element by pulling ON the constructing fiber (`Channel.toPullScoped`
  — the same shape as a blocking `yield* http.getUser`; no forked producer a
  closing scope could orphan; a never-emitting stream blocks like a hanging
  fetch — give sparse streams an `initial`; a stream that ENDS first is a
  defect, fail-loud); provided → returns immediately, ref holds `initial`
  until the first emission. Import `streamRef` unaliased — it sits in the
  compiler's `isSelfTrackingCall` skip set with `Async`/`Catch` (an
  `h.track` wrap would erase its channels AND respawn the stream per dep
  change). The stream's `E` must be
  `never` — a live failure has no honest Effect channel; discharge it with
  `Stream.catch*`/`Stream.retry` (or encode it in `A`) before handing over.
  Derive with the ref's `.map` (equality-deduped notify). Pinned by
  `testing/stream-ref.test.ts` (latest-emission semantics, the waiting
  no-initial form, derived-ref dedup, scope interruption, the R-fold type on
  both overloads, and the `E = never` constraint).
- `Catch` — view-level error boundary (one overloaded helper: function 2nd-arg = catch-all, object 2nd-arg = tag-selective; mirrors `Effect.catch*`; see "`Catch`" below)
- `Fragment` — `<>...</>` compile target (a direct-call component since
  #71: `Fragment({ children: [...] })`, generic over the children tuple —
  also the canonical pattern for effectful-children components)
- `VerrexLive` — base Layer providing `AtomRegistry`
- Types: `View<E>`, `Props`, `FoldE`/`FoldLiveE`/`FoldR` (the `Tag*`
  families died with #71 — component channels are ordinary child folds),
  `IntrinsicProps`, `HtmlEventHandlers`

This is where the **channel propagation contract lives** —
`h()`'s signature uses the fold conditional types to union every child's
channels into the result. Errors split by phase: **construction** errors
(`FoldE`) ride the result Effect's `E`; **live** errors a rendered
subtree can still produce (`FoldLiveE`) ride the `View<E>` success.
`R` unifies (`FoldR`). A component tag is not a fold case of its own:
the compiler lowers `<MyComp/>` to the direct call `MyComp({...})`, so a
component's channels surface as an ordinary Effect child of the
surrounding `h()`. `mount` requires both error channels `never`;
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

| File | Purpose |
|---|---|
| `h.ts` | `h()` factory + `track`/`read` reactivity-tracking machinery (built on `trackDeps`/`recordDep` from `coerce.ts`) |
| `Component.ts` | `Component.make` — the canonical component constructor (traced `Effect.fn` seam + compiler-filled name slot). `Component.test.ts` pins the span-in-Cause; `Component.test-d.ts` pins the channel inference and generic preservation |
| `coerce.ts` | `coerceAsync` (any child shape → `Effect<View>`) and `coerceSync` (render-time emission → `View`). Internal; not re-exported from `index.ts`. Owns `isAtomRef` (brand check against `AtomRef.TypeId`) and the shared dependency tracker `trackDeps`/`recordDep` (used by both `h.track` and `Async`) |
| `View.ts` | `View<E>` IR. The runtime shape is `ViewNode` — a hand-written union of 7 phantom-free named interfaces (`ViewText`…`ViewBoundary`, `ViewEmpty`); constructors via `Data.taggedEnum<ViewNode>()`. `View<E = never> = ViewNode & ViewErr<E>` layers the runtime-error channel on via a covariant phantom (`ViewErr`), so `View<HttpError>` ⊄ `View<never>` (mount can require it) while a `ViewNode` ⊂ any `View<E>` (constructors need no casts). Plus `isView`, `VIEW_TAGS` |
| `mount.ts` | DOM renderer. `buildDom(view, ctx, scope) → Node` (`ctx: BuildCtx = { registry, context, sink }`), `mount(app, el)`. Cleanup is delegated to `Scope` — every subscription/listener/release registers a finalizer on the scope it was created in, and parent-fork cascade tears them down on close. Owns `buildScopedChild` (the one place a dynamic subtree gets a parent-linked child scope), the `List` **interpreter** that applies a `reconcile.ts` plan to real DOM + scopes, and the error **sink** (runs event-handler Effects + routes runtime failures) |
| `reconcile.ts` | Pure keyed-list diff. `plan(prevKeys, nextKeys) → ReconcileOp[]` over opaque keys — no DOM, no `Scope`, no `Effect`. The runtime's highest-bug-density logic, made exhaustively unit-testable. `mount`'s `List` case interprets the ops |
| `index.ts` | Public exports + `list`, `Async`, `asyncRef`, `streamRef`, `Catch` (overloaded catch-all + tag-selective, over an internal `makeBoundary`), `Fragment`, `VerrexLive` |
| `coerce.test.ts` | Vitest suite for `coerceAsync` / `coerceSync` (parity + the sync/async asymmetry pin) |
| `reconcile.test.ts` | Pure diff tests — an apply-to-array oracle (plan turns `prev` into `next`) plus exact op-sequence pins (move-minimality; index updates on shift) |
| `types/Fold.ts` | `ChildE`/`ChildLiveE`/`ChildR` + `FoldE`/`FoldLiveE`/`FoldR` — the channel-fold conditional types. Two error families: construction (`*E`, Effect channel) vs live (`*LiveE`, `View<E>` channel). No `Tag*` family since #71 (component tags are direct calls) |
| `types/Html.ts` | `IntrinsicProps`/`HtmlEventHandlers` — typed event handlers for HTML intrinsics |
| `types/Fold.test-d.ts` | `assertEquals` matrix — every channel-fold shape |

## `Component.make` — the canonical component constructor

A thin **seam** over `Effect.fn`, not an abstraction. Exactly three jobs —
if it grows past these, it's grown too much:

1. **Traced by default.** Component bodies run once at construction
   (fine-grained model), so the span costs per-mount, not per-update — and
   buys component stack traces in a failure `Cause` (the boundary fallback
   can show *where*: `App > ProfilePage > UserCard`) plus OTel spans that
   join UI to backend (the `asyncRef` supervisor forked during construction
   inherits the span context, so refetches nest under the component).
   Opt-out: write a plain `Effect.fnUntraced` function — components are
   just functions; `make` is a seam, not a gate. (Note `Effect.fnUntraced`
   iterates the body's result unconditionally — generator bodies only.)
   Framework internals stay untraced.
2. **Signature-preserving type.** Two overloads: an Effect-returning
   component hits the identity-typed one (`(f: F) => F`), so a
   *generic* component survives with its type parameter intact — which
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

Reactivity is delegated to `effect/unstable/reactivity`. We do not
ship our own atom/signal primitive.

- `AtomRef<T>` — local mutable cell (the "ref"). Subscribe gets
  notified on `.set` / `.update`.
- `Atom<T>` — derived in an `AtomRegistry` context. Need
  `registry.get(atom)` / `registry.subscribe(atom, fn)`.
- `AtomRef.Collection<T>` — reactive array; rows are
  `AtomRef.AtomRef<T>` so each row is its own subscribable cell.

`mount` requires `AtomRegistry` in `R`. `VerrexLive` provides it.

## The track/read dance

The compiler wraps `{expr}` JSX expressions in `h.track(() => expr)`
**only when** it actually rewrote a `.value` read inside (see
[compiler AGENTS.md](../compiler/AGENTS.md)). Inside that scope:

- `h.read(ref)` — a **faithful, transparent wrapper for `.value`**:
  byte-for-byte `ref.value` for any non-AtomRef (throws on null exactly
  as `.value` would — no `?.` swallow), and for a branded AtomRef it
  *additionally* registers `ref` as a tracked dep when a tracker is
  active. This faithfulness is what lets the compiler emit `h.read` for
  *every* `.value` read in a component body (not just JSX) without any
  compile-time atom analysis — the `isAtomRef` brand is the exact gate.

`h.track` itself (via `trackDeps` in `coerce.ts`, shared with `Async`):

1. `trackDeps` sets a module-level collector to a fresh dep set.
2. Runs the thunk; `h.read`→`recordDep` adds to the set per AtomRef.
3. **If the set is empty**, returns the thunk's result directly
   (no AtomRef wrap, no reactivity overhead — and the caller's
   static typing is preserved).
4. **If the set is non-empty**, creates a derived `AtomRef`, sets
   its initial value to the thunk's result, subscribes to every
   tracked ref, re-runs the thunk on change.
5. Deps are re-collected on every rerun (a ternary may read
   different refs on its other branch). Old subs are dropped first.

**Invariant: the empty-deps early return is load-bearing.** Without
it, every `<Row item={item} />` would erase `item`'s generic type to
`unknown`.

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
- `List { source: AtomRef.Collection, render }` — keyed reactive list
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

Channels are unaffected — they're folded at the `h()` call site
via `FoldE`/`FoldR`, which operate on input child *shapes*
(Effect, Option, Atom, …), not on the IR. (Recall: there is no
"JSX call site" in the emitted code — the compiler turns every
`<div>...</div>` into a plain `h(...)` call before tsc sees it.
See root [AGENTS.md](../../../../AGENTS.md) on JSX-as-syntax-only.) By
the time `coerceAsync` returns a View, all channels have been
hoisted into the surrounding Effect.

Good candidates if a need arises: `Portal` (render children to a
different DOM root). Note an async boundary did **not** need a new
variant (`Async` builds a `Reactive` — see below), but the *error*
boundary **did** (`Boundary`): it has to redirect the error sink for its
child subtree, which only `buildDom` can do when it descends into the
node — not expressible by `Reactive`-over-a-ref alone. Anti-pattern:
convenience wrappers like `Card`/`Heading` — those are components, not IR.

## `asyncRef` / `Async` — the async data primitive + render boundary

Effectful/async data is **errors-as-values**: it's an `AsyncResult<A, E>` you
match where it's consumed, not a throw-and-catch boundary (à la effect-atom /
Solid's Resource — **not** React Suspense). Two exports, both in `index.ts`:

- **`asyncRef(() => effect)`** — the primitive. Runs the effect and returns an
  **`AsyncHandle<A, E>`**: a reactive `state:
  AtomRef.ReadonlyRef<AsyncResult<A, E>>` plus a manual `refetch: () => boolean`
  (the same `schedule` a dep change triggers — fresh dep snapshot, stale run
  interrupted; a no-op once the creating scope closes). Handle the state with
  Effect's own `AsyncResult.match`. (`refetch` returns `boolean` — `false`
  means the creating scope closed and the request was dropped. Refetch
  belongs on the handle: it's the same mechanism the arms' `retry` uses
  (#101) — don't split it back out.)
  ```tsx
  const user = yield* asyncRef(() => http.getUser(userId.value))
  <button onclick={user.refetch}>refresh</button>
  {user.state.map(AsyncResult.match({ onInitial, onFailure, onSuccess }))}
  ```
- **`Async(from, { initial?, failure?, success })`** — the render boundary,
  **thunk-first positional**, sugar over `asyncRef` + `AsyncResult.match`.
  `from` is a thunk **or an existing `AsyncHandle`**: a thunk creates a
  handle private to this boundary (its `R` folds here); a passed handle
  decouples the data's lifetime from the view — the fetch loop lives where
  `asyncRef` ran, keeps tracking deps after a `Catch` swaps the subtree away,
  can be refetched from anywhere, and is shared by every consumer
  (handle-based `Async` contributes only `Scope` to `R`; the overloads
  default `R = never` so the union param doesn't leak `unknown`). One
  semantic shift: a boundary `reset` over a handle re-renders the handle's
  CURRENT state and does NOT refetch (a still-failed handle re-escalates on
  rebuild) — compose `() => { handle.refetch(); reset() }` when retry should
  do both. Pinned by `testing/async-handle.test.ts` (external refetch,
  shared loop = one fetch for two consumers, refetch+reset recovery, R/E
  pins):
  ```tsx
  {Async(() => http.getUser(userId.value), {
    initial: <Spinner/>,
    failure: (cause) => <Err cause={cause}/>,
    success: (user) => <UserCard user={user}/>,
  })}
  ```
  The compiler lowers the `<Async from initial failure success/>` JSX element to
  this positional call (planned). **It must stay positional** — a single props
  object passed through `h(Async, props)` defeats inference (`success`'s value
  collapses to `unknown`), the same reason `list` is positional.

**The `failure` arm picks the error's home — function, tag map, or absent.**
Three public overloads (catch-all function first, tag map second, the open
form's arms typed `failure?: never` so resolution can't fall through),
mirroring `Catch`'s function-vs-object convention:

- **`failure` as a function** → catch-all: every failure is handled at the
  leaf, rendered by the arm (which gets the full `Cause<E>`):
  `Effect<View<never>, never, R | Scope>` — discharged, nothing for a
  boundary to see.
- **`failure` as a tag map** — `failure: { NotFound: (e) => … }` → a matched
  tag is handled at the leaf (the handler gets the unwrapped error) while the
  **fetch loop stays live**: a dep change still refetches, so the view
  recovers with no boundary `reset`. That semantic is why this isn't sugar
  for `Catch(Async(open), tagMap)` — a leaf `Catch` that accepts a failure
  swaps the subtree and closes its build scope, tearing down a THUNK-form
  `asyncRef` supervisor (a passed `AsyncHandle`'s supervisor lives where
  `asyncRef` ran and survives the swap — but the leaf-vs-boundary error-home
  distinction stands for both forms). The residual rides the live channel:
  `Effect<View<Exclude<E, { _tag }>>, never, R | Scope>`. Dispatch is shared
  with `Catch` (`taggedMatch`: own function-valued key, routed on the cause's
  *first* error when it is tagged; the helper returns the matched
  `{ handler, error }` pair so dispatch tag and handler argument can't drift)
  and inherits its caveats: a typo'd key mixed with ≥1 valid key is silently
  dead (its tag stays on the channel — for *inline literals* the type never
  lies; a typo as the only key is a compile error), and a tag map on an `E`
  with no tagged members is rejected outright (the overload's constraint
  collapses to `never`, not the accept-anything empty mapped type). The two
  runtime-detectable type/runtime gaps — prototype-keyed handler objects and
  non-function slots (compilable without `exactOptionalPropertyTypes`) — are
  rejected at the `Async()`/`Catch()` call site by `assertHandlerMap`
  (TypeError naming the surface and key; pinned by
  `testing/tagmap-validation.test.ts`). The remaining gap — a pre-built map
  whose *type* declares keys the value doesn't carry — is invisible at
  runtime (erasure) and stays a documented limitation (#91): prefer inline
  handler literals.
  The handler-map shape itself is the shared `TagHandlers<E, Extra>` alias
  (Catch instantiates `Extra = [reset]`, Async `[retry]`). Every Async
  failure handler — catch-all `(cause, retry)` and tag-map `(error, retry)` —
  receives **`retry`** last: it re-runs the thunk with a fresh dep snapshot
  (the handle's `refetch`, the same `schedule` a dep change triggers),
  the leaf analog of `Catch`'s `reset` (which re-runs *construction*). The
  same `refetch` is public on the `AsyncHandle` that `asyncRef` returns. Three retry invariants, each
  hard-won: (1) **failure-waiting renders the `initial` arm**, not the
  failure arm with its stale cause — stale-while-revalidate keeps *content*
  (success-waiting renders success), a stale error isn't content, and
  re-invoking the arm would rebuild its DOM (and retry button) mid-flight;
  this is also the observable that makes retry testable. (2) **Call `retry`
  from event handlers only** — calling it during render refetches in an
  infinite loop (the alternating `waiting` flag defeats `Equal`-dedup).
  (2b) **`refetch` flips the state to waiting synchronously** (inside
  `schedule`, before enqueuing): a rebuild in the same tick — `refetch();
  reset()` in either order — observes waiting instead of re-escalating the
  stale non-waiting Failure; the supervisor's own set on take is a deduped
  duplicate (and corrective in the rare interleaving where the prior run
  completed in between). Don't move the set back to the supervisor — the
  refetch+reset composition's order-independence depends on it.
  (3) **`schedule` is guarded by a `closed` flag** set in the scope finalizer
  (which also clears `unsubs`): a retained `retry` (a `setTimeout`, a click
  racing a boundary swap) fired after teardown must be a no-op — without the
  guard it would re-subscribe deps the finalizer can never clean, feed a
  queue whose consumer is dead, and replay non-idempotent AtomRef
  unsubscribers. Pinned by `testing/async-tagmap.test.ts` (incl. the
  recover-without-reset semantic and nullish-arm degradation) and
  `testing/async-retry.test.ts` (retry on both arm forms; the gated test
  pins waiting→initial and that a failed retry stays retryable), plus the
  tag-map `Async` section of `apps/demo/src/channels.test-d.ts`.
- **omit `failure`** → the failure **rides the live channel**:
  `Effect<View<E>, never, R | Scope>`. This is the leaf primitive that stamps
  `View<E≠never>`. Both an initial-fetch failure and a refetch failure route to
  the nearest enclosing `Catch` (whose `reset` re-runs construction → a fresh
  fetch), and `mount`'s `View<never>` gate makes a missing boundary a compile
  error naming `E`. Mechanism: on `AsyncResult.failure` the matched source
  emits `Effect.failCause(cause)`; the Reactive render path (`coerceSync`)
  runs it, routes the cause to `ctx.sink` — the boundary's `report` — and
  renders `Empty`. No new runtime machinery: it reuses the reactive-re-render
  producer of "Runtime error routing" below. The interrupt-only guard already
  ran in `asyncRef` (teardown never reaches the `Failure` state), and the
  boundary queues the report off the render stack. Pinned by
  `testing/async-escalate.test.ts` and the `Async` section of
  `apps/demo/src/channels.test-d.ts`.

The `from`/thunk runs under the **same dependency tracker as `h.track`**
(`trackDeps`/`recordDep`, from `coerce.ts`): any reactive ref it reads via
`.value`/`h.read` becomes a dependency, and the effect **re-runs when one
changes**, interrupting the stale run. A thunk that reads no refs runs once —
deps are *discovered, not declared*.

Arm channels are accepted permissively (`any`) and are not folded; that avoids a
JSX conditional's `any`-folded channels breaking inference. **Arms must be
synchronous View-producers** — they render via `coerceSync` (`runSyncExit`), so
an *async* arm effect can never resolve. A *failing* arm effect is routed to the
error sink (and renders `Empty`), not stringified — see "Runtime error routing".
Keep arms pure markup.

**Inline or extracted — both track.** The compiler rewrites `.value`→`h.read`
across the whole component body, so an extracted thunk —
`const get = () => http.getUser(userId.value)` then `Async(get, …)` — refetches
identically to inline. The read must happen *inside* the thunk; a `.value` read
into a local *before* it (`const id = userId.value; Async(() => http.getUser(id), …)`)
captures a snapshot and won't refetch — ordinary eager-read semantics.

**The compiler skips the `h.track` wrap for `Async(...)` calls** (`isSelfTrackingCall`
in the compiler — the same guard covers `Catch`, `asyncRef`, and `streamRef`) —
`Async` self-tracks, and `h.track`'s `unknown` return would erase its
`Effect<View, never, R | Scope>` channels from the `h()` fold. The inner
`.value`→`h.read` rewrite is kept (the tracker needs it). Matched by callee
name, so import `Async`/`Catch`/`asyncRef`/`streamRef` unaliased.

Neither is a View IR variant. `asyncRef` builds an `AtomRef<AsyncResult>`; `Async`
maps it through `AsyncResult.match` and returns a `View.Reactive` — the existing
Reactive node does the DOM work. The design that makes this fit verrex:

- **State** is Effect's `AsyncResult` in a *synchronous* `AtomRef` (the Reactive
  node reads it immediately and re-renders on `.set`).
- **Tracking + execution:** `schedule()` runs the thunk under `trackDeps`,
  subscribes to the refs it read (re-scheduling on change), and enqueues the
  effect onto a `Queue`. A `forkScoped` supervisor drains the queue — `forkChild`
  per run, prior run `Fiber.interrupt`ed — on the **mount fiber**. Fork
  interrupted on scope close; ref subscriptions are a scope finalizer.
- **Channels:** because `forkScoped` forks the thunk's effect, the result folds
  its `R` — `asyncRef`/`Async` are `Effect<…, never, R | Scope>` with **no cast**.
  Extract services with `yield* Service` before the thunk so they fold into the
  *component's* `R` (a missing Layer is a compile error at `mount`). The
  construction `E` is always `never` — the fetch never fails the build. The
  failure's home is the `failure`-arm choice above: rendered at the leaf
  (`View<never>`), or riding the live channel (`View<E>`) to the nearest
  `Catch`. Contrast in-component fetching (UserPage), where `E`+`R` fold to
  the root.

Why NOT `Atom`/`Atom.runtime` for this: an `Atom.runtime(layer)` bakes the
Layer in and discharges `R` (loses the thesis); a per-call runtime built
from a captured context dies "registry disposed" once the creating program
returns. Running the user's Effect directly on the mount fiber is what
keeps `R` folded. `Atom`/`AtomRef` remain the right tool for *synchronous*
reactive state (Counter, `list`) — just not the spine for effectful data.

## `Catch` — the view-level error boundary

`Catch` mirrors Effect's `catch*`: recover the **failure** side of a view
subtree, let success pass through (the child renders itself). Contrast `Async`,
which matches a data `AsyncResult` and renders *every* state — a boundary only
supplies the failure fallback. **One overloaded helper, two forms** picked by the
second argument:

- **catch-all** — `Catch(child, (cause, reset) => fallback)`. The handler gets the
  *precise* `Cause<EC | EV>` (both the construction `EC` and live `EV` of the
  child — not `Cause<unknown>`) and discharges everything to
  `Effect<View<never>, never, R | Scope>`.
- **tag-selective** — `Catch(child, { Tag: (error, reset) => …, … })`. Handles a
  subset of the child's error tags (each handler gets the unwrapped tagged error)
  and **narrows** both channels by `Exclude<E, { _tag }>`. Keys are constrained to
  the child's actual error tags — a typo'd key is a compile error *when it is the
  only key*; mixed with ≥1 valid key it is silently accepted (the exactness guard
  is omitted to preserve per-handler `error` inference). That is a safe
  over-approximation, not a soundness hole: a bad key just yields a dead handler,
  and the residual keeps its tag in `E`, so no error is ever wrongly discharged —
  an ergonomic gap, not a soundness one. A leftover tag must still be discharged
  before `mount`.

Both run over the internal `makeBoundary(child, accepts, handler)` (builds the
`Boundary` node, drives `state`); they differ only in `accepts` (catch-all = always;
tag-map = `_tag ∈ keys`) and how the handler is invoked. A cause a tag-map doesn't
`accept` is **escalated**: at construction it re-raises on the Effect channel (its
residual rides `EC`, so a parent boundary / `mount` still sees it); when live it
goes to the ambient sink (the parent boundary — `mount` hands it over via the
node's `setAmbient`). Tag-selective only catches errors in the *type*; an untyped
event-handler/reactive error needs the catch-all form.

A subtree with undischarged errors won't pass `mount` — that's the thesis. (The
fallback's own `E`/`R` are permissive `any`/not folded — keep it pure markup, like
`Async`'s arms.)

Catches **both phases** through one fallback:
- **construction** — `child`'s build Effect is run under `Effect.catchCause`; an
  accepted failure becomes the initial `error` state. Run **inline** in the gen
  (folds `R`, no first-paint flash), so a forgotten `Layer` is still a compile
  error at `mount`.
- **live** — a post-mount failure inside the rendered subtree (a reactive
  re-render via `coerceSync`, or an event-handler Effect) is routed to the
  boundary's `report` sink, which `buildDom` swaps in as `ctx.sink` for the child
  subtree (see "Runtime error routing"). The fallback itself renders with the
  *ambient* sink, so a failure in the fallback bubbles to the next boundary out.

`reset()` re-runs construction. **`report` and `reset` both go through a `Queue`
drained by a `forkScoped` loop** (like `asyncRef`) — never mutating boundary
state synchronously inside the child's render, which would close the child scope
mid-render (reentrant). The runtime impl runs on a deliberately wider, untyped
signature (`Cause<unknown>` sink); the precise types live in the two public
overloads that front it.

**Two lifecycle details that are easy to get wrong (and were):**
- **Generation stamp.** Each `BoundaryState` carries a monotonic `gen`. Without
  it, `AtomRef.set` dedups via `Equal.equals`, and a reset that re-fails with a
  structurally-identical `Cause` is `Equal`-equal to the current state → no notify
  → a *dead retry button*. `gen` makes every emission distinct. Nuance: an
  `Effect.fn` child's causes are never `Equal`-equal in practice (each run's span
  annotation differs), so the hazard bites only span-less subtrees — which is why
  the MF-1 regression test uses an `Effect.fnUntraced` child; an `Effect.fn`
  child would pass vacuously.
- **Per-build construction scope.** Each child build (initial + every reset) runs
  in a fresh scope forked from the mount scope (`Scope.forkUnsafe` + `provideService(Scope.Scope, …)`),
  so a child's construction-time effects (an `asyncRef` supervisor + its
  finalizers, `acquireRelease`) are released when we swap away or reset — not
  leaked onto the mount scope. The prior build's scope is closed on swap/reset
  (`adopt`); the live one closes on teardown via the fork cascade. A build that
  fails with an *accepted* cause closes its scope immediately (nothing renders
  from it — error content holds no live scope). A reset whose rebuild is
  rejected (non-accepted tag) discards its just-built scope and keeps the
  current content; a rejected cause that is interrupt-only (rebuild torn down
  mid-flight) is dropped, not escalated.

Unlike `Async`, this **is** a View IR variant (`Boundary`) — the sink-swap for
the child subtree is a `buildDom`-time concern an existing `Reactive` can't
express. The compiler skips the `h.track` wrap for `Catch(...)` calls (in
`isSelfTrackingCall` alongside `Async`); import `Catch` unaliased.

**Scope/fiber lifetime is uniform across the runtime** — internalize this when
touching any of it: construction effects bind to a per-build scope (above),
event-handler fibers are `Effect.forkIn(scope)`-ed into the element scope (`mount.ts`
`runHandlerEffect`), reactive/list subtrees go through `buildScopedChild`, and
`asyncRef`'s supervisor is `forkScoped`. Every sink also guards
`Cause.hasInterruptsOnly` so a teardown interrupt isn't surfaced as a failure.
Anything forked must be tied to a scope that closes when its DOM does.

## mount internals — invariants

**`BuildCtx` carries the scope-independent deps; `Scope` is threaded
separately.** Signature: `buildDom(view, ctx: BuildCtx, scope: Scope.Scope)
→ Node`, where `BuildCtx = { registry, context, sink }`. `registry` is the
`AtomRegistry`; `context` is the ambient Effect context captured at `mount`
(used to run event-handler Effects with the app's services); `sink` is the
error sink (see "Runtime error routing" below). These three are stable for the
whole tree, so they ride in `ctx`; `scope` is passed alongside because it
changes per dynamic subtree. Every subscription, event listener, and per-row
`Effect.acquireRelease` release registers a finalizer on the scope (directly
via `Scope.addFinalizer`, or via a forked child for sub-trees that need their
own lifetime). On scope close, parent-fork cascade tears everything down.
There is no `{ node, cleanup }` wrapper return type — closing the surrounding
scope IS the cleanup.

**Runtime error routing — the sink.** A post-mount failure has no Effect `E`
channel to land on (the component's build Effect already succeeded), so it is
routed to `ctx.sink: (cause: Cause<unknown>) => void` instead of being
swallowed. Two producers: (1) a **reactive re-render** whose Effect fails —
`coerceSync` calls `sink(cause)` and renders `Empty` (it no longer stringifies
`[effect failed: …]` into the DOM); (2) an **event handler** that returns an
Effect — `applyProp` runs it on the captured context (`Effect.runForkWith(ctx.context)`,
so it gets the app's services) forked into the element's DOM `scope`
(`Effect.forkIn(scope)`, so the fiber is interrupted when the element is removed),
with `Effect.matchCause` routing its failure to the same sink.
Both guard with `Cause.hasInterruptsOnly` — a pure-interrupt cause is scope
teardown, not an error, and is dropped. The root sink (`mount`) logs via
`Effect.logError` on the captured context; a `Catch` boundary replaces the
sink per-subtree (`buildDom` swaps in the boundary's `report` for the child — see
"`Catch`"). A handler that returns a non-Effect value runs as a plain
imperative callback, unchanged.

**`subscribeRefScoped` / `subscribeAtomScoped`** are the only two
ways to subscribe to a reactive source from inside `mount.ts`.
They register the `dispose` callback as a `Scope.addFinalizer`
finalizer. Don't subscribe outside these helpers — the dispose
function would have no scope to bind to and would leak on teardown.

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
registers releases on *that* render's scope. A failing render Effect
is routed to the `sink` (passed as `coerceSync`'s third arg) and renders
`Empty` — see "Runtime error routing" above. `coerceSync` is
deliberately asymmetric vs. `coerceAsync`: at this point in the
render path the Atom/AtomRef has already been peeled, so it does
NOT recurse into Option/Result/Chunk/Atom/AtomRef. Don't "fix" that
— the unwrap contract belongs upstream.

**Reactive ordering: build NEW → swap DOM → close OLD.** Per emit,
fork a fresh child scope from the Reactive's scope, build the new
subtree into it (subscribing whatever refs the new subtree needs),
swap into the DOM via `replaceChild`, THEN close the previous
emit's child scope. The reverse order (close OLD first, then build
NEW) would unsubscribe many refs and resubscribe many during a
single `notify` loop on the source — the same "diff, not
unsub-all-then-resub" hazard documented for `h.track`.

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
`{index.value}` therefore updates **without re-rendering the row**.
Reading `index.value` tracks via
`h.read` like any ref. A reorder/shift never rebuilds a row's DOM; only
`insert` builds and `remove` tears down.

**List snapshot must be a copy, not a reference.** Effect's
`CollectionImpl` mutates its internal array in place on `push`/
`remove`, so storing `view.source.value` and later comparing
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
- Don't make `coerceSync` peel Option/Result/Chunk/Atom/AtomRef.
  Those containers are unwrapped upstream of the Reactive render
  path; adding peeling here would either silently re-introduce
  async dependencies into a sync hot path or grow dead code.
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
- Don't extend `h.track`'s behavior to handle composite expressions
  — the compiler decides what's rewritten; the runtime just executes.
- Don't subscribe to `AtomRef.Collection` per-item-value events
  (only to structural events). Rows do their own value reactivity.
- Don't expose helpers that wrap Effect's own combinators
  (`Effect.map`, `Atom.map`, etc.). API surface is intentionally
  minimal — users compose with native Effect primitives.

## Known limits

### Generic components DO survive JSX tags (since #71) — one caveat

Component tags lower to direct calls (`<Row item={x}/>` →
`Row({ item: x })`), so a generic component's `T` infers natively at
the call site. `list()` is the keyed reconciliation primitive only —
not a generics workaround (the compiler still rewrites
`{coll.value.map(item => <Row/>)}` into `list(coll, …)`).

The caveat: a **tracked attr** still erases. An attr value containing a
`.value` read gets wrapped in `h.track(() => …)`, whose return type is
`unknown` — so `<Row item={ref.value}/>` passes `item: unknown`. Static
attrs pass through untouched (the empty-deps early return in `h.track`
is what preserves them). Same trade-off as before #71, now scoped to
reactive attrs only.

Don't "fix" anything here by widening `h()`'s signature — `h` is
intrinsic-only since #71 and the narrow signature is what makes child
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

### `h.read` overload preserves arbitrary `.value` types

`h.read` is intentionally overloaded two ways:

```ts
function read<T>(obj: AtomRef.ReadonlyRef<T>): T
function read<T extends HasValue>(obj: T): T["value"]
```

(`HasValue = { readonly value: unknown }`.) The second signature
is **load-bearing**: it lets compiled code like `h.read(s).bio`
(where `s` is an `AsyncResult.Success` and the source said
`s.value.bio`) type-check against `Success`'s payload. Drop it
and every pattern-match site against `AsyncResult` / `Option` /
`Result` shapes that reads `.value` inside a JSX expression
breaks. There is **no** nullable overload: reading `.value` on a
possibly-null base is a type error in the source `.value` form
too, and `h.read` now mirrors that — it is byte-for-byte
`obj.value` at runtime (it throws on null; there is no `?.`
swallow). The TS-side overloads are independent of the runtime
behavior (for AtomRefs it tracks; for anything else it's identity
to `.value`). Optional chaining (`obj?.value`) is left un-rewritten
by the compiler, so it never reaches `h.read`.

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
