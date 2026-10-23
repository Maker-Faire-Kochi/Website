import * as THREE from 'three'
import { beamGeometry, blockGeometry, extrude, type Materials, type MatKey } from '../../core/kit'
import {
  ARM, BB, BB_ZC, BUTTON, BUTTON_X, BUZZER, BUZZER_POS, COLS, colX, HEADER, headerPin, HORN_Y, LED, LED_COLS,
  LINKS, P, RAIL_ROWS, railHasHole, rowZ, SBC, SBC_HOLE_INSET, SBC_TOP, SERVO_BODY, SERVO_PLUG, SHAFT,
  TERMINAL_ROWS, WIRES,
} from './layout'

/**
 * The electronics on the mat, and the PartSet every static piece of the
 * workbench is merged through. Everything that never moves -- the bench, its
 * tools AND this board, breadboard and wiring -- is ONE rigid set (faces
 * merged per material, every hairline in one LineSegments), so the whole
 * static drawing costs a handful of draw calls.
 *
 * Hover needs to light ONE part cyan without splitting the merged meshes, so
 * each nameable part is also merged into its own cyan "overlay" mesh built
 * from the very same triangles. Overlays are hidden (no draw call) until
 * hovered, drawn after the opaque pass at identical depth so they win the
 * depth test exactly over their own part and nowhere else, and double as the
 * raycast targets for picking.
 */

export type Target =
  | 'board' | 'soc' | 'ram' | 'gpio' | 'usb' | 'ethernet' | 'hdmi' | 'usbc' | 'pwrLed' | 'actLed'
  | 'wires' | 'breadboard' | 'led0' | 'led1' | 'led2' | 'led3' | 'res0' | 'res1' | 'res2' | 'res3'
  | 'button' | 'buzzer' | 'servo'
  | 'benchTop' | 'toolChest' | 'mat' | 'station' | 'iron' | 'holder' | 'hotAir' | 'helpingHands' | 'perfboard'
  | 'spool' | 'lamp' | 'multimeter' | 'drillPress' | 'mitreSaw' | 'batteries' | 'charger' | 'bins' | 'boxes'
  | 'sprays' | 'shelf' | 'handTools' | 'stool' | 'powerStrip' | 'mug' | 'usbPower' | 'monitor' | 'extractor' | 'floor'

export const NAMES: Record<Target, string> = {
  board: 'Single-board computer',
  soc: 'SoC (processor)',
  ram: 'RAM',
  gpio: '40-pin GPIO header',
  usb: 'USB ports',
  ethernet: 'Ethernet port',
  hdmi: 'Micro-HDMI ports',
  usbc: 'USB-C power in',
  pwrLed: 'Power LED',
  actLed: 'Activity LED',
  wires: 'Jumper wires',
  breadboard: 'Breadboard',
  led0: 'LED, red',
  led1: 'LED, amber',
  led2: 'LED, green',
  led3: 'LED, blue',
  res0: 'Resistor, 220 ohm',
  res1: 'Resistor, 220 ohm',
  res2: 'Resistor, 220 ohm',
  res3: 'Resistor, 220 ohm',
  button: 'Push button',
  buzzer: 'Piezo buzzer',
  servo: 'Hobby servo',
  benchTop: 'Butcher-block bench top',
  toolChest: 'Steel tool chest',
  mat: 'Silicone soldering mat',
  station: 'Soldering station',
  iron: 'Soldering iron',
  holder: 'Iron holder and tip cleaner',
  hotAir: 'Hot-air rework station',
  helpingHands: 'Helping hands',
  perfboard: 'Perfboard being soldered',
  spool: 'Solder spool',
  lamp: 'Magnifier lamp',
  multimeter: 'Multimeter',
  drillPress: 'Drill press',
  mitreSaw: 'Mitre saw',
  batteries: 'Power-tool battery packs',
  charger: 'Battery charger',
  bins: 'Parts bins',
  boxes: 'Storage boxes',
  sprays: 'Spray cans',
  shelf: 'Wall shelf',
  handTools: 'Hand tools',
  stool: 'Stool',
  powerStrip: 'Power strip',
  mug: 'Mug',
  usbPower: 'USB power supply',
  monitor: 'Monitor, the computer terminal',
  extractor: 'Fume extractor',
  floor: 'Scrap bin, offcuts, extension reel',
}

export interface AddOpts {
  pos?: [number, number, number]
  rot?: [number, number, number]
  scale?: [number, number, number]
  /** A full placement instead of pos/rot/scale. */
  matrix?: THREE.Matrix4
  edges?: boolean
}

interface Part { geo: THREE.BufferGeometry, mat: MatKey, m: THREE.Matrix4, edges: boolean, target: Target | null }

