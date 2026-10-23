import * as THREE from 'three'
import { Assembly, beamGeometry, blockGeometry, discGeometry, extrude, pinGeometry, type MatKey, type Materials } from '../../core/kit'
import { DOG, legFore, legSide } from './ik'
import { Rig, RigSource } from './rig'
import type { DogPose } from './gait'

/**
 * The dog's body, after the Unitree Go2 (drawn at 0.6 scale) in the kit's
 * straight-beam language:
 * - a long mid-grey trunk with rounded ends, a dark battery belly and a
 *   slotted light rail down each flank;
 * - at each corner a dark abduction motor drum on the hip axis;
 * - thighs are light slotted links hung OUTBOARD of the trunk from a dark
 *   hip motor with a RED drive cap (red = drive input); calves are dark slotted links ending in round
 *   pads; every knee points backward, as on the real machine;
 * - a head with a dark sensor face (two camera lenses) and the dome of the
 *   spinning lidar under its chin; the head's top shell carries the robot's
 *   one accent. No tail.
 *
 * Draw calls: trunk 4 (mid, dark, light, lines), head 4 (accent, dark,
 * light, lines), all twelve leg parts through one Rig 4 (light, dark, red,
 * lines), contact shadow 1, selection ring 1 (only when selected) = 14.
 */

export interface DogSkeleton {
  root: THREE.Group
  body: THREE.Group
  head: THREE.Group
  legs: { abd: THREE.Group, thigh: THREE.Group, calf: THREE.Group }[]
}

const node = (name: string, parent?: THREE.Object3D, pos?: [number, number, number], order?: THREE.EulerOrder) => {
  const g = new THREE.Group()
  g.name = name
  if (pos) g.position.set(...pos)
  if (order) g.rotation.order = order
  parent?.add(g)
  return g
}

/** Head pivot in the body frame: on the front of the trunk, near the top. */
export const HEAD_AT: [number, number, number] = [0, 0.012, 0.172]

export function createSkeleton(): DogSkeleton {
  const root = node('dog')
  const body = node('body', root, undefined, 'YXZ')
  const head = node('head', body, HEAD_AT, 'YXZ')
  const legs = [0, 1, 2, 3].map((i) => {
    const abd = node('abd', body, [legSide(i) * DOG.hipX, 0, legFore(i) * DOG.hipZ])
    const thigh = node('thigh', abd, [legSide(i) * DOG.d, 0, 0])
    const calf = node('calf', thigh, [0, -DOG.L1, 0])
    return { abd, thigh, calf }
  })
  return { root, body, head, legs }
}

/** Pose the skeleton from a dog pose and its 12 joint angles (gait.poseJoints). */
export function poseSkeleton(sk: DogSkeleton, p: DogPose, q: number[]) {
  sk.body.position.set(p.x, p.y, p.z)
  sk.body.rotation.set(p.pitch, p.yaw, p.roll)
  // Head: pan then tilt; a positive headPitch looks up (nose up = negative X rotation).
  sk.head.rotation.set(-p.headPitch, p.headYaw, 0)
  for (let i = 0; i < 4; i++) {
    const l = sk.legs[i]!
    l.abd.rotation.z = q[3 * i]!
    l.thigh.rotation.x = q[3 * i + 1]!
    l.calf.rotation.x = q[3 * i + 2]!
  }
}

/** Re-axis a kit geometry: its local +X goes to `x`, +Y to `y`. */
function orient(g: THREE.BufferGeometry, x: [number, number, number], y: [number, number, number]) {
  const vx = new THREE.Vector3(...x)
  const vy = new THREE.Vector3(...y)
  g.applyMatrix4(new THREE.Matrix4().makeBasis(vx, vy, vx.clone().cross(vy)))
  return g
}
const DOWN: [number, number, number] = [0, -1, 0]
const FWD: [number, number, number] = [0, 0, 1]
const LEFT: [number, number, number] = [1, 0, 0]
const UP: [number, number, number] = [0, 1, 0]

/**
 * The kit's slotted beam with fewer arc segments: the limbs are re-posed on
 * the CPU every frame (rig.ts), so their vertex count is a per-frame cost.
 */
