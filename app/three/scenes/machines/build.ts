import * as THREE from 'three'
import {
  Assembly, beamGeometry, blockGeometry, discGeometry, extrude, pinGeometry,
  type MatKey, type Materials,
} from '../../core/kit'
import { nextTask } from '../../core/stage'
import {
  ARM_L, AXLE_Y, ESCAPE, ESCAPE_OFFSET, GEARS, PALLET_R, PALLET_W, PIVOT, SHAFTS,
  escapeOutline, gearOutline, rootR, type GearId, type ShaftId,
} from './gears'
import type { WheelSpec } from './odometer'
import {
  BEAM, CARD_H, CARD_Z, CASE, CRANK, FOLIOT, GEAR_T, LAYER, PANEL_PAD, PLATE_X,
  board, display, nameplate, plateToWorld,
} from './layout'

/**
 * Geometry for the machine room. Every part is built once per scene and
 * shared: one extrusion per tooth count (B and D are both 12 teeth, A and E
 * both 36). Assemblies merge per material, so a moving shaft costs its
 * materials + one hairline draw. The split-flap cards are flaps.ts.
 */

type V3 = [number, number, number]

/** Euler (XYZ) that maps a part's local x and y axes onto the given world axes. */
function orient(x: V3, y: V3): V3 {
  const ax = new THREE.Vector3(...x)
  const ay = new THREE.Vector3(...y)
  const m = new THREE.Matrix4().makeBasis(ax, ay, ax.clone().cross(ay))
  const e = new THREE.Euler().setFromRotationMatrix(m, 'XYZ')
  return [e.x, e.y, e.z]
}

/** A beam in the side plate's plane, from plate point (lx, ly) at angle deg, lz out from the plate. */
function plateBeam(lx: number, ly: number, lz: number, deg: number) {
  const a = deg * Math.PI / 180
  return {
    pos: plateToWorld(lx, ly, lz),
    rot: orient([0, Math.sin(a), -Math.cos(a)], [0, Math.cos(a), Math.sin(a)]),
  }
}
/** Along world +x (a pin's local z): plate shafts and the drive axle. */
const ALONG_X = orient([0, 0, -1], [0, 1, 0])

// ── Gears ─────────────────────────────────────────────────────────────────

export const HUB_R = 0.0095
export const SHAFT_R = 0.009

/**
 * Involute spur gear plate with a hub bore and, on the larger wheels, a ring
 * of round lightening holes -- plain holes, like every member in the kit.
 */
export function gearGeometry(teeth: number, thickness = GEAR_T) {
  const pts = gearOutline(teeth)
  const shape = new THREE.Shape()
  shape.moveTo(pts[0]!, pts[1]!)
  for (let i = 2; i < pts.length; i += 2) shape.lineTo(pts[i]!, pts[i + 1]!)
  shape.closePath()
  const hub = new THREE.Path()
  hub.absarc(0, 0, HUB_R, 0, Math.PI * 2, true)
  shape.holes.push(hub)
  if (teeth >= 24) {
    const rf = rootR(teeth)
    const ring = (rf + 0.025) / 2
    const r = (rf - 0.025) * 0.27
    const n = teeth >= 36 ? 6 : 5
    for (let k = 0; k < n; k++) {
      const a = (k + 0.5) * 2 * Math.PI / n
      const p = new THREE.Path()
      p.absarc(ring * Math.cos(a), ring * Math.sin(a), r, 0, Math.PI * 2, true)
      shape.holes.push(p)
    }
  }
  return extrude(shape, thickness)
}

export function escapeGeometry() {
  const pts = escapeOutline()
  const shape = new THREE.Shape()
  shape.moveTo(pts[0]!, pts[1]!)
  for (let i = 2; i < pts.length; i += 2) shape.lineTo(pts[i]!, pts[i + 1]!)
  shape.closePath()
  const hub = new THREE.Path()
  hub.absarc(0, 0, HUB_R, 0, Math.PI * 2, true)
  shape.holes.push(hub)
  // Five plain holes lighten the wheel and make its tick readable at a glance.
  for (let k = 0; k < 5; k++) {
    const a = k * 2 * Math.PI / 5
    const p = new THREE.Path()
    p.absarc(0.04 * Math.cos(a), 0.04 * Math.sin(a), 0.012, 0, Math.PI * 2, true)
    shape.holes.push(p)
  }
  return extrude(shape, 0.012)
}

// ── Train ─────────────────────────────────────────────────────────────────

export type Target = GearId | 'W' | 'crank'

