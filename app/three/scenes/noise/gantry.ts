import * as THREE from 'three'
import { Assembly, beamGeometry, blockGeometry, pinGeometry, type Materials } from '../../core/kit'
import { BED, BED_TOP, BRIDGE, BRIDGE_Y, PAPER_Y, PEN_LEN, RAIL, RAIL_TOP } from './layout'
import { CAP, PAPER } from './plotter'

/**
 * The pen plotter in the beam kit's language: a wood bed, two light slotted
 * rails on posts (Y), a dark slotted bridge riding them on trucks (X), a
 * carriage hanging on the bridge's front face, and the pen in two guides,
 * lifted by a solenoid through a lever on its collar.
 *
 * Moving parts are separate nodes in the plotter's frame: the bridge at pen z,
 * the carriage at pen x/z, the pen at pen x/z and its lift height. The
 * solenoid body is its own small mesh so it can turn red when it fires.
 */

const cyl = (r: number, h: number, sides = 24) => new THREE.CylinderGeometry(r, r, h, sides)

function finish(a: Assembly, m: Materials, name: string, own: THREE.BufferGeometry[]) {
  const group = a.build(m, name)
  own.forEach(g => g.dispose())
  const node = new THREE.Group()
  node.name = name
  node.add(group)
  return node
}

export function buildPlotterBase(m: Materials) {
  const a = new Assembly()
  const own: THREE.BufferGeometry[] = []
  const g = <T extends THREE.BufferGeometry>(geo: T) => (own.push(geo), geo)

  a.add(g(blockGeometry(BED.w, BED.t, BED.d)), 'wood', { pos: [0, BED.y0 + BED.t / 2, 0] })
  const foot = g(blockGeometry(0.04, BED.y0, 0.04))
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) a.add(foot, 'dark', { pos: [sx * (BED.w / 2 - 0.035), BED.y0 / 2, sz * (BED.d / 2 - 0.035)] })
  }

  // Rails: slotted beams on edge along z, pinned to a post at each end.
  const len = RAIL.z1 - RAIL.z0
  const rail = g(beamGeometry({ length: len, width: RAIL.w, thickness: RAIL.t, holes: [0, len], slots: [[0.04, len - 0.04]] }))
  const post = g(blockGeometry(0.024, RAIL.post + RAIL.w / 2, 0.024))
  const pin = g(pinGeometry(0.0045, RAIL.t + 0.034))
  const railY = BED_TOP + RAIL.post + RAIL.w / 2
  for (const sx of [-1, 1]) {
    a.add(rail, 'light', { pos: [sx * RAIL.x, railY, RAIL.z0], rot: [0, -Math.PI / 2, 0] })
    for (const z of [RAIL.z0, RAIL.z1]) {
      a.add(post, 'light', { pos: [sx * (RAIL.x + RAIL.t / 2 + 0.012), BED_TOP + (RAIL.post + RAIL.w / 2) / 2, z] })
      a.add(pin, 'metal', { pos: [sx * (RAIL.x + 0.012), railY, z], rot: [0, Math.PI / 2, 0] })
    }
  }
  // The Y stepper sits on the bed outside the left rail, at the back.
  a.add(g(blockGeometry(0.036, 0.036, 0.036)), 'dark', { pos: [-(RAIL.x + 0.044), BED_TOP + 0.018, RAIL.z0 + 0.02] })
  a.add(g(cyl(0.004, 0.012)), 'metal', { pos: [-(RAIL.x + 0.044), BED_TOP + 0.042, RAIL.z0 + 0.02] })
  return finish(a, m, 'plotter-base', own)
}

