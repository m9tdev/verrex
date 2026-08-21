// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Cause, Effect } from "effect"
import { AtomRef } from "effect/unstable/reactivity"
import { get, h } from "@verrex/core"
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
    expect(Cause.squash(ui.sinkCauses[0]!)).toBeInstanceOf(TypeError)
    user.set({ name: "bob" }) // recovers on the next dep change
    expect(ui.text(".name")).toBe("bob")
    expect(ui.sinkCauses.length).toBe(1)
    await ui.unmount()
  })
})
