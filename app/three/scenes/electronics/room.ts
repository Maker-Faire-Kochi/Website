import * as THREE from 'three'
import { blockGeometry, discGeometry } from '../../core/kit'
import { BENCH, PED, RACK, SEAT, TOP, type V3 } from './bench-layout'
import { cyl, wireTube, type PartSet } from './build'

/**
 * The maker's corner around the bench, for a full-bleed stage: the scene is
 * drawn edge to edge behind scrolling text, so the world has to run past the
 * subject to every screen edge -- a floor, the back wall and the side wall of
 * a corner, a pegboard behind the bench, a tall rack of parts drawers in the
 * corner, a monitor on an arm, a fume extractor by the work, and the things
 * that collect on a workshop floor. All static: it goes into the scene's one
 * PartSet, so it costs no draw calls beyond the materials it shares.
 */

/**
 * The room: floor at y = 0, back wall face at ROOM.back, the side wall of the
 * corner at ROOM.right (beyond the bench's right end, so the camera, which
 * looks from the front-left, sees into the corner).
 */
export const ROOM = {
  back: -0.47,
  right: 2.3,
  /** How far the floor and walls run: far enough to fill any screen around the focus box. */
  x0: -10,
  z1: 9,
  h: 5,
}

/** Pegboard on the back wall between the bench top and the shelf. */
export const PEG = { x0: -1.48, x1: 1.48, y0: TOP + 0.03, y1: RACK.shelfY - 0.04, z: ROOM.back + 0.006, pitch: 0.05 }

/** The monitor on its arm from the centre upright: screen centre, size. */
export const MONITOR = { c: [0.32, 1.255, -0.3] as V3, w: 0.5, h: 0.29, yaw: -0.38 }

/** Fume extractor beside the work, facing the board in the clips. */
export const EXTRACTOR = { x: -0.34, z: -0.08, w: 0.16, h: 0.17, d: 0.07, yaw: 0.75 }

/** Tall rack of drawer organisers in the corner beside the bench. */
const CORNER = { x: 1.95, z: -0.2, w: 0.62, d: 0.5, h: 2.0, shelves: [0.02, 0.5, 0.98, 1.46, 1.94] }

export function addRoom(s: PartSet) {
  const box = (w: number, h: number, d: number) => s.geo(blockGeometry(w, h, d))
  const R = ROOM
  const fx = (R.x0 + R.right) / 2
  const fz = (R.back + R.z1) / 2
  // Floor slab and walls: one block each (their outlines are the drawing).
  s.add(null, box(R.right - R.x0, 0.04, R.z1 - R.back), 'mid', { pos: [fx, -0.02, fz] })
  s.add(null, box(R.right - R.x0 + 0.12, R.h, 0.12), 'light', { pos: [fx + 0.06, R.h / 2, R.back - 0.06] })
  s.add(null, box(0.12, R.h, R.z1 - R.back), 'light', { pos: [R.right + 0.06, R.h / 2, fz] })
  // Skirting along both walls.
  s.add(null, box(R.right - R.x0, 0.08, 0.015), 'mid', { pos: [fx, 0.04, R.back + 0.0075] })
  s.add(null, box(0.015, 0.08, R.z1 - R.back), 'mid', { pos: [R.right - 0.0075, 0.04, fz] })
  // Socket plates: behind the bench's left end, and on the side wall.
  s.add(null, box(0.08, 0.12, 0.012), 'light', { pos: [-1.75, 0.35, R.back + 0.006] })
  s.add(null, box(0.012, 0.12, 0.08), 'light', { pos: [R.right - 0.006, 0.35, 1.2] })

  // Pegboard (hardboard) behind the bench; its holes are an instanced layer (pegHoles()).
  s.add('handTools', box(PEG.x1 - PEG.x0, PEG.y1 - PEG.y0, 0.008), 'woodDark', { pos: [(PEG.x0 + PEG.x1) / 2, (PEG.y0 + PEG.y1) / 2, PEG.z] })

  // Anti-fatigue mat under the stool.
  s.add('stool', box(0.9, 0.012, 0.75), 'dark', { pos: [SEAT.x + 0.05, 0.006, SEAT.z + 0.05] })

  addCorner(s)
  addMonitor(s)
  addExtractor(s)
  addFloorThings(s)
}

