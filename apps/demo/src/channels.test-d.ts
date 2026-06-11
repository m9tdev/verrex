/**
 * Compile-time proof that channels propagate through the tree.
 *
 * Each assertion either holds or produces a type error naming the
 * mismatched channel — this *is* the demonstration.
 */
import type { Cause, Chunk, Effect, Option, Result, Scope } from "effect"
import type { AtomRegistry } from "effect/unstable/reactivity"
import { Async, type AsyncHandle, Catch, h, mount, type View } from "@verrex/core"
import { AsyncEscalate } from "./AsyncEscalate.vx"
import { AsyncUserPage } from "./AsyncUserPage.vx"
import { Clock } from "./Clock.vx"
import { Counter } from "./Counter.vx"
import { LiveUser } from "./LiveUser.vx"
import { HttpError, Http, Theme, type User } from "./services.ts"
import { UserPage } from "./UserPage.vx"

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
declare function assertEquals<A, B extends Equals<A, B> extends true ? unknown : never>(): void

// ─── UserPage carries E = HttpError, R = Http | Theme ───────────────────
//     (in-component fetch: failure folds E to the root, blocking)

type UserPageType = ReturnType<typeof UserPage>
assertEquals<UserPageType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── AsyncUserPage: the same fetch behind an `Async` boundary. The boundary
//     handles failure locally (the failure arm), so E is `never`; Http still folds
//     (fetch on the mount fiber), plus Scope from the fork (`forkScoped`).
//     Same data, opposite E — the boundary vs. fold-to-root contrast, both
//     compile-time enforced.

type AsyncUserPageType = ReturnType<typeof AsyncUserPage>
assertEquals<AsyncUserPageType, Effect.Effect<View, never, Http | Scope.Scope>>()

// ─── AsyncEscalate: tag-map failure arm handles HttpError at the leaf; the
//     RateLimited residual rides View<RateLimited> to a page Catch tag map.
//     Fully discharged end-to-end → View<never>/E never, Http folds.

type AsyncEscalateType = ReturnType<typeof AsyncEscalate>
assertEquals<AsyncEscalateType, Effect.Effect<View, never, Http | Scope.Scope>>()

// ─── Counter is pure (no E or R from the component itself; AtomRegistry
//     is added at mount) ──────────────────────────────────────────────────

type CounterType = ReturnType<typeof Counter>
assertEquals<CounterType, Effect.Effect<View, never, never>>()

// ─── LiveUser fetches async data via the auto-tracking `Async` boundary
//     (`Async(() => http.getUser(userId.value), …)`). Because the service is
//     extracted up front (`const http = yield* Http`) and the fetch runs on the
//     mount fiber (not a baked Atom.runtime), `Http` stays in R — a forgotten
//     layer is a compile error. `E` is `never`: the boundary renders failure via the
//     failure arm rather than propagating it. (This is the thesis the boundary
//     protects.)

type LiveUserType = ReturnType<typeof LiveUser>
assertEquals<LiveUserType, Effect.Effect<View, never, Http | Scope.Scope>>()

// ─── Clock bridges a Stream to a ref via `streamRef`, whose fork makes
//     `Scope` the component's only requirement — the tick stream needs no
//     services and can't fail, so R and E contribute nothing else ─────────

type ClockType = ReturnType<typeof Clock>
assertEquals<ClockType, Effect.Effect<View, never, Scope.Scope>>()

// ─── Composition: a tree containing UserPage AND Counter unions channels ─

const Composed = h("div", {},
  Counter(),
  UserPage({ userId: "42" }),
)

type ComposedType = typeof Composed
// E unions HttpError (only UserPage contributes E).
// R unions Http | Theme. (Counter contributes nothing; AtomRegistry is mount's concern.)
assertEquals<ComposedType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── Conditional render preserves channels ─────────────────────────────

declare const flag: boolean
const WithCond = h("div", {}, flag && UserPage({ userId: "42" }))
type WithCondType = typeof WithCond
assertEquals<WithCondType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── Array of effects preserves channels ───────────────────────────────

