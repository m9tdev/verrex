import { Array as Arr, Cause, Channel, Effect, Exit, Fiber, Layer, Option, Pull, Queue, Scope, Stream, type Types } from "effect"
import { AsyncResult, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { coerceAsync, type ErrorSink, isAtomRef, trackDeps } from "./coerce.ts"
import type { FoldE, FoldLiveE, FoldR } from "./types/Fold.ts"
import { type BoundaryState, type Props, View } from "./View.ts"

export * as Component from "./Component.ts"
export { h } from "./h.ts"
export { mount } from "./mount.ts"
export { type Props, View } from "./View.ts"
// `Async`, `asyncRef`, `Catch`, `list`, `Fragment`, `VerrexLive` are declared + exported below.
export type {
  Child,
  ChildE,
  ChildLiveE,
  ChildR,
  FoldE,
  FoldLiveE,
  FoldR,
} from "./types/Fold.ts"
export type { HtmlEventHandlers, IntrinsicProps } from "./types/Html.ts"

/**
 * Reactive keyed list. Renders one row per item in `from`, keyed by the
 * item's `AtomRef` identity. Adds/removes only the rows that changed —
 * unaffected rows stay mounted with their DOM and subscriptions intact.
 *
 * Generic `T` is preserved through the function call site (which JSX
 * component tags can't do because of higher-rank polymorphism limits in
 * TypeScript). Use as `{list(coll, (item) => <Row item={item} />)}`.
 *
 * `index` is a reactive `ReadonlyRef<number>`, not a plain number: when a row
 * shifts position (because an earlier row was added or removed) or is reordered,
 * `mount` pushes the new index into this ref without re-rendering the row. Read
 * it as `index.value` (the compiler routes that through `h.read`, so it tracks
 * like any other ref) to display a live position.
 *
 * **Breaking:** `index` was a plain `number` in earlier versions; it is now a
 * `ReadonlyRef<number>`. Migrate `i` → `i.value` (and note `i` can no longer be
 * used in arithmetic without `.value`).
 */
export const list = <T>(
  from: AtomRef.Collection<T>,
  render: (
    item: AtomRef.AtomRef<T>,
    index: AtomRef.ReadonlyRef<number>,
  ) => View | Effect.Effect<View, never, Scope.Scope> | Effect.Effect<View, never, never>,
): View =>
  View.List({
    source: from as AtomRef.Collection<unknown>,
    render: render as (
      item: AtomRef.AtomRef<unknown>,
      index: AtomRef.ReadonlyRef<number>,
    ) => unknown,
  })

/**
 * What `asyncRef` returns: the reactive result plus a manual `refetch`.
 * `refetch` re-runs the thunk with a fresh dep snapshot — exactly what a
 * tracked-dep change triggers — interrupting the stale run, and flips the
 * state to waiting SYNCHRONOUSLY (so a re-render in the same tick observes
 * it). It returns `false` — a silent no-op, request dropped — once the
 * creating scope has closed: a retained handle can't resurrect
 * subscriptions, and the return value is how a caller tells a dead handle
 * from a scheduled run. The handle outlives any view rendering it: an
 * `Async` subtree swapped away by a `Catch` does not stop the fetch loop.
 */
export interface AsyncHandle<A, E> {
  readonly state: AtomRef.ReadonlyRef<AsyncResult.AsyncResult<A, E>>
  readonly refetch: () => boolean
}

/**
 * What `Async` accepts in `from` position: a thunk (creates a
 * boundary-private handle; `R` folds here) or an existing {@link AsyncHandle}
 * (data decoupled from the view). The `R = never` default is LOAD-BEARING: a
 * handle mentions no `R`, so without it inference would fall back to
 * `unknown` and poison the fold — every `Async` overload must keep the
 * default. A callable value is ALWAYS treated as a thunk, even if it also
 * carries handle-shaped properties — don't build callable handle hybrids.
 */
type AsyncSource<A, E, R = never> = (() => Effect.Effect<A, E, R>) | AsyncHandle<A, E>

/**
 * The reactive effectful data primitive — the async leaf of the
 * errors-as-values model, and what `<Async>` is sugar over.
 *
 * `asyncRef(() => effect)` runs `effect` on the **mount fiber** (so its `R`
 * folds into the component — a forgotten `Layer` is a compile error at the root
 * `mount`) and returns an {@link AsyncHandle}: a reactive `AsyncResult<A, E>`
 * you handle with Effect's own `AsyncResult.match`, plus a manual `refetch`:
 *
 * ```tsx
 * const user = yield* asyncRef(() => http.getUser(userId.value))
 * //    user: AsyncHandle<User, HttpError>
 * <button onclick={user.refetch}>refresh</button>
 * {user.state.map(AsyncResult.match({ onInitial, onFailure, onSuccess }))}
 * // or hand the handle to Async for the arms/boundary sugar:
 * {Async(user, { initial, failure, success })}
 * ```
 *
 * Reactivity is discovered, not declared: any ref the thunk reads (`.value` →
 * `h.read`) becomes a dependency and the effect re-runs (interrupting the stale
 * run) when it changes — the thunk is the re-run scope; `refetch` triggers the
 * same re-run manually. Built on `AtomRef` + `AsyncResult` + `forkScoped`; no
 * `Atom.runtime` (which would discharge `R`), no new View IR.
 */
export const asyncRef = <A, E, R>(
  effect: () => Effect.Effect<A, E, R>,
): Effect.Effect<AsyncHandle<A, E>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const state = AtomRef.make<AsyncResult.AsyncResult<A, E>>(AsyncResult.initial(true))
    const scope = yield* Effect.scope

    // A "run" request carries the effect to fork. The first is produced by
    // running the thunk under dep-tracking; each tracked ref's change enqueues
    // a fresh run (re-running the thunk to pick up new ref values + deps).
    const runs = yield* Queue.unbounded<Effect.Effect<A, E, R>>()
    let unsubs: Array<() => void> = []
    let closed = false

    const schedule = (): boolean => {
      // `schedule` escapes this scope as `refetch`/`retry` (handed to failure
      // arms), so a retained reference can fire after teardown — a stashed
      // retry in a setTimeout, a click racing a boundary swap. Once the scope
      // closes this must be a no-op: re-subscribing would register
      // subscriptions the (already-run) finalizer can never clean, and the
      // queue's only consumer is dead. `false` is the caller's only signal.
      if (closed) return false
      // Flip to waiting SYNCHRONOUSLY, before the run is even enqueued: a
      // rebuild in the same tick — `refetch(); reset()` in either order —
      // must observe waiting, not re-escalate the stale non-waiting Failure.
      // (The supervisor's own set on take is a deduped duplicate, and
      // corrective in the rare interleaving where the prior run completes in
      // between. At construction the state is already Initial(waiting) — the
      // set dedups to a no-op.)
      state.set(AsyncResult.waitingFrom(Option.some(state.value)))
      for (const u of unsubs) u()
      unsubs = []
      const { result: eff, deps } = trackDeps(effect)
      for (const dep of deps) unsubs.push(dep.subscribe(schedule))
      Queue.offerUnsafe(runs, eff)
      return true
    }
    schedule() // initial run + dep subscriptions
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        closed = true
        for (const u of unsubs) u()
        // Cleared so nothing can ever replay the already-run unsubscribers —
        // AtomRef's unsubscribe is not idempotent.
        unsubs = []
      }),
    )

    // Supervisor loop on the mount fiber: one child at a time; a new run
    // interrupts the prior. Scope close interrupts loop + live child.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        let child: Fiber.Fiber<void, never> | null = null
        let first = true
        while (true) {
          const eff = yield* Queue.take(runs)
          if (child) yield* Fiber.interrupt(child)
          // First run shows Initial(waiting); a refetch keeps the prior result with
          // a waiting flag (stale-while-revalidate) instead of flashing to Initial.
          state.set(first ? AsyncResult.initial(true) : AsyncResult.waitingFrom(Option.some(state.value)))
          first = false
          child = yield* Effect.forkChild(
            Effect.matchCause(eff, {
              onFailure: (cause) => {
                // A refetch interrupts the prior run; an interrupt-only cause is that
                // teardown, not a real failure — don't surface it as a Failure (the
                // guard every other sink in the runtime applies).
                if (!Cause.hasInterruptsOnly(cause)) state.set(AsyncResult.failure(cause))
              },
              onSuccess: (value) => { state.set(AsyncResult.success(value)) },
            }),
          )
        }
      }),
    )

    return {
      state: state as AtomRef.ReadonlyRef<AsyncResult.AsyncResult<A, E>>,
      refetch: schedule,
    }
  })

