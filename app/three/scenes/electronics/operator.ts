import { IRON, lerp3, norm, REACH, RIGHT_REST, SEAT, SOLDER, type V3 } from './bench-layout'
import type { SessionState, WorkbenchSim } from './bench-sim'

/**
 * THE OPERATOR CONTRACT: everything the seated maker needs to work this
 * bench, as pure functions of the simulation, and the driver that applies
 * them to a person (people library) every step:
 *
 *   person.placeAt(SEAT.x, SEAT.z, SEAT.heading)            // once
 *   person.setStance('sit', { seatHeight: SEAT.top, instant: true })
 *   const driver = new OperatorDriver(person)
 *   // every step, after sim.step(dt) and before person.step(dt):
 *   driver.drive(sim, viewerPoint)
 *
 * World units are metres (person scale 1). The grips are always defined (never
 * null), so a hand never snaps: at rest the right hand lies flat on the bench
 * beside the mat and the left holds the solder wire; during a session the
 * right hand eases onto the iron's grip before the iron moves and off it after
 * the iron is home. Every grip stays inside REACH of its shoulder (tested).
 */

export { REACH, SEAT }

/** A people-library hand target: palm centre, the surface normal toward the palm, and an elbow hint. */
export interface Grip { position: V3, normal: V3, elbow: V3 }

/** Palm centre above the grip surface (a pen grip holds the iron in the fingertips). */
const PALM_LIFT = 0.025
const UP: V3 = [0, 1, 0]
const RIGHT_ELBOW = norm([0.35, -0.8, 0.45])
const LEFT_ELBOW = norm([-0.35, -0.8, 0.45])
const RIGHT_REST_NORMAL: V3 = [0, 1, 0]

/** The point on the iron's grip sleeve and the normal out of it toward the palm (up, square to the axis). */
export function ironHandle(tip: V3, axis: V3) {
  const d = UP[0] * axis[0] + UP[1] * axis[1] + UP[2] * axis[2]
  const n = norm([UP[0] - axis[0] * d, UP[1] - axis[1] * d, UP[2] - axis[2] * d])
  const g = IRON.gripAt
  const r = IRON.r
  const p: V3 = [tip[0] + axis[0] * g + n[0] * r, tip[1] + axis[1] * g + n[1] * r, tip[2] + axis[2] * g + n[2] * r]
  return { point: p, normal: n }
}

/**
 * Right hand: on the iron's grip while it is held (session.grip = 1), on the
 * bench at rest (0), eased along a low arc in between.
 */
export function ironGrip(s: SessionState, out?: Grip): Grip {
  const o = out ?? { position: [0, 0, 0], normal: [0, 0, 0], elbow: [...RIGHT_ELBOW] as V3 }
  const h = ironHandle(s.iron.tip, s.iron.axis)
  const on: V3 = [h.point[0] + h.normal[0] * PALM_LIFT, h.point[1] + h.normal[1] * PALM_LIFT, h.point[2] + h.normal[2] * PALM_LIFT]
  const k = s.grip
  lerp3(RIGHT_REST, on, k, o.position)
  o.position[1] += 0.05 * Math.sin(Math.PI * k)
  const n = norm(lerp3(RIGHT_REST_NORMAL, h.normal, k))
  o.normal[0] = n[0]
  o.normal[1] = n[1]
  o.normal[2] = n[2]
  o.elbow[0] = RIGHT_ELBOW[0]
  o.elbow[1] = RIGHT_ELBOW[1]
  o.elbow[2] = RIGHT_ELBOW[2]
  return o
}

/** Where the left hand pinches the solder wire: SOLDER.stick back from its tip. */
export function solderPinch(s: SessionState): V3 {
  const { tip, dir } = s.solder
  return [tip[0] - dir[0] * SOLDER.stick, tip[1] - dir[1] * SOLDER.stick, tip[2] - dir[2] * SOLDER.stick]
}