export interface Train {
  /** The side plate's frame: children are in plate coordinates. */
  plate: THREE.Group
  shafts: Record<ShaftId, THREE.Group>
  anchor: THREE.Group
  /** Hover targets: the mesh each one lights. */
  targets: Map<THREE.Mesh, Target>
  /** Plate-local centre of each target, for the hover label. */
  centre: Record<Target, [number, number, number]>
}

/** Async: yields between shafts so no single build task blocks input for long. */
export async function buildTrain(m: Materials, shared: Map<string, THREE.BufferGeometry>): Promise<Train> {
  const geo = (key: string, make: () => THREE.BufferGeometry) => {
    let g = shared.get(key)
    if (!g) {
      g = make()
      shared.set(key, g)
    }
    return g
  }
  const gearGeo = (teeth: number) => geo(`gear${teeth}`, () => gearGeometry(teeth))
  // Paper-white wheels; B is a pale grey so it still reads (and lights) apart from C on the same shaft.
  const mat: Record<GearId, MatKey> = { A: 'light', B: 'mid', C: 'light', D: 'light', E: 'light' }
  // A red cap on every turning arbor's end: the drive's path is marked shaft by shaft.
  const cap = geo('cap', () => discGeometry(0.017, 0.008))

  const plate = new THREE.Group()
  plate.name = 'plate'
  plate.position.x = PLATE_X
  plate.rotation.y = Math.PI / 2

  const shafts = {} as Record<ShaftId, THREE.Group>
  const centre = {} as Record<Target, [number, number, number]>
  for (const id of ['O', 'M', 'K', 'X'] as ShaftId[]) {
    const a = new Assembly()
    for (const g of GEARS.filter(g => g.shaft === id)) {
      a.add(gearGeo(g.teeth), mat[g.id], { pos: [0, 0, LAYER[g.layer]!] })
      centre[g.id] = [SHAFTS[id].x, SHAFTS[id].y, LAYER[g.layer]!]
    }
    if (id === 'K') {
      // The crank: a red slotted arm outermost on the shaft, and its grip.
      const arm = geo('crankArm', () => beamGeometry({ length: CRANK.arm, width: 0.042, thickness: 0.014, slots: [[0.045, 0.105]] }))
      const grip = geo('crankGrip', () => pinGeometry(0.013, CRANK.grip))
      a.add(arm, 'red', { pos: [0, 0, CRANK.z] })
      a.add(grip, 'red', { pos: [CRANK.arm, 0, CRANK.z + 0.007 + CRANK.grip / 2] })
      centre.crank = [SHAFTS.K.x, SHAFTS.K.y, CRANK.z]
    }
    if (id === 'X') {
      a.add(geo('escape', escapeGeometry), 'metal', { pos: [0, 0, LAYER[2]!], rot: [0, 0, ESCAPE_OFFSET] })
      centre.W = [SHAFTS.X.x, SHAFTS.X.y, LAYER[2]!]
    }
    if (id !== 'K') {
      const outer = id === 'X' ? LAYER[2]! + 0.006 : Math.max(...GEARS.filter(g => g.shaft === id).map(g => LAYER[g.layer]!)) + GEAR_T / 2
      a.add(cap, 'red', { pos: [0, 0, outer + 0.004] })
    }
    const node = a.build(m, id)
    node.position.set(SHAFTS[id].x, SHAFTS[id].y, 0)
    plate.add(node)
    shafts[id] = node
    await nextTask()
  }

  // Anchor: two straight arms along the tangents to the pallet nibs, and the
  // foliot bar with its two weights, all on one arbor.
  const nibLen = 0.022
  const anchorA = new Assembly()
  for (const side of [1, -1]) {
    const ang = Math.PI / 2 + side * ESCAPE.alpha
    const tx = SHAFTS.X.x + PALLET_R * Math.cos(ang) - PIVOT.x
    const ty = SHAFTS.X.y + PALLET_R * Math.sin(ang) - PIVOT.y
    const ox = Math.cos(ang)
    const oy = Math.sin(ang)
    // The arm meets the nib at its outer end, so its round end stays clear of the teeth.
    const ex = tx + ox * nibLen
    const ey = ty + oy * nibLen
    const len = Math.hypot(ex, ey)
    const arm = geo(`anchorArm${side}`, () => beamGeometry({ length: len, width: 0.022, thickness: 0.012, holes: [0], holeR: 0.004 }))
    anchorA.add(arm, 'dark', { pos: [0, 0, LAYER[2]!], rot: [0, 0, Math.atan2(ey, ex)] })
    const ux = tx / ARM_L
    const uy = ty / ARM_L
    const nib = geo('nib', () => blockGeometry(PALLET_W, nibLen, 0.012))
    anchorA.add(nib, 'metal', {
      pos: [tx + ox * nibLen / 2, ty + oy * nibLen / 2, LAYER[2]!],
      rot: [0, 0, Math.atan2(uy, ux)],
    })
  }
  const foliot = geo('foliot', () => beamGeometry({ length: FOLIOT.half * 2, width: 0.026, thickness: 0.012, holes: [0, FOLIOT.half, FOLIOT.half * 2], slots: [[0.035, FOLIOT.half - 0.035], [FOLIOT.half + 0.035, FOLIOT.half * 2 - 0.035]] }))
  anchorA.add(foliot, 'dark', { pos: [-FOLIOT.half, 0, FOLIOT.z] })
  const weight = geo('weight', () => discGeometry(FOLIOT.weightR, 0.02, [{ x: 0, y: 0, r: 0.005 }]))
  for (const s of [-1, 1]) anchorA.add(weight, 'metal', { pos: [s * FOLIOT.half, 0, FOLIOT.z + 0.016] })
  const anchor = anchorA.build(m, 'anchor')
  anchor.position.set(PIVOT.x, PIVOT.y, 0)
  plate.add(anchor)

  const targets = new Map<THREE.Mesh, Target>()
  const find = (node: THREE.Group, key: MatKey) => node.getObjectByName(`${node.name}:${key}`) as THREE.Mesh
  targets.set(find(shafts.K, 'light'), 'A')
  targets.set(find(shafts.K, 'red'), 'crank')
  targets.set(find(shafts.M, 'mid'), 'B')
  targets.set(find(shafts.M, 'light'), 'C')
  targets.set(find(shafts.O, 'light'), 'D')
  targets.set(find(shafts.X, 'light'), 'E')
  targets.set(find(shafts.X, 'metal'), 'W')
  return { plate, shafts, anchor, targets, centre }
}

