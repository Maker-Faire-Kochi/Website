import { rng, type Rng } from '../../core/rng'
import { DipCycle, type Phase } from './cycle'
import {
  BANK, CLUSTER_L, HANG_LOCAL, NET, NUT_R, NUTS, PALMS, TIP_LOCAL, WATER,
  boomToWorld, groundAt, netCorners, netPoint, palmPoint, rotY, type V3,
} from './layout'

/**
 * The whole backwater as plain numbers, stepped at the stage's fixed DT.
 * No three.js: the renderer only reads this state, and every random draw
 * goes through one seeded PRNG in a fixed order, so the same seed, step
 * count and inputs always give the same scene whatever the frame rate.
 *
 * Inputs (taps, keyboard actions, pointer lean) are queued and applied at
 * the start of the next step, never in between steps.
 *
 * Each step also lists the physical events it produced (`events`): the net
 * breaking the surface, a drip landing, a coconut leaving its crown, hitting
 * the bank or the water. The scene's sounds are triggered from these, so a
 * sound belongs to the exact step the thing is seen to happen -- and, being
 * deterministic state, they are unit-tested like the rest. The simulation
 * never plays anything itself.
 *
 * Steady state allocates nothing: every vector is a scratch member written in
 * place (only rare events -- a tap, a splash -- create small objects).
 */

export const G = 9.81

export interface Ring { on: boolean, x: number, z: number, r0: number, R: number, age: number, life: number, a0: number }
/** `drip`: shed by the lifted net (lands with a plink), not thrown up by a splash. */
export interface Drop { on: boolean, x: number, y: number, z: number, vx: number, vy: number, vz: number, drip: boolean }
export interface Wavelet { x: number, z: number, len: number, age: number, life: number }
export type BodyMode = 'off' | 'fall' | 'roll' | 'rest' | 'float' | 'shrink'
export interface Body {
  mode: BodyMode
  x: number, y: number, z: number
  vx: number, vy: number, vz: number
  px: number, py: number, pz: number
  /** Orientation quaternion [x, y, z, w] and world angular velocity. */
  q: [number, number, number, number]
  w: V3
  scale: number
  /** Seconds in the current mode. */
  t: number
  bounces: number
  /** An aimed fall's target (a child's head), until it is reached. */
  aim: V3 | null
}
export interface NutSlot { state: 'on' | 'off' | 'grow', t: number, grow: number }
export interface PalmState {
  /** Crown sway (rotation x, rotation z) and its rate; prev for interpolation. */
  sway: [number, number]
  vel: [number, number]
  prev: [number, number]
  /** Extra lean from the pointer, world-horizontal (x, z) radians, easing towards leanT. */
  lean: [number, number]
  leanT: [number, number]
  off: number
  nuts: NutSlot[]
}

/**
 * What happened during one step, for sound. `speed` is the impact speed
 * (m/s) or, for the splash, the boom's angular speed (rad/s); `fall` is the
 * seconds a released nut will take to reach the ground below it.
 */
export type SimEvent =
  | { kind: 'splash', x: number, z: number, speed: number }
  | { kind: 'drip', x: number, z: number }
  | { kind: 'nut-drop', palm: number, fall: number }
  | { kind: 'nut-bank', speed: number }
  | { kind: 'nut-plop', speed: number }
  | { kind: 'nut-bonk', speed: number, x: number, y: number, z: number }

export const RINGS = 32
export const DROPS = 64
export const WAVELETS = 30
export const BODIES = 8

/** Slow backwater current, along the bank. Wavelets and floating nuts drift with it. */
export const CURRENT: V3 = [-0.1, 0, 0.03]
/** Sea breeze blows inland (+x), so the crowns lean landward. */
const WIND_DIR: V3 = [1, 0, 0]

const SWAY_K = 16
const SWAY_C = 2.4
const BEND = 0.12
const REGROW_AFTER = 8
const GROW_TIME = 2.5
const REST_LIFE = 14
const FLOAT_LIFE = 10
const SHRINK_TIME = 0.8
/**
 * Pointer lean: at most LEAN_MAX rad of extra target tilt, eased in at
 * LEAN_RATE /s so the underdamped crown spring is never kicked by a step
 * (with the easing the crown's extra sway peaks below 0.08 rad -- tested).
 */
