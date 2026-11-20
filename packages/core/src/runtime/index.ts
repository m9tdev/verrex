import { Cause, Effect, Exit, Queue, Scope, type Types } from "effect"
import { Atom, AtomRef } from "effect/unstable/reactivity"
import { coerceAsync, type ErrorSink } from "./coerce.ts"
import { assertHandlerMap, matchTagArm } from "./tag-dispatch.ts"
import type {
  ChildE,
  ChildLiveE,
  ChildR,
  FoldArmsR,
  FoldE,
  FoldLiveE,
  FoldR,
} from "./types/Fold.ts"
import { type BoundaryState, View } from "./View.ts"

export * as Component from "./Component.ts"
export { get, type Get, h } from "./h.ts"
export {
  On,
  type Residual as OnResidual,
  type TagHandlers as OnArms,
} from "./on.ts"
export { atom, fn, type Fn, type AtomOptions, type FnOptions } from "./atom.ts"
export { mount, type MountHandle, RootSink } from "./mount.ts"
export { type Props, View } from "./View.ts"
// `For`, `Catch`, `Fragment` are declared + exported below.
export type {
  Child,
  ChildE,
  ChildLiveE,
  ChildR,
  FoldE,
  FoldLiveE,
  FoldPropsLiveE,
  FoldPropsR,
  ArmR,
  FoldArmsR,
  FoldR,
} from "./types/Fold.ts"
export type {
  EventHandler,
  HtmlEventHandlers,
  IntrinsicProps,
} from "./types/Html.ts"

// ─── For ──────────────────────────────────────────────────────────────────

/** A row renderer's return: a View or a (sync) Effect of one. */
type RowRet = unknown
/**
 * A row builds AFTER construction (on insert), so everything it can fail
 * with is LIVE — its Effect's own `E` and any `View<E>` it returns both land
 * on the list's `View<E>` (same phase switch as an Atom child, Fold.ts).
 */
type RowLiveE<F> = F extends (...args: any) => infer Ret
  ? ChildE<Ret> | ChildLiveE<Ret>
  : never
type RowR<F> = F extends (...args: any) => infer Ret
  ? Exclude<ChildR<Ret>, Scope.Scope>
  : never

/**
 * Keyed reactive list — the `<For>` component
 * . Two sources, one renderer shape:
 *
 * ```tsx
 * // AtomRef.Collection — rows are AtomRef<T>
 * <For each={todos}>{(todo) => <li>{todo.prop("title")}</li>}</For>
 * // Atom<ReadonlyArray<T>> + key — rows are Atom<T>
 * <For each={users} key={(u) => u.id}>
 *   {(u) => <li>{Atom.map(u, (x) => x.name)}</li>}
 * </For>
 * ```
 *
 * - `each: AtomRef.Collection<T>` — rows are the collection's `AtomRef<T>`s,
 *   keyed by identity (no `key`); per-cell reactivity via `row.prop`/`row.map`.
 * - `each: Atom<ReadonlyArray<T>>` + `key` — any array atom (a cell,
 *   `atom(...)`, `Atom.pull`, a derived); rows are `Atom<T>`s derived per key
 *   (`Atom.family` + `withEquality`: an unchanged item = no DOM write).
 * - `index` is a live `ReadonlyRef<number>` mount updates on reorder/shift.
 *
 * `children` is a 1-tuple because the compiler always emits
 * `children: [ … ]`. Structure diff is `reconcile.plan` + a per-row `Scope`
 * (unchanged). Row channels fold: a row's `E` (Effect or `View<E>`) is LIVE on
 * the result (rows build on insert, after construction); its `R` minus the
 * runtime-supplied `Scope` surfaces on the result and is captured at
 * construction (`ViewList.context`), so rows genuinely build on the Layer
 * demanded here.
 */
export function For<
  T,
  F extends (
    row: AtomRef.AtomRef<T>,
    index: AtomRef.ReadonlyRef<number>,
  ) => RowRet,
>(props: {
  readonly each: AtomRef.Collection<T>
  readonly children: readonly [F]
}): Effect.Effect<View<RowLiveE<F>>, never, RowR<F>>
export function For<
  T,
  K,
  F extends (row: Atom.Atom<T>, index: AtomRef.ReadonlyRef<number>) => RowRet,
