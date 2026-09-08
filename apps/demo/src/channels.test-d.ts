/**
 * Compile-time proof that channels propagate through the tree.
 *
 * Each assertion either holds or produces a type error naming the
 * mismatched channel — this *is* the demonstration.
 */
import type { Chunk, Option, Result, Scope } from "effect"
import { Cause, Effect, Stream } from "effect"
import {
  AsyncResult,
  Atom,
  AtomRegistry,
  type AtomRef,
} from "effect/unstable/reactivity"
import {
  atom,
  Catch,
  type EventHandler,
  fn,
  type Fn,
  For,
  get,
  h,
  On,
  mount,
  type MountHandle,
  type View,
} from "@verrex/core"
import { AsyncEscalate } from "./AsyncEscalate.vx"
import { AsyncUserPage } from "./AsyncUserPage.vx"
import { Clock } from "./Clock.vx"
import { Counter } from "./Counter.vx"
import { LiveUser } from "./LiveUser.vx"
import { HttpError, Http, HttpLive, Theme, type User } from "./services.ts"
import { TypedHandlers } from "./TypedHandlers.vx"
import { UserPage } from "./UserPage.vx"

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
declare function assertEquals<
  A,
  B extends (Equals<A, B> extends true ? unknown : never),
>(): void

// ─── UserPage carries E = HttpError, R = Http | Theme ───────────────────
//     (in-component fetch: failure folds E to the root, blocking)

type UserPageType = ReturnType<typeof UserPage>
assertEquals<UserPageType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── AsyncUserPage: the same fetch as an `atom`. On handles the
//     failure locally (a `Failure` arm), so E is `never`; Http still folds
//     (the atom runs on the component's context), plus `AtomRegistry | Scope`
//     from `atom` (mounted on the component's Scope; mount discharges the
//     registry). Same data, opposite E — the leaf vs. fold-to-root contrast,
//     both compile-time enforced.

type AsyncUserPageType = ReturnType<typeof AsyncUserPage>
assertEquals<
  AsyncUserPageType,
  Effect.Effect<View, never, Http | AtomRegistry.AtomRegistry | Scope.Scope>
>()

// ─── AsyncEscalate: an `HttpError` arm on `On` handles it at the leaf; the
//     RateLimited residual (no arm) rides
//     View<RateLimited> to a page Catch tag arm. Fully discharged end-to-end
//     → View<never>/E never, Http folds.

type AsyncEscalateType = ReturnType<typeof AsyncEscalate>
assertEquals<
  AsyncEscalateType,
  Effect.Effect<View, never, Http | AtomRegistry.AtomRegistry | Scope.Scope>
>()

// ─── TypedHandlers: both channels enter through `onclick` alone. The
//     inner Loader stamps Effect<View<HttpError>, never, Http | AtomRegistry>
//     (the handler's `Atom.set` needs the registry); the tag-map Catch
//     discharges the live HttpError, the handler's Http rides R out.

type TypedHandlersType = ReturnType<typeof TypedHandlers>
assertEquals<
  TypedHandlersType,
  Effect.Effect<View, never, Http | AtomRegistry.AtomRegistry | Scope.Scope>
>()

// ─── Counter needs only the AtomRegistry (its handler's `Atom.update` is a
//     registry write) — no services, no E; mount discharges the registry ──

type CounterType = ReturnType<typeof Counter>
assertEquals<
  CounterType,
  Effect.Effect<View, never, AtomRegistry.AtomRegistry>
>()

// ─── LiveUser fetches async data via a dependent `atom`
//     (`atom((get) => http.getUser(get(userId)))`). Because the service is
//     extracted up front (`const http = yield* Http`) and the atom runs on the
//     component's context (not a baked Atom.runtime), `Http` stays in R — a
//     forgotten layer is a compile error. `E` is `never`: On renders
//     failure at the leaf rather than escalating it.

type LiveUserType = ReturnType<typeof LiveUser>
assertEquals<
  LiveUserType,
  Effect.Effect<View, never, Http | AtomRegistry.AtomRegistry | Scope.Scope>
>()

// ─── Clock drives an atom from a Stream via `atom(stream)`, whose mount
//     makes `AtomRegistry | Scope` the component's only requirements — the
//     tick stream needs no services and can't fail, so R and E contribute
//     nothing else ──────────────────────────────────────────────────────────

type ClockType = ReturnType<typeof Clock>
assertEquals<
  ClockType,
  Effect.Effect<View, never, AtomRegistry.AtomRegistry | Scope.Scope>
