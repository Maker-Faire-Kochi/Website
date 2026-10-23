import { approach, clamp } from './kin'

/**
 * A PROCEDURAL, KINEMATIC step planner shared by the dog (a trot: diagonal
 * pairs) and Makey (a biped walk: one foot at a time). Pure TypeScript, no
 * three.js; nothing here is physically simulated.
 *
 * Feet are split into swing GROUPS that take turns: the dog's are its two
 * diagonals, Makey's are its two feet. A phase clock decides when a group
 * lifts and lands; footholds are planned in WORLD space from the body's
 * predicted (eased) motion; the owner moves the body along that reference
 * and solves its legs with IK, so every sole lands where it was planned.
 *
 * The guarantees the tests hold it to (the same ones as the duck's gait):
 * - A planted foot NEVER moves. Its entry is written once, at touchdown, and
 *   nothing touches it until liftoff. If the body would outrun a planted foot,
 *   the GOVERNOR slows the body; the foot is never clamped.
 * - Swing feet travel on raised-cosine arcs: eased along the ground, a smooth
 *   lift and a soft set-down.
 * - Starting and stopping come out as half steps, because footholds are
 *   planned from the predicted body motion; a stop only happens on a squared
 *   stance with the body at rest.
 * - Turning rotates successive footholds; the turn per step is bounded.
 *
 * Everything advances in step(dt) only, so a run replays exactly.
 */

export interface Foot { x: number, y: number, z: number, yaw: number }
export interface Command { speed: number, yawRate: number, strafe?: number }

export interface StepperSpec {
  /** Nominal foothold of each foot in the body frame (x = left, z = forward), on the ground. */
  feet: { x: number, z: number }[]
  /** Swing groups, alternating. */
  groups: number[][]
  /** One step (one group's swing plus its share of support), s. */
  stepTime: number
  staggerStepTime: number
  /** Support share of each step during which no foot is in the air. */
  ds: number
  swingH: number
  maxSpeed: number
  maxBack: number
  maxYawRate: number
  maxStrafe: number
  accel: number
  yawAccel: number
  govAccel: number
  govYawAccel: number
  staggerAccel: number
  /** Governor: furthest a planted foot may drift from its nominal place, along and across the body (m). */
  reach: number
  latReach: number
  /** Governor: largest planted-foot yaw relative to the body (rad). */
  yawReach: number
  /** Footholds: longest step (m) and largest turn per step (rad). */
  maxStep: number
  maxStepYaw: number
}

const TAU = Math.PI * 2

export const moving = (c: Command) => Math.abs(c.speed) > 0.004 || Math.abs(c.yawRate) > 0.03 || Math.abs(c.strafe ?? 0) > 0.004

export class Stepper {
  /** Body reference on the ground: position, heading, forward / sideways speed, yaw rate. */
  bx = 0
  bz = 0
  yaw = 0
  v = 0
  u = 0
  w = 0
  mode: 'stand' | 'walk' = 'stand'
  /** 0..1 within the current step. */
  s = 0
  /** Which group swings this step. */
  swing = 0
  lifted = false
  /** Stride phase 0..1 (two steps), for the owner's bob and arm swing. */
  phi = 0
  /** Smoothed 0 (standing) .. 1 (walking), for blending gait motion in and out. */
  g = 0
  /** Quick recovery steps still to take, and their body-frame velocity (forward, left). */
  stagger = 0
  stagV = 0
  stagU = 0
  /** True on a step where the governor had to slow the body (diagnostic). */
  governed = false
  /** Set at a touchdown (the group index), cleared by the owner. */
  landed = -1

  readonly feet: Foot[]
  readonly planted: boolean[]
  /** Incremented at every touchdown, so a test can tell one stance from the next. */
  readonly stanceId: number[]
  private readonly from: Foot[]
  private readonly to: Foot[]
  private nextSwing = 0

  constructor(readonly spec: StepperSpec) {
    const n = spec.feet.length
    const foot = () => ({ x: 0, y: 0, z: 0, yaw: 0 })
    this.feet = Array.from({ length: n }, foot)
    this.from = Array.from({ length: n }, foot)
    this.to = Array.from({ length: n }, foot)
    this.planted = Array.from({ length: n }, () => true)
    this.stanceId = Array.from({ length: n }, () => 0)
  }