>(props: {
  readonly each: Atom.Atom<ReadonlyArray<T>>
  readonly key: (item: T) => K
  readonly children: readonly [F]
}): Effect.Effect<View<RowLiveE<F>>, never, RowR<F>>
export function For(props: {
  readonly each: AtomRef.Collection<unknown> | Atom.Atom<ReadonlyArray<unknown>>
  readonly key?: (item: unknown) => unknown
  readonly children: readonly [
    (row: any, index: AtomRef.ReadonlyRef<number>) => unknown,
  ]
}): Effect.Effect<View<any>, never, any> {
  const render = props.children[0]
  return Effect.map(Effect.context<never>(), (context) =>
    View.List({
      context,
      source: Atom.isAtom(props.each)
        ? { _tag: "Keyed", each: props.each, key: props.key! }
        : { _tag: "Collection", collection: props.each },
      render,
    }),
  )
}

// ─── Error boundary (Catch) ────────────────

/**
 * Shared boundary machinery for `Catch`. `accepts` decides which causes THIS
 * boundary handles; a non-accepted cause re-raises at construction (its
 * residual rides the Effect channel → a parent boundary / fails mount) and
 * escalates to the ambient sink when live. The typed public wrappers below cast
 * the residual to its precise shape.
 */
// The outcome of one child build: shown content (ok / accepted error) + the
// scope its construction-time effects live in, or a cause this boundary doesn't
// accept.
type BuildOutcome =
  | { readonly content: BoundaryState; readonly scope: Scope.Closeable }
  | {
      readonly rejected: Cause.Cause<unknown>
      readonly scope: Scope.Closeable
    }