/** The bridge, in a frame whose z = 0 is the pen axis (the beam is BRIDGE.z behind it). */
export function buildBridge(m: Materials) {
  const a = new Assembly()
  const own: THREE.BufferGeometry[] = []
  const g = <T extends THREE.BufferGeometry>(geo: T) => (own.push(geo), geo)
  const span = RAIL.x * 2
  const truck = g(blockGeometry(0.034, BRIDGE.truckH, 0.06))
  for (const sx of [-1, 1]) a.add(truck, 'light', { pos: [sx * RAIL.x, RAIL_TOP + BRIDGE.truckH / 2, BRIDGE.z - 0.01] })
  a.add(g(beamGeometry({
    length: span, width: BRIDGE.w, thickness: BRIDGE.t, holes: [0, span],
    slots: [[0.05, span / 2 - 0.04], [span / 2 + 0.04, span - 0.05]],
  })), 'dark', { pos: [-RAIL.x, BRIDGE_Y, BRIDGE.z] })
  const pin = g(pinGeometry(0.0045, BRIDGE.t + 0.012))
  for (const sx of [-1, 1]) a.add(pin, 'metal', { pos: [sx * RAIL.x, BRIDGE_Y, BRIDGE.z] })
  // X stepper on the right truck, behind the beam.
  a.add(g(blockGeometry(0.03, 0.03, 0.03)), 'dark', { pos: [RAIL.x, RAIL_TOP + BRIDGE.truckH + 0.015, BRIDGE.z - 0.025] })
  return finish(a, m, 'plotter-bridge', own)
}

const PLATE = { w: 0.05, h: 0.08, t: 0.012 }
const plateZ = BRIDGE.z + BRIDGE.t / 2 + PLATE.t / 2
/** The solenoid hangs beside the pen at this x, this height above the paper. */
const SOL = { x: 0.021, y: 0.1, z: -0.003, r: 0.0095, h: 0.026 }

/** The carriage (pen axis at x = z = 0) and its solenoid body as a separate mesh. */
export function buildCarriage(m: Materials) {
  const a = new Assembly()
  const own: THREE.BufferGeometry[] = []
  const g = <T extends THREE.BufferGeometry>(geo: T) => (own.push(geo), geo)
  const plateY = BRIDGE_Y - 0.0075
  a.add(g(blockGeometry(PLATE.w, PLATE.h, PLATE.t)), 'light', { pos: [0, plateY, plateZ] })
  // A lip over the beam's top edge carries the weight; the plate hangs from it.
  a.add(g(blockGeometry(PLATE.w, 0.008, BRIDGE.t + PLATE.t + 0.006)), 'light', {
    pos: [0, BRIDGE_Y + BRIDGE.w / 2 + 0.004, BRIDGE.z + PLATE.t / 2],
  })
  // Two pen guides out of the plate's front.
  const guideZ = (plateZ + PLATE.t / 2 + 0.011) / 2
  const guide = g(blockGeometry(0.022, 0.008, 0.011 - (plateZ + PLATE.t / 2)))
  for (const y of [0.05, 0.09]) a.add(guide, 'light', { pos: [0, PAPER_Y + y, guideZ] })
  // Solenoid bracket.
  a.add(g(blockGeometry(0.02, 0.006, plateZ + PLATE.t / 2 - SOL.z + SOL.r)), 'metal', {
    pos: [SOL.x, PAPER_Y + SOL.y + SOL.h / 2 + 0.003, (SOL.z + plateZ + PLATE.t / 2) / 2],
  })
  const carriage = finish(a, m, 'plotter-carriage', own)

  const s = new Assembly().add(cyl(SOL.r, SOL.h), 'mid', { pos: [SOL.x, PAPER_Y + SOL.y, SOL.z] })
  const solenoidGroup = s.build(m, 'solenoid')
  const solenoid = solenoidGroup.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh
  carriage.add(solenoidGroup)
  return { carriage, solenoid }
}

/**
 * The pen, tip at the origin: metal tip, dark barrel, an accent cap (the
 * figure's one accent, matching the ink it draws), a collar, and the lever and
 * plunger that the solenoid lifts it by.
 */
