import { describe, expect, it } from "vitest"
import { transformVerrex } from "./transform.ts"

/** Convenience: just the emitted code, with whitespace normalized so tests
 *  don't break on formatting tweaks from @babel/generator. */
const compile = (src: string): string =>
  transformVerrex(src, "test.vx").code.replace(/\s+/g, " ").trim()

describe("JSX → h() rewrites", () => {
  it("intrinsic element with text child", () => {
    expect(compile(`
      const x = <div>hi</div>
    `))
      .toContain(`h("div", {}, "hi")`)
  })

  it("intrinsic element with string attr", () => {
    expect(compile(`
      const x = <div class="page">hi</div>
    `))
      .toContain(`h("div", { class: "page" }, "hi")`)
  })

  it("intrinsic element with boolean (no-value) attr", () => {
    expect(compile(`
      const x = <input disabled />
    `))
      .toContain(`h("input", { disabled: true })`)
  })

  it("intrinsic element with hyphenated attr name", () => {
    expect(compile(`
      const x = <div data-id="42" />
    `))
      .toContain(`h("div", { ["data-id"]: "42" })`)
  })

  it("intrinsic element with spread attribute", () => {
    expect(compile(`
      const x = <div {...props} />
    `))
      .toMatch(/h\("div",\s*\{\s*\.\.\.props\s*\}\s*\)/)
  })

  it("capitalized tag becomes a direct call (component lowering)", () => {
    expect(compile(`
      const x = <Foo bar={1} />
    `))
      .toContain(`Foo({ bar: 1 })`)
  })

  it("fragment <>...</> uses Fragment identifier", () => {
    expect(compile(`
      const x = <><span /><span /></>
    `))
      .toContain(`Fragment({ children: [h("span", {}), h("span", {})] })`)
  })

  it("nested JSX is recursively rewritten", () => {
    const out = compile(`
      const x = <div><span>a</span></div>
    `)
    expect(out).toContain(`h("span", {}, "a")`)
    expect(out).toContain(`h("div", {}, h("span"`)
  })

  it("JSX inside `&&` is rewritten", () => {
    expect(compile(`
      const x = <div>{cond && <p>y</p>}</div>
    `))
      .toContain(`h("p", {}, "y")`)
  })

  it("JSX inside ternary branches is rewritten", () => {
    const out = compile(`
      const x = <div>{cond ? <a /> : <b />}</div>
    `)
    expect(out).toContain(`h("a", {})`)
    expect(out).toContain(`h("b", {})`)
  })

  it("JSX inside .map(...) is rewritten", () => {
    expect(compile(`
      const x = <ul>{xs.map((x) => <li>{x}</li>)}</ul>
    `))
      .toContain(`h("li", {},`)
  })
})

