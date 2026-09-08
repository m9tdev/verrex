import { Cause, Context, Effect, Equal, Exit, Option, Scope } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import {
  coerceSync,
  type ErrorSink,
  isAtomRef,
  isHandlerKey,
  type SyncRunner,
} from "./coerce.ts"
import { plan } from "./reconcile.ts"
import { bindRootSink } from "./reader.ts"
import { type BoundaryState, type Props, View, type ViewNode } from "./View.ts"

// Stable, scope-independent dependencies threaded through the whole build path.
// `scope` is passed separately because it changes per dynamic subtree; these
// three don't. `context` is the ambient Effect context captured at mount — used
// to run event-handler Effects with the app's services. `sink` is where a
// post-mount failure goes (see coerce.ts `ErrorSink`).
interface BuildCtx {
  readonly registry: AtomRegistry.AtomRegistry
  readonly context: Context.Context<never>
  readonly sink: ErrorSink
  // The scope that OWNS handler dispatches from elements built under this ctx
  // — the scope of the dynamic node that ran their construction —
  // NOT the element build `scope`, which a re-render closes and reforks. Set
  // per call site via `withOwner` (mount root, Reactive, List, Boundary — the
  // table lives in AGENTS.md "Handler-scope semantics"). Consumed only by
  // `runHandlerEffect`.
  readonly ownerScope: Scope.Scope
  // `Effect.runSyncExitWith(context)`, partially applied ONCE per context (the
  // curried runner allocates per application). It is a cache of `context`, so
  // it MUST stay paired with it — only the two BuildCtx constructors set it:
  // `mount` (root) and `withContext`. Don't hand-build a `{ ...ctx, context }`
  // that changes `context` without recomputing this; go through `withContext`.
  // The Element handler path never reads it (handlers consume only
  // `context`/`sink`), so that path doesn't derive a BuildCtx at all.
  readonly runSyncExit: SyncRunner
}

// Derive a node-scoped BuildCtx for a DYNAMIC-RENDER IR node that captured its
// construction context (Reactive re-renders, List rows, Boundary fallbacks) —
// these render through `coerceSync`, which needs the paired `runSyncExit`.
// Reference-equal captures (same fiber, no mid-tree provide) keep the parent
// ctx — no allocation on that path. (Static elements DON'T come here: their
// handlers need only context+sink, passed straight to `applyProps`.)
const withContext = (
  ctx: BuildCtx,
  context: Context.Context<never> | undefined,
): BuildCtx =>
  context === undefined || context === ctx.context
    ? ctx
    : {
        registry: ctx.registry,
        sink: ctx.sink,
        context,
        runSyncExit: Effect.runSyncExitWith(context),
        ownerScope: ctx.ownerScope,
      }

// Derive a ctx whose handler dispatches are owned by `owner`. The one
// sanctioned way to change `ownerScope` (it leaves `context`/`runSyncExit`
// paired, which is why a bare `{ ...ctx, ownerScope }` spread would also be
// safe — but go through here so the constructor rule stays "withContext /
// withOwner / mount root", never a hand-built spread).
const withOwner = (ctx: BuildCtx, owner: Scope.Scope): BuildCtx =>
  ctx.ownerScope === owner ? ctx : { ...ctx, ownerScope: owner }

// The deps a prop application consumes: the element's construction-captured
// `context` (the runtime side of FoldPropsR — a mid-tree provide is honored at
// dispatch), the `sink` a handler failure routes to, and the `registry` an
// Atom-valued prop (an `h.reader` or any Atom) is read/subscribed through. They
// travel together through applyProps → applyProp → the recursive reactive
// re-dispatch, so they ride as one value. Deliberately NOT the full
// `BuildCtx`: the static-element path must not derive a node ctx +
// `runSyncExit` runner it would never read (registry is the mount-stable
// singleton — no derivation, unlike the runner).
interface HandlerDeps {
  readonly context: Context.Context<never>
  readonly sink: ErrorSink
  readonly registry: AtomRegistry.AtomRegistry
  // Threaded from `BuildCtx.ownerScope` at build time; see there.
  readonly ownerScope: Scope.Scope
}