/**
 * The reactive *push* data primitive — `asyncRef`'s sibling for `Stream`.
 *
 * `streamRef(stream, initial?)` runs the stream on the **mount fiber** (so its
 * `R` folds into the component — a forgotten `Layer` is a compile error at the
 * root `mount`) and returns a `ReadonlyRef<A>` tracking the latest element.
 * The fiber is `forkScoped`-d: the stream is interrupted when the enclosing
 * scope closes — the Scope IS the unsubscribe. Derive with the ref's own
 * `.map` (equality-deduped) and interpolate like any ref:
 *
 * ```tsx
 * const now = yield* streamRef(tick)
 * //    now: AtomRef.ReadonlyRef<Date>
 * const seconds = now.map((d) => d.getSeconds())
 * <span>{seconds}</span>
 * ```
 *
 * `initial` picks the construction behavior, mirroring the blocking-vs-
 * placeholder split of the pull side (in-component fetch vs `Async`):
 * - **omitted** — construction *waits for the first element* by the same
 *   mechanism as `yield* http.getUser`: the first pull runs ON the
 *   constructing fiber (no forked producer, no hand-off), so the wait owns
 *   its work and teardown behaves exactly like a blocking fetch. A stream
 *   that never emits blocks construction (like a fetch that never resolves)
 *   — give sparse streams an `initial`; a stream that ENDS before its first
 *   element is a defect (fails loud, never hangs).
 * - **provided** — construction returns immediately; the ref holds `initial`
 *   until the first emission.
 *
 * The error channel must be `never`: a stream's failure happens *after*
 * construction succeeded, so there is no honest Effect channel to ride —
 * handle failures as values at the stream level (`Stream.catch*`,
 * `Stream.retry`, encode them in `A`) before handing it over. This mirrors
 * Effect's own boundary: `Atom.make(stream)` wraps state in `AsyncResult`
 * for the same reason; `streamRef` keeps the sync-read `A` contract instead
 * and pushes the failure story onto the stream where the combinators live.
 * Why not `Atom.make(stream)`: its source must already be context-free
 * (`R = AtomRegistry`), so a service-needing stream forces `Atom.runtime` —
 * which bakes the Layer and discharges `R`, losing the thesis. Running on
 * the mount fiber is what keeps `R` folded (same design as `asyncRef`).
 */
