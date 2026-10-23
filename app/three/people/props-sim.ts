import { rng } from '../core/rng'

/**
 * Physics of the art props, pure (no three.js) so the tests step exactly what
 * the scene steps. All of it is damped and every input is clamped, so nothing
 * can wind up or run away however hard the pointer shakes it; with the wind
 * gone, everything settles back to rest.
 */

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const TAU = Math.PI * 2

/** Ambient breeze: a few incommensurate sines, seeded. Deterministic and bounded by `amp`. */
export function breeze(seed: number, amp: number) {
  const r = rng(seed)
  const parts = Array.from({ length: 3 }, () => ({ f: r.range(0.05, 0.23), p: r.range(0, TAU), a: r.range(0.5, 1) }))
  const sum = parts.reduce((n, q) => n + q.a, 0)
  return (t: number, axis: number) => {
    let v = 0
    for (const q of parts) v += q.a * Math.sin(TAU * q.f * t + q.p + axis * 1.9)
    return (amp * v) / sum
  }
}

// ── Mobile ────────────────────────────────────────────────────────────────

export interface MobileLevel {
  /** Signed distance from the hang point to the beam's centre of area (positive = toward its +X end). */
  areaArm: number
  /** Area moment, scaled: how strongly wind turns this level. */
  area: number
  /** Rotational inertia (kg m^2, scaled). */
  inertia: number
}

/**
 * A hanging mobile: each level yaws on its thread (a torsion spring: the
 * thread's twist restores, air damps), carried by the level above it. Wind
 * pushes the larger side of each arm downwind, like a weathervane. The whole
 * mobile also sways a little on its top thread (a damped pendulum).
 */
export class MobileSim {
  readonly theta: number[]
  readonly omega: number[]
  /** Sway of the top thread, radians about X and Z. */
  sway = [0, 0]
  swayV = [0, 0]
  windX = 0
  windZ = 0
  t = 0
  ambient: ((t: number, axis: number) => number) | null
  static readonly MAX_WIND = 3
  /** Twist stiffness of a thread, N m / rad, and the damping ratio of each level (lightly damped: a mobile keeps turning). */
  static readonly K = 0.0016
  static readonly ZETA = 0.16

  constructor(readonly levels: MobileLevel[], seed = 1, ambient = true) {
    this.theta = levels.map(() => 0)
    this.omega = levels.map(() => 0)
    this.ambient = ambient ? breeze(seed, 0.35) : null
  }

  /** Pointer wind, world m/s; it decays on its own. */
  wind(vx: number, vz: number) {
    const s = Math.hypot(vx, vz)
    const k = s > MobileSim.MAX_WIND ? MobileSim.MAX_WIND / s : 1
    this.windX = clamp(this.windX + vx * k * 0.5, -MobileSim.MAX_WIND, MobileSim.MAX_WIND)
    this.windZ = clamp(this.windZ + vz * k * 0.5, -MobileSim.MAX_WIND, MobileSim.MAX_WIND)
  }

  /** Tap: a push that sets alternate levels turning opposite ways. */
  push(strength = 1) {
    this.omega.forEach((_, i) => { this.omega[i] = clamp(this.omega[i]! + (i % 2 ? -1 : 1) * 1.4 * strength, -6, 6) })
    this.swayV[0] = clamp(this.swayV[0]! + 0.12 * strength, -1, 1)
  }

  step(dt: number) {
    this.t += dt
    const wx = this.windX + (this.ambient?.(this.t, 0) ?? 0)
    const wz = this.windZ + (this.ambient?.(this.t, 1) ?? 0)
    // Pointer wind fades in about a second.
    const fade = Math.exp(-dt * 1.6)
    this.windX *= fade
    this.windZ *= fade
    let yaw = 0
    for (let i = 0; i < this.levels.length; i++) {
      const L = this.levels[i]!
      yaw += this.theta[i]!
      // Torque of a drag force on the arm's centre of area: r x F about Y.
      const tau = L.area * L.areaArm * (-Math.sin(yaw) * wx - Math.cos(yaw) * wz)
      const c = 2 * MobileSim.ZETA * Math.sqrt(MobileSim.K * L.inertia)
      const acc = (tau - MobileSim.K * this.theta[i]! - c * this.omega[i]!) / L.inertia
      this.omega[i] = clamp(this.omega[i]! + acc * dt, -6, 6)
      this.theta[i] = this.theta[i]! + this.omega[i]! * dt
    }
    // Top-thread sway: a damped pendulum (about 0.8 Hz) leaning with the wind.
    const w0 = TAU * 0.8
    const lean = [clamp(0.02 * wz, -0.06, 0.06), clamp(-0.02 * wx, -0.06, 0.06)]
    for (let a = 0; a < 2; a++) {
      this.swayV[a] = this.swayV[a]! + (w0 * w0 * (lean[a]! - this.sway[a]!) - 2 * 0.12 * w0 * this.swayV[a]!) * dt
      this.sway[a] = clamp(this.sway[a]! + this.swayV[a]! * dt, -0.2, 0.2)
    }
  }

