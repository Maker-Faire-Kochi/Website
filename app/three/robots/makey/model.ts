import * as THREE from 'three'
import { Assembly, blockGeometry, discGeometry, extrude, pinGeometry, type MatKey, type Materials } from '../../core/kit'
import { Rig, RigSource } from '../dog/rig'
import { ARM, LEG } from './ik'
import { ARM_L, ARM_R, type MakeyPose } from './gait'

/**
 * Makey, Maker Faire's red robot mascot, built for this licensed Maker Faire
 * site in the kit's clean 3D language: rounded extrusions with hairline
 * edges, red as the character's own colour.
 *
 * - A boxy, rounded RED body with a white circle badge carrying a bold red
 *   "M" (geometry: an extruded M outline on a white disc, no text, no
 *   texture).
 * - A round RED dome head with a dark visor band and two glowing AMBER eyes
 *   (an unlit amber disc each, plus a soft glow sprite that brightens when it
 *   waves); two short antennae with ball tips in the robot's accent.
 * - Chunky arms: rounded red shoulder pads, grey upper arm and forearm, dark
 *   joints, simple white mitten hands.
 * - Short grey legs on big rounded RED feet with dark soles.
 *
 * Draw calls: body 4 (red, light, dark, lines), head 4 (red, dark, accent,
 * lines), eyes 1, eye glows 2, limbs through one Rig 5 (red, mid, dark,
 * light, lines), contact shadow 1, selection ring 1 (when selected) = 18.
 */

export const TORSO = { w: 0.13, y0: 0.008, y1: 0.122, d: 0.085, r: 0.03 }
export const NECK_AT: [number, number, number] = [0, 0.126, 0]
export const EYE = { x: 0.024, y: 0.046, r: 0.0145 }
const HEAD_R = 0.063

export interface MakeySkeleton {
  root: THREE.Group
  pelvis: THREE.Group
  neck: THREE.Group
  legs: { hipYaw: THREE.Group, thigh: THREE.Group, shin: THREE.Group, foot: THREE.Group }[]
  arms: { shoulder: THREE.Group, elbow: THREE.Group, wrist: THREE.Group }[]
}

const node = (name: string, parent?: THREE.Object3D, pos?: [number, number, number], order?: THREE.EulerOrder) => {
  const g = new THREE.Group()
  g.name = name
  if (pos) g.position.set(...pos)
  if (order) g.rotation.order = order
  parent?.add(g)
  return g
}

export function createSkeleton(): MakeySkeleton {
  const root = node('makey')
  const pelvis = node('pelvis', root, undefined, 'YXZ')
  const neck = node('neck', pelvis, NECK_AT, 'YXZ')
  const legs = [1, -1].map((side) => {
    const hipYaw = node('hipYaw', pelvis, [side * LEG.hipW, 0, 0])
    const thigh = node('thigh', hipYaw, undefined, 'ZXY')
    const shin = node('shin', thigh, [0, -LEG.L1, 0])
    const foot = node('foot', shin, [0, -LEG.L2, 0], 'XZY')
    return { hipYaw, thigh, shin, foot }
  })
  const arms = [1, -1].map((side) => {
    const shoulder = node('shoulder', pelvis, [side * ARM.shoulderX, ARM.shoulderY, 0], 'XZY')
    const elbow = node('elbow', shoulder, [0, -ARM.upper, 0], 'XZY')
    const wrist = node('wrist', elbow, [0, -ARM.fore, 0])
    return { shoulder, elbow, wrist }
  })
  return { root, pelvis, neck, legs, arms }
}

/** Pose from a Makey pose and its 22 joints (gait.poseJoints). */
export function poseSkeleton(sk: MakeySkeleton, p: MakeyPose, q: number[]) {
  sk.pelvis.position.set(p.x, p.y, p.z)
  sk.pelvis.rotation.set(p.pitch, p.yaw, p.roll)
  // Positive neckPitch looks up (nose up = negative X); tilt rolls the head.
  sk.neck.rotation.set(-p.neckPitch, p.neckYaw, p.headTilt)
  for (let i = 0; i < 2; i++) {
    const l = sk.legs[i]!, o = i * 6
    l.hipYaw.rotation.y = q[o]!
    l.thigh.rotation.set(q[o + 2]!, 0, q[o + 1]!)
    l.shin.rotation.x = q[o + 3]!
    l.foot.rotation.set(q[o + 4]!, 0, q[o + 5]!)
    const a = sk.arms[i]!, b = i === 0 ? ARM_L : ARM_R
    a.shoulder.rotation.set(q[b]!, 0, q[b + 1]!)
    a.elbow.rotation.set(q[b + 2]!, 0, q[b + 3]!)
    a.wrist.rotation.z = q[b + 4]!
  }
}