>()

// ─── Composition: a tree containing UserPage AND Counter unions channels ─

const Composed = h("div", {}, Counter(), UserPage({ userId: "42" }))

type ComposedType = typeof Composed
// E unions HttpError (only UserPage contributes E).
// R unions Http | Theme | AtomRegistry (Counter's write; discharged by mount).
assertEquals<
  ComposedType,
  Effect.Effect<View, HttpError, Http | Theme | AtomRegistry.AtomRegistry>
>()

// ─── Conditional render preserves channels ─────────────────────────────

declare const flag: boolean
const WithCond = h("div", {}, flag && UserPage({ userId: "42" }))
type WithCondType = typeof WithCond
assertEquals<WithCondType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── Array of effects preserves channels ───────────────────────────────

declare const ids: string[]
const WithList = h(
  "ul",
  {},
  ids.map((id) => UserPage({ userId: id })),
)
type WithListType = typeof WithList
assertEquals<WithListType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── <Component /> form: the compiler lowers component tags to DIRECT calls
//     — `<UserPage userId="42"/>` is `UserPage({ userId: "42" })` in the
//     emitted code, so the component's E/R is just the call's Effect type and
//     folds into a surrounding h() as an ordinary child. (These direct calls
//     ARE the compiled form of the JSX tags.)

const CounterAsTag = Counter() // <Counter />
assertEquals<
  typeof CounterAsTag,
  Effect.Effect<View, never, AtomRegistry.AtomRegistry>
>()

const UserPageAsTag = UserPage({ userId: "42" }) // <UserPage userId="42"/>
assertEquals<
  typeof UserPageAsTag,
  Effect.Effect<View, HttpError, Http | Theme>
>()

// Component children union with the surrounding element's other children.
const Mixed = h(
  "div",
  {},
  UserPage({ userId: "42" }), // contributes HttpError + Http | Theme
  Counter(), // contributes AtomRegistry
)
assertEquals<
  typeof Mixed,
  Effect.Effect<View, HttpError, Http | Theme | AtomRegistry.AtomRegistry>
>()

// ─── Generic components survive JSX tags ────────────────────────────────
//     Direct calls infer the type parameter natively.

declare const GenericRow: <T>(props: {
  item: T
  render: (item: T) => string
}) => Effect.Effect<View, never, never>
// <GenericRow item={42} render={n => n.toFixed(2)}/> — T pins to number;
// `n.toFixed` compiles only because T survived.
const RowCall = GenericRow({ item: 42, render: (n) => n.toFixed(2) })
assertEquals<typeof RowCall, Effect.Effect<View, never, never>>()

// ─── Event handlers on intrinsic elements get typed event arguments ─────

h("button", {
  onclick: (e) => {
    const _: number = e.button // MouseEvent has .button
    void _
  },
})

h("input", {
  oninput: (e) => {
    const _: EventTarget | null = e.target // Event
    void _
  },
})

h("input", {
  onkeydown: (e) => {
    const _: string = e.key // KeyboardEvent has .key
    void _
  },
})

h("form", {
  onsubmit: (e) => {
    const _: HTMLElement | null = e.submitter as HTMLElement | null
    void _
  },
})

// @ts-expect-error — wrong event type: KeyboardEvent ↛ MouseEvent
h("button", { onclick: (_e: KeyboardEvent) => {} })

// Handlers may take fewer args than the event signature (function variance)
h("button", { onclick: () => {} })

// Arbitrary attributes still pass through (intersection with index signature)
h("div", { "data-id": "x", "aria-hidden": "true", customX: 42 })

// ─── Typed event handlers: the live channel is born at the leaf ─────────
//     Handlers are where most live errors are born — the element is already
//     rendered when one runs, so its failure can only ride the LIVE channel.
//     An Effect-returning handler stamps its `E` on the element's `View<E>`
//     (dischargeable by `Catch`, gated by `mount`) and folds its `R` into
//     the element's requirements (a forgotten Layer is a compile error at
//     the root). The runtime always routed these (sink + captured context);
//     now the types track them.

declare const failingSave: Effect.Effect<void, HttpError, never>
declare const auditedLog: Effect.Effect<void, never, Http>

// The handler's E lands on the LIVE channel — construction stays `never`
// (the element builds fine; only a click can fail).
const SaveButton = h("button", { onclick: () => failingSave }, "save")
assertEquals<typeof SaveButton, Effect.Effect<View<HttpError>, never, never>>()

