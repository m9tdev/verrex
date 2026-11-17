# verrex — Effect-native UI framework

**Purpose:** a TypeScript UI framework where Effect's `<A, E, R>`
channels propagate from every leaf of the view tree to the root.
Forgetting to provide a service `Layer` becomes a _compile-time
error that names the missing service_; symmetrically, forgetting to
handle an error with a `Catch` boundary becomes a _compile-time
error that names the unhandled error_ (`mount` requires
`Effect<View<never>, never, R>`). Errors live in two phases: construction
errors ride the Effect `E`; live errors a rendered subtree can still
produce ride the `View<E>` success — one `Catch` boundary discharges both.

**Honest scope today:** the _construction_ channel is fully type-tracked —
a forgotten boundary on a failing build is a compile error. The _live_
channel is tracked wherever a rendered subtree can still fail: (1) an
`Atom`/`AtomRef` child that EMITS an `Effect<View, E>` — the fold's phase
switch puts that `E` on `View<E>` (this is how an `atom(...)`'s failure
escalates: `<On value={user} Success={…} />` with no failure arm; a tag arm
or `Failure` handles it in place; partial handling narrows `E`, the residual
rides); (2) _event handlers_: an intrinsic's `on*` prop returning
`Effect<_, E, R>` stamps `E` on the element's `View<E>` and folds `R`; (3)
`For` rows and `Catch` fallbacks fold their `E`/`R` too. `mount`'s
`View<never>` gate makes a missing boundary a compile error naming `E`.
Reactivity is effect-atom's API with `R`/`E` owned by the caller — see
"Reactivity model" in [`src/runtime/AGENTS.md`](./packages/core/src/runtime/AGENTS.md).

**The name** is built from the channels of an `Effect<View, E, R>`:
**V** (View — the `A`, always the `View` here), **E** (Error), **R**
(Requirements), plus **X**, because the JSX/TSX syntax it borrows adds an
X too. `V + E + R + X` spells **verx**, stylized to **verrex** (and the
`.vx` source extension).

Status: experimental proof-of-concept. Not production-ready.

## The constraint that shaped everything

TypeScript's JSX type-checker erases generic type variables at the
JSX boundary — every component result collapses to `JSX.Element`.
React, Solid, Preact all live with this. For a framework where
the _point_ is that `E`/`R` channels survive composition, that's
fatal.

So this project deliberately **never lets `tsc` see JSX**:

1. Source files use a custom `.vx` extension.
2. `@verrex/core/compiler` (Babel-based) rewrites every JSX node into an
   `h(tag, props, ...children)` call **before** tsc sees the file.
3. `h()`'s generic signature in `verrex` uses conditional
   types (`FoldE`/`FoldR`) to union every child's `E` and `R` into
   the result `Effect<View, E, R>`.

Everything else — the `.vx` extension, the Babel choice, the
custom Vite dev server hook, the TS Language Service plugin —
exists to support this constraint.

### "JSX" here means JSX _syntax_, not JSX _semantics_

This is the most important framing for anyone (or any agent)
joining the codebase. **We borrow JSX syntax. We do not use JSX
in any other sense.**

We use:

- The angle-bracket form `<div>...</div>` as a source-code shape.
- Babel's `jsx` parser plugin to recognize that shape.
- Editor / Treesitter JSX highlighting (via `typescriptreact`
  filetype mapping).

We do **not** use:

- A JSX runtime (`jsx-runtime`, `jsx-dev-runtime`,
  `React.createElement`, none of it).
- The `JSX` TypeScript namespace (`JSX.IntrinsicElements`,
  `JSX.Element`). If those names appear in an error message,
  something is wrong — tsc is seeing JSX it shouldn't.
- Any React-shaped library. There is no React, Preact, Solid
  dependency.
- TypeScript's JSX type-checker. It's never engaged because the
  compiler removes the syntax before tsc parses the file.

Post-compile, `Counter.vx` is `h("div", { class: "counter" }, ...)`
calls in a `.ts` file. Plain function calls in plain TypeScript.
That's the only thing tsc, Vite, your IDE's type-checker, or any
downstream tool ever sees.

When this AGENTS layer says "JSX expression," "JSX node," or "JSX
child," read it as "the angle-bracket source-code shape that the
compiler eats and converts into `h()` calls." Not the React thing.

## Subsystems

Everything user-facing ships as one package, **`packages/core/`**, with a
subpath export per surface (the subdirs self-reference via `verrex/*`). The
editor plugin is the one separate package, because tsserver resolves Language
Service plugins only by bare package name.

- **[`src/runtime/`](./packages/core/src/runtime/AGENTS.md)** — export `@verrex/core`. `h`,
  `mount`, `atom`, `fn`, `get`, `For`, `On`, `Catch`, `Fragment`, `Component.make`, the
  View IR (mount switches on it), channel-fold types. The thing components
  import from.
- **[`src/compiler/`](./packages/core/src/compiler/AGENTS.md)** — export
  `@verrex/core/compiler`. The Babel transform: intrinsic JSX → `h()`,
  component tags → direct calls (`MyComp({...})`), a JSX expression with a
  free `get(...)` → `h.reader((get) => …)`, `Component.make` name slot.
