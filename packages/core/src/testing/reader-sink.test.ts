// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Cause, Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { Catch, get, h } from "@verrex/core"
import { render } from "./index.ts"

// A reader whose RE-render throws keeps the last value, stays subscribed and
// recovers (node-local — the invariant in runtime/AGENTS.md). The report of
// that throw routes to the mount's root sink (a non-fatal defect), so a test
// can assert it via `sinkCauses` instead of spying on `console.error`.
describe("reader re-render throw → root sink", () => {
  it("shows up in sinkCauses while the DOM keeps the last value, then recovers", async () => {
    const user = AtomRef.make<{ name: string } | null>({ name: "ada" })
    const App = Effect.fn(function* () {
      return yield* h(
        "span",
        { class: "name" },
        h.reader(() => get(user)!.name),
      )
    })
    const ui = await render(App())
    expect(ui.text(".name")).toBe("ada")
    user.set(null) // throws on re-render → last value held, defect reported
    expect(ui.text(".name")).toBe("ada")
    expect(ui.sinkCauses.length).toBe(1)
    // A non-fatal DEFECT, not a failure — it must never route to a Catch.
    expect(ui.sinkCauses[0]!.reasons.filter(Cause.isDieReason).length).toBe(1)
    expect(Cause.squash(ui.sinkCauses[0]!)).toBeInstanceOf(TypeError)
    user.set({ name: "bob" }) // recovers on the next dep change
    expect(ui.text(".name")).toBe("bob")
    expect(ui.sinkCauses.length).toBe(1)
    await ui.unmount()
  })

  // The hazard #198 names: if the throw reached the boundary's `report`
  // sink, the boundary would FLIP — recovery would change. The root-sink
  // binding must bypass every subtree sink swap.
  it("a throwing reader inside a Catch boundary does not flip the boundary", async () => {
    const user = AtomRef.make<{ name: string } | null>({ name: "ada" })
    let fallbacks = 0
    const App = Effect.fn(function* () {
      return yield* Catch({
        children: [
          h(
            "span",
            { class: "name" },
            h.reader(() => get(user)!.name),
          ),
        ],
        Failure: () => {
          fallbacks++
          return h("p", { class: "fallback" }, "flipped")
        },
      })
    })
    const ui = await render(App())
    expect(ui.text(".name")).toBe("ada")
    user.set(null)
    expect(ui.text(".name")).toBe("ada") // last value held
    expect(ui.query(".fallback")).toBeNull() // boundary did NOT flip
    expect(fallbacks).toBe(0)
    expect(ui.sinkCauses.length).toBe(1) // root sink still got the report
    user.set({ name: "bob" })
    expect(ui.text(".name")).toBe("bob") // recovered, still no flip
    expect(fallbacks).toBe(0)
    await ui.unmount()
  })
})
