import * as THREE from 'three'
import { beamGeometry, blockGeometry, discGeometry, extrude, type Materials } from '../../core/kit'
import { DRILL, IRON, SAW, type V3 } from './bench-layout'
import { meterFrame, METER_KNOB } from './bench'
import { cyl, PartSet } from './build'

/**
 * The parts of the bench that move, each a rigid PartSet on its own node:
 * the soldering iron (posed every frame from the simulation's tip and axis),
 * the drill press's quill-and-chuck (travels and spins) and feed handle
 * (turns with the travel, rack and pinion), the mitre saw's arm (pivots) and
 * blade (spins), and the multimeter's range knob.
 */

/** Cylinder lying along +x (so tools can be built along their own axis). */
const xcyl = (r: number, len: number, seg = 24) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(-Math.PI / 2)

/** The iron, built along +x from its tip at the node origin; overlay target 'iron'. */
export function buildIron(m: Materials) {
  const s = new PartSet()
  const tip = s.geo(new THREE.CylinderGeometry(0.0042, 0.0012, IRON.tip, 16).rotateZ(-Math.PI / 2))
  s.add('iron', tip, 'metal', { pos: [IRON.tip / 2, 0, 0] })
  s.add('iron', s.geo(xcyl(0.0048, IRON.shaft - IRON.tip)), 'metal', { pos: [(IRON.tip + IRON.shaft) / 2, 0, 0] })
  s.add('iron', s.geo(xcyl(0.008, 0.012)), 'dark', { pos: [IRON.shaft + 0.006, 0, 0] })
  const grip = IRON.grip - IRON.shaft - 0.012
  s.add('iron', s.geo(xcyl(IRON.r, grip)), 'dark', { pos: [IRON.shaft + 0.012 + grip / 2, 0, 0] })
  // Two thin finger rings on the grip sleeve so its turn reads.
  const ring = s.geo(xcyl(IRON.r + 0.0012, 0.004))
  for (const x of [IRON.shaft + 0.03, IRON.shaft + 0.05]) s.add('iron', ring, 'metal', { pos: [x, 0, 0] })
  s.add('iron', s.geo(new THREE.CylinderGeometry(0.0055, IRON.r * 0.9, IRON.end - IRON.grip, 24).rotateZ(-Math.PI / 2)), 'dark', { pos: [(IRON.grip + IRON.end) / 2, 0, 0] })
  const { group, picks } = s.build(m, 'iron')
  const node = new THREE.Group()
  node.name = 'iron'
  node.add(group)
  const x = new THREE.Vector3()
  const y = new THREE.Vector3()
  const z = new THREE.Vector3()
  const mtx = new THREE.Matrix4()
  /** Pose the node: tip point and unit axis (tip toward the cable end). */
  function pose(tipP: ArrayLike<number>, axis: ArrayLike<number>) {
    x.set(axis[0]!, axis[1]!, axis[2]!).normalize()
    // Keep the grip's "up" square to the axis and as close to world up as it gets.
    y.set(0, 1, 0).addScaledVector(x, -x.y).normalize()
    z.crossVectors(x, y)
    mtx.makeBasis(x, y, z)
    node.quaternion.setFromRotationMatrix(mtx)
    node.position.set(tipP[0]!, tipP[1]!, tipP[2]!)
  }
  return { node, picks, pose }
}

/** Drill press quill, chuck and bit: one node on the spindle axis; it travels down y and spins about y. */
export function buildQuill(m: Materials) {
  const s = new PartSet()
  // The quill is long enough to stay inside the head over the full travel.
  s.add('drillPress', s.geo(cyl(0.015, 0.1)), 'metal', { pos: [0, 0.05, 0] })
  // A hex chuck: its six facets catch the light as it turns.
  s.add('drillPress', s.geo(new THREE.CylinderGeometry(0.014, 0.017, DRILL.chuck, 6)), 'metal', { pos: [0, -DRILL.chuck / 2, 0] })
  s.add('drillPress', s.geo(new THREE.CylinderGeometry(0.0028, 0.0028, DRILL.bit, 8)), 'metal', { pos: [0, -DRILL.chuck - DRILL.bit / 2, 0], edges: false })
  const { group, picks } = s.build(m, 'quill')
  const node = new THREE.Group()
  node.name = 'quill'
  node.add(group)
  node.position.set(DRILL.x, DRILL.nose, DRILL.sz)
  return { node, picks }
}

