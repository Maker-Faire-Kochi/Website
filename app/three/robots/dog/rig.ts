import * as THREE from 'three'
import type { MatKey, Materials } from '../../core/kit'

/**
 * Limbs in a handful of draw calls (shared by the dog and Makey).
 *
 * The kit's Assembly merges a RIGID group into one mesh per material plus
 * one LineSegments, so every part that moves on its own costs at least two
 * calls. A dog has twelve such parts; drawn that way its legs alone would be
 * ~30 calls, and the budget for the whole robot is 22.
 *
 * A Rig is the same idea one level up: every limb part is registered with
 * the joint node it hangs on, and once per frame frame() writes each part's
 * vertices, transformed by its node's current matrix, into ONE dynamic
 * buffer per material (and its hairlines into one dynamic LineSegments).
 * Rigid skinning, done on the CPU: a few thousand vertices a frame, so the
 * whole set of limbs costs (materials used + 1) calls however many joints
 * it has. Normals are rotated with the same matrix (the joints never scale).
 *
 * Source vertices (with each part's fixed offset baked in) are built once
 * per robot TYPE (RigSource) and shared by every instance; only the output
 * buffers are per instance.
 */

interface SourcePart {
  /** Index of the node the part hangs on. */
  node: number
  pos: Float32Array
  nrm: Float32Array
  /** Hairline segment vertices, or null. */
  lines: Float32Array | null
}

const EDGE_ANGLE = 20
const edgeCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()
function edgesOf(g: THREE.BufferGeometry) {
  let e = edgeCache.get(g)
  if (!e) {
    e = new THREE.EdgesGeometry(g, EDGE_ANGLE)
    edgeCache.set(g, e)
  }
  return e
}

/** The shared, immutable part of a rig: vertices per material, in each node's frame. */
export class RigSource {
  readonly byMat = new Map<MatKey, SourcePart[]>()
  readonly lines: SourcePart[] = []
  readonly counts = new Map<MatKey, number>()
  lineCount = 0

  /**
   * Add `geo` (not consumed) on node `node`, offset by pos/rot. Hairlines on
   * dark parts are invisible (ink on near-ink), so they default off there.
   */
  add(node: number, geo: THREE.BufferGeometry, mat: MatKey, opts: { pos?: [number, number, number], rot?: [number, number, number], edges?: boolean } = {}) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...(opts.pos ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(opts.rot ?? [0, 0, 0]))),
      new THREE.Vector3(1, 1, 1),
    )
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m)
    const pos = new Float32Array(g.attributes.position!.array)
    const nrm = new Float32Array(g.attributes.normal!.array)
    g.dispose()
    const list = this.byMat.get(mat) ?? []
    list.push({ node, pos, nrm, lines: null })
    this.byMat.set(mat, list)
    this.counts.set(mat, (this.counts.get(mat) ?? 0) + pos.length / 3)
    if (opts.edges ?? mat !== 'dark') {
      const e = edgesOf(geo).clone().applyMatrix4(m)
      const lines = new Float32Array(e.attributes.position!.array)
      e.dispose()
      this.lines.push({ node, pos: lines, nrm: lines, lines })
      this.lineCount += lines.length / 3
    }
    return this
  }

  get triangles() {
    let n = 0
    for (const c of this.counts.values()) n += c / 3
    return n
  }
}

const M = new THREE.Matrix4()
const INV = new THREE.Matrix4()

/** One robot's limbs: the dynamic meshes, posed from its nodes every frame. */
export class Rig {
  readonly group = new THREE.Group()
  readonly meshes: THREE.Mesh[] = []
  private readonly out: { mat: MatKey, parts: SourcePart[], pos: Float32Array, nrm: Float32Array, geo: THREE.BufferGeometry }[] = []
  private readonly lineGeo: THREE.BufferGeometry | null = null
  private readonly linePos: Float32Array | null = null
  private readonly mats: Float32Array

