import { DT } from '../../core/clock'
import { rng, type Rng } from '../../core/rng'
import type { Collider, ContactOther, Normal } from '../contact'
import { GEO } from './geometry'

/**
 * Wheel-legged self-balancing robot: a wheeled inverted pendulum with
 * telescoping (two-link) legs, simulated.
 *
 * Pure TypeScript, no three.js, so the tests run the exact code the page
 * runs. SI units throughout.
 *
 * PITCH (planar, along the heading): x = forward travel of the axle,
 * th = pitch of the legs + body about the axle (+ = leaning forward). The
 * motor torque tau acts BETWEEN body and wheels. Nonlinear EOM:
 *   (M + m + Iw/r^2)*xdd + M*l*cos(th)*thdd - M*l*sin(th)*thd^2 = tau/r - (b/r^2)(xd - r*thd) + Fx
 *   M*l*cos(th)*xdd + (Ib + M*l^2)*thdd - M*g*l*sin(th)       = -tau + (b/r)(xd - r*thd) + tau_d + tau_x
 * where l and Ib follow the LEG LENGTH L (bodyAt): crouched the centre of
 * mass is low and the robot is quick; standing tall it is slower and needs
 * different gains. Fx, tau_x: a grab drag (generalised forces of a
 * horizontal force at a height on the body). RK4 with tau held for the step.
 *
 * CONTROL: discrete LQR, u = -K(L) s, s = [x - xRef, xd - vRef, th, thd].
 * The gains are SCHEDULED by leg length: GAIN_TABLE holds K designed (exact
 * ZOH + discrete Riccati, lqr.ts) for the model linearised at each grid leg
 * length, with the weights in TUNED; K is interpolated linearly between
 * grid points. scripts/test-balance.ts redesigns every entry and checks the
 * committed table against it. The velocity command is an outer loop with an
 * acceleration limit, so driving off starts with the wheels rolling BACK --
 * the real non-minimum-phase response.
 *
 * LEGS (vertical): each leg is a position-controlled actuator between body
 * and wheels -- a stiff servo (spring-damper with gravity feed-forward,
 * force-limited) toward a target length. Standing, the wheels are on the
 * ground and the body rides the servo. A JUMP is that servo extending fast
 * to the hard stop: the stop jerks the wheels off the ground and the whole
 * robot flies ballistically (momentum conserved, no control torque in the
 * air); on touchdown the tyres stop and the legs, servoing softer, absorb
 * the landing. Bumps dip the legs the same way.
 *
 * States: 'balancing' (controller on), 'fallen' (controller off, falls
 * under the same EOM until the pod hits the ground; bounces, rests),
 * 'righting' (SCRIPTED, not simulated: tucks its legs, drives its wheels
 * in under the body as the body swings up along eased keyframes, then
 * extends the legs and re-engages; wheels turn by their own arcs throughout,
 * nothing slides).
 */

export interface BalanceParams {
  /** Body (pod + legs) mass, kg. */
  M: number
  /** COM height above the axle, m (depends on leg length: bodyAt). */
  l: number
  /** Body inertia about its COM, kg m^2. */
  Ib: number
  /** Wheel pair mass, kg. */
  m: number
  /** Wheel radius, m. */
  r: number
  /** Wheel pair inertia, kg m^2. */
  Iw: number
  /** Viscous damping on relative wheel-body rate, N m s. */
  b: number
  /** Motor torque limit (pair), N m. */
  tauMax: number
  /** Motor no-load speed (wheel relative to body), rad/s: drive torque falls to zero there (back-EMF). */
  wNoLoad: number
  /** Track width, m. */
  w: number
  g: number
}

const M = 0.95
const m = 0.22
const r = GEO.wheelR
/** The pod (with its battery, boards and head) and the four leg links. */
const POD_MASS = 0.72
const LEG_MASS = M - POD_MASS
const POD_COM = 0.012
const POD_I = POD_MASS * (0.096 * 0.096 + 0.07 * 0.07) / 12

/** Centre of mass height above the axle and body inertia about it, for leg length L. */
export function bodyAt(L: number) {
  const l = (POD_MASS * (L + POD_COM) + LEG_MASS * L / 2) / M
  const Ib = POD_I + POD_MASS * (L + POD_COM - l) ** 2 + LEG_MASS * (L * L / 12 + (L / 2 - l) ** 2)
  return { l, Ib }
}

export function paramsFor(L: number): BalanceParams {
  const { l, Ib } = bodyAt(L)
  // Spoked wheels carry their mass at the rim: Iw ~ 0.8 m r^2.
  return { M, l, Ib, m, r, Iw: 0.8 * m * r * r, b: 0.002, tauMax: 0.7, wNoLoad: 22, w: 2 * GEO.wheelX, g: 9.81 }
}

/** Parameters at the standing leg length (what the tests and the tune script linearise). */
export const PARAMS: Readonly<BalanceParams> = paramsFor(GEO.legStand)

