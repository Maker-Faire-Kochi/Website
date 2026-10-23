import * as THREE from 'three'
import {
  Assembly, beamGeometry, blockGeometry, contactShadow, discGeometry, extrude, pinGeometry,
  type MatKey, type Materials,
} from '../core/kit'
import { rng } from '../core/rng'
import { KiteSim, MobileSim, PendulumSim, RockSim, catenary, type MobileLevel, type V3 } from './props-sim'

/**
 * Art and craft props for the fair, in the kit's language: straight slotted
 * members and plain pins for anything built (easel, stands, shelf, bracket),
 * natural curves only where the thing itself is natural (a pot's belly, a
 * hanging string). Neutral faces; the kite carries the one beam-blue accent.
 *
 * Every prop has the same small contract as a person: a root to add, a
 * footprint radius, fixed-step `step(dt)` with `frame(alpha)` interpolation,
 * `react()` for a tap (and its keyboard equivalent), `hit(ray)` for picking,
 * `setSelected()` for the cyan hover marker, and `dispose()` for the geometry
 * it built. Props that feel air also take `wind(vx, vz)`: the pointer's
 * ground-plane velocity, world units per second.
 */

export interface ArtProp {
  readonly kind: 'easel' | 'mobile' | 'kite' | 'pottery' | 'lantern'
  readonly root: THREE.Group
  readonly radius: number
  step(dt: number): void
  frame(alpha: number): void
  setPaused(paused: boolean): void
  hit(ray: THREE.Raycaster): boolean
  /** Tap / keyboard reaction. `ray` (optional) says where it was tapped. Returns a short status. */
  react(ray?: THREE.Raycaster): string
  wind?(vx: number, vz: number): void
  setSelected(on: boolean): void
  dispose(): void
}

export interface PropContext {
  materials: Materials
  posterMode?: boolean
}

const TAU = Math.PI * 2
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()

/** Pose for a kit beam (it lies along +X from its first pin) running from a to b, its flat face toward `face`. */
function strut(a: V3, b: V3, face: V3 = [0, 0, 1]) {
  _x.set(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  const length = _x.length()
  _x.normalize()
  _z.set(...face)
  _z.addScaledVector(_x, -_z.dot(_x)).normalize()
  _y.crossVectors(_z, _x)
  _m.makeBasis(_x, _y, _z)
  _e.setFromQuaternion(_q.setFromRotationMatrix(_m))
  return { length, pos: a, rot: [_e.x, _e.y, _e.z] as [number, number, number] }
}

/** Geometries a prop built, disposed with it. */
class Owned {
  list: THREE.BufferGeometry[] = []
  add<T extends THREE.BufferGeometry>(g: T) {
    this.list.push(g)
    return g
  }

  dispose(root: THREE.Object3D) {
    // Assembly output: merged per build, owned here too.
    root.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
      if (g && !this.list.includes(g)) this.list.push(g)
    })
    this.list.forEach(g => g.dispose())
    this.list.length = 0
  }
}

function meshesOf(root: THREE.Object3D, skip: THREE.Object3D[]) {
  const out: THREE.Object3D[] = []
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !skip.includes(o)) out.push(o)
  })
  return out
}

function selectRing(m: Materials, own: Owned, r: number) {
  const g = own.add(new THREE.RingGeometry(r, r + 0.025, 48))
  g.rotateX(-Math.PI / 2)
  const ring = new THREE.Mesh(g, m.face.cyan)
  ring.position.y = 0.002
  ring.visible = false
  return ring
}

/** Cross feet for a free-standing upright: two crossed beams on the ground with a pin. */
function crossFeet(asm: Assembly, own: Owned, span: number, mat: MatKey) {
  const foot = own.add(beamGeometry({ length: span, width: 0.05, thickness: 0.024, holes: [0, span / 2, span] }))
  asm.add(foot, mat, { pos: [-span / 2, 0.025, 0.014], rot: [0, 0, 0] })
  asm.add(foot, mat, { pos: [0, 0.025, span / 2], rot: [0, Math.PI / 2, 0] })
}

// ── Easel with a plotted drawing ──────────────────────────────────────────

/**
 * An A-frame easel with a sheet on it, and on the sheet a harmonograph trace --
 * the kind of single-line drawing a pen plotter at the fair produces. It plots
 * itself on arrival and redraws a new figure on each tap, the pen riding the
 * line end while it draws.
 */