export const streamRef: {
  <A, R>(stream: Stream.Stream<A, never, R>): Effect.Effect<AtomRef.ReadonlyRef<A>, never, R | Scope.Scope>
  <A, R>(stream: Stream.Stream<A, never, R>, initial: A): Effect.Effect<AtomRef.ReadonlyRef<A>, never, R | Scope.Scope>
} = <A, R>(
  stream: Stream.Stream<A, never, R>,
  // A tuple rest (not `initial?: A`) so an EXPLICIT `undefined` still counts
  // as a provided initial when `A` includes `undefined`.
  ...initial: [A] | []
): Effect.Effect<AtomRef.ReadonlyRef<A>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    // One pull shared by the (optional) blocking first read and the forked
    // consumer — the stream is subscribed exactly once, bound to the
    // enclosing scope.
    const scope = yield* Effect.scope
    const pull = yield* Channel.toPullScoped(stream.channel, scope)
    const ref = initial.length > 0
      ? AtomRef.make(initial[0])
      : // No initial: block construction on the first chunk, ON THIS fiber —
        // the same mechanism as a blocking in-component fetch. No forked
        // producer means no hand-off a closing scope could orphan. A stream
        // that ends before its first element dies loud instead of hanging.
        AtomRef.make(
          Arr.lastNonEmpty(
            yield* Pull.catchDone(pull, () =>
              Effect.die(
                new Error(
                  "streamRef: the stream ended before its first element — provide an `initial` value",
                ),
              ),
            ),
          ),
        )
    yield* Effect.forkScoped(
      Effect.whileLoop({
        while: () => true,
        body: () => pull,
        step: (chunk) => {
          for (const a of chunk) ref.set(a)
        },
      }).pipe(
        // E is `never`, so the only typed failure left is the pull's
        // end-of-stream halt — the consumer just stops.
        Effect.catch(() => Effect.void),
      ),
    )
    return ref as AtomRef.ReadonlyRef<A>
  })

// ─── Tagged-error dispatch (shared by Async's tag-map `failure` arm and Catch) ─

type Tagged = { readonly _tag: string }

/**
 * Tag-selective handler map over `E`'s tagged members; `Extra` appends the
 * surface-specific trailing params (Catch's `reset`; Async's `retry`).
 * Both tag-map surfaces instantiate THIS alias so the deliberate trade-offs
 * live once: keys are constrained to the child's tags for per-handler `error`
 * inference, and the exactness guard is omitted on purpose — a typo'd key
 * beside ≥1 valid key is silently dead (its tag stays on the channel, so the
 * type never lies for inline literals), while a typo as the only key is a
 * compile error. Prototype-keyed objects and explicit-`undefined` slots are
 * rejected at construction by `assertHandlerMap`; pre-built maps whose TYPE
 * declares keys the value doesn't carry can still over-discharge — invisible
 * at runtime (erasure), documented limitation (#91).
 */