// @ts-expect-error — the unhandled failing onclick is undischarged: mount's
// View<never> gate rejects the app, naming HttpError. Forgot a boundary.
mount(SaveButton, root)

// A Catch discharges it — catch-all, or tag-selective with the unwrapped error.
mount(
  Catch({
    children: [SaveButton],
    Failure: (_cause) => h("p", {}, "save failed"),
  }),
  root,
)
mount(
  Catch({
    children: [SaveButton],
    HttpError: (e) => h("p", {}, `${e.status}`),
  }),
  root,
)

// The handler's R folds into the element's requirements, exactly like a
// construction R — the root must provide Http or the app doesn't compile.
const AuditButton = h("button", { onclick: () => auditedLog }, "audit")
assertEquals<typeof AuditButton, Effect.Effect<View, never, Http>>()

// Handler channels fold through composition like any other channel: the live
// E and the R both survive an enclosing element.
const Toolbar = h("div", {}, SaveButton, AuditButton, Counter())
assertEquals<
  typeof Toolbar,
  Effect.Effect<View<HttpError>, never, Http | AtomRegistry.AtomRegistry>
>()

// A void/imperative handler beside an Effect-returning one contributes nothing.
const MixedHandlers = h("button", {
  onclick: () => failingSave,
  onblur: () => {},
})
assertEquals<
  typeof MixedHandlers,
  Effect.Effect<View<HttpError>, never, never>
>()

// A non-`on*` function-valued attr is inert (the runtime stringifies it,
// never runs it) — it must not contribute channels the runtime can't fire.
const InertFn = h("div", { format: () => failingSave })
assertEquals<typeof InertFn, Effect.Effect<View, never, never>>()

// The bare key `on` is inert too — the runtime's handler branch requires
// key.length > 2, so folding it would force a Catch that can never fire.
const InertOn = h("div", { on: () => failingSave })
assertEquals<typeof InertOn, Effect.Effect<View, never, never>>()

// An `any`-returning handler (an untyped lib call) is inert — and must NOT
// swallow a sibling handler's channels (the unguarded fold inferred
// `unknown`, which coalesced the whole element's live E to never one level
// up and made R undischargeable).
declare const someAny: any
const AnyBeside = h("button", {
  onclick: () => someAny,
  onkeydown: () => failingSave,
})
assertEquals<typeof AnyBeside, Effect.Effect<View<HttpError>, never, never>>()
const Nested = h("div", {}, AnyBeside)
assertEquals<typeof Nested, Effect.Effect<View<HttpError>, never, never>>()

// Mid-tree Effect.provide discharges a handler's R — and the runtime agrees:
// handlers run on the context captured when h() built the element (pinned at
// runtime by testing/event-handlers.test.ts), so this is not a type-level lie.
const ProvidedButton = Effect.provide(AuditButton, HttpLive)
assertEquals<typeof ProvidedButton, Effect.Effect<View, never, never>>()

// An extracted handler annotated with the exported EventHandler keeps its
// channels — the annotation type carries E/R slots. (A WIDER hand annotation
// — `(): unknown =>` — erases them: inherent to reading the inferred props
// type; documented in types/Html.ts.)
declare const annotated: EventHandler<MouseEvent, HttpError, Http>
const AnnotatedBtn = h("button", { onclick: annotated })
assertEquals<typeof AnnotatedBtn, Effect.Effect<View<HttpError>, never, Http>>()

// For folds row channels: a row with a failing/service-using handler
// surfaces View<E> and R on the list itself (per-row Scope stays excluded).
// (`<For each={todos}>{(item) => …}</For>` compiles to this call.)
declare const todos: AtomRef.Collection<string>
const RowChannels = For({
  each: todos,
  children: [
    (item) => h("li", {}, h("button", { onclick: () => failingSave }, item)),
  ],
})
assertEquals<typeof RowChannels, Effect.Effect<View<HttpError>, never, never>>()
const RowR = For({
  each: todos,
  children: [
    (item) => h("li", {}, h("button", { onclick: () => auditedLog }, item)),
  ],
})
assertEquals<typeof RowR, Effect.Effect<View, never, Http>>()