// Fire-and-forget an event-handler Effect. Runs on the element's
// captured context (the services ambient at construction — incl. a mid-tree
// Effect.provide).
//
// Two scopes, two lifetimes:
// - RESOURCES: a fresh per-dispatch child of `deps.ownerScope`, provided into
//   the handler and closed when it exits — `Scope.use` (onExit-based, so it
//   also closes on interruption). `acquireRelease` inside a handler therefore
//   releases per dispatch, and rapid dispatches don't share a scope.
//   Corollary: the handler's Scope is DISPATCH-lifetime — `forkScoped`, or an
//   `atom`/`fn` created inside a handler, dies when the dispatch
//   settles. Work that must outlive the click forks INTO a scope captured at
//   construction (`const s = yield* Effect.scope`) or `forkDaemon`s.
// - INTERRUPTION: the fiber is `forkIn(deps.ownerScope)` — the scope of the
//   node that RAN the element's construction, not the element's build scope. Do
//   NOT use the element's build scope as the owner — a handler would be
//   interrupted at its first suspension by the re-render its own write
//   triggers. The owner survives those re-emits, so the pending→run→settle
//   pattern completes, and the owner's own teardown still interrupts an
//   in-flight handler. Which scope is the owner per node, and what still
//   interrupts, is in AGENTS.md "Handler-scope semantics".
//
// Every non-success exit routes to the sink — INCLUDING an interrupt-only
// cause. Owner teardown interrupts an in-flight handler without running
// `matchCause`, so the observation point is `onExit` (a finalizer, which does
// run). An interrupt is not an error. `Catch.report` does not flip on it; it
// escalates it to the ambient sink. Mount's default `RootSink` logs it at
// debug level. This exists to make one symptom visible: "the handler never
// finished and nothing said so". The testing harness collects it on
// `ui.sinkCauses`.
const runHandlerEffect = (
  effect: Effect.Effect<unknown, unknown, never>,
  deps: HandlerDeps,
): void => {
  const dispatchScope = Scope.forkUnsafe(deps.ownerScope, "sequential")
  // BATCHING: the handler's SYNCHRONOUS
  // prefix runs inside `Atom.batch`, so a write that fans out through the
  // registry graph (a diamond `a → b, a → c, d = b + c`) recomputes `d` once
  // and writes the DOM once. Two load-bearing details:
  // - `startImmediately: true` — without it `forkIn` schedules the fiber on
  //   the dispatcher and the batch closes before a single write runs (the
  //   batch would cover nothing).
  // - only when no batch is open (`batchState.depth === 0`). `Registry.batch`
  //   does not restore the previous phase in `finally`: a batch opened while
  //   an outer batch is COMMITTING flips the phase back to `collect` and the
  //   invalidations it records are never rebuilt (dependents freeze until
  //   read). A handler dispatched synchronously inside a notify (an emission
  //   that focuses an input, say) is exactly that case, so we skip our batch
  //   and let the outer one collect the writes. Effect's own `fn` writes
  //   batch internally too; those nest fine (depth > 1 keeps collecting).
  // Writes after the first suspension (`yield* sleep`), from atom bodies,
  // streams or timers stay unbatched — accepted until upstream `batch` saves/
  // restores its phase.
  batchIfIdle(() =>
    Effect.runForkWith(deps.context)(
      Effect.forkIn(
        Effect.onExit(Scope.use(effect, dispatchScope), (exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) deps.sink(exit.cause)
          }),
        ),
        deps.ownerScope,
        { startImmediately: true },
      ),
    ),
  )
}

// `batchState` is exported from the registry module at runtime but marked
// `@internal` (absent from the .d.ts), hence the loose read. If a future
// effect stops exporting it we fall back to "never batch" rather than risk
// the nested-commit corruption above.
const registryBatchState = (
  AtomRegistry as unknown as { batchState?: { depth: number } }
).batchState
const batchIfIdle = (f: () => void): void => {
  if (registryBatchState !== undefined && registryBatchState.depth === 0) {
    Atom.batch(f)
  } else {
    f()
  }
}