declare const ids: string[]
const WithList = h("ul", {}, ids.map((id) => UserPage({ userId: id })))
type WithListType = typeof WithList
assertEquals<WithListType, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── <Component /> form: the compiler lowers component tags to DIRECT calls
//     (#71) — `<UserPage userId="42"/>` is `UserPage({ userId: "42" })` in the
//     emitted code, so the component's E/R is just the call's Effect type and
//     folds into a surrounding h() as an ordinary child. (These direct calls
//     ARE the compiled form of the JSX tags.)

const CounterAsTag = Counter()                      // <Counter />
assertEquals<typeof CounterAsTag, Effect.Effect<View, never, never>>()

const UserPageAsTag = UserPage({ userId: "42" })    // <UserPage userId="42"/>
assertEquals<typeof UserPageAsTag, Effect.Effect<View, HttpError, Http | Theme>>()

// Component children union with the surrounding element's other children.
const Mixed = h("div", {},
  UserPage({ userId: "42" }),          // contributes HttpError + Http | Theme
  Counter(),                            // contributes nothing
)
assertEquals<typeof Mixed, Effect.Effect<View, HttpError, Http | Theme>>()

// ─── Generic components survive JSX tags (#71's acceptance) ─────────────
//     Direct calls infer the type parameter natively — the old h()-mediated
//     higher-rank erasure is gone.

declare const GenericRow: <T>(props: { item: T; render: (item: T) => string }) =>
  Effect.Effect<View, never, never>
// <GenericRow item={42} render={n => n.toFixed(2)}/> — T pins to number;
// `n.toFixed` compiles only because T survived.
const RowCall = GenericRow({ item: 42, render: (n) => n.toFixed(2) })
assertEquals<typeof RowCall, Effect.Effect<View, never, never>>()

// ─── Event handlers on intrinsic elements get typed event arguments ─────

h("button", {
  onclick: (e) => {
    const _: number = e.button          // MouseEvent has .button
    void _
  },
})

h("input", {
  oninput: (e) => {
    const _: EventTarget | null = e.target  // Event
    void _
  },
})