describe("tracking-scope rewrites (h.track / h.read)", () => {
  it("`.value` reads become h.read(...) and the expression is wrapped in h.track", () => {
    const out = compile(`
      const x = <div>{ref.value}</div>
    `)
    expect(out).toContain(`h.read(ref)`)
    expect(out).toContain(`h.track(() =>`)
  })

  it("bare identifier in ternary test is NOT rewritten — user must write .value", () => {
    // Removed: bare identifiers in test positions used to be wrapped in
    // `h.peek(...)`. Users must now write `.value` explicitly so the type
    // checker sees a `boolean` (or whatever the ref unwraps to).
    const out = compile(`
      const x = <div>{loading ? <a /> : <b />}</div>
    `)
    expect(out).not.toContain(`h.peek`)
    expect(out).not.toContain(`h.track`)
  })

  it("bare identifier in `&&` is NOT rewritten", () => {
    const out = compile(`
      const x = <div>{show && <p />}</div>
    `)
    expect(out).not.toContain(`h.peek`)
    expect(out).not.toContain(`h.track`)
  })

  it("bare identifier under `!` is NOT rewritten", () => {
    const out = compile(`
      const x = <div>{!hidden ? <a /> : <b />}</div>
    `)
    expect(out).not.toContain(`h.peek`)
  })

  it("static expressions DO NOT get wrapped in h.track", () => {
    // `<Row item={item} />` — `item` is a bare identifier in attribute
    // position; there's no .value read, so wrapping would only strip the
    // static type to `unknown`.
    const out = compile(`
      const x = <Row item={item} />
    `)
    expect(out).toContain(`Row({ item: item })`)
    expect(out).not.toContain(`h.track`)
  })

  it("static literal attribute values are not wrapped", () => {
    expect(compile(`
      const x = <Foo n={42} s={"hi"} />
    `))
      .not.toContain(`h.track`)
  })

  it("`.value` assignment (LHS) is NOT rewritten as a read", () => {
    // We only intercept reads — `obj.value = …` stays as a real assignment.
    expect(compile(`
      const x = <div>{(ref.value = 1, ref.value)}</div>
    `))
      .toMatch(/ref\.value = 1/)
  })

  it("`.value++` / `--.value` are left bare — `h.read(obj)++` would be invalid JS, and TS's own `ts(2540)` already flags the read-only write at the right column", () => {
    const post = compile(`
      const v = <button onclick={() => count.value++}>+</button>
    `)
    expect(post).toContain(`count.value++`)
    expect(post).not.toMatch(/h\.read\(count\)\+\+/)

    const pre = compile(`
      const v = <button onclick={() => --count.value}>-</button>
    `)
    expect(pre).toContain(`--count.value`)
    expect(pre).not.toMatch(/--h\.read\(count\)/)
  })

  it("`.value += X` (compound assignment) is NOT rewritten — caught by the LHS escape hatch", () => {
    // AssignmentExpression with operator `+=` still has .left === the
    // MemberExpression, so the existing skip predicate covers it.
    const out = compile(`
      const v = <button onclick={() => { count.value += 1 }}>+</button>
    `)
    expect(out).toContain(`count.value += 1`)
    expect(out).not.toMatch(/h\.read\(count\) \+=/)
  })
})

