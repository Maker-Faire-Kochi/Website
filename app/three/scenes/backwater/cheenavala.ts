import * as THREE from 'three'
import { Assembly, beamGeometry, blockGeometry, pinGeometry, type Materials } from '../../core/kit'
import {
  BANK, BASKET, BLOCK_Y, BOOM, SCOOP, DECK, FAR, FAR_NETS, FAR_PALMS, FULCRUM, NET, STONES, WATER, WORLD, YOKE_Y, cornerLocal, ROPES,
} from './layout'
import { scoopRest } from './haul'

/**
 * The cheena vala (Chinese fishing net) and its ground, built from the kit.
 *
 * Three rigid groups, because three things move differently:
 *  - the ground: water slab, bank and seawall, the jetty on its posts and the
 *    A-frame carrying the pivot pin -- all still;
 *  - the boom: a pair of long slotted poles, spacers, the tip block and the
 *    four spreader poles lashed to it -- it all tilts together on the pin;
 *  - the counterweight: stones lashed under a yoke, hanging plumb from the
 *    boom's rear end and swinging as one pendulum.
 * Every builder disposes its source geometries once merged.
 */

const v3 = (a: THREE.Vector3): [number, number, number] => [a.x, a.y, a.z]

/** Place a kit beam (lying along +x from its first hole) from a to b, plate face towards `face`. */
function beamBetween(asm: Assembly, geo: THREE.BufferGeometry, mat: Parameters<Assembly['add']>[1], a: THREE.Vector3, b: THREE.Vector3, face = new THREE.Vector3(0, 0, 1)) {
  const X = b.clone().sub(a).normalize()
  const Z = face.clone().addScaledVector(X, -face.dot(X)).normalize()
  const Y = new THREE.Vector3().crossVectors(Z, X)
  const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z))
  asm.add(geo, mat, { pos: v3(a), rot: [e.x, e.y, e.z] })
}

