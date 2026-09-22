// @vitest-environment happy-dom
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { h } from "@verrex/core"
import { render } from "./index.ts"

// Atom-valued props: `applyProp` reads + subscribes through the registry
// (mirroring the Reactive child case), so a derived Atom can drive a single
// attribute. Components resolve the registry via `yield* AtomRegistry` —
// `mount` owns and provides it.

describe("Atom-valued attrs", () => {
  it("applies the registry value initially and re-applies on registry.set", async () => {
    const size = Atom.make(1)
    const cls = Atom.map(size, (n) => `box size-${n}`)

    const Box = Effect.fn(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      return yield* h(
        "div",
        {},
        h(
          "button",
          { class: "grow", onclick: () => registry.set(size, 2) },
          "+",
        ),
        h("span", { class: cls, id: "target" }, "x"),
      )
    })

    const ui = await render(Box())
    expect(ui.get("#target").getAttribute("class")).toBe("box size-1")

    ui.click(".grow")
    await ui.waitFor(".size-2")
    expect(ui.get("#target").getAttribute("class")).toBe("box size-2")

    await ui.unmount()
  })

  it("ties the subscription to the element scope: a swapped-away node stops receiving", async () => {
    const n = Atom.make(0)
    const show = AtomRef.make(true)
    const Probe = Effect.fn(function* () {
      return yield* h(
        "div",
        {},
        show.map((s) =>
          s
            ? h("span", { "data-n": n, id: "probe" }, "x")
            : h("span", { class: "gone" }, "-"),
        ),
      )
    })

    // Writes go through `ui.registry` — the mount's own registry, the SAME
    // instance the attr subscribed on (a fresh registry would pass vacuously).
    const ui = await render(Probe())
    const probe = ui.get("#probe")
    expect(probe.getAttribute("data-n")).toBe("0")

    ui.registry.set(n, 1)
    await ui.waitFor('[data-n="1"]')

    // Swap the subtree away: the Reactive emit closes the old child scope,
    // which holds the attr subscription as a finalizer. The registry is still
    // alive — a further write must not reach the detached node.
    show.set(false)
    await ui.waitFor(".gone")
    ui.registry.set(n, 9)
    await ui.tick()
    expect(probe.getAttribute("data-n")).toBe("1")

    await ui.unmount()
  })
})
