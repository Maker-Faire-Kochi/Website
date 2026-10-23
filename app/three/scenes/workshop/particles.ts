import { landing } from './layout'

/**
 * Sawdust and chisel chips: one fixed-size ring buffer, drawn as ONE Points
 * object. Particles fall under gravity with air drag (dust drifts, chips fly)
 * and stop dead on the first surface they cross -- dust does not bounce. When
 * the ring is full the oldest grain is reused, so the settled pile stays a
 * constant, small size however long the page runs.
 *
 * Pure (no three): positions live in a Float32Array the renderer copies from,
 * with the previous step kept alongside for frame interpolation.
 */

const G = 9.81

export class Particles {
  readonly pos: Float32Array
  readonly prev: Float32Array
  readonly vel: Float32Array
  readonly drag: Float32Array
  readonly resting: Uint8Array
  /** High-water mark: slots [0, count) hold a grain. */
  count = 0
  /** Grains that settled during the last step: dust, and chips (low drag) -- for the sprinkle sound. */
  landedDust = 0
  landedChips = 0
  private head = 0

  constructor(readonly capacity: number) {
    this.pos = new Float32Array(capacity * 3)
    this.prev = new Float32Array(capacity * 3)
    this.vel = new Float32Array(capacity * 3)
    this.drag = new Float32Array(capacity)
    this.resting = new Uint8Array(capacity)
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, drag: number) {
    const i = this.head
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
    const k = i * 3
    this.pos[k] = this.prev[k] = x
    this.pos[k + 1] = this.prev[k + 1] = y
    this.pos[k + 2] = this.prev[k + 2] = z
    this.vel[k] = vx
    this.vel[k + 1] = vy
    this.vel[k + 2] = vz
    this.drag[i] = drag
    this.resting[i] = 0
  }

  step(dt: number) {
    const { pos, prev, vel } = this
    this.landedDust = this.landedChips = 0
    for (let i = 0; i < this.count; i++) {
      const k = i * 3
      prev[k] = pos[k]!
      prev[k + 1] = pos[k + 1]!
      prev[k + 2] = pos[k + 2]!
      if (this.resting[i]) continue
      // Semi-implicit Euler with linear drag: v first, then x from the new v.
      const damp = 1 / (1 + this.drag[i]! * dt)
      vel[k] = vel[k]! * damp
      vel[k + 1] = (vel[k + 1]! - G * dt) * damp
      vel[k + 2] = vel[k + 2]! * damp
      const x = pos[k]! + vel[k]! * dt
      const y0 = pos[k + 1]!
      const y = y0 + vel[k + 1]! * dt
      const z = pos[k + 2]! + vel[k + 2]! * dt
      pos[k] = x
      pos[k + 2] = z
      const ground = vel[k + 1]! < 0 ? landing(x, z, y0, y) : null
      if (ground === null) {
        pos[k + 1] = y
      }
      else {
        pos[k + 1] = ground
        vel[k] = vel[k + 1] = vel[k + 2] = 0
        this.resting[i] = 1
        if (this.drag[i]! < 2) this.landedChips++
        else this.landedDust++
      }
    }
  }
}