function roundRect(w: number, h: number, r: number, cx = 0, cy = 0) {
  const s = new THREE.Shape()
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2
  s.moveTo(x0 + r, y0)
  s.lineTo(x1 - r, y0)
  s.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false)
  s.lineTo(x1, y1 - r)
  s.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false)
  s.lineTo(x0 + r, y1)
  s.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false)
  s.lineTo(x0, y0 + r)
  s.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false)
  return s
}

/** The badge's bold "M", as an outline (unit height, centred). */
function mShape(w: number, h: number) {
  const pts: [number, number][] = [[0, 0], [0.24, 0], [0.24, 0.56], [0.5, 0.26], [0.76, 0.56], [0.76, 0], [1, 0], [1, 1], [0.77, 1], [0.5, 0.64], [0.23, 1], [0, 1]]
  const s = new THREE.Shape()
  pts.forEach(([x, y], i) => (i ? s.lineTo : s.moveTo).call(s, (x - 0.5) * w, (y - 0.5) * h))
  s.closePath()
  return s
}

/** A soft round glow for the eyes (shared canvas texture). */
let glowTex: THREE.CanvasTexture | null = null
let glowRefs = 0
function glowTexture() {
  if (!glowTex) {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.35, 'rgba(255,255,255,0.45)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
    glowTex = new THREE.CanvasTexture(c)
    glowTex.colorSpace = THREE.SRGBColorSpace
  }
  glowRefs++
  return glowTex
}

interface Shared {
  body: THREE.Group
  head: THREE.Group
  eyes: THREE.BufferGeometry
  rig: RigSource
  geos: THREE.BufferGeometry[]
  refs: number
}
let shared: Shared | null = null

const UPV = new THREE.Vector3(0, 1, 0)