const makeBoundary = <R>(
  child: Effect.Effect<View<any>, any, R>,
  accepts: (cause: Cause.Cause<unknown>) => boolean,
  handler: (cause: Cause.Cause<unknown>, reset: () => void) => unknown,
): Effect.Effect<View<never>, unknown, R | Scope.Scope> =>
  Effect.gen(function* () {
    const mountScope = yield* Effect.scope
    // Ambient (parent) sink — set by mount via the node's `setAmbient`. A cause
    // this boundary doesn't `accept` escalates here. A catch-all never
    // escalates.
    let ambient: ErrorSink = () => {}
    const setAmbient = (sink: ErrorSink): void => {
      ambient = sink
    }

    // Monotonic generation: `AtomRef.set` dedups via `Equal.equals`, so a build
    // that fails with a structurally-identical `Cause` would be `Equal`-equal
    // to the current state and silently not notify (a dead retry). `gen` makes
    // every emission distinct.
    let gen = 0
    // Construction scope of the CURRENT content: a child's construction-time
    // effects (an `atom` body's fibers + finalizers, `acquireRelease`, …) bind
    // to a fresh scope forked from the mount scope, so they're released when we
    // swap away or reset rather than leaking onto the mount scope. The fork
    // cascade closes the live one on teardown; `adopt` closes the prior one
    // mid-life. Error content holds no scope: a failed build renders nothing,
    // so its scope closes the moment the failure is accepted — partial
    // resources never idle behind the fallback.
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

    // Build `child` in a fresh scope. Returns content + that scope, or
    // `{ rejected }` for a cause this boundary doesn't accept. Never fails. An
    // interrupt-only cause (teardown) is treated as not-accepted, so a
    // catch-all doesn't render a fallback for a build interrupted mid-flight.
    const build = (): Effect.Effect<BuildOutcome, never, R> =>
      Effect.suspend(() => {
        const scope = Scope.forkUnsafe(mountScope, "sequential")
        return Effect.matchCause(
          Effect.provideService(child, Scope.Scope, scope),
          {
            onSuccess: (view): BuildOutcome => ({
              content: { _tag: "ok", view, gen: gen++ },
              scope,
            }),
            onFailure: (cause): BuildOutcome =>
              accepts(cause) && !Cause.hasInterruptsOnly(cause)
                ? { content: { _tag: "error", cause, gen: gen++ }, scope }
                : { rejected: cause, scope },
          },
        )
      })

    // Initial build inline (folds R; no first-paint flash). A rejected cause
    // here re-raises on the Effect channel — the residual rides `EC` to a
    // parent boundary / fails `mount`.
    const first = yield* build()
    if ("rejected" in first) {
      close(first.scope)
      return yield* Effect.failCause(first.rejected)
    }
    if (first.content._tag === "error") close(first.scope)
    else activeBuild = first.scope
    const state = AtomRef.make<BoundaryState>(first.content)
    const runs = yield* Queue.unbounded<
      | { readonly _tag: "reset" }
      | {
          readonly _tag: "error"
          readonly cause: Cause.Cause<unknown>
        }
    >()

    // Live failures: accepted → error state (via the queue, off the render
    // stack — a synchronous mutation would close the child scope mid-render);
    // non-accepted → escalate to the ambient sink. An interrupt-only cause (a
    // handler torn down mid-flight) is not an error, so it never flips the
    // boundary; it escalates unchanged so the root sink can still observe it.
    const report = (cause: Cause.Cause<unknown>): void => {
      if (Cause.hasInterruptsOnly(cause)) return ambient(cause)
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
            // live error: tear down the current content's construction effects,
            // swap.
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

    // Capture the construction context for the FALLBACK arm: the ok content
    // is (re)built by the drain fiber above, which inherits this context, but
    // the fallback renders through mount's coerceSync and would otherwise run
    // on the ambient (root) context — the one dynamic-render path the
    // per-node capture sweep would miss (see ViewBoundary.context).
    const context = yield* Effect.context<never>()
    return View.Boundary({ state, handler, reset, report, setAmbient, context })
  })

/**
 * View-level error boundary — `Catch`. Mirrors Effect's `catch*`: recover the
 * FAILURE side of a view subtree, let success pass through (the children
 * render themselves). A JSX tag, like `On`: the subtree is the children, the
 * handling is in the props — the same arm KEYS as `On`'s failure arms, but a
 * different handler signature (`Catch`: `(error, reset)` / `(cause, reset)`;
 * `On`: `(error, variant)` / `(variant)`):
 *
 *  - **tag-selective** — one prop per error `_tag`, for any subset of the
 *    children's error tags (each handler gets the unwrapped tagged error). The
 *    result **narrows** both channels by `Exclude<E, { _tag }>`, so a leftover
 *    tag must still be discharged before `mount`. A non-matching error
 *    escalates to the next boundary out.
 *    ```tsx
 *    <Catch
 *      HttpError={(e, reset) => <Banner status={e.status} onRetry={reset} />}
 *      ParseError={(e) => <p>bad data: {e.message}</p>}
 *    >
 *      <UserCard id={id} />
 *    </Catch>
 *    ```
 *  - **catch-all** — `Failure` gets the precise `Cause<EC | EV>` of whatever
 *    no tag arm took, and discharges *every* error to `never` (mountable):
 *    ```tsx
 *    <Catch Failure={(cause, reset) => (
 *      <div class="err">
 *        {Cause.pretty(cause)}<button onclick={reset}>retry</button>
 *      </div>
 *    )}>
 *      <UserCard id={id} />
 *    </Catch>
 *    ```
 *
 * Catches both phases — **construction** (a child's build Effect fails) and
 * **live** (a post-mount reactive re-render or event-handler Effect). `reset()`
 * re-runs construction. The children's `R` folds (construction + every reset
 * run on the mount fiber); the arms' `R` folds too (they render on
 * the captured context, so their services must be provided at `mount`), while
 * their own `E` is not: an arm must produce `View<never>` — like `On`'s
 * arms. Tag arms only catch errors in the *type*; an untyped
 * event-handler or reactive error needs `Failure`.
 *
 * Multiple children are wrapped in a `Fragment`; from plain TS call it as
 * `Catch({ children: [child], HttpError: … })`.
 */
/**
 * `Catch`'s arms: one optional handler per error `_tag` (plus `Failure`, the
 * catch-all). Keys are constrained to the children's tags (`K extends
 * Tags<E> | "Failure"`), so an unknown key is a compile error — alone or
 * beside valid keys — and each handler's `error` infers from its key.
 * Prototype-keyed objects and explicit-`undefined` slots are
 * rejected at construction by `assertHandlerMap`; pre-built maps whose TYPE
 * declares keys the value doesn't carry can still over-discharge — invisible
 * at runtime (erasure), documented limitation.
 */
// One mapped type keyed by the arms ACTUALLY PRESENT (`K`, inferred from
// the props' keys), not by every tag of `E`: that is what lets `Failure` see
// only what no tag arm took — `Cause<Exclude<E, { _tag: K }>>`, like
// `catchTag` then `catchCause`. `NoInfer` keeps `Failure`'s parameter from
// feeding `K`; "children" is in `K`'s key space only so the props' own key
// doesn't push inference to the fallback constraint (`Cs` still infers from
// the plain `children` member); a single map (not `tags & { Failure }`) keeps
// a GENERIC `E` resolvable (TS can't rule "Failure" out of `Tags<E>` there).
export type CatchArms<E, K extends string = Types.Tags<E> | "Failure"> = {
  readonly [P in K]: P extends "children"
    ? unknown
    : P extends "Failure"
      ? (
          cause: Cause.Cause<
            Exclude<E, { readonly _tag: Exclude<NoInfer<K>, "Failure"> }>
          >,
          reset: () => void,
        ) => View | Effect.Effect<View, any, any>
      : (
          error: Extract<E, { readonly _tag: P }>,
          reset: () => void,
        ) => View | Effect.Effect<View, any, any>
}
export type CatchResidual<E, K extends string> = "Failure" extends K
  ? never
  : Types.ExcludeTag<E, K>

export function Catch<
  const Cs extends ReadonlyArray<unknown>,
  K extends Types.Tags<FoldE<Cs> | FoldLiveE<Cs>> | "Failure" | "children" =
    never,
  const H extends CatchArms<FoldE<Cs> | FoldLiveE<Cs>, K> = CatchArms<
    FoldE<Cs> | FoldLiveE<Cs>,
    K
  >,
>(
  props: { readonly children: Cs } & CatchArms<FoldE<Cs> | FoldLiveE<Cs>, K> &
    H,
): Effect.Effect<
  View<CatchResidual<FoldLiveE<Cs>, K>>,
  CatchResidual<FoldE<Cs>, K>,
  FoldR<Cs> | Scope.Scope | FoldArmsR<Omit<H, "children">>
>
export function Catch(
  props: { readonly children: ReadonlyArray<unknown> } & Record<
    string,
    unknown
  >,
): Effect.Effect<View<never>, unknown, unknown> {
  // Validate the PROPS object (a rest-spread would hide its prototype).
  assertHandlerMap(props, "Catch", ["children"])
  const { children, Failure: failure, ...tags } = props
  const child: Effect.Effect<View<any>, any, any> = children.length === 1 &&
  Effect.isEffect(children[0])
    ? (children[0] as Effect.Effect<View<any>, any, any>)
    : Fragment({ children })
  const catchAll = failure as
    | ((cause: Cause.Cause<unknown>, reset: () => void) => unknown)
    | undefined
  // Dispatch: tag arm first (own function-valued key, first-error routing —
  // `matchTagArm`, shared with On), then the catch-all, else escalate.
  return makeBoundary(
    child,
    (cause) => catchAll !== undefined || matchTagArm(tags, cause) !== undefined,
    (cause, reset) => {
      const m = matchTagArm(tags, cause)
      return m ? m.handler(m.error, reset) : catchAll!(cause, reset)
    },
  )
}

/**
 * Fragment component — the compile target for JSX `<>...</>` syntax.
 *
 * `<>...</>` lowers to the direct call `Fragment({ children: [...] })`
 * (component tags don't route through `h`). Children arrive RAW —
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
export const Fragment = <Cs extends ReadonlyArray<unknown>>(props: {
  readonly children?: Cs
}): Effect.Effect<View<FoldLiveE<Cs>>, FoldE<Cs>, FoldR<Cs>> =>
  Effect.gen(function* () {
    const out: View<any>[] = []
    for (const c of props.children ?? []) out.push(yield* coerceAsync(c))
    return View.Fragment({ children: out })
  }) as Effect.Effect<View<FoldLiveE<Cs>>, FoldE<Cs>, FoldR<Cs>>