type TagHandlers<E, Extra extends ReadonlyArray<unknown> = []> = {
  readonly [K in Types.Tags<E>]?: (
    error: Extract<E, { readonly _tag: K }>,
    ...rest: Extra
  ) => View | Effect.Effect<View, any, any>
}

/**
 * Construction-time guard for tag-map handler objects (#91): the type level
 * discharges every `keyof Handlers`, but dispatch only honors OWN,
 * function-valued keys — so reject, loudly and at the call site, the two
 * shapes that would silently over-discharge: prototype-keyed objects (class
 * instances, whose methods never dispatch) and non-function slots
 * (`Tag: undefined`, which compiles for consumers without
 * `exactOptionalPropertyTypes`). The third gap — pre-built maps whose TYPE
 * declares keys the value doesn't carry — is invisible at runtime (erasure)
 * and stays a documented limitation.
 */
const assertHandlerMap = (handlers: Record<string, unknown>, surface: string): void => {
  const proto = Object.getPrototypeOf(handlers)
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `${surface}: a tag-map of handlers must be a plain object — handlers on a prototype (class instance) never dispatch (#91)`,
    )
  }
  for (const key of Object.keys(handlers)) {
    if (typeof handlers[key] !== "function") {
      throw new TypeError(
        `${surface}: tag-map handler "${key}" is not a function — its tag was discharged from the type but would never dispatch (#91)`,
      )
    }
  }
}

/**
 * The handler matching the cause's first error, when that error is tagged and
 * `handlers` carries an OWN, function-valued key for it (non-plain maps and
 * non-function slots are rejected up front by `assertHandlerMap`; the
 * remaining erasure gap is #91).
 * Dispatch is on the cause's FIRST error — if it is untagged, no handler
 * matches even when a later error's tag is mapped; the design assumes a single
 * failure per cause. Returns the handler together with the error it matched
 * on, so dispatch tag and handler argument can't drift apart across the two
 * tag-map surfaces.
 */
const taggedMatch = (
  handlers: Record<string, unknown>,
  cause: Cause.Cause<unknown>,
):
  | { readonly handler: (error: any, extra: () => void) => unknown; readonly error: unknown }
  | undefined => {
  const err = Option.getOrUndefined(Cause.findErrorOption(cause))
  const t =
    typeof err === "object" && err !== null && "_tag" in err ? (err as Tagged)._tag : undefined
  if (t === undefined || !Object.hasOwn(handlers, t)) return undefined
  const fn = handlers[t]
  return typeof fn === "function"
    ? { handler: fn as (error: any, extra: () => void) => unknown, error: err }
    : undefined
}

/**
 * The arms for `Async` / `<Async>`. Each maps to an `AsyncResult` variant.
 * Channels are accepted permissively (`any`) — the arms render at the node scope
 * and their E/R are NOT folded; only `from`'s `R` is (the thesis-bearing one).
 */
interface AsyncArmsBase<A> {
  readonly initial?: View | Effect.Effect<View, any, any>
  readonly success: (value: A) => View | Effect.Effect<View, any, any>
}
/** Handled form: `failure` renders the failure locally → `E` discharged.
 * `retry` re-runs the thunk (fresh dep snapshot) — the leaf analog of
 * `Catch`'s `reset`. */
interface AsyncArmsHandled<A, E> extends AsyncArmsBase<A> {
  readonly failure: (
    cause: Cause.Cause<E>,
    retry: () => void,
  ) => View | Effect.Effect<View, any, any>
}
/** Open form: no `failure` arm — the failure rides the live channel (`View<E>`). */
interface AsyncArmsOpen<A> extends AsyncArmsBase<A> {
  readonly failure?: never
}

