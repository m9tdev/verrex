/**
 * Visualize fine-grained reactivity: when verrex re-renders a node, briefly flash
 * exactly that node — matching what Chrome DevTools' Elements panel highlights
 * on a DOM change.
 *
 * Parity detail: DevTools targets the *precise* node, not a convenient parent.
 * A reactive text swap (`{count}`) highlights only the text node, so updating
 * `clicks: 0` flashes the `0`, not the whole `<span>`. A child removal
 * highlights the container that lost the child. We can't style a text node with
 * CSS, so — exactly like DevTools — we don't style the node at all: we measure
 * its box and paint a transient overlay rectangle over it.
 *
 * This is pure demo sugar, framework-agnostic: a `MutationObserver` on the app
 * root catches the same DOM ops verrex performs (a `Reactive` node swap is a
 * childList change; a reactive `class` or `style` binding is an attribute
 * change; a list insert/remove adds/removes an element). Overlays are appended to `<body>`,
 * outside the observed root, so they never feed back into the observer.
 */

const DURATION = 400 // ms — kept shorter than the simulated fetch latency
                     // (services.ts) so a reset's flash blips before content loads

// The exact viewport-space box of a node, the way DevTools would outline it:
//   - element with a layout box → its own rect
//   - text node, or a `display:contents` wrapper (no box of its own) → the
//     union of its contents, via a Range (this is what makes the `0` text node
//     and the list container measurable)
const rectOf = (node: Node): DOMRect | null => {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element
    if (getComputedStyle(el).display !== "contents") {
      return el.getBoundingClientRect()
    }
  }
  const range = document.createRange()
  try {
    range.selectNodeContents(node)
    return range.getBoundingClientRect()
  } catch {
    return null
  }
}

const paint = (rect: DOMRect): void => {
  if (rect.width < 1 && rect.height < 1) return // nothing visible to flash
  const pad = 1
  // Position absolutely in *page* coordinates (viewport rect + scroll offset),
  // not `fixed` — so the overlay stays glued to the element if the user scrolls
  // during the animation, rather than drifting with the viewport.
  const o = document.createElement("div")
  o.style.cssText =
    "position:absolute;pointer-events:none;z-index:9999;border-radius:3px;" +
    `left:${rect.left + window.scrollX - pad}px;top:${rect.top + window.scrollY - pad}px;` +
    `width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px;` +
    `animation:verrex-flash-overlay ${DURATION}ms ease-out forwards;`
  document.body.appendChild(o)
  o.addEventListener("animationend", () => o.remove(), { once: true })
}

export const flashOnUpdate = (root: HTMLElement): MutationObserver => {
  const observer = new MutationObserver((records) => {
    // Dedupe: several mutations can name the same node in one batch.
    const nodes = new Set<Node>()
    for (const r of records) {
      if (r.type === "childList") {
        if (r.addedNodes.length > 0) {
          // Reactive text swap or list insert → the node(s) that appeared.
          r.addedNodes.forEach((n) => nodes.add(n))
        } else if (r.removedNodes.length > 0) {
          // Pure removal (e.g. "remove last row") → the container that changed.
          nodes.add(r.target)
        }
      } else {
        // characterData (in-place text) or attributes (reactive class) → target.
        nodes.add(r.target)
      }
    }
    for (const node of nodes) {
      if (node === root) continue
      const rect = rectOf(node)
      if (rect) paint(rect)
    }
  })
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  })
  return observer
}