function build(materials: Materials): Shared {
  const geos: THREE.BufferGeometry[] = []
  const keep = <T extends THREE.BufferGeometry>(g: T) => (geos.push(g), g)

  // ── Body ──
  const ty = (TORSO.y0 + TORSO.y1) / 2
  const body = new Assembly()
    .add(keep(extrude(roundRect(TORSO.w, TORSO.y1 - TORSO.y0, TORSO.r, 0, ty), TORSO.d, 10)), 'red')
    .add(keep(discGeometry(0.031, 0.004, [], 32)), 'light', { pos: [0, 0.07, TORSO.d / 2 + 0.002] })
    .add(keep(extrude(mShape(0.036, 0.028), 0.003)), 'red', { pos: [0, 0.07, TORSO.d / 2 + 0.005] })
    .add(keep(blockGeometry(0.1, 0.024, 0.05)), 'dark', { pos: [0, 0.002, 0], edges: false })
    .add(keep(pinGeometry(0.022, 0.012).rotateX(Math.PI / 2)), 'dark', { pos: [0, 0.124, 0], edges: false })
  const bodyG = body.build(materials, 'makey-body')

  // ── Head: a lathed dome, a dark visor band, antennae with accent tips ──
  const prof: THREE.Vector2[] = [new THREE.Vector2(0.0001, 0), new THREE.Vector2(HEAD_R - 0.006, 0), new THREE.Vector2(HEAD_R, 0.006), new THREE.Vector2(HEAD_R, 0.04)]
  for (let i = 1; i <= 8; i++) {
    const a = (i / 8) * Math.PI / 2
    prof.push(new THREE.Vector2(Math.max(0.0001, HEAD_R * Math.cos(a)), 0.04 + 0.052 * Math.sin(a)))
  }
  const dome = keep(new THREE.LatheGeometry(prof, 28))
  const visorProf = [new THREE.Vector2(HEAD_R + 0.0015, 0.024), new THREE.Vector2(HEAD_R + 0.0015, 0.067)]
  const visor = keep(new THREE.LatheGeometry(visorProf, 12, -0.85, 1.7))
  const stalk = keep(pinGeometry(0.0028, 0.04).rotateX(Math.PI / 2))
  const tip = keep(new THREE.SphereGeometry(0.0085, 16, 8))
  const head = new Assembly()
    .add(dome, 'red')
    .add(visor, 'dark', { edges: false })
  for (const side of [1, -1]) {
    // Antennae lean out a little; the stalk is a straight pin.
    const lean = side * 0.32
    const bx = side * 0.026, by = 0.088
    head.add(stalk, 'dark', { pos: [bx + Math.sin(lean) * 0.02, by + Math.cos(lean) * 0.02, 0], rot: [0, 0, -lean], edges: false })
    head.add(tip, 'accent', { pos: [bx + Math.sin(lean) * 0.042, by + Math.cos(lean) * 0.042, 0], edges: false })
    // Ear bolts.
    head.add(keep(pinGeometry(0.012, 0.008).rotateY(Math.PI / 2)), 'dark', { pos: [side * (HEAD_R + 0.002), 0.045, 0], edges: false })
  }
  const headG = head.build(materials, 'makey-head')

  // Eyes: two amber discs on the visor, facing out along the head's curve.
  const eyeParts: THREE.BufferGeometry[] = []
  for (const side of [1, -1]) {
    const a = Math.asin(side * EYE.x / HEAD_R)
    const g = discGeometry(EYE.r, 0.003, [], 24)
    g.translate(0, 0, 0.0015)
    g.applyMatrix4(new THREE.Matrix4().makeRotationAxis(UPV, a))
    g.translate(Math.sin(a) * (HEAD_R + 0.002), EYE.y, Math.cos(a) * (HEAD_R + 0.002))
    eyeParts.push(g)
  }
  const eyes = mergeSimple(eyeParts)

  // ── Limbs (rig) ── nodes: 0-2 left shoulder/elbow/wrist, 3-5 right, 6-8 left thigh/shin/foot, 9-11 right.
  const rig = new RigSource()
  const pad = keep(new THREE.SphereGeometry(0.025, 20, 12).scale(1, 0.75, 1))
  const upper = keep(new THREE.CylinderGeometry(0.0145, 0.0145, ARM.upper, 20).translate(0, -ARM.upper / 2, 0))
  const fore = keep(new THREE.CylinderGeometry(0.0155, 0.0155, ARM.fore, 20).translate(0, -ARM.fore / 2, 0))
  const joint = keep(new THREE.SphereGeometry(0.0165, 16, 10))
  const hand = keep(extrude(roundRect(0.026, 0.03, 0.011, 0, -0.015), 0.019, 6))
  const thighG = keep(new THREE.CylinderGeometry(0.017, 0.017, LEG.L1, 20).translate(0, -LEG.L1 / 2, 0))
  const shinG = keep(new THREE.CylinderGeometry(0.018, 0.018, LEG.L2, 20).translate(0, -LEG.L2 / 2, 0))
  const footProf = new THREE.Shape()
  {
    const z0 = LEG.heel - 0.006, z1 = LEG.toe + 0.006, y0 = -LEG.ankleH + 0.004, y1 = -LEG.ankleH + 0.03
    footProf.moveTo(z0 + 0.012, y0)
    footProf.lineTo(z1 - 0.014, y0)
    footProf.absarc(z1 - 0.014, y0 + 0.014, 0.014, -Math.PI / 2, Math.PI / 2, false)
    footProf.lineTo(z0 + 0.012, y1)
    footProf.absarc(z0 + 0.012, y1 - 0.012, 0.012, Math.PI / 2, Math.PI, false)
    footProf.lineTo(z0, y0 + 0.012)
    footProf.absarc(z0 + 0.012, y0 + 0.012, 0.012, Math.PI, Math.PI * 1.5, false)
  }
  const footG = keep(orientZY(extrude(footProf, 2 * LEG.footHalfW, 8)))
  const sole = keep(blockGeometry(2 * LEG.footHalfW - 0.004, 0.004, LEG.toe - LEG.heel + 0.008))
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 1 : -1
    const a = s * 3, l = 6 + s * 3
    rig.add(a, pad, 'red', { pos: [0, 0.004, 0], edges: false })
    rig.add(a, upper, 'mid', { edges: false })
    rig.add(a, joint, 'dark', { pos: [0, -ARM.upper, 0] })
    rig.add(a + 1, fore, 'mid', { edges: false })
    rig.add(a + 2, hand, 'light', { pos: [side * 0.0, 0, 0] })
    rig.add(l, joint, 'dark', { pos: [0, 0, 0] })
    rig.add(l, thighG, 'mid', { edges: false })
    rig.add(l, joint, 'dark', { pos: [0, -LEG.L1, 0] })
    rig.add(l + 1, shinG, 'mid', { edges: false })
    rig.add(l + 2, footG, 'red')
    rig.add(l + 2, sole, 'dark', { pos: [0, -LEG.ankleH + 0.002, (LEG.toe + LEG.heel) / 2] })
  }
  return { body: bodyG, head: headG, eyes, rig, geos, refs: 0 }
}

