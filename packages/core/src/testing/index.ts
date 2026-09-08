import { Cause, Effect, Exit, Layer, Scope } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { mount, RootSink, type View } from "@verrex/core"

/**
 * Services a component may require without a `layer`: the ambient `Scope`
 * (held open across interaction, closed on `unmount`) and the `AtomRegistry`
 * (owned by `mount` itself — created per mount, disposed with the mount's
 * scope, provided to the app effect). Everything else a component requires
 * is `R` you must satisfy with `layer` — if you forget one, `render` fails
 * to type-check. That's deliberate: the harness must NOT swallow the `E`/`R`
 * channels, or it would defeat the whole point of verrex at the test site.
 */
type Injected = AtomRegistry.AtomRegistry | Scope.Scope

/**
 * The component requirements you must provide — everything except what the
 * harness injects.
 */
type Required<R> = Exclude<R, Injected>

/**
 * Handle to a mounted component: query the DOM, fire events, settle async, tear
 * down.
 */
export interface RenderResult {
  /**
   * The container the component was mounted into (attached to `document.body`).
   */
  readonly container: HTMLElement
  /**
   * First match for `selector`, or throw if none (use when you expect it to
   * exist).
   */
  get(selector: string): HTMLElement
  /** First match for `selector`, or `null`. */
  query(selector: string): HTMLElement | null
  /** All matches for `selector`. */
  all(selector: string): HTMLElement[]
  /**
   * Trimmed `textContent` of the first match (or the container when `selector`
   * is omitted).
   */
  text(selector?: string): string
  /**
   * Dispatch a bubbling `click` at the first match — fires the component's
   * `onclick`.
   */
  click(selector: string): void
  /**
   * Dispatch a bubbling event of `type` at the first match (e.g. `"input"`,
   * `"submit"`).
   */
  fire(selector: string, type: string): void
  /** Flush microtasks + one macrotask so async/atom-driven updates settle. */
  tick(): Promise<void>
  /**
   * Poll until `selector` matches (or `timeoutMs` elapses, then throw). Use for
   * async-driven updates whose exact settle-tick count is nondeterministic
   * (e.g. an `Atom`/`AsyncResult` flushing through the registry's async
   * scheduler), instead of guessing a fixed number of `tick()`s.
   */
  waitFor(selector: string, timeoutMs?: number): Promise<HTMLElement>
  /** Close the scope (firing every finalizer) and detach the container. */
  unmount(): Promise<void>
  /**
   * Every `Cause` that reached the root error sink (`RootSink`), in order: a
   * live failure no `Catch` caught, and any handler that exited with an
   * interrupt-only cause (torn down mid-flight, or `Effect.interrupt`).
   * Assert `toEqual([])` to prove a handler ran to completion — a stub's side
   * effect only proves it *started*. `unmount()` itself interrupts in-flight
   * handlers, so read this before it. The harness always installs its own
   * `RootSink`; a `RootSink` in the `layer` argument is not used.
   */
  readonly sinkCauses: ReadonlyArray<Cause.Cause<unknown>>
  /**
   * The mount's own `AtomRegistry` — write atoms from the test
   * (`registry.set(a, v)`).
   */
  readonly registry: AtomRegistry.AtomRegistry
}

const el = (container: HTMLElement, selector: string): HTMLElement => {
  const found = container.querySelector(selector)
  if (!found)
    throw new Error(`render(): no element matches ${JSON.stringify(selector)}`)
  return found as HTMLElement
}

/**
 * Mount a component into an in-process DOM and return a handle to drive it.
 *
 * `app` is a component result — `Component(props)`, what a component tag
 * compiles to — i.e. an `Effect<View, E, R>`. Provide a `layer` covering every
 * service the component needs (the harness adds the ambient `Scope`); omit it
 * only when the component requires nothing else. A missing service is a compile
 * error, exactly as it would be at a real `mount`.
 *
 * ```ts
 * const ui = await render(
 *   UserPage({ userId: "42" }),
 *   Layer.mergeAll(HttpTest, ThemeTest),
 * )
 * expect(ui.text(".user-card strong")).toBe("Ada Lovelace")
 * await ui.unmount()
 * ```
 */