function leanBeam(length: number, width: number, thickness: number, slots: [number, number][], holes: number[], seg: number) {
  const r = width / 2
  const shape = new THREE.Shape()
  shape.absarc(length, 0, r, -Math.PI / 2, Math.PI / 2, false)
  shape.absarc(0, 0, r, Math.PI / 2, Math.PI * 1.5, false)
  shape.closePath()
  for (const x of holes) {
    const h = new THREE.Path()
    h.absarc(x, 0, width * 0.18, 0, Math.PI * 2, true)
    shape.holes.push(h)
  }
  const sr = width * 0.14
  for (const [a, b] of slots) {
    const p = new THREE.Path()
    p.absarc(b, 0, sr, -Math.PI / 2, Math.PI / 2, false)
    p.absarc(a, 0, sr, Math.PI / 2, Math.PI * 1.5, false)
    p.closePath()
    shape.holes.push(p)
  }
  return extrude(shape, thickness, seg)
}

/** A rounded rectangle in the (forward, up) plane, extruded across the body. */
function sideProfile(z0: number, z1: number, y0: number, y1: number, r: number, width: number, seg = 8) {
  const s = new THREE.Shape()
  s.moveTo(z0 + r, y0)
  s.lineTo(z1 - r, y0)
  s.absarc(z1 - r, y0 + r, r, -Math.PI / 2, 0, false)
  s.lineTo(z1, y1 - r)
  s.absarc(z1 - r, y1 - r, r, 0, Math.PI / 2, false)
  s.lineTo(z0 + r, y1)
  s.absarc(z0 + r, y1 - r, r, Math.PI / 2, Math.PI, false)
  s.lineTo(z0, y0 + r)
  s.absarc(z0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false)
  return orient(extrude(s, width, seg), FWD, UP)
}

interface Shared {
  trunk: THREE.Group
  head: THREE.Group
  rig: RigSource
  geos: THREE.BufferGeometry[]
  refs: number
}

/**
 * Geometry is built ONCE per page (module cache, reference counted) and
 * shared by every dog: trunk and head assemblies are cloned (Group.clone
 * shares geometry), the limbs' source vertices are shared by every Rig.
 */
let shared: Shared | null = null