/** Faces meeting at this angle or more get a hairline (the kit's value). */
const EDGE_ANGLE = 20
const flatCache = new WeakMap<THREE.BufferGeometry, [Float32Array, Float32Array]>()
const edgeCache = new WeakMap<THREE.BufferGeometry, Float32Array>()

/** A geometry's triangles as flat positions and normals (cached per source geometry). */
function flat(geo: THREE.BufferGeometry): [Float32Array, Float32Array] {
  let f = flatCache.get(geo)
  if (!f) {
    const g = geo.index ? geo.toNonIndexed() : geo
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    f = [
      new Float32Array((g.getAttribute('position') as THREE.BufferAttribute).array),
      new Float32Array((g.getAttribute('normal') as THREE.BufferAttribute).array),
    ]
    if (g !== geo) g.dispose()
    flatCache.set(geo, f)
  }
  return f
}

function edgesOf(geo: THREE.BufferGeometry) {
  let e = edgeCache.get(geo)
  if (!e) {
    const g = new THREE.EdgesGeometry(geo, EDGE_ANGLE)
    e = new Float32Array((g.getAttribute('position') as THREE.BufferAttribute).array)
    g.dispose()
    edgeCache.set(geo, e)
  }
  return e
}

/** Points through a 4x4 (column-major elements). */
function writePoints(src: Float32Array, dst: Float32Array, at: number, e: ArrayLike<number>) {
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]!
    const y = src[i + 1]!
    const z = src[i + 2]!
    dst[at + i] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!
    dst[at + i + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!
    dst[at + i + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!
  }
}

/** Normals through a 3x3 normal matrix, renormalised. */
function writeNormals(src: Float32Array, dst: Float32Array, at: number, e: ArrayLike<number>) {
  for (let i = 0; i < src.length; i += 3) {
    const x = e[0]! * src[i]! + e[3]! * src[i + 1]! + e[6]! * src[i + 2]!
    const y = e[1]! * src[i]! + e[4]! * src[i + 1]! + e[7]! * src[i + 2]!
    const z = e[2]! * src[i]! + e[5]! * src[i + 1]! + e[8]! * src[i + 2]!
    const l = Math.hypot(x, y, z) || 1
    dst[at + i] = x / l
    dst[at + i + 1] = y / l
    dst[at + i + 2] = z / l
  }
}

const tq = new THREE.Quaternion()
const te = new THREE.Euler()
const ts = new THREE.Vector3()
const tp = new THREE.Vector3()

/**
 * A RIGID set of parts drawn as one merged mesh per material plus ONE
 * LineSegments of hairlines: the kit's Assembly, written to fill preallocated
 * arrays (a bench of a thousand parts merges without a garbage storm) and
 * able to yield to the browser while it does. A geometry added many times
 * (drawer handles, battery packs, bins, header pins) is triangulated and
 * edge-detected ONCE and only its transformed copies are written, so the
 * whole static bench still costs (materials + 1) draw calls.
 *
 * Every nameable part is also merged into its own hidden cyan overlay built
 * from the very same triangles: the hover highlight (drawn after the opaque
 * pass at identical depth, so it wins exactly over its own part) and the
 * raycast target. A frame (setFrame) prefixes every following placement: the
 * decimetre electronics layout goes into the metre bench through one frame.
 */
export class PartSet {
  private readonly parts: Part[] = []
  private readonly own = new Set<THREE.BufferGeometry>()
  private readonly frame = new THREE.Matrix4()

  /** Remember a geometry made for this set; it is disposed after build (the merge keeps copies). */
  geo<T extends THREE.BufferGeometry>(g: T): T {
    this.own.add(g)
    return g
  }

  setFrame(m: THREE.Matrix4 | null) {
    if (m) this.frame.copy(m)
    else this.frame.identity()
  }

  add(target: Target | null, geo: THREE.BufferGeometry, mat: MatKey, opts: AddOpts = {}) {
    let m: THREE.Matrix4
    if (opts.matrix) m = opts.matrix.clone()
    else {
      tp.set(...(opts.pos ?? [0, 0, 0]))
      tq.setFromEuler(te.set(...(opts.rot ?? [0, 0, 0])))
      ts.set(...(opts.scale ?? [1, 1, 1]))
      m = new THREE.Matrix4().compose(tp, tq, ts)
    }
    m.premultiply(this.frame)
    this.parts.push({ geo, mat, m, edges: opts.edges ?? true, target })
    return this
  }

  build(m: Materials, name: string) {
    const it = this.steps(m, name)
    for (;;) {
      const r = it.next()
      if (r.done) return r.value
    }
  }