export function createEasel(ctx: PropContext, opts: { seed?: number } = {}): ArtProp {
  const M = ctx.materials
  const own = new Owned()
  const R = rng((opts.seed ?? 3) * 977 + 1)
  const root = new THREE.Group()
  root.name = 'easel'

  const asm = new Assembly()
  const legs: [V3, V3][] = [
    [[-0.3, 0, 0.2], [-0.04, 1.58, -0.02]],
    [[0.3, 0, 0.2], [0.04, 1.58, -0.02]],
  ]
  for (const [a, b] of legs) {
    const s = strut(a, b, [0, 0, 1])
    const g = own.add(beamGeometry({ length: s.length, width: 0.04, thickness: 0.022, slots: [[0.55, 0.95]] }))
    asm.add(g, 'wood', { pos: s.pos, rot: s.rot })
  }
  {
    const s = strut([0, 0, -0.5], [0, 1.52, -0.05], [1, 0, 0])
    asm.add(own.add(beamGeometry({ length: s.length, width: 0.04, thickness: 0.022 })), 'wood', { pos: s.pos, rot: s.rot })
  }
  const pin = own.add(pinGeometry(0.012, 0.11))
  asm.add(pin, 'light', { pos: [0, 1.555, -0.015] })
  // The ledge the board stands on, pinned through the legs' slots.
  const tilt = Math.atan2(0.22, 1.58)
  const ledgeY = 0.74
  const ledgeZ = 0.2 - 0.22 * (ledgeY / 1.58) + 0.035
  asm.add(own.add(beamGeometry({ length: 0.76, width: 0.045, thickness: 0.022, holes: [0.11, 0.65] })), 'woodDark', { pos: [-0.38, ledgeY, ledgeZ], rot: [-Math.PI / 2, 0, 0] })
  asm.add(pin, 'light', { pos: [-0.27, ledgeY, ledgeZ - 0.02], rot: [0, 0, 0] })
  asm.add(pin, 'light', { pos: [0.27, ledgeY, ledgeZ - 0.02], rot: [0, 0, 0] })
  // Board and sheet, leaning back with the legs.
  const BW = 0.66, BH = 0.52
  const board = new THREE.Group()
  board.position.set(0, ledgeY + 0.012, ledgeZ + 0.01)
  board.rotation.x = -tilt
  const boardAsm = new Assembly()
    .add(own.add(blockGeometry(BW, BH, 0.016)), 'woodDark', { pos: [0, BH / 2, 0] })
    .add(own.add(blockGeometry(BW - 0.07, BH - 0.08, 0.003)), 'light', { pos: [0, BH / 2 + 0.01, 0.0095] })
  root.add(asm.build(M, 'easel'), board)
  board.add(boardAsm.build(M, 'easel-board'))

  // The drawing: a damped two-pendulum harmonograph, on the sheet's face.
  const N = 900
  const pos = new Float32Array(N * 3)
  const lineGeo = own.add(new THREE.BufferGeometry())
  lineGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const drawing = new THREE.Line(lineGeo, M.line)
  drawing.position.set(0, BH / 2 + 0.01, 0.0115)
  drawing.frustumCulled = false
  board.add(drawing)
  const pen = new THREE.Mesh(own.add(pinGeometry(0.006, 0.05)), M.face.dark)
  pen.geometry.translate(0, 0, 0.025)
  board.add(pen)

  const halfW = (BW - 0.07) / 2 - 0.03, halfH = (BH - 0.08) / 2 - 0.03
  function plot() {
    const f1 = R.range(1.9, 2.1), f2 = R.range(2.9, 3.1), f3 = R.range(1.95, 2.05)
    const p1 = R.range(0, TAU), p2 = R.range(0, TAU), p3 = R.range(0, TAU)
    const dmp = R.range(0.012, 0.022)
    for (let i = 0; i < N; i++) {
      const t = (i / N) * 60
      const e = Math.exp(-dmp * t)
      const x = (0.6 * Math.sin(f1 * t + p1) + 0.4 * Math.sin(f2 * t + p2)) * e
      const y = (0.6 * Math.sin(f3 * t + p3) + 0.4 * Math.sin(f1 * t + p2 * 0.5)) * e
      pos[i * 3] = x * halfW
      pos[i * 3 + 1] = y * halfH
      pos[i * 3 + 2] = 0
    }
    lineGeo.attributes.position!.needsUpdate = true
    lineGeo.computeBoundingSphere()
  }
  plot()

  const PLOT_TIME = 4
  let tPlot = ctx.posterMode ? PLOT_TIME : 0
  let prevT = tPlot
  const shadow = contactShadow(M, 0.5)
  const ring = selectRing(M, own, 0.5)
  root.add(shadow, ring)
  own.add(shadow.geometry)
  const pickable = meshesOf(root, [shadow, ring, pen])

  function show(t: number) {
    const k = Math.min(1, t / PLOT_TIME)
    // Ease in/out so the pen starts and stops like a plotter carriage.
    const e = k * k * (3 - 2 * k)
    const n = Math.max(2, Math.floor(e * N))
    lineGeo.setDrawRange(0, n)
    pen.visible = k < 1
    const i = Math.min(N - 1, n - 1)
    pen.position.set(pos[i * 3]!, pos[i * 3 + 1]! + BH / 2 + 0.01, 0.012)
  }

  return {
    kind: 'easel',
    root,
    radius: 0.45,
    step(dt) {
      prevT = tPlot
      if (!ctx.posterMode) tPlot = Math.min(PLOT_TIME, tPlot + dt)
    },
    frame(alpha) {
      show(prevT + (tPlot - prevT) * alpha)
    },
    setPaused() {},
    hit(ray) {
      return ray.intersectObjects(pickable, false).length > 0
    },
    react() {
      plot()
      tPlot = prevT = 0
      return 'The plotter draws a new figure.'
    },
    setSelected(on) {
      ring.visible = on
    },
    dispose() {
      own.dispose(root)
      root.removeFromParent()
    },
  }
}