export const LEAN_MAX = 0.06
const LEAN_RATE = 5
/** A fast sweep across a crown flicks it: angular-rate kick, rad/s at most. */
export const BRUSH_MAX = 0.18
/** The net counts as out of the water again only once clear by this much, so one entry is one splash. */
const DRY_CLEAR = 0.03
/** Bank impacts slower than this are a nut settling, not a knock. */
const KNOCK_SPEED = 0.4

type Request = { kind: 'dip' } | { kind: 'drop', palm: number, aim?: V3 } | { kind: 'brush', palm: number, dx: number, dz: number }
/** An aimed fall counts as reaching its target within this horizontal distance (m). */
const AIM_TOL = 0.25

/** Smooth 1D value noise from a seeded table: wind gusts that never repeat visibly. */
function makeNoise(r: Rng) {
  const N = 256
  const table = Array.from({ length: N }, () => r.next())
  return (t: number) => {
    const i = Math.floor(t)
    const f = t - i
    const s = f * f * (3 - 2 * f)
    const a = table[((i % N) + N) % N]!
    const b = table[(((i + 1) % N) + N) % N]!
    return a + (b - a) * s
  }
}

/** Net sample points tracked for surface crossings: corners, edge middles, centre. */
const SAMPLES: [number, number][] = []
for (const u of [0, 0.5, 1]) for (const v of [0, 0.5, 1]) SAMPLES.push([u, v])

export class World {
  readonly cycle = new DipCycle()
  /** Keep the net raised while the crew land every fish and regrip the rope. */
  holdCycle = false
  /** Optional coconut reserved for the chapter's scroll-triggered sequence. */
  storyNut: readonly [number, number] | null = null
  time = 0
  theta: number
  prevTheta: number
  /** Net sag and its rate. */
  sag = NET.sag
  sagV = 0
  prevSag = NET.sag
  /** Counterweight pendulum swing (radians, + = towards +x) and rate. */
  phi = 0
  phiV = 0
  prevPhi = 0
  readonly palms: PalmState[]
  readonly rings: Ring[]
  readonly drops: Drop[]
  readonly wavelets: Wavelet[]
  readonly bodies: Body[]
  /** Physical events of the last step (cleared at the start of each step). */
  readonly events: SimEvent[] = []
  /** Some of the net is under the surface (with DRY_CLEAR hysteresis). */
  wet: boolean

  private r: Rng
  private noise: (t: number) => number
  private queue: Request[] = []
  /** Hang point now and one step ago (finite differences give its acceleration). */
  private hx: number
  private hy: number
  private hx1: number
  private hy1: number
  private readonly cw: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
  private readonly v: V3 = [0, 0, 0]
  private readonly sw: [number, number] = [0, 0]
  private readonly bd: [number, number] = [0, 0]
  private below: boolean[] = []
  private poleT = [0, 0, 0, 0]
  private dripT = 0
  private dripAcc = 0
  private dripped = false
  private lastPhase: Phase

  constructor(seed = 7) {
    this.r = rng(seed)
    this.noise = makeNoise(this.r)
    this.theta = this.prevTheta = this.cycle.theta
    this.lastPhase = this.cycle.phase
    this.palms = PALMS.map((_, i) => ({
      sway: [0, 0], vel: [0, 0], prev: [0, 0], lean: [0, 0], leanT: [0, 0],
      off: 37 * i + this.r.range(0, 20),
      nuts: NUTS.map(() => ({ state: 'on', t: 0, grow: 1 })),
    }))
    this.rings = Array.from({ length: RINGS }, () => ({ on: false, x: 0, z: 0, r0: 0, R: 0, age: 0, life: 1, a0: 0 }))
    this.drops = Array.from({ length: DROPS }, () => ({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, drip: false }))
    this.wavelets = Array.from({ length: WAVELETS }, () => {
      const w = { x: 0, z: 0, len: 0, age: 0, life: 1 }
      this.spawnWavelet(w)
      w.age = this.r.range(0, w.life)
      return w
    })
    this.bodies = Array.from({ length: BODIES }, () => ({
      mode: 'off', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0,
      q: [0, 0, 0, 1], w: [0, 0, 0], scale: 1, t: 0, bounces: 0, aim: null,
    }))
    const h = boomToWorld(HANG_LOCAL, this.theta)
    this.hx = this.hx1 = h[0]
    this.hy = this.hy1 = h[1]
    const c = netCorners(this.theta)
    this.below = SAMPLES.map(([u, v]) => netPoint(c, u, v, this.sag)[1] < 0)
    this.wet = this.below.some(b => b)
  }