describe(".value.map(arrow → JSX) → list(...) rewrite", () => {
  it("rewrites `<expr>.value.map(item => <JSX/>)` to a `list(<expr>, ...)` call", () => {
    const out = compile(
      `
      const x = <ul>{coll.value.map((item) => <Row item={item} />)}</ul>
    `,
    )
    expect(out).toContain(`list(coll, item =>`)
    expect(out).toContain(`Row({ item: item })`)
  })

  it("does NOT wrap the rewritten call in h.track (no redundant reactivity)", () => {
    const out = compile(
      `
      const x = <ul>{coll.value.map((item) => <Row item={item} />)}</ul>
    `,
    )
    expect(out).not.toContain(`h.track`)
    // And the `.value` is consumed by the rewrite — not turned into h.read.
    expect(out).not.toContain(`h.read(coll)`)
  })

  it("auto-imports `list` from verrex", () => {
    const out = compile(
      `
      const x = <ul>{coll.value.map((item) => <Row item={item} />)}</ul>
    `,
    )
    expect(out).toMatch(/import \{[^}]*\blist\b[^}]*\} from "@verrex\/core"/)
  })

  it("supports block-body arrow returning only a JSX node", () => {
    const out = compile(
      `
      const x = <ul>{coll.value.map((item) => { return <Row item={item} /> })}</ul>
    `,
    )
    expect(out).toContain(`list(coll,`)
    expect(out).toContain(`Row({ item: item })`)
  })

  it("supports JSX fragment as arrow body (direct and via block)", () => {
    // `isJsxArrowBody` accepts both JSXElement and JSXFragment — make sure
    // both shapes flow through the rewrite. Otherwise users hitting the
    // fragment idiom (`item => <>…</>` for multi-child rows without a wrapper
    // element) would get a silent no-rewrite.
    const direct = compile(
      `
      const x = <ul>{coll.value.map((item) => <>{item}</>)}</ul>
    `,
    )
    expect(direct).toContain(`list(coll,`)
    expect(direct).toContain(`Fragment({ children:`)

    const block = compile(
      `
      const x = <ul>{coll.value.map((item) => { return <>{item}</> })}</ul>
    `,
    )
    expect(block).toContain(`list(coll,`)
    expect(block).toContain(`Fragment({ children:`)
  })

  it("does NOT rewrite when the arrow body is not JSX (preserves Array.map / Collection.map)", () => {
    // Whole-collection derivation pattern (Collection.map((items) => derived))
    // must NOT be touched.
    const out = compile(
      `
      const x = <span>{coll.value.map((items) => items.length)}</span>
    `,
    )
    expect(out).not.toContain(`list(`)
    // The outer `.value` is a normal reactive read; should be rewritten to h.read.
    expect(out).toContain(`h.read(coll)`)
  })

  it("does NOT rewrite plain `.map` (no `.value`) — leaves as-is", () => {
    const out = compile(
      `
      const x = <ul>{xs.map((x) => <li>{x}</li>)}</ul>
    `,
    )
    expect(out).not.toContain(`list(`)
    expect(out).toContain(`h("li", {}, x)`)
  })

  it("does NOT rewrite when callee is not a function reference", () => {
    // `.value.map(SomeFn)` — argument is an identifier, not an arrow.
    // Conservative: the rewrite only fires when the body is unambiguously JSX.
    // The outer `.value` still gets the normal `h.read` rewrite + h.track wrap.
    const out = compile(`
      const x = <ul>{coll.value.map(SomeRow)}</ul>
    `)
    expect(out).not.toContain(`list(`)
    expect(out).toContain(`h.read(coll)`)
    expect(out).toContain(`h.track(() =>`)
  })

  it("rewrites the innermost `.value.map → list` in nested map chains", () => {
    // The outer arrow's body is a CallExpression, not JSX, so the outer
    // `.value.map` stays as Array.prototype.map. The inner arrow's body IS
    // JSX, so the inner `.value.map` becomes list(group.items, ...). The
    // outer `.value` falls back to h.read; the whole expression wraps in
    // h.track because that read happened.
    const out = compile(
      `
      const x = <ul>{outer.value.map((group) => group.items.value.map((item) => <li>{item}</li>))}</ul>
    `,
    )
    expect(out).toContain(`h.read(outer)`)
    expect(out).toContain(`list(group.items,`)
    expect(out).toContain(`h.track(() =>`)
    // Inner `.value` was consumed by the rewrite — never turned into h.read.
    expect(out).not.toContain(`h.read(group.items)`)
  })

  it("does NOT pre-emptively rewrite `.value` reads inside the list arrow body", () => {
    // `ref.value` inside the arrow body is its own JSX expression
    // (`<Row badge={ref.value}/>`). It gets its OWN h.track wrap when the
    // outer JSX traversal reaches that inner `<Row>`. If the outer rewrite
    // descended into the new list's children, it would (a) wrap the whole
    // list(...) in a redundant h.track and (b) strand the inner h.read
    // outside any active tracking scope.
    const out = compile(
      `
      const x = <ul>{coll.value.map((item) => <Row badge={ref.value} />)}</ul>
    `,
    )
    // The list(...) call is NOT wrapped in h.track.
    expect(out).not.toMatch(/h\.track\(\(\)\s*=>\s*list\(/)
    // The inner ref.value gets its own h.track wrap around the h.read.
    expect(out).toMatch(/h\.track\(\(\)\s*=>\s*h\.read\(ref\)\)/)
  })
})

