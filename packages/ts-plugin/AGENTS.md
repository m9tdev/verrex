# `@verrex/ts-plugin` — Volar-based language plugin for `.vx`

What this delivers in your editor: type errors, hover, completions,
inlay hints, go-to-definition, find-references, and JSX tag-pair
highlights, all on the `.vx` source. No virtual file is visible
to the user.

Built on **Volar** (`@volar/typescript`, `@volar/language-core`,
`@volar/source-map`) — we use its language-plugin framework for the
heavy lifting (file discovery, content transformation, position
mapping) and wrap the resulting LanguageService with a thin proxy
for the things Volar doesn't quite do out of the box.

After the `@verrex/core/language` extraction this package contains only the
tsserver-facing pieces; esbuild bundles them into `dist/index.cjs`
for tsserver to `require()`.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry. Re-exports `pluginFactory` via `export =`. |
| `src/jsx-tags.ts` | `findJsxTagPair` — takes a `JsxTagProvider` (the in-process seam) and uses its `jsxRanges` from the shared `VerrexVirtualCode` to find tag-pair partners for document highlights. The service-proxy builds the provider by resolving the `VerrexVirtualCode` from Volar's context. |
| `src/classify-references.ts` | `classifyRefs` — decorates each ref with `{ isDef, isImport }` in one pass, with a per-call file-content cache so each source file is read at most once. Plus `refKey` (the `${fileName}:${textSpan.start}` identity), `dedupeRefs` (drop same-key hits, first-seen order), and `sortClassifiedRefs` (def→usages→imports ordering on the precomputed booleans). The two reference handlers compose these instead of inlining the key/sort logic. |
| `src/hint-text.ts` | `hintText(hint)` — reads an inlay hint's label across the shapes different TS versions use (`hint.text` string, `hint.text` parts, `hint.displayParts`), returning the first non-empty. Plus `SUPPRESS_RE`, the `_tag`/`_props`/`_children`/`_name` regex. Pure + unit-tested so the filter doesn't need a tsserver. |
| `src/service-proxy.ts` | `pluginFactory` — instantiates the shared LanguagePlugin via `createVerrexLanguagePlugin<string>(identity)`, builds Volar's `createLanguageServicePlugin` (capturing the session `Language` through its `setup(language)` hook), then wraps the resulting `LanguageService` in a Proxy with a few method overrides (filter `verrex`'s `h.ts` from definition results, JSX tag-pair document highlights, `_tag`/`_props`/`_children`/`_name` inlay-hint filter, reference dedup + sort). Resolves the per-`.vx` `VerrexVirtualCode` from `language.scripts` when it needs `jsxRanges` or `source`. |
| `src/classify-references.test.ts` | Unit tests for `classifyRefs` (injected fake `readFile`, no disk), plus `refKey`/`dedupeRefs`/`sortClassifiedRefs` — pins the dedup key, first-seen order, and the def→usages→imports ordering (incl. usage-tier stability) without a tsserver. |
| `src/plugin.test.mjs` | Manual smoke test loading the built bundle (`dist/index.cjs`) and asserting plugin shape. Not run by `pnpm test` (vitest config only picks up `*.test.ts`); invoke directly with `node` after building. |
| `vitest.config.ts` | Picks up `src/**/*.test.ts`. The package's `test` script runs vitest first, then builds and runs the integration harness. |
| `test/integration.mjs` | tsserver-subprocess harness. The acceptance-level check that the plugin really works end-to-end. |
| `build.mjs` | esbuild bundle producing `dist/index.cjs` (tsserver `require()`s the plugin as CJS). |

The LanguagePlugin itself (the Volar contract), `convertSourceMap`,
the `VerrexVirtualCode` class, and the three `CodeInformation` profiles
live in [`@verrex/core/language`](../core/src/language/AGENTS.md) — shared with
`@verrex/core/check`.

## How it fits together