  /** As build(), yielding to the browser whenever a slice has run about 8 ms. */
  async buildAsync(m: Materials, name: string, yieldFn: () => Promise<void>) {
    const it = this.steps(m, name)
    let t0 = performance.now()
    for (;;) {
      const r = it.next()
      if (r.done) return r.value
      if (performance.now() - t0 > 8) {
        await yieldFn()
        t0 = performance.now()
      }
    }
  }

  private *steps(m: Materials, name: string): Generator<void, { group: THREE.Group, picks: THREE.Mesh[] }> {
    const faceN = new Map<MatKey, number>()
    const overN = new Map<Target, number>()
    let lineN = 0
    for (const p of this.parts) {
      const n = flat(p.geo)[0].length
      faceN.set(p.mat, (faceN.get(p.mat) ?? 0) + n)
      if (p.target) overN.set(p.target, (overN.get(p.target) ?? 0) + n)
      if (p.edges) lineN += edgesOf(p.geo).length
      yield
    }
    type Buf = { pos: Float32Array, nrm: Float32Array, at: number }
    const faces = new Map<MatKey, Buf>()
    for (const [k, n] of faceN) faces.set(k, { pos: new Float32Array(n), nrm: new Float32Array(n), at: 0 })
    const overs = new Map<Target, Buf>()
    for (const [k, n] of overN) overs.set(k, { pos: new Float32Array(n), nrm: new Float32Array(n), at: 0 })
    const lines = new Float32Array(lineN)
    let lineAt = 0
    const nm = new THREE.Matrix3()
    for (const p of this.parts) {
      const [pos, nrm] = flat(p.geo)
      const e = p.m.elements
      nm.getNormalMatrix(p.m)
      const dsts = p.target ? [faces.get(p.mat)!, overs.get(p.target)!] : [faces.get(p.mat)!]
      for (const d of dsts) {
        writePoints(pos, d.pos, d.at, e)
        writeNormals(nrm, d.nrm, d.at, nm.elements)
        d.at += pos.length
      }
      if (p.edges) {
        const ed = edgesOf(p.geo)
        writePoints(ed, lines, lineAt, e)
        lineAt += ed.length
      }
      yield
    }
    const group = new THREE.Group()
    group.name = name
    const mk = (d: Buf) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3))
      g.setAttribute('normal', new THREE.BufferAttribute(d.nrm, 3))
      g.computeBoundingSphere()
      return g
    }
    for (const [k, d] of faces) {
      const mesh = new THREE.Mesh(mk(d), m.face[k])
      mesh.name = `${name}:${k}`
      group.add(mesh)
    }
    if (lineN) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(lines, 3))
      g.computeBoundingSphere()
      const seg = new THREE.LineSegments(g, m.line)
      seg.name = `${name}:lines`
      group.add(seg)
    }
    const picks: THREE.Mesh[] = []
    for (const [t, d] of overs) {
      const mesh = new THREE.Mesh(mk(d), m.face.cyan)
      mesh.name = `${name}:${t}`
      mesh.visible = false
      mesh.renderOrder = 1
      mesh.userData.target = t
      group.add(mesh)
      picks.push(mesh)
    }
    this.own.forEach(g => g.dispose())
    this.own.clear()
    this.parts.length = 0
    return { group, picks }
  }
}

/** Vertical cylinder; 24 sides keeps facets under the kit's edge angle, so no ridge lines. */
export const cyl = (r: number, h: number) => new THREE.CylinderGeometry(r, r, h, 24)
export const FLAT: [number, number, number] = [-Math.PI / 2, 0, 0]

/** Rounded rectangle centred on the origin, with circular holes; lies flat once rotated by FLAT. */
export function plate(w: number, l: number, r: number, holes: [number, number, number][] = []) {
  const s = new THREE.Shape()
  const x = w / 2
  const y = l / 2
  s.moveTo(-x + r, -y)
  s.lineTo(x - r, -y)
  s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false)
  s.lineTo(x, y - r)
  s.absarc(x - r, y - r, r, 0, Math.PI / 2, false)
  s.lineTo(-x + r, y)
  s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false)
  s.lineTo(-x, -y + r)
  s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false)
  for (const [hx, hy, hr] of holes) {
    const h = new THREE.Path()
    h.absarc(hx, hy, hr, 0, Math.PI * 2, true)
    s.holes.push(h)
  }
  return s
}

/**
 * A wire as straight runs with rounded bends at each corner: the jumpers stay
 * stiff near their connectors and bend gently where they drape. Returns a
 * tube along the path.
 */
