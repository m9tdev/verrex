/**
 * Matches the labels TypeScript emits for the compiler-filled parameters —
 * `h()`'s `_tag`/`_props`/`_children` (and the un-prefixed
 * `tag:`/`props:`/`children:` forms) plus `Component.make`'s `_name` slot
 * (the compiler injects the name argument, so its hint lands on generated
 * code and leaks to the end of the call). `_name` is matched ONLY with the
 * underscore — bare `name:` is a common user parameter and must keep its
 * hint. The TS plugin filters these inlay hints out of `.vx` files; see
 * `service-proxy.ts`. Coupled by name to `verrex`'s `h` / `Component.make`
 * parameter names — documented in both packages' AGENTS.md.
 */
export const SUPPRESS_RE = /^(?:_?(?:tag|props|children)|_name):?$/i

/** The subset of an inlay hint we read a label string from. */
export interface HintTextShape {
  readonly text?: string | ReadonlyArray<{ readonly text: string }>
  readonly displayParts?: ReadonlyArray<{ readonly text: string }>
}

/**
 * Read an inlay hint's label text across the shapes different TypeScript
 * versions use, returning the **first non-empty** one:
 *   1. `hint.text` as a plain string (older TS)
 *   2. `hint.text` as display parts (array of `{ text }`)
 *   3. `hint.displayParts` (newer TS — more relevant since TS 6.0)
 *
 * First-non-empty fixes a latent bug in the previous inline version: it
 * assigned the `displayParts` join *unconditionally* when `displayParts`
 * existed, silently discarding an already-found `text` string/array when
 * `displayParts` was present but empty.
 */
export function hintText(hint: HintTextShape): string {
  if (typeof hint.text === "string" && hint.text.length > 0) {
    return hint.text
  }
  if (Array.isArray(hint.text)) {
    const joined = hint.text.map((p) => p.text).join("")
    if (joined.length > 0) return joined
  }
  if (Array.isArray(hint.displayParts)) {
    const joined = hint.displayParts.map((p) => p.text).join("")
    if (joined.length > 0) return joined
  }
  return ""
}
