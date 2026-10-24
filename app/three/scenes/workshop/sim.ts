import { rng, type Rng } from '../../core/rng'
import {
  BOARD, CHISEL, MALLET, PIVOT_Y, PLANE, REST, SAW, STOOL_FRAME_AT,
  landing, smoother, type Pose, type ToolKey,
} from './layout'
import { carry } from './arc'
import { GRIPS } from './grips'
import { Particles } from './particles'
import { shavingCurve } from './shaving'
import { BLOW, BLOWS, DURATION, PHASES, Timeline, phaseOf, phaseStart, type Tool } from './timeline'

/**
 * The workshop as plain numbers: tool poses, the cuts they leave, sawdust,
 * the shaving and the stool, all advanced in fixed steps from one seeded RNG.
 * The renderer only reads snapshot() -- so the tests drive exactly the motion
 * the page draws.
 *
 * Every action is a list of phases (timeline.ts): the carpenter's hand
 * reaches the resting tool (nothing moves), eased arcs carry the tool to its
 * work pose, the work itself, and arcs back. Arcs lift over everything
 * between, start and stop with zero velocity, and end exactly on their
 * target poses. The hands follow these poses (carpenter.ts); the sim's clock
 * can be HELD for a step (the carpenter walking, waving or settling a grip),
 * which freezes every tool exactly where it is.
 *
 * For sound, each step also reports what it made happen: discrete `events`
 * (a blow landing, the stool starting to come apart, its parts seating, a
 * tap on the bench) and two continuous levels, `rasp` (saw push speed, 0 on
 * the return stroke) and `swish` (plane speed). The sim plays nothing itself.
 */

/** Chisel: BLOWS blows of BLOW seconds each. */
const RAISE = 0.36
const HOLD = 0.08
const STRIKE = 0.12
const CONTACT = RAISE + HOLD + STRIKE
const THETA_READY = -0.35
const THETA_UP = -0.75
/**
 * The swing is the forearm's as well as the wrist's: the grip (the mallet's
 * origin) swings on an arc about a point to its right, where the carpenter's
 * elbow is, by SWING of the mallet's own rotation away from the strike. At
 * the strike the arc angle is 0, so the grip is exactly at the pivot point
 * the contact angle is solved for -- the blow lands as before.
 */
const SWING = 0.45
const ELBOW = { dx: 0.24, dy: -0.04 }
const workLen = (tool: Tool) => PHASES[tool].find(p => p[0] === 'work')![1]
const SAW_WORK = workLen('saw')
const PLANE_WORK = workLen('plane')
/** Work-phase lengths and the strike timing, exported for the tests. */
export const PHASE = { SAW_WORK, PLANE_WORK, BLOW, CONTACT, BLOWS }
const STOOL_SPEED = 1 / 1.6
const STOOL_AUTO_HOLD = 2.2
const STOOL_TAP_HOLD = 5

/** What one step made happen, for sound. */
export type WorkshopEvent =
  | { kind: 'knock', blow: number }
  | { kind: 'explode' }
  | { kind: 'seat', part: 'frame' | 'seat' }
  | { kind: 'tap' }

/** Plane work poses: on the board edge at the start and end of the stroke. */
const PLANE_START: Pose = [PLANE.x0, BOARD.top, BOARD.z, 0, 0, 0]
const PLANE_END: Pose = [PLANE.x1, BOARD.top, BOARD.z, 0, 0, 0]

/** Snapshot layout: every scalar the renderer interpolates between steps. */
export const SNAP = {
  saw: 0, plane: 6, chisel: 12, mallet: 18,
  kerf: 24, mortise: 25,
  shaving: 26, // L, x, y, z, rz
  arrow: 31, // x, y, z, dx, dy, dz, opacity
  stool: 38,
  size: 39,
} as const

const TOOLS: ToolKey[] = ['saw', 'plane', 'chisel', 'mallet']
type Phase = ReturnType<typeof phaseOf>

/** The point each tool is carried by between rest and work: where the driving hand holds it. */
const CARRY: Record<ToolKey, readonly number[]> = {
  saw: GRIPS.saw.p, plane: GRIPS.tote.p, chisel: GRIPS.chisel.p, mallet: GRIPS.mallet.p,
}

