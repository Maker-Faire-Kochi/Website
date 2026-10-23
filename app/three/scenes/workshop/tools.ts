import * as THREE from 'three'
import { Assembly, blockGeometry, extrude, type Materials } from '../../core/kit'
import { CHISEL, MALLET, PLANE, SAW } from './layout'
import { SHAVING } from './shaving'

/**
 * The hand tools, each ONE rigid assembly on its own node, built in the local
 * frames layout.ts describes (saw: toe at the origin, teeth along +x; plane:
 * sole centre, +x forward; chisel: cutting edge, axis +y; mallet: wrist pivot,
 * head at -R on x). Straight parts are blocks and plates; only the wooden
 * handles get a chamfered outline.
 */

function poly(pts: [number, number][]) {
  const s = new THREE.Shape()
  s.moveTo(pts[0]![0], pts[0]![1])
  for (const [x, y] of pts.slice(1)) s.lineTo(x, y)
  s.closePath()
  return s
}

function holePath(pts: [number, number][]) {
  const p = new THREE.Path()
  p.moveTo(pts[0]![0], pts[0]![1])
  for (const [x, y] of pts.slice(1)) p.lineTo(x, y)
  p.closePath()
  return p
}

/** Vertical cylinder; 24 sides keeps facets under the kit's edge angle (no ridge lines), 8 draws an octagon. */
const cyl = (r: number, h: number, sides = 24) => new THREE.CylinderGeometry(r, r, h, sides)

function finish(a: Assembly, m: Materials, name: string, own: THREE.BufferGeometry[]) {
  const group = a.build(m, name)
  own.forEach(g => g.dispose())
  const node = new THREE.Group()
  node.name = name
  node.add(group)
  return node
}

export function buildSaw(m: Materials) {
  // Drawn with the heel toward local -x (see layout.ts), so one z rotation poses it.
  const mx = (pts: [number, number][]) => pts.map(([x, y]) => [-x, y] as [number, number])
  const T = SAW.teeth
  const blade = extrude(poly(mx([[0, 0], [T, 0], [T, 0.12], [0, 0.08]])), 0.002)
  const handle = poly(mx([
    [T - 0.03, 0.02], [T - 0.03, 0.12], [T + 0.01, 0.145], [T + 0.105, 0.145], [T + 0.135, 0.115],
    [T + 0.125, 0.02], [T + 0.085, -0.012], [T, -0.012],
  ]))
  handle.holes.push(holePath(mx([
    [T + 0.02, 0.04], [T + 0.02, 0.1], [T + 0.04, 0.118], [T + 0.085, 0.118],
    [T + 0.1, 0.1], [T + 0.09, 0.04], [T + 0.07, 0.028], [T + 0.035, 0.028],
  ])))
  const grip = extrude(handle, 0.022, 1)
  const nut = new THREE.CylinderGeometry(0.007, 0.007, 0.026, 24).rotateX(Math.PI / 2)
  const a = new Assembly()
    .add(blade, 'metal')
    .add(grip, 'wood')
    .add(nut, 'metal', { pos: [-(T - 0.005), 0.035, 0] })
    .add(nut, 'metal', { pos: [-(T - 0.005), 0.095, 0] })
  return finish(a, m, 'saw', [blade, grip, nut])
}

export function buildPlane(m: Materials) {
  const body = blockGeometry(PLANE.len, 0.03, 0.05)
  const cap = blockGeometry(0.075, 0.006, 0.042)
  const tote = extrude(poly([[-0.125, 0.03], [-0.078, 0.03], [-0.052, 0.098], [-0.066, 0.11], [-0.09, 0.105]]), 0.02, 1)
  const knob = cyl(0.016, 0.03)
  const a = new Assembly()
    .add(body, 'dark', { pos: [0, 0.015, 0] })
    // Lever cap over the iron, bedded at 45 degrees and leaning back from the throat.
    .add(cap, 'metal', { pos: [-0.016, 0.056, 0], rot: [0, 0, -Math.PI / 4] })
    .add(tote, 'wood')
    .add(knob, 'wood', { pos: [0.092, 0.045, 0] })
  return finish(a, m, 'plane', [body, cap, tote, knob])
}

