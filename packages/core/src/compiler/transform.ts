import { parse, type ParserOptions } from "@babel/parser"
import _traverse, { type NodePath } from "@babel/traverse"
import * as t from "@babel/types"
import _generate from "@babel/generator"
import { computeMappings, type CompilerMapping } from "./source-map.ts"

// Babel's traverse/generate ship as CJS-default-export; in ESM contexts that
// surfaces as the actual function on `.default`.
const traverse: typeof _traverse =
  (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse
const generate: typeof _generate =
  (_generate as unknown as { default: typeof _generate }).default ?? _generate

export interface TransformOptions {
  /**
   * Whether Babel recovers from parse errors (emitting a partial AST) instead
   * of throwing. Defaults to `true` for the editor/language-service path,
   * which transforms routinely-unparseable mid-edit source. The build path
   * (`verrex/vite`) passes `false` so a real syntax error fails loudly —
   * a Vite error overlay in dev, a failed build in CI — rather than silently
   * shipping a recovered module.
   */
  readonly errorRecovery?: boolean
}

export interface TransformResult {
  readonly code: string
  readonly map: object | null
  readonly jsxRanges: ReadonlyArray<JsxRange>
  /**
   * Typed source↔generated mappings with explicit lengths on both sides and a
   * kind classification for each span. Computed from `map` + `jsxRanges`;
   * consumers should prefer this over re-processing the Babel source map.
   *
   * See `CompilerMapping` for the shape and `computeMappings` for the
   * algorithm.
   */
  readonly mappings: ReadonlyArray<CompilerMapping>
}

/** Source-side span. All offsets are 0-based byte indices into the original `.vx` source. */
export interface TagPosition {
  readonly start: number
  readonly end: number
}

/** Tag span carrying the name sub-range — `<Foo`'s "Foo" lives at `nameStart..nameEnd`. */
export interface NamedTagPosition extends TagPosition {
  readonly nameStart: number
  readonly nameEnd: number
}

/** A `<Tag>...</Tag>` (or `<Tag />`) range. `closingTag` is `undefined` when `isSelfClosing`. */
export interface JsxElementRange {
  readonly kind: "element"
  readonly start: number
  readonly end: number
  readonly isSelfClosing: boolean
  readonly openingTag: NamedTagPosition
  readonly closingTag?: NamedTagPosition
}

/** A `<>...</>` fragment range. Tags have no name positions. */
export interface JsxFragmentRange {
  readonly kind: "fragment"
  readonly start: number
  readonly end: number
  readonly openingTag: TagPosition
  readonly closingTag: TagPosition
}

/**
 * Source-side metadata about a JSX node the compiler rewrote into an `h()` call.
 * Emitted in pre-order: outermost node first, then nested children in source order.
 *
 * Consumed by `@verrex/ts-plugin` to identify "inside-h()" positions, JSX punctuation,
 * and tag-pair partners without re-parsing the source or scanning the compiled
 * output with regex. The producer (Babel AST) has the exact positions; we report
 * them so consumers don't have to recover them.
 */
export type JsxRange = JsxElementRange | JsxFragmentRange

const PARSER_OPTIONS: ParserOptions = {
  sourceType: "module",
  plugins: ["typescript", "jsx"],
}

/**
 * Convert a JSX attribute name to an object-property key.
 * JSX allows `data-foo` and `aria-bar` — wrap those in string literals.
 */
const attrName = (id: t.JSXIdentifier | t.JSXNamespacedName): t.Identifier | t.StringLiteral => {
  if (t.isJSXNamespacedName(id)) {
    return t.stringLiteral(`${id.namespace.name}:${id.name.name}`)
  }
  return /^[A-Za-z_$][\w$]*$/.test(id.name)
    ? t.identifier(id.name)
    : t.stringLiteral(id.name)
}

/**
 * Per-call mutable state, threaded through every helper that may emit a
 * runtime call. `transformVerrex` creates a fresh instance and reads the
 * flags at the end to decide which runtime imports to auto-inject. `usedH`
 * is per-emission (an intrinsic `h(...)`, an `h.track` wrap, or an
 * `h.read` rewrite) — a file whose JSX is all component tags emits direct
 * calls and needs no `h` at all.
 */
interface RewriteState {
  wroteList: boolean
  usedH: boolean
  usedFragment: boolean
}

/**
 * True when `expr` is a top-level call to an effectful primitive whose call
 * must never be `h.track`-wrapped — `Async(...)`, `Catch(...)`, or
 * `streamRef(...)`. All return an `Effect` that must reach the `h()` fold
 * intact; `h.track` is typed `(thunk) => unknown`, which erases the channels
 * and drops them from the fold. `Async`/`Catch` additionally manage their own
 * reactivity (`Async` tracks its `from` thunk; `Catch` drives its state from
 * a forked loop), so the wrap is redundant for them; for `streamRef` it would
 * be actively wrong twice over — beyond the erasure, re-running the thunk on
 * a dep change would *spawn a fresh stream* per change. Same reason
 * `.value.map(...)` → `list(...)` is left unwrapped. The inner `.value` reads
 * are still rewritten to `h.read` (e.g. a `.value` read in a `Catch` fallback
 * or an `Async` thunk).
 *
 * Matched purely by callee name (the compiler has no types). So
 * `import { Async as A }` defeats the skip — `A(...)` would be wrongly
 * `h.track`-wrapped and lose its channels (a loud type error at the call site).
 * Import these unaliased.
 */
const SELF_TRACKING_HELPERS: ReadonlySet<string> = new Set(["Async", "Catch", "streamRef"])
const isSelfTrackingCall = (expr: t.Expression): boolean =>
  t.isCallExpression(expr) &&
  t.isIdentifier(expr.callee) &&
  SELF_TRACKING_HELPERS.has(expr.callee.name)

/**
 * Wrap a JSX-expression's value in a `h.track(() => expr)` call **only when
 * a `.value` read was found**. Static expressions like `{item}` or `{"hello"}`
 * pass through unchanged so their TypeScript type is preserved — h.track's
 * return is `unknown`, which would otherwise destroy the typing of component
 * props (`<Row item={item} />`, the prop's `item` type).
 *
 * Two rewrites are deliberately NOT wrapped, because they self-subscribe and
 * wrapping would erase their channels:
 *   - `.value.map(arrow → JSX)` → `list(...)` (flips `state.wroteList` for the
 *     `list` auto-import; subscribes inside `mount`).
 *   - `Async(() => …, arms)` and `Catch(child, …)` calls — these
 *     self-track (see `isSelfTrackingCall`).
 */
const wrapTracked = (expr: t.Expression, state: RewriteState): t.Expression => {
  const { expr: rewritten, rewroteRead } = rewriteTrackedExpression(expr, state)
  if (!rewroteRead) return rewritten
  state.usedH = true // the rewrite emitted h.read (and below, possibly h.track)
  // Async / Catch self-track; the `.value`→`h.read` rewrite inside them is
  // kept, but the outer `h.track` wrap is skipped so their channels survive the fold.
  if (isSelfTrackingCall(rewritten)) return rewritten
  return t.callExpression(
    t.memberExpression(t.identifier("h"), t.identifier("track")),
    [t.arrowFunctionExpression([], rewritten)],
  )
}

const hRead = (): t.MemberExpression =>
  t.memberExpression(t.identifier("h"), t.identifier("read"))

/**
 * True when an `obj.value` member sits in a write / binding-target position, so
 * it must be left bare. Rewriting a write target to `h.read(obj)` would emit
 * invalid JS (`[h.read(obj)] = …` — assignment to a call) or, for
 * `for (obj.value of …)`, crash Babel's AST validator (`ForOfStatement.left`
 * rejects a `CallExpression`). Covers every LVal shape:
 *
 *   obj.value = …      obj.value++ / --obj.value     delete obj.value
 *   [obj.value] = …    ({ k: obj.value } = …)        for (obj.value of/in …)
 *   [obj.value = d] = …    [...obj.value] = …
 *
 * The set of LVal positions is closed, so this is exhaustive. It climbs through
 * destructuring connectors (`RestElement`, `AssignmentPattern.left`,
 * `ObjectProperty.value`), and reaching an `ArrayPattern`/`ObjectPattern` — node
 * types that exist *only* in target positions — confirms a write. Read
 * sub-positions are distinguished: a computed pattern key (`{[obj.value]: x}`),
 * an `AssignmentPattern` default (`[a = obj.value]`), the `.right` of an
 * assignment, and the iterable of a `for…of` (`for (x of obj.value)`) all read.
 * Any ordinary expression parent means it's a read.
 */
const isWriteTarget = (path: NodePath<t.MemberExpression>): boolean => {
  let cur: NodePath = path
  let parent: NodePath | null = path.parentPath
  while (parent) {
    const pn = parent.node
    const cn = cur.node
    if (t.isAssignmentExpression(pn)) return pn.left === cn
    if (t.isUpdateExpression(pn)) return pn.argument === cn
    if (t.isUnaryExpression(pn) && pn.operator === "delete") return pn.argument === cn
    if (t.isForOfStatement(pn) || t.isForInStatement(pn)) return pn.left === cn
    if (t.isArrayPattern(pn) || t.isObjectPattern(pn)) return true
    // Connectors — climb only via their target sub-position.
    if (t.isRestElement(pn) && pn.argument === cn) { cur = parent; parent = parent.parentPath; continue }
    if (t.isAssignmentPattern(pn) && pn.left === cn) { cur = parent; parent = parent.parentPath; continue }
    if (t.isObjectProperty(pn) && pn.value === cn) { cur = parent; parent = parent.parentPath; continue }
    return false
  }
  return false
}

/**
 * Rewrite a single `obj.value` member *read* to `h.read(obj)`, returning whether
 * it rewrote. Shared by the JSX-expression rewrite (`rewriteTrackedExpression`)
 * and the whole-body pass (`transformVerrex` pass 3) so both apply identical rules:
 *
 *   - Only non-computed `.value` reads. `obj["value"]` and other properties pass.
 *   - Writes/binding targets are left bare (see `isWriteTarget`). For an AtomRef
 *     the bare write also surfaces TypeScript's own `ts(2540) Cannot assign to
 *     'value' … read-only` at the right column — no custom diagnostic needed.
 *   - Optional chaining (`obj?.value`) is a different node type
 *     (`OptionalMemberExpression`), so it is never matched here — left as-is.
 *
 * Detection of *what actually tracks* is deferred to runtime: `h.read` is a
 * faithful passthrough that records a dependency only for branded AtomRefs under
 * an active tracker (see `readImpl` in `verrex`). So this rewrite needs no
 * compile-time "is this an AtomRef?" analysis — it routes every `.value` read
 * through the one exact gate. `copyLoc` keeps the emitted call mapped to the
 * original `.value` span (matters for statement reads, which no `jsxRange`
 * covers).
 */
const rewriteValueRead = (path: NodePath<t.MemberExpression>): boolean => {
  const n = path.node
  if (n.computed) return false
  if (!t.isIdentifier(n.property)) return false
  if (n.property.name !== "value") return false
  if (isWriteTarget(path)) return false
  path.replaceWith(copyLoc(t.callExpression(hRead(), [n.object as t.Expression]), n))
  return true
}

/**
 * Match `Component.make(<single arg>)` — the one call-site shape the
 * component-name injection rewrites. Matched purely by callee shape (the
 * compiler has no types), so `import { Component as C }` defeats it — which
 * fails soft: the wrapped component loses its named span (anonymous
 * `Effect.fn` adds no span, only stack frames). A call that
 * already carries a second argument (an explicit name) is left alone.
 */
const matchNamelessComponentMake = (node: t.Node): t.CallExpression | null =>
  t.isCallExpression(node) &&
    node.arguments.length === 1 &&
    t.isMemberExpression(node.callee) &&
    !node.callee.computed &&
    t.isIdentifier(node.callee.object, { name: "Component" }) &&
    t.isIdentifier(node.callee.property, { name: "make" })
    ? node
    : null

/**
 * True when an arrow body is a JSX expression — either directly
 * (`item => <Row/>`) or via a block whose only statement is `return <JSX/>`
 * (`item => { return <Row/> }`).
 */
const isJsxArrowBody = (body: t.BlockStatement | t.Expression): boolean => {
  if (t.isJSXElement(body) || t.isJSXFragment(body)) return true
  if (t.isBlockStatement(body) && body.body.length === 1) {
    const stmt = body.body[0]
    if (t.isReturnStatement(stmt) && stmt.argument) {
      return t.isJSXElement(stmt.argument) || t.isJSXFragment(stmt.argument)
    }
  }
  return false
}

/**
 * Match `<expr>.value.map(<arrow>)` exactly. The arrow's JSX-ness is checked
 * separately by `isJsxArrowBody` — this just confirms the call shape.
 */
const matchValueMapCall = (
  node: t.CallExpression,
): { source: t.Expression; arrow: t.ArrowFunctionExpression } | null => {
  if (!t.isMemberExpression(node.callee) || node.callee.computed) return null
  if (!t.isIdentifier(node.callee.property, { name: "map" })) return null
  const valueAccess = node.callee.object
  if (!t.isMemberExpression(valueAccess) || valueAccess.computed) return null
  if (!t.isIdentifier(valueAccess.property, { name: "value" })) return null
  if (node.arguments.length !== 1) return null
  const arg = node.arguments[0]
  if (!t.isArrowFunctionExpression(arg)) return null
  if (!isJsxArrowBody(arg.body)) return null
  if (t.isSuper(valueAccess.object)) return null
  return { source: valueAccess.object, arrow: arg }
}

/**
 * In-place AST rewrites inside a tracked JSX expression:
 *
 *   - `<expr>.value.map(arrow → JSX)` → `list(<expr>, arrow)` — keyed
 *     reactive iteration. Caught before the bare `.value` rewrite so the
 *     `.value` doesn't get turned into an `h.read` we'd then have to undo.
 *     Flips `state.wroteList` so `transformVerrex` adds the import, then
 *     `path.skip()`s the new list's children: any `.value` reads inside the
 *     arrow body belong to inner JSX expressions and will get their own
 *     `h.track` wrap when the outer JSX traversal reaches them. Descending
 *     here would (a) wrap this `list(...)` in a redundant `h.track`, and
 *     (b) strand the inner `h.read` calls outside any active tracking scope.
 *   - `x.value` (read) → `h.read(x)` — tracks AtomRef reads via `.value`.
 *     Sets local `rewroteRead`, which triggers the surrounding `h.track`
 *     wrap in `wrapTracked`.
 */
const rewriteTrackedExpression = (
  expr: t.Expression,
  state: RewriteState,
): { expr: t.Expression; rewroteRead: boolean } => {
  const file = t.file(t.program([t.expressionStatement(expr)]))
  let rewroteRead = false
  traverse(file, {
    CallExpression(path) {
      const matched = matchValueMapCall(path.node)
      if (!matched) return
      const newCall = t.callExpression(t.identifier("list"), [matched.source, matched.arrow])
      path.replaceWith(copyLoc(newCall, path.node))
      state.wroteList = true
      path.skip()
    },
    MemberExpression(path) {
      if (rewriteValueRead(path)) rewroteRead = true
    },
  })
  return {
    expr: (file.program.body[0] as t.ExpressionStatement).expression,
    rewroteRead,
  }
}

/** Build the props object from JSX attributes. */
const buildProps = (
  attrs: ReadonlyArray<t.JSXAttribute | t.JSXSpreadAttribute>,
  state: RewriteState,
): t.Expression => {
  const properties: Array<t.ObjectProperty | t.SpreadElement> = []
  for (const attr of attrs) {
    if (t.isJSXSpreadAttribute(attr)) {
      properties.push(t.spreadElement(attr.argument))
      continue
    }
    const key = attrName(attr.name)
    let value: t.Expression
    if (attr.value == null) {
      value = t.booleanLiteral(true)
    } else if (t.isStringLiteral(attr.value)) {
      value = attr.value
    } else if (t.isJSXExpressionContainer(attr.value)) {
      value = t.isJSXEmptyExpression(attr.value.expression)
        ? t.booleanLiteral(true)
        : wrapTracked(attr.value.expression, state)
    } else {
      // JSXElement/JSXFragment values are exotic — fall back to recursive transform
      value = transformJsxNode(attr.value as t.JSXElement | t.JSXFragment, state)
    }
    properties.push(
      t.objectProperty(
        key,
        value,
        t.isStringLiteral(key) /* computed when string-keyed */,
      ),
    )
  }
  return t.objectExpression(properties)
}

/** Copy source location from one node to another for source map accuracy. */
const copyLoc = <T extends t.Node>(target: T, source: t.Node): T => {
  if (source.loc) {
    target.loc = source.loc
  }
  const srcStart = (source as { start?: number | null }).start
  const srcEnd = (source as { end?: number | null }).end
  if (typeof srcStart === "number") {
    ;(target as { start?: number | null }).start = srcStart
  }
  if (typeof srcEnd === "number") {
    ;(target as { end?: number | null }).end = srcEnd
  }
  return target
}

/**
 * The single source of truth for the tag-dispatch rule: a lowercase first
 * letter means intrinsic element. Used by `tagExpression` (string literal vs
 * identifier) and `isComponentTag` (h() vs direct call) — keep it one
 * predicate so the two can't drift.
 */
const isIntrinsicName = (name: string): boolean => /^[a-z]/.test(name)

/** Decide the tag expression: lowercase → string literal, otherwise identifier. */
const tagExpression = (name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): t.Expression => {
  if (t.isJSXNamespacedName(name)) {
    const lit = t.stringLiteral(`${name.namespace.name}:${name.name.name}`)
    return copyLoc(lit, name)
  }
  if (t.isJSXMemberExpression(name)) {
    return jsxMemberToMember(name)
  }
  // JSXIdentifier - preserve location for go-to-definition
  const lower = isIntrinsicName(name.name)
  const expr = lower ? t.stringLiteral(name.name) : t.identifier(name.name)
  return copyLoc(expr, name)
}

const jsxMemberToMember = (m: t.JSXMemberExpression): t.MemberExpression => {
  const object = t.isJSXMemberExpression(m.object)
    ? jsxMemberToMember(m.object)
    : copyLoc(t.identifier(m.object.name), m.object)
  const property = copyLoc(t.identifier(m.property.name), m.property)
  return copyLoc(t.memberExpression(object, property), m)
}

/**
 * Collapse JSX text whitespace per the JSX spec — a faithful port of Babel's
 * `cleanJSXElementLiteralChild`. Tabs become spaces; leading spaces are trimmed
 * on every line but the first, trailing spaces on every line but the last;
 * blank lines drop; surviving lines join with a single space.
 *
 * The load-bearing difference from the old newline-stripping regex: a newline
 * between two words collapses to one space, not to nothing — so multi-line prose
 * reads "whose point" instead of "whosepoint". Whitespace adjacent to an
 * element/expression boundary still trims to nothing, so (exactly as in React)
 * a tag on its own line concatenates unless the source adds an explicit space.
 */
const cleanJsxText = (value: string): string => {
  const lines = value.split(/\r\n|\n|\r/)
  let lastNonEmpty = 0
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i]!)) lastNonEmpty = i
  }
  let out = ""
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\t/g, " ")
    if (i !== 0) line = line.replace(/^ +/, "")
    if (i !== lines.length - 1) line = line.replace(/ +$/, "")
    if (line === "") continue
    out += i !== lastNonEmpty ? line + " " : line
  }
  return out
}