```
.vx on disk ──┐
               │  Volar's LanguagePlugin (in verrex/language)
               │    getLanguageId()    — ".vx" → "verrex"
               │    createVirtualCode() — transformVerrex → compiled TS
               │    + Volar Mappings (from Babel source map)
               ▼
        VerrexVirtualCode (Volar VirtualCode)
               │
               ▼  tsserver type-checks the virtual TS, Volar maps
               │  results back to source .vx coordinates
        LanguageService results in .vx coords
               │
               ▼  our Proxy wrapper
               │    filterRuntimeHit()         — drop hits in runtime/h.ts
               │    getDocumentHighlights()    — JSX tag pair custom path
               │    provideInlayHints()        — filter _tag/_props/_children/_name
               │    getCompletionsAtPosition() — clamp cross-line replacementSpans
               │    get/findReferences()       — dedupe + sort
               ▼
        Final LanguageService results
```

## The Volar language plugin

The LanguagePlugin itself lives in
[`@verrex/core/language`](../core/src/language/AGENTS.md); if a bug points
at file enumeration, virtual-code content, the `VerrexVirtualCode` class,
or the source-map mappings, the fix is there, not here. This package's
wiring:

- `service-proxy.ts` calls `createVerrexLanguagePlugin<string>((s) => s)`
  — tsserver identifies scripts by string filenames.
- The resulting LanguagePlugin gets handed to Volar's
  `createLanguageServicePlugin` quickstart helper, which hooks Volar
  into tsserver's plugin protocol. Our `setup(language)` callback fires
  synchronously inside `create(info)` and stashes the session's
  `Language` so the proxy can resolve compiled `.vx` files from it.
- Everything else in this package is the *proxy wrapper* below — it
  only touches the LanguageService results.