export function buildGround(m: Materials) {
  const geos: THREE.BufferGeometry[] = []
  const keep = <T extends THREE.BufferGeometry>(g: T) => (geos.push(g), g)
  const a = new Assembly()

  // The world runs past every screen edge (the page draws this scene full
  // bleed, the subject in a focus box): open water to the left and toward the
  // viewer, the bank to the right, and across the back a far shore whose top
  // edge is the horizon line, with its own palms and a second cheena vala.
  // None of the big blocks' ends is ever in view.
  const W = WORLD
  const deep = BANK.top - WATER.bottom
  a.add(keep(blockGeometry(BANK.x0 - W.x0, -WATER.bottom, W.z1 - FAR.z)), 'water', {
    pos: [(W.x0 + BANK.x0) / 2, WATER.bottom / 2, (FAR.z + W.z1) / 2],
  })
  // Bank: land behind a laterite seawall, back to the far shore.
  const wall = 0.32
  a.add(keep(blockGeometry(W.x1 - BANK.x0 - wall, deep, W.z1 - FAR.back)), 'light', {
    pos: [(BANK.x0 + wall + W.x1) / 2, (BANK.top + WATER.bottom) / 2, (FAR.back + W.z1) / 2],
  })
  a.add(keep(blockGeometry(wall, deep + 0.08, W.z1 - FAR.z)), 'stone', {
    pos: [BANK.x0 + wall / 2, (BANK.top + 0.08 + WATER.bottom) / 2, (FAR.z + W.z1) / 2],
  })
  // Far shore: a low strip of land with a stone edge to the water. The land
  // stops behind the edge: sharing its front face, the two z-fought and the
  // edge shimmered as the scroll moved the camera.
  const edge = 0.2
  a.add(keep(blockGeometry(BANK.x0 - W.x0, FAR.top - WATER.bottom, FAR.z - edge - FAR.back)), 'light', {
    pos: [(W.x0 + BANK.x0) / 2, (FAR.top + WATER.bottom) / 2, (FAR.z - edge + FAR.back) / 2],
  })
  a.add(keep(blockGeometry(BANK.x0 - W.x0, FAR.top + 0.05 - WATER.bottom, edge)), 'stone', {
    pos: [(W.x0 + BANK.x0) / 2, (FAR.top + 0.05 + WATER.bottom) / 2, FAR.z - edge / 2],
  })
  farSet(a, keep)

  // Jetty deck: planks across two stringers.
  const deckLen = DECK.x1 - DECK.x0
  const plank = keep(blockGeometry(0.26, DECK.thick, DECK.z * 2))
  for (let x = DECK.x0 + 0.13; x < DECK.x1; x += 0.3) {
    a.add(plank, 'wood', { pos: [x, DECK.top - DECK.thick / 2, 0] })
  }
  const stringer = keep(blockGeometry(deckLen, 0.16, 0.12))
  for (const z of [-0.85, 0.85]) {
    a.add(stringer, 'woodDark', { pos: [DECK.x0 + deckLen / 2, DECK.top - DECK.thick - 0.08, z] })
  }
  // Posts: down through the water into the bed (past the slab's underside, so
  // the two never share a face), or onto the bank.
  const postXs = [-0.2, 1.25, 2.7, 3.85]
  for (const x of postXs) {
    const foot = x >= BANK.x0 ? BANK.top : WATER.bottom - 0.02
    // Topped inside the stringer, not flush with it: their tops would share a face under the plank gaps.
    const h = DECK.top - DECK.thick - 0.02 - foot
    const post = keep(blockGeometry(0.16, h, 0.16))
    for (const z of [-0.85, 0.85]) a.add(post, 'woodDark', { pos: [x, foot + h / 2, z] })
  }
  // Slotted cross-braces between the water posts, on both faces.
  const braceLen = Math.hypot(1.45, 0.7)
  const brace = keep(beamGeometry({ length: braceLen, width: 0.11, thickness: 0.04, slots: [[braceLen * 0.3, braceLen * 0.7]] }))
  for (const z of [-0.95, 0.95]) {
    for (let i = 0; i < 2; i++) {
      const x0 = postXs[i]!
      const x1 = postXs[i + 1]!
      beamBetween(a, brace, 'wood', new THREE.Vector3(x0, 0.15, z), new THREE.Vector3(x1, 0.15 + 0.7 * (x1 - x0) / 1.45, z))
    }
  }

  // A-frame: two slotted legs a side, meeting at the pivot pin.
  const apex = new THREE.Vector3(...FULCRUM)
  const legLen = Math.hypot(0.75, FULCRUM[1] - DECK.top)
  const leg = keep(beamGeometry({ length: legLen, width: 0.17, thickness: 0.08, slots: [[0.45, legLen - 0.5]] }))
  // The tie spans the legs pin-to-pin at its height.
  const tieY = DECK.top + 0.55
  const tieLen = 1.5 * (1 - (tieY - DECK.top) / (FULCRUM[1] - DECK.top))
  const tie = keep(beamGeometry({ length: tieLen, width: 0.12, thickness: 0.06 }))
  for (const z of [-0.36, 0.36]) {
    // The second leg sits 12 mm proud of the first: in one plane, the pair
    // overlapped and z-fought at the apex. Small enough that the tie, on the
    // legs' outer faces, still bears on both.
    for (const [dx, zl] of [[-0.75, z], [0.75, z + Math.sign(z) * 0.012]] as const) {
      beamBetween(a, leg, 'woodDark', new THREE.Vector3(FULCRUM[0] + dx, DECK.top, zl), apex.clone().setZ(zl))
    }
    a.add(tie, 'woodDark', { pos: [FULCRUM[0] - tieLen / 2, tieY, z + (z > 0 ? 0.07 : -0.07)] })
  }
  a.add(keep(pinGeometry(0.055, 0.95)), 'light', { pos: v3(apex) })

  // Rope blocks: a slotted post with the rope's pin at the top, and a strut
  // on the boom side taking the rope's pull (it pulls the top toward the boom).
  const postH = BLOCK_Y + 0.08
  const post = keep(beamGeometry({ length: postH, width: 0.1, thickness: 0.06, holes: [postH - 0.08], slots: [[0.12, postH - 0.25]] }))
  const strutLen = Math.hypot(0.42, BLOCK_Y - 0.12)
  const strut = keep(beamGeometry({ length: strutLen, width: 0.07, thickness: 0.04 }))
  const sheave = keep(pinGeometry(0.045, 0.16))
  for (const r of ROPES) {
    const [x, , z] = r.to
    beamBetween(a, post, 'woodDark', new THREE.Vector3(x, DECK.top, z), new THREE.Vector3(x, DECK.top + postH, z), new THREE.Vector3(1, 0, 0))
    beamBetween(a, strut, 'wood', new THREE.Vector3(x + 0.42, DECK.top, z + 0.075), new THREE.Vector3(x + 0.02, DECK.top + BLOCK_Y - 0.12, z + 0.075), new THREE.Vector3(0, 0, 1))
    a.add(sheave, 'light', { pos: [x, DECK.top + BLOCK_Y, z] })
  }

  // The scoop net's rack: two low uprights beside fisher 0, each with a pin
  // across the pole, where the long pole rests between catches, its hoop out
  // over the water. And the catch basket.
  const rack = keep(beamGeometry({ length: SCOOP.rackY - SCOOP.poleR - 0.025 + 0.02, width: 0.08, thickness: 0.05, holes: [] }))
  const rackPin = keep(pinGeometry(0.025, 0.14))
  const rest = scoopRest()
  const pinYaw = Math.atan2(rest.dir[2], -rest.dir[0])
  for (const t of SCOOP.posts) {
    const x = rest.p[0] + rest.dir[0] * t
    const z = rest.p[2] + rest.dir[2] * t
    const pinY = rest.p[1] - SCOOP.poleR - 0.025
    beamBetween(a, rack, 'woodDark', new THREE.Vector3(x, DECK.top, z), new THREE.Vector3(x, pinY + 0.02, z), new THREE.Vector3(rest.dir[0], 0, rest.dir[2]))
    a.add(rackPin, 'light', { pos: [x, pinY, z], rot: [0, pinYaw, 0] })
  }
  // The basket: open at the top, woven -- an outer wall with two bands, a rim,
  // the inside wall (its faces turned inward, darker) and a dark floor.
  const bx = BASKET.x
  const bz = BASKET.z
  const basketWall = keep(new THREE.CylinderGeometry(BASKET.r, BASKET.r * 0.8, BASKET.h, 12, 1, true))
  a.add(basketWall, 'wood', { pos: [bx, DECK.top + BASKET.h / 2, bz] })
  // Mirrored, its faces turn inward; its normals are turned to match.
  const inner = keep(new THREE.CylinderGeometry(BASKET.r * 0.93, BASKET.r * 0.74, BASKET.h - 0.01, 12, 1, true).scale(-1, 1, 1))
  {
    const nrm = inner.getAttribute('normal')
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i))
  }
  a.add(inner, 'woodDark', { pos: [bx, DECK.top + BASKET.h / 2 + 0.005, bz], edges: false })
  const floor = keep(new THREE.CircleGeometry(BASKET.r * 0.74, 12).rotateX(-Math.PI / 2))
  a.add(floor, 'dark', { pos: [bx, DECK.top + 0.015, bz], edges: false })
  const rim = keep(new THREE.TorusGeometry(BASKET.r * 0.965, 0.014, 4, 16).rotateX(Math.PI / 2))
  a.add(rim, 'woodDark', { pos: [bx, DECK.top + BASKET.h, bz], edges: false })
  for (const f of [0.35, 0.68]) {
    const r = BASKET.r * (0.8 + 0.2 * f) + 0.004
    a.add(keep(new THREE.TorusGeometry(r, 0.006, 3, 16).rotateX(Math.PI / 2)), 'woodDark', { pos: [bx, DECK.top + BASKET.h * f, bz], edges: false })
  }

  const g = a.build(m, 'ground')
  geos.forEach(x => x.dispose())
  return g
}