  constructor(readonly src: RigSource, readonly nodes: THREE.Object3D[], materials: Materials, readonly root: THREE.Object3D, name: string) {
    this.group.name = name
    this.mats = new Float32Array(nodes.length * 16)
    const huge = new THREE.Sphere(new THREE.Vector3(), 1e4)
    for (const [mat, parts] of src.byMat) {
      const n = src.counts.get(mat)!
      const pos = new Float32Array(n * 3)
      const nrm = new Float32Array(n * 3)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage))
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage))
      // Positions change every frame: a fixed, generous bound instead of a stale computed one.
      geo.boundingSphere = huge
      const mesh = new THREE.Mesh(geo, materials.face[mat])
      mesh.name = `${name}:${mat}`
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.meshes.push(mesh)
      this.out.push({ mat, parts, pos, nrm, geo })
    }
    if (src.lineCount) {
      this.linePos = new Float32Array(src.lineCount * 3)
      this.lineGeo = new THREE.BufferGeometry()
      this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage))
      this.lineGeo.boundingSphere = huge
      const seg = new THREE.LineSegments(this.lineGeo, materials.line)
      seg.name = `${name}:lines`
      seg.frustumCulled = false
      this.group.add(seg)
    }
    root.add(this.group)
  }

  /** Swap one material's faces (setAccent). */
  setMaterial(mat: MatKey, m: THREE.Material) {
    for (const mesh of this.meshes) if (mesh.name.endsWith(`:${mat}`)) mesh.material = m
  }

  /** Pose: call after the nodes' transforms are set. The rig group sits under `root`. */
  update() {
    this.root.updateMatrixWorld(true)
    INV.copy(this.root.matrixWorld).invert()
    for (let i = 0; i < this.nodes.length; i++) {
      M.multiplyMatrices(INV, this.nodes[i]!.matrixWorld)
      this.mats.set(M.elements, i * 16)
    }
    const E = this.mats
    for (const o of this.out) {
      let w = 0
      const P = o.pos, N = o.nrm
      for (const part of o.parts) {
        const b = part.node * 16
        const e0 = E[b]!, e1 = E[b + 1]!, e2 = E[b + 2]!, e4 = E[b + 4]!, e5 = E[b + 5]!, e6 = E[b + 6]!
        const e8 = E[b + 8]!, e9 = E[b + 9]!, e10 = E[b + 10]!, e12 = E[b + 12]!, e13 = E[b + 13]!, e14 = E[b + 14]!
        const sp = part.pos, sn = part.nrm
        for (let k = 0; k < sp.length; k += 3) {
          const x = sp[k]!, y = sp[k + 1]!, z = sp[k + 2]!
          P[w] = e0 * x + e4 * y + e8 * z + e12
          P[w + 1] = e1 * x + e5 * y + e9 * z + e13
          P[w + 2] = e2 * x + e6 * y + e10 * z + e14
          const nx = sn[k]!, ny = sn[k + 1]!, nz = sn[k + 2]!
          N[w] = e0 * nx + e4 * ny + e8 * nz
          N[w + 1] = e1 * nx + e5 * ny + e9 * nz
          N[w + 2] = e2 * nx + e6 * ny + e10 * nz
          w += 3
        }
      }
      o.geo.attributes.position!.needsUpdate = true
      o.geo.attributes.normal!.needsUpdate = true
    }
    if (this.linePos) {
      let w = 0
      const P = this.linePos
      for (const part of this.src.lines) {
        const b = part.node * 16
        const sp = part.pos
        for (let k = 0; k < sp.length; k += 3) {
          const x = sp[k]!, y = sp[k + 1]!, z = sp[k + 2]!
          P[w] = E[b]! * x + E[b + 4]! * y + E[b + 8]! * z + E[b + 12]!
          P[w + 1] = E[b + 1]! * x + E[b + 5]! * y + E[b + 9]! * z + E[b + 13]!
          P[w + 2] = E[b + 2]! * x + E[b + 6]! * y + E[b + 10]! * z + E[b + 14]!
          w += 3
        }
      }
      this.lineGeo!.attributes.position!.needsUpdate = true
    }
  }

  dispose() {
    this.group.removeFromParent()
    for (const o of this.out) o.geo.dispose()
    this.lineGeo?.dispose()
  }
}