/** Transform a single JSX child node into an expression. */
const transformChild = (
  child: t.JSXElement["children"][number],
  state: RewriteState,
): t.Expression | t.SpreadElement | null => {
  if (t.isJSXText(child)) {
    const text = cleanJsxText(child.value)
    if (text === "") return null
    return t.stringLiteral(text)
  }
  if (t.isJSXExpressionContainer(child)) {
    return t.isJSXEmptyExpression(child.expression)
      ? null
      : wrapTracked(child.expression, state)
  }
  if (t.isJSXSpreadChild(child)) {
    // `{...items}` expands as individual children (JSX semantics): emit a
    // real SpreadElement — valid both as an `h(...)` call argument and as a
    // `children: [...]` array element. A bare passthrough would land the
    // whole array as ONE child and pick up a redundant Fragment wrapper
    // from coerceAsync's array peel.
    return copyLoc(t.spreadElement(child.expression), child)
  }
  return transformJsxNode(child, state)
}

const RUNTIME_PKG = "@verrex/core"

const ensureRuntimeImports = (program: t.Program, wanted: Set<string>): void => {
  // First pass: find an existing import from the runtime; drop names that
  // are already imported under their own identifier (no `as` alias).
  let existing: t.ImportDeclaration | undefined
  for (const node of program.body) {
    if (!t.isImportDeclaration(node)) continue
    if (node.source.value !== RUNTIME_PKG) continue
    existing = node
    for (const spec of node.specifiers) {
      if (
        t.isImportSpecifier(spec) &&
        t.isIdentifier(spec.imported) &&
        spec.imported.name === spec.local.name
      ) {
        wanted.delete(spec.local.name)
      }
    }
    break
  }

  if (wanted.size === 0) return

  const newSpecs = [...wanted].map((name) =>
    t.importSpecifier(t.identifier(name), t.identifier(name)),
  )

  if (existing) {
    existing.specifiers.push(...newSpecs)
  } else {
    program.body.unshift(
      t.importDeclaration(newSpecs, t.stringLiteral(RUNTIME_PKG)),
    )
  }
}