// ── Kinetic mobile ────────────────────────────────────────────────────────

interface LevelSpec { L: number, rA: number, rB?: number, matA: MatKey, matB?: MatKey, thread: number }

/**
 * A Calder-style mobile on a stand: straight beams, each hung at its true
 * balance point (computed from the discs and the levels below it), each level
 * turning on its thread with damped torsion physics. Pointer motion is wind;
 * a tap sets it turning.
 */
export function createMobile(ctx: PropContext, opts: { seed?: number } = {}): ArtProp {
  const M = ctx.materials
  const own = new Owned()
  const root = new THREE.Group()
  root.name = 'mobile'
  const seed = opts.seed ?? 5

  // Stand: upright, cross feet, and an arm with a pinned brace (a triangle, so it is plausibly stiff).
  const STAND_H = 2.3, ARM = 0.62
  const stand = new Assembly()
  crossFeet(stand, own, 0.7, 'dark')
  {
    const s = strut([0, 0, 0], [0, STAND_H, 0], [0, 0, 1])
    stand.add(own.add(beamGeometry({ length: s.length, width: 0.05, thickness: 0.026, holes: [0.03, STAND_H - 0.3, STAND_H - 0.03] })), 'dark', { pos: s.pos, rot: s.rot })
    const arm = strut([-0.03, STAND_H - 0.03, 0.028], [ARM, STAND_H - 0.03, 0.028])
    stand.add(own.add(beamGeometry({ length: arm.length, width: 0.04, thickness: 0.02, holes: [0.03, 0.33, arm.length - 0.03] })), 'dark', { pos: arm.pos, rot: arm.rot })
    const br = strut([0, STAND_H - 0.3, 0.05], [0.3, STAND_H - 0.03, 0.05])
    stand.add(own.add(beamGeometry({ length: br.length, width: 0.032, thickness: 0.016 })), 'mid', { pos: br.pos, rot: br.rot })
    const pin = own.add(pinGeometry(0.011, 0.1))
    stand.add(pin, 'light', { pos: [0, STAND_H - 0.03, 0.028] })
    stand.add(pin, 'light', { pos: [0, STAND_H - 0.3, 0.03] })
    stand.add(pin, 'light', { pos: [0.3, STAND_H - 0.03, 0.04] })
  }
  root.add(stand.build(M, 'mobile-stand'))

  const specs: LevelSpec[] = [
    { L: 0.72, rA: 0.12, matA: 'light', thread: 0.28 },
    { L: 0.52, rA: 0.085, matA: 'wood', thread: 0.24 },
    { L: 0.36, rA: 0.06, rB: 0.07, matA: 'stone', matB: 'mid', thread: 0.2 },
  ]
  // Balance, bottom-up: mass of each subtree and the hang point that balances it.
  const discMass = (r: number) => 9 * r * r
  const beamMass = (L: number) => 0.06 * L
  const subMass: number[] = []
  const pivot: number[] = []
  const levels: MobileLevel[] = []
  for (let i = specs.length - 1; i >= 0; i--) {
    const s = specs[i]!
    const mA = discMass(s.rA)
    const mB = s.rB ? discMass(s.rB) : subMass[i + 1]!
    const mb = beamMass(s.L)
    const total = mA + mB + mb
    const p = (mb * s.L / 2 + mB * s.L) / total
    pivot[i] = p
    subMass[i] = total
    const xA = -p, xB = s.L - p
    const aA = Math.PI * s.rA * s.rA
    const aB = s.rB ? Math.PI * s.rB * s.rB : 0.6 * Math.PI * specs[i + 1]!.rA ** 2
    levels[i] = {
      areaArm: (aA * xA + aB * xB) / (aA + aB),
      area: 0.06 * (aA + aB),
      inertia: mA * xA * xA + mB * xB * xB + mb * (s.L * s.L / 12 + (s.L / 2 - p) ** 2),
    }
  }
  const sim = new MobileSim(levels, seed, !ctx.posterMode)

  const hang = new THREE.Group()
  hang.position.set(ARM - 0.03, STAND_H - 0.03, 0.028)
  root.add(hang)
  const nodes: THREE.Group[] = []
  let parent: THREE.Object3D = hang
  const threadGeo = (len: number) => {
    const g = own.add(pinGeometry(0.0022, len))
    g.rotateX(Math.PI / 2)
    g.translate(0, len / 2, 0)
    return g
  }
  const pinS = own.add(pinGeometry(0.008, 0.03))
  specs.forEach((s, i) => {
    const node = new THREE.Group()
    const p = pivot[i]!
    node.position.set(i === 0 ? 0 : specs[i - 1]!.L - pivot[i - 1]!, -s.thread, 0)
    node.rotation.y = (i * 1.3 + seed) % TAU
    const a = new Assembly()
    a.add(own.add(beamGeometry({ length: s.L, width: 0.026, thickness: 0.008, holes: [0, p, s.L] })), 'dark', { pos: [-p, 0, 0] })
    a.add(threadGeo(s.thread), 'dark', { edges: false })
    a.add(pinS, 'light', { pos: [0, 0, 0] })
    const disc = (r: number, x: number, mat: MatKey) => {
      a.add(own.add(discGeometry(r, 0.006, [{ x: 0, y: r - 0.018, r: 0.006 }])), mat, { pos: [x, -r + 0.006, 0.01] })
      a.add(pinS, 'light', { pos: [x, 0, 0.004] })
    }
    disc(s.rA, -p, s.matA)
    if (s.rB) disc(s.rB, s.L - p, s.matB!)
    else a.add(pinS, 'light', { pos: [s.L - p, 0, 0] })
    node.add(a.build(M, `mobile-${i}`))
    parent.add(node)
    nodes.push(node)
    parent = node
  })
  const base = nodes.map(n => n.rotation.y)
  // Bake the initial yaw into the sim's rest so the drawing starts as composed.
  const prev = { th: sim.theta.slice(), sw: sim.sway.slice() }
  const shadow = contactShadow(M, 0.45)
  shadow.position.set(0.3, 0, 0)
  const ring = selectRing(M, own, 0.55)
  ring.position.x = 0.3
  root.add(shadow, ring)
  own.add(shadow.geometry)
  const pickable = meshesOf(root, [shadow, ring])

  return {
    kind: 'mobile',
    root,
    radius: 0.55,
    step(dt) {
      prev.th = sim.theta.slice()
      prev.sw = sim.sway.slice()
      if (!ctx.posterMode) sim.step(dt)
    },
    frame(alpha) {
      nodes.forEach((n, i) => { n.rotation.y = base[i]! + prev.th[i]! + (sim.theta[i]! - prev.th[i]!) * alpha })
      hang.rotation.x = prev.sw[0]! + (sim.sway[0]! - prev.sw[0]!) * alpha
      hang.rotation.z = prev.sw[1]! + (sim.sway[1]! - prev.sw[1]!) * alpha
    },
    setPaused(p) {
      if (p) sim.windX = sim.windZ = 0
    },
    hit(ray) {
      return ray.intersectObjects(pickable, false).length > 0
    },
    react() {
      sim.push(1)
      return 'The mobile turns.'
    },
    wind(vx, vz) {
      sim.wind(vx, vz)
    },
    setSelected(on) {
      ring.visible = on
    },
    dispose() {
      own.dispose(root)
      root.removeFromParent()
    },
  }
}

