import type { Mat3 } from './kin'
import { smooth } from './kin'

/**
 * SCRIPTED motion for falls and get-ups, shared by the dog and Makey. Pure
 * TypeScript. This is choreography, not a simulation, and it is labelled as
 * such wherever it is used -- but it is choreography held to the ground:
 *
 * 1. A Script is a list of keyframes: body pitch / roll / yaw (relative to
 *    the heading the fall started at), every joint angle, and an optional
 *    lift off the ground. Each segment has its own duration and easing (a
 *    topple eases IN, like something accelerating under gravity; an impact
 *    rebound eases OUT).
 * 2. The body's POSITION is never keyframed. `Support.place` finds it from
 *    the pose: the body rests on the lowest of the robot's support points
 *    (feet, knees, hands, shell corners...), and the point it rests on does
 *    not slide -- the body moves so that point stays where it touched down.
 *    So a robot tipping over pivots about the edge it tips over, rolls over
 *    its shell, and pushes itself up from where its hands and feet are,
 *    and nothing ever goes through the floor.
 */

export type Ease = 'in' | 'out' | 'inout' | 'lin'

export interface ScriptPose {
  pitch: number
  roll: number
  /** Relative to the heading at the start of the script. */
  yaw: number
  /** Every joint, in the owner's order. */
  q: number[]
  /** Height above resting on the lowest point (m), for a hop or a bounce. */
  lift: number
}

export interface Key {
  dur: number
  ease: Ease
  pose: ScriptPose
  /** Named phase, so the owner can play a sound or hand over at a phase boundary. */
  tag: string
}

const easeFn = (e: Ease, t: number) => (e === 'in' ? t * t : e === 'out' ? 1 - (1 - t) * (1 - t) : e === 'inout' ? smooth(t) : t)

export function copyScriptPose(src: ScriptPose, dst: ScriptPose) {
  dst.pitch = src.pitch
  dst.roll = src.roll
  dst.yaw = src.yaw
  dst.lift = src.lift
  for (let i = 0; i < src.q.length; i++) dst.q[i] = src.q[i]!
}

export function newScriptPose(n: number): ScriptPose {
  return { pitch: 0, roll: 0, yaw: 0, q: new Array(n).fill(0), lift: 0 }
}

export class Script {
  keys: Key[] = []
  /** Index of the segment being played; keys.length when done. */
  i = 0
  /** Time into the segment. */
  t = 0
  private readonly from: ScriptPose
  readonly pose: ScriptPose

  constructor(n: number) {
    this.from = newScriptPose(n)
    this.pose = newScriptPose(n)
  }

  get done() {
    return this.i >= this.keys.length
  }

  get tag() {
    return this.done ? '' : this.keys[this.i]!.tag
  }

  /** 0..1 within the current segment. */
  get u() {
    return this.done ? 1 : Math.min(1, this.t / this.keys[this.i]!.dur)
  }

  start(keys: Key[], from: ScriptPose) {
    this.keys = keys
    this.i = 0
    this.t = 0
    copyScriptPose(from, this.from)
    copyScriptPose(from, this.pose)
  }

  /** Advance; returns true when a segment boundary was crossed this step. */
  step(dt: number) {
    if (this.done) return false
    this.t += dt
    let crossed = false
    while (!this.done && this.t >= this.keys[this.i]!.dur) {
      this.t -= this.keys[this.i]!.dur
      copyScriptPose(this.keys[this.i]!.pose, this.from)
      this.i++
      crossed = true
    }
    if (this.done) {
      copyScriptPose(this.from, this.pose)
      return crossed
    }
    const k = this.keys[this.i]!
    const e = easeFn(k.ease, Math.min(1, this.t / k.dur))
    const a = this.from, b = k.pose, p = this.pose
    p.pitch = a.pitch + (b.pitch - a.pitch) * e
    p.roll = a.roll + (b.roll - a.roll) * e
    p.yaw = a.yaw + (b.yaw - a.yaw) * e
    p.lift = a.lift + (b.lift - a.lift) * e
    for (let j = 0; j < p.q.length; j++) p.q[j] = a.q[j]! + (b.q[j]! - a.q[j]!) * e
    return crossed
  }
}

/**
 * Ground support from a set of body-frame points. Call place() once per
 * step with the body's new orientation and the support points for the new
 * joint angles; it writes the body position.
 */
export class Support {
  /** World positions of the points after the last place(). */
  private world: Float64Array
  private n = 0
  /** Index of the point the body rested on last step, or -1. */
  rest = -1

  constructor(max: number) {
    this.world = new Float64Array(max * 3)
  }

  /** Forget contact history (a new script starts from wherever the body is). */
  reset() {
    this.n = 0
    this.rest = -1
  }

  /**
   * pts: body-frame points (x, y, z packed), n of them, each a ball of radius
   * rad[i] (a foot pad, a knee, a shell corner). body: position in/out
   * (x and z are adjusted so the resting point does not slide; y is set so
   * the lowest point touches the ground, plus `lift`).
   */
  place(R: Mat3, pts: Float64Array, rad: Float64Array, n: number, body: { x: number, y: number, z: number }, lift: number) {
    let lo = Infinity, j = 0
    for (let i = 0; i < n; i++) {
      const k = i * 3
      const oy = R[3] * pts[k]! + R[4] * pts[k + 1]! + R[5] * pts[k + 2]! - rad[i]!
      if (oy < lo) {
        lo = oy
        j = i
      }
    }
    const k = j * 3
    const ox = R[0] * pts[k]! + R[1] * pts[k + 1]! + R[2] * pts[k + 2]!
    const oz = R[6] * pts[k]! + R[7] * pts[k + 1]! + R[8] * pts[k + 2]!
    // The resting point stays put if it was on the ground last step too.
    if (this.n === n && this.world[k + 1]! - rad[j]! < 0.002 + lift) {
      body.x = this.world[k]! - ox
      body.z = this.world[k + 2]! - oz
    }
    body.y = -lo + lift
    this.rest = j
    this.n = n
    for (let i = 0; i < n; i++) {
      const q = i * 3
      const px = pts[q]!, py = pts[q + 1]!, pz = pts[q + 2]!
      this.world[q] = body.x + R[0] * px + R[1] * py + R[2] * pz
      this.world[q + 1] = body.y + R[3] * px + R[4] * py + R[5] * pz
      this.world[q + 2] = body.z + R[6] * px + R[7] * py + R[8] * pz
    }
    this.rad = rad
  }

  /** The body was pushed (contact): the remembered contact points move with it. */
  shift(dx: number, dz: number) {
    for (let i = 0; i < this.n; i++) {
      this.world[i * 3] = this.world[i * 3]! + dx
      this.world[i * 3 + 2] = this.world[i * 3 + 2]! + dz
    }
  }

  private rad: Float64Array = new Float64Array(0)

  /** Lowest surface height among the points after the last place() (tests: never below the ground). */
  lowest() {
    let lo = Infinity
    for (let i = 0; i < this.n; i++) lo = Math.min(lo, this.world[i * 3 + 1]! - this.rad[i]!)
    return lo
  }
}