describe("Async calls are not h.track-wrapped", () => {
  // The Async boundary self-tracks (it runs its thunk under the same dep
  // tracker), so wrapping it in h.track is redundant AND erases its channels
  // (h.track returns `unknown`). The `.value`→h.read rewrite inside is kept.
  it("leaves a `.value`-reading Async(...) bare, keeping h.read", () => {
    const out = compile(`
      const x = <div>{Async(() => client.get(id.value), { success: (v) => <span>{v}</span> })}</div>
    `)
    expect(out).toContain(`h.read(id)`)        // dep rewrite kept (Async needs it)
    expect(out).not.toMatch(/h\.track\(\(\)\s*=>\s*Async\(/) // not wrapped
  })

  it("does not introduce h.track when Async is the only `.value` reader", () => {
    const out = compile(`
      const x = <div>{Async(() => client.get(id.value), { success: (v) => <span>{v}</span> })}</div>
    `)
    expect(out).not.toContain(`h.track`)
  })
})

describe("Catch calls are not h.track-wrapped", () => {
  // Same reason as Async: Catch returns Effect<View, never, R | Scope> that must
  // reach the h() fold; h.track would erase it to `unknown`. A `.value` read
  // inside the fallback is still rewritten to h.read, but the outer call is bare.
  it("leaves a `.value`-reading catch-all Catch(...) bare, keeping h.read", () => {
    const out = compile(`
      const x = <div>{Catch(<Child />, (cause, reset) => <span>{label.value}</span>)}</div>
    `)
    expect(out).toContain(`h.read(label)`) // dep rewrite kept inside the fallback
    expect(out).not.toMatch(/h\.track\(\(\)\s*=>\s*Catch\(/) // not wrapped
  })

  it("does not introduce h.track when Catch is the only `.value` reader", () => {
    const out = compile(`
      const x = <div>{Catch(<Child />, (cause) => <span>{label.value}</span>)}</div>
    `)
    expect(out).not.toContain(`h.track`)
  })

  it("leaves the tag-map Catch form bare too", () => {
    const out = compile(`
      const x = <div>{Catch(<Child />, { HttpError: (e) => <span>{label.value}</span> })}</div>
    `)
    expect(out).toContain(`h.read(label)`)
    expect(out).not.toContain(`h.track`)
  })
})

describe("asyncRef / streamRef calls are not h.track-wrapped", () => {
  // Both return an Effect whose channels must reach the h() fold; h.track would
  // erase them — and re-running the expression on a dep change would mint a
  // fresh handle / spawn a fresh stream per change (each also self-tracks its
  // thunk internally). The `.value`→h.read rewrite inside is kept.
  it("leaves a `.value`-reading streamRef(...) bare, keeping h.read", () => {
    const out = compile(`
      const x = <div>{streamRef(makeStream(id.value), 0)}</div>
    `)
    expect(out).toContain(`h.read(id)`)
    expect(out).not.toMatch(/h\.track\(\(\)\s*=>\s*streamRef\(/)
  })

  it("leaves a `.value`-reading asyncRef(...) bare, keeping h.read", () => {
    const out = compile(`
      const x = <div>{asyncRef(() => client.get(id.value))}</div>
    `)
    expect(out).toContain(`h.read(id)`)
    expect(out).not.toMatch(/h\.track\(\(\)\s*=>\s*asyncRef\(/)
  })
})

describe("whole-body `.value` reads (tracking outside JSX)", () => {
  // The JSX pass only rewrites `.value` inside JSX expressions. A third pass
  // rewrites `.value` reads that survive in *statements* — extracted Async
  // thunks, helpers, locals — so an AtomRef tracks anywhere in a component
  // body. Detection is the runtime brand inside `h.read` (faithful for
  // non-AtomRefs); there is no compile-time atom analysis and no `h.track`
  // wrap in this pass (eager reads stay one-time).

  it("rewrites a `.value` read in an extracted thunk (the motivating gap)", () => {
    const out = compile(`
      const get = () => client.getUser(userId.value)
      const x = <div>{Async(get, { success: (u) => <span>{u}</span> })}</div>
    `)
    expect(out).toContain(`h.read(userId)`)
    // No h.track wrap around the thunk read — Async runs it under its own tracker.
    expect(out).not.toMatch(/h\.track\(\(\)\s*=>\s*client\.getUser/)
  })

  it("rewrites a plain statement-level `.value` read", () => {
    const out = compile(`
      const n = count.value + 1
    `)
    expect(out).toContain(`h.read(count)`)
    expect(out).not.toContain(`h.track`)
  })

  it("rewrites `.value` inside a non-thunk function body", () => {
    const out = compile(`
      function label() { return count.value }
    `)
    expect(out).toContain(`h.read(count)`)
  })

  it("auto-imports `h` when the only rewrite is a body read (no JSX)", () => {
    const out = compile(`
      const get = () => ref.value
    `)
    expect(out).toContain(`h.read(ref)`)
    expect(out).toMatch(/import \{[^}]*\bh\b[^}]*\} from "@verrex\/core"/)
  })

  it("leaves a body `.value` *write* bare (assignment + update)", () => {
    const assign = compile(`
      const f = () => { ref.value = 1 }
    `)
    expect(assign).toContain(`ref.value = 1`)
    expect(assign).not.toContain(`h.read(ref)`)

    const update = compile(`
      const f = () => { count.value++ }
    `)
    expect(update).toContain(`count.value++`)
    expect(update).not.toMatch(/h\.read\(count\)\+\+/)
  })

  it("leaves destructuring-assignment targets bare (array + object patterns)", () => {
    const arr = compile(`
      const f = () => { [obj.value] = arr }
    `)
    expect(arr).toContain(`[obj.value] = arr`)
    expect(arr).not.toContain(`h.read(obj)`)

    const objPat = compile(`
      const f = () => { ({ x: obj.value } = o) }
    `)
    expect(objPat).toContain(`x: obj.value`)
    expect(objPat).not.toContain(`h.read(obj)`)

    const dflt = compile(`
      const f = () => { [obj.value = 1] = arr }
    `)
    expect(dflt).toContain(`obj.value = 1`)
    expect(dflt).not.toContain(`h.read(obj)`)

    const rest = compile(`
      const f = () => { [...obj.value] = arr }
    `)
    expect(rest).toContain(`...obj.value`)
    expect(rest).not.toContain(`h.read(obj)`)
  })

  it("leaves a `for (obj.value of …)` target bare (and does not crash)", () => {
    // The unguarded form crashed Babel: ForOfStatement.left rejects a
    // CallExpression. Must stay bare.
    const of = compile(`
      const f = () => { for (el.value of xs) {} }
    `)
    expect(of).toContain(`for (el.value of xs)`)
    expect(of).not.toContain(`h.read(el)`)

    const inn = compile(`
      const f = () => { for (el.value in xs) {} }
    `)
    expect(inn).toContain(`for (el.value in xs)`)
    expect(inn).not.toContain(`h.read(el)`)
  })

  it("still rewrites a `.value` READ on the for-of iterable (right side)", () => {
    const out = compile(`
      const f = () => { for (const x of coll.value) {} }
    `)
    expect(out).toContain(`for (const x of h.read(coll))`)
  })

  it("leaves `delete obj.value` bare", () => {
    const out = compile(`
      const f = () => delete obj.value
    `)
    expect(out).toContain(`delete obj.value`)
    expect(out).not.toContain(`h.read(obj)`)
  })

  it("rewrites reads that only LOOK write-adjacent (RHS, default value, unary)", () => {
    // x = obj.value (RHS), [a = obj.value] (pattern default), !obj.value (unary)
    // are all reads and must be rewritten.
    expect(compile(`
      const f = () => { x = obj.value }
    `)).toContain(`h.read(obj)`)
    expect(compile(`
      const f = () => { [a = obj.value] = arr }
    `)).toContain(`h.read(obj)`)
    expect(compile(`
      const f = () => !obj.value
    `)).toContain(`!h.read(obj)`)
  })

  it("leaves optional-chained `obj?.value` alone (different node type)", () => {
    const out = compile(`
      const v = maybe?.value
    `)
    expect(out).toContain(`maybe?.value`)
    expect(out).not.toContain(`h.read(maybe)`)
  })

  it("does NOT double-rewrite JSX `.value` reads (no h.read(h.read(...)))", () => {
    const out = compile(`
      const x = <div>{ref.value}</div>
    `)
    expect(out).toContain(`h.read(ref)`)
    expect(out).not.toContain(`h.read(h.read`)
  })

  it("rewrites both a JSX read and a body read with a single `h` import", () => {
    const out = compile(`
      const dbl = () => count.value * 2
      const x = <div>{count.value}</div>
    `)
    // body read + JSX read both go through h.read
    expect(out.match(/h\.read\(count\)/g)?.length).toBe(2)
    const importLines = out.split(";").filter((s) => s.includes(`from "@verrex/core"`))
    expect(importLines.length).toBe(1)
  })

  it("does NOT rewrite a non-`value` property read", () => {
    const out = compile(`
      const u = props.userId
    `)
    expect(out).not.toContain(`h.read`)
    expect(out).not.toContain(`verrex`)
  })
})

describe("runtime auto-imports", () => {
  it("adds `import { h } from \"@verrex/core\"` when JSX is present", () => {
    const out = compile(`
      const x = <div />
    `)
    expect(out).toContain(`import { h } from "@verrex/core"`)
  })

  it("adds `Fragment` too when <>...</> is used", () => {
    const out = compile(`
      const x = <><span /></>
    `)
    expect(out).toMatch(/import \{[^}]*Fragment[^}]*\} from "@verrex\/core"/)
    expect(out).toMatch(/import \{[^}]*h[^}]*\} from "@verrex\/core"/)
  })

  it("does NOT inject if `h` is already imported under its own name", () => {
    const src = `
      import { h } from "@verrex/core"
      const x = <div />
    `
    const matches = compile(src).match(/import \{[^}]*\bh\b[^}]*\} from "@verrex\/core"/g)
    expect(matches?.length).toBe(1)
  })

  it("extends an existing verrex import instead of adding a new one", () => {
    const src = `
      import { mount } from "@verrex/core"
      const x = <div />
    `
    const out = compile(src)
    expect(out).toMatch(/import \{[^}]*mount[^}]*h[^}]*\} from "@verrex\/core"/)
    const importLines = out.split(";").filter((s) => s.includes(`from "@verrex/core"`))
    expect(importLines.length).toBe(1)
  })

  it("does NOT add runtime import when there's no JSX", () => {
    const out = compile(`
      const x = 1; const y = 2;
    `)
    expect(out).not.toContain(`verrex`)
  })

  it("preserves unrelated imports verbatim", () => {
    const out = compile(`
      import { Effect } from "effect"
      const x = <div />
    `)
    expect(out).toContain(`import { Effect } from "effect"`)
  })
})

