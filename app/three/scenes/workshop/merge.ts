import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * Draw-call economy. The kit's Assembly makes one mesh per material plus one
 * hairline object, which is right for a single part but adds up: the bench,
 * the room, four tools and a nine-part stool cost about 45 draws. Here the
 * per-material meshes of an assembly are folded into ONE mesh whose colours
 * ride on the vertices (the material colours, already linear, so the shading
 * is identical), under one shared vertex-colour Lambert material with the
 * kit's polygon offset. An assembly then costs 2 draws: faces and hairlines.
 */

/** The scene's one vertex-colour face material (dispose it with the scene). */
export function vertexColorMaterial() {
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
}

const tmpC = new THREE.Color()

/** A copy of a mesh's geometry in `space` (relative to `root`), non-indexed, with a colour attribute. */
function coloured(mesh: THREE.Mesh, root: THREE.Object3D) {
  mesh.updateWorldMatrix(true, false)
  root.updateWorldMatrix(true, false)
  const m = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld)
  const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
  for (const name of Object.keys(src.attributes)) if (name !== 'position' && name !== 'normal') src.deleteAttribute(name)
  src.applyMatrix4(m)
  tmpC.copy((mesh.material as THREE.MeshLambertMaterial).color)
  const n = src.attributes.position!.count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    col[i * 3] = tmpC.r
    col[i * 3 + 1] = tmpC.g
    col[i * 3 + 2] = tmpC.b
  }
  src.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return src
}

function lineCopy(l: THREE.LineSegments, root: THREE.Object3D) {
  l.updateWorldMatrix(true, false)
  root.updateWorldMatrix(true, false)
  const m = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(l.matrixWorld)
  const g = l.geometry.index ? l.geometry.toNonIndexed() : l.geometry.clone()
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name)
  return g.applyMatrix4(m)
}

/**
 * Fold everything under `sources` (Assembly groups, in `root`'s frame) into
 * one coloured mesh and one hairline object. The sources' geometry is disposed.
 */
export function collapse(sources: THREE.Object3D[], root: THREE.Object3D, mat: THREE.Material, line: THREE.Material, name: string) {
  const faces: THREE.BufferGeometry[] = []
  const lines: THREE.BufferGeometry[] = []
  for (const s of sources) {
    s.traverse((o) => {
      if ((o as THREE.LineSegments).isLineSegments) lines.push(lineCopy(o as THREE.LineSegments, root))
      else if ((o as THREE.Mesh).isMesh) faces.push(coloured(o as THREE.Mesh, root))
    })
    s.traverse(o => (o as THREE.Mesh).geometry?.dispose())
    s.removeFromParent()
  }
  const group = new THREE.Group()
  group.name = name
  const fg = mergeGeometries(faces)!
  faces.forEach(g => g.dispose())
  const mesh = new THREE.Mesh(fg, mat)
  mesh.name = `${name}:faces`
  group.add(mesh)
  if (lines.length) {
    const lg = mergeGeometries(lines)!
    lines.forEach(g => g.dispose())
    const seg = new THREE.LineSegments(lg, line)
    seg.name = `${name}:lines`
    group.add(seg)
  }
  return { group, mesh }
}

/**
 * Several rigid parts that only ever TRANSLATE relative to each other (the
 * exploded stool), as one mesh and one hairline object: each vertex remembers
 * its part, and move() rewrites positions from the rest positions plus that
 * part's offset. A few thousand vertices, rewritten only while parts move.
 */
export function movableParts(parts: THREE.Object3D[], root: THREE.Object3D, mat: THREE.Material, line: THREE.Material, name: string, bound: number) {
  const faces: THREE.BufferGeometry[] = []
  const lines: THREE.BufferGeometry[] = []
  const faceRange: number[] = []
  const lineRange: number[] = []
  for (const p of parts) {
    const f0 = faces.length, l0 = lines.length
    p.traverse((o) => {
      if ((o as THREE.LineSegments).isLineSegments) lines.push(lineCopy(o as THREE.LineSegments, root))
      else if ((o as THREE.Mesh).isMesh) faces.push(coloured(o as THREE.Mesh, root))
    })
    faceRange.push(faces.slice(f0).reduce((n, g) => n + g.attributes.position!.count, 0))
    lineRange.push(lines.slice(l0).reduce((n, g) => n + g.attributes.position!.count, 0))
    p.traverse(o => (o as THREE.Mesh).geometry?.dispose())
    p.removeFromParent()
  }
  const fg = mergeGeometries(faces)!
  const lg = mergeGeometries(lines)!
  faces.forEach(g => g.dispose())
  lines.forEach(g => g.dispose())
  const partOf = (counts: number[]) => {
    const out = new Uint8Array(counts.reduce((a, b) => a + b, 0))
    let o = 0
    counts.forEach((c, i) => out.fill(i, o, (o += c)))
    return out
  }
  const fPart = partOf(faceRange)
  const lPart = partOf(lineRange)
  const fRest = (fg.attributes.position!.array as Float32Array).slice()
  const lRest = (lg.attributes.position!.array as Float32Array).slice()
  ;(fg.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage)
  ;(lg.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage)
  // Bounds cover the fully exploded state, so picking never misses a moved part.
  fg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.3, 0), bound)
  lg.boundingSphere = fg.boundingSphere.clone()
  const mesh = new THREE.Mesh(fg, mat)
  mesh.name = `${name}:faces`
  const seg = new THREE.LineSegments(lg, line)
  seg.name = `${name}:lines`
  const group = new THREE.Group()
  group.name = name
  group.add(mesh, seg)

  const write = (geo: THREE.BufferGeometry, rest: Float32Array, part: Uint8Array, off: ArrayLike<number>) => {
    const a = geo.attributes.position!.array as Float32Array
    for (let i = 0, n = part.length; i < n; i++) {
      const o = part[i]! * 3
      a[i * 3] = rest[i * 3]! + off[o]!
      a[i * 3 + 1] = rest[i * 3 + 1]! + off[o + 1]!
      a[i * 3 + 2] = rest[i * 3 + 2]! + off[o + 2]!
    }
    geo.attributes.position!.needsUpdate = true
  }
  return {
    group,
    mesh,
    /** Offsets per part, flat [x, y, z, ...], from where each part was built. */
    move(off: ArrayLike<number>) {
      write(fg, fRest, fPart, off)
      write(lg, lRest, lPart, off)
    },
  }
}