/**
 * Distant set dressing, merged into the ground: simplified palms (a leaning
 * trunk and a fan of fronds) and smaller cheena valas on the far shore, raised
 * at rest. Smaller than the near ones, so they read as further away even in an
 * orthographic view.
 */
function farSet(a: Assembly, keep: <T extends THREE.BufferGeometry>(g: T) => T) {
  const box = keep(blockGeometry(1, 1, 1))
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const off = new THREE.Vector3()
  for (const p of FAR_PALMS) {
    const h = 6 * p.s
    // Trunk: leaning box from its foot.
    e.set(0, p.yaw, p.lean)
    q.setFromEuler(e)
    off.set(0, h / 2, 0).applyQuaternion(q)
    a.add(box, 'woodDark', { pos: [p.x + off.x, p.y + off.y, p.z + off.z], rot: [e.x, e.y, e.z], scale: [0.16 * p.s, h, 0.16 * p.s] })
    const top = new THREE.Vector3(0, h, 0).applyQuaternion(q).add(new THREE.Vector3(p.x, p.y, p.z))
    // Fronds: seven blades fanning out and arching down from the crown, two
    // segments each (straight pieces, steeper toward the tip).
    for (let k = 0; k < 7; k++) {
      const len = 1.5 * p.s * (k % 3 === 1 ? 0.8 : 1)
      const yaw = k * Math.PI * 2 / 7 + p.yaw
      const d0 = k % 3 === 2 ? 0.15 : 0.35
      e.set(0, yaw, -d0)
      q.setFromEuler(e)
      off.set(len / 2, 0, 0).applyQuaternion(q)
      a.add(box, 'leaf', { pos: [top.x + off.x, top.y + off.y, top.z + off.z], rot: [e.x, e.y, e.z], scale: [len, 0.03, 0.3 * p.s] })
      const mid = top.clone().addScaledVector(off, 2)
      e.set(0, yaw, -(d0 + 0.6))
      q.setFromEuler(e)
      off.set(len / 2, 0, 0).applyQuaternion(q)
      a.add(box, 'leaf', { pos: [mid.x + off.x, mid.y + off.y, mid.z + off.z], rot: [e.x, e.y, e.z], scale: [len, 0.03, 0.22 * p.s] })
    }
  }
  // Far cheena valas: posts, an A-frame, the boom raised, spreaders and stones, all at scale s.
  for (const n of FAR_NETS) {
    const s = n.s
    const base = new THREE.Vector3(n.x, FAR.top, n.z)
    const dir = new THREE.Vector3(Math.sin(n.yaw), 0, Math.cos(n.yaw))
    const side = new THREE.Vector3(dir.z, 0, -dir.x)
    const at = (f: number, y: number, w = 0) => base.clone().addScaledVector(dir, f * s).add(new THREE.Vector3(0, y * s, 0)).addScaledVector(side, w * s)
    const leg = keep(beamGeometry({ length: 3.2 * s, width: 0.17 * s, thickness: 0.08 * s, holes: [] }))
    const apex = at(0.6, 3)
    for (const w of [-0.36, 0.36]) {
      for (const f of [-0.15, 1.35]) beamBetween(a, leg, 'woodDark', at(f, 0, w), apex.clone().addScaledVector(side, w * s))
    }
    const th = 0.3
    const tip = apex.clone().addScaledVector(dir, 8 * s * Math.cos(th)).add(new THREE.Vector3(0, 8 * s * Math.sin(th), 0))
    const tail = apex.clone().addScaledVector(dir, -3 * s * Math.cos(th)).add(new THREE.Vector3(0, -3 * s * Math.sin(th), 0))
    const boomLen = tip.distanceTo(tail)
    const pole = keep(beamGeometry({ length: boomLen, width: 0.22 * s, thickness: 0.07 * s, holes: [] }))
    for (const w of [-0.16, 0.16]) beamBetween(a, pole, 'wood', tail.clone().addScaledVector(side, w * s), tip.clone().addScaledVector(side, w * s), side)
    const sp = keep(beamGeometry({ length: 3.8 * s, width: 0.085 * s, thickness: 0.05 * s, holes: [] }))
    for (const [u, w] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const c = tip.clone().addScaledVector(dir, u * 2.1 * s).addScaledVector(side, w * 2.1 * s).add(new THREE.Vector3(0, -2.4 * s, 0))
      beamBetween(a, sp, 'woodDark', tip, c, side)
    }
    a.add(box, 'stone', { pos: [tail.x, tail.y - 0.6 * s, tail.z], rot: [0.2, n.yaw, 0.1], scale: [0.7 * s, 0.5 * s, 0.5 * s] })
    const deckB = keep(blockGeometry(2.2 * s, 0.1 * s, 1.6 * s))
    const mid = at(0.6, 0.9)
    a.add(deckB, 'wood', { pos: [mid.x, mid.y, mid.z], rot: [0, n.yaw, 0] })
  }
}