describe("jsxRanges output", () => {
  const ranges = (src: string) => transformVerrex(src, "test.vx").jsxRanges

  const firstElement = (src: string) => {
    const rs = ranges(src)
    const r = rs[0]
    if (!r || r.kind !== "element") throw new Error("expected first range to be element")
    return r
  }

  it("single element records its full span and tag name positions", () => {
    const src = `
      const x = <div>hi</div>
    `
    const r = firstElement(src)
    expect(src.slice(r.start, r.end)).toBe(`<div>hi</div>`)
    expect(src.slice(r.openingTag.start, r.openingTag.end)).toBe(`<div>`)
    expect(src.slice(r.openingTag.nameStart, r.openingTag.nameEnd)).toBe(`div`)
    expect(r.isSelfClosing).toBe(false)
    const closing = r.closingTag
    if (!closing) throw new Error("expected closingTag")
    expect(src.slice(closing.start, closing.end)).toBe(`</div>`)
    expect(src.slice(closing.nameStart, closing.nameEnd)).toBe(`div`)
  })

  it("self-closing element has no closingTag and isSelfClosing=true", () => {
    const src = `
      const x = <Foo bar={1} />
    `
    const r = firstElement(src)
    expect(r.isSelfClosing).toBe(true)
    expect(r.closingTag).toBeUndefined()
    expect(src.slice(r.openingTag.nameStart, r.openingTag.nameEnd)).toBe(`Foo`)
  })

  it("fragment records both <> and </> tag positions, no names", () => {
    const src = `
      const x = <><span /></>
    `
    const frag = ranges(src).find((r) => r.kind === "fragment")
    if (!frag || frag.kind !== "fragment") throw new Error("expected fragment")
    expect(src.slice(frag.openingTag.start, frag.openingTag.end)).toBe(`<>`)
    expect(src.slice(frag.closingTag.start, frag.closingTag.end)).toBe(`</>`)
  })

  it("nested elements emit parent before children in source order", () => {
    const src = `
      const x = <div><span>a</span></div>
    `
    const rs = ranges(src)
    expect(rs.length).toBe(2)
    const [outer, inner] = rs
    if (!outer || !inner) throw new Error("expected two ranges")
    expect(outer.kind).toBe("element")
    expect(inner.kind).toBe("element")
    expect(src.slice(outer.start, outer.end)).toBe(`<div><span>a</span></div>`)
    expect(src.slice(inner.start, inner.end)).toBe(`<span>a</span>`)
  })

  it("dotted member tag name covers the full Foo.Bar span", () => {
    const src = `
      const x = <Foo.Bar />
    `
    const r = firstElement(src)
    expect(src.slice(r.openingTag.nameStart, r.openingTag.nameEnd)).toBe(`Foo.Bar`)
  })

  it("ranges are empty when there's no JSX", () => {
    expect(ranges(`
      const x = 1
    `)).toEqual([])
  })

  it("ternary branches both produce ranges", () => {
    const src = `
      const x = <div>{cond ? <a /> : <b />}</div>
    `
    const tags = ranges(src)
      .filter((r) => r.kind === "element")
      .map((r) => src.slice(r.openingTag.nameStart, r.openingTag.nameEnd))
    expect(tags).toContain("div")
    expect(tags).toContain("a")
    expect(tags).toContain("b")
  })
})