/**
 * Async render boundary — **thunk-first positional**
 * (like `list`) so `A`/`E` are fixed from `from` before the arms are typed; a
 * single props object would collapse `success`'s value to `unknown`.
 *
 * `from` is a thunk **or an {@link AsyncHandle}**. A thunk can be inline or
 * extracted (`const getUser = () => http.getUser(userId.value)`); a ref read
 * inside it auto-refetches, and the handle it creates is private to this
 * boundary. Pass a handle (`const user = yield* asyncRef(getUser)`) when the
 * data should OUTLIVE the rendering subtree or be refetched from outside —
 * `user.refetch` keeps working after a `Catch` swaps the view away, and the
 * fetch loop is shared by every consumer of the handle. One semantic shift to
 * note: a boundary `reset` over a handle re-renders the handle's CURRENT
 * state and does not refetch (with a thunk, reset reconstructs the asyncRef →
 * fresh fetch); a still-failed handle re-escalates on rebuild, so compose
 * `() => { user.refetch(); reset() }` when retry should do both. (A
 * `<Async from initial failure success/>` JSX element that lowers to this
 * positional call is *planned*, not yet implemented — use the call form.)
 *
 * ```tsx
 * Async(() => http.getUser(userId.value), {
 *   initial: <p>loading…</p>,
 *   failure: (cause) => <p>error: {Cause.pretty(cause)}</p>,
 *   success: (user) => <h1>{user.name}</h1>,   // user: User (inferred)
 * })
 * ```
 *
 * Sugar over `asyncRef` + `AsyncResult.match`: `from` runs on the mount fiber so
 * its `R` folds into the component (forgotten Layer = compile error). The
 * `failure` arm picks the error's home, per call site (mirroring `Catch`'s
 * function-vs-object forms):
 *
 *  - **function** — catch-all: every failure is handled here as a value (the
 *    arm gets the full `Cause<E>` plus `retry`) and the result is
 *    `Effect<View<never>, never, R | Scope>` — fully discharged, nothing for a
 *    boundary to see.
 *  - **tag map** — `failure: { NotFound: (e) => … }`: a matched tag is handled
 *    here (the handler gets the unwrapped error) and the fetch loop STAYS
 *    LIVE — a dep change still refetches, so the view can recover with no
 *    boundary `reset`. The residual rides the live channel:
 *    `Effect<View<Exclude<E, { _tag }>>, never, R | Scope>`. Dispatch is
 *    `Catch`'s tag-map dispatch (the cause's first error, when tagged; own,
 *    function-valued keys — prefer inline literals: pre-built/widened maps
 *    can over-discharge, see #91). A typo'd key mixed with ≥1 valid key is
 *    silently dead — its tag stays on the channel. A tag map on an `E` with
 *    no tagged members is rejected at compile time.
 *  - **omitted** — the failure **rides the live channel**: the result is
 *    `Effect<View<E>, never, R | Scope>`, the failure (initial fetch *or* any
 *    refetch) routes to the nearest enclosing `Catch`, and `mount`'s
 *    `View<never>` gate makes a missing boundary a compile error naming `E`.
 *    The boundary's `reset` re-runs construction → a fresh fetch.
 *
 * Every failure handler (catch-all and tag-map) receives `retry: () => void`
 * as its last argument — it re-runs the thunk with a fresh dep snapshot, the
 * leaf analog of `Catch`'s `reset` (which re-runs *construction*). While the
 * re-run is in flight the `initial` arm renders (a stale error isn't content,
 * so failure-waiting doesn't get the stale-while-revalidate treatment that
 * success-waiting does). Call `retry` from event handlers only — calling it
 * during render (`failure: (c, retry) => { retry(); … }`) refetches in an
 * infinite loop.
 */
export function Async<A, E, R = never>(
  from: AsyncSource<A, E, R>,
  arms: AsyncArmsHandled<A, E>,
): Effect.Effect<View, never, R | Scope.Scope>
export function Async<
  A,
  E,
  // `never` when E has no tagged members: without it, Types.Tags<E> = never makes
  // the constraint the empty mapped type and ANY map compiles, silently dead.
  Handlers extends [Types.Tags<E>] extends [never] ? never : TagHandlers<E, [retry: () => void]>,
  R = never,
