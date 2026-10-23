import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { contactShadow, type MatKey, type Materials } from '../core/kit'
import { dimsFor, type Dims, type Variant } from './body'
import { partsFor } from './figure'
import { classifyEdges, emptyLines, meshLines, transformLines, type EdgeData } from './geo'
import { Rig, restPositions, type Influence } from './rig'
import { BONE_COUNT, BONE_NAMES, B, PARENT, PersonMotion, skirtSplit, type Action, type BodyStance, type HandTarget, type LookOptions, type P3, type PlayOptions } from './motion'
import type { Mat3, Vec3 } from './ik'
import { TONES, isTone, lookKey, pickColors, resolveLook, type ColorKey, type Look, type Role } from './style'

/**
 * A fair visitor: a jointed figure in the kit's drawing language (opaque
 * faces, fine crease hairlines), driven by PersonMotion.
 *
 * WHY RIGID SKINNING. Every body segment is a rigid part on its own joint
 * node, exactly as an Assembly would be -- but sixteen Assemblies would cost
 * 16 x (materials + 1) draw calls, ~35 per person. Instead each part's
 * vertices are bound with weight 1 to their one bone and all parts sharing a
 * colour role are merged into ONE SkinnedMesh; the hairlines are merged into
 * ONE skinned LineSegments. A person is therefore (roles + 1 + shadow) draw
 * calls, about 7, and the parts still move strictly rigidly: a weight-1
 * vertex has no blending, it is the rigid transform of its bone.
 *
 * Geometry is built ONCE per variant (module cache, reference counted) and
 * shared by every person of that variant; a person owns only its skeleton,
 * its colours (materials chosen per role) and its motion.
 *
 * Bone-space modelling: each part is authored in its bone's own frame and the
 * bone inverses are identity, so a vertex's world position is simply
 * boneWorld x vertex.
 */

export type { Role, Look, ColorKey }
export const ROLES: readonly Role[] = ['skin', 'top', 'bottom', 'hair', 'shoe', 'scarf']

export interface PersonOptions {
  seed: number
  variant: Variant
  /** Initial action (default 'idle'). */
  pose?: Action
  posterMode?: boolean
  /** Uniform scale of the whole figure; proportions stay real. Default 1 (metres). */
  scale?: number
  /**
   * Colour per role: a stage palette key (as before) or one of the people's own
   * tones (style.ts TONES, e.g. 'skin3', 'turmeric'). Anything not given is
   * picked from the seed: real skin and hair tones, neutral clothes, at most one
   * dyed garment.
   */
  colors?: Partial<Record<Role, ColorKey>>
  /**
   * How this person looks and wears their clothes (hair style, glasses, facial
   * hair, sleeves, mundu or lungi, folded mundu, apron). Unset fields are picked
   * from the seed; see style.ts Look.
   */
  look?: Partial<Look>
  /** This figure carries the one beam-blue accent (headscarf or top). */
  accent?: boolean
}