  // ── Inputs ──────────────────────────────────────────────────────────────

  requestDip() {
    this.queue.push({ kind: 'dip' })
  }

  /**
   * Release a ripe nut from a palm. With `aim` (a world point), the nut leaves
   * the crown with just the horizontal speed that carries it, falling freely,
   * onto that point -- still a plain ballistic fall -- and when it gets there
   * it bounces off (event 'nut-bonk') and falls on to the ground.
   */
  requestDrop(palm: number, aim?: V3) {
    this.queue.push({ kind: 'drop', palm, aim: aim ? [aim[0], aim[1], aim[2]] : undefined })
  }

  /**
   * Pointer lean target for one palm (others relax), world-horizontal,
   * clamped to LEAN_MAX. The crown eases towards it in the steps that follow.
   */
  setLean(palm: number, dx: number, dz: number) {
    const l = Math.hypot(dx, dz)
    const k = l > LEAN_MAX ? LEAN_MAX / l : 1
    for (let i = 0; i < this.palms.length; i++) {
      const p = this.palms[i]!
      p.leanT[0] = i === palm ? dx * k : 0
      p.leanT[1] = i === palm ? dz * k : 0
    }
  }

  /** A hand brushing through a crown: flicks it along (dx, dz), |kick| <= BRUSH_MAX rad/s. */
  requestBrush(palm: number, dx: number, dz: number) {
    this.queue.push({ kind: 'brush', palm, dx, dz })
  }

  /** Pause: forget everything queued and any pointer lean. */
  clearInputs() {
    this.queue.length = 0
    this.setLean(-1, 0, 0)
  }

  get phase(): Phase {
    return this.cycle.phase
  }

  hasNut(palm: number) {
    return this.palms[palm]!.nuts.some((n, k) => n.state === 'on' && !(this.storyNut?.[0] === palm && this.storyNut[1] === k))
  }

  hasFreeBody() {
    return this.bodies.some(b => b.mode === 'off' || b.mode === 'rest' || b.mode === 'float')
  }

  // ── Kinematics helpers (pure reads) ─────────────────────────────────────

  bendOf(p: PalmState, alpha = 1, out: [number, number] = [0, 0]): [number, number] {
    out[0] = (p.prev[0] + (p.sway[0] - p.prev[0]) * alpha) * BEND
    out[1] = (p.prev[1] + (p.sway[1] - p.prev[1]) * alpha) * BEND
    return out
  }

  swayOf(p: PalmState, alpha = 1, out: [number, number] = [0, 0]): [number, number] {
    out[0] = p.prev[0] + (p.sway[0] - p.prev[0]) * alpha
    out[1] = p.prev[1] + (p.sway[1] - p.prev[1]) * alpha
    return out
  }

  /** World position of nut k on a palm's crown; pass `out` to reuse a vector. */
  nutWorld(palm: number, k: number, alpha = 1, out?: V3): V3 {
    const p = this.palms[palm]!
    return palmPoint(PALMS[palm]!, this.bendOf(p, alpha, this.bd), this.swayOf(p, alpha, this.sw), NUTS[k]!, out)
  }

  // ── Step ────────────────────────────────────────────────────────────────

