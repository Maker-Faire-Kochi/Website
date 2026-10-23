import type { Person } from '../../people/person'
import type { LookOptions } from '../../people/motion'
import { GRIPS, gripWorld, type Grip } from './grips'
import { BOARD, CARPENTER, CHISEL, MIRROR, PLANE, REST, SAW, smooth, smoother, type ToolKey } from './layout'
import type { WorkshopSim } from './sim'
import { STATIC, phaseOf, type PhaseName, type Tool } from './timeline'

/**
 * The carpenter who works the bench: a director that turns the sim's tool
 * poses into what one person does with their hands, body, feet and eyes.
 * Pure logic over the people library's Person -- the scene and the tests run
 * the same code.
 *
 * WORLD AND SIM. The sim poses tools in its own frame; the scene draws that
 * frame mirrored in x (layout.ts MIRROR) so the board runs along the
 * carpenter's RIGHT side as they face its free end. Every grip and look
 * point is mirrored here on the way into the world; the person is never
 * mirrored.
 *
 * WHO HOLDS WHAT. Every step, each hand either holds a grip on a tool (the
 * palm locked to the tool's pose of THIS step, so the hand moves the tool, it
 * never chases it) or is free. A tool only leaves its rest while a settled
 * hand is on it: the sim's actions start with a reach (the tools still), and
 * every phase where a second hand joins is static, so the director can HOLD
 * the sim's clock at its end until the hand has settled. The people library
 * blends a newly set hand target in over a moment and only then is the palm
 * exactly on the grip -- holding until settled is what keeps "hand on handle
 * within a millimetre" true through every action. Grips carry the library's
 * handle axis, kind (wrap / pinch / flat) and radius, so the fingers close
 * round a handle rather than lying on it.
 *
 * The right hand drives: it takes the saw, the plane's tote and the mallet,
 * with the elbow kept out to the right of the ribs (body-relative elbow
 * hints). The left hand joins the plane's knob for the stroke and holds the
 * chisel.
 *
 * BODY. A working stance, not a squat: feet staggered, the front (left) foot
 * pointing along the board, the back foot turned out, knees soft. Each job
 * has its own place and heading; the carpenter walks between them -- one
 * foot at a time, body turning as it goes -- while the hands are free and
 * the sim waits. The plane is pushed while stepping through with it. The
 * people library has no turn or staggered stance, so this file drives the
 * body's ground point, heading and feet itself (Person.motion's pos /
 * heading / feet); the library solves the legs to those feet every step, so
 * a planted foot never slides.
 * WEIGHT. With the feet planted, moving the ground point moves the hips over
 * them: forward on each saw push, back foot to front through the plane
 * stroke, shoulders travelling with the tool; the torso leans into the push.
 * Every change of lean or weight is eased, so nothing pops between actions.
 *
 * EYES. While the hands hold tools the library keeps the eyes on the work and
 * gives the look target only a glance now and then -- so the look target is
 * the cut itself, or the visitor's pointer when it is about. Between actions
 * the head turns to the next tool; during the stool's show, to the stool.
 *
 * WAVE. A tap on the carpenter: they finish what cannot be let go (an arc in
 * the air, a mallet mid-swing), set the work down where it stands by itself
 * (a saw in its kerf, a plane on the board), let both hands settle to their
 * sides, look up and wave; then take hold again and carry on. The sim waits
 * throughout.
 */

type Side = 'left' | 'right'
interface P3 { x: number, y: number, z: number }
/** A hand's job: a grip on a tool, with a BODY-frame elbow hint (x = left, z = forward). */
interface Hold { tool: ToolKey | 'board', grip: Grip, elbow: P3 }
interface Stand { x: number, z: number, h: number }
interface Foot { x: number, z: number, y: number, yaw: number, pitch: number }
interface Gait { t: number, dur: number, from: Stand, to: Stand, f0: [Foot, Foot], f1: [Foot, Foot], first: 0 | 1, work: boolean }

/** The people library's grip target, with the grip-API fields (ignored by a library without them). */
interface GripTarget {
  position: P3
  normal: P3
  elbow: P3
  axis: P3
  kind: Grip['kind']
  radius: number
}

const M = MIRROR
/** Elbows out to the side, down, a little back: outboard of the ribs, never behind the back. */
const ELBOW_R: P3 = { x: -0.62, y: -0.75, z: -0.15 }
const ELBOW_L: P3 = { x: 0.62, y: -0.75, z: -0.15 }