/**
 * Build a JsxRange from a Babel AST node. Reads `start`/`end` from the parser —
 * always set when the AST came from `@babel/parser` with positions enabled.
 */
const collectJsxRange = (node: t.JSXElement | t.JSXFragment): JsxRange => {
  if (t.isJSXFragment(node)) {
    return {
      kind: "fragment",
      start: node.start!,
      end: node.end!,
      openingTag: {
        start: node.openingFragment.start!,
        end: node.openingFragment.end!,
      },
      closingTag: {
        start: node.closingFragment.start!,
        end: node.closingFragment.end!,
      },
    }
  }
  const opening = node.openingElement
  const closing = node.closingElement
  const base: JsxElementRange = {
    kind: "element",
    start: node.start!,
    end: node.end!,
    isSelfClosing: opening.selfClosing,
    openingTag: {
      start: opening.start!,
      end: opening.end!,
      nameStart: opening.name.start!,
      nameEnd: opening.name.end!,
    },
  }
  if (!closing) return base
  return {
    ...base,
    closingTag: {
      start: closing.start!,
      end: closing.end!,
      nameStart: closing.name.start!,
      nameEnd: closing.name.end!,
    },
  }
}

/**
 * True when the JSX tag names a component (the compiler lowers it to a
 * direct call) rather than an intrinsic element (routed through `h`).
 * Components are capitalized identifiers (`<MyComp/>` — same first-letter
 * rule `tagExpression` uses) and member expressions (`<X.Y/>` — components
 * by JSX convention regardless of case). Namespaced names (`<svg:rect/>`)
 * are intrinsic.
 */