// ── Kite on a string ──────────────────────────────────────────────────────

/**
 * A diamond kite on straight spars, flown on a string drawn as a true
 * catenary from the flyer's hand. Its flight is a small physical model
 * (props-sim KiteSim); it flutters with the gusts, and a tap tugs the line.
 * Anchor it to a person's hand with setAnchor() every step.
 */
export interface Kite extends ArtProp {
  setAnchor(p: THREE.Vector3): void
  readonly sim: KiteSim
}

export function createKite(ctx: PropContext, opts: { seed?: number, anchor?: THREE.Vector3, line?: number, windDir?: [number, number] } = {}): Kite {
  const M = ctx.materials
  const own = new Owned()
  const seed = opts.seed ?? 9
  const R = rng(seed * 131 + 7)
  const root = new THREE.Group()
  root.name = 'kite'
  const a0 = opts.anchor ?? new THREE.Vector3(0, 1, 0)
  const sim = new KiteSim([a0.x, a0.y, a0.z], opts.line ?? 3.2, opts.windDir ?? [0.35, -1], seed, !ctx.posterMode)

  // Sail: two halves, the right one beam blue; spars behind it.
  const half = (sx: number) => {
    const s = new THREE.Shape()
    s.moveTo(0, 0.42)
    s.lineTo(sx * 0.27, 0.12)
    s.lineTo(0, -0.32)
    s.closePath()
    return own.add(extrude(s, 0.004, 1))
  }
  const k = new Assembly()
    .add(half(-1), 'light')
    .add(half(1), 'accent')
    .add(own.add(beamGeometry({ length: 0.76, width: 0.016, thickness: 0.01, holes: [] })), 'wood', { pos: [0, -0.33, -0.008], rot: [0, 0, Math.PI / 2] })
    .add(own.add(beamGeometry({ length: 0.56, width: 0.016, thickness: 0.01, holes: [] })), 'wood', { pos: [-0.28, 0.12, -0.012] })
  const kite = new THREE.Group()
  kite.add(k.build(M, 'kite'))
  root.add(kite)

  // String and tail: hairlines with live positions.
  const NS = 32
  const sPos = new Float32Array((NS + 1) * 3)
  const sGeo = own.add(new THREE.BufferGeometry())
  sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3))
  const hoverLine = new THREE.LineBasicMaterial({ color: ctx.materials.face.cyan.color })
  const string = new THREE.Line(sGeo, M.line)
  string.frustumCulled = false
  const NT = 10
  const tPos = new Float32Array(NT * 3)
  const tGeo = own.add(new THREE.BufferGeometry())
  tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3))
  const tail = new THREE.Line(tGeo, M.line)
  tail.frustumCulled = false
  root.add(string, tail)

  const prevP: V3 = [...sim.p] as V3
  const prevA: V3 = [...sim.anchor] as V3
  const ph = { roll: R.range(0, TAU), yaw: R.range(0, TAU) }
  let t = 0
  const P = new THREE.Vector3(), A = new THREE.Vector3(), bridle = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const basis = new THREE.Matrix4()
  const flutter = new THREE.Quaternion()
  const fe = new THREE.Euler()

  function pose(alpha: number) {
    P.set(prevP[0] + (sim.p[0] - prevP[0]) * alpha, prevP[1] + (sim.p[1] - prevP[1]) * alpha, prevP[2] + (sim.p[2] - prevP[2]) * alpha)
    A.set(prevA[0] + (sim.anchor[0] - prevA[0]) * alpha, prevA[1] + (sim.anchor[1] - prevA[1]) * alpha, prevA[2] + (sim.anchor[2] - prevA[2]) * alpha)
    // Face the flyer, nose up, the sail tilted back about 25 deg from vertical (its
    // angle of attack); flutter rolls it with the gusts and its own sideways speed.
    _z.subVectors(A, P).setY(0)
    if (_z.lengthSq() < 1e-8) _z.set(-sim.windDir[0], 0, -sim.windDir[1])
    _z.normalize().multiplyScalar(Math.cos(0.45)).add(_y.set(0, -Math.sin(0.45), 0))
    _y.copy(up).addScaledVector(_z, -up.dot(_z)).normalize()
    _x.crossVectors(_y, _z)
    basis.makeBasis(_x, _y, _z)
    kite.quaternion.setFromRotationMatrix(basis)
    const amp = ctx.posterMode ? 0 : 1
    const side = _x.x * sim.v[0] + _x.z * sim.v[2]
    fe.set(0.05 * amp * Math.sin(TAU * 0.9 * t + ph.yaw), 0.08 * amp * Math.sin(TAU * 0.6 * t + ph.yaw), amp * (0.12 * Math.sin(TAU * 1.3 * t + ph.roll) + 0.05 * Math.sin(TAU * 3.1 * t)) - 0.08 * side)
    kite.quaternion.multiply(flutter.setFromEuler(fe))
    kite.position.copy(P)
    // The string ties on at the bridle, a little in front of the sail.
    bridle.set(0, 0.06, 0.1).applyQuaternion(kite.quaternion).add(P)
    const L = Math.max(sim.length, P.distanceTo(A)) * 1.004
    catenary([A.x, A.y, A.z], [bridle.x, bridle.y, bridle.z], L, NS, sPos)
    sGeo.attributes.position!.needsUpdate = true
    // Tail: trails downwind and below the tail tip, waving.
    _x.set(0, -0.32, 0).applyQuaternion(kite.quaternion).add(P)
    for (let i = 0; i < NT; i++) {
      const s = i / (NT - 1)
      const wave = 0.06 * amp * Math.sin(TAU * (1.4 * t - s * 1.2)) * s
      tPos[i * 3] = _x.x + sim.windDir[0] * 0.35 * s + sim.windDir[1] * wave
      tPos[i * 3 + 1] = _x.y - 0.62 * s
      tPos[i * 3 + 2] = _x.z + sim.windDir[1] * 0.35 * s - sim.windDir[0] * wave
    }
    tGeo.attributes.position!.needsUpdate = true
  }
  pose(1)
  const pickable = meshesOf(root, [])
  const sphere = new THREE.Sphere()

  return {
    kind: 'kite',
    root,
    radius: 0.4,
    sim,
    setAnchor(p) {
      sim.anchor[0] = p.x
      sim.anchor[1] = p.y
      sim.anchor[2] = p.z
    },
    step(dt) {
      prevP[0] = sim.p[0]; prevP[1] = sim.p[1]; prevP[2] = sim.p[2]
      prevA[0] = sim.anchor[0]; prevA[1] = sim.anchor[1]; prevA[2] = sim.anchor[2]
      if (!ctx.posterMode) {
        sim.step(dt)
        t += dt
      }
    },
    frame(alpha) {
      pose(ctx.posterMode ? 1 : alpha)
    },
    setPaused() {},
    hit(ray) {
      // The sail is thin and small: pick a generous sphere around it.
      sphere.set(kite.position, 0.42)
      return ray.ray.intersectsSphere(sphere) || ray.intersectObjects(pickable, false).length > 0
    },
    react() {
      sim.tug(1)
      return 'A tug on the kite line.'
    },
    setSelected(on) {
      string.material = on ? hoverLine : M.line
    },
    dispose() {
      hoverLine.dispose()
      own.dispose(root)
      root.removeFromParent()
    },
  }
}