// Subscribe to a ref and register the unsubscribe as a finalizer on the
// given scope. The teardown happens via scope close (full or cascade), so
// individual call sites never have to thread cleanup callbacks back up.
const subscribeRefScoped = <A>(
  ref: AtomRef.ReadonlyRef<A>,
  fn: (v: A) => void,
  scope: Scope.Scope,
): void => {
  const dispose = ref.subscribe(fn)
  Effect.runSync(Scope.addFinalizer(scope, Effect.sync(dispose)))
}

// AtomRegistry uses a different subscribe shape (registry.subscribe(atom, fn))
// than AtomRef. Same finalizer-register pattern; thin separate helper rather
// than overloading the shape.
const subscribeAtomScoped = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  fn: (v: A) => void,
  scope: Scope.Scope,
): void => {
  const dispose = registry.subscribe(atom, fn)
  Effect.runSync(Scope.addFinalizer(scope, Effect.sync(dispose)))
}

// The one seam where the two reactive source shapes converge: apply the
// current value (immediately, or deferred to `deferInitial` drain time — the
// deferred thunk re-reads the source THEN, so a write landing during the
// children build isn't clobbered by a stale capture), and subscribe `apply`
// for the rest of `scope`'s life. Dispatch on Atom (read/subscribe through
// the registry — an `h.reader`) vs AtomRef (direct). Both reactive
// consumers — `applyProp` and the Reactive child case — go through here; a
// third source shape means extending this, not a new dispatch site. A value
// that is neither is a no-op, matching what each call site did before the
// consolidation (both guarded with `isAtom`/`isAtomRef` and fell through).
const applyAndSubscribeSource = (
  source: unknown,
  registry: AtomRegistry.AtomRegistry,
  apply: (v: unknown) => void,
  scope: Scope.Scope,
  deferInitial?: Array<() => void>,
): void => {
  const read = Atom.isAtom(source)
    ? () => registry.get(source as Atom.Atom<unknown>)
    : isAtomRef(source)
      ? () => source.value
      : null
  if (read === null) return
  if (deferInitial) deferInitial.push(() => apply(read()))
  else apply(read())
  if (Atom.isAtom(source)) {
    subscribeAtomScoped(registry, source as Atom.Atom<unknown>, apply, scope)
  } else {
    subscribeRefScoped(source as AtomRef.ReadonlyRef<unknown>, apply, scope)
  }
}

// Props that must be written as DOM *properties*, not attributes. After user
// interaction the dirty value flag makes the `value` attribute and property
// diverge permanently — setAttribute then changes nothing visible. Same story
// for the boolean trio.
const FORM_BOOL_PROPS = new Set(["checked", "selected", "indeterminate"])
// `value` is restricted by tag — `key in el` alone over-matches elements with a
// numeric `value` IDL (<li>, <progress>, <meter>), where a string property
// write is wrong and the no-op guard is permanently defeated.
const VALUE_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "OPTION"])
const isFormProp = (el: Element, key: string): boolean =>
  key === "value"
    ? VALUE_TAGS.has(el.tagName)
    : FORM_BOOL_PROPS.has(key) && key in el