// ── Frame ─────────────────────────────────────────────────────────────────

/**
 * Everything that never moves, in one assembly: the base board, the yellow
 * case on its foot rails, the ink display panels and the flaps' hinge rods,
 * the side plate's truss of slotted beams (every shaft lands on a beam hole),
 * its shafts and pins, and the axle that carries the drive into the case.
 * `yellow` is the case's material (the campaign yellow is the page's colour,
 * not one of the kit's); everything else is the kit's.
 */
export async function buildFrame(m: Materials, list: WheelSpec[], yellow: THREE.MeshLambertMaterial) {
  // Assemblies merge by palette key; the case borrows 'wood' (used nowhere
  // else in this scene) for its yellow.
  const mats: Materials = { ...m, face: { ...m.face, wood: yellow } }
  const a = new Assembly()
  const B = board(list)
  a.add(blockGeometry(B.x1 - B.x0, B.t, B.z1 - B.z0), 'dark', { pos: [(B.x0 + B.x1) / 2, -B.t / 2, (B.z0 + B.z1) / 2] })

  // The case, on two flat foot rails running front to back.
  const D = display(list)
  const [cx0, cx1] = D.caseX
  const [cy0, cy1] = D.caseY
  a.add(blockGeometry(cx1 - cx0, cy1 - cy0, CASE.front - CASE.back), 'wood', {
    pos: [(cx0 + cx1) / 2, (cy0 + cy1) / 2, (CASE.front + CASE.back) / 2],
  })
  const flatRail = (x: number, z0: number, z1: number, mat: MatKey) => {
    const len = z1 - z0
    a.add(beamGeometry({ length: len, width: BEAM.w, thickness: BEAM.t, holes: [0, len / 2, len], slots: [[0.05, len / 2 - 0.05], [len / 2 + 0.05, len - 0.05]] }), mat, {
      pos: [x, BEAM.t / 2, z1], rot: orient([0, 0, -1], [1, 0, 0]),
    })
  }
  for (const x of [cx0 + 0.09, cx1 - 0.07]) flatRail(x, CASE.back - 0.03, CASE.front + 0.03, 'light')

  // An ink panel behind each digit group's cards, and at each end of it
  // the pivot the group's flaps hinge on (the split between the half cards
  // shows the ink panel: the dark line through every figure).
  const pivot = pinGeometry(0.006, 0.014)
  for (const { x0: g0, x1: g1, hinge } of D.groups) {
    a.add(blockGeometry(g1 - g0 + 2 * PANEL_PAD, CARD_H + 2 * PANEL_PAD, CASE.panelT), 'dark', {
      pos: [(g0 + g1) / 2, hinge, CASE.front + CASE.panelT / 2],
    })
    for (const x of [g0 - 0.006, g1 + 0.006]) a.add(pivot, 'metal', { pos: [x, hinge, CARD_Z + 0.004] })
  }
  // The nameplate (only with three day units) is held by two bolts, above and below its lettering.
  const np = nameplate(list)
  if (np) {
    const bolt = pinGeometry(0.009, 0.01)
    for (const y of [np.y1 - 0.025, np.y0 + 0.025]) a.add(bolt, 'metal', { pos: [(np.x0 + np.x1) / 2, y, CASE.front + 0.009] })
  }
  // A carrying handle on the lid: a slotted ink beam on two posts.
  const hl = 0.36 * (cx1 - cx0)
  const post = pinGeometry(0.009, 0.05)
  for (const s of [-1, 1]) a.add(post, 'metal', { pos: [(cx0 + cx1) / 2 + s * hl / 2, cy1 + 0.025, 0], rot: orient([1, 0, 0], [0, 0, 1]) })
  a.add(beamGeometry({ length: hl, width: 0.04, thickness: 0.016, holes: [0, hl], slots: [[0.05, hl - 0.05]] }), 'dark', {
    pos: [(cx0 + cx1) / 2 - hl / 2, cy1 + 0.058, 0], rot: orient([1, 0, 0], [0, 0, -1]),
  })

  // Side plate truss (plate coordinates).
  const foot = BEAM.w / 2
  const { O, M, K, X } = SHAFTS
  const len = (p: { x: number, y: number }, q: { x: number, y: number }) => Math.hypot(q.x - p.x, q.y - p.y)
  const deg = (p: { x: number, y: number }, q: { x: number, y: number }) => Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI
  const beam = (p: { x: number, y: number }, q: { x: number, y: number }, mat: MatKey, holes: number[], lz = 0, slots?: [number, number][]) => {
    const L = len(p, q)
    const b = plateBeam(p.x, p.y, lz, deg(p, q))
    a.add(beamGeometry({ length: L, width: BEAM.w, thickness: BEAM.t, holes, slots }), mat, b)
  }
  const base = { x: O.x, y: foot }
  const top = { x: PIVOT.x, y: PIVOT.y }
  const Ly = top.y - base.y
  beam(base, top, 'dark', [0, O.y - foot, X.y - foot, Ly], 0, [[0.06, O.y - foot - 0.06], [O.y - foot + 0.06, X.y - foot - 0.06]])
  const kBase = { x: K.x, y: foot }
  beam(kBase, K, 'dark', [0, K.y - foot], 0, [[0.06, K.y - foot - 0.06]])
  beam(O, M, 'light', [0, len(O, M)], -BEAM.t)
  beam(M, K, 'light', [0, len(M, K)], -BEAM.t)
  // Diagonal brace from the back foot up to the escape arbor, behind the others.
  beam(kBase, X, 'light', [0, len(kBase, X)], -2 * BEAM.t, [[0.08, len(kBase, X) / 2 - 0.04], [len(kBase, X) / 2 + 0.04, len(kBase, X) - 0.08]])
  flatRail(PLATE_X, -K.x - 0.07, 0.12, 'light')

  // Shafts (static pins; the gears turn on them) and frame pins.
  const shaft = (p: { x: number, y: number }, z0: number, z1: number) => {
    a.add(pinGeometry(SHAFT_R, z1 - z0), 'metal', { pos: plateToWorld(p.x, p.y, (z0 + z1) / 2), rot: ALONG_X })
  }
  shaft(M, -2 * BEAM.t, LAYER[1]! + 0.02)
  shaft(K, -2 * BEAM.t, CRANK.z + 0.012)
  shaft(X, -2 * BEAM.t, LAYER[2]! + 0.02)
  shaft(PIVOT, -BEAM.t, FOLIOT.z + 0.03)
  shaft(kBase, -3 * BEAM.t, BEAM.t)
  // The drive axle: out of the case's side to the pinion D on the plate.
  const ax0 = cx1 - 0.02
  const ax1 = PLATE_X + LAYER[0]! + 0.02
  a.add(pinGeometry(SHAFT_R, ax1 - ax0), 'metal', { pos: [(ax0 + ax1) / 2, AXLE_Y, 0], rot: ALONG_X })
  a.add(pinGeometry(0.01, 0.06), 'metal', { pos: [PLATE_X, foot, 0], rot: ALONG_X })

  await nextTask()
  return a.build(mats, 'frame')
}