export interface Person {
  readonly root: THREE.Group
  readonly variant: Variant
  readonly dims: Dims
  /** The resolved look (seeded unless pinned in the options). */
  readonly look: Look
  /** Footprint radius on the ground, world units. */
  readonly radius: number
  /** Ground position (y = 0) after the last step. */
  readonly position: THREE.Vector3
  readonly heading: number
  /** True while a step is in progress (it finishes before anything else starts). */
  readonly busy: boolean
  readonly action: Action
  readonly motion: PersonMotion
  /** Rope travel per haul cycle, world units -- what a scene moves its rope by. */
  readonly ropeHaulPerCycle: number
  placeAt(x: number, z: number, heading: number): void
  step(dt: number): void
  frame(alpha: number): void
  /**
   * World point to look at, or null for the person's own idle glances. While a hand
   * target is set the eyes stay on the hands and only glance at this -- unless
   * `{ priority: 'target' }`: then the eyes stay on it and glance at the hands when one
   * goes to a new grip (or on glanceAtHands).
   */
  lookAt(target: THREE.Vector3 | null, opts?: LookOptions): void
  /** Same as lookAt. */
  setLookTarget(target: THREE.Vector3 | null, opts?: LookOptions): void
  /** A short look at the hands (seconds), for a look target with priority over them. */
  glanceAtHands(seconds?: number): void
  /**
   * World grip point for a hand (call every step while a tool moves). The palm
   * centre lands exactly on `position` when it is within reach; beyond reach the
   * torso leans toward it and, standing, the person steps closer. `normal` is
   * the surface normal at the grip (out of the handle, toward the hand); `elbow`
   * a world direction for the elbow (default down, back, a little out). Null
   * returns the arm to its current animation (eased).
   */
  setHandTarget(side: 'left' | 'right', target: { position: P3, normal?: P3, elbow?: P3 } | null): void
  /** Torso lean, radians: forward (+, up to 0.6) / back (-, to -0.25), and left (+) / right (-) up to 0.3. */
  setLean(forward: number, side?: number): void
  /** Body set for work; feet re-plant one at a time. 'sit' takes the seat's top height and, optionally, the height of a rung for the feet (world units). */
  setStance(stance: BodyStance, opts?: { seatHeight?: number, footHeight?: number, instant?: boolean }): void
  readonly stance: BodyStance
  play(action: Action, opts?: PlayOptions): void
  /** Sync 'pull-rope' to the scene: phase in [0, 1). Without it the haul free-runs. */
  setRopePhase(phase: number): void
  /** World position of a hand's palm centre. */
  handWorld(side: 'left' | 'right', out: THREE.Vector3): THREE.Vector3
  setSelected(on: boolean): void
  setPaused(paused: boolean): void
  hit(ray: THREE.Raycaster): boolean
  dispose(): void
}

// ── Shared geometry per variant and look ────────────────────────────────

interface VariantGeo { faces: Map<Role, THREE.BufferGeometry>, lines: THREE.BufferGeometry, refs: number }

const cache = new Map<string, VariantGeo>()
const CREASE = 60

/** Skin attributes from per-vertex influences (bone-local positions in, see rig.ts). */
function skinFrom(geo: THREE.BufferGeometry, inf: (v: [number, number, number]) => Influence) {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const n = pos.count
  const idx = new Uint16Array(n * 4)
  const w = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const list = inf([pos.getX(i), pos.getY(i), pos.getZ(i)])
    for (let k = 0; k < list.length; k++) {
      idx[i * 4 + k] = list[k]![0]
      w[i * 4 + k] = list[k]![1]
    }
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4))
  return geo
}

/**
 * Parts are authored in their bone's frame; the build weights every vertex
 * (rigid, blended at the joints, or across the legs for long garments) and
 * then moves it into the bind pose (bone rest translations), so the skeleton
 * carries real bind inverses and blended weights deform correctly.
 */
