import { Effect } from "effect"
import type { View } from "./View.ts"

// Channel extraction from the union of effects a generator body yields —
// the same encoding `Effect.fn` uses ([Eff] tuple wrap defeats distribution).
type GenE<Eff> = [Eff] extends [never] ? never
  : [Eff] extends [Effect.Effect<infer _A, infer E, infer _R>] ? E
  : never
type GenR<Eff> = [Eff] extends [never] ? never
  : [Eff] extends [Effect.Effect<infer _A, infer _E, infer R>] ? R
  : never

/**
 * The canonical component constructor — a thin seam over `Effect.fn`, not an
 * abstraction. Exactly three jobs:
 *
 *  1. **Traced by default.** Component bodies run once at construction
 *     (fine-grained model), so the span costs per-mount, not per-update — and
 *     buys component stack traces in a failure `Cause`
 *     (`App > ProfilePage > UserCard`) plus OTel spans that join UI to backend
 *     (the `asyncRef` supervisor forked during construction inherits the span
 *     context, so refetches nest under the component). Opt out by writing a
 *     plain `Effect.fnUntraced` function — components are just functions;
 *     `make` is a seam, not a gate.
 *  2. **Signature-preserving type.** An Effect-returning component goes
 *     through the identity-typed overload (`(f: F) => F`), so a *generic*
 *     component survives with its type parameter intact — which
 *     `Effect.fn`'s overloads don't guarantee. Generator bodies (the common
 *     case) take the second overload, which mirrors `Effect.fn`'s channel
 *     inference; TypeScript cannot carry a generator's own type parameter
 *     through that one, so write a generic component in the Effect-returning
 *     form: `Component.make(<T,>(props: { item: T }) => Effect.gen(…))`.
 *  3. **A name slot the compiler fills.** In `.vx` source, write
 *     `Component.make(fn)` — the compiler rewrites it to
 *     `Component.make(fn, "Counter")` from the declared name (fails soft: no
 *     name → no span — anonymous `Effect.fn` never calls `useSpan` — but
 *     failures still carry definition + call-site stack frames). In plain
 *     `.ts` (tests, harnesses) pass the name yourself. The parameter is
 *     `_name` — underscore-prefixed like `h`'s `_tag`/`_props`/`_children`
 *     because it's a compiler-filled slot, coupled by name to the
 *     ts-plugin's inlay-hint filter so the injected argument never shows
 *     a `_name:` label in the editor.
 *
 * If it ever grows beyond these three jobs, it's grown too much. (A runtime
 * brand was considered for #71's direct-call tag lowering and deliberately
 * left out until that issue proves the need.)
 *
 * The body takes at most one props object. A propless component takes no
 * parameter at all (`function* ()`): the compiler emits the zero-arg call
 * `Counter()` for an attr-less, child-less tag — no `_props: {} = {}`
 * boilerplate.
 *
 * ```tsx
 * export const Counter = Component.make(function* () {
 *   const count = AtomRef.make(0)
 *   return yield* <button onclick={() => count.update((n) => n + 1)}>{count}</button>
 * })
 * ```
 */
export function make<F extends (props: any) => Effect.Effect<View<any>, any, any>>(
  f: F,
  _name?: string,
): F
export function make<
  Args extends [props?: any],
  Eff extends Effect.Effect<any, any, any>,
  AView extends View<any>,
>(
  body: (...args: Args) => Generator<Eff, AView, never>,
  _name?: string,
): (...args: Args) => Effect.Effect<AView, GenE<Eff>, GenR<Eff>>
export function make(f: (props?: any) => any, _name?: string): unknown {
  // `Effect.fn`'s runtime accepts both body shapes — a generator (iterated)
  // and a plain Effect-returning function (`isEffect(iter) ? iter : …`) — so
  // one wrapper serves both overloads.
  return _name === undefined ? Effect.fn(f as never) : Effect.fn(_name)(f as never)
}

