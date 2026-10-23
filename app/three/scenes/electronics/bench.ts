import * as THREE from 'three'
import { beamGeometry, blockGeometry, discGeometry, extrude } from '../../core/kit'
import {
  BATTERIES, BENCH, DRILL, HH, HOLDER, HOLDER_AXIS, HOTAIR, LAMP, MAT, MAT_TOP, METER, PADS, PB, PB_N, PB_U, PB_V,
  PED, PLINTH, RACK, SAW, SEAT, SPOOL, STATION, TOP, workToWorld, type V3,
} from './bench-layout'
import { cyl, FLAT, plate, wireTube, type PartSet, type Target } from './build'
import { BB, rowZ, SBC, SBC_TOP } from './layout'

/**
 * The workbench itself, in metres: a butcher-block top on two steel
 * tool-chest pedestals with a knee well for the operator's stool, a
 * slotted-beam rack behind it carrying a shelf and a tool rail, and the tools
 * a maker keeps on it -- soldering station and iron holder, hot-air station,
 * helping hands, solder spool, magnifier lamp, multimeter, battery packs, a
 * drill press at one end and a mitre saw at the other.
 *
 * Everything here is static and goes into the scene's one PartSet. Parts that
 * repeat (drawer handles, battery packs, bins, screwdrivers, pins) build their
 * geometry once and only add transformed copies. Structure follows the
 * guidelines: straight slotted members with plain pins (rack, brackets, lamp
 * arms, drill-press column), opaque neutral faces, wood for the top, beam blue
 * only on the mat, red only where a tool takes its drive (the drill press
 * switch, the saw's trigger).
 */

type Geo = THREE.BufferGeometry
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2])

/** Shared-geometry factories for one PartSet: one geometry per distinct size. */
function factory(s: PartSet) {
  const cache = new Map<string, Geo>()
  const get = (key: string, make: () => Geo) => {
    let g = cache.get(key)
    if (!g) cache.set(key, g = s.geo(make()))
    return g
  }
  return {
    box: (w: number, h: number, d: number) => get(`b${w},${h},${d}`, () => blockGeometry(w, h, d)),
    cyl: (r: number, h: number, seg = 24) => get(`c${r},${h},${seg}`, () => (seg === 24 ? cyl(r, h) : new THREE.CylinderGeometry(r, r, h, seg))),
    disc: (r: number, t: number) => get(`d${r},${t}`, () => discGeometry(r, t, [], 32)),
    get,
  }
}

/**
 * Placement for a member from a to b: local +x along a->b (beam kit
 * convention, origin at a), local z = `face` made square to it (the side the
 * flat face looks toward).
 */