export function wireTube(pts: THREE.Vector3[], bend: number, radius: number) {
  const path = new THREE.CurvePath<THREE.Vector3>()
  let from = pts[0]!.clone()
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!
    const a = pts[i - 1]!.clone().sub(p)
    const b = pts[i + 1]!.clone().sub(p)
    const ra = Math.min(bend, a.length() * 0.45)
    const rb = Math.min(bend, b.length() * 0.45)
    const pa = p.clone().add(a.normalize().multiplyScalar(ra))
    const pb = p.clone().add(b.normalize().multiplyScalar(rb))
    if (from.distanceTo(pa) > 1e-6) path.add(new THREE.LineCurve3(from, pa))
    path.add(new THREE.QuadraticBezierCurve3(pa, p.clone(), pb))
    from = pb
  }
  path.add(new THREE.LineCurve3(from, pts[pts.length - 1]!.clone()))
  const segs = Math.max(16, Math.round(path.getLength() * 40))
  return new THREE.TubeGeometry(path as unknown as THREE.Curve<THREE.Vector3>, segs, radius, 6, false)
}

const WIRE_R = 0.0075
/** Female housing on a header pin, male housing standing in a breadboard hole. */
const FEMALE = { w: 0.024, h: 0.14 }
const MALE = { w: 0.024, h: 0.1, lift: 0.004 }

// ── The single-board computer ─────────────────────────────────────────────

function addSbc(s: PartSet) {
  const W = SBC.x1 - SBC.x0
  const L = SBC.z1 - SBC.z0
  const cx = (SBC.x0 + SBC.x1) / 2
  const cz = (SBC.z0 + SBC.z1) / 2
  const i = SBC_HOLE_INSET
  // Mounting holes 3.5 mm from the long edges, at both ends of the header side.
  const holes: [number, number][] = [
    [SBC.x0 + i, SBC.z1 - i], [SBC.x1 - i, SBC.z1 - i],
    [SBC.x0 + i, SBC.z1 - 0.615], [SBC.x1 - i, SBC.z1 - 0.615],
  ]
  const pcb = s.geo(extrude(plate(W, L, 0.03, holes.map(([x, z]) => [x - cx, -(z - cz), 0.0135])), SBC.t, 16))
  s.add('board', pcb, 'mid', { pos: [cx, SBC.y + SBC.t / 2, cz], rot: FLAT })

  // Standoffs under each hole, a screw head on top.
  const standoff = s.geo(cyl(0.02, SBC.y))
  const head = s.geo(cyl(0.018, 0.008))
  for (const [x, z] of holes) {
    s.add('board', standoff, 'metal', { pos: [x, SBC.y / 2, z] })
    s.add('board', head, 'metal', { pos: [x, SBC_TOP + 0.004, z] })
  }

  // SoC under a metal heat spreader, RAM beside it, a shielded radio can, a power IC.
  s.add('soc', s.geo(blockGeometry(0.15, 0.008, 0.15)), 'dark', { pos: [cx - 0.03, SBC_TOP + 0.004, 0.02] })
  s.add('soc', s.geo(blockGeometry(0.12, 0.005, 0.12)), 'metal', { pos: [cx - 0.03, SBC_TOP + 0.0105, 0.02] })
  s.add('ram', s.geo(blockGeometry(0.1, 0.01, 0.14)), 'dark', { pos: [cx - 0.03, SBC_TOP + 0.005, -0.17] })
  s.add('board', s.geo(blockGeometry(0.1, 0.012, 0.12)), 'metal', { pos: [SBC.x0 + 0.13, SBC_TOP + 0.006, 0.17] })
  s.add('board', s.geo(blockGeometry(0.05, 0.006, 0.05)), 'dark', { pos: [cx + 0.12, SBC_TOP + 0.003, 0.24] })

  // Back end: Ethernet and two stacked USB blocks, overhanging the edge a little.
  const backZ = SBC.z0 - 0.02
  const eth = { w: 0.16, h: 0.135, d: 0.21 }
  s.add('ethernet', s.geo(blockGeometry(eth.w, eth.h, eth.d)), 'metal', { pos: [SBC.x0 + 0.095, SBC_TOP + eth.h / 2, backZ + eth.d / 2] })
  const usb = s.geo(blockGeometry(0.13, 0.155, 0.175))
  for (const x of [SBC.x0 + 0.26, SBC.x0 + 0.42]) s.add('usb', usb, 'metal', { pos: [x, SBC_TOP + 0.0775, backZ + 0.0875] })

  // Left edge: USB-C power in and two micro-HDMI sockets.
  s.add('usbc', s.geo(blockGeometry(0.075, 0.032, 0.09)), 'metal', { pos: [SBC.x0 + 0.03, SBC_TOP + 0.016, 0.24] })
  const hdmi = s.geo(blockGeometry(0.07, 0.03, 0.065))
  for (const z of [0.07, -0.06]) s.add('hdmi', hdmi, 'metal', { pos: [SBC.x0 + 0.028, SBC_TOP + 0.015, z] })

  // Power and activity LEDs: two tiny SMD parts at the front corner.
  const smd = s.geo(blockGeometry(0.024, 0.01, 0.014))
  s.add('pwrLed', smd, 'light', { pos: [SBC.x0 + 0.08, SBC_TOP + 0.005, SBC.z1 - 0.03] })
  s.add('actLed', smd, 'light', { pos: [SBC.x0 + 0.08, SBC_TOP + 0.005, SBC.z1 - 0.055] })

  // 40-pin header: a black base strip and the pins as a merged row.
  const baseL = 20 * P + 0.004
  s.add('gpio', s.geo(blockGeometry(2 * P + 0.004, HEADER.baseH, baseL)), 'dark', {
    pos: [HEADER.x, SBC_TOP + HEADER.baseH / 2, HEADER.z1 - 9.5 * P],
  })
  const pin = s.geo(blockGeometry(0.0064, HEADER.pinH, 0.0064))
  for (let n = 1; n <= 40; n++) {
    if (WIRES.some(w => w.pin === n)) continue
    const [x, z] = headerPin(n)
    s.add('gpio', pin, 'metal', { pos: [x, SBC_TOP + HEADER.pinH / 2, z], edges: false })
  }
}