- **[`src/language/`](./packages/core/src/language/AGENTS.md)** — export
  `@verrex/core/language`. The Volar `LanguagePlugin` describing `.vx` files (file id,
  virtual code, source-map conversion, JSX region tagging). Bridges
  `@verrex/core/compiler` to Volar's contracts; consumed by the ts-plugin and check.
- **[`src/check/`](./packages/core/src/check/AGENTS.md)** — export `@verrex/core/check`, bin
  `verrex-check`. Standalone CLI/programmatic type-checker on `@volar/kit` +
  the language plugin. Replaces `tsc --noEmit` for `.vx`.
- **[`src/vite-plugin/`](./packages/core/src/vite-plugin/AGENTS.md)** — export
  `@verrex/core/vite`. Owns the full `.vx` compile (Babel JSX→`h()`, then Oxc
  type-strip via `transformWithOxc`, `moduleType: "js"`); rewrites `.vx` URLs
  with `?import` so strict-MIME browsers accept the response.
- **[`src/testing/`](./packages/core/src/testing/AGENTS.md)** — export
  `@verrex/core/testing`. In-process component test harness; `render(app, layer?)`
  mounts into a happy-dom DOM and drives it. The `layer` requirement is
  type-enforced so a missing service is a compile error.
- **[`packages/ts-plugin/`](./packages/ts-plugin/AGENTS.md)** (publishes as
  `@verrex/ts-plugin`) — the Volar-based TS Language Service plugin (editor
  integration): JSX tag-pair
  highlights, inlay-hint filtering, reference dedup/sort, native cross-file
  go-to-def. esbuild-bundles `@verrex/core/language` into one CJS file.
- **[`apps/demo/`](./apps/demo/AGENTS.md)** — usage patterns by primitive; home
  to `channels.test-d.ts`, the compile-time proof.
- **[`scripts/`](./scripts/AGENTS.md)** — manual Playwright probes
  (`probe-*.mjs`) for browser behaviors unit/type tests can't reach.

## Repository-wide invariants

- **Reactivity is `effect/unstable/reactivity`** — `AtomRef`, `Atom`,
  `AtomRegistry`, `AsyncResult`, `Collection`. We do not ship our
  own signal/atom primitive. If you reach for one, stop and use
  the Effect one.
- **API surface stays minimal.** Don't expose helpers that wrap
  what Effect already provides (no `verrexMap`, `verrexIf`, etc.).
  Users compose with native Effect combinators. Concretely, what
  we **build** is small: the View IR, `h()` + the fold types,
  `mount`, the Babel transform, the Volar language plugin, the
  Vite plugin. What we **consume** from Effect: `Effect.fn` /
  `Effect.gen` (component shape), `Context.Service` (services),
  `Data.TaggedError` (errors), `Layer` (root provisioning),
  `Scope` (per-row lifecycles), and every reactivity primitive
  (`AtomRef`, `Atom`, `AtomRegistry`, `AsyncResult`,
  `Collection`). If you find yourself building a new wrapper
  alongside Effect, you're probably on the wrong side of this
  line.
- **`.vx` files never reach `tsc` directly.** A plugin always
  intercepts: `@verrex/core/language` (consumed by the TS plugin and by
  `@verrex/core/check`) hands tsc a JSX-free virtual TS buffer, and
  `@verrex/core/vite` does the same for Vite. Source files keep
  their angle brackets; only the compiled buffer is JSX-free.
- **Imports of `.vx` files use the explicit `.vx` extension.**
  `import { X } from "./Foo.vx"` — not `"./Foo"`. TS's resolver
  only tries `extraFileExtensions` against import paths that
  already carry the matching suffix. Same convention as Vue
  (`.vue` in imports) and Astro (`.astro`).
- **Components are `Component.make` functions taking at most one
  props object.** Write `export const Counter = Component.make(function* () { … })`
  (or `function* (props: { id: string })` when there are props),
  not a bare `Effect.fn` wrap or `(props) => Effect.gen(function* () { … })`.
  The single-prop signature is what makes `<Counter />` compile
  (component tags lower to direct calls — `Counter(props)`, zero-arg
  `Counter()` when attr-less and child-less); a propless component
  takes **no parameter at all**. A _generic_ component uses the
  Effect-returning form
  (`Component.make(<T,>(props: { item: T }) => Effect.gen(…))`),
  whose identity-typed overload preserves the type parameter. The
  seam's three jobs (traced spans, signature preservation,
  compiler-filled name slot) live in
  [`src/runtime/AGENTS.md`](./packages/core/src/runtime/AGENTS.md).
