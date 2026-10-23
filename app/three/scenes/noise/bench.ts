import * as THREE from 'three'
import { Assembly, beamGeometry, blockGeometry, contactShadow, pinGeometry, type Materials } from '../../core/kit'
import { SHELF_Y, TABLE, tableTop, type Place } from './layout'
import { AREA, PAPER } from './plotter'

/**
 * The bench the machine and the plotter stand on, with what a noise maker
 * leaves lying about: a stack of finished plots and a coiled patch cable.
 * Everything here is still, so it is ONE assembly (materials + 1 draw calls)
 * plus the top plot's ink line and a floor shadow.
 *
 * Built per layout (the top is sized to the machines' footprint), so the scene
 * builds both and shows the one in use.
 */

/** Where the props lie in each layout: x, surface y, z and a turn about y. */
const PROPS: Record<Place, { stack: [number, number, number, number], coil: [number, number, number] }> = {
  // Staggered: the coil in the free front-left corner of the top, the plots on the shelf.
  tall: { stack: [0.12, SHELF_Y, 0.06, 0.1], coil: [-0.37, TABLE.h, 0.33] },
  // Side by side the top is full: both go on the shelf.
  wide: { stack: [-0.3, SHELF_Y, 0.01, 0.08], coil: [0.32, SHELF_Y, 0.02] },
}

const SHEETS = 6
const SHEET_T = 0.0012
const UP = new THREE.Vector3(0, 1, 0)

/** A finished plot: a decayed two-pendulum harmonograph, like the ones the plotter draws. */
function plotFigure() {
  const pts: number[] = []
  const w = 2 * Math.PI * 0.11
  let last: [number, number] | null = null
  for (let t = 0; t <= 24; t += 0.03) {
    const e1 = Math.exp(-0.05 * t)
    const e2 = Math.exp(-0.035 * t)
    const u = 0.56 * Math.sin(w * 2.01 * t + 0.6) * e1 + 0.38 * Math.sin(w * 3 * t + 2.1) * e2
    const v = 0.56 * Math.sin(w * 3.02 * t + 1.4) * e1 + 0.38 * Math.sin(w * 1.99 * t) * e2
    const p: [number, number] = [u * AREA.hx, v * AREA.hz]
    if (last) pts.push(last[0], 0, last[1], p[0], 0, p[1])
    last = p
  }
  return new THREE.Float32BufferAttribute(pts, 3)
}

/** A loose coil of patch cable lying on its side, both ends trailing out. Its ends lie flat, pointing out of the cable. */
function coil() {
  const r = 0.0042
  const turns = 2.6
  const n = 110
  const pts: THREE.Vector3[] = [new THREE.Vector3(0.085, r, -0.05)]
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const a = u * turns * Math.PI * 2
    // Loops of different size, each resting a little higher on the last.
    const R = 0.05 + 0.012 * Math.sin(a * 0.7 + 0.4)
    pts.push(new THREE.Vector3(Math.cos(a) * R + 0.01 * u, r + Math.min(1, u * 1.5) * r * 1.6, Math.sin(a) * R))
  }
  pts.push(new THREE.Vector3(-0.1, r, 0.06))
  const curve = new THREE.CatmullRomCurve3(pts)
  const ends = [
    { p: curve.getPointAt(0), d: curve.getTangentAt(0).negate().setY(0).normalize() },
    { p: curve.getPointAt(1), d: curve.getTangentAt(1).setY(0).normalize() },
  ]
  return { geo: new THREE.TubeGeometry(curve, n * 2, r, 6, false), ends }
}