function along(a: V3, b: V3, face: V3): THREE.Matrix4 {
  const x = v(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize()
  const z = v3(face)
  z.addScaledVector(x, -z.dot(x))
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(x, -x.z)
  z.normalize()
  const y = new THREE.Vector3().crossVectors(z, x)
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(a[0], a[1], a[2])
}

/** A round rod (cylinder) from a to b. */
function rodAt(a: V3, b: V3): THREE.Matrix4 {
  const d = v(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  const len = d.length()
  const y = d.clone().normalize()
  const x = Math.abs(y.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(y).normalize() : new THREE.Vector3(1, 0, 0)
  const z = new THREE.Vector3().crossVectors(x, y)
  return new THREE.Matrix4().makeBasis(x, y, z).scale(v(1, len, 1)).setPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
}

/** A slotted kit beam from a to b, pins at both ends, a slot between. */
function slotted(s: PartSet, t: Target, a: V3, b: V3, face: V3, w: number, th: number, mat: 'light' | 'mid' | 'dark' = 'light') {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  const slot = len > 6 * w ? [[1.6 * w, len - 1.6 * w]] as [number, number][] : []
  const g = s.geo(beamGeometry({ length: len, width: w, thickness: th, holes: [0, len], slots: slot }))
  s.add(t, g, mat, { matrix: along(a, b, face) })
}

// ── Bench: top, tool chest, stool ─────────────────────────────────────────

function addBench(s: PartSet) {
  const f = factory(s)
  const L = BENCH.x1 - BENCH.x0
  const D = BENCH.z1 - BENCH.z0
  // The top is one block (its outline is the drawing); the staves are faint seams (seams()).
  s.add('benchTop', f.box(L, BENCH.t, D), 'wood', { pos: [(BENCH.x0 + BENCH.x1) / 2, TOP - BENCH.t / 2, (BENCH.z0 + BENCH.z1) / 2] })

  // Pedestals: carcass, recessed plinth, proud drawer fronts with bar handles and label cards.
  const H = PED.top - PLINTH
  const dz = PED.z1 - PED.z0
  for (const p of [PED.left, PED.right]) {
    const w = p.x1 - p.x0
    const cx = (p.x0 + p.x1) / 2
    s.add('toolChest', f.box(w, H, dz), 'dark', { pos: [cx, PLINTH + H / 2, (PED.z0 + PED.z1) / 2] })
    s.add('toolChest', f.box(w - 0.06, PLINTH, dz - 0.04), 'dark', { pos: [cx, PLINTH / 2, (PED.z0 + PED.z1) / 2 - 0.01] })
    const fw = w - 0.03
    const handle = f.box(fw * 0.62, 0.012, 0.012)
    const post = f.box(0.012, 0.012, 0.018)
    const card = f.box(0.07, 0.022, 0.003)
    let y = PED.top - 0.012
    for (const frac of p.drawers) {
      const h = frac * (H - 0.03)
      const fy = y - h / 2
      s.add('toolChest', f.box(fw, h - 0.008, 0.012), 'dark', { pos: [cx, fy, PED.z1 + 0.006] })
      const hy = y - Math.min(0.03, h * 0.3)
      s.add('toolChest', handle, 'metal', { pos: [cx, hy, PED.z1 + 0.03] })
      for (const sx of [-1, 1]) s.add('toolChest', post, 'metal', { pos: [cx + sx * fw * 0.29, hy, PED.z1 + 0.018], edges: false })
      if (h < 0.2) s.add('toolChest', card, 'light', { pos: [cx - fw * 0.38, hy, PED.z1 + 0.0135] })
      y -= h
    }
    // Lift handles on the outer side.
    const side = p === PED.left ? p.x0 - 0.012 : p.x1 + 0.012
    s.add('toolChest', f.box(0.012, 0.012, dz * 0.4), 'metal', { pos: [side, PED.top - 0.08, (PED.z0 + PED.z1) / 2] })
  }
  // Knee-well back panel between the pedestals.
  s.add('toolChest', f.box(PED.right.x0 - PED.left.x1, 0.36, 0.015), 'dark', { pos: [(PED.right.x0 + PED.left.x1) / 2, PED.top - 0.18, PED.z0 + 0.02] })
}

function addStool(s: PartSet) {
  const f = factory(s)
  const top = SEAT.top
  s.add('stool', f.disc(SEAT.r, SEAT.t), 'wood', { pos: [SEAT.x, top - SEAT.t / 2, SEAT.z], rot: FLAT })
  s.add('stool', f.box(0.2, 0.025, 0.2), 'dark', { pos: [SEAT.x, top - SEAT.t - 0.0125, SEAT.z] })
  // Four splayed straight legs and a square footrest ring between them.
  const legTop: V3[] = []
  const legFoot: V3[] = []
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2
    const c = Math.cos(a)
    const sn = Math.sin(a)
    legTop.push([SEAT.x + c * SEAT.legTop, top - SEAT.t - 0.02, SEAT.z + sn * SEAT.legTop])
    legFoot.push([SEAT.x + c * SEAT.spread, 0, SEAT.z + sn * SEAT.spread])
  }
  const leg = f.box(0.028, 1, 0.028)
  legTop.forEach((a, k) => {
    s.add('stool', leg, 'dark', { matrix: rodAt(legFoot[k]!, a) })
    s.add('stool', f.cyl(0.018, 0.012), 'dark', { pos: [legFoot[k]![0], 0.006, legFoot[k]![2]] })
  })
  const at = (k: number, y: number): V3 => {
    const a = legFoot[k]!
    const b = legTop[k]!
    const t = y / b[1]
    return [a[0] + (b[0] - a[0]) * t, y, a[2] + (b[2] - a[2]) * t]
  }
  const ring = f.cyl(0.009, 1)
  for (let k = 0; k < 4; k++) s.add('stool', ring, 'metal', { matrix: rodAt(at(k, SEAT.ring), at((k + 1) % 4, SEAT.ring)) })
}

// ── The mat and the job on it ─────────────────────────────────────────────

function addMat(s: PartSet) {
  const f = factory(s)
  s.add('mat', f.box(MAT.w, MAT.t, MAT.d), 'accent', { pos: [MAT.x, TOP + MAT.t / 2, MAT.z] })
}

function addHelpingHands(s: PartSet) {
  const f = factory(s)
  const y0 = MAT_TOP
  s.add('helpingHands', f.box(HH.baseW, HH.baseH, HH.baseD), 'dark', { pos: [HH.x, y0 + HH.baseH / 2, HH.z] })
  const post: V3 = [HH.x, y0 + HH.baseH, HH.z - 0.015]
  const top: V3 = [post[0], post[1] + HH.post, post[2]]
  s.add('helpingHands', f.cyl(0.006, 1), 'metal', { matrix: rodAt(post, top) })
  s.add('helpingHands', f.cyl(0.011, 0.016), 'metal', { pos: top })
  // Two jointed arms to alligator clips on the board's side edges.
  const rod = f.cyl(0.0035, 1)
  const knuckle = f.cyl(0.007, 0.012)
  const clip = f.box(0.026, 0.008, 0.01)
  for (const side of [-1, 1]) {
    const edge: V3 = [PB.x + PB_U[0] * side * (PB.w / 2 + 0.011), PB.y, PB.z]
    const elbow: V3 = [HH.x + side * 0.075, top[1] + 0.01, (top[2] + edge[2]) / 2 - 0.01]
    s.add('helpingHands', rod, 'metal', { matrix: rodAt(top, elbow) })
    s.add('helpingHands', rod, 'metal', { matrix: rodAt(elbow, edge) })
    s.add('helpingHands', knuckle, 'metal', { pos: elbow })
    s.add('helpingHands', clip, 'dark', { matrix: along(edge, [edge[0] - side * 0.026, edge[1], edge[2]], PB_N).multiply(new THREE.Matrix4().makeTranslation(0.013, 0, 0)) })
  }
  // The perfboard, tilted toward the operator; parts on the far side, pads on the near one.
  const rot: [number, number, number] = [PB.tilt, 0, 0]
  s.add('perfboard', f.box(PB.w, PB.t, PB.h), 'woodDark', { pos: [PB.x, PB.y, PB.z], rot })
  const pad = f.cyl(0.0014, 0.0006, 12)
  const toWorld = (a: number, b: number, n: number): V3 => [
    PB.x + PB_U[0] * a + PB_V[0] * b + PB_N[0] * n,
    PB.y + PB_U[1] * a + PB_V[1] * b + PB_N[1] * n,
    PB.z + PB_U[2] * a + PB_V[2] * b + PB_N[2] * n,
  ]
  for (const [a, b] of PADS) s.add('perfboard', pad, 'metal', { pos: toWorld(a, b, PB.t / 2 + 0.0003), rot, edges: false })
  // Parts behind: two resistors spanning pad pairs, a two-pin header.
  const res = f.box(0.011, 0.004, 0.004)
  s.add('perfboard', res, 'wood', { pos: toWorld((PADS[0]![0] + PADS[1]![0]) / 2, PADS[0]![1], -0.004), rot })
  s.add('perfboard', res, 'wood', { pos: toWorld((PADS[2]![0] + PADS[3]![0]) / 2, PADS[2]![1], -0.004), rot })
  s.add('perfboard', f.box(0.011, 0.008, 0.005), 'dark', { pos: toWorld((PADS[4]![0] + PADS[5]![0]) / 2, PADS[4]![1], -0.005), rot })
}

// ── Soldering: station, holder, spool, hot air ────────────────────────────

function addSoldering(s: PartSet) {
  const f = factory(s)
  // Station: a plain box with a display, a knob and its cable port.
  const st = STATION
  s.add('station', f.box(st.w, st.h, st.d), 'light', { pos: [st.x, TOP + st.h / 2, st.z] })
  const front = st.z + st.d / 2
  s.add('station', f.box(st.w * 0.62, st.h * 0.3, 0.004), 'dark', { pos: [st.x, TOP + st.h * 0.7, front + 0.002] })
  s.add('station', f.cyl(0.016, 0.014), 'mid', { pos: [st.x + st.w * 0.22, TOP + st.h * 0.3, front + 0.007], rot: [Math.PI / 2, 0, 0] })
  s.add('station', f.box(0.016, 0.01, 0.006), 'dark', { pos: [st.x - st.w * 0.3, TOP + st.h * 0.3, front + 0.003] })
  s.add('station', f.cyl(0.009, 0.012), 'dark', { pos: [st.port[0], st.port[1], front + 0.006], rot: [Math.PI / 2, 0, 0] })

  // Iron holder: a dish with a sponge and a brass-wool cup, a post, the coil along HOLDER_AXIS.
  const ax = v3(HOLDER_AXIS)
  const tip = v3(HOLDER.tip)
  const mid = tip.clone().addScaledVector(ax, (HOLDER.coil0 + HOLDER.coil1) / 2)
  const baseC: V3 = [mid.x, TOP, mid.z - 0.01]
  s.add('holder', f.disc(0.05, 0.014), 'dark', { pos: [baseC[0], TOP + 0.007, baseC[2]], rot: FLAT })
  s.add('holder', f.box(0.045, 0.01, 0.035), 'wood', { pos: [baseC[0] - 0.012, TOP + 0.019, baseC[2] + 0.018] })
  s.add('holder', f.cyl(0.018, 0.026), 'metal', { pos: [baseC[0] + 0.024, TOP + 0.027, baseC[2] - 0.016] })
  const under: V3 = [mid.x, mid.y - HOLDER.coilR - 0.002, mid.z]
  s.add('holder', f.cyl(0.005, 1), 'dark', { matrix: rodAt([under[0], TOP + 0.014, under[2]], under) })
  // The coil: a helix about the axis (a spring may curve; the members around it do not).
  const n1 = new THREE.Vector3(0, 1, 0).cross(ax).normalize()
  const n2 = new THREE.Vector3().crossVectors(ax, n1)
  const turns = 6
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= turns * 16; i++) {
    const u = i / (turns * 16)
    const a = u * turns * Math.PI * 2
    const along_ = HOLDER.coil0 + (HOLDER.coil1 - HOLDER.coil0) * u
    // The coil flares toward its mouth so the iron slides in easily.
    const r = HOLDER.coilR * (0.75 + 0.35 * u)
    pts.push(tip.clone().addScaledVector(ax, along_).addScaledVector(n1, Math.cos(a) * r).addScaledVector(n2, Math.sin(a) * r))
  }
  const helix = new THREE.CatmullRomCurve3(pts)
  s.add('holder', s.geo(new THREE.TubeGeometry(helix, turns * 24, 0.0016, 5, false)), 'metal', { edges: false })

  // Hot-air rework station: a box, display, two knobs, the handpiece in its cradle.
  const h = HOTAIR
  s.add('hotAir', f.box(h.w, h.h, h.d), 'mid', { pos: [h.x, TOP + h.h / 2, h.z] })
  const hf = h.z + h.d / 2
  s.add('hotAir', f.box(h.w * 0.55, h.h * 0.26, 0.004), 'dark', { pos: [h.x - h.w * 0.1, TOP + h.h * 0.72, hf + 0.002] })
  for (const dx of [-0.035, 0.035]) s.add('hotAir', f.cyl(0.013, 0.012), 'light', { pos: [h.x + dx, TOP + h.h * 0.32, hf + 0.006], rot: [Math.PI / 2, 0, 0] })
  const cradle: V3 = [h.x + h.w / 2 + 0.03, TOP, h.z + 0.02]
  s.add('hotAir', f.box(0.05, 0.012, 0.06), 'dark', { pos: [cradle[0], TOP + 0.006, cradle[2]] })
  s.add('hotAir', f.box(0.006, 0.13, 0.03), 'dark', { pos: [cradle[0], TOP + 0.065, cradle[2] - 0.022] })
  s.add('hotAir', f.cyl(0.016, 0.15), 'dark', { pos: [cradle[0], TOP + 0.09, cradle[2]] })
  s.add('hotAir', s.geo(wireTube([
    v(cradle[0], TOP + 0.165, cradle[2]), v(cradle[0], TOP + 0.2, cradle[2] - 0.02),
    v(h.x + h.w / 2 - 0.02, TOP + 0.16, h.z + h.d / 2 - 0.01), v(h.x + h.w / 2 - 0.035, TOP + 0.05, h.z + h.d / 2 + 0.006),
  ], 0.03, 0.006)), 'dark', { edges: false })

  // Solder spool on a little stand.
  const sp = SPOOL
  s.add('spool', f.box(0.07, 0.01, 0.05), 'dark', { pos: [sp.x, TOP + 0.005, sp.z] })
  for (const dx of [-1, 1]) s.add('spool', f.box(0.004, sp.axleY - TOP, 0.012), 'metal', { pos: [sp.x + dx * 0.027, (sp.axleY + TOP) / 2 + 0.005, sp.z] })
  const side = s.geo(discGeometry(sp.r, 0.003, [{ x: 0, y: 0, r: 0.006 }], 32).rotateY(Math.PI / 2))
  for (const dx of [-1, 1]) s.add('spool', side, 'light', { pos: [sp.x + dx * sp.w / 2, sp.axleY, sp.z] })
  s.add('spool', s.geo(cyl(sp.r * 0.85, sp.w).rotateZ(Math.PI / 2)), 'metal', { pos: [sp.x, sp.axleY, sp.z] })
}

// ── Lamp, multimeter ──────────────────────────────────────────────────────

function addLamp(s: PartSet) {
  const f = factory(s)
  const L = LAMP
  // Clamp on the back edge, a short post, two slotted arms with pins, the ring head.
  s.add('lamp', f.box(0.05, 0.03, 0.06), 'dark', { pos: [L.base[0], TOP + 0.015, L.base[2]] })
  s.add('lamp', f.box(0.05, 0.08, 0.012), 'dark', { pos: [L.base[0], TOP - 0.03, BENCH.z0 - 0.006] })
  s.add('lamp', f.cyl(0.012, 1), 'dark', { matrix: rodAt([L.base[0], TOP + 0.03, L.base[2]], L.j0) })
  const hinge = (a: V3, b: V3): V3 => {
    const d = v(b[0] - a[0], 0, b[2] - a[2]).normalize()
    return [d.z, 0, -d.x]
  }
  slotted(s, 'lamp', L.j0, L.j1, hinge(L.j0, L.j1), 0.03, 0.012)
  slotted(s, 'lamp', L.j1, L.j2, hinge(L.j1, L.j2), 0.026, 0.012)
  const pin = f.cyl(0.007, 1)
  const hz = hinge(L.j0, L.j2)
  for (const j of [L.j0, L.j1, L.j2]) {
    s.add('lamp', pin, 'metal', { matrix: rodAt([j[0] - hz[0] * 0.016, j[1], j[2] - hz[2] * 0.016], [j[0] + hz[0] * 0.016, j[1], j[2] + hz[2] * 0.016]) })
  }
  // A balance spring beside the lower arm: a straight thin rod (drawn, not simulated).
  const off = (p: V3, k: number): V3 => [p[0] + 0.012 * k, p[1] + 0.025, p[2]]
  s.add('lamp', f.cyl(0.0025, 1), 'metal', { matrix: rodAt(off(L.j0, 1), off(L.j1, 1)) })
  // Neck to the head, then the ring (lamp) with its lens.
  s.add('lamp', f.cyl(0.006, 1), 'dark', { matrix: rodAt(L.j2, [L.head[0], L.head[1] + 0.02, L.head[2]]) })
  const ring = s.geo(discGeometry(L.headR, 0.025, [{ x: 0, y: 0, r: L.headR * 0.62 }], 40))
  s.add('lamp', ring, 'light', { pos: L.head, rot: FLAT })
  s.add('lamp', s.geo(discGeometry(L.headR * 0.62, 0.004, [], 40)), 'water', { pos: [L.head[0], L.head[1] - 0.004, L.head[2]], rot: FLAT })
  // Its cord down the arm and over the back edge.
  s.add('lamp', s.geo(wireTube([
    v(L.j1[0], L.j1[1] - 0.02, L.j1[2] - 0.01), v(L.j0[0] - 0.02, L.j0[1] + 0.05, L.j0[2] - 0.02),
    v(L.base[0] - 0.03, TOP + 0.005, BENCH.z0 + 0.01), v(L.base[0] - 0.04, TOP - 0.02, BENCH.z0 - 0.01),
    v(L.base[0] - 0.05, TOP - 0.4, BENCH.z0 - 0.02),
  ], 0.04, 0.003)), 'dark', { edges: false })
}

/** The multimeter's local frame: on the bench, leaning back on its stand. */
export function meterFrame(): THREE.Matrix4 {
  return new THREE.Matrix4().compose(v(METER.x, TOP, METER.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-METER.lean, METER.yaw, 0, 'YXZ')), v(1, 1, 1))
}
/** Knob centre in the meter's frame (the body stands on its bottom edge, face toward +z). */
export const METER_KNOB: V3 = [0, 0.075, METER.d / 2]
export const METER_DISPLAY: V3 = [0, 0.135, METER.d / 2 + 0.0015]

