import { rng, type Rng } from '../../core/rng'
import {
  add3, DRILL, HOLDER, HOLDER_AXIS, JOINTS, LEFT_REST, lerp3, METER, norm, padWorld, PB, PB_N, PER_SESSION, RIGHT_REST,
  SAW, SOLDER, SOLDER_DIR_FEED, SOLDER_DIR_REST, TOP, WORK_AXIS, workToWorld, type V3,
} from './bench-layout'
import { ElectronicsSim } from './sim'

/**
 * Everything that changes on the workbench, stepped at the stage's fixed DT:
 * the electronics on the mat (ElectronicsSim, unchanged), the soldering
 * session, the drill press, the mitre saw, the multimeter, the lamp, and the
 * smoke and dust. Pure (no three, no audio) and seeded, so the same seed,
 * inputs and step count always give the same bench.
 *
 * TOOL JOBS QUEUE. Soldering, drilling, sawing and measuring are one person's
 * work, so they never overlap: a job asked for while another runs waits its
 * turn (each kind at most once in the queue). With nothing queued, the
 * operator picks the iron up again after a short, seeded pause.
 *
 * THE SOLDERING SESSION is a fixed timeline the operator's hands follow
 * (operator.ts reads it): reach for the iron, slide it out of the coil, carry
 * it to the first joint, touch, dwell while the solder is fed in from the
 * other side (sizzle, a curl of flux smoke, the fillet grows), lift, hop to
 * the next joint, and after PER_SESSION joints carry it back and slide it
 * home. Every start and stop is eased, so the hand never jerks.
 */

export type Job = 'solder' | 'drill' | 'saw' | 'measure'
export const JOBS: Job[] = ['solder', 'drill', 'saw', 'measure']

/** Sound / effect events raised since the renderer last read them (the electronics keep their own). */
export const BEV = { SIZZLE: 1, DRILL: 2, SAW: 4, CUT: 8, METER: 16, LAMP: 32, IRON_OUT: 64, IRON_HOME: 128, WAVE: 256 }

/** The operator's wave (seconds) and how long he looks up at the visitor first. */
export const WAVE = { length: 2.6, glance: 1.2 }
/** Idle glances between sessions: the board in the clips, the meter, the computer, each this long. */
export const GLANCE = 2.2
/** Torso lean (rad): sitting up, and bent in over a joint. */
export const LEAN_UP = 0.1
export const LEAN_IN = 0.32

/** Soldering phases and their lengths (seconds). */
export const PHASE = {
  reach: 0.55, lift: 0.45, carry: 0.95, approach: 0.32, dwell: 1.7, retract: 0.3, hop: 0.5,
  back: 0.95, insert: 0.45, release: 0.55,
}
type PhaseName = keyof typeof PHASE

/** Drill press: spin up / down, quill down, hold, up (seconds from the tap). */
export const DRILL_T = { spinUp: 0.35, down0: 0.55, down1: 1.5, up0: 1.8, up1: 2.5, end: 3.0 }
/** Mitre saw: blade spin up, arm down, hold, arm up, spin down. */
export const SAW_T = { spinUp: 0.5, down0: 0.5, down1: 1.6, up0: 1.85, up1: 2.7, end: 3.4 }
/** Multimeter: knob to continuity, beep, hold the reading, knob back. */
export const METER_T = { turn: 0.3, beep: 0.35, back0: 1.5, back1: 1.8, end: 1.9 }
/** Breath between queued jobs; idle pause before the iron comes out again. */
export const JOB_GAP = 0.4
export const IDLE_WAIT: [number, number] = [3, 7]

/** Smoke: a few points rising from the joint while the iron dwells. */
export const SMOKE = { n: 14, every: 0.11, life: 1.9, rise: 0.055 }
/** Chips and sawdust: a short ballistic burst. */
export const DUST = { n: 24, life: 0.9 }

const LOOK_SBC = workToWorld(-1.34, 0.1, -0.05)

const s5 = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * t * (t * (t * 6 - 15) + 10)
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