// Prop application consumes only `HandlerDeps` (captured context + sink +
// registry); it never touches the full `BuildCtx`, so the static-Element path
// passes that trio instead of deriving a node-scoped ctx + runner it would
// never use.
const applyProp = (
  el: Element,
  key: string,
  value: unknown,
  deps: HandlerDeps,
  scope: Scope.Scope,
  deferred?: Array<() => void>,
): void => {
  // Reactive prop: Atom (an `h.reader` or any Atom) or AtomRef → subscribe and
  // re-apply on changes. Same rolling child scope either way; only the
  // read/subscribe seam differs.
  if (Atom.isAtom(value) || isAtomRef(value)) {
    let lastChildScope: Scope.Closeable | null = null
    const apply = (v: unknown, defer?: Array<() => void>) => {
      if (lastChildScope) {
        const e = Scope.closeUnsafe(lastChildScope, Exit.void)
        if (e) Effect.runFork(e)
      }
      lastChildScope = Scope.forkUnsafe(scope, "sequential")
      applyProp(el, key, v, deps, lastChildScope, defer)
    }
    applyAndSubscribeSource(
      value,
      deps.registry,
      (v) => apply(v),
      scope,
      deferred && isFormProp(el, key) ? deferred : undefined,
    )
    return
  }

  if (isFormProp(el, key)) {
    const rec = el as unknown as Record<string, unknown>
    // `false` maps to "" like null — `value={cond && str}` must not
    // display "false".
    const next =
      key === "value"
        ? value == null || value === false
          ? ""
          : String(value)
        : Boolean(value)
    const write = () => {
      // Guard the write — assigning `value` unconditionally resets the caret
      // to the end, breaking mid-string editing.
      if (rec[key] !== next) rec[key] = next
    }
    // At initial build, children don't exist yet — `select.value = ...` would
    // be a silent no-op. Defer to after the appendChild loop; reactive
    // re-applications (no `deferred`) run immediately.
    if (deferred) deferred.push(write)
    else write()
    return
  }

  if (value == null || value === false) {
    el.removeAttribute(key)
    return
  }
  // Event handler: onClick, onInput, etc. (`isHandlerKey` — the gate shared
  // with h()'s capture predicate and mirrored by the type fold). The handler
  // may return an Effect — run it (on the element's captured context, so it
  // gets the services ambient at construction) and route its failure to the
  // sink. A handler that returns anything else (a plain imperative
  // `ref.set(...)`) just runs as before; non-Effect results are ignored.
  if (isHandlerKey(key) && typeof value === "function") {
    const event = key.slice(2).toLowerCase()
    const userHandler = value as (event: Event) => unknown
    const listener: EventListener = (e) => {
      const result = userHandler(e)
      if (Effect.isEffect(result)) {
        runHandlerEffect(result as Effect.Effect<unknown, unknown, never>, deps)
      }
    }
    el.addEventListener(event, listener)
    Effect.runSync(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => el.removeEventListener(event, listener)),
      ),
    )
    return
  }
  // style object
  if (key === "style" && typeof value === "object") {
    const style = (el as HTMLElement).style
    for (const [k, v] of Object.entries(value as Record<string, string>)) {
      style.setProperty(k, v)
    }
    return
  }
  // Boolean true → presence attribute
  if (value === true) {
    el.setAttribute(key, "")
    return
  }
  // Default: setAttribute
  el.setAttribute(key, String(value))
}

const applyProps = (
  el: Element,
  props: Props,
  deps: HandlerDeps,
  scope: Scope.Scope,
  deferred?: Array<() => void>,
): void => {
  for (const [k, v] of Object.entries(props)) {
    if (k === "children") continue
    applyProp(el, k, v, deps, scope, deferred)
  }
}

// Materialize a dynamic value into a DOM node under a fresh child scope forked
// from `parent`. Every dynamic subtree (a Reactive emit, a List row, Boundary
// content) goes through here so the "child scope is parent-LINKED, never an
// orphan" invariant lives in one place — closing `parent` cascades into the
// returned scope, so finalizers can't leak on an unexpected teardown path (see
// AGENTS.md).
//
// `handlerOwner` decides who owns handler dispatches from elements built in
// this subtree (BuildCtx.ownerScope): `"child"` = the freshly forked scope —
// its own close must interrupt them (List rows, Boundary content);
// `"inherit"` = the caller's owner — Reactive emissions, whose owner is the
// NODE so a handler survives the re-emit it triggers.
const buildScopedChild = (
  value: unknown,
  parent: Scope.Scope,
  ctx: BuildCtx,
  handlerOwner: "child" | "inherit",
): { readonly node: Node; readonly scope: Scope.Closeable } => {
  const scope = Scope.forkUnsafe(parent, "sequential")
  const buildCtx = handlerOwner === "child" ? withOwner(ctx, scope) : ctx
  const node = buildDom(
    coerceSync(value, scope, ctx.sink, ctx.runSyncExit),
    buildCtx,
    scope,
  )
  return { node, scope }
}