/** The tilting boom in its own frame: pin at the origin, net end along +x. */
export function buildBoom(m: Materials) {
  const geos: THREE.BufferGeometry[] = []
  const keep = <T extends THREE.BufferGeometry>(g: T) => (geos.push(g), g)
  const a = new Assembly()
  const L = BOOM.front + BOOM.rear
  const r = BOOM.rear
  const pole = keep(beamGeometry({
    length: L,
    width: BOOM.width,
    thickness: 0.07,
    holes: [0, r, L],
    slots: [[0.45, r - 0.5], [r + 0.55, r + 3.1], [r + 3.6, r + 6.2], [r + 6.7, L - 0.45]],
  }))
  for (const z of [-BOOM.gap, BOOM.gap]) a.add(pole, 'wood', { pos: [-r, 0, z] })
  // Spacers hold the pair apart (and are where people stand to walk the boom).
  const spacer = keep(blockGeometry(0.12, 0.15, BOOM.gap * 2 - 0.07))
  for (const x of [-r + 0.2, -1.4, 1.2, 3.2, 5.2, 7.0]) a.add(spacer, 'woodDark', { pos: [x, 0, 0] })
  const pin = keep(pinGeometry(0.035, BOOM.gap * 2 + 0.16))
  for (const x of [-r, BOOM.front]) a.add(pin, 'light', { pos: [x, 0, 0] })

  // Tip block, and the four spreader poles splaying out and down to the net corners.
  a.add(keep(blockGeometry(0.34, 0.3, BOOM.gap * 2 + 0.1)), 'woodDark', { pos: [BOOM.front + 0.05, -0.05, 0] })
  const tip = new THREE.Vector3(BOOM.front, -0.1, 0)
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const c = new THREE.Vector3(...cornerLocal(i, j))
    const len = c.distanceTo(tip)
    const spreader = keep(beamGeometry({ length: len, width: 0.085, thickness: 0.05, holes: [0], slots: [[len * 0.25, len * 0.55]] }))
    beamBetween(a, spreader, 'woodDark', tip, c, new THREE.Vector3(0, 0, j ? 1 : -1))
  }

  const g = a.build(m, 'boom')
  geos.forEach(x => x.dispose())
  return g
}