/** Corner rack: slotted uprights, shelves, drawer organisers and boxes. */
function addCorner(s: PartSet) {
  const C = CORNER
  const box = (w: number, h: number, d: number) => s.geo(blockGeometry(w, h, d))
  const post = box(0.04, C.h, 0.04)
  for (const dx of [-1, 1]) for (const dz of [-1, 1]) s.add('bins', post, 'mid', { pos: [C.x + dx * (C.w / 2 - 0.02), C.h / 2, C.z + dz * (C.d / 2 - 0.02)] })
  const shelf = box(C.w, 0.02, C.d)
  for (const y of C.shelves) s.add('bins', shelf, 'light', { pos: [C.x, y, C.z] })
  // Drawer organisers: a cabinet of small drawers, each front a plate with a pull.
  const org = (y: number, cols: number, rows: number, w: number, h: number) => {
    const d = 0.28
    s.add('bins', box(w, h, d), 'light', { pos: [C.x, y + h / 2, C.z + 0.05] })
    const fw = w / cols - 0.008
    const fh = h / rows - 0.008
    const front = box(fw, fh, 0.006)
    const pull = box(fw * 0.4, 0.006, 0.008)
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const x = C.x - w / 2 + (c + 0.5) * (w / cols)
        const yy = y + (r + 0.5) * (h / rows)
        s.add('bins', front, 'mid', { pos: [x, yy, C.z + 0.05 + d / 2 + 0.003] })
        s.add('bins', pull, 'dark', { pos: [x, yy - fh * 0.2, C.z + 0.05 + d / 2 + 0.009], edges: false })
      }
    }
  }
  org(C.shelves[1]! + 0.01, 4, 6, 0.5, 0.42)
  org(C.shelves[2]! + 0.01, 3, 4, 0.5, 0.36)
  s.add('boxes', box(0.4, 0.3, 0.36), 'woodDark', { pos: [C.x, C.shelves[0]! + 0.16, C.z] })
  s.add('boxes', box(0.3, 0.22, 0.3), 'light', { pos: [C.x - 0.05, C.shelves[3]! + 0.12, C.z] })
  s.add('boxes', box(0.18, 0.12, 0.25), 'woodDark', { pos: [C.x + 0.17, C.shelves[3]! + 0.07, C.z + 0.04] })
  s.add('boxes', box(0.44, 0.16, 0.34), 'mid', { pos: [C.x, C.shelves[4]! + 0.09, C.z] })
  // Hank of cable and a reel on the side wall.
  s.add('handTools', s.geo(discGeometry(0.16, 0.05, [{ x: 0, y: 0, r: 0.09 }], 40).rotateY(Math.PI / 2)), 'dark', { pos: [ROOM.right - 0.04, 1.55, 0.55] })
  s.add('handTools', s.geo(cyl(0.012, 0.08).rotateZ(Math.PI / 2)), 'metal', { pos: [ROOM.right - 0.04, 1.73, 0.55] })
  // Bar clamps hanging on the side wall.
  const bar = box(0.012, 0.6, 0.025)
  const jaw = box(0.03, 0.03, 0.09)
  for (let i = 0; i < 3; i++) {
    const z = 1.0 + i * 0.12
    s.add('handTools', bar, 'metal', { pos: [ROOM.right - 0.03, 1.25, z] })
    s.add('handTools', jaw, 'dark', { pos: [ROOM.right - 0.04, 1.52, z + 0.03] })
    s.add('handTools', jaw, 'dark', { pos: [ROOM.right - 0.04, 1.05 + i * 0.06, z + 0.03] })
  }
}

/** Monitor on a VESA arm from the centre upright, its stand neck and the HDMI lead down to the board. */
function addMonitor(s: PartSet) {
  const M = MONITOR
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, M.yaw, 0))
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z).applyQuaternion(q).add(new THREE.Vector3(...M.c)), q, new THREE.Vector3(1, 1, 1))
  s.add('monitor', s.geo(blockGeometry(M.w + 0.024, M.h + 0.024, 0.03)), 'dark', { matrix: at(0, 0, -0.016) })
  s.add('monitor', s.geo(blockGeometry(0.08, 0.08, 0.03)), 'dark', { matrix: at(0, 0, -0.046) })
  const arm0: V3 = [RACK.xs[1]!, M.c[1], RACK.z + 0.02]
  const back = new THREE.Vector3(0, 0, -0.06).applyQuaternion(q).add(new THREE.Vector3(...M.c))
  const mid: V3 = [(arm0[0] + back.x) / 2 + 0.03, M.c[1], (arm0[2] + back.z) / 2 + 0.03]
  const rod = s.geo(cyl(0.012, 1))
  for (const [a, b] of [[arm0, mid], [mid, [back.x, back.y, back.z] as V3]] as [V3, V3][]) {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const len = d.length()
    const y = d.normalize()
    const x = new THREE.Vector3(0, 1, 0).cross(y).normalize()
    const z = new THREE.Vector3().crossVectors(x, y)
    s.add('monitor', rod, 'mid', { matrix: new THREE.Matrix4().makeBasis(x, y, z).scale(new THREE.Vector3(1, len, 1)).setPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2) })
  }
  s.add('monitor', s.geo(cyl(0.02, 0.05)), 'mid', { pos: mid })
  s.add('monitor', s.geo(blockGeometry(0.05, 0.08, 0.03)), 'mid', { pos: [arm0[0], arm0[1], arm0[2]] })
}

/** The monitor's screen frame (for the live terminal texture). */
export function monitorScreen(): THREE.Matrix4 {
  const M = MONITOR
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, M.yaw, 0))
  return new THREE.Matrix4().compose(new THREE.Vector3(...M.c).add(new THREE.Vector3(0, 0, 0.0005).applyQuaternion(q)), q, new THREE.Vector3(1, 1, 1))
}

