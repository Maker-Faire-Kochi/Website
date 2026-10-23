import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Palette } from './palette'

/**
 * The beam kit: the parts every drawing on the stage is built from, in the
 * straight-beam language of the guidelines -- straight slotted members with
 * plain pins, opaque faces with quiet side planes, fine hairline edges.
 *
 * Units are metres. A beam lies along +X from its first pin centre (x = 0) to
 * its last (x = length), so linkages chain by placing the next part at
 * x = length. Thickness is centred on z = 0.
 */

export type MatKey = Exclude<keyof Palette, 'ink' | 'paper'>

export interface Materials {
  face: Record<MatKey, THREE.MeshLambertMaterial>
  line: THREE.LineBasicMaterial
  lineFaint: THREE.LineBasicMaterial
  shadow: THREE.MeshBasicMaterial
  dispose(): void
}

export function createMaterials(p: Palette): Materials {
  const face = {} as Record<MatKey, THREE.MeshLambertMaterial>
  for (const key of Object.keys(p) as (keyof Palette)[]) {
    if (key === 'ink' || key === 'paper') continue
    // Faces are pushed back a hair so the hairlines drawn on their edges win
    // the depth test instead of z-fighting with them.
    face[key] = new THREE.MeshLambertMaterial({
      color: p[key],
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    })
  }
  const line = new THREE.LineBasicMaterial({ color: p.ink })
  const lineFaint = new THREE.LineBasicMaterial({ color: p.ink, transparent: true, opacity: 0.3 })
  const shadow = new THREE.MeshBasicMaterial({
    map: blobTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.22,
  })
  return {
    face,
    line,
    lineFaint,
    shadow,
    dispose() {
      Object.values(face).forEach(m => m.dispose())
      line.dispose()
      lineFaint.dispose()
      shadow.map?.dispose()
      shadow.dispose()
    },
  }
}

/** One soft radial blob, used as a contact shadow under anything standing on the ground. */
function blobTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(0,0,0,1)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Flat paper-studio light: faces facing the key light read at their own colour, side planes fall off quietly. */
export function addLights(scene: THREE.Scene) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0xd8d8d2, 1.9)
  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.set(-3, 5, 4)
  scene.add(hemi, key)
  return { hemi, key }
}

// ── Geometry ──────────────────────────────────────────────────────────────

export interface BeamSpec {
  length: number
  width: number
  thickness: number
  /** Pin hole centres along the beam. Defaults to both ends. */
  holes?: number[]
  holeR?: number
  /** Slots as [from, to] centre positions along the beam. */
  slots?: [number, number][]
  slotW?: number
}

export function beamGeometry(s: BeamSpec): THREE.BufferGeometry {
  const r = s.width / 2
  const shape = new THREE.Shape()
  shape.absarc(s.length, 0, r, -Math.PI / 2, Math.PI / 2, false)
  shape.absarc(0, 0, r, Math.PI / 2, Math.PI * 1.5, false)
  shape.closePath()
  const holeR = s.holeR ?? s.width * 0.18
  for (const x of s.holes ?? [0, s.length]) {
    const h = new THREE.Path()
    h.absarc(x, 0, holeR, 0, Math.PI * 2, true)
    shape.holes.push(h)
  }
  const sr = (s.slotW ?? s.width * 0.28) / 2
  for (const [a, b] of s.slots ?? []) {
    const p = new THREE.Path()
    p.absarc(b, 0, sr, -Math.PI / 2, Math.PI / 2, false)
    p.absarc(a, 0, sr, Math.PI / 2, Math.PI * 1.5, false)
    p.closePath()
    shape.holes.push(p)
  }
  return extrude(shape, s.thickness)
}

/** A flat plate from any 2D outline (with holes), extruded and centred on z = 0. */
export function extrude(shape: THREE.Shape, depth: number, curveSegments = 10) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments })
  g.translate(0, 0, -depth / 2)
  return g
}

/** Disc of radius r with optional hole circles: wheels, hubs, pulleys. Lies in XY, centred on z = 0. */
export function discGeometry(r: number, thickness: number, holes: { x: number, y: number, r: number }[] = [], segments = 24) {
  const shape = new THREE.Shape()
  shape.absarc(0, 0, r, 0, Math.PI * 2, false)
  for (const h of holes) {
    const p = new THREE.Path()
    p.absarc(h.x, h.y, h.r, 0, Math.PI * 2, true)
    shape.holes.push(p)
  }
  return extrude(shape, thickness, segments)
}