- **`refs/` is reference material for inspiration.** Cloned external
  repos — search here when stuck on design questions or debugging
  integrations. Key references:
  - `effect/` — **Effect v4 internals** (the `Effect-TS/effect`
    monorepo), especially
    `packages/effect/src/unstable/reactivity` (AtomRef, Atom,
    Collection). Search here first for reactivity patterns.
  - `volar/`, `vue-language-tools/` — Volar Language Service plugin
    architecture, reference for `@verrex/ts-plugin`.
  - `vite-plugin-svelte/` — mature Vite integration patterns.
  - `solid/` — fine-grained reactivity patterns.

  Token budget note: grep for specific symbols rather than loading
  entire directories.

## Tooling at a glance

- pnpm workspace, 2 packages (`@verrex/core` + `@verrex/ts-plugin`) + demo + workspace root.
- Effect v4 (see `packages/core/package.json` for the pinned version;
  developed in the `Effect-TS/effect` monorepo).
- Vitest — compiler tests use plain `vitest`; runtime channel-fold
  type-tests via `expectTypeOf` at typecheck time.
- oxlint + oxfmt for linting and formatting, on stock config bar a few
  documented exceptions. Neither supports `.vx` (hardcoded Rust
  extension list, no plugin API for file types), so `pnpm lint` /
  `pnpm format` also run
  [`scripts/vx-oxc.mjs`](./scripts/AGENTS.md#vx-oxcmjs--linting-and-formatting-vx),
  which feeds `.vx` through a shadow tree of `.tsx` symlinks; and
  [`scripts/comment-width.mjs`](./scripts/AGENTS.md#comment-widthmjs--comment-line-width),
  which keeps comment prose at 80 columns (`--fix` reflows).
- Babel as the `.vx` parser (parser + traverse + generate
  directly, no `@babel/preset-*`).
- Volar (`@volar/typescript`, `@volar/language-core`,
  `@volar/source-map`) under the TS plugin for editor integration.
- esbuild to bundle the TS plugin into a single CJS file
  tsserver can `require()`.
- No bundler in the framework itself; consumers bring Vite (or
  whatever) plus the Vite plugin.
- Nix devshell (`flake.nix`) provides Node, Corepack (which resolves
  pnpm via the `packageManager` field), and Chromium with
  `VERREX_CHROMIUM` pre-exported for the probe scripts.

## How to verify a change end-to-end

```
pnpm lint            # oxlint, .vx via scripts/vx-oxc.mjs, comment width
pnpm format:check    # oxfmt + .vx (`pnpm format` to fix; also reflows comments)
pnpm -r test         # compiler tests + ts-plugin integration tests
pnpm -r typecheck    # fans out: every package runs `tsc --noEmit`,
                     # apps/demo runs `@verrex/core/check` (the .vx-aware checker)
pnpm --filter verrex-demo dev   # browser-test interactive features
```

UI changes especially require the dev server pass — type checks
catch contract regressions but not "the click handler didn't
re-render."

## Releasing

Two packages publish to npm (`@verrex/core`, `@verrex/ts-plugin`) via
release-please: pushes to `main` update one Release PR per package;
merging one tags and publishes that package (tokenless OIDC +
provenance). The one rule that
matters in every commit: **a commit bumps a package by the path of the
files it changes, not by the commit scope** — keep a commit's edits
inside one package dir to bump just that one; commits touching neither
package (root, `apps/demo/`, `.github/`, docs) release nothing. Full
process — version/tag scheme, pre-1.0 bump policy, trusted-publisher
bootstrap, dist/src shipping for go-to-def — in
[`docs/RELEASING.md`](./docs/RELEASING.md).

## Reference docs (outlinks)

- [`README.md`](./README.md) — public-facing intro + editor setup.
- [`docs/intent-layer.md`](./docs/intent-layer.md) — explains the
  AGENTS.md tree itself: what it is, how to capture and maintain it.
- [`docs/RELEASING.md`](./docs/RELEASING.md) — the full release process
  (release-please, OIDC publishing, exports/dist shipping).

## Maintaining the Intent Layer

This repo uses an Intent Layer (the `AGENTS.md` files throughout the
codebase). When you make changes that affect architectural boundaries,
contracts, invariants, or anti-patterns, **update the relevant AGENTS.md
file as part of the same change**.

Signs an AGENTS.md needs updating:

- You added a new invariant or coupling between packages
- You discovered an anti-pattern the hard way
- A section describes behavior that no longer matches the code
- You added a new subsystem that warrants its own node

`AGENTS.md` is the only agent-instructions file; there is no `CLAUDE.md`.

Claude Code, Codex and other agents load `AGENTS.md` natively: the root
node at session start, nested nodes when they work in that folder. A new
node anywhere is picked up automatically, no registration or hooks needed.

## Anti-patterns at the root

- Don't try to make `.tsx` work as a parallel file extension.
  Channels die through tsc's JSX type-checker — that's the whole
  reason `.vx` exists.
- Don't add a JSX runtime shim (`jsx-runtime`, automatic JSX,
  etc.). Components are `h()` calls; the compiler is the only
  thing that produces them.
- Don't refactor the runtime to make `h()` accept arbitrary
  generic factories ("pluggable JSX backends"). The fold types
  are tightly coupled to `h`'s exact signature.
- Don't add a state-management layer on top of Effect's
  reactivity primitives. Composition belongs to the user.