function buildVariant(variant: Variant, look: Look): VariantGeo {
  const d = dimsFor(variant)
  const rig = new Rig(d)
  const parts = partsFor(d, look)
  const byRole = new Map<Role, THREE.BufferGeometry[]>()
  const lineGeos: THREE.BufferGeometry[] = []
  for (const p of parts) {
    const g = p.geo.clone()
    if (!g.index) g.setIndex([...Array(g.attributes.position!.count).keys()])
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
    if (!g.attributes.normal) g.computeVertexNormals()
    g.applyMatrix4(p.m)
    const inf = (v: [number, number, number]) => (p.legs ? rig.legs(v) : rig.joint(p.bone, v))
    skinFrom(g, inf)
    const pos = g.attributes.position as THREE.BufferAttribute
    const col = new Float32Array(pos.count * 3).fill(1)
    if (p.color) {
      for (let i = 0; i < pos.count; i++) {
        const c = p.color([pos.getX(i), pos.getY(i), pos.getZ(i)])
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const r = rig.rest[p.bone]!
    g.translate(r[0], r[1], r[2])
    const list = byRole.get(p.role) ?? []
    list.push(g)
    byRole.set(p.role, list)
    const ld = emptyLines()
    const ge = p.geo.userData.edges as EdgeData | undefined
    if (p.crease !== 0) {
      if (ge) classifyEdges(ge, p.crease ?? CREASE, ld, p.rims ?? true)
      else meshLines(p.geo, p.crease ?? CREASE, ld)
    }
    if (p.lines) {
      ld.pos.push(...p.lines.pos)
      ld.n1.push(...p.lines.n1)
      ld.n2.push(...p.lines.n2)
    }
    let t = transformLines(ld, p.m)
    if (p.bone === B.uaL || p.bone === B.uaR) {
      // The top of the arm lies just under the shoulder's skin and cloth: outline edges
      // found there (the faces' small depth offset lets lines a hair under a surface show)
      // drew dark smudges over a sharply bent shoulder. The shoulder's own outline is drawn.
      const keep = { pos: [] as number[], n1: [] as number[], n2: [] as number[] }
      const top = -0.028 * d.H
      for (let k = 0; k < t.pos.length; k += 6) {
        const crease = t.n1[k] === 0 && t.n1[k + 1] === 0 && t.n1[k + 2] === 0
        if (!crease && t.pos[k + 1]! > top && t.pos[k + 4]! > top) continue
        for (let q = 0; q < 6; q++) { keep.pos.push(t.pos[k + q]!); keep.n1.push(t.n1[k + q]!); keep.n2.push(t.n2[k + q]!) }
      }
      t = keep
    }
    if (t.pos.length) {
      const lg = new THREE.BufferGeometry()
      lg.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3))
      lg.setAttribute('eN1', new THREE.Float32BufferAttribute(t.n1, 3))
      lg.setAttribute('eN2', new THREE.Float32BufferAttribute(t.n2, 3))
      skinFrom(lg, inf)
      lg.translate(r[0], r[1], r[2])
      lineGeos.push(lg)
    }
    p.geo.dispose()
  }
  const faces = new Map<Role, THREE.BufferGeometry>()
  // Indexed throughout (geo.ts): smooth surfaces share vertices, so each is skinned once.
  for (const [role, list] of byRole) {
    faces.set(role, mergeGeometries(list)!)
    list.forEach(g => g.dispose())
  }
  const lines = mergeGeometries(lineGeos)!
  lineGeos.forEach(g => g.dispose())
  return { faces, lines, refs: 0 }
}

function acquire(key: string, variant: Variant, look: Look): VariantGeo {
  let v = cache.get(key)
  if (!v) {
    v = buildVariant(variant, look)
    cache.set(key, v)
  }
  v.refs++
  return v
}

function release(key: string) {
  const v = cache.get(key)
  if (!v) return
  if (--v.refs > 0) return
  v.faces.forEach(g => g.dispose())
  v.lines.dispose()
  cache.delete(key)
}

/**
 * The shared geometry of a variant while any person of it is alive (for tests
 * and budgets). With a look, exactly that variant + look; without, any look.
 */
export function variantGeometry(variant: Variant, look?: Look) {
  if (look) return cache.get(lookKey(variant, look)) ?? null
  for (const [k, v] of cache) if (k.startsWith(`${variant}|`)) return v
  return null
}

/**
 * Hairlines that follow the skeleton. three.js skins any object flagged
 * isSkinnedMesh; LineSegments does not carry the flag, so this class adds it
 * with the same attached-bind bookkeeping SkinnedMesh does.
 */
class SkinnedLines extends THREE.LineSegments {
  readonly isSkinnedMesh = true
  bindMode = THREE.AttachedBindMode
  bindMatrix = new THREE.Matrix4()
  bindMatrixInverse = new THREE.Matrix4()
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, public skeleton: THREE.Skeleton) {
    super(geo, mat)
  }

  override updateMatrixWorld(force?: boolean) {
    super.updateMatrixWorld(force)
    this.bindMatrixInverse.copy(this.matrixWorld).invert()
  }
}

/**
 * Skinned objects get their own copies of the stage's materials. Sharing one
 * material between skinned and unskinned objects makes three.js swap shader
 * programs (and rebuild their parameters) every time the draw order crosses
 * from one kind to the other -- measured at ~11% of a throttled frame here.
 * One set per stage Materials, reference counted with the people using it.
 */
interface SkinMats { face(k: ColorKey): THREE.Material, line: THREE.Material, refs: number, list: THREE.Material[] }