// A `get(...)`-reading row over an Atom<Array> source: rows are Atom<T>s.
declare const users: Atom.Atom<ReadonlyArray<User>>
const KeyedRows = For({
  each: users,
  key: (u) => u.id,
  children: [
    (u) =>
      h(
        "li",
        {},
        h.reader(() => get(u).name),
      ),
  ],
})
assertEquals<typeof KeyedRows, Effect.Effect<View, never, never>>()

// An Atom child's emitted Effects FOLD `R` (the phase switch keeps E live,
// the rule for arms applies to whatever an atom emits): a handler
// inside a On arm needing a service the fetch does not folds onto the
// element's requirements — a missing Layer there is the same compile error
// as anywhere else, not a click-time Service-not-found defect. `Scope` is
// not folded from emitted Effects (they render under the node scope).
declare const userResult: Atom.Atom<AsyncResult.AsyncResult<User, HttpError>>
declare const themedLog: Effect.Effect<void, never, Theme>
const ArmFoldsR = h(
  "div",
  {},
  On({
    value: userResult,
    Success: (s) => h("button", { onclick: () => themedLog }, s.value.name),
  }),
)
assertEquals<typeof ArmFoldsR, Effect.Effect<View<HttpError>, never, Theme>>()
// Providing only Http leaves Theme on the requirements — a forgotten Layer
// for an arm's handler is a compile error.
declare const withHttp: Effect.Effect<View<HttpError>, never, Http | Theme>
const ArmProvidedHttp = Effect.provide(withHttp, HttpLive)
assertEquals<
  typeof ArmProvidedHttp,
  Effect.Effect<View<HttpError>, never, Theme>
>()

// Every arm folds: waiting, success, failure — whatever On emits.
declare const themedView: Effect.Effect<View, never, Theme>
const InitialFoldsR = h(
  "div",
  {},
  On({
    value: userResult,
    Waiting: () => themedView,
    Success: (s) => h("p", {}, s.value.name),
    Failure: () => h("p", {}, "err"),
  }),
)
assertEquals<typeof InitialFoldsR, Effect.Effect<View, never, Theme>>()
const FailureFoldsR = h(
  "div",
  {},
  On({
    value: userResult,
    Success: (s) => h("p", {}, s.value.name),
    Failure: () => themedView,
  }),
)
assertEquals<typeof FailureFoldsR, Effect.Effect<View, never, Theme>>()
const TagArmFoldsR = h(
  "div",
  {},
  On({
    value: userResult,
    Success: (s) => h("p", {}, s.value.name),
    HttpError: () => themedView,
  }),
)
assertEquals<typeof TagArmFoldsR, Effect.Effect<View, never, Theme>>()

// A conditional arm folds each branch's R; a component-call branch folds the
// component's channels (construction E of an emitted Effect is LIVE — it runs
// after mount).
const CondArm = h(
  "div",
  {},
  On({
    value: userResult,
    Success: (s) => (flag ? h("p", {}, s.value.name) : themedView),
  }),
)
assertEquals<typeof CondArm, Effect.Effect<View<HttpError>, never, Theme>>()
const CompCondArm = h(
  "div",
  {},
  On({
    value: userResult,
    Success: (s) =>
      flag ? UserPage({ userId: s.value.id }) : h("p", {}, s.value.name),
  }),
)
assertEquals<
  typeof CompCondArm,
  Effect.Effect<View<HttpError>, never, Http | Theme>
>()

// Catch fallbacks fold too — both forms — while an arm needing only what the
// runtime provides (Scope) or nothing adds nothing.
declare const failingView: Effect.Effect<View, HttpError, never>
const FallbackFoldsR = Catch({
  children: [failingView],
  Failure: () => themedView,
})
assertEquals<
  typeof FallbackFoldsR,
  Effect.Effect<View, never, Theme | Scope.Scope>
>()
// An inline handler that reads `cause` and `reset` still infers under the
// generic H, and folds what it uses.
const InlineFallback = Catch({
  children: [failingView],
  Failure: (cause, reset) =>
    Effect.gen(function* () {
      yield* themedLog
      return yield* h("button", { onclick: reset }, Cause.pretty(cause))
    }),
})
assertEquals<
  typeof InlineFallback,
  Effect.Effect<View, never, Theme | Scope.Scope>
>()
const TagFallbackFoldsR = Catch({
  children: [failingView],
  HttpError: () => themedView,
})
assertEquals<
  typeof TagFallbackFoldsR,
  Effect.Effect<View, never, Theme | Scope.Scope>