const closeScope = (scope: Scope.Closeable): void => {
  const e = Scope.closeUnsafe(scope, Exit.void)
  if (e) Effect.runFork(e)
}

const buildDom = (view: ViewNode, ctx: BuildCtx, scope: Scope.Scope): Node => {
  switch (view._tag) {
    case "Empty":
      return document.createComment("")

    case "Text":
      return document.createTextNode(view.value)

    case "Element": {
      const el = document.createElement(view.tag)
      // Handlers run on the context captured when h() built this element
      // (h captures only when a handler prop exists), so a mid-tree
      // Effect.provide is honored at click time (the runtime side of
      // FoldPropsR). Pass the `HandlerDeps` pair — handlers need only those,
      // so the static-element path never derives a node ctx/runner. Children
      // keep the ambient ctx. Hand-built nodes (no capture) fall back to
      // mount's context.
      // Form-control property writes are deferred past the children loop:
      // `select.value` assigned before its <option>s exist silently no-ops.
      const deferred: Array<() => void> = []
      applyProps(
        el,
        view.props,
        {
          context: view.context ?? ctx.context,
          sink: ctx.sink,
          registry: ctx.registry,
          ownerScope: ctx.ownerScope,
        },
        scope,
        deferred,
      )
      for (const child of view.children) {
        el.appendChild(buildDom(child, ctx, scope))
      }
      for (const write of deferred) write()
      return el
    }

    case "Fragment": {
      // We can't return a DocumentFragment directly because replacing it later
      // requires a stable reference. Wrap in a span with display:contents.
      const wrapper = document.createElement("span")
      wrapper.style.display = "contents"
      for (const child of view.children) {
        wrapper.appendChild(buildDom(child, ctx, scope))
      }
      return wrapper
    }

    case "Reactive": {
      // Placeholder; will be replaced on first render.
      let currentNode: Node = document.createComment("reactive-pending")
      // Rolling child scope: tracks the in-flight subtree's finalizers.
      // On parent close, the fork-cascade closes whatever is current — no
      // explicit teardown needed here.
      let renderChildScope: Scope.Closeable | null = null
      // Every emission builds on this node's construction-captured context
      // (mid-tree provides reach REBUILDS, not just first paint). Once per
      // node, reused per emission. Handler owner = `scope`, the scope THIS
      // node was built in (its lifetime) — not the per-emit child — so a
      // handler survives the re-emit its own write triggers.
      const nodeCtx = withOwner(withContext(ctx, view.context), scope)

      const render = (next: unknown): void => {
        // Build NEW subtree first (subscribing any refs it needs), THEN tear
        // down the OLD subtree. The reverse order would unsubscribe many
        // listeners and resubscribe many — the documented "diff, not
        // unsub-all-then-resub" hazard (see h.ts AGENTS.md) extends here.
        const { node, scope: newScope } = buildScopedChild(
          next,
          scope,
          nodeCtx,
          "inherit",
        )
        if (currentNode.parentNode) {
          currentNode.parentNode.replaceChild(node, currentNode)
        }
        if (renderChildScope) closeScope(renderChildScope)
        renderChildScope = newScope
        currentNode = node
      }

      // Initial synchronous render
      applyAndSubscribeSource(view.source, ctx.registry, render, scope)

      return currentNode
    }

    case "List": {
      // Wrapper element holds the rendered rows. `display: contents` makes the
      // wrapper invisible to CSS so list items still get the right styling
      // from their actual parent (e.g. `<ul>`).
      const wrapper = document.createElement("span")
      wrapper.style.display = "contents"

      // Per-row: its DOM node, its own scope (holds every finalizer the row
      // registered — subscriptions, user `acquireRelease` releases), and a
      // reactive index ref the planner's `keep`/`move` ops update. Keyed by
      // an opaque KEY: the row's AtomRef (Collection source — identity IS the
      // key) or the user's key value (Keyed source), so reactivity is
      // preserved across reorders/inserts.
      type Row = {
        readonly node: Node
        readonly rowScope: Scope.Closeable
        readonly indexRef: AtomRef.AtomRef<number>
      }
      const rendered = new Map<unknown, Row>()
      // Rows build on the list's construction-captured context — the runtime
      // side of For's folded row R (see ViewList.context).
      const nodeCtx = withContext(ctx, view.context)
      // The planner's `prev`. For a Collection, snapshot the ARRAY (not just
      // the reference!) — CollectionImpl mutates its internal array in place on
      // push/remove, so comparing references would never detect structural
      // changes.
      let snapshot: Array<unknown> = []

      // A plan's `before` is a row key; resolve it to the reference node.
      const nodeBefore = (key: unknown): Node | null =>
        key === null ? null : (rendered.get(key)?.node ?? null)

      // What a key renders as. Collection: the ref itself. Keyed: one derived
      // `Atom<T>` per key — `Atom.family` memoizes by key (WeakRef'd; released
      // once its registry node goes), reads the item out of an index Map that
      // is ITS OWN atom (so the array is indexed once per emission, not once
      // per row), and `withEquality(Equal.equals)` INSIDE the family fn (the
      // combinator returns a new atom object; applied at the use site it would
      // churn node identity per emission) so an unchanged item costs one Equal
      // check and no DOM write. Pinned by testing/for.test.ts.
      const rowHandle: (key: unknown) => unknown =
        view.source._tag === "Collection"
          ? (key) => key
          : (() => {
              const src = view.source
              const index = Atom.map(src.each, (items) => {
                const m = new Map<unknown, unknown>()
                for (const item of items) m.set(src.key(item), item)
                return m
              })
              return Atom.family((key: unknown) =>
                Atom.readable((get) => {
                  const m = get(index)
                  // A removed key's row atom recomputes BEFORE the structural
                  // reconcile tears the row down (the index atom notifies its
                  // dependents first): hold the last value rather than emit
                  // `undefined` into a row that is about to be removed.
                  return m.has(key)
                    ? m.get(key)
                    : Option.getOrUndefined(get.self())
                }).pipe(Atom.withEquality(Equal.equals)),
              )
            })()

      const setIndex = (row: Row, index: number): void => {
        if (row.indexRef.value !== index) row.indexRef.set(index)
      }

      // The diff itself lives in the pure `plan` (see reconcile.ts); this is
      // the interpreter — it just applies the ops to real DOM + scopes.
      const reconcile = (next: ReadonlyArray<unknown>): void => {
        for (const op of plan(snapshot, next)) {
          switch (op.op) {
            case "remove": {
              // Close the row scope first (firing the row's finalizers) THEN
              // detach the DOM, so user releases that observe DOM still see it.
              const row = rendered.get(op.key)
              if (row) {
                closeScope(row.rowScope)
                if (row.node.parentNode === wrapper)
                  wrapper.removeChild(row.node)
                rendered.delete(op.key)
              }
              break
            }
            case "insert": {
              const indexRef = AtomRef.make(op.index)
              // Handler owner = the rowScope: survives moves (DOM reparenting
              // only), closes on removal.
              const { node, scope: rowScope } = buildScopedChild(
                view.render(rowHandle(op.key), indexRef),
                scope,
                nodeCtx,
                "child",
              )
              rendered.set(op.key, { node, rowScope, indexRef })
              wrapper.insertBefore(node, nodeBefore(op.before))
              break
            }
            case "move": {
              const row = rendered.get(op.key)
              if (row) {
                wrapper.insertBefore(row.node, nodeBefore(op.before))
                setIndex(row, op.index)
              }
              break
            }
            case "keep": {
              const row = rendered.get(op.key)
              if (row) setIndex(row, op.index)
              break
            }
          }
        }
        snapshot = Array.from(next)
      }

      // Re-reconcile only on structural changes (a different key sequence).
      // A Collection also notifies on per-item value updates and a Keyed
      // source on any emission (handled by each row's own reactive bindings)
      // — those plan all-`keep`, so skipping them is a pure perf short-circuit,
      // not a correctness gate. Don't tighten it into something the diff
      // relies on.
      const onKeys = (next: ReadonlyArray<unknown>): void => {
        const structural =
          next.length !== snapshot.length ||
          next.some((key, i) => key !== snapshot[i])
        if (structural) reconcile(next)
      }
      if (view.source._tag === "Collection") {
        const collection = view.source.collection
        reconcile(collection.value)
        subscribeRefScoped(collection, onKeys, scope)
      } else {
        const src = view.source
        const keysOf = (items: ReadonlyArray<unknown>) => items.map(src.key)
        // `applyAndSubscribeSource` reads once (initial reconcile) and then
        // subscribes through the registry, unsubscribing on scope close.
        applyAndSubscribeSource(
          src.each,
          ctx.registry,
          (items) => onKeys(keysOf(items as ReadonlyArray<unknown>)),
          scope,
        )
      }

      return wrapper
    }

    case "Boundary": {
      // The child subtree renders with a sink that reports into THIS boundary
      // (live failures flip its state to `error`); the fallback renders with
      // the ambient `ctx` sink, so a failure in the fallback bubbles to the
      // next boundary outward. `setAmbient` hands the boundary the parent sink
      // so a tag-selective boundary can escalate a cause it doesn't handle.
      // Same build-NEW → swap → close-OLD ordering as Reactive.
      view.setAmbient(ctx.sink)
      const childCtx: BuildCtx = { ...ctx, sink: view.report }
      // The fallback builds on the boundary's construction context (the ok
      // content needs no swap — it was built by the boundary's drain fiber,
      // which inherits that context) while keeping the AMBIENT sink, so a
      // failure in the fallback still bubbles outward.
      const fallbackCtx = withContext(ctx, view.context)
      let currentNode: Node = document.createComment("boundary-pending")
      let contentScope: Scope.Closeable | null = null

      const render = (st: BoundaryState): void => {
        // Handler owner = the per-flip content scope, so a flip interrupts
        // prior-generation dispatches — a stale failure can't re-flip a reset
        // boundary. Boundary state flips only on report/reset, never on an
        // ordinary handler write, so a handler is not interrupted by its own
        // write.
        const built =
          st._tag === "ok"
            ? buildScopedChild(st.view, scope, childCtx, "child")
            : buildScopedChild(
                view.handler(st.cause, view.reset),
                scope,
                fallbackCtx,
                "child",
              )
        if (currentNode.parentNode) {
          currentNode.parentNode.replaceChild(built.node, currentNode)
        }
        if (contentScope) closeScope(contentScope)
        contentScope = built.scope
        currentNode = built.node
      }

      render(view.state.value)
      subscribeRefScoped(view.state, render, scope)
      return currentNode
    }
  }
}