/**
 * The people's line shader: the stage's ink line, plus the silhouette test.
 * Each line vertex carries the normals of the two faces that meet at its edge
 * (eN1, eN2; zero for creases and seams, which are always drawn). The edge is
 * drawn only when one face turns toward the camera and the other away -- the
 * outline of the figure as seen right now. Normals are skinned with the same
 * blend of bones as the position.
 */
function silhouetteLines(m: THREE.Material) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', 'attribute vec3 eN1;\nattribute vec3 eN2;\nvarying float vHide;\n#include <common>')
      .replace('#include <project_vertex>', `#include <project_vertex>
      {
        vec3 a = eN1, b = eN2;
        #ifdef USE_SKINNING
          // Skinned with the same blend of bones as the position: on a joint (a shoulder
          // bent sharply) the dominant bone's turn alone tipped edges over and drew false
          // outlines inside the body.
          mat4 sk = skinWeight.x * boneMatX + skinWeight.y * boneMatY + skinWeight.z * boneMatZ + skinWeight.w * boneMatW;
          mat3 sm = mat3(bindMatrixInverse * sk * bindMatrix);
          a = sm * a;
          b = sm * b;
        #endif
        a = normalMatrix * a;
        b = normalMatrix * b;
        vec3 v = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-mvPosition.xyz);
        // Hidden unless one face turns toward the eye and the other away (creases: zero normals, always drawn).
        vHide = dot(a, v) * dot(b, v) > 0.0 ? 1.0 : 0.0;
      }`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', 'varying float vHide;\n#include <common>')
      .replace('void main() {', 'void main() {\n  if (vHide > 0.5) discard;')
  }
  m.customProgramCacheKey = () => 'person-silhouette-lines'
  return m
}
const skinSets = new WeakMap<Materials, SkinMats>()

function acquireSkinMaterials(M: Materials): SkinMats {
  let s = skinSets.get(M)
  if (!s) {
    const faces = new Map<ColorKey, THREE.Material>()
    const list: THREE.Material[] = []
    const line = silhouetteLines(M.line.clone())
    list.push(line)
    s = {
      face(k) {
        let m = faces.get(k)
        if (!m) {
          if (isTone(k)) {
            m = M.face.light.clone()
            ;(m as THREE.MeshLambertMaterial).color.set(TONES[k])
          }
          else {
            m = M.face[k as MatKey].clone()
          }
          // People carry per-vertex shade: dark eyes, a kasavu border, a lungi's check.
          ;(m as THREE.MeshLambertMaterial).vertexColors = true
          // Pushed back less than the stage's faces (by slope): where one surface lies just
          // over another (a sleeve over the shoulder), the outline beneath showed through it
          // as dark smudges at grazing angles.
          m.polygonOffsetFactor = 0.25
          faces.set(k, m)
          list.push(m)
        }
        return m
      },
      line,
      refs: 0,
      list,
    }
    skinSets.set(M, s)
  }
  s.refs++
  return s
}

function releaseSkinMaterials(M: Materials) {
  const s = skinSets.get(M)
  if (!s || --s.refs > 0) return
  s.list.forEach(m => m.dispose())
  skinSets.delete(M)
}

// ── The person ────────────────────────────────────────────────────────────

const _m4 = new THREE.Matrix4()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()

function mat3ToQuat(m: Mat3, q: THREE.Quaternion) {
  _m4.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1)
  return q.setFromRotationMatrix(_m4)
}