describe("TypeScript syntax survives", () => {
  it("type annotations are preserved", () => {
    expect(compile(`
      const greet = (name: string) => <p>hi {name}</p>
    `))
      .toContain(`name: string`)
  })

  it("generator functions are preserved", () => {
    expect(compile(`
      const f = function* () { return <div /> }
    `))
      .toContain(`function* ()`)
  })

  it("`yield*` survives the rewrite", () => {
    expect(compile(`
      const f = function* () { yield* effect; return <div /> }
    `))
      .toContain(`yield* effect`)
  })

  it("type parameters on functions survive", () => {
    expect(compile(`
      const id = <T,>(x: T): T => { return (<p>{x}</p> as any) as T }
    `))
      .toMatch(/<T(,)?>/)
  })
})

describe("parse-error tolerance (mid-edit source)", () => {
  // The editor calls transformVerrex on every keystroke; mid-edit source is
  // routinely unparseable. Throwing would leave the language plugin without a
  // virtual code, and completion requests would fall back to the project's
  // global scope (999 entries of DOM ambient declarations instead of the
  // expected member list). errorRecovery: true on @babel/parser keeps the AST
  // coming. Note: recovery isn't omnipotent — JSX-interior parse errors like
  // `<div>{x.}</div>` still throw — but the common "type a dot in user code"
  // case works.
  it("does not throw on `obj.` followed by a keyword", () => {
    const src = `function* f() { const x = { a: 1 }; x.\n\nreturn yield* g() }`
    expect(() => transformVerrex(src, "test.vx")).not.toThrow()
  })

  it("emits a recognizable member access for `obj.` recovery", () => {
    // Babel's recovery turns `x.\n\nreturn` into `x.return` (next keyword
    // becomes the property name). The exact property name doesn't matter
    // — what matters is that `x.` lands inside a member-access shape so the
    // source map covers it and tsserver returns members of `x`.
    const src = `function* f() { const x = { a: 1 }; x.\n\nreturn yield* g() }`
    const out = compile(src)
    expect(out).toMatch(/x\.\w+/)
  })

  // The build path (verrex/vite) passes `errorRecovery: false` so a real
  // syntax error throws loudly — a Vite overlay in dev, a failed build in CI —
  // instead of the compiler silently recovering and shipping a broken module.
  it("throws on genuinely broken source when errorRecovery is false", () => {
    const src = `function* f() { const x = { a: 1 }; x.\n\nreturn yield* g() }`
    expect(() => transformVerrex(src, "test.vx", { errorRecovery: false })).toThrow()
  })

  it("still recovers by default (editor path) for the same source", () => {
    const src = `function* f() { const x = { a: 1 }; x.\n\nreturn yield* g() }`
    expect(() => transformVerrex(src, "test.vx")).not.toThrow()
  })
})