/**
 * The root error sink, as a `Context.Reference` (a service with a default, so
 * it never shows up in `R`). It receives every live `Cause` no `Catch`
 * boundary caught — a failing handler or re-render — and the interrupt-only
 * cause of a handler torn down mid-flight. The default logs: errors via
 * `Effect.logError`, interrupts via `Effect.logDebug` with a hint (below the
 * default `Info` level; raise it to see them).
 *
 * Override it like any Effect service, provided AROUND `mount` (it is read
 * once, from mount's context — not from a subtree's):
 * `Effect.provideService(mount(app, el), RootSink, (cause) => report(cause))`
 * or `Layer.succeed(RootSink, …)`. The sink runs forked and unsupervised:
 * keep it infallible (a sink that fails is dropped without a trace), and
 * note an async sink is not awaited by teardown. The testing harness provides
 * one that collects into `ui.sinkCauses`.
 */
export const RootSink = Context.Reference<
  (cause: Cause.Cause<unknown>) => Effect.Effect<void>
>("verrex/RootSink", {
  defaultValue:
    () =>
    (cause): Effect.Effect<void> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.logDebug(
            "verrex: an event handler was interrupted before it completed",
            cause,
          )
        : Effect.logError(cause),
})

/**
 * What a completed `mount` hands back: the internals a caller legitimately
 * needs to drive the mounted tree from outside it.
 *
 * Deliberately narrow. Teardown is NOT here — the ambient `Scope` owns it
 * (close the scope and the DOM detaches, every finalizer fires, the registry
 * is disposed), and a second `unmount()` door would be a competing lifecycle.
 * The `RootSink` isn't here either: the caller provides it AROUND `mount`, so
 * it already holds it. Add a field only when reaching around the seam is the
 * alternative — that is the bar this interface exists to enforce.
 */