/** Teeth line direction from heel to toe: (dir.x, -dir.y). */
const sawDir = { x: Math.cos(SAW.angle), y: Math.sin(SAW.angle) }

/**
 * Saw at work, ripping down into the board's free end: blade in the board's
 * middle plane, its teeth line through the kerf bottom where the cut leaves
 * the end grain (x = BOARD.x1). s slides the saw along its own teeth line,
 * down and toward the toe on the push.
 */
export function sawWorkPose(depth: number, s: number, out: number[] | Pose) {
  const k = SAW.s0 + s
  out[0] = BOARD.x1 + k * sawDir.x
  out[1] = BOARD.top - depth - k * sawDir.y
  out[2] = BOARD.z
  out[3] = 0
  out[4] = 0
  out[5] = -SAW.angle
  return out
}

/**
 * Where the saw is settled before the cut and lifted to after it: at its
 * cutting angle, toe just past the end grain, a hand's breadth above the
 * top edge. From here it slides down its own teeth line into the kerf.
 */
export const SAW_HANDOVER: Pose = (() => {
  const p = sawWorkPose(0, 0.01 - SAW.s0, [0, 0, 0, 0, 0, 0]) as Pose
  p[1] += 0.05
  return p
})()

/** Height of the saw's teeth line at x, for a saw in its work orientation. */
export function sawTeethY(pose: ArrayLike<number>, x: number) {
  return pose[1]! + (pose[0]! - x) * sawDir.y / sawDir.x
}

const sawStroke = (tau: number) => -SAW.amp * Math.cos(2 * Math.PI * tau / SAW.period)

/** Mallet angle at which its striking face meets the chisel top with the mortise at depth m. */
export function contactAngle(m: number) {
  const { R, hh } = MALLET
  return Math.asin((hh + m) / Math.hypot(R, hh)) - Math.atan2(hh, R)
}

/** Mallet pose for rotation theta while chopping a mortise m deep (arm swing included). */
export function malletPose(theta: number, m: number, out: number[] | Pose) {
  const phi = SWING * (theta - contactAngle(m))
  const c = Math.cos(phi), s = Math.sin(phi)
  // The mallet works turned half round (ry = pi): its grip on the -x side of
  // the chisel, which the drawn (mirrored) world puts at the carpenter's
  // right as they face the bench. Turned so, the head's height for a given
  // theta is unchanged, so the contact angle still holds; the forearm's arc
  // is the same, reflected. Grip = elbow + R(phi) (pivot - elbow).
  out[0] = CHISEL.x - (MALLET.R + ELBOW.dx - ELBOW.dx * c + ELBOW.dy * s)
  out[1] = PIVOT_Y + ELBOW.dy - ELBOW.dx * s - ELBOW.dy * c
  out[2] = BOARD.z
  out[3] = 0
  out[4] = Math.PI
  out[5] = theta
}

function chiselPose(m: number, wobble: number, out: number[]) {
  out[0] = CHISEL.x
  out[1] = BOARD.top - m
  out[2] = BOARD.z
  out[3] = 0
  out[4] = 0
  out[5] = wobble
}

export interface Shaving {
  L: number
  attached: boolean
  resting: boolean
  x: number
  y: number
  z: number
  rz: number
  vx: number
  vy: number
  vz: number
  w: number
  radius: number
}

export class WorkshopSim {
  readonly timeline = new Timeline()
  readonly particles = new Particles(192)
  readonly pose: Record<ToolKey, number[]>
  /** Rip depth at the end grain; the cut runs up to the top edge at the saw's angle. */
  kerf = SAW.startDepth
  mortise = 0
  readonly shaving: Shaving = {
    L: 0, attached: false, resting: false,
    x: 0, y: 0, z: 0, rz: 0, vx: 0, vy: 0, vz: 0, w: 0, radius: 0,
  }