/** Where the SBC LEDs' light sits, for the glow layer. */
export const SBC_LEDS: [number, number, number][] = [
  [SBC.x0 + 0.08, SBC_TOP + 0.01, SBC.z1 - 0.03],
  [SBC.x0 + 0.08, SBC_TOP + 0.01, SBC.z1 - 0.055],
]

// ── The breadboard and the parts on it ────────────────────────────────────

function addBreadboard(s: PartSet) {
  const L = BB.x1 - BB.x0
  const D = BB.z1 - BB.z0
  const cx = (BB.x0 + BB.x1) / 2
  s.add('breadboard', s.geo(blockGeometry(L, BB.h, D)), 'light', { pos: [cx, BB.h / 2, (BB.z0 + BB.z1) / 2] })
  // Centre channel and the printed rail stripes (red = supply, ink = ground).
  const top = BB.h + 0.0006
  s.add('breadboard', s.geo(blockGeometry(L - 0.03, 0.0012, 0.03)), 'mid', { pos: [cx, top, BB_ZC] })
  const stripe = s.geo(blockGeometry(colX(61) - colX(1), 0.0012, 0.005))
  const sx = (colX(1) + colX(61)) / 2
  for (const side of [-1, 1]) {
    s.add('breadboard', stripe, 'red', { pos: [sx, top, BB_ZC + side * 9.75 * P], edges: false })
    s.add('breadboard', stripe, 'dark', { pos: [sx, top, BB_ZC + side * 7.25 * P], edges: false })
  }
}

/** The breadboard's holes: one instanced dark square per hole, one draw call. */
export function buildHoles(m: Materials) {
  const spots: [number, number][] = []
  for (let c = 0; c < COLS; c++) {
    for (const r of TERMINAL_ROWS) spots.push([colX(c), rowZ(r)])
    if (railHasHole(c)) for (const r of RAIL_ROWS) spots.push([colX(c), rowZ(r)])
  }
  const geo = new THREE.PlaneGeometry(0.0085, 0.0085).rotateX(-Math.PI / 2)
  const mesh = new THREE.InstancedMesh(geo, m.face.dark, spots.length)
  mesh.name = 'holes'
  const mtx = new THREE.Matrix4()
  spots.forEach(([x, z], i) => mesh.setMatrixAt(i, mtx.makeTranslation(x, BB.h + 0.0009, z)))
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
  return mesh
}

