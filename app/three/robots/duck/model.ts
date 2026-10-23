import * as THREE from 'three'
import { Assembly, beamGeometry, blockGeometry, discGeometry, extrude, pinGeometry, type MatKey, type Materials } from '../../core/kit'
import { LEG, mul, pelvisRotation, rotX, rotY, rotZ, solveLeg, type LegSolution, type Mat3, type Vec3 } from './ik'
import type { DuckPose } from './gait'

/**
 * The duck's body: an original open-hardware-style biped built from the beam
 * kit. A compact box torso; legs of dark servo blocks joined by straight
 * slotted links ending in flat feet; a three-link servo neck rising from the
 * front of the torso; a rounded helmet head (an extruded side profile) with a
 * flat bill beam underneath and one round camera eye.
 *
 * Two layers, kept apart on purpose:
 * - The SKELETON: bare transform nodes in the exact joint order of ik.ts
 *   (pelvis -> hip yaw -> hip roll+pitch -> knee -> ankle pitch+roll; neck
 *   yaw -> three neck links -> head). poseSkeleton() solves the IK and writes
 *   the joint angles. The tests pose this very skeleton and read the soles
 *   back from its world matrices, so what is tested is what is drawn.
 * - The PARTS: one rigid Assembly per moving part, hung on its node.
 *
 * Draw-call budget (A1.1 §6, <= 28): an assembly costs one call per material
 * plus one for its hairlines. Hairlines on dark parts are invisible (ink on
 * near-ink), so all-dark assemblies are built without edges and cost a
 * single call. Count: torso 3, hip-yaw brackets 2 x 1, thighs 2 x 3, shins
 * 2 x 1, feet 2 x 2, neck links 3 x 1, head 4, contact shadow 1 = 25; the
 * cyan selection ring adds 1.
 */

const NECK_LINK = 0.034
/** Neck yaw joint, pelvis frame: on top of the torso, at the front. */
const NECK_BASE: [number, number, number] = [0, 0.109, 0.03]
/** Resting neck curve: lean forward from the body, then lift back -- an S, like a bird's. */
const NECK_POSTURE = [0.5, -0.15, -0.3]
/** How a downward/upward look is shared among the three neck links. */
const NECK_SHARE = [0.45, 0.35, 0.2]
export const SOLE_OFFSET = -LEG.ankleH
/** The body shell leans forward this much (rad) in the pelvis frame: the micro duck's eager stance. */
export const BODY_LEAN = 0.18

export interface DuckSkeleton {
  root: THREE.Group
  pelvis: THREE.Group
  legs: { hipYaw: THREE.Group, thigh: THREE.Group, shin: THREE.Group, foot: THREE.Group }[]
  neckYaw: THREE.Group
  neck: THREE.Group[]
  head: THREE.Group
}

const node = (name: string, parent?: THREE.Object3D, pos?: [number, number, number], order?: THREE.EulerOrder) => {
  const g = new THREE.Group()
  g.name = name
  if (pos) g.position.set(...pos)
  if (order) g.rotation.order = order
  parent?.add(g)
  return g
}

export function createSkeleton(): DuckSkeleton {
  const root = node('duck')
  // Pelvis: yaw, then pitch, then roll -- the same order as ik.pelvisRotation.
  const pelvis = node('pelvis', root, undefined, 'YXZ')
  const legs = [1, -1].map((side) => {
    const hipYaw = node('hipYaw', pelvis, [side * LEG.hipW, 0, 0])
    // Hip roll (Z) then hip pitch (X): Euler 'ZXY' is Rz * Rx * Ry.
    const thigh = node('thigh', hipYaw, undefined, 'ZXY')
    const shin = node('shin', thigh, [0, -LEG.L1, 0])
    // Ankle pitch (X) then ankle roll (Z): Euler 'XZY' is Rx * Rz * Ry.
    const foot = node('foot', shin, [0, -LEG.L2, 0], 'XZY')
    return { hipYaw, thigh, shin, foot }
  })
  const neckYaw = node('neckYaw', pelvis, NECK_BASE)
  const n0 = node('neck0', neckYaw)
  const n1 = node('neck1', n0, [0, NECK_LINK, 0])
  const n2 = node('neck2', n1, [0, NECK_LINK, 0])
  const head = node('head', n2, [0, NECK_LINK, 0], 'YXZ')
  return { root, pelvis, legs, neckYaw, neck: [n0, n1, n2], head }
}

// poseSkeleton runs every frame per robot: scratch instead of fresh arrays.
const POSE_R: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0]
const SOLE_R: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0]
const SOLE_Y: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0]
const SOLE_X: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0]
const SOLE_T: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0]
const POSE_P: Vec3 = [0, 0, 0]
const SOLE_P: Vec3 = [0, 0, 0]