// ── Pottery shelf ─────────────────────────────────────────────────────────

const POTS: { mat: MatKey, pts: [number, number][] }[] = [
  // Chatti: the round-bellied Kerala cooking pot, with a rolled rim.
  { mat: 'woodDark', pts: [[0, 0], [0.055, 0], [0.095, 0.025], [0.118, 0.075], [0.105, 0.125], [0.072, 0.152], [0.07, 0.16], [0.082, 0.172], [0.074, 0.178], [0.062, 0.166]] },
  // Tall vase with a narrow neck.
  { mat: 'stone', pts: [[0, 0], [0.045, 0], [0.062, 0.06], [0.058, 0.14], [0.032, 0.205], [0.028, 0.24], [0.042, 0.268], [0.036, 0.272], [0.024, 0.25]] },
  // Open bowl.
  { mat: 'wood', pts: [[0, 0], [0.05, 0], [0.1, 0.035], [0.125, 0.07], [0.118, 0.074], [0.094, 0.044], [0.045, 0.024], [0, 0.022]] },
  // Small lidded jar.
  { mat: 'woodDark', pts: [[0, 0], [0.04, 0], [0.056, 0.05], [0.052, 0.1], [0.036, 0.118], [0.04, 0.124], [0.012, 0.136], [0.012, 0.15], [0, 0.15]] },
]