export interface MountHandle {
  /**
   * The `AtomRegistry` this mount created and owns. Live until the mount scope
   * closes (which disposes it). A test writes atoms through it
   * (`registry.set(a, v)`) against the SAME instance the tree subscribed on;
   * before this existed, the testing harness had to capture the registry by
   * flat-mapping the service out of the app effect — a reach-around that broke
   * silently (an `undefined` deref, not a type error) whenever `mount` moved
   * where it provides the registry.
   */
  readonly registry: AtomRegistry.AtomRegistry
}

/**
 * Run the app Effect, build the DOM, and attach to the target element.
 *
 * Cleanup is handled entirely through the ambient `Scope`. Every subscription,
 * event listener, and per-row `acquireRelease` registers a finalizer on this
 * scope (directly or via a forked child). Closing the surrounding scope
 * cascades to every child scope and runs all finalizers.
 *
 * Post-mount failures (a reactive re-render or an event-handler Effect that
 * fails) that aren't caught by a `Catch` boundary are routed to a root
 * error sink — the {@link RootSink} reference read from the captured context
 * (default: log). A handler interrupted mid-flight by its element's teardown
 * reaches the same sink as an interrupt-only `Cause` (the default logs that
 * at debug level, since teardown is not an error).
 *
 * **The `AtomRegistry` is owned by the mount, not required from context.**
 * `mount` creates a registry and disposes it in the same scope close that
 * detaches the DOM — the registry and the UI it drives always die together,
 * so a mis-scoped provision can't freeze a live UI. A component's
 * `yield* AtomRegistry.AtomRegistry` resolves to the mount's own registry
 * (it is provided to the app effect, and discharged from `R` here). It is also
 * handed back on the {@link MountHandle} this effect succeeds with, so a
 * caller outside the tree (the testing harness) reaches it through mount's
 * own interface instead of smuggling the service out of the app effect.
 *
 * **Requires `Effect<View<never>, never, R>`** — the app must have every error
 * discharged: construction failures off the Effect `E` channel (via
 * `Effect.catchCause` or a `Catch` boundary) and live failures off the
 * `View<E>` channel (via `Catch`). A leftover error is a compile error here
 * that names it — the runtime counterpart of a forgotten `Layer` naming a
 * service.
 */
