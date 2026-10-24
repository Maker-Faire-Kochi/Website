import type { V3 } from './layout'

/** Client scroll input; the ordinary falling coconuts keep their own physics. */
export const scrollCoconut = { enabled: false, progress: 0 }

/** Scroll starts the fall once the bank camera is ready; time carries it on. */
export class CoconutPlayback {
  progress = 0
  started = false

  step(dt: number, scroll: number, bankReady: boolean) {
    if (!this.started && scroll >= 0.15 && bankReady) {
      this.started = true
      this.progress = 0.12
    }
    if (this.started) this.progress = Math.min(1, this.progress + dt / 1.8)
  }
}

/** Fall, bounce and roll along the bank, evaluated from playback progress. */
export function coconutPose(start: V3, end: V3, progress: number, out: V3): V3 {
  const p = Math.min(1, Math.max(0, progress))
  if (p <= 0.12) {
    out[0] = start[0]; out[1] = start[1]; out[2] = start[2]
  }
  else if (p <= 0.68) {
    const u = (p - 0.12) / 0.56
    out[0] = start[0] + (end[0] - start[0]) * u
    out[1] = start[1] + (end[1] - start[1]) * u * u
    out[2] = start[2] + (end[2] - start[2]) * u
  }
  else {
    const u = (p - 0.68) / 0.32
    out[0] = end[0] + 0.55 * u
    out[1] = end[1] + 0.4 * Math.abs(Math.sin(u * Math.PI * 2)) * (1 - u) ** 2
    out[2] = end[2] + 0.18 * u
  }
  return out
}