>()
declare const scopedView: Effect.Effect<View, never, Scope.Scope>
const ScopedArmAddsNothing = Catch({
  children: [failingView],
  Failure: () => scopedView,
})
assertEquals<
  typeof ScopedArmAddsNothing,
  Effect.Effect<View, never, Scope.Scope>
>()

// A typed FAILING handler inside a Catch fallback is rejected (the fallback
// must produce View<never>) — discharge it inside the fallback instead: a
// nested Catch compiles.
declare const failing: Effect.Effect<View, HttpError, never>
mount(
  Catch({
    children: [failing],
    Failure: (_cause, reset) =>
      Catch({
        children: [
          h("button", { onclick: () => failingSave, onblur: reset }, "retry"),
        ],

        HttpError: (e) => h("p", {}, `retry failed: ${e.status}`),
      }),
  }),
  root,
)

// ─── Props are type-checked against the component's declared shape ───────

// (the direct-call lowering means these errors point at UserPage's own
// signature, not at h's conditional types)

// @ts-expect-error — missing required prop `userId`
const Missing = UserPage({})
void Missing

// @ts-expect-error — typo: `userid` is not in `{ userId: string }`
const Typo = UserPage({ userid: "42" })
void Typo

// @ts-expect-error — wrong type: number not assignable to string
const WrongType = UserPage({ userId: 42 })
void WrongType

// @ts-expect-error — extra prop not declared on component
const Extra = UserPage({ userId: "42", nope: true })
void Extra

// ─── Container parity: ChildE/ChildR must peel exactly what coerceAsync
//     peels at runtime (Fold.ts ↔ coerce.ts). Effect's VALUE containers
//     (Option / Result / Chunk / AsyncResult / Stream) are peeled by neither —
//     they are values the author maps explicitly — so they contribute NO
//     channels here (an inner Effect's E/R must not leak through them, or the
//     type would promise a channel the runtime `String(v)`s away). Arrays are
//     structure and DO peel.

declare const optEff: Option.Option<Effect.Effect<View, HttpError, Http>>
const WithOption = h("div", {}, optEff)
assertEquals<typeof WithOption, Effect.Effect<View, never, never>>()

declare const resEff: Result.Result<
  Effect.Effect<View, HttpError, Http>,
  unknown
>

const WithResult = h("div", {}, resEff)
assertEquals<typeof WithResult, Effect.Effect<View, never, never>>()

declare const chunkEff: Chunk.Chunk<Effect.Effect<View, HttpError, Http>>
const WithChunk = h("div", {}, chunkEff)
assertEquals<typeof WithChunk, Effect.Effect<View, never, never>>()

declare const arrEff: ReadonlyArray<Effect.Effect<View, HttpError, Http>>
const WithArray = h("div", {}, arrEff)
assertEquals<typeof WithArray, Effect.Effect<View, HttpError, Http>>()

// ─── The error-boundary thesis: discharge-or-it-won't-compile ───────────
//     `Catch` discharges a subtree's errors; `mount` requires a fully
//     discharged app (`View<never>`, `never`). A forgotten boundary is a
//     compile error that NAMES the error — the runtime counterpart of a
//     forgotten Layer naming a service.

declare const root: HTMLElement

// Catch-all (function form) turns a failing subtree into a fully-discharged
// one. The handler's cause is precisely typed — `Cause<HttpError>`, not
// `Cause<unknown>`.
const Caught = Catch({
  children: [UserPage({ userId: "42" })],
  Failure: (cause, reset) => {
    const _typedCause: Cause.Cause<HttpError> = cause
    void _typedCause
    void reset
    return h("div", {}, "failed")
  },
})
// E discharged to `never`; UserPage's `Http | Theme` fold through, plus `Scope`
// from the boundary's fork.
assertEquals<
  typeof Caught,
  Effect.Effect<View, never, Http | Theme | Scope.Scope>
>()

// @ts-expect-error — UserPage's HttpError is undischarged: `mount` rejects it,
// and the error names `HttpError` (not assignable to `never`).
mount(UserPage({ userId: "42" }), root)

// With the boundary, the same app mounts.
mount(Caught, root)

// A pure component needs no boundary — it's already `View<never>`, `never`.
mount(Counter(), root)

// ─── mount owns the AtomRegistry ────────────────────────────────────────
//     A component that resolves `yield* AtomRegistry` carries it on R, and
//     mount DISCHARGES AtomRegistry from R — the result needs no registry
//     layer, so it cannot be provided with the wrong lifetime.