`getVerrexVirtualCode(fileName)` resolves
`language.scripts.get(fileName).generated.root` and narrows it with
`instanceof VerrexVirtualCode` — the exact instance Volar received from
`createVirtualCode`, read back from Volar's own context with no
side-channel cache (matches Vue's `VueVirtualCode` pattern). The
proxy wrapper below doesn't translate offsets itself: Volar's own
`SourceMap` indexes `mappings` and maps virtual-code coordinates back
to `.vx` source before results reach us. We resolve the
`VerrexVirtualCode` only for `jsxRanges` (via the `JsxTagProvider` handed
to `jsx-tags.ts`) and `source` (whitespace-at-cursor suppression in
`getDocumentHighlights`, cross-line span detection in
`getCompletionsAtPosition`).

## The proxy wrapper

Volar produces a working LanguageService. We then wrap it in a
`Proxy` (in the outer `pluginFactory`) and override five groups of
methods. Seven of the eight overrides route through a local
`wrapMethod(name, transform)` helper — it calls the underlying
LanguageService method eagerly and hands the result plus the
original args to `transform`. `getDocumentHighlights` is the
exception: its `.vx` path early-returns (whitespace skip,
JSX-pair match) before the underlying call would fire, which the
eager-call shape of `wrapMethod` can't express, so it stays
hand-rolled.

- **`getDefinitionAtPosition` / `getDefinitionAndBoundSpan` /
  `getTypeDefinitionAtPosition`** — call Volar, then filter each
  result through `filterRuntimeHit`: drop any hit whose path
  contains `/runtime/` and ends in `/h.ts` (the JSX factory
  itself — go-to-def on `<div>` should NOT land you in `h.ts`).
  The predicate is intentionally loose so a workspace-relative
  path, an absolute path, or a vendored copy all match. Volar
  has already mapped results back to `.vx` source coordinates
  via its own `SourceMap`, and TS's resolver finds `.vx` files
  directly via `extraFileExtensions` — no path rewriting, no
  offset re-mapping, no header-offset subtraction needed.

- **`getDocumentHighlights`** — `.vx`-only custom path. If the
  cursor is on a JSX tag (anywhere on the brackets or name, but
  not on attributes), `findJsxTagPair` walks the
  `VerrexVirtualCode.jsxRanges` resolved from Volar's context and
  returns the matching opening↔closing name spans. Highlights just
  the names. Babel paired the tags during parse; we don't depth-
  count or regex-scan. Self-closing (`<Foo />`) and fragments
  (`<>...</>`) return no pair. Falls back to Volar's default
  outside JSX tags.

- **`provideInlayHints`** — `.vx`-only filter. Volar gives us all
  hints including the h() parameter labels (`_tag`, `_props`,
  `_children`) and the `_name:` label for `Component.make`'s
  compiler-injected name argument (the injected literal has no source
  loc, so its hint rides the preceding mapping and would render at the
  end of the call — `})name:`). We drop any hint whose label matches
  `SUPPRESS_RE`. Bare `name:` is deliberately NOT matched — it's a
  common user parameter; only the underscore form is suppressed.
  Label extraction (`hintText`) and the regex live in `hint-text.ts`
  (pure + unit-tested); `hintText` reads the first non-empty of
  `hint.text` (string), `hint.text` (parts), or `hint.displayParts`
  (newer TS) — first-non-empty so an empty `displayParts` can't clobber
  a found label.

- **`getCompletionsAtPosition`** — `.vx`-only span clamp. When the
  user types `count.` mid-edit and triggers completions, Babel's
  `errorRecovery: true` (in `@verrex/core/compiler`) parses
  `count.\n\nreturn yield*` as `count.return` (the next keyword
  becomes the synthesized property name). That gives us the right
  completion list — members of `count` — but tsserver's
  `optionalReplacementSpan` covers the `return` keyword on the
  next line. Applying it would delete `return`. We detect spans
  whose range crosses a newline relative to the cursor position
  and clamp them to a zero-width span at the cursor, so the
  editor inserts the picked entry rather than replacing the
  next-line token. Same treatment for per-entry `replacementSpan`
  in case tsserver populates it.

- **`getReferencesAtPosition` / `findReferences`** — dedupe + sort.
  Both compose the helpers in `classify-references.ts` rather than
  inlining the logic; the two handlers iterate different shapes (a
  flat `ReferenceEntry[]` vs the flattened nested `ReferencedSymbol[]`),
  so they share the key formula, not the loop.
  - Filter out hits in `verrex`'s `h.ts` (same reason as the
    definition overrides).
  - `dedupeRefs` deduplicates by `refKey` (`${fileName}:${textSpan.start}`).
    `findReferences` flattens its nested result first and dedupes
    **across symbols**, because TS often returns the same logical
    reference under both the renamed component name and the `h(...)`
    call symbol.
  - `sortClassifiedRefs` orders definition first, then usages, then
    imports. The "is this an import line?" decision needs to read the
    source file — `classifyRefs` does that **once** per distinct file
    before the sort, so the comparator only looks at precomputed
    booleans. (Previously the comparator called `ts.sys.readFile`
    inline, paying O(N log N) reads of the same handful of files; and
    the policy itself was untestable inside the Proxy closure.)

## Cross-file resolution

Find-references and go-to-definition cross `.vx` files natively
because user code writes `import { X } from "./Foo.vx"` (the
root invariant) — TS's resolver picks up `.vx` via the
`extraFileExtensions` registered by [`@verrex/core/language`](../core/src/language/AGENTS.md),
the file lands in the program as virtual code, and TS's reference
index sees usages across files. No sibling `.ts` shim is involved.

## Coupling to other packages

- **`verrex` `h.ts` / `Component.ts`** — the `HFn` signature uses
  parameter names `_tag`/`_props`/`_children`, and `Component.make`'s
  compiler-filled name slot is `_name` (underscore prefix throughout).
  This is **coupled to the inlay-hint filter regex above**. If you
  rename them, update the regex in `hint-text.ts`. The `_?` makes the
  h() trio tolerate both prefixed and unprefixed variants; `_name` is
  underscore-only so user `name:` hints survive.