>(
  from: AsyncSource<A, E, R>,
  arms: AsyncArmsBase<A> & { readonly failure: Handlers },
): Effect.Effect<View<Types.ExcludeTag<E, keyof Handlers & string>>, never, R | Scope.Scope>
export function Async<A, E, R = never>(
  from: AsyncSource<A, E, R>,
  arms: AsyncArmsOpen<A>,
): Effect.Effect<View<E>, never, R | Scope.Scope>
export function Async<A, E, R = never>(
  from: AsyncSource<A, E, R>,
  arms: AsyncArmsBase<A> & {
    readonly failure?:
      | ((cause: Cause.Cause<E>, retry: () => void) => View | Effect.Effect<View, any, any>)
      | Record<string, unknown>
  },
): Effect.Effect<View<E>, never, R | Scope.Scope> {
  const { failure } = arms
  // Fail fast at the call site: a tag map that can't dispatch is a
  // programming error, not a renderable failure.
  if (failure && typeof failure === "object") assertHandlerMap(failure, "Async")
  // A thunk creates the handle here (its R folds); an existing AsyncHandle is
  // subscribed as-is — the data outlives this subtree, so a boundary `reset`
  // re-renders the handle's CURRENT state and does NOT refetch (compose
  // `() => { handle.refetch(); reset() }` when retry should do both).
  // Fail fast on a non-handle smuggled past the types (cast, JS) — same
  // stance as assertHandlerMap.
  if (typeof from !== "function" && !isAtomRef(from.state)) {
    throw new TypeError("Async: `from` is neither a thunk nor an AsyncHandle (`state` is not an AtomRef)")
  }
  return (typeof from === "function" ? asyncRef(from) : Effect.succeed(from)).pipe(
    Effect.map(({ refetch, state }) =>
      View.Reactive({
        source: state.map((r) =>
          AsyncResult.match(r, {
            onInitial: () => arms.initial ?? null,
            // Function arm: catch-all, renders the full Cause. Tag map: a
            // matched tag renders locally — the asyncRef stays live, so a dep
            // change still refetches and can recover. Unmatched/absent: emit
            // the cause as a failing Effect; the Reactive render path
            // (`coerceSync`) runs it, routes the cause to the subtree's error
            // sink — the nearest `Catch`'s `report` — and renders nothing. The
            // interrupt-only guard already ran in `asyncRef` (teardown never
            // reaches the Failure state).
            onFailure: (f) => {
              // Retry/refetch in flight (`waiting` flag): render the initial
              // arm instead of re-invoking the failure arm with the stale
              // cause. Stale-while-revalidate keeps CONTENT (success-waiting
              // renders the success arm); a stale error isn't content, and
              // re-invoking the arm would rebuild its DOM (including any
              // retry button) mid-flight. Also the observable that makes
              // "retry is running" testable.
              if (f.waiting) return arms.initial ?? null
              if (typeof failure === "function") return failure(f.cause, refetch)
              // Truthiness (not === undefined): a nullish `failure` smuggled
              // past the types degrades to the open form instead of crashing
              // `Object.hasOwn` — matching the pre-tag-map behavior.
              const match = failure ? taggedMatch(failure, f.cause) : undefined
              return match ? match.handler(match.error, refetch) : Effect.failCause(f.cause)
            },
            onSuccess: (s) => arms.success(s.value),
          }),
        ) as AtomRef.ReadonlyRef<unknown>,
      }),
    ),
  )
}

// ─── Error boundary (Catch) ────────────────

/**
 * Shared boundary machinery for `Catch` (both forms). `accepts`
 * decides which causes THIS boundary handles; a non-accepted cause re-raises at
 * construction (its residual rides the Effect channel → a parent boundary / fails
 * mount) and escalates to the ambient sink when live. The typed public wrappers
 * below cast the residual to its precise shape.
 */
// The outcome of one child build: shown content (ok / accepted error) + the scope
// its construction-time effects live in, or a cause this boundary doesn't accept.
type BuildOutcome =
  | { readonly content: BoundaryState; readonly scope: Scope.Closeable }
  | { readonly rejected: Cause.Cause<unknown>; readonly scope: Scope.Closeable }