/**
 * A plain shelf (four straight uprights, two boards, pinned) carrying four
 * lathe-turned pots. Tap a pot and it rocks on its base rim; tap the shelf and
 * they all rock a little. Rocking pivots on the rim's contact point, so a pot
 * never sinks into its board.
 */
export function createPottery(ctx: PropContext, opts: { seed?: number } = {}): ArtProp {
  const M = ctx.materials
  const own = new Owned()
  const R = rng((opts.seed ?? 4) * 31 + 3)
  const root = new THREE.Group()
  root.name = 'pottery'
  const W = 1.0, D = 0.3, Hs = 1.06
  const levels = [0.4, 0.82]
  const shelf = new Assembly()
  const post = own.add(beamGeometry({ length: Hs, width: 0.045, thickness: 0.026, holes: [0.03, levels[0]! - 0.02, levels[1]! - 0.02, Hs - 0.03] }))
  for (const x of [-W / 2 + 0.03, W / 2 - 0.03]) {
    for (const z of [-D / 2 + 0.03, D / 2 - 0.03]) {
      const s = strut([x, 0, z], [x, Hs, z], [1, 0, 0])
      shelf.add(post, 'wood', { pos: s.pos, rot: s.rot })
    }
  }
  const boardG = own.add(blockGeometry(W, 0.022, D))
  const pin = own.add(pinGeometry(0.009, 0.06))
  for (const y of levels) {
    shelf.add(boardG, 'wood', { pos: [0, y, 0] })
    for (const x of [-W / 2 + 0.03, W / 2 - 0.03]) shelf.add(pin, 'light', { pos: [x, y - 0.02, D / 2 - 0.03] })
  }
  // A rail along the back, under the top board.
  shelf.add(own.add(beamGeometry({ length: W - 0.06, width: 0.04, thickness: 0.02, holes: [0, W - 0.06] })), 'woodDark', { pos: [-W / 2 + 0.03, levels[1]! - 0.11, -D / 2 + 0.045] })
  root.add(shelf.build(M, 'shelf'))

  const places: [number, number][] = [[-0.26, levels[1]!], [0.18, levels[1]!], [-0.14, levels[0]!], [0.26, levels[0]!]]
  const pots: { node: THREE.Group, sim: RockSim, r: number, prev: number, base: THREE.Vector3, meshes: THREE.Object3D[] }[] = []
  POTS.forEach((spec, i) => {
    const g = own.add(new THREE.LatheGeometry(spec.pts.map(([x, y]) => new THREE.Vector2(x, y)), 28))
    const node = new THREE.Group()
    const [x, y] = places[i]!
    const base = new THREE.Vector3(x, y + 0.011, 0.02)
    node.position.copy(base)
    node.rotation.y = R.range(0, TAU)
    const built = new Assembly().add(g, spec.mat).build(M, `pot-${i}`)
    node.add(built)
    root.add(node)
    pots.push({ node, sim: new RockSim(R.range(2.3, 3.0), 0.1), r: spec.pts[1]![0], prev: 0, base, meshes: meshesOf(built, []) })
  })
  const shadow = contactShadow(M, 0.65)
  const ring = selectRing(M, own, 0.62)
  root.add(shadow, ring)
  own.add(shadow.geometry)
  const shelfMeshes = meshesOf(root.children[0]!, [])
  const axis = new THREE.Vector3()
  const contact = new THREE.Vector3()
  const yawQ = new THREE.Quaternion()
  const tiltQ = new THREE.Quaternion()

  function tilt(p: typeof pots[number], phi: number) {
    // Rock about the base rim on the side it leans to.
    const dir = p.sim.dir
    const sgn = phi >= 0 ? 1 : -1
    contact.set(Math.cos(dir) * p.r * sgn, 0, Math.sin(dir) * p.r * sgn)
    axis.set(-Math.sin(dir), 0, Math.cos(dir))
    tiltQ.setFromAxisAngle(axis, -phi)
    yawQ.setFromAxisAngle(_y.set(0, 1, 0), p.node.userData.yaw ?? (p.node.userData.yaw = p.node.rotation.y))
    p.node.quaternion.multiplyQuaternions(tiltQ, yawQ)
    // Keep the contact point fixed: position = base + contact - R(contact).
    _x.copy(contact).applyQuaternion(tiltQ)
    p.node.position.copy(p.base).add(contact).sub(_x)
  }

  return {
    kind: 'pottery',
    root,
    radius: 0.62,
    step(dt) {
      for (const p of pots) {
        p.prev = p.sim.phi
        if (!ctx.posterMode) p.sim.step(dt)
      }
    },
    frame(alpha) {
      for (const p of pots) tilt(p, p.prev + (p.sim.phi - p.prev) * alpha)
    },
    setPaused() {},
    hit(ray) {
      return ray.intersectObjects([...shelfMeshes, ...pots.flatMap(p => p.meshes)], false).length > 0
    },
    react(ray) {
      if (ray) {
        for (const p of pots) {
          const h = ray.intersectObjects(p.meshes, false)[0]
          if (h) {
            const d = h.point.clone().sub(p.node.getWorldPosition(new THREE.Vector3()))
            p.sim.knock(Math.atan2(-d.z, -d.x), 1)
            return 'A pot rocks on its base.'
          }
        }
      }
      pots.forEach((p, i) => p.sim.knock(i * 1.7, 0.5))
      return 'The pots rock on the shelf.'
    },
    setSelected(on) {
      ring.visible = on
    },
    dispose() {
      own.dispose(root)
      root.removeFromParent()
    },
  }
}