const RegistryUser = Effect.gen(function* () {
  const registry = yield* AtomRegistry.AtomRegistry
  return yield* h("p", {}, `${typeof registry}`)
})
assertEquals<
  typeof RegistryUser,
  Effect.Effect<View, never, AtomRegistry.AtomRegistry>
>()
assertEquals<
  ReturnType<typeof mount<AtomRegistry.AtomRegistry>>,
  Effect.Effect<MountHandle, never, Scope.Scope>
>()
//     …and the mount's own registry rides back out on the handle, so a caller
//     outside the tree (the testing harness) reaches it through mount's
//     interface rather than capturing the service out of the app effect.
assertEquals<MountHandle["registry"], AtomRegistry.AtomRegistry>()
mount(RegistryUser, root)

// ─── Atom carriers: the COMPONENT owns the requirements ──────────────────
//     The service instance is extracted in the component body (`yield* Http`
//     is what puts Http in R), and the Atom's stream source is built from
//     that instance — so the source itself is context-free, `Atom.runtime`
//     (which would bake the Layer and discharge R) never appears, and a
//     forgotten HttpLive is still a compile error at mount.

const AtomCarrier = Effect.gen(function* () {
  const http = yield* Http // Http rides the component's R
  const user = Atom.make(Stream.fromEffect(http.getUser("42")))
  return yield* h("p", { "data-user": user }, "·")
})
assertEquals<typeof AtomCarrier, Effect.Effect<View, never, Http>>()

// ─── Catch tag-map form narrows the error channel by tag ────────────────
//     Handle specific tags; the rest stay on the channel and must still be
//     discharged before `mount`. A typo'd tag key is a compile error.

class ParseError {
  readonly _tag = "ParseError" as const
  readonly message = ""
}
declare const TwoErrors: Effect.Effect<View, HttpError | ParseError, Http>

// Handle one tag → handler gets the unwrapped error; both channels narrow by
// `Exclude<E, { _tag }>`.
const CaughtHttp = Catch({
  children: [TwoErrors],

  HttpError: (e, reset) => {
    const _status: number = e.status
    void _status
    void reset
    return h("p", {}, "http error")
  },
})
assertEquals<
  typeof CaughtHttp,
  Effect.Effect<View, ParseError, Http | Scope.Scope>
>()

// @ts-expect-error — "Nope" is not one of the child's error tags
Catch({ children: [TwoErrors], Nope: () => h("p", {}, "x") })

// @ts-expect-error — ParseError is still undischarged; mount rejects it
mount(CaughtHttp, root)

// Handle the remaining tag → fully discharged, mountable.
const CaughtBoth = Catch({
  children: [CaughtHttp],

  ParseError: (e) => {
    const _msg: string = e.message
    void _msg
    return h("p", {}, "parse error")
  },
})
assertEquals<
  typeof CaughtBoth,
  Effect.Effect<View, never, Http | Scope.Scope>
>()
mount(CaughtBoth, root)

// Handle every tag at once → discharged, mountable.
const AllTags = Catch({
  children: [TwoErrors],

  HttpError: (e) => h("p", {}, `${e.status}`),
  ParseError: (e) => h("p", {}, e.message),
})
assertEquals<typeof AllTags, Effect.Effect<View, never, Http | Scope.Scope>>()
mount(AllTags, root)

// A tag arm beside `Failure` NARROWS what `Failure` sees — `catchTag` then
// `catchCause`: HttpError is taken by its arm, so the catch-all's Cause is
// `Cause<ParseError>` only. Discharged, mountable.
const TagThenAll = Catch({
  children: [TwoErrors],

  HttpError: (e) => h("p", {}, `${e.status}`),
  Failure: (cause) => {
    assertEquals<typeof cause, Cause.Cause<ParseError>>()
    return h("p", {}, "rest")
  },
})
assertEquals<
  typeof TagThenAll,
  Effect.Effect<View, never, Http | Scope.Scope>
>()
mount(TagThenAll, root)

// ─── The LIVE half of the mount gate ────────────────────────────────────
//     A View carrying a live error (`View<E≠never>`) is also rejected by
//     `mount`, and `Catch` discharges it — the symmetric counterpart of the
//     construction (Effect-E) gate above.

declare const liveOnly: Effect.Effect<View<HttpError>, never, never>

// @ts-expect-error — the View can fail live with HttpError; mount wants never
mount(liveOnly, root)

