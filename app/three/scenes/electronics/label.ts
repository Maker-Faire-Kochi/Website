/**
 * The hovered part's name for the DOM, written by the electronics scene every
 * frame while a part is hovered (or briefly after a tap on touch devices) and
 * read by the integrator's hairline leader in its own requestAnimationFrame.
 * x, y are CSS px relative to the slot's top-left, at the top of the part.
 * A plain mutable object on purpose: reactivity at 60 Hz would re-render for
 * nothing. Only the electronics scene writes it.
 */
export const hoverLabel = { text: '', x: 0, y: 0, visible: false }