  step(dt: number) {
    this.events.length = 0
    for (const q of this.queue) {
      if (q.kind === 'dip') { if (!this.holdCycle) this.cycle.dip() }
      else if (q.kind === 'drop') this.drop(q.palm, q.aim)
      else this.brush(q.palm, q.dx, q.dz)
    }
    this.queue.length = 0

    this.time += dt
    if (!this.holdCycle) this.cycle.step(dt)
    this.prevTheta = this.theta
    this.theta = this.cycle.theta
    const omega = (this.theta - this.prevTheta) / dt
    const phase = this.cycle.phase
    if (phase === 'lower' && this.lastPhase !== 'lower') this.dripped = false
    this.lastPhase = phase

    this.stepCounterweight(dt)
    this.stepNet(dt, omega, phase)
    this.stepPalms(dt)
    this.stepBodies(dt)
    this.stepDrops(dt)
    this.stepRings(dt)
    this.stepWavelets(dt)
  }

  /**
   * The stones hang from the boom's rear end and swing as one pendulum. The
   * hang point is driven by the boom; its acceleration (finite differences
   * of its path) is what sets the stones swinging at every start and stop.
   */
  private stepCounterweight(dt: number) {
    this.prevPhi = this.phi
    const h = boomToWorld(HANG_LOCAL, this.theta, this.v)
    const ax = (h[0] - 2 * this.hx + this.hx1) / (dt * dt)
    const ay = (h[1] - 2 * this.hy + this.hy1) / (dt * dt)
    this.hx1 = this.hx
    this.hy1 = this.hy
    this.hx = h[0]
    this.hy = h[1]
    const acc = -((G + ay) * Math.sin(this.phi) + ax * Math.cos(this.phi)) / CLUSTER_L - 0.9 * this.phiV
    this.phiV += acc * dt
    this.phi += this.phiV * dt
  }

  private stepNet(dt: number, omega: number, phase: Phase) {
    // Cloth: the net bellies down when hauled out heavy with water and lifts
    // a little as it is dropped through the air.
    this.prevSag = this.sag
    const target = NET.sag + Math.max(-0.2, Math.min(0.35, omega > 0 ? omega * 0.9 : omega * 0.6))
    this.sagV += (25 * (target - this.sag) - 7 * this.sagV) * dt
    this.sag += this.sagV * dt

    const c = netCorners(this.theta, this.cw)
    let minY = Infinity
    for (let i = 0; i < SAMPLES.length; i++) {
      const u = SAMPLES[i]![0]
      const v = SAMPLES[i]![1]
      const p = netPoint(c, u, v, this.sag, this.v)
      minY = Math.min(minY, p[1])
      const below = p[1] < 0
      if (below !== this.below[i]) {
        const centre = u === 0.5 && v === 0.5
        const corner = u !== 0.5 && v !== 0.5
        this.ring(p[0], p[2], centre ? 1.7 : corner ? 1.0 : 1.25, 2.6, 0.7)
      }
      this.below[i] = below
    }
    // The net breaking the surface: once per entry, on the step its first
    // point goes under (the step its first rings appear).
    if (!this.wet && minY < 0) {
      this.wet = true
      const x = (c[0]![0] + c[1]![0] + c[2]![0] + c[3]![0]) / 4
      const z = (c[0]![2] + c[1]![2] + c[2]![2] + c[3]![2]) / 4
      this.events.push({ kind: 'splash', x, z, speed: Math.abs(omega) })
    }
    else if (this.wet && minY > DRY_CLEAR) {
      this.wet = false
    }

    // Where a spreader pole pierces the surface, small rings keep coming.
    // The spreader ends are exactly the net corners computed above.
    const tip = boomToWorld(TIP_LOCAL, this.theta, this.v)
    for (let k = 0; k < 4; k++) {
      const cw = c[k]!
      this.poleT[k] = this.poleT[k]! - dt
      if (tip[1] > 0 && cw[1] < 0 && this.poleT[k]! <= 0) {
        const s = tip[1] / (tip[1] - cw[1])
        this.ring(tip[0] + (cw[0] - tip[0]) * s, tip[2] + (cw[2] - tip[2]) * s, this.r.range(0.35, 0.6), 1.5, 0.6)
        this.poleT[k] = this.r.range(1.0, 1.7)
      }
    }

    // Dripping: once the whole net is clear of the water on the way up.
    if (phase === 'lift' && !this.dripped && minY > 0.03) {
      this.dripped = true
      this.dripT = 2.8
    }
    if (this.dripT > 0) {
      this.dripT -= dt
      this.dripAcc += 26 * Math.max(0, this.dripT / 2.8) * dt
      while (this.dripAcc >= 1) {
        this.dripAcc -= 1
        const p = netPoint(c, this.r.range(0.08, 0.92), this.r.range(0.08, 0.92), this.sag, this.v)
        if (p[1] > 0.05) this.spawnDrop(p[0], p[1], p[2], 0, -0.2, 0, true)
      }
    }
  }