export function buildBench(m: Materials, place: Place, ink: string) {
  const a = new Assembly()
  const own: THREE.BufferGeometry[] = []
  const g = <T extends THREE.BufferGeometry>(geo: T) => (own.push(geo), geo)
  const top = tableTop(place)
  const L = TABLE.leg
  const vertical: [number, number, number] = [0, 0, Math.PI / 2]

  // Top: one plywood slab resting on the aprons.
  a.add(g(blockGeometry(top.x1 - top.x0, TABLE.t, top.z1 - top.z0)), 'wood', {
    pos: [(top.x0 + top.x1) / 2, TABLE.h - TABLE.t / 2, (top.z0 + top.z1) / 2],
  })

  // Legs: slotted beams standing on edge, broad face to the front, on dark feet.
  const lx = [top.x0 + L.in, top.x1 - L.in]
  const lz = [top.z0 + L.in, top.z1 - L.in]
  const footH = 0.016
  const y0 = footH + L.w / 2 - 0.006
  const y1 = TABLE.h - TABLE.t - L.w / 2
  const legLen = y1 - y0
  const leg = g(beamGeometry({
    length: legLen,
    width: L.w,
    thickness: L.t,
    holes: [0, TABLE.stretcher - y0, legLen],
    slots: [[TABLE.stretcher - y0 + 0.06, legLen - 0.06]],
  }))
  const foot = g(blockGeometry(L.w + 0.012, footH, L.t + 0.02))
  for (const x of lx) {
    for (const z of lz) {
      a.add(leg, 'dark', { pos: [x, y0, z], rot: vertical })
      a.add(foot, 'dark', { pos: [x, footH / 2, z] })
    }
  }

  // Aprons under the top and stretchers low down, face to face outside the
  // legs, front and back; a plain pin through every joint.
  const span = lx[1]! - lx[0]!
  const rail = g(beamGeometry({
    length: span,
    width: L.w,
    thickness: L.t,
    holes: [0, span],
    slots: [[0.07, span / 2 - 0.05], [span / 2 + 0.05, span - 0.07]],
  }))
  const pin = g(pinGeometry(0.007, L.t * 2 + 0.012))
  const railZ = [lz[0]! - L.t, lz[1]! + L.t]
  for (const [i, z] of railZ.entries()) {
    for (const y of [TABLE.stretcher, y1]) {
      a.add(rail, 'dark', { pos: [lx[0]!, y, z] })
      for (const x of lx) a.add(pin, 'light', { pos: [x, y, (z + lz[i]!) / 2] })
    }
  }
  // Shelf: a plank resting on the stretchers, between the legs.
  const shelfD = railZ[1]! - railZ[0]! + L.t
  a.add(g(blockGeometry(span - L.w - 0.012, TABLE.shelfT, shelfD)), 'wood', {
    pos: [(lx[0]! + lx[1]!) / 2, SHELF_Y - TABLE.shelfT / 2, (lz[0]! + lz[1]!) / 2],
  })

  // A stack of finished plots, each sheet a little askew.
  const at = PROPS[place]
  const [sx, sy, sz, turn] = at.stack
  const sheet = g(blockGeometry(PAPER.w, SHEET_T, PAPER.d))
  // Offsets per sheet (x, z, turn); the top one lies square, its plot on it.
  const skew = [0.05, -0.03, 0.07, -0.06, 0.02, 0]
  for (let i = 0; i < SHEETS; i++) {
    const k = skew[i]!
    a.add(sheet, 'light', { pos: [sx + k * 0.08, sy + SHEET_T * (i + 0.5), sz - k * 0.05], rot: [0, turn + k, 0] })
  }

  // The spare patch cable and its two plugs.
  const [cx, cy, cz] = at.coil
  const c = coil()
  a.add(g(c.geo), 'dark', { pos: [cx, cy, cz], edges: false })
  const plug = g(new THREE.CylinderGeometry(0.0075, 0.0075, 0.03, 24))
  const tip = g(new THREE.CylinderGeometry(0.003, 0.003, 0.018, 12))
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  for (const end of c.ends) {
    e.setFromQuaternion(q.setFromUnitVectors(UP, end.d))
    const rot: [number, number, number] = [e.x, e.y, e.z]
    const along = (k: number): [number, number, number] => [cx + end.p.x + end.d.x * k, cy + 0.0075, cz + end.p.z + end.d.z * k]
    a.add(plug, 'dark', { pos: along(0.012), rot })
    a.add(tip, 'metal', { pos: along(0.034), rot })
  }

  const node = a.build(m, `noise-bench-${place}`)
  own.forEach(geo => geo.dispose())

  // The top plot's ink, in the plotter's accent.
  const inkMat = new THREE.LineBasicMaterial({ color: ink })
  const inkGeo = new THREE.BufferGeometry()
  inkGeo.setAttribute('position', plotFigure())
  const plot = new THREE.LineSegments(inkGeo, inkMat)
  plot.position.set(sx, sy + SHEET_T * SHEETS + 0.0003, sz)
  plot.rotation.y = turn
  node.add(plot)

  // Its shadow on the floor.
  const shadow = contactShadow(m, 0.5)
  shadow.scale.set((top.x1 - top.x0) * 1.05, (top.z1 - top.z0) * 1.25, 1)
  shadow.position.set((top.x0 + top.x1) / 2, shadow.position.y, (top.z0 + top.z1) / 2)
  node.add(shadow)

  return { node, dispose: () => inkMat.dispose() }
}