/** Left hand: pinching the solder wire, the palm just above the pinch. */
export function solderGrip(s: SessionState, out?: Grip): Grip {
  const o = out ?? { position: [0, 0, 0], normal: [0, 0, 0], elbow: [...LEFT_ELBOW] as V3 }
  const p = solderPinch(s)
  const d = s.solder.dir
  const dd = d[1]
  const n = norm([-d[0] * dd, 1 - d[1] * dd, -d[2] * dd])
  o.position[0] = p[0] + n[0] * 0.018
  o.position[1] = p[1] + n[1] * 0.018
  o.position[2] = p[2] + n[2] * 0.018
  o.normal[0] = n[0]
  o.normal[1] = n[1]
  o.normal[2] = n[2]
  o.elbow[0] = LEFT_ELBOW[0]
  o.elbow[1] = LEFT_ELBOW[1]
  o.elbow[2] = LEFT_ELBOW[2]
  return o
}

/** The joint being soldered (or the tool running, or a glance between jobs); null = look up at the visitor. */
export function lookTarget(sim: WorkbenchSim, out?: V3): V3 | null {
  return sim.look(out)
}

interface P3 { x: number, y: number, z: number }
interface HandTarget { position: P3, normal?: P3, elbow?: P3 }

/** The part of the people library's Person (or PersonMotion) the driver uses. */
export interface OperatorBody {
  setHandTarget(side: 'left' | 'right', target: HandTarget | null): void
  setLean(forward: number, side?: number): void
  lookAt(target: P3 | null): void
  play(action: 'wave', opts?: { hand?: 'left' | 'right' }): void
}

function toTarget(g: Grip, out: HandTarget): HandTarget {
  const set = (o: P3, v: V3) => {
    o.x = v[0]
    o.y = v[1]
    o.z = v[2]
  }
  set(out.position, g.position)
  set(out.normal!, g.normal)
  set(out.elbow!, g.elbow)
  return out
}

/**
 * Applies the contract to a body every step: the right hand on the iron's
 * grip (or at rest beside the mat), the left pinching the solder wire, the
 * torso leaning in over a joint, the eyes on the work -- and, when the visitor
 * taps him, the right hand let go for a wave while he looks up at them.
 * Driven from the simulation's state only, so it is deterministic per step.
 */
export class OperatorDriver {
  private readonly gr = ironGrip(newRest())
  private readonly gl = solderGrip(newRest())
  private readonly tr: HandTarget = { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, elbow: { x: 0, y: 0, z: 0 } }
  private readonly tl: HandTarget = { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, elbow: { x: 0, y: 0, z: 0 } }
  private readonly look: V3 = [0, 0, 0]
  private readonly lookP: P3 = { x: 0, y: 0, z: 0 }
  private waving = false

  constructor(private readonly body: OperatorBody) {}

  /** `viewer`: where to look when he looks up at the visitor (a point toward the camera). */
  drive(sim: WorkbenchSim, viewer: V3) {
    const b = this.body
    if (sim.waveT > 0) {
      if (!this.waving) {
        this.waving = true
        b.setHandTarget('right', null)
        b.play('wave', { hand: 'right' })
      }
    }
    else {
      this.waving = false
      b.setHandTarget('right', toTarget(ironGrip(sim.session, this.gr), this.tr))
    }
    b.setHandTarget('left', toTarget(solderGrip(sim.session, this.gl), this.tl))
    b.setLean(sim.lean, 0)
    const l = sim.look(this.look) ?? viewer
    this.lookP.x = l[0]
    this.lookP.y = l[1]
    this.lookP.z = l[2]
    b.lookAt(this.lookP)
  }
}

function newRest(): SessionState {
  return {
    iron: { tip: [0, 0, 0], axis: [1, 0, 0] },
    grip: 0,
    solder: { tip: [0, 0, 0], dir: [1, 0, 0] },
    contact: false,
    joint: -1,
    feed: 0,
    phase: 'idle',
  }
}