describe("JSX text whitespace (cleanJSXElementLiteralChild parity)", () => {
  it("collapses a newline between two words to a single space", () => {
    const src = `const x = <p>a framework whose
      point is honesty</p>`
    expect(compile(src)).toContain(`"a framework whose point is honesty"`)
  })

  it("preserves internal spaces in single-line text", () => {
    expect(compile(`const x = <span> clicks: </span>`))
      .toContain(`h("span", {}, " clicks: ")`)
  })

  it("drops pure-whitespace / blank-line nodes", () => {
    const src = `const x = <div>

      hi

    </div>`
    expect(compile(src)).toContain(`h("div", {}, "hi")`)
  })

  it("trims whitespace adjacent to an element boundary (React parity: a tag on its own line concatenates)", () => {
    const src = `const x = <p>paired
      <code>unmount</code></p>`
    // "paired" carries no trailing space — the source must add {" "} for one,
    // exactly as in React.
    expect(compile(src)).toContain(`"paired"`)
    expect(compile(src)).not.toContain(`"paired "`)
  })

  it("keeps an explicit {\" \"} spacer between text and an element", () => {
    const src = `const x = <p>use a{" "}
      <code>.vx</code> file</p>`
    expect(compile(src)).toContain(`"use a"`)
    expect(compile(src)).toContain(`" "`)
  })
})