export interface IronPose { tip: V3, axis: V3 }

export const HOME: IronPose = { tip: HOLDER.tip, axis: HOLDER_AXIS }
export const LIFTED: IronPose = { tip: add3(HOLDER.tip, HOLDER_AXIS, HOLDER.slide), axis: HOLDER_AXIS }
/** Tip on pad k (a hair above it), along the working axis. */
export function contactPose(k: number): IronPose {
  return { tip: add3(padWorld(k), PB_N, 0.0012), axis: WORK_AXIS }
}
/** Hovering just off pad k, backed out along the iron's own axis. */
export function hoverPose(k: number): IronPose {
  return { tip: add3(contactPose(k).tip, WORK_AXIS, 0.03), axis: WORK_AXIS }
}

/** Solder wire: the tip point and its direction out of the hand. */
export interface SolderPose { tip: V3, dir: V3 }
export const SOLDER_REST: SolderPose = { tip: add3(LEFT_REST, SOLDER_DIR_REST, SOLDER.stick), dir: SOLDER_DIR_REST }
/** Wire tip touching pad k from the side away from the iron. */
export function feedPose(k: number, back: number): SolderPose {
  // The wire's end meets the iron's tip on the pad, from the other side.
  const p = add3(padWorld(k), PB_N, 0.0012)
  return { tip: add3(add3(p, [-1, 0, 0], 0.0015), SOLDER_DIR_FEED, -back), dir: SOLDER_DIR_FEED }
}
/** Ready to feed: the wire 9 mm back from the joint. */
const READY = 0.009

interface Phase { name: PhaseName, t0: number, t1: number, joint: number, next: number }

/** The phases of one session over `joints` (pad indices), with start times. */
export function sessionPlan(joints: number[]): Phase[] {
  const out: Phase[] = []
  let t = 0
  const push = (name: PhaseName, joint: number, next = joint) => {
    out.push({ name, t0: t, t1: t + PHASE[name], joint, next })
    t += PHASE[name]
  }
  push('reach', joints[0]!)
  push('lift', joints[0]!)
  push('carry', joints[0]!)
  joints.forEach((k, i) => {
    push('approach', k)
    push('dwell', k)
    push('retract', k)
    if (i < joints.length - 1) push('hop', k, joints[i + 1]!)
  })
  const last = joints[joints.length - 1]!
  push('back', last)
  push('insert', last)
  push('release', last)
  return out
}

export function planLength(plan: Phase[]) {
  return plan[plan.length - 1]!.t1
}

function mixPose(a: IronPose, b: IronPose, t: number, lift: number, out: IronPose) {
  lerp3(a.tip, b.tip, t, out.tip)
  // A raised arc: the iron is carried over things, never dragged through them.
  out.tip[1] += lift * Math.sin(Math.PI * t)
  const ax = lerp3(a.axis, b.axis, t)
  const n = norm(ax)
  out.axis[0] = n[0]
  out.axis[1] = n[1]
  out.axis[2] = n[2]
}

function mixSolder(a: SolderPose, b: SolderPose, t: number, lift: number, out: SolderPose) {
  lerp3(a.tip, b.tip, t, out.tip)
  out.tip[1] += lift * Math.sin(Math.PI * t)
  const n = norm(lerp3(a.dir, b.dir, t))
  out.dir[0] = n[0]
  out.dir[1] = n[1]
  out.dir[2] = n[2]
}

/** Everything a session's timeline drives at time t: the iron, the hands, the wire, the joint being worked. */
export interface SessionState {
  iron: IronPose
  /** 0 = right hand at rest, 1 = on the iron's grip. */
  grip: number
  solder: SolderPose
  /** True while the tip is on a joint. */
  contact: boolean
  /** Joint being worked (or about to be), and the solder fed into it so far (0..1). */
  joint: number
  feed: number
  phase: PhaseName | 'idle'
}