/** Profile drawn in (forward, up), extruded across: shape X -> Z, shape Y -> Y. */
function orientZY(g: THREE.BufferGeometry) {
  const x = new THREE.Vector3(0, 0, 1), y = new THREE.Vector3(0, 1, 0)
  g.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, x.clone().cross(y)))
  return g
}

function mergeSimple(parts: THREE.BufferGeometry[]) {
  const nonIdx = parts.map(p => (p.index ? p.toNonIndexed() : p))
  let n = 0
  for (const p of nonIdx) n += p.attributes.position!.count
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3)
  let o = 0
  for (const p of nonIdx) {
    pos.set(p.attributes.position!.array as Float32Array, o)
    nrm.set(p.attributes.normal!.array as Float32Array, o)
    o += p.attributes.position!.count * 3
  }
  parts.forEach(p => p.dispose())
  nonIdx.forEach(p => p.dispose())
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  return g
}

function instance(tpl: THREE.Group, materials: Materials) {
  const g = tpl.clone()
  g.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh && !(o as THREE.LineSegments).isLineSegments) return
    const key = o.name.slice(o.name.lastIndexOf(':') + 1)
    m.material = key === 'lines' ? materials.line : materials.face[key as MatKey]
  })
  return g
}

export const EYE_DIM = new THREE.Color('#7A4A0C')
export const EYE_BRIGHT = new THREE.Color('#FFC23A')

export interface MakeyParts {
  rig: Rig
  meshes: THREE.Mesh[]
  /** Antenna tips: the robot's accent. */
  tips: THREE.Mesh | undefined
  setGlow(k: number): void
  dispose(): void
}

export function buildMakey(materials: Materials, accent: MatKey, sk: MakeySkeleton): MakeyParts {
  if (!shared) shared = build(materials)
  const S = shared
  S.refs++
  const body = instance(S.body, materials)
  sk.pelvis.add(body)
  const head = instance(S.head, materials)
  sk.neck.add(head)
  const tips = head.getObjectByName('makey-head:accent') as THREE.Mesh | undefined
  if (tips) tips.material = materials.face[accent]

  // Per robot: its own eye materials, so each one's eyes can brighten on their own.
  const eyeMat = new THREE.MeshBasicMaterial({ color: EYE_BRIGHT.clone() })
  const eyes = new THREE.Mesh(S.eyes, eyeMat)
  eyes.name = 'makey-eyes'
  head.add(eyes)
  const glowMat = new THREE.SpriteMaterial({ map: glowTexture(), color: EYE_BRIGHT.clone(), transparent: true, depthWrite: false, opacity: 0.6 })
  const glows: THREE.Sprite[] = []
  for (const side of [1, -1]) {
    const a = Math.asin(side * EYE.x / HEAD_R)
    const sp = new THREE.Sprite(glowMat)
    sp.position.set(Math.sin(a) * (HEAD_R + 0.008), EYE.y, Math.cos(a) * (HEAD_R + 0.008))
    sp.scale.setScalar(0.05)
    sp.renderOrder = 2
    head.add(sp)
    glows.push(sp)
  }

  const nodes = [
    ...sk.arms.flatMap(a => [a.shoulder, a.elbow, a.wrist]),
    ...sk.legs.flatMap(l => [l.thigh, l.shin, l.foot]),
  ]
  const rig = new Rig(S.rig, nodes, materials, sk.root, 'makey-limbs')
  const meshes: THREE.Mesh[] = []
  for (const g of [body, head]) g.traverse(o => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh))
  let disposed = false
  return {
    rig,
    meshes,
    tips,
    setGlow(k: number) {
      const t = Math.min(1, Math.max(0, k))
      eyeMat.color.copy(EYE_DIM).lerp(EYE_BRIGHT, t)
      glowMat.opacity = 0.12 + 0.6 * t * t
      const s = 0.035 + 0.03 * t
      glows[0]!.scale.setScalar(s)
      glows[1]!.scale.setScalar(s)
    },
    dispose() {
      if (disposed) return
      disposed = true
      rig.dispose()
      body.removeFromParent()
      head.removeFromParent()
      eyeMat.dispose()
      glowMat.dispose()
      if (--glowRefs === 0 && glowTex) {
        glowTex.dispose()
        glowTex = null
      }
      if (--S.refs === 0 && shared === S) {
        S.geos.forEach(g => g.dispose())
        S.eyes.dispose()
        S.body.traverse(o => (o as THREE.Mesh).geometry?.dispose())
        S.head.traverse(o => (o as THREE.Mesh).geometry?.dispose())
        shared = null
      }
    },
  }
}
