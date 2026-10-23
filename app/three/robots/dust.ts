import * as THREE from 'three'

/**
 * Contact evidence: a tiny puff of dust on the ground where two robots (or a
 * robot and a prop) hit -- a ring of short hairline ticks that spring
 * outward, lift a few millimetres and fade into the ground in half a second.
 * Drawn in the kit's hairline language, sized by the impact speed.
 *
 * POOLED: one LineSegments (one draw call) holds `pool` puffs of `ticks`
 * segments each; a new puff takes the oldest slot. Fading is done with
 * vertex colours blending from a faint ink to the ground colour, so there is
 * no transparency to sort. The geometry is only rewritten while a puff is
 * alive. Time is the scene's simulated time, so the puffs replay exactly.
 */
export const DUST = {
  pool: 8,
  ticks: 7,
  life: 0.5,
  /** Ring radius at the start, and its growth, per metre of `size`. */
  r0: 0.35,
  grow: 1.1,
  /** Tick length per metre of size, and the lift (m) at the end of the puff. */
  len: 0.45,
  lift: 0.006,
  /** Strength of the ink at birth (0 = paper, 1 = ink). */
  ink: 0.55,
}

interface Puff { x: number, z: number, t0: number, size: number, phase: number, live: boolean }

export class Dust {
  readonly lines: THREE.LineSegments
  private readonly geo = new THREE.BufferGeometry()
  private readonly mat: THREE.LineBasicMaterial
  private readonly pos: Float32Array
  private readonly col: Float32Array
  private readonly puffs: Puff[] = []
  private readonly ink: THREE.Color
  private readonly paper: THREE.Color
  private next = 0
  private count = 0
  private dirty = false

  constructor(ink: string, paper: string) {
    const n = DUST.pool * DUST.ticks * 2
    this.pos = new Float32Array(n * 3)
    this.col = new Float32Array(n * 3)
    this.ink = new THREE.Color(ink)
    this.paper = new THREE.Color(paper)
    for (let i = 0; i < n; i++) this.paper.toArray(this.col, i * 3)
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true })
    this.lines = new THREE.LineSegments(this.geo, this.mat)
    this.lines.frustumCulled = false
    this.lines.renderOrder = -1
    this.lines.visible = false
    for (let i = 0; i < DUST.pool; i++) this.puffs.push({ x: 0, z: 0, t0: 0, size: 0, phase: 0, live: false })
  }

  /** A puff at a ground point; speed (m/s) sets its size. */
  puff(x: number, z: number, speed: number, time: number) {
    const p = this.puffs[this.next]!
    p.x = x
    p.z = z
    p.t0 = time
    p.size = 0.012 + 0.05 * Math.min(1, speed / 0.5)
    // Golden-angle phase per puff, so neighbouring puffs never repeat the same ring.
    p.phase = (this.count * 2.39996) % (Math.PI * 2)
    p.live = true
    this.next = (this.next + 1) % DUST.pool
    this.count++
    this.dirty = true
    this.lines.visible = true
  }

  /** Puffs still visible. */
  get active() {
    let n = 0
    for (const p of this.puffs) if (p.live) n++
    return n
  }

  /** Rewrite the live puffs for this (simulated) time. */
  update(time: number) {
    if (!this.dirty) return
    let any = false
    const T = DUST.ticks
    for (let i = 0; i < DUST.pool; i++) {
      const p = this.puffs[i]!
      let u = p.live ? (time - p.t0) / DUST.life : 1
      if (u >= 1 || u < 0) {
        if (p.live || u < 0) p.live = false
        u = 1
      }
      else {
        any = true
      }
      // Ease out: the ring springs open, then drifts.
      const e = 1 - (1 - u) * (1 - u)
      const r = p.size * (DUST.r0 + DUST.grow * e)
      const len = p.size * DUST.len * (1 - u)
      const y = 0.0015 + DUST.lift * e * (p.size / 0.06)
      const k = p.live ? DUST.ink * (1 - u) * (1 - u) : 0
      const cr = this.paper.r + (this.ink.r - this.paper.r) * k
      const cg = this.paper.g + (this.ink.g - this.paper.g) * k
      const cb = this.paper.b + (this.ink.b - this.paper.b) * k
      for (let t = 0; t < T; t++) {
        const a = p.phase + t / T * Math.PI * 2
        const ca = Math.cos(a), sa = Math.sin(a)
        const v = (i * T + t) * 6
        const r1 = p.live ? r : 0
        const r2 = p.live ? r + len : 0
        this.pos[v] = p.x + ca * r1
        this.pos[v + 1] = p.live ? 0.0015 : -1
        this.pos[v + 2] = p.z + sa * r1
        this.pos[v + 3] = p.x + ca * r2
        this.pos[v + 4] = p.live ? y : -1
        this.pos[v + 5] = p.z + sa * r2
        this.col[v] = this.col[v + 3] = cr
        this.col[v + 1] = this.col[v + 4] = cg
        this.col[v + 2] = this.col[v + 5] = cb
      }
    }
    this.geo.attributes.position!.needsUpdate = true
    this.geo.attributes.color!.needsUpdate = true
    this.dirty = any
    // Nothing alive: skip the draw call altogether.
    this.lines.visible = any
  }

  dispose() {
    this.lines.removeFromParent()
    this.geo.dispose()
    this.mat.dispose()
  }
}