function addExtractor(s: PartSet) {
  const E = EXTRACTOR
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, E.yaw, 0))
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z).applyQuaternion(q).add(new THREE.Vector3(E.x, TOP, E.z)), q, new THREE.Vector3(1, 1, 1))
  s.add('extractor', s.geo(blockGeometry(E.w, E.h, E.d)), 'mid', { matrix: at(0, E.h / 2 + 0.02, 0) })
  s.add('extractor', s.geo(blockGeometry(E.w * 0.86, E.h * 0.86, 0.008)), 'dark', { matrix: at(0, E.h / 2 + 0.02, E.d / 2 + 0.003) })
  // The filter's grille: a few straight bars across the intake.
  const bar = s.geo(blockGeometry(E.w * 0.86, 0.004, 0.004))
  for (let i = 1; i < 6; i++) s.add('extractor', bar, 'mid', { matrix: at(0, 0.02 + E.h * 0.07 + i * E.h * 0.86 / 6, E.d / 2 + 0.009), edges: false })
  s.add('extractor', s.geo(blockGeometry(0.1, 0.02, 0.06)), 'dark', { matrix: at(0, 0.01, 0) })
}

function addFloorThings(s: PartSet) {
  // Scrap bin by the right pedestal, an offcuts box, the extension reel.
  s.add('floor', s.geo(new THREE.CylinderGeometry(0.17, 0.15, 0.42, 24)), 'mid', { pos: [PED.right.x1 + 0.22, 0.21, 0.3] })
  s.add('floor', s.geo(blockGeometry(0.3, 0.004, 0.06)), 'wood', { pos: [PED.right.x1 + 0.22, 0.43, 0.3], rot: [0.3, 0.6, 0.4] })
  s.add('floor', s.geo(blockGeometry(0.42, 0.26, 0.32)), 'woodDark', { pos: [PED.left.x0 + 0.05, 0.13, PED.z1 + 0.3], rot: [0, 0.2, 0] })
  s.add('floor', s.geo(blockGeometry(0.04, 0.3, 0.03)), 'wood', { pos: [PED.left.x0 + 0.1, 0.36, PED.z1 + 0.26], rot: [0.2, 0.2, 0.1] })
  s.add('floor', s.geo(blockGeometry(0.03, 0.34, 0.05)), 'wood', { pos: [PED.left.x0 - 0.02, 0.38, PED.z1 + 0.33], rot: [-0.15, 0.2, -0.12] })
  const reel = s.geo(discGeometry(0.15, 0.025, [{ x: 0, y: 0, r: 0.03 }], 40))
  for (const dz of [-0.06, 0.06]) s.add('floor', reel, 'red', { pos: [BENCH.x0 - 0.4, 0.16, -0.1 + dz] })
  s.add('floor', s.geo(cyl(0.1, 0.1).rotateX(Math.PI / 2)), 'dark', { pos: [BENCH.x0 - 0.4, 0.16, -0.1] })
  s.add('floor', s.geo(blockGeometry(0.06, 0.04, 0.14)), 'mid', { pos: [BENCH.x0 - 0.4, 0.02, -0.1] })
  s.add('floor', s.geo(wireTube([
    new THREE.Vector3(BENCH.x0 - 0.4, 0.07, -0.1), new THREE.Vector3(BENCH.x0 - 0.55, 0.008, 0.1),
    new THREE.Vector3(BENCH.x0 - 0.15, 0.008, 0.5), new THREE.Vector3(BENCH.x0 + 0.35, 0.008, 0.45),
  ], 0.12, 0.006)), 'dark', { edges: false })
}

/** Pegboard holes: one instanced dark square per hole (one draw call). */
export function pegHoles(mat: THREE.Material) {
  const spots: [number, number][] = []
  for (let x = PEG.x0 + PEG.pitch / 2; x < PEG.x1; x += PEG.pitch) {
    for (let y = PEG.y0 + PEG.pitch / 2; y < PEG.y1; y += PEG.pitch) {
      // Leave the holes behind the rack's uprights out (they would z-fight their edges).
      if (RACK.xs.some(u => Math.abs(u - x) < RACK.w * 0.7)) continue
      // ...and those behind the monitor.
      if (Math.abs(x - MONITOR.c[0]) < MONITOR.w * 0.55 && Math.abs(y - MONITOR.c[1]) < MONITOR.h * 0.6) continue
      spots.push([x, y])
    }
  }
  const geo = new THREE.PlaneGeometry(0.008, 0.008)
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length)
  mesh.name = 'pegHoles'
  const m = new THREE.Matrix4()
  spots.forEach(([x, y], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, PEG.z + 0.0045)))
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
  return mesh
}

/** Faint floor-tile joints (600 mm), drawn with the bench's stave seams. */
export function floorJoints(): number[] {
  const pts: number[] = []
  const T = 0.6
  for (let x = Math.ceil(ROOM.x0 / T) * T; x < ROOM.right; x += T) pts.push(x, 0.0006, ROOM.back, x, 0.0006, ROOM.z1)
  for (let z = Math.ceil(ROOM.back / T) * T; z < ROOM.z1; z += T) pts.push(ROOM.x0, 0.0006, z, ROOM.right, 0.0006, z)
  return pts
}
