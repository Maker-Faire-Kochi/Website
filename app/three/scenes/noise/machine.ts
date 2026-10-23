import * as THREE from 'three'
import { Assembly, blockGeometry, discGeometry, extrude, pinGeometry, type Materials } from '../../core/kit'
import {
  BASE, BASE_TOP, CHEEK_OUT, CHEEK_X, FACE, JACK, KNOBS, PLY, SIDE_X, SPK, facePoint,
} from './layout'

/**
 * The campaign's noise machine, rebuilt in the beam kit's language instead of
 * copied from the photo: an open frame of plywood plates on metal standoffs,
 * a square face leaning back with a big speaker in it, a perfboard of chips
 * between the box and a control cheek, two cream knobs and a jack with a
 * coiled red cable (the drive: it carries the signal in).
 *
 * Four rigid parts, each its own node: the frame (with the cable), the cone,
 * and one per knob cap. Every plate joint is face to face with pins or
 * spacers through it; nothing floats.
 */

const TILT: [number, number, number] = [-FACE.tilt, 0, 0]

function plate(pts: [number, number][], holes: { x: number, y: number, r: number }[]) {
  const s = new THREE.Shape()
  s.moveTo(pts[0]![0], pts[0]![1])
  for (const [x, y] of pts.slice(1)) s.lineTo(x, y)
  s.closePath()
  for (const h of holes) {
    const p = new THREE.Path()
    p.absarc(h.x, h.y, h.r, 0, Math.PI * 2, true)
    s.holes.push(p)
  }
  return extrude(s, PLY, 24)
}

/**
 * A side plate standing in the machine's YZ plane, outline given as (z, y).
 * The shape is drawn with x = -z so a +90deg turn about y lays it into place.
 */
function sidePlate(outline: [number, number][], holes: { z: number, y: number, r: number }[]) {
  return plate(outline.map(([z, y]) => [-z, y]), holes.map(h => ({ x: -h.z, y: h.y, r: h.r })))
}

/** (z, y) of a face-frame point. */
const zy = (b: number, c: number): [number, number] => {
  const p = facePoint(0, b, c)
  return [p[2], p[1]]
}

/** The face-frame b at which the line at depth c meets the base top. */
const bAtBase = (c: number) => (BASE_TOP - FACE.y - c * Math.sin(FACE.tilt)) / Math.cos(FACE.tilt)

/** Reverses every triangle so an open shell shows its inside (the cone is seen from within). */
function flipped(geo: THREE.BufferGeometry) {
  const idx = geo.index!
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1)
    idx.setX(i + 1, idx.getX(i + 2))
    idx.setX(i + 2, a)
  }
  const n = geo.getAttribute('normal')
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i))
  return geo
}

/** A polyline as a Curve, so TubeGeometry can follow a sampled helix exactly. */
class Polyline extends THREE.Curve<THREE.Vector3> {
  constructor(private pts: THREE.Vector3[]) {
    super()
    this.arcLengthDivisions = pts.length * 2
  }

  override getPoint(t: number, target = new THREE.Vector3()) {
    const f = Math.max(0, Math.min(1, t)) * (this.pts.length - 1)
    const i = Math.min(this.pts.length - 2, Math.floor(f))
    return target.copy(this.pts[i]!).lerp(this.pts[i + 1]!, f - i)
  }
}

/** Jack position on the cheek's outer face, and where the cable leaves the plug. */
export function jackPoint() {
  const [, y, z] = facePoint(0, JACK.b, JACK.c)
  return { y, z, plugEnd: CHEEK_OUT - 0.058 }
}

/**
 * The coiled cable: a helix wound around a centre line that leaves the plug,
 * drops to the floor, loops round in front of the machine and runs in under
 * the base. Natural things may curve; this is a cable, not a machine member.
 */