  private stepPalms(dt: number) {
    for (let i = 0; i < this.palms.length; i++) {
      const p = this.palms[i]!
      const spec = PALMS[i]!
      p.prev[0] = p.sway[0]
      p.prev[1] = p.sway[1]
      // The pointer lean eases in and out (exactly 0 when never used).
      const ke = Math.min(1, LEAN_RATE * dt)
      p.lean[0] += (p.leanT[0] - p.lean[0]) * ke
      p.lean[1] += (p.leanT[1] - p.lean[1]) * ke
      // Gusts: two slow octaves of seeded noise, a steady push plus a gentle
      // cross drift. Slow on purpose: a sea breeze leans a crown over seconds,
      // it does not shake it (a faster octave read as fidgeting).
      const t = this.time + p.off
      const gust = 0.5 * this.noise(t * 0.2) + 0.5 * this.noise(t * 0.5 + 91)
      const cross = this.noise(t * 0.25 + 173) - 0.5
      const push = 0.012 + 0.05 * gust
      // World tilt direction -> this palm's yaw frame; tilt towards d is (x: d.z, z: -d.x).
      const wx = WIND_DIR[0] * push + p.lean[0]
      const wz = WIND_DIR[2] * push + 0.03 * cross + p.lean[1]
      const d = this.v
      d[0] = wx
      d[1] = 0
      d[2] = wz
      rotY(d, -spec.yaw, d)
      const tx = d[2]
      const tz = -d[0]
      p.vel[0] += (SWAY_K * (tx - p.sway[0]) - SWAY_C * p.vel[0]) * dt
      p.vel[1] += (SWAY_K * (tz - p.sway[1]) - SWAY_C * p.vel[1]) * dt
      p.sway[0] += p.vel[0] * dt
      p.sway[1] += p.vel[1] * dt

      for (const n of p.nuts) {
        if (n.state === 'off') {
          n.t -= dt
          if (n.t <= 0) {
            n.state = 'grow'
            n.grow = 0
          }
        }
        else if (n.state === 'grow') {
          n.grow = Math.min(1, n.grow + dt / GROW_TIME)
          if (n.grow >= 1) n.state = 'on'
        }
      }
    }
  }

  /**
   * A few drops thrown up at a point (a fish flapping in the lifted net): they
   * fall back and ring the water like any other drop.
   */
  splash(x: number, y: number, z: number, n: number) {
    for (let i = 0; i < n; i++) {
      const a = this.r.range(0, Math.PI * 2)
      const sp = this.r.range(0.2, 0.5)
      this.spawnDrop(x, y, z, Math.cos(a) * sp, this.r.range(0.6, 1.2), Math.sin(a) * sp, false)
    }
  }

  /** A drip or splash drop; silently skipped when the pool is full. */
  private spawnDrop(x: number, y: number, z: number, vx: number, vy: number, vz: number, drip: boolean) {
    for (const d of this.drops) {
      if (d.on) continue
      d.on = true
      d.x = x
      d.y = y
      d.z = z
      d.vx = vx
      d.vy = vy
      d.vz = vz
      d.drip = drip
      return
    }
  }