function addMeter(s: PartSet) {
  const f = factory(s)
  const M = meterFrame()
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z).premultiply(M)
  s.add('multimeter', f.box(METER.w, METER.h, METER.d), 'dark', { matrix: at(0, METER.h / 2, 0) })
  s.add('multimeter', f.box(METER.w * 0.86, METER.h * 0.9, 0.004), 'mid', { matrix: at(0, METER.h / 2, METER.d / 2) })
  s.add('multimeter', f.box(0.068, 0.034, 0.004), 'light', { matrix: at(METER_DISPLAY[0], METER_DISPLAY[1], METER.d / 2 + 0.0005) })
  s.add('multimeter', f.cyl(0.028, 0.004), 'dark', { matrix: at(METER_KNOB[0], METER_KNOB[1], METER.d / 2 + 0.002).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)) })
  const jack = f.cyl(0.0055, 0.006)
  for (const x of [-0.026, 0, 0.026]) s.add('multimeter', jack, 'dark', { matrix: at(x, 0.022, METER.d / 2 + 0.003).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)) })
  // The kickstand behind.
  s.add('multimeter', f.box(METER.w * 0.7, METER.h * 0.6, 0.004), 'dark', { matrix: new THREE.Matrix4().compose(v(METER.x - 0.02, TOP + 0.05, METER.z - 0.06), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.55, METER.yaw, 0, 'YXZ')), v(1, 1, 1)) })
  // Leads: + (red, supply side) and COM, clipped to the breadboard's front rails.
  const jackW = (x: number) => new THREE.Vector3(x, 0.022, METER.d / 2 + 0.006).applyMatrix4(M)
  const clipAt = (row: 'vccF' | 'gndF') => v3(workToWorld(BB.x0 - 0.05, BB.h * 0.6, rowZ(row)))
  const clip = f.box(0.016, 0.006, 0.006)
  for (const [x, row, mat] of [[0.026, 'vccF', 'red'], [0, 'gndF', 'dark']] as const) {
    const a = jackW(x)
    const b = clipAt(row)
    const pts = [
      a, a.clone().add(v(0, -0.01, 0.03)), v(a.x + 0.06, TOP + 0.005, a.z + 0.05 + x),
      v(-0.24, MAT_TOP + 0.004, 0.01 + x * 0.3), v(-0.04, MAT_TOP + 0.004, 0.006 + x * 0.3), v(b.x - 0.025, MAT_TOP + 0.004, b.z + 0.004), v(b.x - 0.012, b.y, b.z),
    ]
    s.add('multimeter', s.geo(wireTube(pts, 0.03, 0.0022)), mat, { edges: false })
    s.add('multimeter', clip, 'dark', { pos: [b.x - 0.006, b.y, b.z] })
  }
}