/** Torque the motors can deliver at relative shaft speed wm: drive falls off with speed, braking does not. */
export function torqueLimits(p: Readonly<BalanceParams>, wm: number): [number, number] {
  const hi = Math.min(p.tauMax, p.tauMax * (1 - wm / p.wNoLoad))
  const lo = Math.max(-p.tauMax, -p.tauMax * (1 + wm / p.wNoLoad))
  return [lo, hi]
}

/**
 * LQR weights: heavier on position, speed and pitch than on torque.
 * START_TUNING is kept for the record (the first robot's starting point).
 */
export const START_TUNING = { Q: [4, 1, 60, 2], R: 40 } as const
export const TUNED = { Q: [60, 6, 200, 1], R: 15 } as const

export type Gains = readonly [number, number, number, number]

/** Leg lengths of the gain schedule, m. */
export const LEG_GRID = [0.07, 0.09, 0.11, 0.125, 0.14, 0.155, 0.165] as const
/**
 * K(L) for TUNED at each LEG_GRID length (u = -K s). Regenerate with
 * `npx --yes tsx scripts/tune-balance.ts` (lqr.ts: discretize(linearize(
 * paramsFor(L)), DT) then dlqr(.., TUNED)); test-balance redesigns them and
 * fails if these drift by more than 1e-4.
 */
export const GAIN_TABLE: readonly Gains[] = [
  [-1.23834, -1.32134, -3.16517, -0.27338],
  [-1.33583, -1.36996, -3.50409, -0.31909],
  [-1.41441, -1.41233, -3.79842, -0.36484],
  [-1.46257, -1.43949, -3.99379, -0.39897],
  [-1.50315, -1.46322, -4.17115, -0.43294],
  [-1.53749, -1.48412, -4.33360, -0.46681],
  [-1.55748, -1.49676, -4.43493, -0.48937],
]
/** K at the standing leg length. */
export const GAINS: Gains = GAIN_TABLE[3]!

/** Gains for leg length L: linear interpolation in the table (clamped at its ends). */
export function gainsAt(L: number, out: number[]) {
  const g = LEG_GRID
  let i = 0
  while (i < g.length - 2 && L > g[i + 1]!) i++
  const t = Math.min(1, Math.max(0, (L - g[i]!) / (g[i + 1]! - g[i]!)))
  const a = GAIN_TABLE[i]!, b = GAIN_TABLE[i + 1]!
  for (let k = 0; k < 4; k++) out[k] = a[k]! + (b[k]! - a[k]!) * t
  return out
}

/**
 * Smallest pitch-rate impulse (rad/s, from rest at the standing leg length,
 * noise off) that carries the body past fallAngle -- measured by bisection
 * in the test. A tap is a jump now; a shove is 1.2x this (it falls).
 */
export const IMPULSE_FALL = 7.80252

export const LIMITS = {
  maxSpeed: 0.25,
  /** Slew limit on the velocity command, m/s^2: starts and stops are eased by the controller itself. */
  maxAccel: 0.45,
  maxYawRate: 2,
  maxYawAccel: 6,
  /** Past this pitch the controller lets go. */
  fallAngle: 0.45,
  /** xRef is kept within this of x. */
  maxPosError: 0.12,
  /** Flat out (cmd.boost): the motors' real top end, eased by a harder slew. */
  sprint: 0.7,
  sprintAccel: 1.2,
}

/** Leg servo and jump. */
export const LEGS = {
  /** Servo bandwidth (rad/s) and damping ratio when standing; softer on landing. */
  omega: 16,
  zeta: 1,
  landOmega: 11,
  landTime: 0.35,
  /** Fast extension for the jump push. */
  jumpOmega: 70,
  /** Actuator force limits (both legs), N. On the ground the legs cannot pull the wheels up. */
  fMax: 20,
  fMin: -12,
  /** Jump: crouch this long, then push to (beyond) the stop. */
  crouchTime: 0.25,
}

/** Sensor noise (standard deviations): IMU pitch, gyro rate, encoder position and speed. */
export const NOISE = { th: 0.0015, thd: 0.02, x: 0.0002, xd: 0.003 }
/** Disturbance torque on the body: low-pass filtered noise, N m. */
export const DISTURBANCE = { sd: 0.03, tau: 0.6 }

/**
 * The points that touch the ground first in a fall, relative to the hip axis
 * (up along the body, fwd along the heading): the pod's top front and back
 * edges and the head's front. Heights above the axle add the leg length.
 */
export const BUMPER = {
  front: { up: GEO.podTop, fwd: GEO.podFront },
  back: { up: GEO.podTop, fwd: GEO.podBack },
  head: { up: GEO.headBase + GEO.pitchAxis + 0.012, fwd: GEO.headFront },
}