h("input", {
  onkeydown: (e) => {
    const _: string = e.key             // KeyboardEvent has .key
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
//     peels at runtime (Fold.ts ↔ coerce.ts). A shape folded here but not
//     peeled there makes the channel claim a *lie* (the type promises an E/R
//     the runtime would `String(v)` away). These pin the inner Effect's E/R
//     folding through each peelable container. `Stream` is in NEITHER — it is
//     deliberately not peeled, so it contributes no channels.

declare const optEff: Option.Option<Effect.Effect<View, HttpError, Http>>
const WithOption = h("div", {}, optEff)
assertEquals<typeof WithOption, Effect.Effect<View, HttpError, Http>>()

declare const resEff: Result.Result<Effect.Effect<View, HttpError, Http>, unknown>
const WithResult = h("div", {}, resEff)
assertEquals<typeof WithResult, Effect.Effect<View, HttpError, Http>>()

declare const chunkEff: Chunk.Chunk<Effect.Effect<View, HttpError, Http>>
const WithChunk = h("div", {}, chunkEff)
assertEquals<typeof WithChunk, Effect.Effect<View, HttpError, Http>>()

// ─── The error-boundary thesis: discharge-or-it-won't-compile ───────────
//     `Catch` discharges a subtree's errors; `mount` requires a fully
//     discharged app (`View<never>`, `never`). A forgotten boundary is a
//     compile error that NAMES the error — the runtime counterpart of a
//     forgotten Layer naming a service.

declare const root: HTMLElement

// Catch-all (function form) turns a failing subtree into a fully-discharged one.
// The handler's cause is precisely typed — `Cause<HttpError>`, not `Cause<unknown>`.
const Caught = Catch(UserPage({ userId: "42" }), (cause, reset) => {
  const _typedCause: Cause.Cause<HttpError> = cause
  void _typedCause
  void reset
  return h("div", {}, "failed")
})
// E discharged to `never`; UserPage's `Http | Theme` fold through, plus `Scope`
// from the boundary's fork.
assertEquals<typeof Caught, Effect.Effect<View, never, Http | Theme | Scope.Scope>>()

// @ts-expect-error — UserPage's HttpError is undischarged: `mount` rejects it,
// and the error names `HttpError` (not assignable to `never`). Forgot a boundary.
mount(UserPage({ userId: "42" }), root)

// With the boundary, the same app mounts.
mount(Caught, root)

// A pure component needs no boundary — it's already `View<never>`, `never`.
mount(Counter(), root)

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
const CaughtHttp = Catch(TwoErrors, {
  HttpError: (e, reset) => {
    const _status: number = e.status
    void _status
    void reset
    return h("p", {}, "http error")
  },
})
assertEquals<typeof CaughtHttp, Effect.Effect<View, ParseError, Http | Scope.Scope>>()

// @ts-expect-error — "Nope" is not one of the child's error tags
Catch(TwoErrors, { Nope: () => h("p", {}, "x") })

// @ts-expect-error — ParseError is still undischarged; mount rejects it, naming it
mount(CaughtHttp, root)

// Handle the remaining tag → fully discharged, mountable.
const CaughtBoth = Catch(CaughtHttp, {
  ParseError: (e) => {
    const _msg: string = e.message
    void _msg
    return h("p", {}, "parse error")
  },
})
assertEquals<typeof CaughtBoth, Effect.Effect<View, never, Http | Scope.Scope>>()
mount(CaughtBoth, root)

// Handle every tag at once → discharged, mountable.
const AllTags = Catch(TwoErrors, {
  HttpError: (e) => h("p", {}, `${e.status}`),
  ParseError: (e) => h("p", {}, e.message),
})
assertEquals<typeof AllTags, Effect.Effect<View, never, Http | Scope.Scope>>()
mount(AllTags, root)

// ─── The LIVE half of the mount gate ────────────────────────────────────
//     A View carrying a live error (`View<E≠never>`) is also rejected by `mount`,
//     and `Catch` discharges it — the symmetric counterpart of the construction
//     (Effect-E) gate above.

declare const liveOnly: Effect.Effect<View<HttpError>, never, never>

// @ts-expect-error — the View can fail live with HttpError; mount requires View<never>.
mount(liveOnly, root)

// catch-all discharges the live error → mountable.
mount(Catch(liveOnly, (_cause) => h("p", {}, "live error")), root)

// tag-map discharges it too, narrowing to View<never>.
mount(Catch(liveOnly, { HttpError: (e) => h("p", {}, `${e.status}`) }), root)

// ─── Async: the failure arm picks the error's home ──────────────────────
//     Providing `failure` handles the failure at the leaf — `View<never>`,
//     nothing for a boundary to see. Omitting it puts `E` on the LIVE channel
//     (`View<E>`) — the leaf primitive that stamps `View<E≠never>` — and the
//     failure (initial fetch or refetch) routes to the nearest `Catch`.

declare const getUser42: () => Effect.Effect<User, HttpError, Http>

// Open form: HttpError rides the View channel; Http still folds into R.
const OpenAsync = Async(getUser42, { success: (u) => h("p", {}, u.name) })
assertEquals<typeof OpenAsync, Effect.Effect<View<HttpError>, never, Http | Scope.Scope>>()

// Handled form: discharged to View<never>; the cause is precisely typed.
const HandledAsync = Async(getUser42, {
  success: (u) => h("p", {}, u.name),
  failure: (cause) => {
    const _typed: Cause.Cause<HttpError> = cause
    void _typed
    return h("p", {}, "failed")
  },
})
assertEquals<typeof HandledAsync, Effect.Effect<View, never, Http | Scope.Scope>>()

// The live E folds through enclosing elements (FoldLiveE picks it off the
// child Effect's View<E> success).
const OpenInTree = h("main", {}, OpenAsync)
assertEquals<typeof OpenInTree, Effect.Effect<View<HttpError>, never, Http | Scope.Scope>>()

// @ts-expect-error — the open Async's HttpError is undischarged: mount rejects
// it, naming HttpError. Add a Catch boundary (or a failure arm at the leaf).
mount(OpenInTree, root)

// A page-level Catch discharges the live failure → mountable.
mount(Catch(OpenInTree, (_cause) => h("p", {}, "failed")), root)

// Tag-map form discharges it too, narrowing to View<never>.
mount(Catch(OpenInTree, { HttpError: (e) => h("p", {}, `${e.status}`) }), root)

// ─── Async tag-map failure arm: per-tag leaf handling, residual rides ───
//     `failure` as a `_tag → handler` map mirrors Catch's tag-selective form:
//     matched tags are handled at the leaf (the fetch loop stays live), the
//     residual rides the live channel by `Exclude<E, { _tag }>` and must still
//     meet a `Catch` before `mount`.

declare const getUserTwo: () => Effect.Effect<User, HttpError | ParseError, Http>

// Handle one tag → its handler gets the unwrapped error; the residual stays
// on the live channel: View<ParseError>.
const TagMapAsync = Async(getUserTwo, {
  success: (u) => h("p", {}, u.name),
  failure: {
    HttpError: (e) => {
      const _status: number = e.status
      void _status
      return h("p", {}, "http error")
    },
  },
})
assertEquals<typeof TagMapAsync, Effect.Effect<View<ParseError>, never, Http | Scope.Scope>>()

// @ts-expect-error — "Nope" is not one of the thunk's error tags
Async(getUserTwo, { success: (u) => h("p", {}, u.name), failure: { Nope: () => h("p", {}, "x") } })

// @ts-expect-error — ParseError still rides the live channel; mount rejects it, naming it
mount(TagMapAsync, root)

// A boundary discharges the residual → mountable.
mount(Catch(TagMapAsync, { ParseError: (e) => h("p", {}, e.message) }), root)

// A tag map needs an E with at least one tagged member: with TagsOf<E> = never
// the Handlers constraint collapses to `never` (not the empty mapped type, which
// would accept ANY map as a silently-dead handler set).
declare const getUntagged: () => Effect.Effect<string, string, never>
// @ts-expect-error — E = string has no tags; the tag-map overload is rejected
Async(getUntagged, { success: (s) => h("p", {}, s), failure: { Oops: () => h("p", {}, "x") } })

// Handle every tag at the leaf → View<never>, mountable with no boundary.
const TagMapAll = Async(getUserTwo, {
  success: (u) => h("p", {}, u.name),
  failure: {
    HttpError: (e) => h("p", {}, `${e.status}`),
    ParseError: (e) => h("p", {}, e.message),
  },
})
assertEquals<typeof TagMapAll, Effect.Effect<View, never, Http | Scope.Scope>>()
mount(TagMapAll, root)

// Every failure handler (catch-all and tag-map) receives `retry` last —
// typed () => void, the leaf analog of Catch's reset.
const HandledRetry = Async(getUser42, {
  success: (u) => h("p", {}, u.name),
  failure: (cause, retry) => {
    const _c: Cause.Cause<HttpError> = cause
    const _r: () => void = retry
    void _c
    void _r
    return h("p", {}, "failed")
  },
})
assertEquals<typeof HandledRetry, Effect.Effect<View, never, Http | Scope.Scope>>()

const TagMapRetry = Async(getUserTwo, {
  success: (u) => h("p", {}, u.name),
  failure: {
    HttpError: (e, retry) => {
      const _r: () => void = retry
      void _r
      return h("p", {}, `${e.status}`)
    },
  },
})
assertEquals<typeof TagMapRetry, Effect.Effect<View<ParseError>, never, Http | Scope.Scope>>()

// ─── AsyncHandle: asyncRef returns { state, refetch }; Async accepts the
//     handle directly — same E homes as the thunk form, but the data outlives
//     the subtree and only Scope is contributed to R (the thunk's R already
//     folded where asyncRef ran).

declare const userHandle: AsyncHandle<User, HttpError | ParseError>

const HandleOpen = Async(userHandle, { success: (u) => h("p", {}, u.name) })
assertEquals<typeof HandleOpen, Effect.Effect<View<HttpError | ParseError>, never, Scope.Scope>>()

const HandleTagMap = Async(userHandle, {
  success: (u) => h("p", {}, u.name),
  failure: {
    HttpError: (e, retry) => {
      const _r: () => void = retry
      void _r
      return h("p", {}, `${e.status}`)
    },
  },
})
assertEquals<typeof HandleTagMap, Effect.Effect<View<ParseError>, never, Scope.Scope>>()

// A handle-based open Async still needs a boundary before mount.
// @ts-expect-error — HttpError | ParseError ride the live channel
mount(HandleOpen, root)
mount(Catch(HandleOpen, (_cause) => h("p", {}, "failed")), root)

// Note: the type assertions above are the **load-bearing proof** of the POC.
// If they compile, channels are surviving the tree.
// The `@ts-expect-error` assertions above prove props are type-checked at
// JSX call sites, and that a forgotten error boundary fails to compile.