// ── Drill press and mitre saw (the static parts) ──────────────────────────

function addDrill(s: PartSet) {
  const f = factory(s)
  const d = DRILL
  s.add('drillPress', f.box(d.base.w, d.base.h, d.base.d), 'dark', { pos: [d.x, TOP + d.base.h / 2, d.z] })
  // Column: a slotted straight member standing on the base's back end.
  const c0: V3 = [d.x, TOP + d.base.h, d.columnZ]
  const c1: V3 = [d.x, TOP + d.columnH, d.columnZ]
  slotted(s, 'drillPress', c0, c1, [0, 0, 1], 0.05, 0.036, 'mid')
  s.add('drillPress', f.box(0.07, 0.03, 0.05), 'dark', { pos: [d.x, TOP + d.base.h + 0.015, d.columnZ] })
  // Table on a bracket, and the work clamped on it.
  s.add('drillPress', f.box(0.16, 0.012, 0.16), 'mid', { pos: [d.x, d.table - 0.006, d.sz] })
  s.add('drillPress', f.box(0.05, 0.035, d.sz - d.columnZ), 'dark', { pos: [d.x, d.table - 0.03, (d.sz + d.columnZ) / 2] })
  s.add('drillPress', f.box(d.work.w, d.work.h, d.work.d), 'wood', { pos: [d.x, d.table + d.work.h / 2, d.sz] })
  // Head housing, motor behind the column, belt cover over both.
  const hz0 = d.columnZ - 0.04
  const hz1 = d.sz + 0.07
  s.add('drillPress', f.box(0.15, d.headY1 - d.headY0, hz1 - hz0), 'light', { pos: [d.x, (d.headY0 + d.headY1) / 2, (hz0 + hz1) / 2] })
  const mz = d.columnZ - 0.1
  s.add('drillPress', f.cyl(0.05, 0.13), 'mid', { pos: [d.x, d.headY1 - 0.05, mz] })
  s.add('drillPress', f.box(0.13, 0.045, hz1 - mz + 0.05), 'light', { pos: [d.x, d.headY1 + 0.0225, (mz - 0.05 + hz1) / 2] })
  // Spindle nose collar, the red switch on the head's front.
  s.add('drillPress', f.cyl(0.022, d.headY0 - d.nose), 'metal', { pos: [d.x, (d.headY0 + d.nose) / 2, d.sz] })
  s.add('drillPress', f.box(0.03, 0.02, 0.012), 'red', { pos: [d.x - 0.035, (d.headY0 + d.headY1) / 2, hz1 + 0.006] })
  // Hub boss on the right side for the feed handle.
  s.add('drillPress', f.cyl(0.02, 0.012), 'metal', { pos: [d.hub[0] - 0.006, d.hub[1], d.hub[2]], rot: [0, 0, Math.PI / 2] })
}