describe("Component.make name injection", () => {
  it("injects the declared name as a second argument", () => {
    const out = compile(`
      export const Counter = Component.make(function* () {
        return yield* <div>hi</div>
      })
    `)
    expect(out).toContain(`Component.make(function*`)
    expect(out).toContain(`, "Counter")`)
  })

  it("injects for a non-exported const too", () => {
    const out = compile(`
      const Local = Component.make(function* () {
        return yield* <div>hi</div>
      })
    `)
    expect(out).toContain(`"Local")`)
  })

  it("leaves an explicitly named call alone", () => {
    const out = compile(`
      export const Counter = Component.make(fn, "Custom")
    `)
    expect(out).toContain(`Component.make(fn, "Custom")`)
    expect(out).not.toContain(`"Counter"`)
  })

  it("does not fire on other Component members or bare make calls", () => {
    const out = compile(`
      const a = Component.makeOther(fn)
      const b = make(fn)
    `)
    expect(out).not.toContain(`"a"`)
    expect(out).not.toContain(`"b"`)
  })

  it("does not fire on an aliased namespace (fails soft, no named span)", () => {
    const out = compile(`
      const Aliased = C.make(fn)
    `)
    expect(out).toContain(`C.make(fn)`)
    expect(out).not.toContain(`"Aliased"`)
  })

  it("does not fire on a destructuring declarator", () => {
    const out = compile(`
      const { x } = Component.make(fn)
    `)
    expect(out).toContain(`Component.make(fn)`)
  })
})

describe("component-tag lowering (direct calls, #71)", () => {
  it("no attrs, no children → zero-arg call (propless components stay callable)", () => {
    expect(compile(`const x = <Counter />`)).toContain(`Counter()`)
  })

  it("children land as a `children` array prop", () => {
    const out = compile(`const x = <Layout><span /\>hi</Layout>`)
    expect(out).toContain(`Layout({ children: [h("span", {}), "hi"] })`)
  })

  it("attrs and children combine in one props object", () => {
    const out = compile(`const x = <Layout pad={2}><span /></Layout>`)
    expect(out).toContain(`Layout({ pad: 2, children: [h("span", {})] })`)
  })

  it("JSX children override an explicit children attr (React semantics)", () => {
    const out = compile(`const x = <Layout children={old}><span /></Layout>`)
    expect(out).not.toContain(`old`)
    expect(out).toContain(`children: [h("span", {})]`)
  })

  it("member-expression tags lower to direct calls too", () => {
    expect(compile(`const x = <UI.Button label="ok" />`)).toContain(`UI.Button({ label: "ok" })`)
  })

  it("spread attrs pass through into the props object", () => {
    expect(compile(`const x = <Foo {...rest} />`)).toContain(`Foo({ ...rest })`)
  })

  it("a component-only file imports no `h` at all", () => {
    const out = compile(`export const x = <Counter />`)
    expect(out).not.toContain(`import`)
  })

  it("a fragment-only file imports Fragment but not h", () => {
    const out = compile(`const x = <>{Counter()}</>`)
    expect(out).toMatch(/import \{ Fragment \} from "@verrex\/core"/)
    expect(out).not.toMatch(/\bh\b[^.]*from/)
  })

  it("intrinsics still route through h (and import it)", () => {
    const out = compile(`const x = <div><Counter /></div>`)
    expect(out).toContain(`h("div", {}, Counter())`)
    expect(out).toMatch(/import \{ h \} from "@verrex\/core"/)
  })

  it("namespaced tags stay string-tagged through h", () => {
    expect(compile(`const x = <svg:rect width="1" />`)).toContain(`h("svg:rect", { width: "1" })`)
  })

  it("a spread child expands into the children array (component) and the call args (intrinsic)", () => {
    expect(compile(`const x = <Foo>{...items}</Foo>`)).toContain(`Foo({ children: [...items] })`)
    expect(compile(`const y = <div>{...items}</div>`)).toContain(`h("div", {}, ...items)`)
  })
})
