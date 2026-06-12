# `@verrex/core/compiler` — `.vx` → plain TypeScript

Single Babel transform. Takes `.vx` source (TypeScript with
angle-bracket `<div>...</div>` syntax — JSX-shape only, no JSX
semantics; see root [AGENTS.md](../../../../AGENTS.md)) and emits plain
TypeScript with every `<...>` expression rewritten as a call:
intrinsic elements become `h(tag, props, ...children)`, component tags
become DIRECT calls (`MyComp({ ...attrs, children: [...] })` — see
"Tag dispatch"). The output contains zero angle brackets — they are
gone before tsc, Vite, or any other downstream tool sees the file.

Entry point: `transformVerrex(source, filename) → { code, map, jsxRanges, mappings }`.

- `code` — compiled TypeScript output.
- `map` — Babel V3 source map. Used by `@verrex/core/vite` for HMR /
  dev-server source maps.
- `jsxRanges` — source-side metadata about each `JSXElement` /
  `JSXFragment` (opening/closing tag positions). Used by
  `@verrex/ts-plugin/src/jsx-tags.ts` for `<Foo>` ↔ `</Foo>` document
  highlights.
- `mappings` — `CompilerMapping[]`: typed source↔generated spans
  with explicit lengths on both sides and a `kind` tag (`"user"` /
  `"h-call"` / `"punctuation"`). Built by `computeMappings` in
  `source-map.ts`. This is the single source of truth for
  position translation; `@verrex/core/language` translates it directly into
  Volar's `Mapping<CodeInformation>[]` without touching `map` or
  `jsxRanges`. See "Source-map mappings" below.

## Why Babel, not tsc/swc

We need a parser that recognizes the angle-bracket source shape
but emits TypeScript with no trace of it left — because tsc's JSX
type-checker collapses generics to `JSX.Element` and erases the
`E`/`R` channel type variables that are the whole point. Babel's
`jsx` plugin (in combination with `typescript`) parses the shape
into a typed AST (`JSXElement`, `JSXFragment`, `JSXExpressionContainer`
node types — these are Babel-internal AST node names, not anything
that survives into our output); our transform rewrites those nodes
to plain `CallExpression`s before `generate()` produces output.
swc was rejected for weaker plugin ergonomics on this kind of
local AST rewrite.

## The three rewrites

Every JSX expression `{...}` triggers up to three local rewrites:

