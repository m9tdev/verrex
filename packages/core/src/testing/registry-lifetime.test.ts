// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { Effect, Exit, Scope } from "effect"
import { Atom, AtomRef, AtomRegistry } from "effect/unstable/reactivity"
import { get, h, mount } from "@verrex/core"

// `mount` owns its AtomRegistry: it creates, provides, and disposes the
// registry itself, so NO registry provision is needed at all.

const trackedSpan = (dep: AtomRef.AtomRef<string>) =>
  Effect.gen(function* () {
    return yield* h(
      "span",
      {},
      h.reader(() => get(dep)),
    )
  })

// Mount under a held-open scope (as a real app's long-lived scope would),
// returning mount's handle plus a close function for teardown.
const mountHeld = async <A, R>(
  app: Effect.Effect<A, never, R>,
): Promise<{ handle: A; close: () => Promise<void> }> => {
  const scope = Scope.makeUnsafe()
  const handle = await Effect.runPromise(
    Scope.provide(app as Effect.Effect<A, never, never>, scope),
  )
  return {
    handle,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

describe("mount owns the AtomRegistry", () => {
  it("mounts and stays reactive with no registry provided", async () => {
    const dep = AtomRef.make("a")
    const el = document.createElement("div")
    const { close } = await mountHeld(mount(trackedSpan(dep), el))
    expect(el.querySelector("span")!.textContent).toBe("a")
    dep.set("b")
    expect(el.querySelector("span")!.textContent).toBe("b")
    await close()
  })

  it("a component's `yield* AtomRegistry` resolves to the mount's own live registry", async () => {
    const el = document.createElement("div")
    let seen: AtomRegistry.AtomRegistry | undefined
    const { close } = await mountHeld(
      mount(
        Effect.gen(function* () {
          seen = yield* AtomRegistry.AtomRegistry
          return yield* h("span", {}, "x")
        }),
        el,
      ),
    )
    expect(seen).toBeDefined()
    // It is live — usable for reads — not a disposed layer instance.
    const atom = Atom.make(1)
    expect(() => seen!.get(atom)).not.toThrow()
    expect(seen!.get(atom)).toBe(1)
    await close()
  })

  it("closing the mount scope detaches the DOM and disposes the registry together", async () => {
    const dep = AtomRef.make("a")
    const el = document.createElement("div")
    document.body.appendChild(el)
    let registry: AtomRegistry.AtomRegistry | undefined
    const { close } = await mountHeld(
      mount(
        Effect.gen(function* () {
          registry = yield* AtomRegistry.AtomRegistry
          return yield* h(
            "span",
            {},
            h.reader(() => get(dep)),
          )
        }),
        el,
      ),
    )
    expect(el.querySelector("span")!.textContent).toBe("a")
    await close()
    expect(el.querySelector("span")).toBeNull()
    // The registry is disposed: touching it now is a loud error, not a
    // silent freeze of a still-visible UI (the UI is gone).
    expect(() => registry!.get(Atom.make(1))).toThrow(/disposed/i)
    el.remove()
  })

  it("hands back the registry the TREE subscribed on — writes through it drive the DOM", async () => {
    const n = Atom.make(0)
    const el = document.createElement("div")
    let seen: AtomRegistry.AtomRegistry | undefined
    // The handle is mount's OWN interface: no service-capture trick, no
    // non-null assertion. If mount ever moves where it provides the registry,
    // this breaks as a type error, not an undefined at use (#199).
    const { handle, close } = await mountHeld(
      mount(
        Effect.gen(function* () {
          seen = yield* AtomRegistry.AtomRegistry
          return yield* h("span", {}, n)
        }),
        el,
      ),
    )
    expect(handle.registry).toBe(seen)
    // The contract that matters is not "a registry comes back" but "THE
    // registry the rendered tree subscribed on comes back" — so assert
    // through the DOM, not a `get`/`set` round-trip (which would only pin
    // effect's own registry behaviour).
    expect(el.querySelector("span")!.textContent).toBe("0")
    handle.registry.set(n, 7)
    expect(el.querySelector("span")!.textContent).toBe("7")
    await close()
    // The handle's registry dies with the mount scope — no way to keep a
    // disposed registry alive by holding the handle.
    expect(() => handle.registry.get(Atom.make(1))).toThrow(/disposed/i)
  })
})