/**
 * While sawing, the left hand presses flat on the board's face ahead of the
 * handle, toward the cut (clear of the blade, which runs in the board's
 * middle plane): it steadies the work and draws the eyes along to the kerf.
 */
const ON_BOARD: Hold = {
  tool: 'board',
  grip: { p: [0.16, BOARD.top - 0.045, BOARD.front - BOARD.z + 0.02], n: [0, 0, 1], kind: 'flat', radius: 0.02 },
  // The hand is near the body's middle line: the elbow goes further out to stay clear of the ribs.
  elbow: { x: 0.8, y: -0.58, z: -0.15 },
}
const BOARD_POSE = [0, 0, BOARD.z, 0, 0, 0]
const SAW_GRIP: Hold = { tool: 'saw', grip: GRIPS.saw, elbow: ELBOW_R }
const TOTE: Hold = { tool: 'plane', grip: GRIPS.tote, elbow: ELBOW_R }
const KNOB: Hold = { tool: 'plane', grip: GRIPS.knob, elbow: ELBOW_L }
const CHISEL_GRIP: Hold = { tool: 'chisel', grip: GRIPS.chisel, elbow: ELBOW_L }
// The mallet hand: the elbow out to the side at hand height, the forearm level and square to the handle.
const MALLET_GRIP: Hold = { tool: 'mallet', grip: GRIPS.mallet, elbow: { x: -0.9, y: -0.15, z: -0.4 } }

/** [left, right] per tool and phase. */
const PLAN: Record<Tool, Partial<Record<PhaseName, [Hold | null, Hold | null]>>> = {
  saw: {
    reach: [null, SAW_GRIP],
    fetch: [null, SAW_GRIP],
    pass: [null, SAW_GRIP],
    place: [ON_BOARD, SAW_GRIP],
    work: [ON_BOARD, SAW_GRIP],
    lift: [null, SAW_GRIP],
    unpass: [null, SAW_GRIP],
    return: [null, SAW_GRIP],
  },
  plane: {
    reach: [null, TOTE],
    fetch: [null, TOTE],
    set: [KNOB, TOTE],
    work: [KNOB, TOTE],
    unset: [null, TOTE],
    return: [null, TOTE],
  },
  chisel: {
    reach: [CHISEL_GRIP, MALLET_GRIP],
    fetch: [CHISEL_GRIP, MALLET_GRIP],
    work: [CHISEL_GRIP, MALLET_GRIP],
    return: [CHISEL_GRIP, MALLET_GRIP],
  },
}

/**
 * The stagger, in the body frame (x = left, z = forward), metres: the left
 * foot forward and pointing toward the work line, the right foot back and
 * turned out.
 */
const FEET = {
  front: { x: 0.08, z: 0.17 },
  back: { x: -0.12, z: -0.15, yaw: -0.7 },
}
/** The direction the tools are pushed, in the world: along the board toward its free end. */
const WORK_YAW = -Math.PI / 2
const WORK_X = Math.sin(WORK_YAW)
const WORK_Z = Math.cos(WORK_YAW)
/** Step lift (m) and the two feet's swing windows within a walk (fractions). */
const LIFT = 0.06
const SWING: [[number, number], [number, number]] = [[0.1, 0.48], [0.52, 0.9]]
/** A hand counts as settled on its grip within this distance (m)... */
const SETTLED = 4e-4
/**
 * ...once it has been there this long (s): the library brings the palm's
 * orientation round a little after its position, so the hand closes on the
 * handle before the tool moves.
 */
const CLOSE = 0.15
/** Eyes on the cut through a stroke, the hands only glanced at. */
const ON_CUT: LookOptions = { priority: 'target' }
/** Seconds the hands take to come down before a wave starts. */
const RELEASE = 0.45
const STANDS: Record<Tool, Stand> = CARPENTER.stands
const PLANE_END: Stand = {
  x: STANDS.plane.x + WORK_X * CARPENTER.planeTravel,
  z: STANDS.plane.z + WORK_Z * CARPENTER.planeTravel,
  h: STANDS.plane.h,
}
const NEXT_REST: Record<Tool, ToolKey> = { saw: 'saw', plane: 'plane', chisel: 'chisel' }

export interface HandState {
  /** The tool held, or the board steadied. */
  tool: ToolKey | 'board'
  /** World grip point and the grip's normal (out of the tool, toward the palm) this step. */
  target: P3
  normal: P3
  /** The palm has arrived (true once the library's blend is done and the grip is in reach). */
  settled: boolean
  /** Seconds the palm has been on the grip (counting stops once it has closed). */
  on: number
}