/** Counterweight cluster in its hanging frame (origin at the hang point, stones below). */
export function buildStones(m: Materials) {
  const geos: THREE.BufferGeometry[] = []
  const keep = <T extends THREE.BufferGeometry>(g: T) => (geos.push(g), g)
  const a = new Assembly()
  const yoke = keep(beamGeometry({ length: 1.0, width: 0.1, thickness: 0.06, holes: [0.5] }))
  a.add(yoke, 'woodDark', { pos: [-0.5, YOKE_Y, 0] })
  // Rough dressed stones: a dodecahedron squashed to each stone's size.
  const stone = keep(new THREE.DodecahedronGeometry(0.5, 0))
  for (const s of STONES) {
    a.add(stone, 'stone', {
      pos: [s.x, YOKE_Y - s.len - s.h / 2, 0],
      rot: [0.2, s.rot, 0.1],
      scale: [s.w, s.h, s.d],
    })
  }
  const g = a.build(m, 'stones')
  geos.forEach(x => x.dispose())
  return g
}

/** For hit testing: rough boxes around the boom and net, in the boom frame. */
export function boomProxies() {
  const mat = new THREE.MeshBasicMaterial()
  const boom = new THREE.Mesh(new THREE.BoxGeometry(BOOM.front + BOOM.rear + 0.4, 0.7, 0.9), mat)
  boom.position.set((BOOM.front - BOOM.rear) / 2, 0, 0)
  const net = new THREE.Mesh(new THREE.BoxGeometry(NET.half * 2 + 0.4, NET.drop + 1.4, NET.half * 2 + 0.4), mat)
  net.position.set(BOOM.front, -(NET.drop + 1.4) / 2 + 0.2, 0)
  net.rotation.z = -NET.thetaRef
  for (const p of [boom, net]) p.visible = false
  return { meshes: [boom, net], mat }
}