/** Plain pin along Z, centred on the origin. */
export function pinGeometry(r: number, length: number) {
  // 24 sides keeps the facet angle (15deg) under EDGE_ANGLE, so no ridge lines.
  const g = new THREE.CylinderGeometry(r, r, length, 24)
  g.rotateX(Math.PI / 2)
  return g
}

export function blockGeometry(w: number, h: number, d: number) {
  return new THREE.BoxGeometry(w, h, d)
}

/** Flat ground-plane contact shadow; add to a scene and position under a figure. */
export function contactShadow(m: Materials, radius: number) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), m.shadow)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = 0.0005
  mesh.renderOrder = -1
  return mesh
}

// ── Assemblies ────────────────────────────────────────────────────────────

const EDGE_ANGLE = 20
const edgeCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()

function edgesOf(geo: THREE.BufferGeometry) {
  let e = edgeCache.get(geo)
  if (!e) {
    e = new THREE.EdgesGeometry(geo, EDGE_ANGLE)
    edgeCache.set(geo, e)
  }
  return e
}

function forMerge(geo: THREE.BufferGeometry, m: THREE.Matrix4) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone()
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
  }
  g.applyMatrix4(m)
  return g
}

const tmpQ = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpS = new THREE.Vector3()
const tmpP = new THREE.Vector3()

/**
 * A RIGID group of parts. build() merges every face that shares a material
 * into one mesh and every hairline into one LineSegments, so an assembly costs
 * (materials used + 1) draw calls however many parts it has. Anything that
 * moves relative to anything else must be its own assembly.
 */
export class Assembly {
  private parts: { geo: THREE.BufferGeometry, mat: MatKey, m: THREE.Matrix4, edges: boolean }[] = []

  add(geo: THREE.BufferGeometry, mat: MatKey, opts: {
    pos?: [number, number, number]
    rot?: [number, number, number]
    scale?: [number, number, number]
    edges?: boolean
  } = {}) {
    tmpP.set(...(opts.pos ?? [0, 0, 0]))
    tmpQ.setFromEuler(tmpE.set(...(opts.rot ?? [0, 0, 0])))
    tmpS.set(...(opts.scale ?? [1, 1, 1]))
    this.parts.push({ geo, mat, m: new THREE.Matrix4().compose(tmpP, tmpQ, tmpS), edges: opts.edges ?? true })
    return this
  }

  /** Geometries passed to add() are not consumed; dispose them yourself if they are not shared. */
  build(materials: Materials, name = 'assembly'): THREE.Group {
    const group = new THREE.Group()
    group.name = name
    const byMat = new Map<MatKey, THREE.BufferGeometry[]>()
    const lines: THREE.BufferGeometry[] = []
    for (const p of this.parts) {
      const list = byMat.get(p.mat) ?? []
      list.push(forMerge(p.geo, p.m))
      byMat.set(p.mat, list)
      if (p.edges) lines.push(edgesOf(p.geo).clone().applyMatrix4(p.m))
    }
    for (const [mat, geos] of byMat) {
      const merged = mergeGeometries(geos)
      geos.forEach(g => g.dispose())
      const mesh = new THREE.Mesh(merged, materials.face[mat])
      mesh.name = `${name}:${mat}`
      group.add(mesh)
    }
    if (lines.length) {
      const merged = mergeGeometries(lines)
      lines.forEach(g => g.dispose())
      const seg = new THREE.LineSegments(merged, materials.line)
      seg.name = `${name}:lines`
      group.add(seg)
    }
    return group
  }
}

/** Disposes every geometry under root. Materials are shared and owned by the stage. */
export function disposeGeometries(root: THREE.Object3D) {
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    g?.dispose()
  })
}

/** Orthographic camera fitted so `viewHeight` world units span the slot height. */
export function fitOrtho(cam: THREE.OrthographicCamera, w: number, h: number, viewHeight: number) {
  const aspect = w / Math.max(1, h)
  cam.top = viewHeight / 2
  cam.bottom = -viewHeight / 2
  cam.left = -viewHeight * aspect / 2
  cam.right = viewHeight * aspect / 2
  cam.updateProjectionMatrix()
}