function addSaw(s: PartSet) {
  const f = factory(s)
  const w = SAW
  s.add('mitreSaw', f.box(w.base.w, w.base.h * 0.6, w.base.d), 'dark', { pos: [w.x, TOP + w.base.h * 0.3, w.z] })
  s.add('mitreSaw', f.disc(w.tableR, w.base.h * 0.4), 'metal', { pos: [w.x, TOP + w.base.h * 0.8, w.z + 0.03], rot: FLAT })
  s.add('mitreSaw', f.box(0.008, 0.002, w.tableR * 2 - 0.02), 'dark', { pos: [w.x, TOP + w.base.h + 0.001, w.z + 0.03], edges: false })
  s.add('mitreSaw', f.box(0.05, 0.02, 0.07), 'mid', { pos: [w.x, TOP + w.base.h * 0.5, w.z + w.base.d / 2 + 0.03] })
  // Fence either side of the blade's path.
  const fence = f.box(0.17, 0.07, 0.012)
  for (const sx of [-1, 1]) s.add('mitreSaw', fence, 'metal', { pos: [w.x + sx * (0.025 + 0.085), TOP + w.base.h + 0.035, w.fenceZ - 0.006] })
  // Pivot post at the back.
  const py = w.pivot[1]
  s.add('mitreSaw', f.box(0.07, py - TOP - w.base.h + 0.02, 0.05), 'mid', { pos: [w.x, (py + TOP + w.base.h) / 2, w.pivot[2] - 0.01] })
  s.add('mitreSaw', f.cyl(0.02, 0.09), 'metal', { pos: w.pivot, rot: [0, 0, Math.PI / 2] })
  // The work: a strip against the fence, across the blade's path.
  s.add('mitreSaw', f.box(w.work.len, w.work.h, w.work.w), 'wood', { pos: [w.x + 0.04, TOP + w.base.h + w.work.h / 2, w.fenceZ + w.work.w / 2] })
}