  get busy() {
    return this.stagger > 0
  }

  /** Teleport to a squared standing stance. */
  placeAt(x: number, z: number, heading: number) {
    this.bx = x
    this.bz = z
    this.yaw = heading
    this.v = this.w = this.u = 0
    this.mode = 'stand'
    this.lifted = false
    this.s = 0
    this.g = 0
    this.stagger = 0
    for (let i = 0; i < this.feet.length; i++) {
      this.nominal(i, x, z, heading, this.feet[i]!)
      this.planted[i] = true
    }
  }

  /**
   * Take over a standing stance that was not squared by placeAt (the end of a
   * scripted get-up): the body is where it is, the feet are where they are,
   * all planted. The next walk re-squares them.
   */
  adopt(x: number, z: number, heading: number, feet: readonly { x: number, z: number }[]) {
    this.bx = x
    this.bz = z
    this.yaw = heading
    this.v = this.w = this.u = 0
    this.mode = 'stand'
    this.lifted = false
    this.s = 0
    this.stagger = 0
    for (let i = 0; i < this.feet.length; i++) {
      const f = this.feet[i]!
      f.x = feet[i]!.x
      f.z = feet[i]!.z
      f.y = 0
      f.yaw = heading
      this.planted[i] = true
      this.stanceId[i]!++
    }
  }

  /** Foot i's nominal place for a body at (x, z, heading). */
  nominal(i: number, x: number, z: number, heading: number, out: Foot) {
    const n = this.spec.feet[i]!
    const c = Math.cos(heading), s = Math.sin(heading)
    out.x = x + c * n.x + s * n.z
    out.z = z - s * n.x + c * n.z
    out.y = 0
    out.yaw = heading
    return out
  }

  /** Quick recovery steps with a body-frame velocity (forward, left). */
  stumble(forward: number, left: number, steps: number) {
    const sp = this.spec
    this.stagV = clamp(forward, -sp.maxBack - 0.05, sp.maxSpeed + 0.05)
    this.stagU = clamp(left, -sp.maxStrafe, sp.maxStrafe)
    this.stagger = steps
    if (this.mode === 'stand') this.startWalk({ speed: this.stagV, yawRate: 0, strafe: this.stagU })
  }

  /** Move the body reference. Planted feet stay where they are; lifted feet re-aim with it. */
  shiftBody(dx: number, dz: number) {
    this.bx += dx
    this.bz += dz
    if (this.lifted) {
      for (const i of this.spec.groups[this.swing]!) {
        this.to[i]!.x += dx
        this.to[i]!.z += dz
      }
    }
  }

  /**
   * A swing foot is in something (or about to come down in it): the whole
   * arc moves by (dx, dz) -- where it lifted from, where it will land, and
   * the foot itself -- so the foot is clear NOW, in one correction, and lands
   * clear. (Moving only the landing left a foot that had just lifted inside
   * the obstacle for several steps.) The foot is in the air, so nothing
   * planted slides.
   */
  reaim(i: number, dx: number, dz: number) {
    if (!this.lifted || !this.spec.groups[this.swing]!.includes(i)) return
    this.from[i]!.x += dx
    this.from[i]!.z += dz
    this.to[i]!.x += dx
    this.to[i]!.z += dz
    this.feet[i]!.x += dx
    this.feet[i]!.z += dz
  }

  step(dt: number, cmdIn: Command, hold: boolean) {
    const sp = this.spec
    const cmd = { speed: 0, yawRate: 0, strafe: 0 }
    if (this.stagger > 0) {
      cmd.speed = this.stagV
      cmd.strafe = this.stagU
    }
    else if (!hold) {
      cmd.speed = clamp(cmdIn.speed, -sp.maxBack, sp.maxSpeed)
      cmd.yawRate = clamp(cmdIn.yawRate, -sp.maxYawRate, sp.maxYawRate)
      cmd.strafe = clamp(cmdIn.strafe ?? 0, -sp.maxStrafe, sp.maxStrafe)
    }
    if (this.mode === 'stand' && moving(cmd)) this.startWalk(cmd)
    this.governed = false
    if (this.mode === 'walk') this.walkStep(dt, cmd)
    else this.v = this.w = this.u = 0
    this.g += ((this.mode === 'walk' ? 1 : 0) - this.g) * Math.min(1, dt / 0.1)
  }