export type WaveState = 'none' | 'pending' | 'releasing' | 'waving' | 'regrip'

export class Carpenter {
  readonly hands: Record<Side, HandState | null> = { left: null, right: null }
  wave: WaveState = 'none'
  private t = 0
  private waveT = 0
  private pointer: P3 | null = null
  private pointerT = -1e9
  private glanceUntil = -1
  private nextGlance = 0
  private viewer: P3 = { x: 2, y: 1.6, z: 3 }
  private stool: P3 = { x: 1, y: 0.4, z: 0 }
  private backedOff = false
  private paused = false
  private waveSeen = false
  /** Where the body is set (its ground point and heading, before any weight shift). */
  private stand: Stand
  private gait: Gait | null = null
  /** The plane walk-through of this action: not yet, walking out with the stroke, walking back. */
  private travel: 'none' | 'out' | 'back' = 'none'
  /** Weight shift along the work line (m of ground point; the hips move 0.4 of it), eased. */
  private shift = 0
  private shiftV = 0
  private readonly hw = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this } }
  private readonly look: P3 = { x: 0, y: 0, z: 0 }
  private readonly targets: Record<Side, GripTarget> = {
    left: { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, elbow: { x: 0, y: -1, z: 0 }, axis: { x: 1, y: 0, z: 0 }, kind: 'wrap', radius: 0.015 },
    right: { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, elbow: { x: 0, y: -1, z: 0 }, axis: { x: 1, y: 0, z: 0 }, kind: 'wrap', radius: 0.015 },
  }

  constructor(readonly person: Person, readonly sim: WorkshopSim, private readonly posterMode = false) {
    const s = STANDS.saw
    this.stand = { ...s }
    person.placeAt(s.x, s.z, s.h)
    person.setStance('stand', { instant: true })
    const f = this.feetFor(s)
    Object.assign(person.motion.feet[0], f[0])
    Object.assign(person.motion.feet[1], f[1])
  }

  /** True while the carpenter walks between places (hands free); not the plane's walk-through. */
  get walking() {
    return this.gait !== null && !this.gait.work
  }

  /** A point toward the viewer at head height (where a wave looks). */
  setViewer(p: P3) {
    this.viewer = { x: p.x, y: p.y, z: p.z }
  }

  /** The stool's place on the floor, in the world. */
  setStool(x: number, z: number) {
    this.stool = { x, y: 0.42, z }
  }

  /** The visitor's pointer as a world point near the carpenter, or null when it leaves. */
  setPointer(p: P3 | null) {
    if (!p) {
      this.pointer = null
      return
    }
    if (!this.pointer) this.pointer = { x: 0, y: 0, z: 0 }
    this.pointer.x = p.x
    this.pointer.y = p.y
    this.pointer.z = p.z
    this.pointerT = this.t
  }

  setPaused(p: boolean) {
    this.paused = p
    if (p && this.wave === 'pending') this.wave = 'none'
    this.person.setPaused(p)
  }

  /** A tap or the key: look up and wave as soon as the work can be let go. */
  requestWave(): string {
    if (this.posterMode || this.paused) return ''
    if (this.wave !== 'none') return 'The carpenter is already waving'
    this.wave = 'pending'
    return this.waveSafe() ? 'The carpenter looks up and waves' : 'The carpenter will wave after this stroke'
  }

  /** Before sim.step: should the action clock stand still this step? */
  hold(dt: number): boolean {
    if (this.posterMode) return false
    const tl = this.sim.timeline
    const cur = tl.current
    if (this.wave === 'pending' && this.waveSafe()) this.startWave()
    if (this.wave === 'releasing' || this.wave === 'waving') return true
    if (this.wave === 'regrip') {
      if (cur && !this.requiredSettled(cur, phaseOf(cur, tl.t).name)) return true
      this.wave = 'none'
    }
    // Idle: let a walk finish before the next action may begin.
    if (!cur) return this.walking
    const ph = phaseOf(cur, tl.t)
    if (ph.name === 'reach' && (this.walking || !this.atStation(cur))) return true
    // Leaving a static phase: every hand that holds a tool must have arrived.
    if (STATIC.has(ph.name) && phaseOf(cur, tl.t + dt).name !== ph.name && !this.requiredSettled(cur, ph.name)) return true
    return false
  }

  /** After sim.step: put the hands on this step's poses, lean, look, walk; step the person. */
  step(dt: number) {
    const p = this.person
    const tl = this.sim.timeline
    const cur = tl.current
    if (!this.posterMode) this.t += dt
    const ph = cur ? phaseOf(cur, tl.t) : null
    if (!cur || ph?.name === 'reach') this.travel = 'none'

    // ── Hands ───────────────────────────────────────────────────────────
    const away = this.walking || (!!cur && ph?.name === 'reach' && !this.atStation(cur))
    const free = away || this.wave === 'releasing' || this.wave === 'waving'
    const plan = cur && ph && !free ? PLAN[cur][ph.name] : undefined
    this.setHand('left', plan?.[0] ?? null)
    this.setHand('right', plan?.[1] ?? null)

    // ── Wave: hands down first, then the wave itself ────────────────────
    if (this.wave === 'releasing') {
      this.waveT += dt
      if (this.waveT >= RELEASE) {
        this.wave = 'waving'
        this.waveSeen = false
        p.play('wave', { hand: 'right' })
      }
    }

    // ── Feet ────────────────────────────────────────────────────────────
    if (!this.posterMode && !this.gait && this.wave === 'none') {
      if (cur && ph?.name === 'reach' && !this.atStation(cur) && !this.hands.left && !this.hands.right) {
        this.beginGait(STANDS[cur], false)
      }
      else if (cur === 'plane' && ph?.name === 'work' && this.travel === 'none') {
        // Step through with the stroke: the body travels with the plane.
        this.travel = 'out'
        this.beginGait(PLANE_END, true, ph.len - ph.t)
      }
      else if (cur === 'plane' && ph?.name === 'return' && this.travel === 'out') {
        this.travel = 'back'
        this.beginGait(STANDS.plane, true, ph.len - ph.t)
      }
      else if (!cur && this.sim.stoolTarget === 1 && this.sim.stoolU > 0 && !this.backedOff) {
        // Step back once to take in the stool coming apart.
        this.backedOff = true
        const dx = this.stand.x - this.stool.x
        const dz = this.stand.z - this.stool.z
        const l = Math.hypot(dx, dz) || 1
        this.beginGait({ x: this.stand.x + dx / l * CARPENTER.back, z: this.stand.z + dz / l * CARPENTER.back, h: this.stand.h }, false)
      }
    }
    if (this.sim.stoolU === 0 && this.sim.stoolTarget === 0) this.backedOff = false
    // A walk-through pauses while the work is put down for a wave.
    if (this.gait && !(this.gait.work && this.wave !== 'none')) this.advanceGait(dt)

    // ── Lean and weight ─────────────────────────────────────────────────
    let fwd = 0.06
    let side = 0
    let weight = 0
    if (cur && ph && !free) {
      if (cur === 'saw' && ph.name === 'work') {
        // Into each push (the stroke's velocity), ahead of the body's lag:
        // the hips go forward over the front foot and the torso follows.
        const w = 2 * Math.PI / SAW.period
        const push = Math.sin(w * ph.t + 0.9)
        fwd = 0.26 + 0.1 * push
        side = -0.04 * push
        weight = 0.09 * Math.sin(w * ph.t + 0.3)
      }
      else if (cur === 'plane' && ph.name === 'work') {
        // From the back foot at the start of the stroke to the front foot at its end.
        const e = smooth(ph.t / ph.len)
        fwd = 0.12 + 0.16 * e
        side = -0.05 * Math.sin(Math.PI * e)
        weight = -0.08 + 0.18 * e
      }
      else if (cur === 'plane' && ph.name === 'set') {
        fwd = 0.14
        weight = -0.08
      }
      else if (cur === 'chisel' && ph.name === 'work') {
        fwd = 0.16
      }
      else if (cur !== 'plane' && (ph.name === 'reach' || ph.name === 'return')) {
        // The saw, chisel and mallet wait well back on the bench: lean in to take them up and put them down.
        fwd = cur === 'saw' ? 0.48 : 0.42
      }
      else {
        // Reaching to the bench top and carrying: a moderate lean.
        fwd = 0.2
      }
    }
    p.setLean(fwd, side)
    this.stepShift(weight, dt)
    this.applyBody()

    // ── Eyes ────────────────────────────────────────────────────────────
    // (Person.lookAt only reads x, y, z.) From setting the tool on the work to
    // the stroke's end the cut has priority over the hands (which get glances
    // as they take new grips), so the eyes are there before the first stroke;
    // the library tracks it as it moves (kerf, plane mouth).
    const look = this.lookTarget(cur, ph?.name ?? null)
    const onCut = look === this.look && (ph?.name === 'work' || ph?.name === 'place' || ph?.name === 'set')
    p.lookAt(look as never, onCut ? ON_CUT : undefined)

    p.step(dt)

    // Waves end on their own; then hands go back on the work.
    if (this.wave === 'waving') {
      if (p.action === 'wave') this.waveSeen = true
      else if (this.waveSeen) {
        this.wave = 'regrip'
        this.waveSeen = false
        // Back to the tools: a look down at the hands as they take hold again.
        p.glanceAtHands()
        if (cur && ph?.name === 'reach') this.sim.restartReach()
      }
    }
    this.measure(dt)
  }

  /** Hands that must be settled to leave this phase (or to resume after a wave). */
  private requiredSettled(cur: Tool, name: PhaseName) {
    const plan = PLAN[cur][name]
    if (!plan) return true
    if (plan[0] && !this.hands.left?.settled) return false
    if (plan[1] && !this.hands.right?.settled) return false
    return true
  }

  private atStation(cur: Tool) {
    const s = STANDS[cur]
    const b = this.stand
    return !this.gait && Math.hypot(b.x - s.x, b.z - s.z) < 1e-3 && Math.abs(b.h - s.h) < 1e-3
  }

  /** The staggered feet for a stand, in the world. */
  private feetFor(s: Stand): [Foot, Foot] {
    const c = Math.cos(s.h), sn = Math.sin(s.h)
    const at = (lx: number, lz: number, yaw: number): Foot => ({ x: s.x + c * lx + sn * lz, z: s.z - sn * lx + c * lz, y: 0, yaw, pitch: 0 })
    // Front foot toward the work line, within what a hip comfortably turns.
    const frontYaw = s.h + Math.max(-0.6, Math.min(0.6, WORK_YAW - s.h))
    return [at(FEET.front.x, FEET.front.z, frontYaw), at(FEET.back.x, FEET.back.z, s.h + FEET.back.yaw)]
  }

  private beginGait(to: Stand, work: boolean, dur?: number) {
    const from = { ...this.stand }
    const d = Math.hypot(to.x - from.x, to.z - from.z)
    const f0 = this.person.motion.feet.map(f => ({ ...f })) as [Foot, Foot]
    const f1 = this.feetFor(to)
    // The foot with further to go steps first.
    const far = (i: 0 | 1) => Math.hypot(f1[i].x - f0[i].x, f1[i].z - f0[i].z)
    const len = dur ?? 1.3 + 1.6 * d + 0.4 * Math.abs(to.h - from.h)
    this.gait = { t: 0, dur: Math.max(0.3, len), from, to: { ...to }, f0, f1, first: far(1) > far(0) ? 1 : 0, work }
  }

  /** One step of a walk: the body glides and turns, each foot swings in its window. */
  private advanceGait(dt: number) {
    const g = this.gait!
    g.t = Math.min(g.dur, g.t + dt)
    const f = g.t / g.dur
    const k = smoother((f - 0.06) / 0.88)
    this.stand.x = g.from.x + (g.to.x - g.from.x) * k
    this.stand.z = g.from.z + (g.to.z - g.from.z) * k
    this.stand.h = g.from.h + (g.to.h - g.from.h) * k
    const feet = this.person.motion.feet
    for (const i of [0, 1] as const) {
      const [a, b] = SWING[i === g.first ? 0 : 1]
      const u = smoother((f - a) / (b - a))
      const p = g.f0[i], q = g.f1[i]
      feet[i].x = p.x + (q.x - p.x) * u
      feet[i].z = p.z + (q.z - p.z) * u
      feet[i].yaw = p.yaw + (q.yaw - p.yaw) * u
      feet[i].pitch = 0
      feet[i].y = f > a && f < b ? LIFT * Math.sin(Math.PI * u) : 0
    }
    if (g.t >= g.dur) {
      this.stand.x = g.to.x
      this.stand.z = g.to.z
      this.stand.h = g.to.h
      this.gait = null
    }
  }

  /** Weight shift toward `target`, critically damped (no snap when a stroke starts or stops). */
  private stepShift(target: number, dt: number) {
    if (this.posterMode) {
      this.shift = target
      return
    }
    const w = 7
    this.shiftV += (w * w * (target - this.shift) - 2 * w * this.shiftV) * dt
    this.shift += this.shiftV * dt
  }

  /** Put the body where it stands, shifted along the work line; the legs re-solve to the planted feet. */
  private applyBody() {
    const m = this.person.motion
    m.pos.x = this.stand.x + WORK_X * this.shift
    m.pos.z = this.stand.z + WORK_Z * this.shift
    m.heading = this.stand.h
  }

  /** Can both hands let go now without anything falling? */
  private waveSafe() {
    const tl = this.sim.timeline
    const cur = tl.current
    if (!cur) return !this.walking
    const ph = phaseOf(cur, tl.t).name
    if (ph === 'reach') return !this.walking
    if (cur === 'saw') return ph === 'work' && this.sim.kerf >= 0.008
    if (cur === 'plane') return ph === 'set' || ph === 'work'
    return false
  }

  private startWave() {
    this.wave = 'releasing'
    this.waveT = 0
    this.setHand('left', null)
    this.setHand('right', null)
  }

  private setHand(side: Side, h: Hold | null) {
    const p = this.person
    if (!h) {
      if (this.hands[side]) p.setHandTarget(side, null)
      this.hands[side] = null
      return
    }
    const t = this.targets[side]
    gripWorld(h.grip, h.tool === 'board' ? BOARD_POSE : this.sim.pose[h.tool], t.position, t.normal, t.axis, M)
    // The elbow hint is body-relative: turn it by the body's heading into the world.
    const c = Math.cos(this.stand.h), s = Math.sin(this.stand.h)
    t.elbow.x = c * h.elbow.x + s * h.elbow.z
    t.elbow.y = h.elbow.y
    t.elbow.z = -s * h.elbow.x + c * h.elbow.z
    t.kind = h.grip.kind
    t.radius = h.grip.radius
    p.setHandTarget(side, t)
    const st = this.hands[side]
    if (st && st.tool === h.tool) {
      st.target.x = t.position.x
      st.target.y = t.position.y
      st.target.z = t.position.z
      st.normal.x = t.normal.x
      st.normal.y = t.normal.y
      st.normal.z = t.normal.z
    }
    else {
      this.hands[side] = { tool: h.tool, target: { ...t.position }, normal: { ...t.normal }, settled: false, on: 0 }
    }
  }

  /** After the person's step: which hands have arrived on their grips. */
  private measure(dt: number) {
    for (const side of ['left', 'right'] as const) {
      const s = this.hands[side]
      if (!s) continue
      this.person.handWorld(side, this.hw as never)
      const on = Math.hypot(this.hw.x - s.target.x, this.hw.y - s.target.y, this.hw.z - s.target.z) < SETTLED
      // Once the hand has closed on the grip it stays closed: a later hair of lag is not a new grasp.
      if (s.on < CLOSE - 1e-9) s.on = on ? s.on + dt : 0
      s.settled = on && s.on >= CLOSE - 1e-9
    }
  }

  /** The cut being worked, in the world (what the eyes are on during a stroke). */
  workPoint(cur: Tool, out: P3) {
    if (cur === 'saw') {
      out.x = M * (BOARD.x1 - 0.02)
      out.y = BOARD.top - this.sim.kerf * 0.5
    }
    else if (cur === 'plane') {
      out.x = M * (this.sim.pose.plane[0]! + PLANE.throat[0])
      out.y = BOARD.top
    }
    else {
      out.x = M * CHISEL.x
      out.y = BOARD.top + CHISEL.len
    }
    out.z = BOARD.z
    return out
  }

  private lookTarget(cur: Tool | null, ph: PhaseName | null): P3 | null {
    const L = this.look
    if (this.wave === 'waving' || this.wave === 'releasing') return this.viewer
    const hovering = this.pointer && this.t - this.pointerT < 4
    if (cur && ph && (ph === 'work' || ph === 'place' || ph === 'set')) {
      // Hands on the tools: the library keeps the eyes there; this gets a glance.
      if (hovering) return this.pointer
      return this.workPoint(cur, L)
    }
    if (!cur && this.sim.stoolU > 0) return this.stool
    // Between actions: now and then a glance at the visitor's pointer.
    if (hovering && this.t >= this.nextGlance) {
      this.glanceUntil = this.t + 1.1
      this.nextGlance = this.t + 4.5
    }
    if (hovering && this.t < this.glanceUntil) return this.pointer
    // Otherwise the head turns to the tool that comes next.
    const r = REST[NEXT_REST[this.sim.timeline.upcoming]]
    L.x = M * r[0]
    L.y = r[1] + 0.03
    L.z = r[2]
    return L
  }
}
