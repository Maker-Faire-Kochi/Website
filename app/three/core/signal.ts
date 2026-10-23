/**
 * Live values a scene publishes every frame for DOM effects to read in their
 * own requestAnimationFrame. Plain mutable objects on purpose: Vue reactivity
 * on a value written 60 times a second would re-render for nothing.
 */

/** Written by the noise scene's synth; read by the NOISE headline (Pretext). */
export const noiseSignal = {
  /** 0..1 RMS output level of the synth, smoothed. */
  level: 0,
  /** 0..1 position of the pitch control. */
  pitch: 0,
  /** True while the synth is sounding. */
  active: false,
}

/** Written by the hero scene; read by the hero's live leader lines. Slot-relative CSS px. */
export interface Anchor { id: string, x: number, y: number, visible: boolean }
export const heroAnchors: Anchor[] = []

/**
 * Written by the hero page; read by the hero scene. Screen areas the robots
 * must keep out of because text and controls sit there (the words block, the
 * key and controls box): each a rect in FRACTIONS of the hero slot (0..1,
 * y down). The scene projects them onto the floor and treats them as walls,
 * so text never sits over a moving robot. `version` increments on every
 * change so the scene can rebuild its walls only when they move.
 */
export interface ScreenRect { x0: number, x1: number, y0: number, y1: number }
export const heroKeepOut = { version: 0, rects: [] as ScreenRect[] }