export const mount = <R>(
  app: Effect.Effect<View<never>, never, R>,
  el: HTMLElement,
): Effect.Effect<
  MountHandle,
  never,
  Exclude<R, AtomRegistry.AtomRegistry> | Scope.Scope
> =>
  Effect.gen(function* () {
    const registry = AtomRegistry.make()
    // The real ambient context (carries the app's provided services). Typed
    // `never` so it threads without a generic — handler Effects are cast to
    // `R = never` at the run site; the services are present at runtime.
    const context = yield* Effect.context<never>()
    const rootSink = yield* RootSink
    const sink: ErrorSink = (cause) => {
      Effect.runForkWith(context)(rootSink(cause))
    }
    // Let a reader's re-render throw reach this sink (as a non-fatal defect)
    // from inside the synchronous registry read — see reader.ts.
    bindRootSink(registry, sink)
    const view = yield* Effect.provideService(
      app,
      AtomRegistry.AtomRegistry,
      registry,
    )
    const scope = yield* Effect.scope
    // Root handler owner = the mount scope (a static element under no dynamic
    // parent is interrupted only at app teardown).
    const ctx: BuildCtx = {
      registry,
      context,
      sink,
      runSyncExit: Effect.runSyncExitWith(context),
      ownerScope: scope,
    }
    // Registered BEFORE buildDom so LIFO close runs it LAST: the DOM detach
    // and every child-scope unsubscribe run against a still-live registry.
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()))
    const node = buildDom(view, ctx, scope)
    el.replaceChildren()
    el.appendChild(node)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (node.parentNode === el) el.removeChild(node)
      }),
    )
    return { registry } satisfies MountHandle
  })