// ── Back of the bench: batteries, rack, shelf, rail and tools ─────────────

function addBatteries(s: PartSet) {
  const f = factory(s)
  const body = f.box(0.075, 0.045, 0.115)
  const rail = f.box(0.05, 0.026, 0.085)
  const latch = f.box(0.03, 0.008, 0.012)
  const pack = (t: Target, x: number, y: number, z: number) => {
    s.add(t, body, 'dark', { pos: [x, y + 0.0225, z] })
    s.add(t, rail, 'mid', { pos: [x, y + 0.058, z - 0.012] })
    s.add(t, latch, 'light', { pos: [x, y + 0.049, z + 0.045] })
  }
  for (let i = 0; i < BATTERIES.n; i++) pack('batteries', BATTERIES.x0 + i * BATTERIES.dx, TOP, BATTERIES.z)
  const [cx, cz] = BATTERIES.charger
  s.add('charger', f.box(0.1, 0.045, 0.15), 'mid', { pos: [cx, TOP + 0.0225, cz] })
  s.add('charger', f.box(0.012, 0.006, 0.006), 'light', { pos: [cx + 0.03, TOP + 0.045, cz + 0.07] })
  pack('batteries', cx, TOP + 0.045, cz - 0.01)
  s.add('charger', s.geo(wireTube([v(cx, TOP + 0.02, cz - 0.075), v(cx + 0.02, TOP + 0.005, cz - 0.1), v(cx + 0.05, TOP + 0.004, BENCH.z0 + 0.02), v(cx + 0.06, TOP - 0.02, BENCH.z0 - 0.01), v(cx + 0.06, TOP - 0.45, BENCH.z0 - 0.02)], 0.04, 0.003)), 'dark', { edges: false })
}

function addRack(s: PartSet) {
  const f = factory(s)
  const R = RACK
  // Uprights on the back face of the top, slotted face toward the room.
  for (const x of R.xs) {
    slotted(s, 'shelf', [x, R.y0, R.z], [x, R.y1, R.z], [0, 0, 1], R.w, R.t)
    for (const y of [TOP - 0.06, TOP - 0.02]) s.add('shelf', f.cyl(0.008, 0.03), 'metal', { pos: [x, y, R.z + 0.012], rot: [Math.PI / 2, 0, 0] })
    // Bracket under the shelf, its slotted face to the side.
    const by = R.shelfY - 0.012 - R.w / 2
    slotted(s, 'shelf', [x, by, R.z + 0.01], [x, by, R.shelfZ1 - 0.02], [1, 0, 0], R.w * 0.8, R.t)
    s.add('shelf', f.cyl(0.008, 0.03), 'metal', { pos: [x, by, R.z], rot: [Math.PI / 2, 0, 0] })
  }
  s.add('shelf', f.box(R.shelfX1 - R.shelfX0, 0.025, R.shelfZ1 - R.shelfZ0), 'wood', { pos: [(R.shelfX0 + R.shelfX1) / 2, R.shelfY - 0.0125, (R.shelfZ0 + R.shelfZ1) / 2] })
  // Tool rail across the uprights, with pins for hooks.
  slotted(s, 'shelf', [R.xs[0]! - 0.06, R.railY, R.z + R.t], [R.xs[2]! + 0.06, R.railY, R.z + R.t], [0, 0, 1], R.w, R.t)
  for (const x of R.xs) s.add('shelf', f.cyl(0.008, 0.05), 'metal', { pos: [x, R.railY, R.z + 0.012], rot: [Math.PI / 2, 0, 0] })
}

function addShelfStuff(s: PartSet) {
  const f = factory(s)
  const y = RACK.shelfY
  const zc = (RACK.shelfZ0 + RACK.shelfZ1) / 2
  // Storage boxes, left.
  s.add('boxes', f.box(0.26, 0.15, 0.22), 'light', { pos: [-1.3, y + 0.075, zc] })
  s.add('boxes', f.box(0.26, 0.004, 0.225), 'mid', { pos: [-1.3, y + 0.151, zc] })
  s.add('boxes', f.box(0.22, 0.17, 0.21), 'woodDark', { pos: [-1.03, y + 0.085, zc - 0.005] })
  s.add('boxes', f.box(0.18, 0.1, 0.2), 'mid', { pos: [-0.8, y + 0.05, zc] })
  s.add('boxes', f.box(0.14, 0.06, 0.15), 'light', { pos: [-0.8, y + 0.13, zc + 0.01] })
  // Spray cans.
  const can = f.cyl(0.032, 0.19)
  const cap = f.cyl(0.028, 0.04)
  const nozzle = f.box(0.012, 0.012, 0.012)
  for (const [i, x] of [-0.6, -0.52, -0.44].entries()) {
    s.add('sprays', can, i === 1 ? 'light' : 'metal', { pos: [x, y + 0.095, zc + 0.02 - i * 0.015] })
    s.add('sprays', cap, i === 2 ? 'light' : 'dark', { pos: [x, y + 0.21, zc + 0.02 - i * 0.015] })
    s.add('sprays', nozzle, 'dark', { pos: [x, y + 0.236, zc + 0.03 - i * 0.015], edges: false })
  }
  // Parts bins: open-fronted stacking bins, two rows, a little stock in each.
  const prof = new THREE.Shape()
  const D = 0.2
  const H = 0.075
  prof.moveTo(0, 0)
  prof.lineTo(D, 0)
  prof.lineTo(D, H)
  prof.lineTo(D * 0.42, H)
  prof.lineTo(0, H * 0.45)
  prof.closePath()
  const bin = f.get('bin', () => {
    const g = extrude(prof, 0.1, 4)
    g.rotateY(Math.PI / 2)
    return g
  })
  const stock = f.box(0.07, 0.02, 0.06)
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 6; i++) {
      const x = 0.3 + i * 0.105
      const by = y + row * (H + 0.003)
      // Turned, the profile runs from z = 0 (the low open front) back to -D.
      s.add('bins', bin, 'light', { pos: [x, by, RACK.shelfZ1 - 0.01] })
      s.add('bins', stock, i % 3 === 1 ? 'dark' : i % 3 === 2 ? 'metal' : 'mid', { pos: [x, by + 0.012, RACK.shelfZ1 - 0.09], edges: false })
    }
  }
  s.add('boxes', f.box(0.2, 0.12, 0.2), 'woodDark', { pos: [1.15, y + 0.06, zc] })
  s.add('boxes', f.box(0.12, 0.05, 0.16), 'light', { pos: [1.33, y + 0.025, zc] })
}

