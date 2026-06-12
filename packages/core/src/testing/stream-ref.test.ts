// @vitest-environment happy-dom
import { describe, it, expect, expectTypeOf } from "vitest"
import { Context, Effect, Queue, Scope, Stream } from "effect"
import type { AtomRef } from "effect/unstable/reactivity"
import { h, streamRef } from "@verrex/core"
import { render } from "./index.ts"

// `streamRef(stream, initial)`: the stream runs on the mount fiber, pushes
// into a ReadonlyRef, and dies with the enclosing Scope. Driven here from a
// Queue so emissions are test-controlled.

describe("streamRef", () => {
  it("shows the initial value, then the latest emission (derived refs dedup)", async () => {
    const queue = Effect.runSync(Queue.unbounded<number>())

    const Probe = Effect.fn(function* () {
      const n = yield* streamRef(Stream.fromQueue(queue), 0)
      const parity = n.map((v) => (v % 2 === 0 ? "even" : "odd"))
      return yield* h(
        "div",
        {},
        h("span", { class: "n" }, n),
        h("span", { class: "parity", "data-parity": parity }, "·"),
      )
    })

    const ui = await render(Probe())
    expect(ui.text(".n")).toBe("0")
    expect(ui.get(".parity").getAttribute("data-parity")).toBe("even")

    await Effect.runPromise(Queue.offer(queue, 3))
    await ui.waitFor('[data-parity="odd"]')
    expect(ui.text(".n")).toBe("3")

    // 3 → 5: parity unchanged — the derived ref dedups, only `.n` re-renders
    const parityEl = ui.get(".parity")
    await Effect.runPromise(Queue.offer(queue, 5))
    while (ui.text(".n") !== "5") await ui.tick()
    expect(parityEl.getAttribute("data-parity")).toBe("odd")

    await ui.unmount()
  })

  it("interrupts the stream when the scope closes", async () => {
    const queue = Effect.runSync(Queue.unbounded<number>())
    const log: string[] = []

    const Probe = Effect.fn(function* () {
      const n = yield* streamRef(
        Stream.fromQueue(queue).pipe(
          Stream.ensuring(Effect.sync(() => log.push("stream done"))),
        ),
        0,
      )
      return yield* h("span", { class: "n" }, n)
    })

    const ui = await render(Probe())
    await Effect.runPromise(Queue.offer(queue, 1))
    // wait for the emission to LAND in the DOM — only then is the stream
    // provably started (unmounting earlier interrupts the fiber before
    // `ensuring` is registered, vacuously passing an empty-log assertion)
    while (ui.text(".n") !== "1") await ui.tick()
    expect(log).toEqual([])

    await ui.unmount()
    expect(log).toEqual(["stream done"])
  })

  it("without initial: construction waits for the first element", async () => {
    const queue = Effect.runSync(Queue.unbounded<number>())

    const Probe = Effect.fn(function* () {
      const n = yield* streamRef(Stream.fromQueue(queue))
      return yield* h("span", { class: "n" }, n)
    })

    let resolved = false
    const pending = render(Probe()).then((ui) => {
      resolved = true
      return ui
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(resolved).toBe(false) // still waiting on the first element

    await Effect.runPromise(Queue.offer(queue, 7))
    const ui = await pending
    expect(ui.text(".n")).toBe("7")

    // later emissions keep flowing into the same ref
    await Effect.runPromise(Queue.offer(queue, 8))
    while (ui.text(".n") !== "8") await ui.tick()

    await ui.unmount()
  })

  it("without initial: a stream that ends before emitting dies loud, not hangs", async () => {
    const Probe = Effect.fn(function* () {
      const n = yield* streamRef(Stream.empty as Stream.Stream<number>)
      return yield* h("span", { class: "n" }, n)
    })
    await expect(render(Probe())).rejects.toThrow(/ended before its first element/)
  })

  it("folds the stream's R into the component (types)", () => {
    class Feed extends Context.Service<Feed, {
      readonly ticks: Stream.Stream<number>
    }>()("test/Feed") {}

    const withService = Effect.gen(function* () {
      const feed = yield* Feed
      const n = yield* streamRef(feed.ticks, 0)
      return n
    })
    expectTypeOf(withService).toEqualTypeOf<
      Effect.Effect<AtomRef.ReadonlyRef<number>, never, Feed | Scope.Scope>
    >()

    // the no-initial overload folds identically
    const waiting = Effect.gen(function* () {
      const feed = yield* Feed
      return yield* streamRef(feed.ticks)
    })
    expectTypeOf(waiting).toEqualTypeOf<
      Effect.Effect<AtomRef.ReadonlyRef<number>, never, Feed | Scope.Scope>
    >()

    // the error channel must be discharged at the stream level
    const failing = null as unknown as Stream.Stream<number, Error>
    // @ts-expect-error — Stream<A, Error> is not assignable to Stream<A, never>
    void streamRef(failing, 0)
  })
})