export const render = <E, R>(
  app: Effect.Effect<View, E, R>,
  ...rest: [Required<R>] extends [never]
    ? [layer?: Layer.Layer<never>]
    : [layer: Layer.Layer<Required<R>>]
): Promise<RenderResult> => {
  const layer = (rest[0] ?? Layer.empty) as Layer.Layer<never>
  return renderImpl(app as Effect.Effect<View, unknown, never>, layer)
}

/**
 * Type-erase an app's LIVE error channel so a sink-containment test can mount
 * it. This is the one sanctioned lie in the harness: `mount`'s `View<never>`
 * gate makes an undischarged live error a compile error (the thesis), but
 * tests of the runtime sink — "a failing handler is contained, the app keeps
 * working" — need exactly such an app. Route every such test through this
 * named, greppable hatch instead of ad-hoc `as unknown as` casts on handler
 * effects; anything else using it is a smell.
 */
export const untracked = <V extends View<any>, E, R>(
  app: Effect.Effect<V, E, R>,
): Effect.Effect<View, E, R> => app as unknown as Effect.Effect<View, E, R>

const renderImpl = async (
  app: Effect.Effect<View, unknown, never>,
  layer: Layer.Layer<never>,
): Promise<RenderResult> => {
  const container = document.createElement("div")
  document.body.appendChild(container)

  // A Closeable scope we own: mount registers every subscription/listener/
  // release finalizer on it, and we keep it open until unmount().
  const scope = Scope.makeUnsafe()
  // `mount` requires a discharged app (`Effect<View<never>, never, R>`). The
  // harness discharges an undischarged construction error by turning it into a
  // defect, so a component that fails to build (with no boundary) rejects the
  // `render(...)` promise loudly — exactly the failure a test wants to see.
  const discharged = Effect.catchCause(app, (cause) =>
    Effect.die(Cause.squash(cause)),
  )
  // Build the caller's layer INTO the harness scope (not `Effect.provide`,
  // which would scope it to the mount effect — an effect that completes as
  // soon as the DOM attaches), so service finalizers fire on `unmount()`.
  // The AtomRegistry needs no layer at all: `mount` owns one per mount and
  // disposes it with the same scope.
  const sinkCauses: Array<Cause.Cause<unknown>> = []
  // The mount's own AtomRegistry comes back ON the handle — mount's interface,
  // not a service captured out of the app effect. Reaching around the seam
  // would break silently (undefined at use) if mount moved its provision.
  const handle = await Effect.runPromise(
    Scope.provide(
      Effect.flatMap(Layer.build(layer), (ctx) =>
        Effect.provideContext(
          Effect.provideService(
            mount(discharged, container),
            RootSink,
            (cause) =>
              Effect.sync(() => {
                sinkCauses.push(cause)
              }),
          ),
          ctx,
        ),
      ),
      scope,
    ),
  )

  return {
    container,
    sinkCauses,
    registry: handle.registry,
    get: (s) => el(container, s),
    query: (s) => container.querySelector(s) as HTMLElement | null,
    all: (s) => Array.from(container.querySelectorAll(s)) as HTMLElement[],
    text: (s) => (s ? el(container, s) : container).textContent?.trim() ?? "",
    click: (s) => {
      el(container, s).dispatchEvent(new MouseEvent("click", { bubbles: true }))
    },
    fire: (s, type) => {
      el(container, s).dispatchEvent(new Event(type, { bubbles: true }))
    },
    tick: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    waitFor: async (selector, timeoutMs = 1000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = container.querySelector(selector) as HTMLElement | null
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(
            `waitFor(): ${JSON.stringify(selector)} did not appear within ${timeoutMs}ms. ` +
              `Container: ${container.innerHTML}`,
          )
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
    },
    unmount: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      container.remove()
    },
  }
}