function build(materials: Materials): Shared {
  const geos: THREE.BufferGeometry[] = []
  const keep = <T extends THREE.BufferGeometry>(g: T) => (geos.push(g), g)

  // ── Trunk ──
  const trunk = new Assembly()
    .add(keep(sideProfile(-0.18, 0.18, -0.03, 0.045, 0.026, 0.11)), 'mid')
    .add(keep(sideProfile(-0.15, 0.13, -0.046, -0.02, 0.012, 0.075)), 'dark', { edges: false })
  const rail = keep(orient(beamGeometry({ length: 0.26, width: 0.026, thickness: 0.006, holes: [0, 0.13, 0.26], slots: [[0.025, 0.105], [0.155, 0.235]] }), FWD, UP))
  // Abduction motors: dark drums on the hip axes, standing proud of the trunk ends.
  const drum = keep(orient(pinGeometry(0.02, 0.016), UP, LEFT))
  for (const side of [1, -1]) {
    trunk.add(rail, 'light', { pos: [side * 0.058, 0.01, -0.13] })
    trunk.add(drum, 'dark', { pos: [side * DOG.hipX, -0.008, -0.184], edges: false })
  }
  // A handle bar on the back (the Go2's top rail), straight and pinned.
  trunk.add(keep(orient(beamGeometry({ length: 0.14, width: 0.018, thickness: 0.008, slots: [[0.03, 0.11]] }), FWD, LEFT)), 'light', { pos: [0, 0.049, -0.09] })
  const trunkG = trunk.build(materials, 'dog-trunk')

  // ── Head: accent top shell, dark sensor face, lidar dome under the chin ──
  // The Go2's head is the trunk's rounded nose: a dark glass sensor face with
  // a stereo camera pair, and the spinning lidar dome under the chin.
  const head = new Assembly()
    .add(keep(sideProfile(-0.012, 0.05, -0.024, 0.038, 0.022, 0.1)), 'accent')
    .add(keep(blockGeometry(0.084, 0.036, 0.008)), 'dark', { pos: [0, 0.009, 0.05], edges: false })
  const lens = keep(discGeometry(0.0075, 0.003, [{ x: 0, y: 0, r: 0.0048 }], 20))
  for (const x of [-0.016, 0.016]) head.add(lens, 'light', { pos: [x, 0.012, 0.055] })
  const dome = new THREE.SphereGeometry(0.02, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2)
  dome.rotateX(Math.PI)
  head.add(keep(dome), 'dark', { pos: [0, -0.024, 0.026], edges: false })
  head.add(keep(orient(discGeometry(0.022, 0.004, [{ x: 0, y: 0, r: 0.018 }], 24), LEFT, FWD)), 'light', { pos: [0, -0.026, 0.026] })
  const headG = head.build(materials, 'dog-head')

  // ── Limbs (rig) ── nodes: 0..3 thighs, 4..7 calves.
  const rig = new RigSource()
  const motor = keep(orient(pinGeometry(0.027, 0.03), LEFT, UP))
  const motorCap = keep(orient(discGeometry(0.02, 0.006, [], 20), LEFT, UP))
  const thighBeam = keep(orient(leanBeam(DOG.L1, 0.032, 0.014, [[0.03, DOG.L1 - 0.03]], [0, DOG.L1], 5), DOWN, FWD))
  // Calves are dark: their slots would not read, so they are plain rounded bars.
  const calfBeam = keep(orient(leanBeam(DOG.L2 - 0.004, 0.02, 0.011, [], [], 4), DOWN, FWD))
  const kneePin = keep(orient(pinGeometry(0.0065, 0.04), LEFT, UP))
  const pad = keep(new THREE.SphereGeometry(DOG.footR, 12, 6))
  for (let i = 0; i < 4; i++) {
    const s = legSide(i)
    rig.add(i, motor, 'dark', { pos: [-s * 0.006, 0, 0] })
    rig.add(i, motorCap, 'red', { pos: [s * 0.012, 0, 0] })
    rig.add(i, thighBeam, 'light', { pos: [s * 0.002, 0, 0] })
    rig.add(i, kneePin, 'light', { pos: [0, -DOG.L1, 0] })
    rig.add(4 + i, calfBeam, 'dark', { pos: [-s * 0.012, 0, 0] })
    rig.add(4 + i, pad, 'dark', { pos: [-s * 0.012, -DOG.L2, 0] })
  }
  return { trunk: trunkG, head: headG, rig, geos, refs: 0 }
}

/** Clone a template assembly onto this slot's materials (materials are per slot). */
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

export interface DogParts {
  rig: Rig
  /** Rigid meshes for picking. */
  meshes: THREE.Mesh[]
  headShell: THREE.Mesh | undefined
  dispose(): void
}

export function buildDog(materials: Materials, accent: MatKey, sk: DogSkeleton): DogParts {
  if (!shared) shared = build(materials)
  const S = shared
  S.refs++
  const trunk = instance(S.trunk, materials)
  sk.body.add(trunk)
  const head = instance(S.head, materials)
  sk.head.add(head)
  const headShell = head.getObjectByName('dog-head:accent') as THREE.Mesh | undefined
  if (headShell) headShell.material = materials.face[accent]
  const nodes = [...sk.legs.map(l => l.thigh), ...sk.legs.map(l => l.calf)]
  const rig = new Rig(S.rig, nodes, materials, sk.root, 'dog-legs')
  const meshes: THREE.Mesh[] = []
  for (const g of [trunk, head]) g.traverse(o => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh))
  let disposed = false
  return {
    rig,
    meshes,
    headShell,
    dispose() {
      if (disposed) return
      disposed = true
      rig.dispose()
      trunk.removeFromParent()
      head.removeFromParent()
      if (--S.refs === 0 && shared === S) {
        S.geos.forEach(g => g.dispose())
        S.trunk.traverse(o => (o as THREE.Mesh).geometry?.dispose())
        S.head.traverse(o => (o as THREE.Mesh).geometry?.dispose())
        shared = null
      }
    },
  }
}