function addHandTools(s: PartSet) {
  const f = factory(s)
  const R = RACK
  const z = R.z + R.t * 1.5 + 0.012
  const hook = f.cyl(0.003, 0.03)
  const hookAt = (x: number) => s.add('handTools', hook, 'metal', { pos: [x, R.railY - 0.012, R.z + R.t + 0.015], rot: [Math.PI / 2, 0, 0], edges: false })
  // Pliers and cutters: jaws at the top, two straight handles opening downward.
  const plier = (x: number, len: number, mat: 'dark' | 'mid') => {
    hookAt(x)
    const top = R.railY - 0.03
    s.add('handTools', f.box(0.016, 0.035, 0.008), 'metal', { pos: [x, top - 0.0175, z] })
    const handle = f.box(0.012, len, 0.008)
    for (const sx of [-1, 1]) s.add('handTools', handle, mat, { pos: [x + sx * 0.012, top - 0.035 - len / 2, z], rot: [0, 0, sx * 0.14] })
  }
  plier(-1.0, 0.12, 'dark')
  plier(-0.9, 0.1, 'mid')
  plier(0.45, 0.11, 'dark')
  // Screwdrivers in a strip.
  s.add('handTools', f.box(0.16, 0.012, 0.03), 'dark', { pos: [-0.72, R.railY - 0.02, z + 0.004] })
  const grip = f.cyl(0.011, 0.07)
  for (const [k, len] of [0.1, 0.13, 0.08, 0.11].entries()) {
    const x = -0.78 + k * 0.04
    s.add('handTools', grip, k % 2 ? 'mid' : 'dark', { pos: [x, R.railY + 0.02, z + 0.004] })
    s.add('handTools', f.cyl(0.0025, len, 12), 'metal', { pos: [x, R.railY - 0.026 - len / 2, z + 0.004], edges: false })
  }
  // Tweezers, a hank of hook-up wire on its hook, a tape measure, a small hammer.
  hookAt(0.6)
  for (const sx of [-1, 1]) s.add('handTools', f.box(0.004, 0.11, 0.003), 'metal', { pos: [0.6 + sx * 0.005, R.railY - 0.085, z], rot: [0, 0, sx * 0.05] })
  hookAt(0.75)
  s.add('handTools', s.geo(discGeometry(0.05, 0.014, [{ x: 0, y: 0, r: 0.032 }], 32)), 'mid', { pos: [0.75, R.railY - 0.07, z] })
  hookAt(0.92)
  s.add('handTools', f.box(0.06, 0.06, 0.03), 'dark', { pos: [0.92, R.railY - 0.06, z] })
  hookAt(1.1)
  s.add('handTools', f.box(0.016, 0.2, 0.012), 'wood', { pos: [1.1, R.railY - 0.13, z] })
  s.add('handTools', f.box(0.08, 0.022, 0.022), 'metal', { pos: [1.1, R.railY - 0.235, z] })
}

// ── Small things, cables ──────────────────────────────────────────────────