// ── Hanging lantern ───────────────────────────────────────────────────────

/** A small lantern on a bracket post, swinging as a damped pendulum; pointer wind and taps set it swinging. */
export function createLantern(ctx: PropContext, opts: { seed?: number } = {}): ArtProp {
  const M = ctx.materials
  const own = new Owned()
  const root = new THREE.Group()
  root.name = 'lantern'
  const PH = 2.0, ARM = 0.46
  const post = new Assembly()
  crossFeet(post, own, 0.56, 'woodDark')
  {
    const s = strut([0, 0, 0], [0, PH, 0], [0, 0, 1])
    post.add(own.add(beamGeometry({ length: s.length, width: 0.05, thickness: 0.026, holes: [0.03, PH - 0.28, PH - 0.03] })), 'woodDark', { pos: s.pos, rot: s.rot })
    const arm = strut([-0.03, PH - 0.03, 0.028], [ARM, PH - 0.03, 0.028])
    post.add(own.add(beamGeometry({ length: arm.length, width: 0.04, thickness: 0.02, holes: [0.03, 0.27, arm.length - 0.04] })), 'woodDark', { pos: arm.pos, rot: arm.rot })
    const br = strut([0, PH - 0.28, 0.05], [0.27, PH - 0.03, 0.05])
    post.add(own.add(beamGeometry({ length: br.length, width: 0.032, thickness: 0.016 })), 'wood', { pos: br.pos, rot: br.rot })
    const pin = own.add(pinGeometry(0.011, 0.1))
    post.add(pin, 'light', { pos: [0, PH - 0.03, 0.028] })
    post.add(pin, 'light', { pos: [0, PH - 0.28, 0.03] })
    post.add(pin, 'light', { pos: [0.27, PH - 0.03, 0.04] })
  }
  root.add(post.build(M, 'lantern-post'))

  const CORD = 0.2
  const swing = new THREE.Group()
  swing.position.set(ARM - 0.04, PH - 0.03, 0.028)
  root.add(swing)
  const cord = own.add(pinGeometry(0.0025, CORD))
  cord.rotateX(Math.PI / 2)
  cord.translate(0, -CORD / 2, 0)
  const lw = 0.15, lh = 0.21
  const top = -CORD
  const L = new Assembly()
    .add(cord, 'dark', { edges: false })
    // A four-sided roof with a small flat top (a true cone apex leaves degenerate cap triangles).
    .add(own.add(new THREE.CylinderGeometry(lw * 0.14, lw * 0.78, 0.07, 4, 1)), 'dark', { pos: [0, top - 0.035, 0], rot: [0, Math.PI / 4, 0] })
    .add(own.add(blockGeometry(lw, lh, lw)), 'light', { pos: [0, top - 0.07 - lh / 2, 0] })
    .add(own.add(blockGeometry(lw + 0.02, 0.016, lw + 0.02)), 'dark', { pos: [0, top - 0.07 - lh - 0.008, 0] })
  const postG = own.add(blockGeometry(0.014, lh, 0.014))
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.add(postG, 'dark', { pos: [sx * lw / 2, top - 0.07 - lh / 2, sz * lw / 2] })
  swing.add(L.build(M, 'lantern'))
  const sim = new PendulumSim(CORD + 0.07 + lh / 2, 0.05, opts.seed ?? 6, !ctx.posterMode)
  const prev = [0, 0]
  const shadow = contactShadow(M, 0.3)
  shadow.position.x = 0.15
  const ring = selectRing(M, own, 0.36)
  ring.position.x = 0.2
  root.add(shadow, ring)
  own.add(shadow.geometry)
  const pickable = meshesOf(root, [shadow, ring])

  return {
    kind: 'lantern',
    root,
    radius: 0.36,
    step(dt) {
      prev[0] = sim.a[0]!
      prev[1] = sim.a[1]!
      if (!ctx.posterMode) sim.step(dt)
    },
    frame(alpha) {
      swing.rotation.x = prev[0]! + (sim.a[0]! - prev[0]!) * alpha
      swing.rotation.z = prev[1]! + (sim.a[1]! - prev[1]!) * alpha
    },
    setPaused(p) {
      if (p) sim.windX = sim.windZ = 0
    },
    hit(ray) {
      return ray.intersectObjects(pickable, false).length > 0
    },
    react() {
      sim.push(1, 0.4, 1)
      return 'The lantern swings.'
    },
    wind(vx, vz) {
      sim.wind(vx, vz)
    },
    setSelected(on) {
      ring.visible = on
    },
    dispose() {
      own.dispose(root)
      root.removeFromParent()
    },
  }
}