// catch-all discharges the live error → mountable.
mount(
  Catch({
    children: [liveOnly],
    Failure: (_cause) => h("p", {}, "live error"),
  }),
  root,
)

// tag-map discharges it too, narrowing to View<never>.
mount(
  Catch({
    children: [liveOnly],
    HttpError: (e) => h("p", {}, `${e.status}`),
  }),
  root,
)

// ─── atom: On picks the error's home ─────────────────────────────
//     `atom(effect)` exposes `Atom<AsyncResult<A, E>>`; per site `On` either
//     handles the failure at the leaf (a `Failure` arm → `View<never>`, nothing
//     for a boundary to see) or — with no `Failure` arm — lets it BUBBLE BY
//     DEFAULT: the unhandled failure is emitted as `Effect<never, E>`, the
//     fold's phase switch puts `E` on the LIVE channel (`View<E>`), and the
//     failure (initial fetch or refresh) routes to the nearest `Catch`. `atom`
//     itself contributes the caller's `R` (minus the atom's own services) plus
//     `AtomRegistry | Scope`; `mount` discharges the registry.

declare const getUser42: Effect.Effect<User, HttpError, Http>
const userAtom = atom(getUser42)
assertEquals<
  typeof userAtom,
  Effect.Effect<
    Atom.Atom<AsyncResult.AsyncResult<User, HttpError>>,
    never,
    Http | AtomRegistry.AtomRegistry | Scope.Scope
  >
>()
declare const user: Atom.Atom<AsyncResult.AsyncResult<User, HttpError>>

// Open form: HttpError rides the View channel.
const OpenAsync = h(
  "p",
  {},
  On({ value: user, Success: (s) => h("b", {}, s.value.name) }),
)
assertEquals<typeof OpenAsync, Effect.Effect<View<HttpError>, never, never>>()

// Handled form: discharged to View<never>; the cause is precisely typed.
const HandledAsync = h(
  "p",
  {},
  On({
    value: user,
    Success: (s) => h("b", {}, s.value.name),
    Failure: (f) => {
      const _typed: Cause.Cause<HttpError> = f.cause
      void _typed
      return h("b", {}, "failed")
    },
  }),
)
assertEquals<typeof HandledAsync, Effect.Effect<View, never, never>>()

// The live E folds through enclosing elements (FoldLiveE picks it off the
// child Effect's View<E> success).
const OpenInTree = h("main", {}, OpenAsync)
assertEquals<typeof OpenInTree, Effect.Effect<View<HttpError>, never, never>>()

// @ts-expect-error — the escalated HttpError is undischarged: mount rejects
// it, naming HttpError. Add a Catch boundary (or handle it at the leaf).
mount(OpenInTree, root)

// A page-level Catch discharges the live failure → mountable.
mount(
  Catch({ children: [OpenInTree], Failure: (_cause) => h("p", {}, "failed") }),
  root,
)

// Tag-map form discharges it too, narrowing to View<never>.
mount(
  Catch({
    children: [OpenInTree],
    HttpError: (e) => h("p", {}, `${e.status}`),
  }),
  root,
)

// ─── Partial leaf handling: a tag arm handles one tag, the residual rides ─
//     A tag-map `Failure` narrows `E` like `Effect.catchTag`; the residual
//     bubbles by default — `Exclude<E, { _tag }>` on the live channel, which
//     must still meet a `Catch` before `mount`. Unknown tags (and unknown
//     arm keys) are compile errors.

declare const userTwo: Atom.Atom<
  AsyncResult.AsyncResult<User, HttpError | ParseError>
>

// Handle one tag → its handler gets the unwrapped error; the residual stays
// on the live channel: View<ParseError>.
const TagMapAsync = h(
  "p",
  {},
  On({
    value: userTwo,
    Waiting: () => h("i", {}, "…"),
    Success: (s) => h("b", {}, s.value.name),

    HttpError: (e) => {
      const _status: number = e.status
      void _status
      return h("b", {}, "http error")
    },
  }),
)
assertEquals<
  typeof TagMapAsync,
  Effect.Effect<View<ParseError>, never, never>
>()

// "Nope" is not one of the atom's error tags
On({
  value: userTwo,
  // @ts-expect-error — not a tag of HttpError | ParseError
  Nope: () => h("p", {}, "x"),
})

// "Bogus" is not one of the AsyncResult's tags (unknown arm key)
On({
  value: userTwo,
  // @ts-expect-error — not a tag of AsyncResult
  Bogus: () => h("p", {}, "x"),
})

