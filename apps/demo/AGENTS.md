# `apps/demo` — usage patterns by primitive

Each `.vx` file exercises a different framework primitive. The
demo is also the canonical "example" — when documenting an
intended pattern, prefer extending an existing demo over inventing
a new one elsewhere.

The actual app at `src/main.vx` mounts every demo into one page so
they can be exercised in a browser side-by-side.

## What each demo proves

| File | Primitive |
|---|---|
| `Counter.vx` | Local `AtomRef` state, no Effect services. Reactive `.value` interpolation inside `{...}` expressions. |
| `UserPage.vx` | In-component fetch: a `Component.make` body that `yield*`s `http.getUser` directly, so the subtree blocks until it resolves and `E = HttpError` + `R = Http \| Theme` fold to the root (root-handled failure). The channel-propagation example. |
| `AsyncUserPage.vx` | The same fetch behind the `Async` boundary, once form: `Async(getUser, { initial, failure, success })` (thunk-first positional, extractable `from`). Non-blocking (initial placeholder) and failure rendered as a value (`failure`), so `E = never`; `Http` still folds (fetch on the mount fiber) → `Effect<View, never, Http \| Scope>`. The boundary counterpart to `UserPage` — same data, opposite `E`. Renders into `.async-user-page` (distinct from UserPage's `.user-page`). |
| `LiveUser.vx` | The `Async` boundary, auto-tracking form: `Async(() => http.getUser(userId.value), { … })`. The thunk reads a writable `AtomRef`'s `.value`, so it becomes a tracked dep and the fetch re-runs on change (interrupting the stale run) — no explicit trigger declared. Service extracted up front → `Effect<View, never, Http \| Scope>` (Http folded), unlike a baked `Atom.runtime` which would discharge it. |
| `Todos.vx` | Keyed reactive list (`{coll.value.map(item => <Row item={item}/>)}` compiles to `list(coll, render)`). Per-row reactivity: toggling one row doesn't tear down others. |
| `Lifecycle.vx` | `Effect.acquireRelease` inside a row — release fires when the row is removed (per-row Scope in mount). |
| `CatchDemo.vx` | The `Catch` error boundary (step 07), both forms: a function handler (catch-all over a `Crasher` whose click fails) and an object tag-map (`{ HttpError }` over a flaky `BadRequest` that ~50% of the time fails construction with a random typed error, routed + unwrapped — `retry` re-rolls and may recover). Discharges to `Effect<View, never, Scope>`; `reset`/`retry` re-run construction. Exercised end-to-end by `scripts/probe-catch.mjs`. |
| `AsyncEscalate.vx` | `Async` failure homes over **`AsyncHandle`s** (step 08): each block's data is an `asyncRef` handle created in the component body — data outlives the views (an escalated block keeps tracking `userId`), spam is `tagUser.refetch()` ×3, and the banners' retries compose `() => { handle.refetch(); reset() }` (over a handle, `reset` alone re-renders CURRENT state without refetching). Two live blocks share one `userId` dep. **Tag-map block**: the thunk fails with `HttpError \| RateLimited` (a demo-local second tag); `HttpError` is handled **at the leaf** — the fetch loop stays live (another id recovers with no boundary involved; the handler's `retry` re-runs the same fetch, showing the `initial` arm while in flight); `RateLimited` rides the residual (`View<RateLimited>`, literally the `Exclude`) to a page-level `Catch` **tag map** (`.page-fallback`) that gets it unwrapped (`e.retryAfterMs` typed). Deleting that `Catch` names only `RateLimited`. The rate limit is **real**: a sliding-window limiter (2 req/s shared by both blocks) in `fetchUser`'s synchronous body — request-creation time, so every refetch counts deterministically, interrupted or not; the "spam ×3" button fires three refetch rounds back-to-back — enough to exceed the budget even when only one block is still live. A live **request log** (`.req-log`, reactive text ref) narrates every request: sent (n/2), ← 200/404, ← interrupted (stale run), → 429 — the limiter's whole story is on-screen. **Open-form block**: the same fetch with no `failure` arm — every failure rides `View<HttpError \| RateLimited>` to a catch-all `Catch` (`.open-fallback`, `Cause.pretty` + `reset`); deleting it names the full union. The id buttons live outside both boundaries and survive every swap. Exercised end-to-end by `scripts/probe-escalate.mjs`. |
| `Clock.vx` | Push-based fine-grained updates from an Effect `Stream` (step 09): an analog clock driven through ONE write — a stream of wall-clock second boundaries (`Stream.fromEffectRepeat` over a sleep recomputed from the real clock each cycle: `1000 - Date.now() % 1000`, drift-free and boundary-aligned) piped to `runForEach` pushes the time into a single `now` ref, the pipeline `Effect.forkScoped`-ed so the fiber is bound to the component's `Scope` — unmount/reset interrupts it (no unsubscribe bookkeeping). The hand angles are *derived* (`now.map(…)` → `ReadonlyRef`, whose subscribe is equality-deduped: recomputes every tick, notifies only when its value changed), and each hand's `style` is a tracked attr on exactly its own derived ref → one DOM write per tick (the second hand's rotation; minute/hour join at the top of the minute). The hands carry only `transform: rotate(…)` inline and deliberately no CSS transition, so the flash overlay (which observes `class` + `style` attribute mutations) marks exactly the write. `Scope` is the only requirement → `Effect<View, never, Scope>`. Note the fully set-free form (`Atom.make(stream)`) exists in Effect but isn't expressible as a tracked attr today — `h.read`/`applyProp` speak `AtomRef` only; an `Atom` source would force the hands into child position (whole-element swap per tick + `AsyncResult` unwrap). |
| `main.vx` | Wires Layers (`VerrexLive`, `HttpLive`, `ThemeLive`) + `Effect.scoped` + `Effect.never` (keep scope alive for page lifetime). |
| `services.ts` | Mock Http + Theme services. `Data.TaggedError` for `HttpError`. |

## No sibling `.ts` files on disk

Cross-file `.vx` imports carry an explicit `.vx` extension (see
the root [AGENTS.md](../../AGENTS.md) invariant). As a result
nothing in this demo's build pipeline emits sibling `.ts` files:
`pnpm typecheck` runs [`@verrex/core/check`](../../packages/core/src/check/AGENTS.md)
directly, `vite build` runs
[`@verrex/core/vite`](../../packages/core/src/vite-plugin/AGENTS.md)
directly, and the editor's
[TS plugin](../../packages/ts-plugin/AGENTS.md) maps virtual-code
results back to source `.vx` positions natively.

## `channels.test-d.ts`

Type-only test file. Uses `expectTypeOf` from `vitest` to assert
that:

- A `<Component />` whose body needs `Http` propagates `Http` into
  `R` at the surrounding `h()` call site (which is what the
  compiler turns the JSX-syntax into — see root
  [AGENTS.md](../../AGENTS.md)).
- A `<div>` containing such a component propagates `Http` too.
- Conditional / `&&` / list children all fold `E`/`R` correctly.
- A consumer that forgets a required Layer fails to type-check.

This is the **compile-time proof that channels survive the tree**.
If you touch `h()`'s signature, any of the `Fold*` types, or `View`
IR, run:

```
pnpm --filter verrex-demo typecheck
```

A regression here is the framework's central thesis breaking. The
file is intentionally not run as a runtime test — `expectTypeOf` is
purely a typing assertion.

## Vite dev server

`vite.config.ts` is intentionally minimal — it wires
`@verrex/core/vite`, which owns the whole `.vx` story (transform + URL
middleware; see [its node](../../packages/core/src/vite-plugin/AGENTS.md)).
Don't add a separate filename-rewrite shim; the plugin already handles it.

The dev server binds to `0.0.0.0` (set in vite.config.ts) so LAN
devices can hit the demo. Don't drop that without checking.

## Anti-patterns

- Don't import from `verrex/internal` — there is no internal
  subpath; everything is re-exported from the index.
- Don't wrap reactive reads in `.pipe(Effect.map(...))` for the
  common case — let the compiler emit `h.track`. Use Effect's
  combinators only when you actually need to compose multiple
  Effects.
- Don't add helper components that wrap intrinsics for no reason.
  The demo is opinionated about *not* having a component library;
  it shows what falls out of the framework directly.
- Don't reach for `AtomRef.unsafeMake` or `Effect.runSyncUnsafe`
  in component code — the runtime expects everything reactive to
  flow through scoped effects.

## Related context

- Runtime contract: [`packages/core/src/runtime/`](../../packages/core/src/runtime/AGENTS.md)
- Compiler rewrites (what `.vx` actually becomes): [`packages/core/src/compiler/`](../../packages/core/src/compiler/AGENTS.md)
- Framework rationale + channel-fold thesis: root [`AGENTS.md`](../../AGENTS.md)