const makeBoundary = <R>(
  child: Effect.Effect<View<any>, any, R>,
  accepts: (cause: Cause.Cause<unknown>) => boolean,
  handler: (cause: Cause.Cause<unknown>, reset: () => void) => unknown,
): Effect.Effect<View<never>, unknown, R | Scope.Scope> =>
  Effect.gen(function* () {
    const mountScope = yield* Effect.scope
    // Ambient (parent) sink — set by mount via the node's `setAmbient`. A cause
    // this boundary doesn't `accept` escalates here. A catch-all never escalates.
    let ambient: ErrorSink = () => {}
    const setAmbient = (sink: ErrorSink): void => { ambient = sink }

    // Monotonic generation: `AtomRef.set` dedups via `Equal.equals`, so a build
    // that fails with a structurally-identical `Cause` would be `Equal`-equal to
    // the current state and silently not notify (a dead retry). `gen` makes every
    // emission distinct.
    let gen = 0
    // Construction scope of the CURRENT content: a child's construction-time effects
    // (an `asyncRef` supervisor + finalizers, `acquireRelease`, …) bind to a fresh
    // scope forked from the mount scope, so they're released when we swap away or
    // reset rather than leaking onto the mount scope. The fork cascade closes the
    // live one on teardown; `adopt` closes the prior one mid-life. Error content
    // holds no scope: a failed build renders nothing, so its scope closes the
    // moment the failure is accepted — partial resources never idle behind the
    // fallback.
    let activeBuild: Scope.Closeable | null = null
    const close = (s: Scope.Closeable | null): void => {
      if (!s) return
      const e = Scope.closeUnsafe(s, Exit.void)
      if (e) Effect.runFork(e)
    }
    const adopt = (s: Scope.Closeable): void => {
      close(activeBuild)
      activeBuild = s
    }

    // Build `child` in a fresh scope. Returns content + that scope, or `{ rejected }`
    // for a cause this boundary doesn't accept. Never fails. An interrupt-only cause
    // (teardown) is treated as not-accepted, so a catch-all doesn't render a fallback
    // for a build interrupted mid-flight.
    const build = (): Effect.Effect<BuildOutcome, never, R> =>
      Effect.suspend(() => {
        const scope = Scope.forkUnsafe(mountScope, "sequential")
        return Effect.matchCause(Effect.provideService(child, Scope.Scope, scope), {
          onSuccess: (view): BuildOutcome => ({ content: { _tag: "ok", view, gen: gen++ }, scope }),
          onFailure: (cause): BuildOutcome =>
            accepts(cause) && !Cause.hasInterruptsOnly(cause)
              ? { content: { _tag: "error", cause, gen: gen++ }, scope }
              : { rejected: cause, scope },
        })
      })

    // Initial build inline (folds R; no first-paint flash). A rejected cause here
    // re-raises on the Effect channel — the residual rides `EC` to a parent boundary
    // / fails `mount`.
    const first = yield* build()
    if ("rejected" in first) {
      close(first.scope)
      return yield* Effect.failCause(first.rejected)
    }
    if (first.content._tag === "error") close(first.scope)
    else activeBuild = first.scope
    const state = AtomRef.make<BoundaryState>(first.content)
    const runs = yield* Queue.unbounded<{ readonly _tag: "reset" } | {
      readonly _tag: "error"
      readonly cause: Cause.Cause<unknown>
    }>()

    // Live failures: accepted → error state (via the queue, off the render stack —
    // a synchronous mutation would close the child scope mid-render); non-accepted
    // → escalate to the ambient sink. Interrupts (teardown) dropped.
    const report = (cause: Cause.Cause<unknown>): void => {
      if (Cause.hasInterruptsOnly(cause)) return
      if (accepts(cause)) Queue.offerUnsafe(runs, { _tag: "error", cause })
      else ambient(cause)
    }
    const reset = (): void => {
      Queue.offerUnsafe(runs, { _tag: "reset" })
    }

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const msg = yield* Queue.take(runs)
          if (msg._tag === "error") {
            // live error: tear down the current content's construction effects, swap.
            close(activeBuild)
            activeBuild = null
            state.set({ _tag: "error", cause: msg.cause, gen: gen++ })
          } else {
            // reset: re-build. ok → adopt new scope + swap; accepted error →
            // swap but close BOTH scopes (nothing renders from a failed build);
            // rejected → escalate to the parent and KEEP current content
            // (discard the new scope). A rebuild torn down mid-flight
            // (interrupt-only) is teardown, not an error — don't escalate it.
            const b = yield* build()
            if ("rejected" in b) {
              close(b.scope)
              if (!Cause.hasInterruptsOnly(b.rejected)) ambient(b.rejected)
            } else {
              if (b.content._tag === "error") {
                close(activeBuild)
                activeBuild = null
                close(b.scope)
              } else {
                adopt(b.scope)
              }
              state.set(b.content)
            }
          }
        }
      }),
    )

    return View.Boundary({ state, handler, reset, report, setAmbient })
  })