export function buildChisel(m: Materials) {
  const blade = blockGeometry(0.016, 0.1, 0.005)
  const ferrule = cyl(0.009, 0.02)
  const handle = cyl(0.014, 0.1, 8)
  const hoop = cyl(0.0148, 0.008, 8)
  const a = new Assembly()
    .add(blade, 'metal', { pos: [0, 0.05, 0] })
    .add(ferrule, 'metal', { pos: [0, 0.11, 0] })
    .add(handle, 'woodDark', { pos: [0, 0.17, 0] })
    .add(hoop, 'metal', { pos: [0, CHISEL.len - 0.004, 0] })
  return finish(a, m, 'chisel', [blade, ferrule, handle, hoop])
}

export function buildMallet(m: Materials) {
  // The handle ends flush with the head's far face, so the mallet can stand on its head.
  const L = MALLET.R + 0.0325
  const handle = blockGeometry(L, MALLET.rh * 2, 0.026)
  const head = blockGeometry(0.065, MALLET.hh * 2, 0.075)
  const a = new Assembly()
    .add(handle, 'wood', { pos: [-L / 2, 0, 0] })
    .add(head, 'woodDark', { pos: [-MALLET.R, 0, 0] })
  return finish(a, m, 'mallet', [handle, head])
}

/**
 * The red hairline arrow that marks the drive input while force is applied:
 * tail at the origin, head at +x. Its own material, so it can fade.
 */
export function buildArrow(color: string) {
  const L = 0.07
  const h = 0.014
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, L, 0, 0,
    L, 0, 0, L - h, h * 0.55, 0,
    L, 0, 0, L - h, -h * 0.55, 0,
  ], 3))
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false })
  const line = new THREE.LineSegments(geo, mat)
  line.name = 'force'
  line.renderOrder = 2
  line.frustumCulled = false
  return line
}

/**
 * The shaving's ribbon: (segments + 1) pairs of vertices across its width,
 * rewritten from the centre line whenever it grows. Faces and both edge
 * hairlines share one position buffer.
 */
export function buildShaving(m: Materials) {
  const n = SHAVING.segments
  const pos = new THREE.Float32BufferAttribute(new Float32Array((n + 1) * 2 * 3), 3)
  pos.setUsage(THREE.DynamicDrawUsage)
  const tri: number[] = []
  const seg: number[] = []
  for (let k = 0; k < n; k++) {
    const a = k * 2
    tri.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    seg.push(a, a + 2, a + 1, a + 3)
  }
  seg.push(0, 1, n * 2, n * 2 + 1)
  const faces = new THREE.BufferGeometry()
  faces.setAttribute('position', pos)
  faces.setIndex(tri)
  const lines = new THREE.BufferGeometry()
  lines.setAttribute('position', pos)
  lines.setIndex(seg)
  // A curled ribbon shows both sides: a double-sided copy of the wood face.
  const mat = m.face.wood.clone()
  mat.side = THREE.DoubleSide
  const mesh = new THREE.Mesh(faces, mat)
  const edge = new THREE.LineSegments(lines, m.line)
  const node = new THREE.Group()
  node.name = 'shaving'
  node.add(mesh, edge)
  mesh.frustumCulled = edge.frustumCulled = false

  const half = SHAVING.width / 2
  return {
    node,
    material: mat,
    /** Writes the centre line (x,y pairs, centroid-relative) into the ribbon. */
    update(curve: Float32Array) {
      const arr = pos.array as Float32Array
      for (let k = 0; k <= n; k++) {
        const x = curve[k * 2]!
        const y = curve[k * 2 + 1]!
        const o = k * 6
        arr[o] = x
        arr[o + 1] = y
        arr[o + 2] = -half
        arr[o + 3] = x
        arr[o + 4] = y
        arr[o + 5] = half
      }
      pos.needsUpdate = true
      faces.computeVertexNormals()
    },
    dispose() {
      faces.dispose()
      lines.dispose()
      mat.dispose()
    },
  }
}