const isComponentTag = (
  name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName,
): boolean =>
  t.isJSXMemberExpression(name) || (t.isJSXIdentifier(name) && !isIntrinsicName(name.name))

/**
 * Transform a JSX element or fragment node into its compiled call:
 *
 *  - intrinsic element → `h("tag", props, ...children)` (unchanged)
 *  - component tag     → direct call: `MyComp({ ...attrs, children: [...] })`,
 *    `MyComp({ ...attrs })`, or `MyComp()` when there are no attrs and no
 *    children (so zero-param components stay callable)
 *  - fragment          → `Fragment({ children: [...] })` (Fragment is itself
 *    a component since #71; it coerces the raw children)
 *
 * Direct calls are what let a generic component's type parameter infer at
 * the call site, and what makes the component's channels fold as an
 * ordinary Effect child of the surrounding `h()` — no `Tag*` fold types.
 * JSX children always win over an explicit `children={...}` attr (React
 * semantics; a duplicate key would also be a TS error in the emitted
 * object literal).
 */
const transformJsxNode = (
  node: t.JSXElement | t.JSXFragment,
  state: RewriteState,
): t.CallExpression => {
  const childArgs: Array<t.Expression | t.SpreadElement> = []
  for (const child of node.children) {
    const transformed = transformChild(child, state)
    if (transformed) childArgs.push(transformed)
  }

  const isFragment = t.isJSXFragment(node)
  if (isFragment || isComponentTag(node.openingElement.name)) {
    const callee: t.Expression = isFragment
      ? copyLoc(t.identifier("Fragment"), node)
      : tagExpression(node.openingElement.name)
    if (isFragment) state.usedFragment = true

    const props = isFragment
      ? t.objectExpression([])
      : (buildProps(node.openingElement.attributes, state) as t.ObjectExpression)
    if (childArgs.length > 0) {
      props.properties = props.properties.filter(
        (p) =>
          !(t.isObjectProperty(p) &&
            (t.isIdentifier(p.key, { name: "children" }) ||
              t.isStringLiteral(p.key, { value: "children" }))),
      )
      props.properties.push(
        t.objectProperty(t.identifier("children"), t.arrayExpression(childArgs)),
      )
    }
    // No attrs, no children → zero-arg call, so propless `function* ()`
    // components typecheck. Fragment always takes its (required) props arg.
    const args = !isFragment && props.properties.length === 0 ? [] : [props]
    return copyLoc(t.callExpression(callee, args), node)
  }

  state.usedH = true
  const tag = tagExpression(node.openingElement.name)
  const props = buildProps(node.openingElement.attributes, state)
  // Preserve location on the h() call for source map accuracy
  const hCall = t.callExpression(t.identifier("h"), [tag, props, ...childArgs])
  return copyLoc(hCall, node)
}