  /** Flick a crown: an angular-rate kick along world (dx, dz), in the palm's frame like the wind. */
  private brush(palm: number, dx: number, dz: number) {
    const p = this.palms[palm]
    if (!p) return
    const l = Math.hypot(dx, dz)
    const k = l > BRUSH_MAX ? BRUSH_MAX / l : 1
    const d = this.v
    d[0] = dx * k
    d[1] = 0
    d[2] = dz * k
    rotY(d, -PALMS[palm]!.yaw, d)
    p.vel[0] += d[2]
    p.vel[1] += -d[0]
  }

  /** Releases one ripe coconut from a palm. */
  private drop(palm: number, aim?: V3) {
    const p = this.palms[palm]
    if (!p) return
    const ripe = p.nuts.map((n, k) => n.state === 'on' && !(this.storyNut?.[0] === palm && this.storyNut[1] === k) ? k : -1).filter(k => k >= 0)
    if (!ripe.length) return
    // Reuse a free body, else the one that has lain longest.
    let b = this.bodies.find(x => x.mode === 'off')
    if (!b) {
      const idle = this.bodies.filter(x => x.mode === 'rest' || x.mode === 'float')
      if (!idle.length) return
      b = idle.reduce((m, x) => (x.t > m.t ? x : m))
    }
    let k = ripe[Math.floor(this.r.next() * ripe.length) % ripe.length]!
    // An aimed drop takes the ripe nut nearest the target: it falls, it is not thrown.
    if (aim) {
      let bd = Infinity
      for (const j of ripe) {
        const q = this.nutWorld(palm, j)
        const d = Math.hypot(q[0] - aim[0], q[2] - aim[2])
        if (d < bd) {
          bd = d
          k = j
        }
      }
    }
    const slot = p.nuts[k]!
    const pos = this.nutWorld(palm, k)
    const a = this.r.range(0, Math.PI * 2)
    const sp = this.r.range(0.15, 0.4)
    Object.assign(b, {
      mode: 'fall', x: pos[0], y: pos[1], z: pos[2], px: pos[0], py: pos[1], pz: pos[2],
      vx: Math.cos(a) * sp, vy: 0, vz: Math.sin(a) * sp, scale: 1, t: 0, bounces: 0,
    })
    b.q = [0, 0, 0, 1]
    b.w = [this.r.range(-4, 4), this.r.range(-2, 2), this.r.range(-4, 4)]
    b.aim = null
    if (aim && aim[1] < pos[1] - 0.5) {
      // Time to fall to the target's height from rest, then the drift that lands it there.
      const T = Math.sqrt(2 * (pos[1] - aim[1]) / G)
      b.vx = (aim[0] - pos[0]) / T
      b.vz = (aim[2] - pos[2]) / T
      b.aim = [aim[0], aim[1], aim[2]]
    }
    slot.state = 'off'
    slot.t = REGROW_AFTER
    slot.grow = 0
    const h = Math.max(0, pos[1] - NUT_R - groundAt(pos[0]))
    this.events.push({ kind: 'nut-drop', palm, fall: Math.sqrt(2 * h / G) })
  }