export const RIGHTING = {
  /** Resting on the pod (|thd| < restRate) this long before righting starts. */
  restTime: 0.5,
  restRate: 0.05,
  /** Scripted phases, s. */
  tuck: 0.4,
  swing: 1.0,
  extend: 0.45,
  restitution: 0.2,
  /** Impacts slower than this (rad/s) do not bounce. */
  restImpact: 0.6,
  /** Extra damping on xd while the pod drags on the ground, 1/s. */
  contactFriction: 20,
}

/** Pitch at which a body point (up above the hip, fwd) touches the ground, for leg length L. sign: +1 forward, -1 back. */
function groundAngleOf(L: number, p: { up: number, fwd: number }, sign: 1 | -1) {
  const h = (th: number) => r + (L + p.up) * Math.cos(th) - p.fwd * Math.sin(th)
  let lo = 0
  let hi = Math.PI * sign
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (h(mid) > 0) lo = mid
    else hi = mid
  }
  return lo
}

/** The landing pitch forward (+) and backward (-) at leg length L: the first bumper point to reach the ground. */
export function groundAngles(L: number): { front: number, back: number } {
  const f = Math.min(groundAngleOf(L, BUMPER.front, 1), groundAngleOf(L, BUMPER.head, 1))
  const b = Math.max(groundAngleOf(L, BUMPER.back, -1), groundAngleOf(L, { up: BUMPER.head.up, fwd: -0.02 }, -1))
  return { front: f, back: b }
}

/** At the standing leg length (tests). */
export const GROUND_ANGLE = groundAngles(GEO.legStand)

/**
 * Contact (robots/contact.ts). Seven circles following the silhouette from
 * above: two along each big wheel (fore and aft of the hub; band = the
 * wheel's height), two across the body pod and one for the sensor head --
 * the last three ride up and down with the legs and swing out ahead of the
 * axle as the body pitches, with height bands where they are.
 *
 * A hit is a horizontal impulse at `hitUp` (wheels: at the axle; pod and
 * head: their height) through the mass matrix of the EOM, so the contact
 * point's forward speed changes by (1 + e) times this robot's share of the
 * closing speed; above the centre of percussion the body pitches away from
 * the blow and the wheels lag -- a wobble the LQR catches, or a fall. The
 * legs give a little with every hit (the servo is a spring). Wheels cannot
 * roll sideways, so the lateral part is a short, damped SKID.
 */
export const CONTACT_SHAPE = {
  mass: M + m,
  wheelR: 0.03,
  wheelFore: 0.027,
  podX: 0.025,
  podR: 0.047,
  headR: 0.04,
  restitution: 0.3,
  /** Leg dip per m/s of impact. */
  legGive: 0.3,
  skidDecel: 4,
  skidDamp: 6,
} as const

export type BalanceMode = 'balancing' | 'fallen' | 'righting'

export interface SimCommand {
  speed: number
  yawRate: number
  /** Sprint: LIMITS.sprint and LIMITS.sprintAccel instead of the everyday limits. */
  boost?: boolean
}

export interface SimOptions {
  seed?: number
  noise?: boolean
  disturbance?: boolean
  /** Start at this leg length (default: standing). */
  leg?: number
}