  private startWalk(cmd: Command) {
    this.mode = 'walk'
    this.s = 0
    this.lifted = false
    // Two groups: lead with the one on the side of the turn or the side-step
    // (group 0 holds the left front foot); otherwise alternate.
    const st = cmd.strafe ?? 0
    if (Math.abs(st) > 0.004 && Math.abs(st) >= 0.5 * Math.abs(cmd.speed)) this.swing = st > 0 ? 0 : 1
    else if (Math.abs(cmd.yawRate) > 0.1 && this.stagger === 0) this.swing = cmd.yawRate > 0 ? 0 : 1
    else this.swing = this.nextSwing
  }

  private swingK() {
    const u = clamp((this.s - this.spec.ds) / (1 - this.spec.ds), 0, 1)
    return (1 - Math.cos(Math.PI * u)) / 2
  }

  private walkStep(dt: number, cmd: Command) {
    const sp = this.spec
    const Ts = this.stagger > 0 ? sp.staggerStepTime : sp.stepTime
    const ds = sp.ds
    const swingG = sp.groups[this.swing]!
    const otherG = sp.groups[1 - this.swing]!

    // Governor: bounds on the body's speeds that keep every planted (or
    // about-to-be-planted) foot within reach of its nominal place until it
    // lifts again.
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw)
    const lx = fz, lz = -fx
    let vLo = -Infinity, vHi = Infinity, wLo = -Infinity, wHi = Infinity, uLo = -Infinity, uHi = Infinity
    const bound = (i: number, f: Foot, tau: number) => {
      if (tau <= 1e-4) return
      const n = sp.feet[i]!
      const o = (f.x - this.bx) * fx + (f.z - this.bz) * fz - n.z
      vHi = Math.min(vHi, (o + sp.reach) / tau)
      vLo = Math.max(vLo, (o - sp.reach) / tau)
      const ol = (f.x - this.bx) * lx + (f.z - this.bz) * lz - n.x
      uHi = Math.min(uHi, (ol + sp.latReach) / tau)
      uLo = Math.max(uLo, (ol - sp.latReach) / tau)
      const dy = f.yaw - this.yaw
      wHi = Math.min(wHi, (dy + sp.yawReach) / tau)
      wLo = Math.max(wLo, (dy - sp.yawReach) / tau)
    }
    if (!this.lifted) {
      for (const i of swingG) bound(i, this.feet[i]!, (ds - this.s) * Ts)
      for (const i of otherG) bound(i, this.feet[i]!, (1 - this.s + ds) * Ts)
    }
    else {
      for (const i of otherG) bound(i, this.feet[i]!, (1 - this.s + ds) * Ts)
      for (const i of swingG) {
        bound(i, this.to[i]!, (1 - this.s) * Ts)
        bound(i, this.to[i]!, (2 - this.s + ds) * Ts)
      }
    }
    const govern = (x: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : clamp(x, lo, hi))
    const vT = govern(cmd.speed, vLo, vHi)
    const wT = govern(cmd.yawRate, wLo, wHi)
    const uT = govern(cmd.strafe ?? 0, uLo, uHi)
    const gv = vT !== cmd.speed, gw = wT !== cmd.yawRate, gu = uT !== (cmd.strafe ?? 0)
    this.governed = gv || gw || gu
    const acc = this.stagger > 0 ? sp.staggerAccel : sp.accel
    this.v = approach(this.v, vT, (gv ? sp.govAccel : acc) * dt)
    this.u = approach(this.u, uT, (gu ? sp.govAccel : acc) * dt)
    this.w = approach(this.w, wT, (gw ? sp.govYawAccel : sp.yawAccel) * dt)
    this.yaw += this.w * dt
    this.bx += (Math.sin(this.yaw) * this.v + Math.cos(this.yaw) * this.u) * dt
    this.bz += (Math.cos(this.yaw) * this.v - Math.sin(this.yaw) * this.u) * dt

