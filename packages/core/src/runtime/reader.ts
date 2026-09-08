import { Cause, Effect, Option } from "effect"
import { Atom, AtomRegistry, type AtomRef } from "effect/unstable/reactivity"
import { bridgeAtom, isAtomRef, type ErrorSink } from "./coerce.ts"

// ─── the ambient reader: h.reader + get ──────────────────────────────────
//
// The compiler lowers a JSX expression containing a call to verrex's `get`
// to `h.reader(() => expr)`. `h.reader` is `Atom.readable` under the hood: a
// demand-driven derived that re-runs `expr` per dep change, whose lifecycle
// the registry owns by refcount (never mounted → never subscribes; unmount →
// released). `get` is a REAL exported function (auto-imported like `h`) — so
// hover / go-to-def / rename work through tsc with no injected identifiers —
// that reads through the AMBIENT reader: `h.reader` pushes the node's read
// context for the synchronous duration of `read()`, and `get` reads via the
// top of that stack. Outside a reader (a handler, after an `await`, a plain
// function) it throws with a clear message. Inside an `atom((get) => …)`
// body effect-atom's explicit param shadows the import, so both coexist.
// `get` accepts an `Atom` or an `AtomRef` — a ref is bridged INSIDE the
// reader's own read (`bridgeAtom`), the one place verrex still bridges refs
// into the registry graph. Static expressions never reach here (no `get` →
// no wrap), so their TypeScript type survives untouched.

/** What `get` accepts: an atom or a local ref. */
export type Get = <A>(source: Atom.Atom<A> | AtomRef.ReadonlyRef<A>) => A

// The ambient reader stack. A reader's `read` runs synchronously inside the
// registry read; a nested reader CREATED during it is only evaluated later
// (by the registry), so the stack is almost always depth 1 — it is a stack
// only so a reader that synchronously reads another reader's atom (nested
// registry reads re-enter this function) stays correct.
// `null` = an explicit "no ambient" frame: pushed while a reader reads one of
// its sources, so a verrex `get(...)` reached synchronously from INSIDE that
// read (an `Atom.map`/`Atom.readable` body) throws instead of silently
// recording its dep on the outer reader (where it would never re-track).
const readers: Array<Get | null> = []

// The mount's ROOT sink, keyed by the mount's `AtomRegistry` (one per mount,
// so the key is unique). A reader's RE-render throw keeps the last value and
// recovers node-locally, so it must NOT reach a `Catch` boundary's `report`
// (that would flip the boundary — recovery would change); it is reported to
// the root sink as a non-fatal defect instead. The reader reaches its
// registry via `ctx.registry` (AtomContext), which is what makes the lookup
// possible from inside a synchronous registry read. A reader running under a
// bare registry (no mount — unit tests) has no sink bound and falls back to
// `console.error`.
const rootSinks = new WeakMap<AtomRegistry.AtomRegistry, ErrorSink>()

/** @internal Bind a mount's root sink to its registry. Called by `mount`. */
export const bindRootSink = (
  registry: AtomRegistry.AtomRegistry,
  sink: ErrorSink,
): void => {
  rootSinks.set(registry, sink)
}

/**
 * Read an atom or ref inside a reactive JSX expression. The compiler wraps
 * the containing expression in `h.reader(() => …)`, so this only ever runs
 * with an ambient reader; calling it anywhere else throws.
 *
 * ```tsx
 * <span>{get(count) * 2}</span>
 * ```
 */
export const get: Get = (source) => {
  const active = readers[readers.length - 1]
  if (active === undefined || active === null) {
    throw new Error(
      "[verrex] get() called outside a reactive expression. `get` only tracks inside a JSX " +
        "expression (which the compiler wraps in h.reader) — not in an event handler, after an " +
        "await, or in a plain function. Read the atom via `Atom.get`/`registry.get`, or move the " +
        "get(...) into the JSX.",
    )
  }
  return active(source)
}

/**
 * The guarded, ambient-scoped readable behind `h.reader(() => expr)` — the
 * compiler's lowering of a JSX expression with a free `get(...)`.
 */
export const reader = <A>(_read: () => A): Atom.Atom<A> =>
  Atom.readable((ctx) => {
    const ambient: Get = (source) => {
      readers.push(null)
      try {
        return isAtomRef(source)
          ? ctx(bridgeAtom(source))
          : ctx(source as Atom.Atom<any>)
      } finally {
        readers.pop()
      }
    }
    // A throw must NOT escape the registry read: `AtomRegistry` has no
    // try/catch around a node's read, so an escaping exception aborts the
    // notify cascade — the parent's REMAINING dependents are dropped from
    // its children set for good (siblings freeze silently) and the throw
    // lands in the writer (a handler → its sink). One transient bad frame
    // (`get(user)!.name` while `user` is briefly null) is common in JSX, so
    // the reader stays node-local: keep the last good value, stay
    // subscribed to whatever the failed run did read, report, and recover on
    // the next dep change. A FIRST-read throw has no last value: it becomes
    // `Effect.die(error)` — a LIVE defect the fold routes to the nearest
    // `Catch` / the root sink (never rethrown into the registry: a nested
    // reader's first read commonly happens inside a notify cascade, where a
    // throw would freeze the siblings just the same). This is a verrex-owned
    // readable, so the guard is ours to keep; user-written `Atom.readable`s
    // get Effect's behaviour (upstream issue).
    readers.push(ambient)
    try {
      return _read()
    } catch (error) {
      const previous = ctx.self<A>()
      if (Option.isNone(previous)) return Effect.die(error) as A
      const sink = rootSinks.get(ctx.registry)
      if (sink) {
        sink(Cause.die(error))
      } else {
        console.error(
          "[verrex] a reader threw while re-rendering; " +
            "the node kept its last value and will retry on the next dep change.",
          error,
        )
      }
      return previous.value
    } finally {
      readers.pop()
    }
  })

/**
 * Read `source` through a registry `get`: an `Atom` directly, an `AtomRef`
 * bridged (`bridgeAtom`), anything else returned as-is. The one rule for
 * turning a "value or reactive source" prop into a tracked value inside a
 * readable (used by `On`; `h.reader`'s ambient `get` does the same bridging
 * for JSX expressions).
 */
export const readSource = (
  get: <A>(atom: Atom.Atom<A>) => A,
  source: unknown,
): unknown =>
  Atom.isAtom(source)
    ? get(source)
    : isAtomRef(source)
      ? get(bridgeAtom(source))
      : source

/**
 * Run `f` inside a registry read without letting a throw escape it: an
 * escaping exception would abort the notify cascade and freeze the node's
 * siblings for good (see the guard in `reader` above). A throw is a defect —
 * `Effect.die` — a LIVE failure for the nearest `Catch` / the root sink.
 */
export const guardRegistryRead = (f: () => unknown): unknown => {
  try {
    return f()
  } catch (error) {
    return Effect.die(error)
  }
}