function addParts(s: PartSet) {
  // LEDs: rim, body and dome on two legs, anode and cathode one column apart.
  const rim = s.geo(cyl(LED.rimR, LED.rimH))
  const body = s.geo(cyl(LED.r, LED.bodyH))
  const dome = s.geo(new THREE.SphereGeometry(LED.r, 24, 6, 0, Math.PI * 2, 0, Math.PI / 2))
  const leg = s.geo(blockGeometry(0.005, LED.lift, 0.005))
  // Resistors bridge the channel in the anode column: beige body, three bands, bent legs.
  const resBody = s.geo(cyl(0.011, 0.045).rotateX(Math.PI / 2))
  const band = s.geo(cyl(0.0118, 0.004).rotateX(Math.PI / 2))
  const resY = BB.h + 0.03
  const lead = 0.004
  const across = s.geo(blockGeometry(lead, lead, 1.5 * P - 0.0225))
  const down = s.geo(blockGeometry(lead, resY - BB.h, lead))
  LED_COLS.forEach((c, k) => {
    const t = `led${k}` as Target
    const x = colX(c) + P / 2
    const z = rowZ('c')
    const y0 = BB.h + LED.lift
    for (const lx of [colX(c), colX(c + 1)]) s.add(t, leg, 'metal', { pos: [lx, BB.h + LED.lift / 2, z], edges: false })
    s.add(t, rim, 'light', { pos: [x, y0 + LED.rimH / 2, z] })
    s.add(t, body, 'light', { pos: [x, y0 + LED.rimH + LED.bodyH / 2, z] })
    s.add(t, dome, 'light', { pos: [x, y0 + LED.rimH + LED.bodyH, z] })

    const r = `res${k}` as Target
    const rx = colX(c)
    s.add(r, resBody, 'wood', { pos: [rx, resY, BB_ZC] })
    for (const dz of [-0.012, -0.004, 0.006]) s.add(r, band, 'dark', { pos: [rx, resY, BB_ZC + dz], edges: false })
    for (const side of [-1, 1]) {
      s.add(r, across, 'metal', { pos: [rx, resY, BB_ZC + side * (0.0225 + (1.5 * P - 0.0225) / 2)], edges: false })
      s.add(r, down, 'metal', { pos: [rx, (BB.h + resY) / 2, BB_ZC + side * 1.5 * P], edges: false })
    }
  })

  // Push button body (the cap is its own moving node).
  s.add('button', s.geo(blockGeometry(BUTTON.w, BUTTON.h, BUTTON.w)), 'dark', { pos: [BUTTON_X, BB.h + BUTTON.h / 2, BB_ZC] })
  const corner = s.geo(blockGeometry(0.018, 0.004, 0.018))
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      s.add('button', corner, 'metal', { pos: [BUTTON_X + dx * 0.043, BB.h + BUTTON.h + 0.002, BB_ZC + dz * 0.043] })
    }
  }

  // Piezo buzzer with its sound port.
  const [bx, by, bz] = BUZZER_POS
  s.add('buzzer', s.geo(cyl(BUZZER.r, BUZZER.h)), 'dark', { pos: [bx, by + BUZZER.h / 2, bz] })
  s.add('buzzer', s.geo(cyl(0.013, 0.003)), 'mid', { pos: [bx, by + BUZZER.h + 0.0015, bz] })
  const bleg = s.geo(blockGeometry(0.005, BUZZER.lift + 0.002, 0.005))
  for (const c of [BUZZER.c0, BUZZER.c1]) s.add('buzzer', bleg, 'metal', { pos: [colX(c), BB.h + BUZZER.lift / 2, bz], edges: false })
}

// ── Wiring ────────────────────────────────────────────────────────────────

function addWires(s: PartSet) {
  const female = s.geo(blockGeometry(FEMALE.w, FEMALE.h, FEMALE.w))
  const male = s.geo(blockGeometry(MALE.w, MALE.h, MALE.w))
  const up = new THREE.Vector3(0, 1, 0)
  WIRES.forEach((w) => {
    const [px, pz] = headerPin(w.pin)
    const fy = SBC_TOP + HEADER.baseH
    s.add('wires', female, 'dark', { pos: [px, fy + FEMALE.h / 2, pz] })
    const bx = colX(w.col)
    const bz = rowZ(w.row)
    s.add('wires', male, 'dark', { pos: [bx, BB.h + MALE.lift + MALE.h / 2, bz] })
    const a = new THREE.Vector3(px, fy + FEMALE.h, pz)
    const b = new THREE.Vector3(bx, BB.h + MALE.lift + MALE.h, bz)
    const span = Math.hypot(b.x - a.x, b.z - a.z)
    // Longer runs ride higher, so the bundle nests instead of crossing itself.
    const rise = 0.05 + 0.08 * span
    const a1 = a.clone().addScaledVector(up, rise)
    const b1 = b.clone().addScaledVector(up, rise + (a.y - b.y) * 0.5)
    const mid = a1.clone().lerp(b1, 0.5).addScaledVector(up, -0.03 - 0.025 * span)
    s.add('wires', s.geo(wireTube([a, a1, mid, b1, b], 0.05, WIRE_R)), w.mat, { edges: false })
  })

  // Short links lying flat on the board.
  for (const [c0, r0, c1, r1, mat] of LINKS) {
    const x0 = colX(c0)
    const z0 = rowZ(r0)
    const x1 = colX(c1)
    const z1 = rowZ(r1)
    const len = Math.hypot(x1 - x0, z1 - z0)
    const g = s.geo(blockGeometry(0.008, 0.007, len + 0.008))
    s.add('wires', g, mat, { pos: [(x0 + x1) / 2, BB.h + 0.0035, (z0 + z1) / 2], rot: [0, Math.atan2(x1 - x0, z1 - z0), 0], edges: false })
  }
}