    this.s += dt / Ts
    if (!this.lifted && this.s >= ds) this.plan(cmd, Ts)
    if (this.lifted) {
      if (this.s >= 1) this.land(cmd)
      else this.swingFeet()
    }
    if (this.mode === 'walk') this.phi = (this.s + this.swing) / 2
  }

  /** Footholds: under each foot's nominal place at the middle of its coming stance, predicted. */
  private plan(cmd: Command, Ts: number) {
    const sp = this.spec
    const tMid = (1 - this.s) * Ts + 0.5 * (1 + sp.ds) * Ts
    const acc = this.stagger > 0 ? sp.staggerAccel : sp.accel
    let x = this.bx, z = this.bz, a = this.yaw, v = this.v, w = this.w, u = this.u, t = 0
    while (t < tMid - 1e-12) {
      const h = Math.min(0.01, tMid - t)
      v = approach(v, cmd.speed, acc * h)
      u = approach(u, cmd.strafe ?? 0, acc * h)
      w = approach(w, cmd.yawRate, sp.yawAccel * h)
      a += w * h
      x += (Math.sin(a) * v + Math.cos(a) * u) * h
      z += (Math.cos(a) * v - Math.sin(a) * u) * h
      t += h
    }
    for (const i of sp.groups[this.swing]!) {
      const f = this.feet[i]!
      const to = this.nominal(i, x, z, a, this.to[i]!)
      // Bounded step length and turn.
      const dx = to.x - f.x, dz = to.z - f.z
      const len = Math.hypot(dx, dz)
      if (len > sp.maxStep) {
        to.x = f.x + dx * sp.maxStep / len
        to.z = f.z + dz * sp.maxStep / len
      }
      to.yaw = f.yaw + clamp(a - f.yaw, -sp.maxStepYaw, sp.maxStepYaw)
      Object.assign(this.from[i]!, f)
      this.planted[i] = false
    }
    this.lifted = true
  }

  private swingFeet() {
    const sp = this.spec
    const u = clamp((this.s - sp.ds) / (1 - sp.ds), 0, 1)
    const k = (1 - Math.cos(Math.PI * u)) / 2
    for (const i of sp.groups[this.swing]!) {
      const from = this.from[i]!, to = this.to[i]!, f = this.feet[i]!
      const len = Math.hypot(to.x - from.x, to.z - from.z)
      // A short step (turning on the spot) still clears the ground, just less.
      f.y = sp.swingH * (0.55 + 0.45 * Math.min(1, len / (0.6 * sp.maxStep))) * (1 - Math.cos(TAU * u)) / 2
      f.x = from.x + (to.x - from.x) * k
      f.z = from.z + (to.z - from.z) * k
      f.yaw = from.yaw + (to.yaw - from.yaw) * k
    }
  }

  private land(cmd: Command) {
    const g = this.swing
    for (const i of this.spec.groups[g]!) {
      Object.assign(this.feet[i]!, this.to[i])
      this.feet[i]!.y = 0
      this.planted[i] = true
      this.stanceId[i]!++
    }
    this.landed = g
    this.lifted = false
    this.s -= 1
    this.swing = 1 - g
    if (this.stagger > 0) this.stagger--
    if (this.stagger === 0 && !moving(cmd) && Math.abs(this.v) < 0.004 && Math.abs(this.w) < 0.03 && Math.abs(this.u) < 0.004 && this.squared()) {
      this.mode = 'stand'
      this.phi = (1 + g) / 2
      this.v = this.w = this.u = 0
      this.s = 0
      this.nextSwing = this.swing
    }
  }

  /** Every foot on its nominal place (4 mm, 0.03 rad). */
  squared() {
    const tmp = { x: 0, y: 0, z: 0, yaw: 0 }
    for (let i = 0; i < this.feet.length; i++) {
      const f = this.feet[i]!
      this.nominal(i, this.bx, this.bz, this.yaw, tmp)
      if (Math.hypot(f.x - tmp.x, f.z - tmp.z) > 0.004 || Math.abs(f.yaw - this.yaw) > 0.03) return false
    }
    return true
  }

  snapshot() {
    return [this.bx, this.bz, this.yaw, this.v, this.u, this.w, this.mode, this.s, this.swing, this.lifted, this.phi, this.g,
      this.stagger, this.stagV, this.stagU, this.feet, this.planted, this.stanceId, this.to]
  }
}