/** Feed handle: three spokes with knobs on a hub, turning about x. */
export function buildFeed(m: Materials) {
  const s = new PartSet()
  s.add('drillPress', s.geo(xcyl(0.014, 0.022)), 'metal', { pos: [0.011, 0, 0] })
  const spoke = s.geo(cyl(0.004, DRILL.spoke))
  const knob = s.geo(new THREE.SphereGeometry(0.011, 16, 10))
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI * 2 / 3
    const dy = Math.cos(a)
    const dz = Math.sin(a)
    s.add('drillPress', spoke, 'metal', { pos: [0.016, dy * DRILL.spoke / 2, dz * DRILL.spoke / 2], rot: [a, 0, 0] })
    s.add('drillPress', knob, 'dark', { pos: [0.016, dy * DRILL.spoke, dz * DRILL.spoke] })
  }
  const { group, picks } = s.build(m, 'feed')
  const node = new THREE.Group()
  node.name = 'feed'
  node.add(group)
  node.position.set(...DRILL.hub)
  return { node, picks }
}

/**
 * Mitre saw arm on its pivot (rotation.x = -angle, + raises it) with the
 * blade on a child node at the arbor (rotation.x = blade angle). Arm local:
 * +z from the pivot toward the blade centre.
 */
export function buildSawArm(m: Materials) {
  const w = SAW
  const s = new PartSet()
  const R = w.bladeR
  s.add('mitreSaw', s.geo(blockGeometry(0.04, 0.045, w.reach)), 'light', { pos: [0.045, 0.035, w.reach / 2] })
  s.add('mitreSaw', s.geo(xcyl(0.038, 0.085)), 'mid', { pos: [0.075, 0, w.reach] })
  // Upper guard: half a disc over the top of the blade, straddling it.
  const guard = new THREE.Shape()
  const gr = R + 0.016
  guard.moveTo(gr, -0.012)
  guard.absarc(0, -0.012, gr, 0, Math.PI, false)
  guard.closePath()
  s.add('mitreSaw', s.geo(extrude(guard, 0.034, 24).rotateY(Math.PI / 2)), 'light', { pos: [0, 0, w.reach] })
  // D-handle and its trigger (red: the switch that drives the blade).
  s.add('mitreSaw', s.geo(blockGeometry(0.026, 0.026, 0.13)), 'dark', { pos: [0, gr + 0.03, w.reach + 0.03], rot: [0.25, 0, 0] })
  s.add('mitreSaw', s.geo(blockGeometry(0.02, 0.06, 0.022)), 'dark', { pos: [0, gr - 0.0, w.reach - 0.035] })
  s.add('mitreSaw', s.geo(blockGeometry(0.012, 0.022, 0.014)), 'red', { pos: [0, gr + 0.008, w.reach + 0.07] })
  const arm = s.build(m, 'sawArm')

  const b = new PartSet()
  const holes = Array.from({ length: 5 }, (_, k) => {
    const a = k * Math.PI * 2 / 5
    return { x: Math.cos(a) * R * 0.58, y: Math.sin(a) * R * 0.58, r: R * 0.11 }
  })
  b.add('mitreSaw', b.geo(discGeometry(R, 0.0022, holes, 48).rotateY(Math.PI / 2)), 'metal')
  b.add('mitreSaw', b.geo(xcyl(0.016, 0.012, 6)), 'metal')
  const blade = b.build(m, 'blade')

  const node = new THREE.Group()
  node.name = 'sawArm'
  node.add(arm.group)
  const bladeNode = new THREE.Group()
  bladeNode.name = 'blade'
  bladeNode.add(blade.group)
  bladeNode.position.set(0, 0, w.reach)
  node.add(bladeNode)
  node.position.set(...w.pivot)
  return { node, bladeNode, picks: [...arm.picks, ...blade.picks] }
}

/** Multimeter range knob: a pointer bar turning about the dial's axis. */
export function buildKnob(m: Materials) {
  const s = new PartSet()
  s.add('multimeter', s.geo(beamGeometry({ length: 0.036, width: 0.012, thickness: 0.008, holes: [] })), 'light', { pos: [0, -0.012, 0.008], rot: [0, 0, Math.PI / 2] })
  const { group, picks } = s.build(m, 'knob')
  const node = new THREE.Group()
  node.name = 'knob'
  const turn = new THREE.Group()
  turn.add(group)
  node.add(turn)
  node.applyMatrix4(new THREE.Matrix4().makeTranslation(...(METER_KNOB as V3)).premultiply(meterFrame()))
  return { node, turn, picks }
}