// @ts-expect-error — ParseError still rides the live channel; mount rejects it
mount(TagMapAsync, root)

// A boundary discharges the residual → mountable.
mount(
  Catch({
    children: [TagMapAsync],
    ParseError: (e) => h("p", {}, e.message),
  }),
  root,
)

// Handle every tag at the leaf → View<never>, mountable with no boundary.
const TagMapAll = h(
  "p",
  {},
  On({
    value: userTwo,
    Waiting: () => h("i", {}, "…"),
    Success: (s) => h("b", {}, s.value.name),

    HttpError: (e) => h("b", {}, `${e.status}`),
    ParseError: (e) => h("b", {}, e.message),
  }),
)
assertEquals<typeof TagMapAll, Effect.Effect<View, never, never>>()
mount(TagMapAll, root)

// Without a Failure arm nothing is discharged — the full E rides the live
// channel (tracked at the type level, so mount rejects it: a compile error,
// not a throw).
const NoFailureArm = h(
  "p",
  {},
  On({
    value: userTwo,
    Waiting: () => h("i", {}, "…"),
    Success: (s) => h("b", {}, s.value.name),
  }),
)
assertEquals<
  typeof NoFailureArm,
  Effect.Effect<View<HttpError | ParseError>, never, never>
>()
// @ts-expect-error — the failure cases are unhandled
mount(NoFailureArm, root)

// ─── fn: the state of a function call ─────────────────────────────────────
//     `fn(f)` hands back a callable `Atom.AtomResultFn`: `save(arg)` runs the
//     body (`Effect<void, never, AtomRegistry>`, returned from a handler);
//     `get(save)` is its `AsyncResult<A, E>`. The caller's `R` rides `fn`'s
//     result the same way as `atom`.

declare const saveUser: (u: User) => Effect.Effect<void, HttpError, Http>
const saveFn = fn(saveUser)
assertEquals<
  typeof saveFn,
  Effect.Effect<
    Fn<User, void, HttpError>,
    never,
    Http | AtomRegistry.AtomRegistry | Scope.Scope
  >
>()
declare const save: Fn<User, void, HttpError>
declare const someUser: User
// Calling it is a registry write; a handler returning it folds AtomRegistry.
const SaveCall = h("button", { onclick: () => save(someUser) }, "save")
assertEquals<
  typeof SaveCall,
  Effect.Effect<View, never, AtomRegistry.AtomRegistry>
>()
// Its failure bubbles like any atom's (no Failure arm). `on` is not an arm:
// although `Fn` is callable, its return does NOT fold onto R here.
const SaveState = h(
  "p",
  {},
  On({ value: save, Waiting: () => h("i", {}, "saving…") }),
)
assertEquals<typeof SaveState, Effect.Effect<View<HttpError>, never, never>>()

// Note: the type assertions above are the **load-bearing proof** of the POC.
// If they compile, channels are surviving the tree.
// The `@ts-expect-error` assertions above prove props are type-checked at
// JSX call sites, and that a forgotten error boundary fails to compile.

// ─── A reactive handler on an UNLISTED `on*` key keeps its channels ───────
//     A handler chosen reactively (`h.reader(() => get(flag) ? saveA :
//     saveB)`) is an `Atom<handler>`. The fold peels the Atom so the
//     handler's `E`/`R` ride; an `unknown` there would slip through the
//     `Record<string, unknown>` half of IntrinsicProps past mount's gate,
//     with no Catch and no Layer. (In `.vx`, `get` inside an `on*` attribute is
//     a compile error — a listener is not a reactive expression — so this
//     shape is only reachable through an explicit `h.reader`.)

declare const flagRef: AtomRef.AtomRef<boolean>
declare const saveA: (e: Event) => Effect.Effect<void, HttpError, Http>
declare const saveB: (e: Event) => Effect.Effect<void, HttpError, Http>

const TrackedUnlisted = h("video", {
  ontimeupdate: h.reader(() => (get(flagRef) ? saveA : saveB)),
})
assertEquals<
  typeof TrackedUnlisted,
  Effect.Effect<View<HttpError>, never, Http>
>()

// A reactive attr that is NOT a handler stays inert — no channels invented.
const TrackedAttr = h("div", {
  class: h.reader(() => (get(flagRef) ? "a" : "b")),
})
assertEquals<typeof TrackedAttr, Effect.Effect<View<never>, never, never>>()