function cableGeometry() {
  const j = jackPoint()
  const centre = new THREE.CatmullRomCurve3([
    new THREE.Vector3(j.plugEnd, j.y, j.z),
    new THREE.Vector3(j.plugEnd - 0.022, j.y - 0.012, j.z + 0.006),
    new THREE.Vector3(-0.345, 0.05, j.z + 0.035),
    new THREE.Vector3(-0.33, 0.013, 0.13),
    new THREE.Vector3(-0.24, 0.013, 0.205),
    new THREE.Vector3(-0.1, 0.013, 0.218),
    new THREE.Vector3(0.02, 0.013, 0.185),
    new THREE.Vector3(0.055, 0.013, 0.09),
    new THREE.Vector3(0.03, 0.013, 0),
  ], false, 'centripetal')
  const R = 0.009
  const turns = Math.round(centre.getLength() / 0.0085)
  const n = turns * 10
  const frames = centre.computeFrenetFrames(n, false)
  const pts: THREE.Vector3[] = []
  const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
  for (let i = 0; i <= n; i++) {
    const u = i / n
    // A short straight lead out of the plug, then the coil.
    const r = R * ease((u - 0.03) / 0.05)
    const a = u * turns * Math.PI * 2
    const p = centre.getPointAt(u)
    p.addScaledVector(frames.normals[i]!, Math.cos(a) * r).addScaledVector(frames.binormals[i]!, Math.sin(a) * r)
    pts.push(p)
  }
  return new THREE.TubeGeometry(new Polyline(pts), n, 0.0032, 6, false)
}