function addOddments(s: PartSet) {
  const f = factory(s)
  // Power strip along the back, the station and hot-air cords plugged in.
  const px = 0.62
  const pz = BENCH.z0 + 0.04
  s.add('powerStrip', f.box(0.34, 0.035, 0.055), 'light', { pos: [px, TOP + 0.0175, pz] })
  const sock = f.box(0.03, 0.004, 0.03)
  for (let i = 0; i < 5; i++) s.add('powerStrip', sock, 'dark', { pos: [px - 0.12 + i * 0.055, TOP + 0.036, pz], edges: false })
  const plug = (x: number, from: THREE.Vector3) => {
    s.add('powerStrip', f.box(0.03, 0.025, 0.035), 'dark', { pos: [x, TOP + 0.048, pz] })
    s.add('powerStrip', s.geo(wireTube([from, v(from.x, TOP + 0.006, from.z - 0.03), v(x, TOP + 0.006, pz + 0.05), v(x, TOP + 0.05, pz + 0.018)], 0.03, 0.0035)), 'dark', { edges: false })
  }
  plug(px - 0.12, v(STATION.x - 0.03, TOP + 0.02, STATION.z - STATION.d / 2))
  plug(px - 0.065, v(HOTAIR.x - 0.04, TOP + 0.02, HOTAIR.z - HOTAIR.d / 2))
  s.add('powerStrip', s.geo(wireTube([v(px + 0.17, TOP + 0.017, pz), v(px + 0.21, TOP + 0.006, pz), v(px + 0.25, TOP + 0.006, BENCH.z0 + 0.01), v(px + 0.26, TOP - 0.03, BENCH.z0 - 0.01), v(px + 0.26, PLINTH, BENCH.z0 - 0.02)], 0.04, 0.004)), 'dark', { edges: false })

  // USB power supply for the board, its cable to the USB-C socket.
  const ux = -0.24
  const uz = BENCH.z0 + 0.07
  s.add('usbPower', f.box(0.05, 0.03, 0.045), 'light', { pos: [ux, TOP + 0.015, uz] })
  const usbc = v3(workToWorld(SBC.x0 - 0.04, SBC_TOP + 0.016, 0.24))
  s.add('usbPower', s.geo(wireTube([
    usbc, v(usbc.x - 0.02, MAT_TOP + 0.003, usbc.z),
    v(usbc.x - 0.045, MAT_TOP + 0.003, usbc.z - 0.05), v(ux + 0.01, TOP + 0.003, uz + 0.06), v(ux, TOP + 0.012, uz + 0.023),
  ], 0.03, 0.0022)), 'dark', { edges: false })

  // A mug.
  const mx = 0.68
  const mz = 0.22
  s.add('mug', f.cyl(0.04, 0.095), 'light', { pos: [mx, TOP + 0.0475, mz] })
  s.add('mug', f.cyl(0.035, 0.002), 'woodDark', { pos: [mx, TOP + 0.085, mz], edges: false })
  s.add('mug', f.box(0.006, 0.05, 0.012), 'light', { pos: [mx + 0.062, TOP + 0.05, mz] })
  for (const dy of [-1, 1]) s.add('mug', f.box(0.024, 0.008, 0.012), 'light', { pos: [mx + 0.05, TOP + 0.05 + dy * 0.025, mz] })

  // Cords from the drill press and the saw over the bench's ends to the floor.
  s.add('drillPress', s.geo(wireTube([
    v(DRILL.x + 0.03, DRILL.headY1 - 0.06, DRILL.columnZ - 0.15), v(DRILL.x + 0.06, TOP + 0.006, DRILL.columnZ - 0.17),
    v(BENCH.x0 + 0.03, TOP + 0.006, -0.16), v(BENCH.x0 - 0.012, TOP - 0.02, -0.15), v(BENCH.x0 - 0.03, 0.3, -0.1),
    v(BENCH.x0 - 0.06, 0.006, 0.0), v(BENCH.x0 + 0.1, 0.006, 0.12),
  ], 0.06, 0.0045)), 'dark', { edges: false })
  s.add('mitreSaw', s.geo(wireTube([
    v(SAW.x + 0.06, SAW.pivot[1] - 0.03, SAW.pivot[2] - 0.03), v(SAW.x + 0.1, TOP + 0.006, SAW.pivot[2] - 0.1),
    v(BENCH.x1 - 0.03, TOP + 0.006, -0.28), v(BENCH.x1 + 0.012, TOP - 0.02, -0.28), v(BENCH.x1 + 0.03, 0.25, -0.22),
    v(BENCH.x1 + 0.05, 0.006, -0.1), v(BENCH.x1 - 0.05, 0.006, 0.05),
  ], 0.06, 0.0045)), 'dark', { edges: false })
}

/** Every static piece of the bench, in build order (the caller yields between groups). */
export const BENCH_PARTS: ((s: PartSet) => void)[] = [
  addBench, addStool, addMat, addHelpingHands, addSoldering, addLamp, addMeter, addDrill, addSaw, addBatteries,
  addRack, addShelfStuff, addHandTools, addOddments,
]

/** The butcher block's stave seams (plus any extra faint lines, e.g. floor joints): one LineSegments. */
export function seams(line: THREE.LineBasicMaterial, extra: number[] = []) {
  const pts: number[] = [...extra]
  const D = BENCH.z1 - BENCH.z0
  for (let i = 1; i < BENCH.staves; i++) {
    const z = BENCH.z0 + (D * i) / BENCH.staves
    pts.push(BENCH.x0, TOP + 0.0004, z, BENCH.x1, TOP + 0.0004, z)
    for (const x of [BENCH.x0 - 0.0004, BENCH.x1 + 0.0004]) pts.push(x, TOP, z, x, TOP - BENCH.t, z)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  const seg = new THREE.LineSegments(g, line)
  seg.name = 'seams'
  return seg
}

/** Contact shadows as one mesh: [x, y, z, size x, size z] quads with the blob texture. */
export function shadows(mat: THREE.Material) {
  const spots: [number, number, number, number, number][] = [
    [(PED.left.x0 + PED.left.x1) / 2, 0.0005, (PED.z0 + PED.z1) / 2, PED.left.x1 - PED.left.x0 + 0.5, 1.1],
    [(PED.right.x0 + PED.right.x1) / 2, 0.0005, (PED.z0 + PED.z1) / 2, PED.right.x1 - PED.right.x0 + 0.5, 1.1],
    [(PED.left.x1 + PED.right.x0) / 2, 0.0004, 0.0, 1.0, 0.9],
    [SEAT.x, 0.0006, SEAT.z, SEAT.spread * 2 + 0.3, SEAT.spread * 2 + 0.3],
    [DRILL.x, TOP + 0.0006, DRILL.z, 0.32, 0.42],
    [SAW.x, TOP + 0.0006, SAW.z, 0.5, 0.56],
    [STATION.x, TOP + 0.0006, STATION.z, 0.24, 0.26],
    [HOTAIR.x, TOP + 0.0006, HOTAIR.z, 0.26, 0.28],
    [METER.x, TOP + 0.0006, METER.z, 0.16, 0.16],
    [(BATTERIES.x0 + BATTERIES.charger[0]) / 2, TOP + 0.0006, BATTERIES.z, 0.6, 0.2],
  ]
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  spots.forEach(([x, y, z, sx, sz], i) => {
    for (const [u, w] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      pos.push(x + (u! - 0.5) * sx, y, z + (w! - 0.5) * sz)
      uv.push(u!, w!)
    }
    const k = i * 4
    idx.push(k, k + 2, k + 1, k, k + 3, k + 2)
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  const mesh = new THREE.Mesh(g, mat)
  mesh.name = 'shadows'
  mesh.renderOrder = -1
  return mesh
}