export function createPerson(ctx: { materials: Materials }, opts: PersonOptions): Person {
  const variant = opts.variant
  const d = dimsFor(variant)
  const userScale = opts.scale ?? 1
  const motion = new PersonMotion(d, opts.seed, { posterMode: opts.posterMode, scale: userScale })
  const look = resolveLook(variant, opts.seed, opts.look)
  const key = lookKey(variant, look)
  const geo = acquire(key, variant, look)
  const skinMats = acquireSkinMaterials(ctx.materials)
  const colors = pickColors(variant, opts.seed, look, !!opts.accent, opts.colors)
  const M = ctx.materials

  const root = new THREE.Group()
  root.name = `person:${variant}`
  root.scale.setScalar(userScale)

  const bones: THREE.Bone[] = []
  const offsets = motion.offsets
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = new THREE.Bone()
    b.name = BONE_NAMES[i]!
    const o = offsets[i]!
    b.position.set(o[0], o[1], o[2])
    bones.push(b)
    const parent = PARENT[i]!
    if (parent < 0) root.add(b)
    else bones[parent]!.add(b)
  }
  // Bind pose: every bone at its rest offset, no rotation (see rig.ts).
  const rest = restPositions(d)
  const skeleton = new THREE.Skeleton(bones, rest.map(r => new THREE.Matrix4().makeTranslation(-r[0], -r[1], -r[2])))

  for (const [role, g] of geo.faces) {
    const mesh = new THREE.SkinnedMesh(g, skinMats.face(colors[role]))
    mesh.name = `${variant}:${role}`
    mesh.bind(skeleton, new THREE.Matrix4())
    // Bounds would be computed once from the rest pose; a crouch or a raised arm leaves them.
    mesh.frustumCulled = false
    root.add(mesh)
  }
  const lines = new SkinnedLines(geo.lines, skinMats.line, skeleton)
  lines.name = `${variant}:lines`
  lines.frustumCulled = false
  root.add(lines)

  // Contact shadow and the cyan selection ring sit in the parent frame under the
  // person, so they are siblings positioned each frame, not children of the scaled root.
  const shadowR = 0.2 * d.H * d.build
  const shadow = contactShadow(M, shadowR)
  shadow.scale.setScalar(userScale)
  const ringGeo = new THREE.RingGeometry(0.21 * d.H, 0.235 * d.H, 40)
  ringGeo.rotateX(-Math.PI / 2)
  const ring = new THREE.Mesh(ringGeo, M.face.cyan)
  ring.position.y = 0.002
  ring.visible = false
  root.add(ring)

  const group = new THREE.Group()
  group.name = `visitor:${variant}`
  group.add(root, shadow)

  // Interpolation: the previous and current step's bone rotations. The motion
  // assigns fresh matrices every step (never mutates them), so keeping the two
  // arrays of references is free; quaternions are made per FRAME, not per step.
  let prevR: Mat3[] = motion.pose.R.slice()
  let curR: Mat3[] = prevR
  const prevP = new Float64Array(14)
  const curP = new Float64Array(14)
  const qa = new THREE.Quaternion()
  const qb = new THREE.Quaternion()

  const position = new THREE.Vector3()
  function capture() {
    const P = motion.pose
    curR = P.R.slice()
    curP[0] = P.pelvisPos[0]
    curP[1] = P.pelvisPos[1]
    curP[2] = P.pelvisPos[2]
    curP[3] = motion.pos.x
    curP[4] = motion.pos.z
    curP[5] = motion.heading
    curP[6] = P.shoulderLift
    curP[7] = P.skirtScale
    // The shoulders' pivots move with the clavicles' shrug.
    for (let k = 0; k < 3; k++) {
      curP[8 + k] = offsets[B.uaL]![k]!
      curP[11 + k] = offsets[B.uaR]![k]!
    }
    position.set(motion.pos.x, 0, motion.pos.z)
  }
  function settle() {
    capture()
    prevR = curR
    prevP.set(curP)
  }
  settle()

  let paused = false
  const radius = 0.24 * d.H * d.build * userScale

  function apply(alpha: number) {
    for (let i = 0; i < BONE_COUNT; i++) {
      const q = bones[i]!.quaternion
      mat3ToQuat(curR[i]!, q)
      if (alpha < 1 && prevR[i] !== curR[i]) q.copy(mat3ToQuat(prevR[i]!, qa).slerp(qb.copy(q), alpha))
    }
    const l = (k: number) => prevP[k]! + (curP[k]! - prevP[k]!) * alpha
    bones[B.pelvis]!.position.set(l(0), l(1), l(2))
    const x = l(3), z = l(4)
    const h = prevP[5]! + Math.atan2(Math.sin(curP[5]! - prevP[5]!), Math.cos(curP[5]! - prevP[5]!)) * alpha
    root.position.set(x, 0, z)
    root.rotation.y = h
    const lift = l(6)
    bones[B.uaL]!.position.set(l(8), l(9) + lift, l(10))
    bones[B.uaR]!.position.set(l(11), l(12) + lift, l(13))
    bones[B.skirtLow]!.scale.y = l(7)
    // Shadow under the pelvis, on the ground.
    const pc = Math.cos(h), ps = Math.sin(h)
    const px = l(0) * userScale, pz = l(2) * userScale
    shadow.position.set(x + pc * px + ps * pz, 0.0005, z - ps * px + pc * pz)
  }
  apply(1)

  if (opts.pose && opts.pose !== 'idle') motion.play(opts.pose)

  const person: Person = {
    root: group,
    variant,
    dims: d,
    look,
    radius,
    position,
    get heading() { return motion.heading },
    get busy() { return motion.busy },
    get action() { return motion.action },
    motion,
    get ropeHaulPerCycle() { return motion.ropeHaulPerCycle },
    placeAt(x, z, heading) {
      motion.placeAt(x, z, heading)
      settle()
      apply(1)
    },
    step(dt) {
      prevR = curR
      prevP.set(curP)
      motion.step(dt)
      capture()
    },
    frame(alpha) {
      apply(opts.posterMode ? 1 : alpha)
    },
    lookAt(target, lookOpts) {
      if (paused && target) return
      motion.lookAt(target, lookOpts)
    },
    setLookTarget(target, lookOpts) {
      person.lookAt(target, lookOpts)
    },
    glanceAtHands(seconds) {
      motion.glanceAtHands(seconds)
    },
    setHandTarget(side, target) {
      motion.setHandTarget(side, target as HandTarget | null)
    },
    setLean(forward, side = 0) {
      motion.setLean(forward, side)
    },
    setStance(stance, o) {
      motion.setStance(stance, o)
      if (o?.instant) {
        settle()
        apply(1)
      }
    },
    get stance() { return motion.bodyStance },
    play(action, o) {
      if (paused) return
      motion.play(action, o)
    },
    setRopePhase(phase) {
      motion.setRopePhase(phase)
    },
    handWorld(side, out) {
      const p = motion.handWorld(side)
      return out.set(p[0], p[1], p[2])
    },
    setSelected(on) {
      ring.visible = on
    },
    setPaused(p) {
      paused = p
      if (p) {
        motion.dropQueued()
        motion.lookAt(null)
      }
    },
    hit(ray) {
      root.updateWorldMatrix(true, true)
      const s = userScale
      const wp = (i: number, v: THREE.Vector3) => v.setFromMatrixPosition(bones[i]!.matrixWorld)
      const seg = (i: number, j: number, r: number) => {
        wp(i, _a)
        wp(j, _b)
        return ray.ray.distanceSqToSegment(_a, _b) <= r * r
      }
      // Head: a sphere above the neck base.
      _c.set(0, d.neck + d.headH * 0.5, 0).applyMatrix4(bones[B.head]!.matrixWorld)
      if (ray.ray.distanceSqToPoint(_c) <= (d.headH * 0.6 * s) ** 2) return true
      if (seg(B.pelvis, B.head, d.torsoW * s)) return true
      for (const [a, b2, c] of [[B.thL, B.shL, B.ftL], [B.thR, B.shR, B.ftR]] as const) {
        if (seg(a, b2, d.thigh * 0.65 * s) || seg(b2, c, d.calf * 0.7 * s)) return true
      }
      for (const [a, b2, c] of [[B.uaL, B.faL, B.handL], [B.uaR, B.faR, B.handR]] as const) {
        if (seg(a, b2, d.arm * 0.8 * s) || seg(b2, c, d.arm * 0.8 * s)) return true
      }
      if (d.hem > 0) {
        _c.set(0, -(d.hem - skirtSplit(d)), 0).applyMatrix4(bones[B.skirtLow]!.matrixWorld)
        if (ray.ray.distanceSqToSegment(wp(B.skirt, _a), _c) <= (d.hemW1 * s) ** 2) return true
      }
      return false
    },
    dispose() {
      skeleton.dispose()
      shadow.geometry.dispose()
      ringGeo.dispose()
      group.removeFromParent()
      release(key)
      releaseSkinMaterials(ctx.materials)
    },
  }
  return person
}

export type { Variant, Action, PlayOptions, Vec3, BodyStance, HandTarget, LookOptions }