export function buildFrame(m: Materials): THREE.Group {
  const a = new Assembly()
  const own: THREE.BufferGeometry[] = []
  const g = <T extends THREE.BufferGeometry>(geo: T) => (own.push(geo), geo)
  const S = FACE.s
  const sideRot: [number, number, number] = [0, Math.PI / 2, 0]

  // Base plate on four metal standoffs.
  a.add(g(blockGeometry(BASE.x1 - BASE.x0, BASE.t, BASE.z1 - BASE.z0)), 'wood', {
    pos: [(BASE.x0 + BASE.x1) / 2, BASE.y0 + BASE.t / 2, (BASE.z0 + BASE.z1) / 2],
  })
  const standoff = g(new THREE.CylinderGeometry(0.008, 0.008, BASE.y0, 24))
  for (const x of [BASE.x0 + 0.025, BASE.x1 - 0.025]) {
    for (const z of [BASE.z0 + 0.025, BASE.z1 - 0.025]) a.add(standoff, 'metal', { pos: [x, BASE.y0 / 2, z] })
  }

  // The face: a square plate with the speaker hole, leaning back.
  const face = plate([[-S / 2, 0], [S / 2, 0], [S / 2, S], [-S / 2, S]], [{ x: 0, y: S / 2, r: SPK.hole }])
  own.push(face)
  a.add(face, 'wood', { pos: facePoint(0, 0, 0), rot: TILT })

  // Box sides: flush with the face front, resting on the base. The inner left
  // one also carries the perfboard's other edge.
  const fc = PLY / 2
  const side = g(sidePlate([
    [BASE.z0 + 0.01, BASE_TOP], zy(bAtBase(fc), fc), zy(S, fc), [BASE.z0 + 0.01, 0.2],
  ], [{ z: -0.05, y: 0.115, r: 0.032 }]))
  a.add(side, 'wood', { pos: [SIDE_X, 0, 0], rot: sideRot })
  a.add(side, 'wood', { pos: [-SIDE_X, 0, 0], rot: sideRot })

  // The control cheek stands proud of the face, like the photo's.
  const cc = fc + 0.014
  const cheek = g(sidePlate([
    [-0.1, BASE_TOP], zy(bAtBase(cc), cc), zy(S + 0.02, cc), [-0.1, 0.26],
  ], [{ z: -0.055, y: 0.085, r: 0.024 }, { z: -0.055, y: 0.16, r: 0.018 }]))
  a.add(cheek, 'wood', { pos: [CHEEK_X, 0, 0], rot: sideRot })

  // Spacers through cheek and inner side tie them together across the gap.
  const span = -SIDE_X - CHEEK_X + PLY + 0.006
  const spacer = g(pinGeometry(0.005, span))
  const spacerX = (CHEEK_X - SIDE_X) / 2
  for (const [z, y] of [[-0.085, 0.07], [-0.085, 0.235], zy(0.26, -0.03)] as [number, number][]) {
    a.add(spacer, 'metal', { pos: [spacerX, y, z], rot: sideRot })
  }

  // Screws: four in the face corners, eight round the speaker gasket.
  const screw = g(discGeometry(0.0055, 0.003, [], 24))
  for (const sa of [-1, 1]) {
    for (const b of [0.02, S - 0.02]) a.add(screw, 'metal', { pos: facePoint(sa * (S / 2 - 0.02), b, PLY / 2 + 0.0015), rot: TILT })
  }
  a.add(g(discGeometry(SPK.ring, 0.004, [{ x: 0, y: 0, r: SPK.hole }], 64)), 'dark', {
    pos: facePoint(0, S / 2, PLY / 2 + 0.002), rot: TILT,
  })
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 + Math.PI / 8
    a.add(screw, 'metal', { pos: facePoint(Math.cos(ang) * 0.13, S / 2 + Math.sin(ang) * 0.13, PLY / 2 + 0.0055), rot: TILT })
  }


  // Perfboard in the gap, set back from the face, with its chips.
  const ba = CHEEK_X + PLY / 2 + 0.003
  const bb = -(SIDE_X + PLY / 2) - 0.003
  const bc = -0.022
  const boardA = (ba + bb) / 2
  a.add(g(blockGeometry(bb - ba, 0.24, 0.0025)), 'woodDark', { pos: facePoint(boardA, 0.15, bc), rot: TILT })
  const top = bc + 0.00125
  const chip = g(blockGeometry(0.018, 0.026, 0.005))
  a.add(chip, 'dark', { pos: facePoint(boardA + 0.004, 0.215, top + 0.0025), rot: TILT })
  a.add(chip, 'dark', { pos: facePoint(boardA - 0.006, 0.135, top + 0.0025), rot: TILT })
  const cap = g(new THREE.CylinderGeometry(0.0075, 0.0075, 0.016, 24).rotateX(Math.PI / 2))
  a.add(cap, 'mid', { pos: facePoint(boardA + 0.012, 0.07, top + 0.008), rot: TILT })
  const resistor = g(blockGeometry(0.004, 0.013, 0.004))
  for (const [da, b] of [[-0.022, 0.25], [-0.016, 0.175], [0.02, 0.175], [-0.02, 0.085], [0.022, 0.115]] as [number, number][]) {
    a.add(resistor, 'light', { pos: facePoint(boardA + da, b, top + 0.002), rot: TILT })
  }

  // Pot bodies behind the cheek, hex nuts in front; the jack barrel below them.
  const nut = g(new THREE.CylinderGeometry(0.012, 0.012, 0.005, 6))
  const pot = g(new THREE.CylinderGeometry(0.012, 0.012, 0.016, 24))
  const axisX: [number, number, number] = [0, 0, Math.PI / 2]
  for (const k of KNOBS) {
    const [, y, z] = facePoint(0, k.b, k.c)
    a.add(nut, 'metal', { pos: [CHEEK_OUT - 0.0025, y, z], rot: axisX })
    a.add(pot, 'metal', { pos: [CHEEK_X + PLY / 2 + 0.008, y, z], rot: axisX })
  }
  const j = jackPoint()
  a.add(nut, 'metal', { pos: [CHEEK_OUT - 0.0025, j.y, j.z], rot: axisX })
  a.add(g(new THREE.CylinderGeometry(0.0062, 0.0062, 0.012, 24)), 'metal', { pos: [CHEEK_OUT - 0.011, j.y, j.z], rot: axisX })
  // The plug and its strain relief are red with the cable: the signal going in.
  a.add(g(new THREE.CylinderGeometry(0.0075, 0.0075, 0.026, 24)), 'red', { pos: [CHEEK_OUT - 0.03, j.y, j.z], rot: axisX })
  a.add(g(new THREE.CylinderGeometry(0.0065, 0.0042, 0.016, 24)), 'red', { pos: [CHEEK_OUT - 0.05, j.y, j.z], rot: axisX })
  a.add(g(cableGeometry()), 'red', { edges: false })

  const group = a.build(m, 'noise-frame')
  own.forEach(geo => geo.dispose())
  return group
}

/**
 * The cone: three shallow frusta (the annulus stack reads as corrugations)
 * and a light dust cap, in the speaker's own frame (z out of the face). Its
 * node moves along z by the excursion.
 */