export function newSessionState(): SessionState {
  return {
    iron: { tip: [...HOME.tip] as V3, axis: [...HOME.axis] as V3 },
    grip: 0,
    solder: { tip: [...SOLDER_REST.tip] as V3, dir: [...SOLDER_REST.dir] as V3 },
    contact: false,
    joint: -1,
    feed: 0,
    phase: 'idle',
  }
}

/** Evaluate a session plan at time t (pure). Outside the plan the iron is home and the hands rest. */
export function evalSession(plan: Phase[], t: number, out: SessionState): SessionState {
  const ph = plan.find(p => t >= p.t0 && t < p.t1)
  out.contact = false
  out.feed = 0
  if (!ph) {
    mixPose(HOME, HOME, 0, 0, out.iron)
    mixSolder(SOLDER_REST, SOLDER_REST, 0, 0, out.solder)
    out.grip = 0
    out.joint = -1
    out.phase = 'idle'
    return out
  }
  const u = (t - ph.t0) / (ph.t1 - ph.t0)
  const e = s5(u)
  const k = ph.joint
  out.joint = ph.name === 'hop' && u > 0.5 ? ph.next : k
  out.phase = ph.name
  out.grip = 1
  const ready = feedPose(k, READY)
  switch (ph.name) {
    case 'reach':
      mixPose(HOME, HOME, 0, 0, out.iron)
      out.grip = e
      mixSolder(SOLDER_REST, SOLDER_REST, 0, 0, out.solder)
      break
    case 'lift':
      // Straight out along the coil's axis: the coil guides it.
      mixPose(HOME, LIFTED, e, 0, out.iron)
      mixSolder(SOLDER_REST, SOLDER_REST, 0, 0, out.solder)
      break
    case 'carry':
      mixPose(LIFTED, hoverPose(k), e, 0.05, out.iron)
      // The left hand brings the wire up to the joint while the iron travels.
      mixSolder(SOLDER_REST, ready, s5((u - 0.2) / 0.8), 0.02, out.solder)
      break
    case 'approach':
      mixPose(hoverPose(k), contactPose(k), e, 0, out.iron)
      mixSolder(ready, ready, 0, 0, out.solder)
      break
    case 'dwell': {
      // A small rub of the tip on the pad while it heats (half a millimetre).
      const c = contactPose(k)
      mixPose(c, c, 0, 0, out.iron)
      const w = 0.0005 * Math.sin(u * Math.PI * 6) * Math.sin(u * Math.PI)
      out.iron.tip[0] += w
      out.contact = true
      // Feed: in from 20%, the wire melting into the joint, out from 80%.
      const into = s5((u - 0.18) / 0.25)
      const outOf = s5((u - 0.8) / 0.2)
      mixSolder(ready, feedPose(k, 0), into - outOf, 0, out.solder)
      out.feed = s5((u - 0.3) / 0.45)
      break
    }
    case 'retract':
      mixPose(contactPose(k), hoverPose(k), e, 0, out.iron)
      mixSolder(ready, ready, 0, 0, out.solder)
      out.feed = 1
      break
    case 'hop':
      mixPose(hoverPose(k), hoverPose(ph.next), e, 0.012, out.iron)
      mixSolder(ready, feedPose(ph.next, READY), e, 0.008, out.solder)
      break
    case 'back':
      mixPose(hoverPose(k), LIFTED, e, 0.05, out.iron)
      mixSolder(ready, SOLDER_REST, s5(u / 0.8), 0.02, out.solder)
      break
    case 'insert':
      mixPose(LIFTED, HOME, e, 0, out.iron)
      mixSolder(SOLDER_REST, SOLDER_REST, 0, 0, out.solder)
      break
    case 'release':
      mixPose(HOME, HOME, 0, 0, out.iron)
      out.grip = 1 - e
      mixSolder(SOLDER_REST, SOLDER_REST, 0, 0, out.solder)
      break
  }
  return out
}

/** True when the iron sits in its holder (bit-exact home pose). */
export function ironHome(s: SessionState) {
  return s.iron.tip.every((v, i) => v === HOME.tip[i]) && s.iron.axis.every((v, i) => v === HOME.axis[i])
}