  energy() {
    let e = 0
    this.levels.forEach((L, i) => { e += 0.5 * L.inertia * this.omega[i]! ** 2 + 0.5 * MobileSim.K * this.theta[i]! ** 2 })
    return e + 0.5 * (this.swayV[0]! ** 2 + this.swayV[1]! ** 2)
  }
}

// ── Kite ──────────────────────────────────────────────────────────────────

export type V3 = [number, number, number]

/**
 * A kite as a point mass: wind drag pushes it downwind, lift holds it up,
 * gravity pulls it down, and the string -- inextensible-ish, a stiff spring
 * that only pulls -- holds it at the line length. Linear drag damps every
 * direction, so it always settles to the equilibrium where the string angle
 * balances lift against drag. A tug reels the line in briefly: the kite dips
 * toward the flyer, then climbs back.
 */
export class KiteSim {
  readonly p: V3
  readonly v: V3 = [0, 0, 0]
  anchor: V3
  lineLen: number
  /** Temporary reel-in, metres; springs back to 0. */
  reel = 0
  reelV = 0
  t = 0
  gusts: ((t: number, axis: number) => number) | null
  /** Wind direction (unit, horizontal) and speed, m/s. */
  windDir: [number, number]
  windSpeed = 3
  static readonly MASS = 0.3
  static readonly DRAG = 0.6
  static readonly LIFT = 1.8
  static readonly K = 60
  static readonly G = 9.81

  constructor(anchor: V3, lineLen: number, windDir: [number, number], seed = 1, gusts = true) {
    this.anchor = [...anchor] as V3
    this.lineLen = lineLen
    const l = Math.hypot(windDir[0], windDir[1]) || 1
    this.windDir = [windDir[0] / l, windDir[1] / l]
    // Start at the equilibrium angle, so the kite is flying from the first frame.
    const eq = this.equilibriumElevation()
    this.p = [
      anchor[0] + this.windDir[0] * lineLen * Math.cos(eq),
      anchor[1] + lineLen * Math.sin(eq),
      anchor[2] + this.windDir[1] * lineLen * Math.cos(eq),
    ]
    this.gusts = gusts ? breeze(seed, 0.6) : null
  }

  equilibriumElevation() {
    const up = KiteSim.LIFT * this.windSpeed - KiteSim.MASS * KiteSim.G
    return Math.atan2(up, KiteSim.DRAG * this.windSpeed)
  }

  tug(strength = 1) {
    this.reelV = clamp(this.reelV + 2.2 * strength, 0, 4)
  }

  /** Current string length (shortened while reeling in). */
  get length() {
    return Math.max(0.3, this.lineLen - this.reel)
  }

  step(dt: number) {
    this.t += dt
    const gust = this.gusts ? 1 + this.gusts(this.t, 0) : 1
    const side = this.gusts ? 0.7 * this.gusts(this.t, 1) : 0
    const ws = this.windSpeed * gust
    const wx = this.windDir[0] * ws - this.windDir[1] * side
    const wz = this.windDir[1] * ws + this.windDir[0] * side
    const m = KiteSim.MASS
    const F: V3 = [
      KiteSim.DRAG * (wx - this.v[0]),
      KiteSim.LIFT * ws - m * KiteSim.G - KiteSim.DRAG * this.v[1],
      KiteSim.DRAG * (wz - this.v[2]),
    ]
    // Reel: a damped spring back to the full line (about 0.7 s).
    this.reelV += (-28 * this.reel - 9 * this.reelV) * dt
    this.reel = clamp(this.reel + this.reelV * dt, 0, 0.8)
    const d: V3 = [this.p[0] - this.anchor[0], this.p[1] - this.anchor[1], this.p[2] - this.anchor[2]]
    const c = Math.hypot(d[0], d[1], d[2])
    const L = this.length
    if (c > L && c > 1e-6) {
      const u: V3 = [d[0] / c, d[1] / c, d[2] / c]
      const vr = this.v[0] * u[0] + this.v[1] * u[1] + this.v[2] * u[2]
      const pull = KiteSim.K * (c - L) + 6 * Math.max(0, vr)
      F[0] -= pull * u[0]
      F[1] -= pull * u[1]
      F[2] -= pull * u[2]
    }
    for (let a = 0; a < 3; a++) {
      this.v[a] = clamp(this.v[a]! + (F[a]! / m) * dt, -12, 12)
      this.p[a] = this.p[a]! + this.v[a]! * dt
    }
    // The kite never flies below its flyer's hand.
    if (this.p[1] < this.anchor[1] + 0.2) {
      this.p[1] = this.anchor[1] + 0.2
      this.v[1] = Math.max(0, this.v[1])
    }
  }
}