/**
 * Pose the skeleton: pelvis from the pose, legs from the IK, neck and head
 * from the look springs. `sols` receives the two leg solutions (for tests and
 * diagnostics).
 */
export function poseSkeleton(sk: DuckSkeleton, pose: DuckPose, sols: [LegSolution, LegSolution]) {
  sk.pelvis.position.set(pose.x, pose.y, pose.z)
  sk.pelvis.rotation.set(pose.pitch, pose.yaw, pose.roll)
  const R = pelvisRotation(pose.yaw, pose.pitch, pose.roll, POSE_R)
  POSE_P[0] = pose.x; POSE_P[1] = pose.y; POSE_P[2] = pose.z
  for (let i = 0; i < 2; i++) {
    const f = pose.feet[i]!
    SOLE_P[0] = f.x; SOLE_P[1] = f.y; SOLE_P[2] = f.z
    // A walking sole is flat (yaw only); a fallen duck's tucked sole tilts with it.
    const soleR = f.pitch || f.roll
      ? mul(mul(rotY(f.yaw, SOLE_Y), rotX(f.pitch ?? 0, SOLE_X), SOLE_T), rotZ(f.roll ?? 0, SOLE_X), SOLE_R)
      : rotY(f.yaw, SOLE_R)
    const q = solveLeg(POSE_P, R, i === 0 ? 1 : -1, SOLE_P, soleR, sols[i])
    const leg = sk.legs[i]!
    leg.hipYaw.rotation.y = q.hipYaw
    leg.thigh.rotation.set(q.hipPitch, 0, q.hipRoll)
    leg.shin.rotation.x = q.knee
    leg.foot.rotation.set(q.anklePitch, 0, q.ankleRoll)
  }
  // Neck: the base turns the whole neck; looking down curls the links forward.
  sk.neckYaw.rotation.y = pose.neckYaw
  let sum = 0
  for (let i = 0; i < 3; i++) {
    const a = NECK_POSTURE[i]! - pose.neckPitch * NECK_SHARE[i]!
    sk.neck[i]!.rotation.x = a
    sum += a
  }
  // The head holds its pitch against the horizon (it undoes the body's lean
  // and the neck's curve), plus whatever the lagging head spring adds.
  sk.head.rotation.set(-pose.headPitch - sum - pose.pitch, pose.headYaw - pose.neckYaw, 0)
}

// ── Geometry ──────────────────────────────────────────────────────────────

/** Re-axis a kit geometry: its local +X goes to `x`, +Y to `y` (+Z follows). */
function orient(g: THREE.BufferGeometry, x: [number, number, number], y: [number, number, number]) {
  const vx = new THREE.Vector3(...x)
  const vy = new THREE.Vector3(...y)
  g.applyMatrix4(new THREE.Matrix4().makeBasis(vx, vy, vx.clone().cross(vy)))
  return g
}
const DOWN: [number, number, number] = [0, -1, 0]
const UP: [number, number, number] = [0, 1, 0]
const FWD: [number, number, number] = [0, 0, 1]

export interface DuckParts {
  meshes: THREE.Mesh[]
  /** Status LED on the back of the torso (separate mesh: the wrapper blinks it). */
  led: THREE.Mesh
  dispose(): void
}

/**
 * Hang the drawn parts on the skeleton, after the open-source "Open Duck
 * Mini" (the micro duck inspired by Disney's BD-X droids): a forward-leaning
 * rounded body shell over the hip servos, slim legs of black servo blocks
 * and thin links with their output horns showing (red = drive), flat feet, a
 * three-servo neck, and a round helmet head with ONE big camera eye, a short
 * bill and two antenna pins on top. The head shell carries the robot's one
 * accent.
 *
 * Draw calls: torso 3, hip-yaw brackets 2 x 1, thighs 2 x 3, shins 2 x 2,
 * feet 2 x 2, neck links 3 x 1, head 4, contact shadow 1 = 26; LED 1 (blinks,
 * mostly hidden); selection ring 1 (only when selected).
 */
