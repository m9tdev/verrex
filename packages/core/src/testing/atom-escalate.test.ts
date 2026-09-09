// @vitest-environment happy-dom
import { describe, expect, expectTypeOf, it } from "vitest"
import { Cause, Data, Deferred, Effect } from "effect"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { atom, Catch, h, mount, type View } from "@verrex/core"
import { render } from "./index.ts"

// Escalation with no extra boundary primitive: an atom that EMITS an
// `Effect<View, E>` at render time puts `E` on the LIVE channel (`View<E>`,
// Fold.ts phase switch), so an unhandled `On` failure — or, the escape hatch
// pinned here, `.onFailure(Effect.failCause)` inside `Atom.map(result, …)` —
// routes a typed failure to the nearest `Catch` — and `mount` refuses the tree
// without one. Handling at the leaf (`.onFailure(() => <p/>)`) yields
// `View<never>`.

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}

describe("atom → typed live escalation", () => {
  it("a failing atom escalates through Atom.map(...onFailure(Effect.failCause)) to Catch", async () => {
    const gate = Deferred.makeUnsafe<void>()
    let calls = 0
    const App = Effect.fn(function* () {
      const fetch: Effect.Effect<string, NotFound> = Effect.gen(function* () {
        calls++
        yield* Deferred.await(gate)
        return yield* Effect.fail(new NotFound({ id: "7" }))
      })
      const user = yield* atom(fetch)
      const body = h(
        "div",
        { class: "body" },
        Atom.map(user, (r) =>
          AsyncResult.builder(r)
            .onInitialOrWaiting(() => h("p", { class: "loading" }, "loading"))
            .onSuccess((name) => h("b", {}, name))
            .onFailure(Effect.failCause)
            .exhaustive(),
        ),
      )
      // Type pins: live E is NotFound, construction E is never.
      expectTypeOf(body).toMatchTypeOf<
        Effect.Effect<View<NotFound>, never, any>
      >()
      return yield* Catch({
        children: [body],

        NotFound: (e, _reset) =>
          h("p", { class: "fallback" }, `no user ${e.id}`),
      })
    })
    const ui = await render(App())
    expect(ui.query(".loading")).not.toBeNull()
    Effect.runSync(Deferred.succeed(gate, void 0))
    await ui.waitFor(".fallback")
    expect(ui.text(".fallback")).toBe("no user 7")
    expect(calls).toBe(1)
    await ui.unmount()
  })

  it("handled at the leaf → View<never>; mount refuses an unhandled live E", () => {
    const leaf = Effect.gen(function* () {
      const fetch: Effect.Effect<string, NotFound> = Effect.fail(
        new NotFound({ id: "1" }),
      )
      const user = yield* atom(fetch)
      return yield* h(
        "div",
        {},
        Atom.map(user, (r) =>
          AsyncResult.builder(r)
            .onInitialOrWaiting(() => null)
            .onSuccess((n) => h("b", {}, n))
            .onFailure((c) => h("p", {}, Cause.pretty(c)))
            .exhaustive(),
        ),
      )
    })
    expectTypeOf(leaf).toMatchTypeOf<Effect.Effect<View<never>, never, any>>()

    const unhandled = Effect.gen(function* () {
      const fetch: Effect.Effect<string, NotFound> = Effect.fail(
        new NotFound({ id: "1" }),
      )
      const user = yield* atom(fetch)
      return yield* h(
        "div",
        {},
        Atom.map(user, (r) =>
          AsyncResult.builder(r).onFailure(Effect.failCause).orNull(),
        ),
      )
    })
    const el = null as unknown as HTMLElement
    // @ts-expect-error live NotFound is not discharged
    mount(unhandled, el)
    // No registry provide: `mount` discharges `AtomRegistry` from `R` itself.
    // Providing one here would typecheck too, but it is the anti-pattern —
    // an app-level registry splits the brain (runtime AGENTS.md, "mount owns
    // its AtomRegistry").
    mount(leaf, el)
  })
})