export function buildCone(m: Materials): THREE.Group {
  const a = new Assembly()
  const own: THREE.BufferGeometry[] = []
  const front = PLY / 2 - 0.002
  const back = PLY / 2 - SPK.depth
  const ring = (f0: number, f1: number) => {
    const r0 = SPK.coneR + (SPK.coneIn - SPK.coneR) * f0
    const r1 = SPK.coneR + (SPK.coneIn - SPK.coneR) * f1
    const z0 = front + (back - front) * f0
    const z1 = front + (back - front) * f1
    // Cylinder +y becomes +z, so radiusTop is the front (larger) rim.
    const geo = flipped(new THREE.CylinderGeometry(r0, r1, z0 - z1, 64, 1, true).rotateX(Math.PI / 2))
    geo.translate(0, 0, (z0 + z1) / 2)
    own.push(geo)
    return geo
  }
  for (const [f0, f1] of [[0, 0.3], [0.3, 0.62], [0.62, 1]] as [number, number][]) a.add(ring(f0, f1), 'mid')
  const R = 0.05
  const capPhi = 0.9
  const dust = new THREE.SphereGeometry(R, 48, 8, 0, Math.PI * 2, 0, capPhi).rotateX(Math.PI / 2)
  own.push(dust)
  a.add(dust, 'light', { pos: [0, 0, back + 0.0015 - R * Math.cos(capPhi)] })
  const group = a.build(m, 'noise-cone')
  own.forEach(geo => geo.dispose())
  const node = new THREE.Group()
  node.name = 'cone'
  node.add(group)
  return node
}

/**
 * The surround: a dark half-roll joining the cone's rim to the gasket. Its
 * outer edge is clamped and its inner edge rides on the cone, so as the cone
 * pumps the roll shears between them (each vertex moves by the excursion
 * times how near it is to the cone). In the speaker frame, like the cone.
 */
export function buildSurround(m: Materials) {
  const roll: THREE.Vector2[] = []
  const rc = (SPK.coneR + SPK.hole) / 2
  const rr = (SPK.hole - SPK.coneR) / 2
  // 18 degree steps stay under the kit's edge angle: the roll shades smoothly.
  for (let i = 0; i <= 10; i++) {
    const ph = Math.PI * (1 - i / 10)
    roll.push(new THREE.Vector2(rc + rr * Math.cos(ph), 0.008 * Math.sin(ph)))
  }
  const geo = flipped(new THREE.LatheGeometry(roll, 64)).rotateX(Math.PI / 2)
  geo.translate(0, 0, PLY / 2 - 0.001)
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  pos.setUsage(THREE.DynamicDrawUsage)
  const rest = Float32Array.from(pos.array as Float32Array)
  const weight = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(rest[i * 3]!, rest[i * 3 + 1]!)
    weight[i] = Math.max(0, Math.min(1, (SPK.hole - r) / (SPK.hole - SPK.coneR)))
  }
  const mesh = new THREE.Mesh(geo, m.face.dark)
  mesh.name = 'surround'
  let shown = 0
  return {
    mesh,
    set(x: number) {
      if (Math.abs(x - shown) < 1e-5) return
      shown = x
      const arr = pos.array as Float32Array
      for (let i = 0; i < pos.count; i++) arr[i * 3 + 2] = rest[i * 3 + 2]! + x * weight[i]!
      pos.needsUpdate = true
      geo.computeVertexNormals()
    },
  }
}

/** Where the speaker frame sits: the face centre, tilted with the face. */
export function speakerFrame() {
  const f = new THREE.Group()
  f.position.set(...facePoint(0, FACE.s / 2, 0))
  f.rotation.set(...TILT)
  return f
}

/**
 * One knob: a cream skirt and cap with a dark pointer line, built along +y
 * (out of the cheek). Returned as an orienting holder (turns +y to the cheek's
 * outward -x) and the cap node that rotates about its own axis.
 */
export function buildKnob(m: Materials, i: 0 | 1) {
  const a = new Assembly()
  const skirt = new THREE.CylinderGeometry(0.03, 0.03, 0.007, 64)
  const cap = new THREE.CylinderGeometry(0.0245, 0.026, 0.026, 64)
  const line = blockGeometry(0.018, 0.0012, 0.003)
  a.add(skirt, 'light', { pos: [0, 0.0085, 0] })
  a.add(cap, 'light', { pos: [0, 0.012 + 0.013, 0] })
  a.add(line, 'dark', { pos: [0.012, 0.0386, 0] })
  const group = a.build(m, `knob${i + 1}`)
  ;[skirt, cap, line].forEach(geo => geo.dispose())
  const node = new THREE.Group()
  node.name = `knob${i + 1}`
  node.add(group)
  const holder = new THREE.Group()
  const [, y, z] = facePoint(0, KNOBS[i].b, KNOBS[i].c)
  holder.position.set(CHEEK_OUT, y, z)
  holder.rotation.z = Math.PI / 2
  holder.add(node)
  return { holder, node }
}