/** A spent particle if there is one, else the one nearest the end of its life. */
function oldest(list: Particle[]) {
  let best = list[0]!
  let score = -Infinity
  for (const q of list) {
    const v = q.age >= q.life ? Infinity : q.age / q.life
    if (v > score) {
      score = v
      best = q
    }
  }
  return best
}

export interface Particle { age: number, life: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, phase: number, kind: 0 | 1 }

/** Snapshot layout: values the renderer interpolates between two steps. */
export const BSNAP = {
  tip: 0, axis: 3, solderTip: 6, solderDir: 9, drill: 12, drillAngle: 13, saw: 14, blade: 15, knob: 16,
  lamp: 17, tipGlow: 18, fillet: 19, size: 19 + JOINTS,
}

export class WorkbenchSim {
  readonly elec: ElectronicsSim
  t = 0

  /** The tool job running (and how long it has run), and those waiting. */
  job: Job | null = null
  jobT = 0
  readonly queue: Job[] = []
  private gap = 0
  private idle = 0
  private idleWait: number

  /** Soldering: the session plan, its state, and how much solder each joint has. */
  private plan: Phase[] = []
  private planJoints: number[] = []
  readonly session = newSessionState()
  readonly fillet = new Float64Array(JOINTS)
  /** Joints finished on the current board; a fresh board goes in when all are done. */
  done = 0
  private wasContact = false

  /** Drill press: quill travel 0..1, chuck angle, motor level. */
  drill = 0
  drillAngle = 0
  drillSpin = 0
  /** Mitre saw: arm down 0..1, blade angle, motor level. */
  saw = 0
  blade = 0
  sawSpin = 0
  private cut = false
  /** Multimeter: knob position 0 (V) .. 1 (continuity), the reading it shows, its mode. */
  knob = 0
  reading = 5.01
  meterMode: 'V' | 'ohm' = 'V'
  private readT = 0
  /** Lamp on, and its eased level. */
  lampOn = true
  /** The operator's wave: time left (0 = not waving), and one asked for while his hands were busy. */
  waveT = 0
  wavePending = false
  /** Time left looking up at the visitor (he looks up at once, waves when his hand is free). */
  glanceUp = 0
  /** Torso lean, eased toward LEAN_IN while the tip is near a joint. */
  lean = LEAN_UP
  lamp = 1
  /** Iron tip glow: warm while out of the holder, full on a joint. */
  tipGlow = 0

  readonly smoke: Particle[] = []
  readonly dust: Particle[] = []
  private smokeT = 0
  events = 0

  private readonly r: Rng

  constructor(seed = 1) {
    this.elec = new ElectronicsSim(seed)
    this.r = rng((seed * 7919 + 17) >>> 0)
    this.idleWait = this.r.range(IDLE_WAIT[0], IDLE_WAIT[1])
    for (let i = 0; i < SMOKE.n; i++) this.smoke.push({ age: 1, life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, phase: 0, kind: 0 })
    for (let i = 0; i < DUST.n; i++) this.dust.push({ age: 1, life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, phase: 0, kind: 1 })
  }

  /** Length of the running solder session (s), or 0. */
  get sessionLength() {
    return this.job === 'solder' ? planLength(this.plan) : 0
  }

  /** The pads this session visits. */
  get sessionJoints(): readonly number[] {
    return this.planJoints
  }

  // ── Inputs ────────────────────────────────────────────────────────────

  /**
   * Ask for a tool job. Starts now if the bench is free, otherwise waits
   * behind the running job; asking again for one already running or waiting
   * changes nothing.
   */
  request(job: Job): 'started' | 'queued' | 'busy' {
    if (this.job === job || this.queue.includes(job)) return 'busy'
    if (!this.job && this.gap <= 0 && this.waveT <= 0 && !this.wavePending) {
      this.start(job)
      return 'started'
    }
    this.queue.push(job)
    return 'queued'
  }