/**
 * Compile `.vx` source (TypeScript + JSX-shape syntax) into plain
 * TypeScript with every JSX node rewritten as an `h()` call.
 *
 * The output is what `tsc` and Vite see — neither ever encounters JSX.
 * TypeScript's JSX type-checker is therefore never engaged; channel
 * propagation comes from `h()`'s generic signature alone.
 */
export const transformVerrex = (
  source: string,
  filename: string,
  options: TransformOptions = {},
): TransformResult => {
  const ast = parse(source, {
    ...PARSER_OPTIONS,
    // The editor/language-service path (default) wants error recovery: it
    // calls this on every keystroke over routinely-unparseable mid-edit
    // source. With recovery Babel emits a partial AST for RECOVERABLE errors
    // and attaches them to `ast.errors` (which we don't read — tsc surfaces
    // the real errors). But recovery is not a no-throw guarantee: Babel still
    // hard-throws on fatal states, including the most common mid-edit ones
    // (`count.` at EOF, an unterminated tag → "Unexpected token"). Callers
    // that must survive those wrap this call — the language plugin degrades
    // to the file's last good compile (`onTransformError: "recover"`). The
    // build path passes `false` so a genuine syntax error throws loudly here
    // instead of silently emitting a recovered/garbage module that the
    // bundler would then ship.
    errorRecovery: options.errorRecovery ?? true,
    sourceFilename: filename,
  })

  // Pre-pass: collect a JsxRange for every JSXElement/JSXFragment in source order.
  // The rewrite pass below uses path.replaceWith, which only visits outermost JSX
  // (nested children get rewritten recursively inside transformJsxNode and are no
  // longer JSX nodes by the time Babel would visit them). Collecting separately
  // beforehand is the cleanest way to see every node.
  const jsxRanges: JsxRange[] = []
  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      jsxRanges.push(collectJsxRange(path.node))
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      jsxRanges.push(collectJsxRange(path.node))
    },
  })

  const state: RewriteState = { wroteList: false, usedH: false, usedFragment: false }

  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      path.replaceWith(transformJsxNode(path.node, state))
    },
    JSXFragment(path: NodePath<t.JSXFragment>) {
      path.replaceWith(transformJsxNode(path.node, state))
    },
  })

  // Pass 3 — whole-body `.value` reads. The JSX pass above only rewrites
  // `.value` inside JSX expressions; a `.value` read in a *statement* (an
  // extracted `Async` thunk, a helper, a local `const`) was left bare and so
  // never tracked. Rewrite those surviving reads too, so an AtomRef tracks
  // anywhere in a component body, not just in JSX.
  //
  // Runs on the LIVE AST *after* the JSX pass, so every JSX `.value` is already
  // an `h.read(...)` call (property name "read", not "value") and can't be
  // double-rewritten. There is NO compile-time atom detection: `h.read` is a
  // faithful passthrough (identical to `.value` for non-AtomRefs), so emitting
  // it for every `.value` read is safe; the runtime brand check is the exact
  // gate. And NO `h.track` wrap here — eager statement reads stay one-time
  // reads (Solid/Svelte/Vue semantics); tracking only activates when the read
  // executes under a tracker (an `Async` thunk, or a JSX `h.track` scope).
  //
  // The same traversal also performs the Component-name injection (see the
  // VariableDeclarator visitor) — an independent, additive rewrite that rides
  // along to avoid a fourth pass.
  let usedHRead = false
  traverse(ast, {
    MemberExpression(path: NodePath<t.MemberExpression>) {
      if (rewriteValueRead(path)) usedHRead = true
    },
    // Component-name injection: `const Counter = Component.make(fn)` gains the
    // declared name as a second argument — `Component.make(fn, "Counter")` —
    // so the span is named without the user repeating the export name. Purely
    // additive, single call-site shape (see `matchNamelessComponentMake`);
    // anything that doesn't match fails soft (no named span).
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(path.node.id) || path.node.init == null) return
      const call = matchNamelessComponentMake(path.node.init)
      if (call) call.arguments.push(t.stringLiteral(path.node.id.name))
    },
  })

  // Auto-inject the runtime imports the rewritten code now depends on.
  // Looks for an existing `import … from "@verrex/core"` and adds the
  // missing names there; otherwise prepends a new import. Keeps the user's
  // imports untouched and avoids duplicate specifiers. `h` is needed if the
  // JSX pass emitted `h(...)` OR pass 3 emitted any `h.read(...)`.
  const wanted = new Set<string>()
  if (state.usedH || usedHRead) wanted.add("h")
  if (state.usedFragment) wanted.add("Fragment")
  if (state.wroteList) wanted.add("list")
  if (wanted.size > 0) ensureRuntimeImports(ast.program, wanted)

  const result = generate(
    ast,
    {
      sourceMaps: true,
      sourceFileName: filename,
      retainLines: false,
      jsescOption: { minimal: true },
    },
    source,
  )

  const map = (result.map as object | null) ?? null
  const mappings = computeMappings(map, source, result.code, jsxRanges)

  return {
    code: result.code,
    map,
    jsxRanges,
    mappings,
  }
}