1. **Wrap in `h.track(() => ...)`** — *only if a `.value` read got
   rewritten*. See `wrapTracked` + `rewroteRead` flag in `transform.ts`.
   This is load-bearing: `h.track`'s return is `unknown`, which would
   destroy the typing of static expressions like
   `<Row item={item} />` (where `item` is a generic `T`). Static
   passes through with no wrap. The `.value.map → list(...)` rewrite
   (#3) also does **not** trigger a wrap — `list()` subscribes inside
   `mount`, so wrapping in `h.track` would be a redundant layer. Same
   for `Async(...)`, `Catch(...)`, and `streamRef(...)` calls
   (`isSelfTrackingCall`): all must reach the `h()` fold un-erased —
   `Async`/`Catch` self-track; for `streamRef` a tracked re-run would
   additionally spawn a fresh stream per dep change.

2. **`x.value` → `h.read(x)`** inside the wrapped expression. Tracks
   AtomRef reads. (The *same* read rewrite also runs over the whole
   component body in a separate pass — see "Whole-body `.value` reads"
   below — so reads in statements/extracted thunks track too. Both
   share `rewriteValueRead` in `transform.ts`.) Left bare on any **write
   or binding target** — see `isWriteTarget`, which covers the closed set
   of LVal positions: assignment LHS (`x.value = …`, `x.value += …`),
   update (`x.value++`, `--x.value`), `delete x.value`, destructuring
   targets (`[x.value] = …`, `({k: x.value} = …)`, `[...x.value] = …`),
   and `for (x.value of/in …)`. The bare fallback exists so the emitted
   JS stays well-formed: `h.read(x)++` / `[h.read(x)] = …` would be
   invalid, and `for (h.read(x) of …)` would even crash Babel's AST
   validator (`ForOfStatement.left` rejects a `CallExpression`). Read
   sub-positions that only *look* write-adjacent are still rewritten — an
   assignment's RHS, an `AssignmentPattern` default (`[a = x.value]`), a
   computed pattern key, and the iterable of a `for…of`
   (`for (a of x.value)`). The compiler intentionally does not raise its
   own diagnostic for `.value++` on an AtomRef: TypeScript already
   surfaces `ts(2540) Cannot assign to 'value' because it is a
   read-only property` at the right column for `=`, `+=`, `++`, and
   `--`, which is the familiar idiomatic error. The right idiom is
   `ref.update(v => v + 1)`.

   **Destructuring blind spot.** The rewrite matches `MemberExpression`
   shapes only, so `const { value } = ref` inside a JSX expression is
   *not* rewritten — `value` is a bare identifier coming out of a
   `VariableDeclarator`, the AtomRef read happens silently at
   destructuring time, and reactivity tracking never sees it. The
   user's render won't update on `ref` change. Document `.value`
   reads as the idiom; don't extend the rewrite to destructuring
   without thinking through the alias-tracking ramifications.

3. **`<expr>.value.map(arrow → JSX)` → `list(<expr>, arrow)`** —
   keyed reactive iteration. Caught before the bare `.value` rewrite
   so the `.value` doesn't get turned into an `h.read` we'd then have
   to undo. The arrow body must syntactically be a JSX node (direct
   `item => <Row/>` or `item => <></>`) or a block whose only statement
   is `return <JSX/>` — anything else (`.value.map(item => item.text)`,
   `.value.map(Component)`) is left as a plain `.map` and the outer
   `.value` is rewritten normally.

   The rewrite is purely structural; it fires whenever the shape
   matches, without consulting types. If `<expr>` isn't actually a
   `Collection<T>`, the emitted `list(<expr>, arrow)` call fails to
   type-check with a diagnostic like
   `Argument of type 'X[]' is not assignable to parameter of type 'Collection<...>'`,
   pointing at the source `<expr>.value.map(...)` site. That's the
   intended user-facing signal — there's no way to do a type-aware
   Babel pass.

   After the rewrite, `path.skip()` halts the inner traversal so it
   doesn't descend into the new list's arrow body. `.value` reads
   inside the arrow are part of inner JSX expressions and will get
   their own `h.track` wrap when the outer `JSXElement` visitor in
   `transformVerrex` reaches them. Pre-emptively rewriting them here
   would (a) wrap this `list(...)` in a redundant `h.track`, and (b)
   strand the resulting `h.read` outside any active tracking scope.

**No test-position magic.** Bare identifiers in `cond ? A : B`,
`a && b`, `!x` positions are **not** rewritten. Users must write
`.value` explicitly — that keeps the types honest
(`ref.value: boolean`, not `AtomRef<boolean>`) and avoids surprising
reads where none looked syntactically present: an implicit unwrap would
diverge from the type TS assigns at the source site.

## Whole-body `.value` reads

After the JSX pass, a third `traverse(ast, …)` over the **live** AST
rewrites every *surviving* `obj.value` read — the ones in statements,
helpers, and **extracted `Async` thunks** — to `h.read(obj)` (via the
same `rewriteValueRead` helper, so the write-guards are identical). This
closes the gap where a thunk lifted out of an `Async(...)` call site
(`const get = () => http.getUser(userId.value)`) silently stopped
tracking: it now tracks identically to the inline form.

Why this is safe **without** any compile-time "is `obj` an AtomRef?"
analysis — the key design decision:

- `h.read` is a **faithful, transparent wrapper** for `.value`: for any
  non-AtomRef it is byte-for-byte `obj.value`; for a branded AtomRef it
  *additionally* records a dep iff a tracker is active (exact wrapper
  semantics live in [runtime AGENTS.md](../runtime/AGENTS.md)).
  So emitting `h.read` for *every* `.value` read
  is sound; the runtime `isAtomRef` brand check is the only gate, and
  it's **exact** — it handles aliased imports, extracted refs,
  service-returned refs, and dynamic indirection that no syntactic
  binding analysis could. (This is the Vue model: the tracking lives in
  the read primitive, not in a compile-time graph. verrex routes `.value`
  through `h.read` only because Effect's `AtomRef.value` getter is inert
  and can't self-track.)
- **Ordering matters.** The body pass runs *after* the JSX pass, so JSX
  `.value` reads are already `h.read(...)` calls (callee property `read`,
  not `value`) and cannot be double-rewritten. The body pass only ever
  sees reads the JSX pass left behind.
- **No `h.track` wrap in this pass.** Eager statement reads
  (`const x = ref.value`) stay one-time reads — auto-deriving them would
  be the implicit-infection model Vue retracted (Reactivity Transform)
  and Svelte/Solid reject. Tracking activates only when the read
  *executes* under a tracker: an `Async` thunk (run under `trackDeps`) or
  a JSX `h.track` scope. A statement read outside any tracker is just
  `.value`.

Opt-out of tracking has no dedicated helper yet: read outside a tracking
scope, or (future) a small `untrack`-style wrapper. Optional chaining
(`obj?.value`, an `OptionalMemberExpression`) is never matched, so it is
left as-is and does not track.

The same traversal carries the Component-name injection visitor (next
section) — an independent rewrite riding along to avoid a fourth pass.

## Component-name injection

The whole-body pass also rewrites
`const Counter = Component.make(fn)` → `Component.make(fn, "Counter")`,
injecting the *declared* name as the span name so users don't repeat the
export name (`matchNamelessComponentMake` + the `VariableDeclarator`
visitor in `transformVerrex`). Deliberately narrow and additive:

- Fires only on the exact callee shape `Component.make` with exactly one
  argument, bound by a plain identifier declarator (`const X = …`,
  exported or not). A second argument already present (an explicit name)
  is left alone.
- Matched by name, like `isSelfTrackingCall` — an aliased import
  (`import { Component as C }`) defeats it, which **fails soft**: the
  component still works, its span is just anonymous. No diagnostic.
- `Component` is NOT auto-imported (it only appears in this rewrite when
  the user already wrote the call, so they already import it).

## Auto-injected imports

If any JSX rewrote to an `h()` call **or** the whole-body pass emitted any
`h.read(...)`, the transform ensures `import { h } from "@verrex/core"`
exists (tracked via `usedH || usedHRead` in `transformVerrex`). `Fragment`
is added when `<>...</>` is used. `list` is added when the
`.value.map → list(...)` rewrite fires. `ensureRuntimeImports` finds an
existing import from `verrex` and appends to it; otherwise it
prepends a new declaration. Names already imported under their own
identifier (no alias) are skipped to avoid duplicates.

## Tag dispatch

- Lowercase identifier → intrinsic: `<div>` → `h("div", props, ...children)`
- `JSXNamespacedName` → intrinsic: `<svg:rect>` → `h("svg:rect", ...)`
- Uppercase identifier → DIRECT call (`isComponentTag`):
  `<Counter/>` → `Counter()` (zero-arg when no attrs and no children, so
  propless `function* ()` components typecheck);
  `<Foo bar={1}>kid</Foo>` → `Foo({ bar: 1, children: [...] })`
- `JSXMemberExpression` → direct call regardless of case
  (`<X.Y>` → `X.Y({...})` — components by JSX convention)
- Fragment (`<>`) → `Fragment({ children: [...] })` — `Fragment` is itself a
  direct-call component (generic over the children tuple, coerces raw
  children; see runtime AGENTS.md)

The direct-call lowering (#71) is why generic components keep their type
parameter at JSX call sites and why the `Tag*` fold families no longer
exist — a component's channels are just its call's Effect type, folding
into the surrounding `h()` as an ordinary child. Children pass RAW in the
`children` array prop (coercion happens where the component embeds them);
JSX children win over an explicit `children={...}` attr (React semantics
— and a duplicate literal key would be a TS error in the emitted object).
Consequence for imports: `h` is auto-imported per-emission (an intrinsic
element, an `h.track` wrap, or an `h.read` rewrite) — a component-only
file imports nothing.

## JSX text whitespace

`transformChild` runs JSX text through `cleanJsxText`, a faithful port
of Babel's `cleanJSXElementLiteralChild`: tabs → spaces, leading spaces
trimmed on every line but the first, trailing spaces on every line but
the last, blank lines dropped, surviving lines joined with a single
space. Pure-whitespace nodes drop.

The subtlety that bit us: a newline *between two words* must collapse to
one space, not to nothing — otherwise multi-line prose renders
`whosepoint`. Whitespace adjacent to an element/expression
boundary still trims to nothing, so — exactly as in React — a tag on its
own line concatenates with neighbouring text unless the source adds an
explicit `{" "}`.

(Watch the JSDoc on `cleanJsxText`: don't write the literal
newline-stripping regex inside a block comment — the `*` `/` it contains
closes the comment early. The function comment spells the rule out in
prose for that reason.)

## Babel ESM gotcha

`@babel/traverse` and `@babel/generator` ship CJS-default-export.
In ESM the actual function lives on `.default`. The
`traverse`/`generate` consts at the top of `transform.ts` resolve
this for both module shapes — don't simplify them without testing
under ESM consumption.

## Source location preservation

`copyLoc(target, source)` propagates `loc`/`start`/`end` from JSX
AST nodes onto the emitted `h(...)` call's pieces. Applied at:

- `tagExpression` — the string literal / identifier replacing the
  JSX tag name (`<Counter>` → `Counter` identifier, with its
  source location intact).
- `jsxMemberToMember` — every node in a `<X.Y.Z>` chain.

This is **load-bearing for the TS plugin's go-to-definition**.
Babel's source map otherwise collapses to the start of each JSX
expression, and clicking on `<UserPage userId="42" />` lands you
on the `<` instead of the `UserPage` identifier. The TS plugin's
Volar mappings derive directly from this map.

If you add a new node kind to the emit (e.g., a future
`h.something(...)` call from a new compiler rewrite), wrap its
constructors in `copyLoc` against the source node they replace.

## `jsxRanges` — source-side metadata for tag-pair matching

Alongside `code`, `map`, and `mappings`, the transform emits one
`JsxRange` per `JSXElement` / `JSXFragment` the parser saw, in
source order (pre-order: outer before nested). Each range carries:

- `start` / `end` — the full node span (`<div>...</div>`)
- `openingTag.start` / `.end` — the `<...>` part
- `openingTag.nameStart` / `.nameEnd` — just the tag name span
  (covers dotted names: `<Foo.Bar>` → name is `Foo.Bar`)
- `closingTag` — same shape, omitted when `isSelfClosing`
- Fragments (`kind: "fragment"`) have no name positions; their
  `openingTag` is `<>`, `closingTag` is `</>`

This exists so consumers (today: `@verrex/ts-plugin/src/jsx-tags.ts`)
don't have to re-discover JSX structure by regex-scanning the
source. The Babel AST already knows these positions; we report
them. Anti-pattern: anywhere in the workspace running a JSX-shaped
regex against `.vx` content — consume `jsxRanges` instead.

`jsxRanges` is ALSO used internally by `computeMappings` to
classify each source position as `"user"` / `"h-call"` /
`"punctuation"` — but external consumers should reach for
`mappings` (which has the classification baked in) over rebuilding
that classifier from `jsxRanges`.

## Source-map mappings — typed source↔generated spans

`computeMappings(map, source, generated, jsxRanges)` in
`source-map.ts` produces the `mappings` array. The algorithm
in five steps:

1. Decode Babel's V3 mappings into `(genOffset, srcOffset, srcChar)`
   segments via `@jridgewell/sourcemap-codec`.
2. Dedupe by source offset (first segment wins) — Babel sometimes
   emits multiple generated points for the same source point.
3. Compute source-side spans by sorting segments by source offset
   and taking consecutive differences.
4. Compute generated-side spans by sorting INDEPENDENTLY by
   generated offset and taking differences. Source and generated
   spans **can differ** because Babel transforms shift byte counts:
   - `(n) =>` → `n =>` (single-arg arrow paren strip): source `((`
     of 2 chars maps to generated `(` of 1 char.
   - `x.value` → `h.read(x)`: source 7 chars → generated 9 chars.
   - `<div>...</div>` → `h("div", ..., ...)`: source 5 chars
     (opening tag) → generated 8+ chars.
5. Classify each mapping's `kind` via `jsxRanges` intersection:
   - JSX angle bracket `<` / `>` / `/` inside an opening or closing
     tag span → `"punctuation"` (no semantic, no navigation —
     cursor on `<` shouldn't jump into `h.ts`).
   - Inside any JSX node range → `"h-call"` (semantic features kept
     but highlight suppressed — cursor on a tag name shouldn't
     highlight every `h` identifier).
   - Otherwise → `"user"` (full features).

The lengths-on-both-sides design is **load-bearing**: tracking only
source lengths makes inlay-hint positions drift one column left
(`( : numbern)` instead of `(n: number)`). `source-map.test.ts` pins
the exact `(source: 2, generated: 1)` shape.

`@verrex/core/language` uses `mappings` directly and never re-decodes the
Babel source map. The bidirectional length asymmetry is captured
once, here, in the compiler.

## Tests

`transform.test.ts` — 28 cases via `vitest`. Coverage includes:
each rewrite category, wrap-skip when nothing rewrote, import
injection / dedup, JSX whitespace, tag dispatch shapes, spread
attributes, source maps. Run with `pnpm --filter @verrex/core test`.

## What this package does NOT do

- No type checking. That's tsc's job (post-transform).
- No reactivity wiring. `h.track`/`read` live in `verrex`;
  the compiler only emits *calls* to them.
- No `CodeInformation` profile assignment. The compiler classifies
  each span as `"user"` / `"h-call"` / `"punctuation"` (a
  Volar-free taxonomy); `@verrex/core/language` translates kind → Volar
  `CodeInformation`. Keeps the compiler Volar-agnostic.
- No file watching, no caching. Pure function of `(source, filename)`.
  Callers cache.

## Parse-error tolerance

`@babel/parser` runs with `errorRecovery: true`. The editor calls
`transformVerrex` on every keystroke; mid-edit source is routinely
unparseable (`count.` with no property name yet). Without recovery,
Babel throws → `createVirtualCode` propagates → Volar has no virtual
code for the file → tsserver returns the project's *global scope*
(999 entries — every DOM ambient declaration) for completion
requests instead of the member list the user expects.

With recovery, Babel emits a partial AST for *recoverable* errors and
attaches them to `ast.errors`. We don't read that array — downstream
`tsc` will surface real errors as diagnostics. But recovery is **not a
no-throw guarantee**: Babel still hard-throws on fatal states, including
the most common mid-edit ones — `count.` at EOF, an unterminated tag
("Unexpected token"), `<div>{x.}</div>`. Recovery only helps when a
following token exists to recover *into* (`x.` followed by `return` parses
as `x.return`). Callers that must survive the hard-throws wrap this call:
the language plugin degrades to the file's last good compile
(`onTransformError: "recover"`, #102). The build path passes
`errorRecovery: false` so a genuine syntax error throws loudly instead of
shipping a recovered/garbage module.

## Anti-patterns

- Don't add a rewrite that fires on composite expressions
  (`x.length`, `arr[0].value`, etc.). The lossy-but-predictable
  "rewrite only bare identifiers / `.value` reads" rule is what
  keeps the system debuggable.
- Don't emit `h.track(...)` unconditionally — generics die.
- Don't auto-import anything except `h`, `Fragment`, and `list`.
  Users manage their own imports.
- Don't depend on `@babel/preset-*`. We use parser + traverse +
  generate directly to keep the bundle small (the ts-plugin ships
  this transform inside its dist).
- Don't remove `errorRecovery: true` from the parser options. See
  "Parse-error tolerance" above — completions silently regress to
  the project global scope without it.