export function buildPen(m: Materials) {
  const a = new Assembly()
  const own: THREE.BufferGeometry[] = []
  const g = <T extends THREE.BufferGeometry>(geo: T) => (own.push(geo), geo)
  a.add(g(new THREE.CylinderGeometry(0.0055, 0.0012, 0.01, 24)), 'metal', { pos: [0, 0.005, 0] })
  a.add(g(cyl(0.0055, PEN_LEN - 0.025)), 'dark', { pos: [0, 0.01 + (PEN_LEN - 0.025) / 2, 0] })
  a.add(g(cyl(0.0058, 0.015)), 'accent', { pos: [0, PEN_LEN - 0.0075, 0] })
  const collarY = SOL.y - SOL.h / 2 - 0.012
  a.add(g(cyl(0.0075, 0.006)), 'metal', { pos: [0, collarY, 0] })
  a.add(g(blockGeometry(SOL.x, 0.003, 0.006)), 'metal', { pos: [SOL.x / 2, collarY, SOL.z] })
  a.add(g(cyl(0.0022, 0.02)), 'metal', { pos: [SOL.x, collarY + 0.01, SOL.z] })
  return finish(a, m, 'plotter-pen', own)
}

/**
 * One paper sheet with its drawing. Its own materials (the stage's are
 * shared) so it can fade as it is fed in and pushed off. The drawing is a
 * preallocated LineSegments buffer written incrementally by the scene.
 */
export function buildSheet(m: Materials, ink: string) {
  const node = new THREE.Group()
  node.name = 'sheet'
  const paperMat = m.face.light.clone()
  paperMat.transparent = true
  const edgeMat = m.line.clone()
  edgeMat.transparent = true
  const inkMat = new THREE.LineBasicMaterial({ color: ink, transparent: true })
  const paperGeo = new THREE.PlaneGeometry(PAPER.w, PAPER.d).rotateX(-Math.PI / 2)
  const paper = new THREE.Mesh(paperGeo, paperMat)
  paper.position.z = PAPER.cz
  const hw = PAPER.w / 2
  const z0 = PAPER.cz - PAPER.d / 2
  const z1 = PAPER.cz + PAPER.d / 2
  const edgeGeo = new THREE.BufferGeometry()
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    -hw, 0, z0, hw, 0, z0, hw, 0, z0, hw, 0, z1, hw, 0, z1, -hw, 0, z1, -hw, 0, z1, -hw, 0, z0,
  ], 3))
  const edge = new THREE.LineSegments(edgeGeo, edgeMat)
  const pos = new THREE.Float32BufferAttribute(new Float32Array((CAP - 1) * 2 * 3), 3)
  pos.setUsage(THREE.DynamicDrawUsage)
  const inkGeo = new THREE.BufferGeometry()
  inkGeo.setAttribute('position', pos)
  inkGeo.setDrawRange(0, 0)
  const drawing = new THREE.LineSegments(inkGeo, inkMat)
  drawing.frustumCulled = false
  drawing.position.y = 0.0003
  node.add(paper, edge, drawing)
  node.position.y = PAPER_Y

  let written = 0
  return {
    node,
    paper,
    setOpacity(op: number) {
      node.visible = op > 0.003
      paperMat.opacity = op
      edgeMat.opacity = op * 0.6
      inkMat.opacity = op
    },
    /** Appends segments up to `count` points of `buf` (x,z pairs); reset() starts over. */
    sync(buf: Float32Array, count: number) {
      if (count <= written) return
      const arr = pos.array as Float32Array
      const from = Math.max(1, written)
      for (let k = from; k < count; k++) {
        const o = (k - 1) * 6
        arr[o] = buf[(k - 1) * 2]!
        arr[o + 1] = 0
        arr[o + 2] = buf[(k - 1) * 2 + 1]!
        arr[o + 3] = buf[k * 2]!
        arr[o + 4] = 0
        arr[o + 5] = buf[k * 2 + 1]!
      }
      pos.clearUpdateRanges()
      pos.addUpdateRange((from - 1) * 6, (count - from) * 6)
      pos.needsUpdate = true
      inkGeo.setDrawRange(0, Math.max(0, count - 1) * 2)
      written = count
    },
    reset() {
      written = 0
      inkGeo.setDrawRange(0, 0)
    },
    dispose() {
      paperMat.dispose()
      edgeMat.dispose()
      inkMat.dispose()
    },
  }
}