  /** Red hairline arrow: where force is applied right now (opacity 0 = none). */
  readonly arrow = { x: 0, y: 0, z: 0, dx: 1, dy: 0, dz: 0, a: 0 }
  stoolU = 0
  stoolTarget: 0 | 1 = 0
  /** Events of the last step (cleared at the start of each step). */
  readonly events: WorkshopEvent[] = []
  /** Saw push speed this step, 0..1 of the stroke's peak; 0 on the pull. */
  rasp = 0
  /** Plane speed this step, 0..1 of the stroke's peak. */
  swish = 0
  /** Taps on the bench waiting for the next step: x, y, z triples. */
  private puffs: number[] = []
  private stoolHold = 0
  private wobbleT = 1e9
  private dustAcc = 0
  private readonly rand: Rng
  private readonly curve = new Float32Array((48 + 1) * 2)
  private readonly tmp: number[] = [0, 0, 0, 0, 0, 0]

  constructor(seed = 7) {
    this.rand = rng(seed)
    this.pose = {
      saw: [...REST.saw],
      plane: [...REST.plane],
      chisel: [...REST.chisel],
      mallet: [...REST.mallet],
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────

  /** Rewind a reach in progress (after a wave the hand starts out again). */
  restartReach() {
    this.timeline.restartReach()
  }

  request(tool: Tool) {
    const r = this.timeline.request(tool)
    if (r === 'started') this.begin(tool)
    return r
  }

  toggleStool(): 'exploding' | 'assembling' {
    if (this.stoolTarget === 1) {
      this.stoolTarget = 0
      return 'assembling'
    }
    this.stoolTarget = 1
    this.stoolHold = STOOL_TAP_HOLD
    return 'exploding'
  }

  /** A tap on the bench at (x, y, z): a little puff of dust there on the next step. */
  requestPuff(x: number, y: number, z: number) {
    if (this.puffs.length < 9) this.puffs.push(x, y, z)
  }

  clearQueue() {
    this.timeline.clearQueue()
    this.puffs.length = 0
  }

  // ── Step ───────────────────────────────────────────────────────────────

  /** One fixed step; `hold` freezes the action clock (every tool stays exactly put). */
  step(dt: number, hold = false) {
    const tl = this.timeline
    const was = tl.current
    const t0 = tl.t
    this.events.length = 0
    this.rasp = this.swish = 0
    for (let i = 0; i < this.puffs.length; i += 3) this.puff(this.puffs[i]!, this.puffs[i + 1]!, this.puffs[i + 2]!)
    this.puffs.length = 0
    const ev = tl.step(dt, hold)
    if (ev.started) this.begin(ev.started)
    if (ev.stool) {
      this.stoolTarget = 1
      this.stoolHold = STOOL_AUTO_HOLD
    }
    this.arrow.a = 0
    this.wobbleT += dt

    for (const k of TOOLS) {
      const p = this.pose[k]
      const r = REST[k]
      for (let i = 0; i < 6; i++) p[i] = r[i]!
    }
    const cur = tl.current
    if (cur) this.act(cur, ev.started ? 0 : (was === cur ? t0 : 0), tl.t)

    this.particles.step(dt)
    this.stepShaving(dt)
    this.stepStool(dt)
  }

  private begin(tool: Tool) {
    if (tool === 'saw') {
      this.kerf = SAW.startDepth
    }
    else if (tool === 'plane') {
      const s = this.shaving
      s.L = 0
      s.attached = true
      s.resting = false
    }
    else {
      this.mortise = 0
      this.wobbleT = 1e9
    }
  }

  /**
   * Pose the current action's tools for time t1 into it (t0 = the previous
   * step's time, for speeds and cut depth). The work functions get times
   * from the start of their work phase.
   */
  private act(tool: Tool, t0: number, t1: number) {
    const t = Math.min(t1, DURATION[tool])
    const ph = phaseOf(tool, t)
    // The reach: the hand is on its way, every tool still at rest.
    if (ph.name === 'reach') return
    const ws = phaseStart(tool, 'work')
    if (tool === 'saw') this.actSaw(ph, Math.max(0, t0 - ws), t - ws)
    else if (tool === 'plane') this.actPlane(ph, Math.max(0, t0 - ws), t - ws)
    else this.actChisel(ph, Math.max(0, t0 - ws), t - ws)
  }

  private actSaw(ph: Phase, t0: number, t: number) {
    const p = this.pose.saw
    const u = ph.t / ph.len
    switch (ph.name) {
      case 'fetch': return carry(REST.saw, SAW_HANDOVER, u, 0.08, CARRY.saw, p)
      case 'pass': case 'unpass': return carry(SAW_HANDOVER, SAW_HANDOVER, 0, 0, CARRY.saw, p)
      case 'place': return carry(SAW_HANDOVER, sawWorkPose(this.kerf, -SAW.amp, this.tmp) as Pose, u, 0.02, CARRY.saw, p)
      case 'lift': return carry(sawWorkPose(this.kerf, sawStroke(SAW_WORK), this.tmp) as Pose, SAW_HANDOVER, u, 0.02, CARRY.saw, p)
      case 'return': return carry(SAW_HANDOVER, REST.saw, u, 0.08, CARRY.saw, p)
    }
    {
      const s = sawStroke(t)
      const ds = s - sawStroke(t0)
      const dt = t - t0
      // Western saw: it cuts on the push (s increasing, toward the toe).
      if (ds > 0) this.kerf = Math.min(SAW.maxDepth, this.kerf + SAW.cutRate * ds)
      const depth = this.kerf
      sawWorkPose(depth, s, p)
      if (dt > 0) this.sawDust(ds, dt, depth)
      if (ds > 0 && dt > 0) {
        const vmax = SAW.amp * 2 * Math.PI / SAW.period
        const a = this.arrow
        // Tail just behind the handle, pointing along the push (heel -> toe).
        const d = 0.635 - (SAW.s0 + s)
        a.x = BOARD.x1 - d * sawDir.x + 0.07 * sawDir.y
        a.y = BOARD.top - depth + d * sawDir.y + 0.07 * sawDir.x
        a.z = BOARD.z
        a.dx = sawDir.x
        a.dy = -sawDir.y
        a.dz = 0
        a.a = Math.min(1, ds / dt / vmax)
        this.rasp = a.a
      }
    }
  }

  /**
   * Dust leaves the kerf where the teeth come out: from the end grain on the
   * push, from the top edge on the pull.
   */
  private sawDust(ds: number, dt: number, depth: number) {
    const R = this.rand
    this.dustAcc += (ds > 0 ? 34 : 12) * dt
    while (this.dustAcc >= 1) {
      this.dustAcc -= 1
      const z = BOARD.z + R.range(-0.003, 0.003)
      if (ds > 0) {
        const y = BOARD.top - depth + R.range(0, 0.012)
        this.particles.spawn(BOARD.x1 + 0.002, y, z, R.range(0.05, 0.3), R.range(-0.05, 0.15), R.range(-0.06, 0.06), 4)
      }
      else {
        const x = BOARD.x1 - depth * sawDir.x / sawDir.y + R.range(-0.004, 0.004)
        this.particles.spawn(x, BOARD.top + 0.002, z, -R.range(0.02, 0.15), R.range(0, 0.12), R.range(-0.25, 0.25), 4)
      }
    }
  }

  private actPlane(ph: Phase, t0: number, t: number) {
    const p = this.pose.plane
    const u = ph.t / ph.len
    if (ph.name === 'fetch') return carry(REST.plane, PLANE_START, u, 0.2, CARRY.plane, p)
    if (ph.name === 'set') return carry(PLANE_START, PLANE_START, 0, 0, CARRY.plane, p)
    if (ph.name === 'unset' || ph.name === 'return') {
      // The stroke is over: the shaving breaks free; the plane rests a moment
      // on the board as the front hand lets go, then lifts away.
      if (this.shaving.attached) this.releaseShaving()
      return carry(PLANE_END, REST.plane, ph.name === 'unset' ? 0 : u, 0.2, CARRY.plane, p)
    }
    {
      const e = smoother(t / PLANE_WORK)
      const x = PLANE.x0 + (PLANE.x1 - PLANE.x0) * e
      p[0] = x
      p[1] = BOARD.top
      p[2] = BOARD.z
      p[3] = p[4] = p[5] = 0
      this.shaving.L = Math.max(0, x - PLANE.x0 - 0.004)
      const dt = t - t0
      if (dt > 0) {
        const x0 = PLANE.x0 + (PLANE.x1 - PLANE.x0) * smoother(t0 / PLANE_WORK)
        const v = (x - x0) / dt
        const vmax = (PLANE.x1 - PLANE.x0) / PLANE_WORK * 1.875
        const a = this.arrow
        a.x = x - PLANE.len / 2 - 0.1
        a.y = BOARD.top + 0.07
        a.z = BOARD.z
        a.dx = 1
        a.dy = a.dz = 0
        a.a = Math.min(1, v / vmax)
        this.swish = a.a
      }
    }
  }

  private releaseShaving() {
    const s = this.shaving
    const f = shavingCurve(s.L, this.curve)
    s.attached = false
    s.x = PLANE.x1 + f.cx
    s.y = BOARD.top + f.cy
    s.z = BOARD.z
    s.rz = 0
    s.radius = f.radius
    // Flicked off toward the front, clear of the board and the vice jaw.
    s.vx = 0.12
    s.vy = 0.45
    s.vz = 0.5
    s.w = -5
  }

  private stepShaving(dt: number) {
    const s = this.shaving
    if (s.attached) {
      const f = shavingCurve(s.L, this.curve)
      s.x = this.pose.plane[0]! + f.cx
      s.y = this.pose.plane[1]! + f.cy
      s.z = this.pose.plane[2]!
      s.rz = 0
      s.radius = f.radius
      return
    }
    if (s.resting || s.L <= 0) return
    const damp = 1 / (1 + 1.2 * dt)
    s.vx *= damp
    s.vy = (s.vy - 9.81 * dt) * damp
    s.vz *= damp
    const y0 = s.y - s.radius
    s.x += s.vx * dt
    s.y += s.vy * dt
    s.z += s.vz * dt
    s.rz += s.w * dt
    const ground = s.vy < 0 ? landing(s.x, s.z, y0, s.y - s.radius) : null
    if (ground !== null) {
      s.y = ground + s.radius
      s.resting = true
    }
  }

  private actChisel(ph: Phase, t0: number, t: number) {
    const pc = this.pose.chisel
    const pm = this.pose.mallet
    const work = this.tmp
    if (ph.name === 'fetch') {
      const u = ph.t / ph.len
      chiselPose(0, 0, work)
      carry(REST.chisel, work as Pose, u, 0.18, CARRY.chisel, pc)
      malletPose(THETA_READY, 0, work)
      carry(REST.mallet, work as Pose, u, 0.15, CARRY.mallet, pm)
      return
    }
    if (ph.name === 'return') {
      const u = ph.t / ph.len
      chiselPose(this.mortise, 0, work)
      carry(work as Pose, REST.chisel, u, 0.18, CARRY.chisel, pc)
      malletPose(contactAngle(this.mortise), this.mortise, work)
      carry(work as Pose, REST.mallet, u, 0.15, CARRY.mallet, pm)
      return
    }
    const i = Math.min(BLOWS - 1, Math.floor(t / BLOW))
    const tau = t - i * BLOW
    // Contact this step? The blow lands, the chisel sinks, a chip flies.
    const tc = i * BLOW + CONTACT
    const struck = t0 < tc && t >= tc
    if (struck) this.blow(i)
    const thC = contactAngle(this.mortise)
    let theta: number
    if (tau < RAISE) {
      const from = i === 0 ? THETA_READY : thC
      theta = from + (THETA_UP - from) * smoother(tau / RAISE)
    }
    else if (tau < RAISE + HOLD) {
      theta = THETA_UP
    }
    else if (tau < CONTACT) {
      // Accelerates all the way into the strike.
      const v = (tau - RAISE - HOLD) / STRIKE
      theta = THETA_UP + (contactAngle(this.mortise) - THETA_UP) * v * v
      const a = this.arrow
      a.x = CHISEL.x - 0.075
      a.y = BOARD.top - this.mortise + CHISEL.len + 0.08
      a.z = BOARD.z
      a.dx = a.dz = 0
      a.dy = -1
      a.a = v
    }
    else {
      // Recoil: a small bounce off the chisel that settles back onto it.
      const v = (tau - CONTACT) / (BLOW - CONTACT)
      theta = thC - 0.09 * Math.sin(Math.PI * v) * (1 - v)
      if (v < 0.2) {
        const a = this.arrow
        a.x = CHISEL.x - 0.075
        a.y = BOARD.top - this.mortise + CHISEL.len + 0.08
        a.z = BOARD.z
        a.dx = a.dz = 0
        a.dy = -1
        a.a = 1 - v / 0.2
      }
    }
    // The step a blow lands, the face is ON the chisel top (the knock and the
    // drawn impact are the same step), whatever fraction of a step past contact.
    if (struck) theta = contactAngle(this.mortise)
    malletPose(theta, this.mortise, pm)
    // The chisel rings after each blow: a small decaying rock about its edge.
    const wobble = 0.025 * Math.exp(-9 * this.wobbleT) * Math.sin(32 * this.wobbleT)
    chiselPose(this.mortise, wobble, pc)
  }

  private blow(i: number) {
    this.events.push({ kind: 'knock', blow: i })
    this.mortise += CHISEL.blow
    this.wobbleT = 0
    const R = this.rand
    const side = R.next() < 0.5 ? -1 : 1
    for (let j = 0; j < 3; j++) {
      this.particles.spawn(
        CHISEL.x + R.range(-0.006, 0.006),
        BOARD.top + 0.002,
        BOARD.z + R.range(-0.006, 0.006),
        side * R.range(0.25, 0.55),
        R.range(0.55, 0.95),
        R.range(-0.05, 0.3),
        1.5,
      )
    }
  }

  /** Dust knocked up by a tap on the bench: a few grains thrown up and out. */
  private puff(x: number, y: number, z: number) {
    const R = this.rand
    this.events.push({ kind: 'tap' })
    for (let j = 0; j < 10; j++) {
      const a = R.range(0, Math.PI * 2)
      const s = R.range(0.08, 0.3)
      this.particles.spawn(x, y + 0.002, z, Math.cos(a) * s, R.range(0.35, 0.8), Math.sin(a) * s, 3)
    }
  }

  private stepStool(dt: number) {
    const u0 = this.stoolU
    this.moveStool(dt)
    const u = this.stoolU
    // The frame's parts all seat together where the frame factor reaches 0;
    // the seat drops on last, at u = 0.
    if (u0 === 0 && u > 0) this.events.push({ kind: 'explode' })
    if (u0 > STOOL_FRAME_AT && u <= STOOL_FRAME_AT) this.events.push({ kind: 'seat', part: 'frame' })
    if (u0 > 0 && u === 0) this.events.push({ kind: 'seat', part: 'seat' })
  }

  private moveStool(dt: number) {
    if (this.stoolTarget === 1) {
      this.stoolU = Math.min(1, this.stoolU + STOOL_SPEED * dt)
      if (this.stoolU === 1) {
        this.stoolHold -= dt
        if (this.stoolHold <= 0) this.stoolTarget = 0
      }
    }
    else {
      this.stoolU = Math.max(0, this.stoolU - STOOL_SPEED * dt)
    }
  }

  // ── Read-out ───────────────────────────────────────────────────────────

  snapshot(out: Float64Array) {
    for (const k of TOOLS) {
      const o = SNAP[k]
      const p = this.pose[k]
      for (let i = 0; i < 6; i++) out[o + i] = p[i]!
    }
    out[SNAP.kerf] = this.kerf
    out[SNAP.mortise] = this.mortise
    const s = this.shaving
    out[SNAP.shaving] = s.L
    out[SNAP.shaving + 1] = s.x
    out[SNAP.shaving + 2] = s.y
    out[SNAP.shaving + 3] = s.z
    out[SNAP.shaving + 4] = s.rz
    const a = this.arrow
    out[SNAP.arrow] = a.x
    out[SNAP.arrow + 1] = a.y
    out[SNAP.arrow + 2] = a.z
    out[SNAP.arrow + 3] = a.dx
    out[SNAP.arrow + 4] = a.dy
    out[SNAP.arrow + 5] = a.dz
    out[SNAP.arrow + 6] = a.a
    out[SNAP.stool] = this.stoolU
    return out
  }
}