export function buildDuck(materials: Materials, accent: MatKey, sk: DuckSkeleton): DuckParts {
  const geos: THREE.BufferGeometry[] = []
  const keep = <T extends THREE.BufferGeometry>(g: T) => (geos.push(g), g)
  // Red marks drive input -- the servo horns -- unless red is already this
  // robot's accent, in which case the horns stay neutral.
  const horn: MatKey = accent === 'red' ? 'light' : 'red'

  const servoX = keep(blockGeometry(0.018, 0.02, 0.03)) // output shaft along X
  const servoLong = keep(blockGeometry(0.018, 0.03, 0.02)) // body along the link
  const hornX = keep(orient(discGeometry(0.0085, 0.0025, [], 20), [0, 1, 0], [0, 0, 1]))
  const pinX = keep(orient(pinGeometry(0.0028, 0.012), [0, 1, 0], [0, 0, 1]))
  const legBeam = (len: number) => keep(orient(beamGeometry({
    length: len, width: 0.012, thickness: 0.004, slots: [[len * 0.3, len * 0.7]],
  }), DOWN, FWD))

  // Torso: a rounded body shell seen from the side -- a straight-edged
  // profile with chamfered corners, extruded across -- leaning forward a
  // little (the micro duck's eager stance), over the dark hip-yaw servos.
  // The neck's servo and horn sit on its front top.
  const lean = BODY_LEAN
  const prof = new THREE.Shape()
  const zb = -0.07, zf = 0.05, yb = 0.035, yt = 0.098, c1 = 0.022, c2 = 0.012
  prof.moveTo(zb + c2, yb)
  prof.lineTo(zf - c2, yb)
  prof.lineTo(zf, yb + c2)
  prof.lineTo(zf, yt - c1)
  prof.lineTo(zf - c1, yt)
  prof.lineTo(zb + c1, yt)
  prof.lineTo(zb, yt - c1)
  prof.lineTo(zb, yb + c2)
  prof.closePath()
  const shell = keep(orient(extrude(prof, 0.104, 6), FWD, UP))
  const torso = new Assembly()
    .add(shell, 'light', { rot: [lean, 0, 0] })
  // Side seam rails (a slotted beam bolted along each flank) and cable runs.
  const rail = keep(orient(beamGeometry({ length: 0.07, width: 0.012, thickness: 0.003, slots: [[0.018, 0.052]] }), FWD, UP))
  const cable = keep(blockGeometry(0.003, 0.003, 0.05))
  const hipServo = keep(blockGeometry(0.02, 0.016, 0.028))
  for (const side of [1, -1]) {
    torso.add(rail, 'light', { pos: [side * 0.0535, 0.062, -0.045], rot: [lean, 0, 0] })
    torso.add(hipServo, 'dark', { pos: [side * LEG.hipW, 0.026, 0], edges: false })
    torso.add(cable, 'dark', { pos: [side * 0.03, 0.03, -0.035], rot: [-0.4, 0, 0], edges: false })
  }
  torso.add(keep(blockGeometry(0.024, 0.016, 0.02)), 'dark', { pos: [0, 0.1, 0.032], edges: false })
  torso.add(keep(orient(discGeometry(0.009, 0.003, [], 20), [1, 0, 0], [0, 0, -1])), 'light', { pos: [0, 0.1085, 0.03] })
  // A short tail rail, raised at the back.
  const tail = keep(orient(beamGeometry({ length: 0.035, width: 0.012, thickness: 0.004 }), [0, 0.45, -0.89], [0, 0.89, 0.45]))
  torso.add(tail, 'light', { pos: [0, 0.07, -0.07] })
  sk.pelvis.add(torso.build(materials, 'torso'))
  // Status LED on the back of the shell.
  const led = new THREE.Mesh(keep(blockGeometry(0.008, 0.006, 0.004)), materials.face.red)
  led.position.set(0.02, 0.083, -0.072)
  led.rotation.x = lean
  led.name = 'duck-led'
  sk.pelvis.add(led)

  const thighBeam = legBeam(LEG.L1)
  const shinBeam = legBeam(LEG.L2)
  const bracketPlate = keep(blockGeometry(0.022, 0.004, 0.028))
  const bracketRiser = keep(blockGeometry(0.012, 0.008, 0.018))
  const sole = keep(blockGeometry(0.042, 0.006, 0.085))
  const cheek = keep(blockGeometry(0.0035, 0.022, 0.014))
  const anklePin = keep(orient(pinGeometry(0.0028, 0.034), [0, 1, 0], [0, 0, 1]))
  sk.legs.forEach((leg, i) => {
    const side = i === 0 ? 1 : -1
    // Hip-yaw bracket: horn plate under the torso, a riser, and the hip servo (shaft outward).
    leg.hipYaw.add(new Assembly()
      .add(bracketPlate, 'dark', { pos: [0, 0.02, 0], edges: false })
      .add(bracketRiser, 'dark', { pos: [0, 0.014, 0], edges: false })
      .add(servoX, 'dark', { pos: [0, 0, -0.004], edges: false })
      .build(materials, 'hipYaw'))
    // Thigh: a slim light link outboard of the servos, bolted to the hip and knee horns.
    leg.thigh.add(new Assembly()
      .add(thighBeam, 'light', { pos: [side * 0.0135, 0, 0] })
      .add(hornX, horn, { pos: [side * 0.017, 0, 0] })
      .add(hornX, horn, { pos: [side * 0.017, -LEG.L1, 0] })
      .add(pinX, 'light', { pos: [side * 0.0195, 0, 0] })
      .add(pinX, 'light', { pos: [side * 0.0195, -LEG.L1, 0] })
      .build(materials, 'thigh'))
    // Shin: knee servo, a slim dark link and the ankle servo, its horn showing.
    leg.shin.add(new Assembly()
      .add(servoLong, 'dark', { pos: [0, -0.006, 0], edges: false })
      .add(shinBeam, 'dark', { pos: [-side * 0.0145, 0, 0], edges: false })
      .add(servoLong, 'dark', { pos: [0, -LEG.L2 + 0.008, 0], edges: false })
      .add(hornX, horn, { pos: [side * 0.011, -LEG.L2, 0], edges: false })
      .build(materials, 'shin'))
    // Foot: a flat plate (toes forward) with two cheeks up to the ankle pin.
    leg.foot.add(new Assembly()
      .add(sole, 'light', { pos: [0, SOLE_OFFSET + 0.003, 0.01] })
      .add(cheek, 'light', { pos: [0.0125, -0.006, 0] })
      .add(cheek, 'light', { pos: [-0.0125, -0.006, 0] })
      .add(anklePin, 'light', { pos: [0, 0, 0] })
      .build(materials, 'foot'))
  })

  // Neck links: paired dark side plates with a servo at the top joint.
  const neckPlate = keep(orient(beamGeometry({ length: NECK_LINK, width: 0.012, thickness: 0.0035 }), UP, FWD))
  const neckServo = keep(blockGeometry(0.018, 0.018, 0.022))
  sk.neck.forEach((n, i) => {
    n.add(new Assembly()
      .add(neckPlate, 'dark', { pos: [0.011, 0, 0], edges: false })
      .add(neckPlate, 'dark', { pos: [-0.011, 0, 0], edges: false })
      .add(neckServo, 'dark', { pos: [0, NECK_LINK, -0.002], edges: false })
      .build(materials, `neck${i}`))
  })

  // Head: a ROUND helmet seen from the side (big corner radii) extruded
  // across the width, a short flat bill under the front, ONE big camera eye
  // (light ring, dark lens) and two antenna pins with light tips.
  const hshape = new THREE.Shape()
  const z0 = -0.024, z1 = 0.058, y0 = 0.002, y1 = 0.058
  const rbt = 0.03, rft = 0.026, rfb = 0.012, rbb = 0.016
  hshape.moveTo(z0 + rbb, y0)
  hshape.lineTo(z1 - rfb, y0)
  hshape.absarc(z1 - rfb, y0 + rfb, rfb, -Math.PI / 2, 0, false)
  hshape.lineTo(z1, y1 - rft)
  hshape.absarc(z1 - rft, y1 - rft, rft, 0, Math.PI / 2, false)
  hshape.lineTo(z0 + rbt, y1)
  hshape.absarc(z0 + rbt, y1 - rbt, rbt, Math.PI / 2, Math.PI, false)
  hshape.lineTo(z0, y0 + rbb)
  hshape.absarc(z0 + rbb, y0 + rbb, rbb, Math.PI, Math.PI * 1.5, false)
  const headShell = keep(orient(extrude(hshape, 0.062, 10), FWD, UP))
  const bill = keep(orient(beamGeometry({ length: 0.05, width: 0.03, thickness: 0.006, holes: [0, 0.05], slots: [[0.016, 0.034]] }), FWD, [1, 0, 0]))
  const eyeY = 0.031
  const antenna = keep(pinGeometry(0.0016, 0.028).rotateX(Math.PI / 2))
  const tip = keep(blockGeometry(0.006, 0.006, 0.006))
  sk.head.add(new Assembly()
    .add(headShell, accent)
    .add(bill, 'dark', { pos: [0, 0.0005, 0.03], edges: false })
    .add(keep(discGeometry(0.019, 0.004, [{ x: 0, y: 0, r: 0.0135 }], 32)), 'light', { pos: [0, eyeY, z1 + 0.002] })
    .add(keep(discGeometry(0.0138, 0.004, [], 32)), 'dark', { pos: [0, eyeY, z1 + 0.001], edges: false })
    .add(antenna, 'dark', { pos: [0.018, y1 + 0.012, -0.004], rot: [-0.25, 0, -0.2], edges: false })
    .add(antenna, 'dark', { pos: [-0.018, y1 + 0.012, -0.004], rot: [-0.25, 0, 0.2], edges: false })
    .add(tip, 'light', { pos: [0.0208, y1 + 0.0255, -0.0075] })
    .add(tip, 'light', { pos: [-0.0208, y1 + 0.0255, -0.0075] })
    .build(materials, 'head'))

  const meshes: THREE.Mesh[] = []
  sk.pelvis.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o !== led) meshes.push(o as THREE.Mesh)
  })
  return {
    meshes,
    led,
    dispose() {
      geos.forEach(g => g.dispose())
    },
  }
}