/**
 * View-level error boundary — `Catch`. Mirrors Effect's `catch*`: recover the
 * FAILURE side of a view subtree, let success pass through (the child renders
 * itself). Contrast `Async`, which matches a data `AsyncResult` and renders
 * *every* state — a boundary supplies only the failure fallback. Two forms,
 * picked by the second argument:
 *
 *  - **catch-all** — a function handler gets the precise `Cause<EC | EV>` and
 *    discharges *every* error to `never` (mountable):
 *    ```tsx
 *    {Catch(<UserCard id={id} />, (cause, reset) =>
 *      <div class="err">{Cause.pretty(cause)}<button onclick={reset}>retry</button></div>)}
 *    ```
 *  - **tag-selective** — a map of `_tag → handler` for any subset of the child's
 *    error tags (each handler gets the unwrapped tagged error). The result
 *    **narrows** both channels by `Exclude<E, { _tag }>`, so a leftover tag must
 *    still be discharged before `mount`. A non-matching error escalates to the
 *    next boundary out.
 *    ```tsx
 *    {Catch(<UserCard id={id} />, {
 *      HttpError: (e, reset) => <Banner status={e.status} onRetry={reset} />,
 *      ParseError: (e) => <p>bad data: {e.message}</p>,
 *    })}
 *    ```
 *
 * Catches both phases — **construction** (`child`'s build Effect fails) and
 * **live** (a post-mount reactive re-render or event-handler Effect). `reset()`
 * re-runs construction. `child`'s `R` folds (construction + every reset run on
 * the mount fiber); the fallback's own `E`/`R` are not folded — keep it pure
 * markup, like `Async`'s arms. Tag-selective only catches errors in the *type*;
 * an untyped event-handler or reactive error needs the catch-all form.
 */
export function Catch<EV, EC, R>(
  child: Effect.Effect<View<EV>, EC, R>,
  handler: (cause: Cause.Cause<EC | EV>, reset: () => void) => View | Effect.Effect<View, any, any>,
): Effect.Effect<View<never>, never, R | Scope.Scope>
export function Catch<
  EV,
  EC,
  R,
  Handlers extends TagHandlers<EC | EV, [reset: () => void]>,
>(
  child: Effect.Effect<View<EV>, EC, R>,
  handlers: Handlers,
): Effect.Effect<
  View<Types.ExcludeTag<EV, keyof Handlers & string>>,
  Types.ExcludeTag<EC, keyof Handlers & string>,
  R | Scope.Scope
>
export function Catch(
  child: Effect.Effect<View<any>, any, any>,
  handlerOrMap:
    | ((cause: Cause.Cause<unknown>, reset: () => void) => unknown)
    | Record<string, (error: any, reset: () => void) => unknown>,
): Effect.Effect<View<never>, unknown, unknown> {
  if (typeof handlerOrMap === "function") {
    return makeBoundary(child, () => true, handlerOrMap)
  }
  const handlers = handlerOrMap
  assertHandlerMap(handlers, "Catch")
  // Dispatch rules (own function-valued key, first-error routing) live in
  // `taggedMatch`, shared with Async's tag-map `failure` arm.
  return makeBoundary(
    child,
    (cause) => taggedMatch(handlers, cause) !== undefined,
    (cause, reset) => {
      const m = taggedMatch(handlers, cause)!
      return m.handler(m.error, reset)
    },
  )
}

/**
 * Fragment component — the compile target for JSX `<>...</>` syntax.
 *
 * `<>...</>` lowers to the direct call `Fragment({ children: [...] })`
 * (component tags don't route through `h` since #71). Children arrive RAW —
 * any child shape `h` accepts — and are coerced here exactly as `h` coerces
 * its variadic children.
 *
 * Fragment is also the canonical pattern for a component that accepts
 * arbitrary effectful children: generic over the children TUPLE, folding its
 * channels with `FoldE`/`FoldLiveE`/`FoldR`. Inference happens at the direct
 * call site, so the folds are precise. Do NOT type such a prop as the
 * non-generic `Child[]` — `Child` includes `Effect<View, any, any>`, and
 * folding `any` poisons the channel (an `any` E defeats the `mount` gate).
 */
export const Fragment = <Cs extends ReadonlyArray<unknown>>(
  props: { readonly children?: Cs },
): Effect.Effect<View<FoldLiveE<Cs>>, FoldE<Cs>, FoldR<Cs>> =>
  Effect.gen(function* () {
    const out: View<any>[] = []
    for (const c of props.children ?? []) out.push(yield* coerceAsync(c))
    return View.Fragment({ children: out })
  }) as Effect.Effect<View<FoldLiveE<Cs>>, FoldE<Cs>, FoldR<Cs>>

/**
 * The base Layer every verrex app needs. Provides the `AtomRegistry` so any
 * reactive children in the view tree have somewhere to live.
 *
 * Merge this with your app-specific Layers (Http, Db, Theme, etc.) before
 * passing to `Effect.provide`.
 */
export const VerrexLive: Layer.Layer<AtomRegistry.AtomRegistry> = AtomRegistry.layer