// ── The servo (body; the horn and arm are their own node) ─────────────────

function addServo(s: PartSet) {
  const S = SERVO_BODY
  const w = S.x1 - S.x0
  const d = S.z1 - S.z0
  const cx = (S.x0 + S.x1) / 2
  const cz = (S.z0 + S.z1) / 2
  s.add('servo', s.geo(blockGeometry(w, S.h, d)), 'red', { pos: [cx, S.h / 2, cz] })
  const fw = w + 2 * S.flangeOver
  const holes: [number, number, number][] = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) holes.push([sx * (w / 2 + S.flangeOver * 0.5), sy * d * 0.27, 0.011])
  s.add('servo', s.geo(extrude(plate(fw, d, 0.012, holes), S.flangeT, 12)), 'red', { pos: [cx, S.flangeY, cz], rot: FLAT })
  // Raised gear cover around the output shaft, the splined shaft itself.
  s.add('servo', s.geo(cyl(0.055, 0.012)), 'red', { pos: [SHAFT[0], S.h + 0.006, SHAFT[1]] })
  s.add('servo', s.geo(cyl(0.035, 0.008)), 'red', { pos: [SHAFT[0] + 0.07, S.h + 0.004, SHAFT[1]] })
  s.add('servo', s.geo(cyl(0.02, 0.012)), 'metal', { pos: [SHAFT[0], S.h + 0.012, SHAFT[1]] })

  // The lead: three wires out of the left end, into a 3-pin plug on the breadboard.
  const plugX = colX(SERVO_PLUG.c[1]!)
  const plugZ = rowZ(SERVO_PLUG.row)
  s.add('servo', s.geo(blockGeometry(3 * P + 0.004, SERVO_PLUG.h, 0.026)), 'dark', { pos: [plugX, BB.h + SERVO_PLUG.h / 2, plugZ] })
  const mats: MatKey[] = ['dark', 'red', 'mid']
  mats.forEach((mat, k) => {
    const off = (k - 1) * WIRE_R * 2.1
    const e = new THREE.Vector3(S.x0, 0.035, cz + off)
    const top = new THREE.Vector3(colX(SERVO_PLUG.c[k]!), BB.h + SERVO_PLUG.h, plugZ)
    const pts = [
      e,
      new THREE.Vector3(S.x0 - 0.07, 0.035, cz + off),
      new THREE.Vector3(S.x0 - 0.17, 0.2, (cz + plugZ) / 2 + off),
      top.clone().add(new THREE.Vector3(0, 0.08, 0)),
      top,
    ]
    s.add('servo', s.geo(wireTube(pts, 0.05, WIRE_R)), mat, { edges: false })
  })
}

/** Every static electronics part, in the layout's decimetres (the caller sets the frame). */
export function addElectronics(s: PartSet) {
  addSbc(s)
  addBreadboard(s)
  addParts(s)
  addWires(s)
  addServo(s)
}

/** The button's cap, on its own node so it can travel. Node origin = cap at rest. */
export function buildButtonCap(m: Materials) {
  const s = new PartSet()
  s.add('button', s.geo(cyl(BUTTON.capR, BUTTON.capH)), 'mid', { pos: [0, BUTTON.capH / 2, 0] })
  const { group, picks } = s.build(m, 'buttonCap')
  const node = new THREE.Group()
  node.name = 'buttonCap'
  node.add(group)
  node.position.set(BUTTON_X, BB.h + BUTTON.h - 0.004, BB_ZC)
  return { node, picks }
}

/**
 * The servo horn and the pointer arm, on a node at the output shaft that
 * turns about y. Built along local +x (0 deg). The arm is a slotted kit beam
 * screwed to the horn at two holes. Plain beam white: on the workbench the
 * soldering mat carries the scene's one beam-blue accent.
 */