  /** What a queued job waits behind, for the status line. */
  get running(): Job | null {
    return this.job
  }

  /**
   * Tap on the operator: he looks up at once, and waves -- now if the iron is
   * in its holder and his hand is free, else as soon as it is. No tool job
   * starts while he waves.
   */
  wave(): 'now' | 'after' | 'busy' {
    this.glanceUp = WAVE.glance
    if (this.waveT > 0 || this.wavePending) return 'busy'
    if (this.handFree) {
      this.startWave()
      return 'now'
    }
    this.wavePending = true
    return 'after'
  }

  /** The right hand is off the iron and the iron is home. */
  get handFree() {
    return this.job !== 'solder' && this.session.grip === 0
  }

  private startWave() {
    this.waveT = WAVE.length
    this.wavePending = false
    this.events |= BEV.WAVE
  }

  toggleLamp() {
    this.lampOn = !this.lampOn
    this.events |= BEV.LAMP
    return this.lampOn
  }

  /** Pause: drop the queue and the electronics' pointer targets. The running job finishes. */
  clearInputs() {
    this.queue.length = 0
    this.elec.clearInputs()
  }

  private start(job: Job) {
    this.job = job
    this.jobT = 0
    this.idle = 0
    this.cut = false
    if (job === 'solder') {
      if (this.done >= JOINTS) {
        // A fresh board in the clips.
        this.done = 0
        this.fillet.fill(0)
      }
      this.planJoints = []
      for (let i = 0; i < PER_SESSION && this.done + i < JOINTS; i++) this.planJoints.push(this.done + i)
      this.plan = sessionPlan(this.planJoints)
    }
    if (job === 'drill') this.events |= BEV.DRILL
    if (job === 'saw') this.events |= BEV.SAW
  }

  private finish() {
    this.job = null
    this.jobT = 0
    this.gap = JOB_GAP
    this.idle = 0
  }

  // ── Step ──────────────────────────────────────────────────────────────

  step(dt: number) {
    this.t += dt
    this.elec.step(dt)

    if (this.waveT > 0) this.waveT = Math.max(0, this.waveT - dt)
    else if (this.wavePending && this.handFree) this.startWave()
    if (this.glanceUp > 0) this.glanceUp = Math.max(0, this.glanceUp - dt)

    if (this.job) this.jobT += dt
    else if (this.gap > 0 || this.waveT > 0 || this.wavePending) this.gap = Math.max(0, this.gap - dt)
    else if (this.queue.length) this.start(this.queue.shift()!)
    else {
      this.idle += dt
      if (this.idle >= this.idleWait) {
        this.idleWait = this.r.range(IDLE_WAIT[0], IDLE_WAIT[1])
        this.start('solder')
      }
    }

    this.stepSolder(dt)
    this.stepDrill(dt)
    this.stepSaw(dt)
    this.stepMeter(dt)
    this.lamp += Math.max(-dt / 0.15, Math.min(dt / 0.15, (this.lampOn ? 1 : 0) - this.lamp))
    const ph = this.session.phase
    const lean = ph === 'approach' || ph === 'dwell' || ph === 'retract' || ph === 'hop' ? LEAN_IN : LEAN_UP
    this.lean += Math.max(-0.35 * dt, Math.min(0.35 * dt, lean - this.lean))
    this.stepParticles(dt)
  }

  private stepSolder(dt: number) {
    const on = this.job === 'solder'
    const s = this.session
    const wasHome = ironHome(s)
    evalSession(on ? this.plan : [], on ? this.jobT : 0, s)
    if (wasHome && !ironHome(s)) this.events |= BEV.IRON_OUT
    if (!wasHome && ironHome(s)) this.events |= BEV.IRON_HOME
    if (s.contact && !this.wasContact) this.events |= BEV.SIZZLE
    if (s.joint >= 0 && (s.phase === 'dwell' || s.phase === 'retract')) this.fillet[s.joint] = Math.max(this.fillet[s.joint]!, s.feed)
    if (this.wasContact && !s.contact && s.joint >= 0) this.done = Math.max(this.done, s.joint + 1)
    this.wasContact = s.contact
    const glow = s.contact ? 1 : ironHome(s) ? 0 : 0.45
    this.tipGlow += Math.max(-dt / 0.25, Math.min(dt / 0.08, glow - this.tipGlow))
    if (on && this.jobT >= planLength(this.plan)) {
      evalSession([], 0, s)
      this.finish()
    }
  }