/**
 * Points of a catenary of length `L` hanging between A and B (B may be higher),
 * written into `out` as xyz triples, n + 1 points. A string shorter than the
 * chord is drawn straight. The curve lies in the vertical plane through A, B.
 */
export function catenary(A: V3, B: V3, L: number, n: number, out: Float32Array) {
  const dx = B[0] - A[0], dz = B[2] - A[2]
  const h = Math.hypot(dx, dz)
  const v = B[1] - A[1]
  const chord = Math.hypot(h, v)
  const straight = () => {
    for (let i = 0; i <= n; i++) {
      const s = i / n
      out[i * 3] = A[0] + dx * s
      out[i * 3 + 1] = A[1] + v * s
      out[i * 3 + 2] = A[2] + dz * s
    }
  }
  if (h < 1e-4 || L <= chord * 1.0001) {
    straight()
    return 0
  }
  // Solve sqrt(L^2 - v^2) = 2 a sinh(h / (2 a)) for a (bisection on a log scale; monotone in a).
  const target = Math.sqrt(L * L - v * v)
  let lo = 1e-4, hi = 1e4
  for (let it = 0; it < 80; it++) {
    const a = Math.sqrt(lo * hi)
    const val = 2 * a * Math.sinh(h / (2 * a))
    if (!Number.isFinite(val) || val > target) lo = a
    else hi = a
  }
  const a = Math.sqrt(lo * hi)
  // Vertex offset: y = a cosh((x - x0) / a) + c through (0, 0) and (h, v).
  const x0 = h / 2 - a * Math.atanh(clamp(v / L, -0.999999, 0.999999))
  const c0 = -a * Math.cosh(-x0 / a)
  const ux = dx / h, uz = dz / h
  for (let i = 0; i <= n; i++) {
    const x = (h * i) / n
    const y = a * Math.cosh((x - x0) / a) + c0
    out[i * 3] = A[0] + ux * x
    out[i * 3 + 1] = A[1] + y
    out[i * 3 + 2] = A[2] + uz * x
  }
  return a
}

// ── Pendulum (lantern) and rocking pots ───────────────────────────────────

/** Small-angle spherical pendulum: two damped tilts, driven by wind. */
export class PendulumSim {
  readonly a = [0, 0]
  readonly v = [0, 0]
  windX = 0
  windZ = 0
  t = 0
  ambient: ((t: number, axis: number) => number) | null
  constructor(readonly length: number, readonly zeta = 0.06, seed = 1, ambient = true) {
    this.ambient = ambient ? breeze(seed, 0.25) : null
  }

  wind(vx: number, vz: number) {
    this.windX = clamp(this.windX + vx * 0.5, -3, 3)
    this.windZ = clamp(this.windZ + vz * 0.5, -3, 3)
  }

  push(dirX: number, dirZ: number, strength = 1) {
    const l = Math.hypot(dirX, dirZ) || 1
    this.v[0] = clamp(this.v[0]! + (dirZ / l) * 0.9 * strength, -3, 3)
    this.v[1] = clamp(this.v[1]! - (dirX / l) * 0.9 * strength, -3, 3)
  }

  step(dt: number) {
    this.t += dt
    const w0 = Math.sqrt(9.81 / this.length)
    const wx = this.windX + (this.ambient?.(this.t, 0) ?? 0)
    const wz = this.windZ + (this.ambient?.(this.t, 1) ?? 0)
    const fade = Math.exp(-dt * 1.6)
    this.windX *= fade
    this.windZ *= fade
    // Tilt about X follows wind along Z; tilt about Z follows wind along -X.
    const drive = [0.05 * wz, -0.05 * wx]
    for (let i = 0; i < 2; i++) {
      this.v[i] = this.v[i]! + (w0 * w0 * (drive[i]! - this.a[i]!) - 2 * this.zeta * w0 * this.v[i]!) * dt
      this.a[i] = clamp(this.a[i]! + this.v[i]! * dt, -0.6, 0.6)
    }
  }
}

/** A pot rocking on its base rim: a damped oscillator in tilt, about a direction. */
export class RockSim {
  phi = 0
  w = 0
  dir = 0
  constructor(readonly freq = 2.6, readonly zeta = 0.12) {}
  knock(dir: number, strength = 1) {
    this.dir = dir
    this.w = clamp(this.w + 1.1 * strength, -3, 3)
  }

  step(dt: number) {
    const w0 = TAU * this.freq
    this.w += (-w0 * w0 * this.phi - 2 * this.zeta * w0 * this.w) * dt
    this.phi = clamp(this.phi + this.w * dt, -0.16, 0.16)
  }
}