- **`@verrex/core/compiler` `copyLoc`** — the compiler preserves source
  locations on emitted nodes. Without that, Babel's source map
  collapses everything to the start of the JSX expression, and
  go-to-definition lands on the wrong token.

- **`@verrex/core/compiler` `jsxRanges`** — `TransformResult.jsxRanges` is
  load-bearing for two features: classifying source positions as
  "inside h()" or "JSX punctuation" during source-map conversion
  (in `@verrex/core/language`), and finding tag-pair partners for document
  highlights (`jsx-tags.ts` here). If the compiler ever stops
  emitting it (e.g. swc swap), both features break silently. The
  array is stored on `VerrexVirtualCode` next to `mappings` so neither
  consumer re-runs the compiler.

- **Volar script-key shape** — we resolve the `VerrexVirtualCode` via
  `language.scripts.get(fileName)`, keyed by the `.vx` file-path
  string tsserver hands us — the same string `createVerrexLanguagePlugin`
  is configured with (`asFileName` is identity here). If that key
  convention changes in `@verrex/core/language`, the lookup here breaks with
  it.

## Anti-patterns

- Don't try to wrap LanguageService methods via Volar's `setup`
  hook or by mutating `info.languageService` from inside the
  language plugin. `createLanguageServicePlugin` returns its own
  proxy that intercepts methods before any setup-time wrap can
  apply — the wrap silently does nothing. Wrap externally with
  `new Proxy(volarService, ...)` *after* `volarModule.create(info)`
  returns (which is what `pluginFactory` at the bottom of
  `index.ts` does). Using `setup(language)` to *capture* the
  `Language` for read-only lookups (`language.scripts.get(...)`) is
  fine and expected — it's *wrapping methods* there that doesn't
  work. The capture is a synchronous handoff: `setup` fires inside
  `volarModule.create(info)`, so read the stashed `Language` into a
  per-`create` const immediately after that call returns, before any
  service method can run.
- Don't change `noHighlightData` / `structuralOnlyData` /
  `fullData` to be position-dependent at *runtime*. They're
  decided at `createVirtualCode` time per range; that's how Volar
  caches mappings.
- Don't add a fourth CodeInformation profile without checking
  Vue's docs and Volar source — the six flags
  (`verification`/`completion`/`semantic`/`navigation`/`structure`/`format`)
  interact in non-obvious ways.
- Don't switch `extraFileExtensions.scriptKind` /
  `extraFileExtensions.isMixedContent` /
  `getServiceScript.scriptKind` independently. They form a
  contract with tsc that's load-bearing across both this plugin's
  tsserver path and `@verrex/core/check`'s kit path. The current
  combination (Deferred + isMixedContent: true + TS for the
  virtual code) is documented in
  [`@verrex/core/language` AGENTS.md](../core/src/language/AGENTS.md#the-extrafileextensions-shape-is-load-bearing).
  Change all three together or not at all.

## Test loop

```
pnpm --filter @verrex/ts-plugin test
```

Three phases: vitest runs the `*.test.ts` unit suites
(`classify-references.test.ts`, `jsx-tags.test.ts`,
`hint-text.test.ts`), the package builds
its CJS bundle, and `node test/integration.mjs` spawns a real
tsserver subprocess and exercises the LSP protocol against it.
The integration harness is the acceptance-level definition of "the
plugin works." `src/plugin.test.mjs` is a manual smoke test outside
this loop — run it separately if you want a quick post-build
shape check.

## Related context

- Root [`AGENTS.md`](../../AGENTS.md) — the "JSX syntax, not JSX
  semantics" framing this plugin enforces
- [`verrex`](../core/src/runtime/AGENTS.md) — the `_tag/_props/_children`
  and `_name` parameter naming
- [`@verrex/core/compiler`](../core/src/compiler/AGENTS.md) — the source-location
  preservation that the source map depends on
- [`@verrex/core/language`](../core/src/language/AGENTS.md) — the shared Volar
  language plugin that does the heavy lifting