export function buildArm(m: Materials) {
  const s = new PartSet()
  const hornL = 0.24
  // Horn holes at -0.09, -0.045, +0.045 and +0.09 from the shaft; the arm screws into the outer pair's +x hole.
  const horn = s.geo(beamGeometry({ length: hornL, width: 0.05, thickness: 0.022, holes: [0.03, 0.075, 0.165, 0.21], holeR: 0.006 }))
  s.add('servo', horn, 'light', { pos: [-hornL / 2, HORN_Y, 0], rot: FLAT })
  s.add('servo', s.geo(cyl(0.03, 0.026)), 'light', { pos: [0, HORN_Y + 0.002, 0] })
  const arm = s.geo(beamGeometry({ length: ARM.len, width: ARM.w, thickness: ARM.t, holes: [0, 0.09, ARM.len], slots: [[0.17, ARM.len - 0.1]] }))
  s.add('servo', arm, 'light', { pos: [0, ARM.y, 0], rot: FLAT })
  const screw = s.geo(cyl(0.012, 0.014))
  s.add('servo', screw, 'metal', { pos: [0, ARM.y + ARM.t / 2 + 0.005, 0] })
  s.add('servo', s.geo(cyl(0.009, 0.012)), 'metal', { pos: [0.09, ARM.y + ARM.t / 2 + 0.004, 0] })
  const { group, picks } = s.build(m, 'arm')
  const node = new THREE.Group()
  node.name = 'arm'
  node.add(group)
  node.position.set(SHAFT[0], 0, SHAFT[1])
  return { node, picks }
}

// ── Light: LED dots and glows, the buzzer's chirp marks ───────────────────

function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export interface Light { pos: [number, number, number], colour: string, dot: number, glow: number, lift: number }

/**
 * Indicator light as two instanced layers (two draw calls for every LED on
 * the bench): a small solid dot on the lens facing the camera, and a soft
 * glow quad turned to face the (fixed-orientation) camera. An LED that is off
 * shows neither, so colour appears only while it is lit.
 */
export function buildLights(lights: Light[], camera: THREE.Camera) {
  const toCam = new THREE.Vector3()
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), dotMat, lights.length)
  const tex = glowTexture()
  const glowMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.6 })
  const glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, lights.length)
  dots.name = 'ledDots'
  glows.name = 'ledGlows'
  glows.renderOrder = 2
  dots.frustumCulled = glows.frustumCulled = false
  const c = new THREE.Color()
  lights.forEach((l, i) => {
    c.set(l.colour)
    dots.setColorAt(i, c)
    glows.setColorAt(i, c)
  })
  const mtx = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const ident = new THREE.Quaternion()
  function update(levels: ArrayLike<number>) {
    toCam.set(0, 0, 1).applyQuaternion(camera.quaternion)
    lights.forEach((l, i) => {
      const v = Math.max(0, Math.min(1, levels[i]!))
      p.set(...l.pos).addScaledVector(toCam, l.lift)
      s.setScalar(v > 0.01 ? l.dot * (0.6 + 0.4 * v) : 0)
      dots.setMatrixAt(i, mtx.compose(p, ident, s))
      p.set(...l.pos).addScaledVector(toCam, l.lift + 0.05)
      s.set(l.glow * v, l.glow * v, 1)
      glows.setMatrixAt(i, mtx.compose(p, camera.quaternion, s))
    })
    dots.instanceMatrix.needsUpdate = true
    glows.instanceMatrix.needsUpdate = true
  }
  return {
    dots,
    glows,
    update,
    dispose() {
      dotMat.dispose()
      glowMat.dispose()
      tex.dispose()
      dots.dispose()
      glows.dispose()
    },
  }
}

/** Three short hairline ticks radiating above the buzzer while it chirps, drawn in the camera's plane. */
export function buildChirp(ink: string, camera: THREE.Camera) {
  const [bx, by, bz] = BUZZER_POS
  const o = new THREE.Vector3(bx, by + BUZZER.h, bz)
  const attr = new THREE.Float32BufferAttribute(new Float32Array(3 * 2 * 3), 3)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', attr)
  const mat = new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0 })
  const lines = new THREE.LineSegments(geo, mat)
  lines.name = 'chirp'
  lines.visible = false
  lines.frustumCulled = false
  const right = new THREE.Vector3()
  const upv = new THREE.Vector3()
  const d = new THREE.Vector3()
  const p = new THREE.Vector3()
  /** Lay the ticks in the camera's plane; call after the camera turns. */
  function orient() {
    right.set(1, 0, 0).applyQuaternion(camera.quaternion)
    upv.set(0, 1, 0).applyQuaternion(camera.quaternion)
    let k = 0
    for (const deg of [40, 90, 140]) {
      const a = (deg * Math.PI) / 180
      d.copy(right).multiplyScalar(Math.cos(a)).addScaledVector(upv, Math.sin(a))
      for (const r of [0.085, 0.13]) {
        p.copy(o).addScaledVector(d, r)
        attr.setXYZ(k++, p.x, p.y, p.z)
      }
    }
    attr.needsUpdate = true
  }
  orient()
  return {
    lines,
    orient,
    set(level: number) {
      lines.visible = level > 0.01
      mat.opacity = level
    },
    dispose() {
      mat.dispose()
      geo.dispose()
    },
  }
}
