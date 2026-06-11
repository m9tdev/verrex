import { describe, it, expect } from "vitest"
import { hintText, SUPPRESS_RE } from "./hint-text.ts"

describe("hintText", () => {
  it("reads a plain string label", () => {
    expect(hintText({ text: "_tag:" })).toBe("_tag:")
  })

  it("joins display-part array `text`", () => {
    expect(hintText({ text: [{ text: "_props" }, { text: ":" }] })).toBe("_props:")
  })

  it("reads newer-TS `displayParts`", () => {
    expect(hintText({ displayParts: [{ text: "_children" }, { text: ":" }] })).toBe(
      "_children:",
    )
  })

  // The bug this extraction fixes: an empty `displayParts` must not clobber a
  // label already found in `text`. The old inline version overwrote it.
  it("keeps `text` when `displayParts` is present but empty", () => {
    expect(hintText({ text: "_tag:", displayParts: [] })).toBe("_tag:")
  })

  it("keeps `text` array when `displayParts` is empty", () => {
    expect(hintText({ text: [{ text: "_tag" }, { text: ":" }], displayParts: [] })).toBe(
      "_tag:",
    )
  })

  it("returns empty string when nothing is populated", () => {
    expect(hintText({})).toBe("")
    expect(hintText({ text: "" })).toBe("")
  })
})

describe("SUPPRESS_RE", () => {
  it("matches the h() parameter labels (prefixed and not, with/without colon)", () => {
    for (const s of ["_tag", "_tag:", "tag:", "_props:", "_children:", "Props"]) {
      expect(SUPPRESS_RE.test(s)).toBe(true)
    }
  })

  it("matches Component.make's compiler-filled _name slot (underscore only)", () => {
    for (const s of ["_name", "_name:", "_Name:"]) {
      expect(SUPPRESS_RE.test(s)).toBe(true)
    }
  })

  // Bare `name:` is a common user parameter — its hint must survive; only
  // the underscore-prefixed compiler slot is suppressed.
  it("does not match unrelated labels", () => {
    for (const s of ["count:", "name:", "tagName:", "children2:", "_named:"]) {
      expect(SUPPRESS_RE.test(s)).toBe(false)
    }
  })
})