  private stepDrill(dt: number) {
    const on = this.job === 'drill'
    const t = this.jobT
    const T = DRILL_T
    let spin = 0
    let travel = 0
    if (on) {
      spin = t < T.spinUp ? s5(t / T.spinUp) : t < T.up1 ? 1 : 1 - s5((t - T.up1) / (T.end - T.up1))
      travel = t < T.down0 ? 0 : t < T.down1 ? s5((t - T.down0) / (T.down1 - T.down0)) : t < T.up0 ? 1 : s5(1 - (t - T.up0) / (T.up1 - T.up0))
      // Chips while the bit is in the wood.
      if (travel > 0.78 && t < T.up0) this.emitDust(dt, DRILL.x, DRILL.table + DRILL.work.h, DRILL.sz, 0.35)
      if (t >= T.end) this.finish()
    }
    this.drillSpin = spin
    this.drill = travel
    this.drillAngle = (this.drillAngle + spin * 16 * dt) % (Math.PI * 2)
  }

  private stepSaw(dt: number) {
    const on = this.job === 'saw'
    const t = this.jobT
    const T = SAW_T
    let spin = 0
    let down = 0
    if (on) {
      spin = t < T.spinUp ? s5(t / T.spinUp) : t < T.up1 ? 1 : 1 - s5((t - T.up1) / (T.end - T.up1))
      down = t < T.down0 ? 0 : t < T.down1 ? s5((t - T.down0) / (T.down1 - T.down0)) : t < T.up0 ? 1 : s5(1 - (t - T.up0) / (T.up1 - T.up0))
      const inWork = down > 0.72 && t < T.up0
      if (inWork && !this.cut) {
        this.cut = true
        this.events |= BEV.CUT
      }
      if (inWork) this.emitDust(dt, SAW.x + 0.01, TOP + SAW.base.h + SAW.work.h, SAW.fenceZ + 0.05, 1)
      if (t >= T.end) this.finish()
    }
    this.sawSpin = spin
    this.saw = down
    this.blade = (this.blade + spin * 22 * dt) % (Math.PI * 2)
  }

  private stepMeter(dt: number) {
    const on = this.job === 'measure'
    const t = this.jobT
    const T = METER_T
    if (on) {
      this.knob = t < T.turn ? s5(t / T.turn) : t < T.back0 ? 1 : s5(1 - (t - T.back0) / (T.back1 - T.back0))
      if (t - dt < T.beep && t >= T.beep) this.events |= BEV.METER
      this.meterMode = t >= T.turn && t < T.back0 ? 'ohm' : 'V'
      if (t >= T.end) this.finish()
    }
    else {
      this.knob = 0
      this.meterMode = 'V'
    }
    // The reading: the board's 5 V rail, its last digit wandering a little.
    this.readT -= dt
    if (this.readT <= 0) {
      this.readT = 0.35
      this.reading = Math.round((5.01 + this.r.range(-0.025, 0.025)) * 100) / 100
    }
  }

  private emitDust(dt: number, x: number, y: number, z: number, spread: number) {
    // About 40 grains a second while cutting: the oldest grain is reused.
    if (this.r.next() > 40 * dt) return
    const p = oldest(this.dust)
    p.age = 0
    p.life = DUST.life * this.r.range(0.6, 1)
    p.x = x
    p.y = y
    p.z = z
    const a = this.r.range(0, Math.PI * 2)
    const v = this.r.range(0.15, 0.4) * spread
    p.vx = Math.cos(a) * v
    p.vz = Math.sin(a) * v * 0.6 + 0.12 * spread
    p.vy = this.r.range(0.2, 0.55) * spread
  }