  private stepBodies(dt: number) {
    const R = NUT_R
    for (const b of this.bodies) {
      b.px = b.x
      b.py = b.y
      b.pz = b.z
      if (b.mode === 'off') continue
      b.t += dt
      if (b.mode === 'fall') {
        b.vy -= G * dt
        b.x += b.vx * dt
        b.y += b.vy * dt
        b.z += b.vz * dt
        // An aimed nut reaching its target: a glancing bounce up and off to one side.
        const aim = b.aim
        if (aim && b.y <= aim[1]) {
          b.aim = null
          if (Math.hypot(b.x - aim[0], b.z - aim[2]) <= AIM_TOL) {
            this.events.push({ kind: 'nut-bonk', speed: -b.vy, x: b.x, y: b.y, z: b.z })
            const side = this.r.next() < 0.5 ? -1 : 1
            const hx = b.vx
            const hz = b.vz
            b.vy = 0.3 * -b.vy
            b.vx = 0.35 * hx - side * 0.9 * hz / (Math.hypot(hx, hz) || 1)
            b.vz = 0.35 * hz + side * 0.9 * hx / (Math.hypot(hx, hz) || 1)
            b.w = [this.r.range(-6, 6), this.r.range(-3, 3), this.r.range(-6, 6)]
          }
        }
        // The seawall face: a nut dropping past the edge must not pass into it.
        if (b.x < BANK.x0 && b.x > BANK.x0 - R && b.y < BANK.top) {
          b.x = BANK.x0 - R
          if (b.vx > 0) b.vx *= -0.3
        }
        this.keepInside(b)
        if (b.x >= BANK.x0) {
          if (b.y - R <= BANK.top) {
            b.y = BANK.top + R
            if (-b.vy > KNOCK_SPEED) this.events.push({ kind: 'nut-bank', speed: -b.vy })
            if (b.vy < -0.9 && b.bounces < 3) {
              // A husk is lumpy: each bounce throws it off sideways.
              b.bounces++
              b.vy = -0.32 * b.vy
              const a = this.r.range(0, Math.PI * 2)
              const kick = this.r.range(0.5, 1.1) / b.bounces
              b.vx = b.vx * 0.5 + Math.cos(a) * kick
              b.vz = b.vz * 0.5 + Math.sin(a) * kick
            }
            else {
              b.vy = 0
              b.mode = 'roll'
              b.t = 0
            }
          }
        }
        else if (b.y - R <= 0) {
          // Plop: rings and a splash, then it bobs up and floats.
          this.events.push({ kind: 'nut-plop', speed: -b.vy })
          this.ring(b.x, b.z, 0.8, 2.2, 0.85)
          this.ring(b.x, b.z, 0.5, 1.6, 0.6)
          for (let i = 0; i < 6; i++) {
            const a = this.r.range(0, Math.PI * 2)
            const s = this.r.range(0.4, 0.9)
            this.spawnDrop(b.x, 0.02, b.z, Math.cos(a) * s, this.r.range(1.4, 2.4), Math.sin(a) * s, false)
          }
          b.y = R
          b.vy = Math.max(b.vy * 0.1, -0.8)
          b.vx *= 0.3
          b.vz *= 0.3
          b.mode = 'float'
          b.t = 0
        }
      }
      else if (b.mode === 'roll') {
        const s = Math.hypot(b.vx, b.vz)
        const ns = Math.max(0, s - 0.22 * G * dt)
        if (ns < 0.03) {
          b.vx = b.vz = 0
          b.mode = 'rest'
          b.t = 0
        }
        else {
          b.vx *= ns / s
          b.vz *= ns / s
          b.x += b.vx * dt
          b.z += b.vz * dt
          // Rolling without slipping: spin about up x direction at speed / radius.
          b.w[0] = b.vz / R
          b.w[1] = 0
          b.w[2] = -b.vx / R
          this.keepInside(b)
          if (b.x < BANK.x0) {
            b.mode = 'fall'
            b.t = 0
          }
        }
      }
      else if (b.mode === 'float') {
        b.vy += (-36 * (b.y - 0.02) - 4.5 * b.vy) * dt
        b.y += b.vy * dt
        b.vx += (CURRENT[0] - b.vx) * 1.5 * dt
        b.vz += (CURRENT[2] - b.vz) * 1.5 * dt
        b.x = Math.min(b.x + b.vx * dt, BANK.x0 - R)
        b.z += b.vz * dt
        this.keepInside(b)
        b.w[0] = b.w[0] * (1 - 2 * dt)
        b.w[1] = b.w[1] * (1 - 2 * dt)
        b.w[2] = b.w[2] * (1 - 2 * dt)
        if (b.t > FLOAT_LIFE) {
          b.mode = 'shrink'
          b.t = 0
        }
      }
      else if (b.mode === 'rest') {
        b.w[0] = b.w[1] = b.w[2] = 0
        if (b.t > REST_LIFE) {
          b.mode = 'shrink'
          b.t = 0
        }
      }
      else if (b.mode === 'shrink') {
        b.scale = Math.max(0, 1 - b.t / SHRINK_TIME)
        if (b.scale <= 0) b.mode = 'off'
      }
      integrate(b.q, b.w, dt)
    }
  }