/** Continuous linearisation at th = 0: sdot = A s + B tau, s = [x, xd, th, thd]. */
export function linearize(p: Readonly<BalanceParams> = PARAMS) {
  const a = p.M + p.m + p.Iw / (p.r * p.r)
  const c = p.M * p.l
  const d = p.Ib + p.M * p.l * p.l
  const det = a * d - c * c
  const br2 = p.b / (p.r * p.r)
  const br = p.b / p.r
  const mgl = p.M * p.g * p.l
  const A = [
    [0, 1, 0, 0],
    [0, (d * -br2 - c * br) / det, (-c * mgl) / det, (d * br + c * p.b) / det],
    [0, 0, 0, 1],
    [0, (a * br + c * br2) / det, (a * mgl) / det, (-a * p.b - c * br) / det],
  ]
  const B = [0, (d / p.r + c) / det, 0, (-a - c / p.r) / det]
  return { A, B }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** Quintic smootherstep: zero velocity and acceleration at both ends. */
const ease = (t: number) => {
  const u = clamp(t, 0, 1)
  return u * u * u * (u * (u * 6 - 15) + 10)
}

/**
 * One robot's simulation. step() advances exactly one DT. Everything random
 * is drawn from the robot's own seeded stream at a fixed count per step.
 */
export class BalancerSim {
  readonly p: BalanceParams
  private rand: Rng
  private noise: boolean
  private disturb: boolean
  private readonly K = [0, 0, 0, 0]

  // Pitch / travel.
  x = 0
  xd = 0
  th = 0
  thd = 0
  tau = 0
  vRef = 0
  xRef = 0
  // Planar pose and wheel arcs.
  X = 0
  Z = 0
  psi = 0
  omega = 0
  sL = 0
  sR = 0
  // Legs and vertical.
  /** Leg length (axle to hip axis), its rate, and the servo target. */
  L: number = GEO.legStand
  Ld = 0
  Lt: number = GEO.legStand
  /** Axle height above the ground (r when the wheels are down) and its rate. */
  yw: number = GEO.wheelR
  ywd = 0
  air = false
  /**
   * The floor's height under the axle (a ramp on the mat), m; null = flat.
   * Rolling up a slope the wheels ride its surface; at a ramp's lip the floor
   * drops away and the robot is airborne under the same leg/flight model as a
   * jump (the slope's gravity component is neglected: ~10 deg, a short ride).
   */
  ground: ((x: number, z: number) => number) | null = null
  /** Floor height under the axle now, m. */
  gy = 0
  // Fall and recovery.
  mode: BalanceMode = 'balancing'
  contact = false
  steps = 0
  /** Sideways skid velocity (world XZ), m/s. */
  skidX = 0
  skidZ = 0
  /** Contact circles: 0-1 left wheel (fore, aft), 2-3 right wheel, 4-5 pod, 6 head. */
  readonly colliders: Collider[] = [0, 1, 2, 3, 4, 5, 6].map(k => ({
    x: 0, z: 0, r: k < 4 ? CONTACT_SHAPE.wheelR : k < 6 ? CONTACT_SHAPE.podR : CONTACT_SHAPE.headR, vx: 0, vz: 0, fixed: false,
  }))
  /** External force for the next step (a grab): world x/y/z (N) at `extH` up the body from the axle. */
  extX = 0
  extY = 0
  extZ = 0
  extH = 0

  private tauD = 0
  private impulseQueue = 0
  private restTimer = 0
  private phase: 'tuck' | 'swing' | 'extend' | null = null
  private phaseT = 0
  private fallSign: 1 | -1 = 1
  private thRest = 0
  private xFrom = 0
  private xTo = 0
  private jumpT = -1
  private legFrom = 0
  private landT = -1
  /** Ground-contact angles for the current leg length while fallen. */
  private gF = 0
  private gB = 0
  /** Pitch-model constants for the current leg length (updated each step). */
  private ml = 0
  private dI = 0

  constructor(opts: SimOptions = {}) {
    this.L = this.Lt = opts.leg ?? GEO.legStand
    this.p = paramsFor(this.L)
    this.rand = rng(opts.seed ?? 1)
    this.noise = opts.noise ?? true
    this.disturb = opts.disturbance ?? false
    this.updateBody()
    this.updateColliders()
  }

  /** True while it cannot be steered: fallen, righting, re-extending its legs, or jumping. */
  get busy() {
    return this.mode !== 'balancing' || this.phase === 'extend' || this.jumpT >= 0 || this.air
  }

  get fallen() {
    return this.mode !== 'balancing'
  }

  get wheelL() {
    return this.sL / this.p.r
  }

  get wheelR() {
    return this.sR / this.p.r
  }

  /** Pitch-rate impulse (rad/s) applied at the start of the next step: a push on the body. */
  impulse(dthd: number) {
    this.impulseQueue += dthd
  }

  clearQueue() {
    this.impulseQueue = 0
  }

  /** Leg posture: crouch / stand / tall -- any length within the leg's range. */
  setLeg(L: number) {
    if (this.jumpT < 0 && this.mode === 'balancing') this.Lt = clamp(L, GEO.legMin, GEO.legMax)
  }

  /** A small jump: crouch, extend fast to the stop, fly, land on sprung legs. */
  jump() {
    if (this.busy) return false
    this.jumpT = 0
    return true
  }

  place(X: number, Z: number, psi: number) {
    this.X = X
    this.Z = Z
    this.psi = psi
    this.updateColliders()
  }

  /** l and inertia for the current leg length into the cached EOM constants. */
  private updateBody() {
    const b = bodyAt(this.L)
    this.p.l = b.l
    this.p.Ib = b.Ib
    this.ml = this.p.M * b.l
    this.dI = b.Ib + this.p.M * b.l * b.l
  }

  step(cmd: SimCommand) {
    const p = this.p
    this.steps++
    const n0 = this.rand.gauss()
    const n1 = this.rand.gauss()
    const n2 = this.rand.gauss()
    const n3 = this.rand.gauss()
    const n4 = this.rand.gauss()
    if (this.disturb) {
      const k = DT / DISTURBANCE.tau
      this.tauD += (DISTURBANCE.sd * Math.sqrt(2 / k) * n4 - this.tauD) * k
    }

    if (this.impulseQueue !== 0 && this.mode === 'balancing') this.thd += this.impulseQueue
    this.impulseQueue = 0

    // The scripted righting drives the legs itself.
    if (this.mode !== 'righting') this.stepLegs()
    this.updateBody()

    // The grab's horizontal force, split along the heading (through the
    // drive train and pendulum) and across it (against the tyres: a skid).
    const fx = Math.sin(this.psi), fz = Math.cos(this.psi)
    const fAlong = this.extX * fx + this.extZ * fz
    const fLat = this.extX * fz - this.extZ * fx
    if (fLat !== 0) {
      const a = fLat / (p.M + p.m) * DT
      this.skidX += a * fz
      this.skidZ -= a * fx
    }

    const x0 = this.x
    if (this.mode === 'righting') {
      this.stepRighting()
    }
    else if (this.air) {
      // Ballistic: no ground, no control torque; momentum carries x and pitch rate.
      this.tau = 0
      this.xd += fAlong / (p.M + p.m) * DT
      this.x += this.xd * DT
      this.th += this.thd * DT
    }
    else {
      if (this.mode === 'balancing') {
        const busy = this.phase === 'extend'
        const vMax = cmd.boost ? LIMITS.sprint : LIMITS.maxSpeed
        const aMax = cmd.boost ? LIMITS.sprintAccel : LIMITS.maxAccel
        // A jump keeps the speed it was taken at (a running jump off a ramp's lip); extending legs stop.
        const target = busy ? 0 : this.jumpT >= 0 ? this.vRef : clamp(cmd.speed, -vMax, vMax)
        const dv = clamp(target - this.vRef, -aMax * DT, aMax * DT)
        this.vRef += dv
        this.xRef += this.vRef * DT
        this.xRef = clamp(this.xRef, this.x - LIMITS.maxPosError, this.x + LIMITS.maxPosError)
        const nz = this.noise ? 1 : 0
        const s0 = this.x + nz * NOISE.x * n0 - this.xRef
        const s1 = this.xd + nz * NOISE.xd * n1 - this.vRef
        const s2 = this.th + nz * NOISE.th * n2
        const s3 = this.thd + nz * NOISE.thd * n3
        const K = gainsAt(this.L, this.K)
        const [lo, hi] = torqueLimits(p, this.xd / p.r - this.thd)
        this.tau = clamp(-(K[0]! * s0 + K[1]! * s1 + K[2]! * s2 + K[3]! * s3), lo, hi)
        const wTarget = busy || this.jumpT >= 0 ? 0 : clamp(cmd.yawRate, -LIMITS.maxYawRate, LIMITS.maxYawRate)
        this.omega += clamp(wTarget - this.omega, -LIMITS.maxYawAccel * DT, LIMITS.maxYawAccel * DT)
        if (this.phase === 'extend') this.stepExtend()
      }
      else {
        this.tau = 0
        this.omega = 0
      }
      const h = this.extH
      this.integrate(this.tau, this.tauD, fAlong, fAlong * h * Math.cos(this.th) - this.extY * h * Math.sin(this.th))
      if (this.mode === 'balancing' && Math.abs(this.th) > LIMITS.fallAngle) this.fall()
      if (this.mode === 'fallen') this.stepFallen()
    }

    // Planar motion: travel along the heading; on the ground the wheels roll their own arcs.
    const dx = this.x - x0
    const half = this.omega * p.w / 2 * DT
    if (!this.air) {
      this.sL += dx - half
      this.sR += dx + half
    }
    const mid = this.psi + this.omega * DT / 2
    this.X += dx * Math.sin(mid)
    this.Z += dx * Math.cos(mid)
    this.psi += this.omega * DT
    if (this.skidX !== 0 || this.skidZ !== 0) this.stepSkid()
    if (this.ground) this.followGround()
    this.updateColliders()
  }

  /**
   * Wheels on the floor ride its height; off a ramp's lip the floor drops away
   * and it flies. The trigger is the FLOOR dropping (not the axle being high:
   * getting up after a fall lifts it too, and that is not a flight).
   */
  private followGround() {
    const before = this.gy
    const gy = this.ground!(this.X, this.Z)
    this.gy = gy
    if (this.air || this.mode !== 'balancing') return
    const want = this.p.r + gy
    if (before - gy > 0.002 && this.yw > want + 0.002) {
      // The lip: ballistic from here, with the climb rate it had on the slope.
      this.air = true
      return
    }
    if (this.yw < want + 0.002) {
      // Riding up: the climb rate is the slope's -- capped, so a wheel that
      // bumps up the step's side (a 4 cm rise in one step) climbs it, it is
      // not fired into the air by the next drop.
      this.ywd = Math.min((want - this.yw) / DT, 0.4)
      this.yw = want
    }
  }

  /**
   * The legs: a force-limited servo between body and wheels with gravity
   * feed-forward; ground contact is one-sided; the jump and the landing are
   * this same model (see the header).
   */
  private stepLegs() {
    const p = this.p
    // Jump timeline: crouch, then drive fast at (past) the stop.
    let omega = this.landT >= 0 ? LEGS.landOmega : LEGS.omega
    if (this.jumpT >= 0) {
      this.jumpT += DT
      if (this.jumpT < LEGS.crouchTime) {
        this.Lt = GEO.legCrouch
      }
      else if (!this.air) {
        this.Lt = GEO.legMax + 0.03
        omega = LEGS.jumpOmega
      }
      else {
        // In the air: bring the legs back to standing, ready to land.
        this.Lt = GEO.legStand
      }
    }
    if (this.landT >= 0) {
      this.landT += DT
      if (this.landT > LEGS.landTime) this.landT = -1
    }
    if (this.mode === 'fallen') this.Lt = this.L
    const cosTh = Math.cos(this.th)
    let F = p.M * (p.g * cosTh + omega * omega * (this.Lt - this.L) - 2 * LEGS.zeta * omega * this.Ld)
    F = clamp(F, this.air ? LEGS.fMin : Math.max(LEGS.fMin, -p.m * p.g), LEGS.fMax)
    if (!this.air) {
      // Wheels on the ground: only the body moves along the leg.
      this.Ld += (F / p.M - p.g * cosTh) * DT
      this.L += this.Ld * DT
      if (this.L >= GEO.legMax) {
        this.L = GEO.legMax
        if (this.Ld > 0 && this.mode === 'balancing') {
          // The stop jerks the wheels up: momentum shared, the robot leaves the ground.
          this.ywd = p.M * this.Ld * cosTh / (p.M + p.m)
          this.air = this.ywd > 0.05
        }
        this.Ld = 0
      }
      else if (this.L <= GEO.legMin) {
        this.L = GEO.legMin
        if (this.Ld < 0) this.Ld = 0
      }
    }
    else {
      // Airborne: body and wheels exchange the leg force, gravity on both.
      this.ywd += (-F / p.m - p.g) * DT
      this.Ld += F * (1 / p.M + 1 / p.m) * DT
      this.yw += this.ywd * DT
      this.L += this.Ld * DT
      const limit = this.L > GEO.legMax ? GEO.legMax : this.L < GEO.legMin ? GEO.legMin : -1
      if (limit > 0) {
        // Hard stop in the air: inelastic, momentum conserved.
        const P = p.M * (this.ywd + this.Ld) + p.m * this.ywd
        this.L = limit
        this.Ld = 0
        this.ywd = P / (p.M + p.m)
      }
      if (this.yw <= p.r + this.gy && this.ywd < 0) {
        // Touchdown: the tyres stop, the body keeps falling into its legs.
        this.Ld += this.ywd
        this.ywd = 0
        this.yw = p.r + this.gy
        this.air = false
        this.landT = 0
        this.jumpT = -1
        this.Lt = GEO.legStand
        // The ground takes up the pitch-model velocities again: wheels roll at the air speed.
        this.xRef = this.x
        this.vRef = clamp(this.xd, -LIMITS.maxSpeed, LIMITS.maxSpeed)
      }
    }
    if (this.jumpT > LEGS.crouchTime + 1.5) this.jumpT = -1
  }

  /** Classic RK4 over (x, xd, th, thd) with tau and the external generalised forces held constant. */
  private integrate(tau: number, tauD: number, fx: number, tx: number) {
    const h = DT
    const x = this.x, v = this.xd, th = this.th, w = this.thd
    const a1 = this.accel(th, v, w, tau, tauD, fx, tx)
    const a1x = a1[0], a1t = a1[1]
    const a2 = this.accel(th + w * h / 2, v + a1x * h / 2, w + a1t * h / 2, tau, tauD, fx, tx)
    const a2x = a2[0], a2t = a2[1]
    const a3 = this.accel(th + (w + a1t * h / 2) * h / 2, v + a2x * h / 2, w + a2t * h / 2, tau, tauD, fx, tx)
    const a3x = a3[0], a3t = a3[1]
    const a4 = this.accel(th + (w + a2t * h / 2) * h, v + a3x * h, w + a3t * h, tau, tauD, fx, tx)
    const a4x = a4[0], a4t = a4[1]
    const v2 = v + a1x * h / 2, v3 = v + a2x * h / 2, v4 = v + a3x * h
    const w2 = w + a1t * h / 2, w3 = w + a2t * h / 2, w4 = w + a3t * h
    this.x = x + h / 6 * (v + 2 * v2 + 2 * v3 + v4)
    this.th = th + h / 6 * (w + 2 * w2 + 2 * w3 + w4)
    this.xd = v + h / 6 * (a1x + 2 * a2x + 2 * a3x + a4x)
    this.thd = w + h / 6 * (a1t + 2 * a2t + 2 * a3t + a4t)
  }

  private readonly acc: [number, number] = [0, 0]

  /** Solves the 2x2 mass-matrix system for (xdd, thdd). Returns a shared tuple: read it at once. */
  private accel(th: number, xd: number, thd: number, tau: number, tauD: number, fx: number, tx: number): [number, number] {
    const p = this.p
    const a = p.M + p.m + p.Iw / (p.r * p.r)
    const c = this.ml * Math.cos(th)
    const d = this.dI
    const s = Math.sin(th)
    const rel = xd - p.r * thd
    const f1 = tau / p.r - (p.b / (p.r * p.r)) * rel + this.ml * s * thd * thd + fx
    const f2 = this.ml * p.g * s - tau + (p.b / p.r) * rel + tauD + tx
    const det = a * d - c * c
    this.acc[0] = (d * f1 - c * f2) / det
    this.acc[1] = (a * f2 - c * f1) / det
    return this.acc
  }

  private fall() {
    this.mode = 'fallen'
    this.tau = 0
    this.omega = 0
    this.phase = null
    this.jumpT = -1
    this.restTimer = 0
    this.contact = false
  }

  /** Ground contact at the pod/head: clamp, bounce with restitution, drag while lying. */
  private stepFallen() {
    const g = groundAngles(this.L)
    this.gF = g.front
    this.gB = g.back
    this.contact = false
    const bounce = (v: number) => (Math.abs(v) < RIGHTING.restImpact ? 0 : -RIGHTING.restitution * v)
    if (this.th >= this.gF) {
      this.th = this.gF
      if (this.thd > 0) this.thd = bounce(this.thd)
      this.contact = true
    }
    else if (this.th <= this.gB) {
      this.th = this.gB
      if (this.thd < 0) this.thd = bounce(this.thd)
      this.contact = true
    }
    if (this.contact) {
      this.xd *= Math.exp(-RIGHTING.contactFriction * DT)
      this.restTimer = Math.abs(this.thd) < RIGHTING.restRate ? this.restTimer + DT : 0
      if (this.restTimer >= RIGHTING.restTime) this.startRighting()
    }
    else {
      this.restTimer = 0
    }
  }

  private startRighting() {
    this.mode = 'righting'
    this.contact = true
    this.phase = 'tuck'
    this.phaseT = 0
    this.fallSign = this.th > 0 ? 1 : -1
    this.thd = 0
    this.xd = 0
    this.Ld = 0
    this.legFrom = this.L
  }

  /**
   * SCRIPTED recovery (not simulated). tuck: the legs fold in while it lies
   * on its pod (the body settling to the new contact angle). swing: it drives
   * its wheels in under the pod while the body swings up to upright along an
   * eased keyframe -- the wheels turn by the distance they travel, nothing
   * slides, and the pod only rises off the ground. Then the controller takes
   * over and the legs extend back to standing.
   */
  private stepRighting() {
    this.phaseT += DT
    this.tau = 0
    this.omega = 0
    if (this.phase === 'tuck') {
      const t = this.phaseT / RIGHTING.tuck
      this.Lt = GEO.legMin
      this.L = this.legFrom + (GEO.legMin - this.legFrom) * ease(t)
      this.updateBody()
      const g = groundAngles(this.L)
      this.th = this.fallSign > 0 ? g.front : g.back
      if (t >= 1) {
        this.phase = 'swing'
        this.phaseT = 0
        this.thRest = this.th
        this.xFrom = this.x
        // Wheels end up under where the body's centre of mass lay.
        this.xTo = this.x + bodyAt(this.L).l * Math.sin(this.thRest) * 0.9
      }
      return
    }
    // swing
    const t = this.phaseT / RIGHTING.swing
    const thPrev = this.th
    const xPrev = this.x
    const k = ease(t)
    this.th = this.thRest * (1 - k)
    this.x = this.xFrom + (this.xTo - this.xFrom) * k
    this.thd = (this.th - thPrev) / DT
    this.xd = (this.x - xPrev) / DT
    this.contact = false
    if (t >= 1) {
      this.mode = 'balancing'
      this.th = 0
      this.thd = 0
      this.xd = 0
      this.xRef = this.x
      this.vRef = 0
      this.phase = 'extend'
      this.phaseT = 0
      this.Lt = GEO.legStand
    }
  }

  private stepExtend() {
    this.phaseT += DT
    if (this.phaseT >= RIGHTING.extend) this.phase = null
  }

  /** A sideways skid: the tyres slide and friction kills it within a few centimetres. */
  private stepSkid() {
    this.X += this.skidX * DT
    this.Z += this.skidZ * DT
    const v = Math.hypot(this.skidX, this.skidZ)
    const decel = this.air ? 0 : CONTACT_SHAPE.skidDecel
    const k = Math.max(0, v * (1 - CONTACT_SHAPE.skidDamp * DT) - decel * DT) / v
    if (v * k < 1e-4) {
      this.skidX = 0
      this.skidZ = 0
    }
    else {
      this.skidX *= k
      this.skidZ *= k
    }
  }

  /** Where the contact circles are now, and how fast they move. */
  updateColliders() {
    const fx = Math.sin(this.psi), fz = Math.cos(this.psi)
    const lx = fz, lz = -fx
    const st = Math.sin(this.th), ct = Math.cos(this.th)
    const lift = this.yw - this.p.r
    for (let k = 0; k < 7; k++) {
      const c = this.colliders[k]!
      let side = 0, along = 0, up = 0, v = this.xd
      if (k < 4) {
        side = (k < 2 ? 1 : -1) * GEO.wheelX
        along = (k % 2 === 0 ? 1 : -1) * CONTACT_SHAPE.wheelFore
        c.y0 = lift
        c.y1 = lift + 2 * this.p.r
      }
      else {
        // Pod (two across) or head: up the body from the axle, swinging with the pitch.
        const hUp = k < 6 ? this.L + (GEO.podBottom + GEO.podTop) / 2 : this.L + GEO.headBase + GEO.pitchAxis
        side = k < 6 ? (k === 4 ? 1 : -1) * CONTACT_SHAPE.podX : 0
        along = hUp * st
        up = this.p.r + lift + hUp * ct
        v = this.xd + hUp * ct * this.thd
        const half = k < 6 ? 0.036 + 0.05 * Math.abs(st) : 0.03
        c.y0 = Math.max(0, up - half)
        c.y1 = up + half
      }
      c.x = this.X + lx * side + fx * along
      c.z = this.Z + lz * side + fz * along
      c.vx = fx * (v - this.omega * side) + this.skidX
      c.vz = fz * (v - this.omega * side) + this.skidZ
    }
  }

  /** Height above the axle at which a part is struck. */
  private hitUp(part: number) {
    if (part < 4) return 0
    return part < 6 ? this.L + (GEO.podBottom + GEO.podTop) / 2 : this.L + GEO.headBase + GEO.pitchAxis
  }

  /**
   * Contact response (see CONTACT_SHAPE). `n` points away from what was hit;
   * `depth` is this robot's share of the overlap; `relSpeed` its share of the
   * closing speed. Moves the simulated state, never the drawing.
   */
  collide(n: Normal, depth: number, relSpeed: number, _other: ContactOther, part: number) {
    const fx = Math.sin(this.psi), fz = Math.cos(this.psi)
    const along = n.x * fx + n.z * fz
    if (depth > 0) {
      // Forward part: the wheels roll with it and the controller's reference
      // moves too. Lateral part: a skid.
      const s = depth * along
      this.X += n.x * depth
      this.Z += n.z * depth
      this.x += s
      this.xRef += s
      if (!this.air) {
        this.sL += s
        this.sR += s
      }
      if (this.mode === 'righting') {
        this.xFrom += s
        this.xTo += s
      }
    }
    if (relSpeed > 0) {
      const dv = (1 + CONTACT_SHAPE.restitution) * relSpeed
      const dvf = dv * along
      this.skidX += dv * n.x - dvf * fx
      this.skidZ += dv * n.z - dvf * fz
      if (this.mode !== 'righting') {
        if (this.air) this.xd += dvf
        else this.hit(dvf, this.hitUp(part))
      }
      // The legs are sprung: a knock dips them.
      if (!this.air && this.mode === 'balancing') this.Ld -= CONTACT_SHAPE.legGive * dv
    }
    this.updateColliders()
  }

  /** Horizontal impulse at height u above the axle that changes that point's forward speed by dv. */
  private hit(dv: number, u: number) {
    const p = this.p
    const a = p.M + p.m + p.Iw / (p.r * p.r)
    const c = this.ml * Math.cos(this.th)
    const d = this.dI
    const det = a * d - c * c
    const j = u * Math.cos(this.th)
    const q1 = (d - c * j) / det
    const q2 = (a * j - c) / det
    const P = dv / (q1 + j * q2)
    this.xd += P * q1
    this.thd += P * q2
  }
}

/**
 * Head look controller: critically damped second-order springs on yaw and
 * pitch, targets clamped to the servo limits.
 */
export const HEAD = { omega: 9, yawLimit: Math.PI / 2, pitchLimit: 25 * Math.PI / 180 }

export class HeadSpring {
  yaw = 0
  pitch = 0
  yawRate = 0
  pitchRate = 0

  step(targetYaw: number, targetPitch: number, dt: number) {
    const w = HEAD.omega
    const ty = clamp(targetYaw, -HEAD.yawLimit, HEAD.yawLimit)
    const tp = clamp(targetPitch, -HEAD.pitchLimit, HEAD.pitchLimit)
    this.yawRate += (w * w * (ty - this.yaw) - 2 * w * this.yawRate) * dt
    this.pitchRate += (w * w * (tp - this.pitch) - 2 * w * this.pitchRate) * dt
    this.yaw += this.yawRate * dt
    this.pitch += this.pitchRate * dt
    if (Math.abs(this.yaw) > HEAD.yawLimit) {
      this.yaw = Math.sign(this.yaw) * HEAD.yawLimit
      this.yawRate = 0
    }
    if (Math.abs(this.pitch) > HEAD.pitchLimit) {
      this.pitch = Math.sign(this.pitch) * HEAD.pitchLimit
      this.pitchRate = 0
    }
  }
}