  private stepParticles(dt: number) {
    const s = this.session
    if (s.contact) {
      this.smokeT -= dt
      if (this.smokeT <= 0) {
        this.smokeT = SMOKE.every
        const p = oldest(this.smoke)
        const j = padWorld(s.joint)
        p.age = 0
        p.life = SMOKE.life * this.r.range(0.75, 1)
        p.x = j[0]
        p.y = j[1] + 0.004
        p.z = j[2]
        p.vx = this.r.range(-0.004, 0.004)
        p.vz = this.r.range(-0.004, 0.004)
        p.vy = SMOKE.rise * this.r.range(0.8, 1.2)
        p.phase = this.r.range(0, Math.PI * 2)
      }
    }
    else this.smokeT = 0
    for (const p of this.smoke) {
      if (p.age >= p.life) continue
      p.age += dt
      // A slow curl: the column drifts and twists as it rises.
      const w = 2.2
      p.x += (p.vx + 0.012 * Math.cos(p.phase + p.age * w)) * dt
      p.z += (p.vz + 0.008 * Math.sin(p.phase + p.age * w)) * dt
      p.y += p.vy * dt * (1 - 0.35 * p.age / p.life)
    }
    for (const p of this.dust) {
      if (p.age >= p.life) continue
      p.age += dt
      p.vy -= 3.2 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      // Settle on the bench top rather than falling through it.
      if (p.y < TOP + 0.001) {
        p.y = TOP + 0.001
        p.vx = p.vy = p.vz = 0
      }
    }
  }

  /**
   * Where the operator looks, or null to look up at the visitor (the scene
   * supplies that point): the holder while he takes or returns the iron, the
   * joint while soldering, the tool while it runs; between jobs he glances
   * from the board in the clips to the meter to the computer. Always one of a
   * few fixed points, so the gaze settles instead of chasing.
   */
  look(out: V3 = [0, 0, 0]): V3 | null {
    if (this.glanceUp > 0 || this.waveT > 0) return null
    const s = this.session
    let p: V3
    if (this.job === 'drill') p = [DRILL.x, DRILL.table + DRILL.work.h, DRILL.sz]
    else if (this.job === 'saw') p = [SAW.x, TOP + SAW.base.h + SAW.work.h, SAW.fenceZ + 0.04]
    else if (this.job === 'measure') p = [METER.x, TOP + 0.13, METER.z]
    else if (s.phase === 'reach' || s.phase === 'lift' || s.phase === 'insert' || s.phase === 'release') p = HOLDER.tip
    else if (s.joint >= 0) p = padWorld(s.joint)
    else {
      const g = Math.floor(this.idle / GLANCE) % 3
      p = g === 0 ? [PB.x, PB.y, PB.z] : g === 1 ? [METER.x, TOP + 0.13, METER.z] : LOOK_SBC
    }
    out[0] = p[0]
    out[1] = p[1]
    out[2] = p[2]
    return out
  }

  snapshot(out: Float64Array) {
    const s = this.session
    for (let i = 0; i < 3; i++) {
      out[BSNAP.tip + i] = s.iron.tip[i]!
      out[BSNAP.axis + i] = s.iron.axis[i]!
      out[BSNAP.solderTip + i] = s.solder.tip[i]!
      out[BSNAP.solderDir + i] = s.solder.dir[i]!
    }
    out[BSNAP.drill] = this.drill
    out[BSNAP.drillAngle] = this.drillAngle
    out[BSNAP.saw] = this.saw
    out[BSNAP.blade] = this.blade
    out[BSNAP.knob] = this.knob
    out[BSNAP.lamp] = clamp01(this.lamp)
    out[BSNAP.tipGlow] = clamp01(this.tipGlow)
    for (let i = 0; i < JOINTS; i++) out[BSNAP.fillet + i] = this.fillet[i]!
    return out
  }

  takeEvents() {
    const e = this.events
    this.events = 0
    return e
  }
}