  private keepInside(b: Body) {
    const R = NUT_R
    if (b.x > BANK.x1 - R) {
      b.x = BANK.x1 - R
      b.vx = -0.3 * Math.abs(b.vx)
    }
    if (b.x < WATER.x0 + R) {
      b.x = WATER.x0 + R
      b.vx = 0.3 * Math.abs(b.vx)
    }
    if (b.z < BANK.z0 + R) {
      b.z = BANK.z0 + R
      b.vz = 0.3 * Math.abs(b.vz)
    }
    if (b.z > BANK.z1 - R) {
      b.z = BANK.z1 - R
      b.vz = -0.3 * Math.abs(b.vz)
    }
  }

  private stepDrops(dt: number) {
    for (const d of this.drops) {
      if (!d.on) continue
      d.vy -= G * dt
      d.x += d.vx * dt
      d.y += d.vy * dt
      d.z += d.vz * dt
      if (d.y <= groundAt(d.x) && d.vy < 0) {
        d.on = false
        if (d.drip && d.x < BANK.x0) this.events.push({ kind: 'drip', x: d.x, z: d.z })
        if (d.x < BANK.x0 && this.r.next() < 0.5) this.ring(d.x, d.z, this.r.range(0.14, 0.26), 0.8, 0.55)
      }
    }
  }

  private ring(x: number, z: number, R: number, life: number, a0: number) {
    // A free ring, else the one furthest through its life.
    let g: Ring | null = null
    for (const r of this.rings) {
      if (!r.on) {
        g = r
        break
      }
    }
    if (!g) {
      g = this.rings[0]!
      for (const r of this.rings) if (r.age / r.life > g.age / g.life) g = r
    }
    g.on = true
    g.x = x
    g.z = z
    g.r0 = Math.min(0.08, R * 0.3)
    g.R = R
    g.age = 0
    g.life = life
    g.a0 = a0
  }

  private stepRings(dt: number) {
    for (const g of this.rings) {
      if (!g.on) continue
      g.age += dt
      if (g.age >= g.life) g.on = false
    }
  }

  private spawnWavelet(w: Wavelet) {
    w.x = this.r.range(WATER.x0 + 1.0, WATER.x1 - 1.4)
    w.z = this.r.range(WATER.z0 + 0.8, WATER.z1 - 1.4)
    w.len = this.r.range(0.35, 0.8)
    w.life = this.r.range(5, 9)
    w.age = 0
  }

  private stepWavelets(dt: number) {
    for (const w of this.wavelets) {
      w.age += dt
      w.x += CURRENT[0] * dt
      w.z += CURRENT[2] * dt
      if (w.age >= w.life) this.spawnWavelet(w)
    }
  }

  /** Everything that defines the state, as plain numbers (tests compare these). */
  snapshot() {
    return JSON.stringify({
      t: this.cycle.t, th: this.theta, sag: this.sag, phi: this.phi,
      palms: this.palms.map(p => [p.sway, p.vel, p.lean, p.leanT, p.nuts.map(n => [n.state, n.t, n.grow])]),
      rings: this.rings, drops: this.drops, wavelets: this.wavelets,
      bodies: this.bodies.map(b => [b.mode, b.x, b.y, b.z, b.vx, b.vy, b.vz, b.q, b.scale, b.aim]),
    })
  }
}

/** q += 0.5 * dt * (w as a pure quaternion) * q, renormalised. */
function integrate(q: [number, number, number, number], w: V3, dt: number) {
  const [x, y, z, s] = q
  const h = 0.5 * dt
  const nx = x + h * (w[0] * s + w[1] * z - w[2] * y)
  const ny = y + h * (w[1] * s + w[2] * x - w[0] * z)
  const nz = z + h * (w[2] * s + w[0] * y - w[1] * x)
  const ns = s - h * (w[0] * x + w[1] * y + w[2] * z)
  const l = Math.hypot(nx, ny, nz, ns) || 1
  q[0] = nx / l
  q[1] = ny / l
  q[2] = nz / l
  q[3] = ns / l
}
