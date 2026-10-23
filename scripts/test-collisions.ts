/**
 * Collision tests:  npm run test:collisions
 *
 * Runs the exact contact code the page runs (app/three/robots/contact.ts plus
 * each robot's own collide()), headless. Robot-level checks use the pure sims
 * (BalancerSim, DuckGait); the scene-level checks build the real hero
 * director with stub materials and step it like the stage does.
 *
 * Every "no overlap" check is measured AFTER the solver, at EVERY step, over
 * every pair of contact circles from different bodies (fixed-vs-fixed pairs
 * -- two planted duck feet -- are counted separately and must not occur).
 */
import * as THREE from 'three'
import { DT, FixedClock } from '../app/three/core/clock'
import { createMaterials } from '../app/three/core/kit'
import { readPalette } from '../app/three/core/palette'
import { BalancerSim, CONTACT_SHAPE, GROUND_ANGLE, IMPULSE_FALL, LIMITS } from '../app/three/robots/balancer/dynamics'
import { keepOutDistance, keepOutOf, maxOverlap, solveContacts, WALL, type Body, type Obstacle } from '../app/three/robots/contact'
import { DUCK_SHAPE, DuckGait } from '../app/three/robots/duck/gait'
import { DUST } from '../app/three/robots/dust'
import { Ball, BALL, Block } from '../app/three/robots/arena/props'
import type { LegSolution } from '../app/three/robots/duck/ik'
import { createSkeleton, poseSkeleton, SOLE_OFFSET } from '../app/three/robots/duck/model'
import { heroKeepOut, type ScreenRect } from '../app/three/core/signal'

let failed = 0
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg)
    failed++
  }
  else {
    console.log('PASS:', msg)
  }
}

const OVERLAP_MAX = 0.002
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

// ── Pure-sim bodies ───────────────────────────────────────────────────────

interface SimBody extends Body {
  kind: 'balancer' | 'duck'
  x(): number
  z(): number
  heading(): number
  step(speed: number, yawRate: number): void
  bal?: BalancerSim
  duck?: DuckGait
}

function balancer(seed: number, x: number, z: number, psi: number, noise = false): SimBody {
  const sim = new BalancerSim({ seed, noise, disturbance: noise })
  sim.place(x, z, psi)
  return {
    kind: 'balancer', mass: CONTACT_SHAPE.mass, colliders: sim.colliders, bal: sim,
    collide: (n, d, v, o, p) => sim.collide(n, d, v, o, p),
    x: () => sim.X, z: () => sim.Z, heading: () => sim.psi,
    step: (speed, yawRate) => sim.step({ speed, yawRate }),
  }
}

function duck(seed: number, x: number, z: number, yaw: number): SimBody {
  const g = new DuckGait(seed)
  g.placeAt(x, z, yaw)
  return {
    kind: 'duck', mass: DUCK_SHAPE.mass, colliders: g.colliders, duck: g,
    collide: (n, d, v, o, p) => g.collide(n, d, v, o, p),
    x: () => g.bx, z: () => g.bz, heading: () => g.yaw,
    step: (speed, yawRate) => g.step(DT, { speed, yawRate }),
  }
}

/** Steer toward a point at a speed (no separation: these tests WANT the collision). */
function drive(b: SimBody, tx: number, tz: number, speed: number) {
  const err = wrap(Math.atan2(tx - b.x(), tz - b.z()) - b.heading())
  b.step(b.bal?.busy || b.duck?.busy ? 0 : speed * Math.max(0, Math.cos(err)), Math.max(-1.6, Math.min(1.6, 3 * err)))
}

// ── 1. Head-on: never more than 2 mm of overlap after the solver ───────────
{
  const pairs: [string, () => SimBody, () => SimBody][] = [
    ['balancer vs balancer', () => balancer(1, -0.5, 0, Math.PI / 2), () => balancer(2, 0.5, 0, -Math.PI / 2)],
    ['duck vs duck', () => duck(3, -0.5, 0, Math.PI / 2), () => duck(4, 0.5, 0, -Math.PI / 2)],
    ['balancer vs duck', () => balancer(5, -0.5, 0, Math.PI / 2), () => duck(6, 0.5, 0.02, -Math.PI / 2)],
  ]
  for (const [name, mkA, mkB] of pairs) {
    const A = mkA(), B = mkB()
    let worst = 0, fixedPairs = 0, closest = Infinity, impacts = 0, staggered = false, maxTh = 0
    for (let i = 0; i < 1600; i++) {
      // Both keep driving at full speed toward where the other one is.
      drive(A, B.x(), B.z(), 0.25)
      drive(B, A.x(), A.z(), 0.25)
      solveContacts([A, B], [], () => impacts++)
      const o = maxOverlap([A, B], [])
      worst = Math.max(worst, o.worst)
      fixedPairs += o.fixedPairs
      closest = Math.min(closest, Math.hypot(A.x() - B.x(), A.z() - B.z()))
      if (B.duck?.busy || A.duck?.busy) staggered = true
      maxTh = Math.max(maxTh, Math.abs(A.bal?.th ?? 0), Math.abs(B.bal?.th ?? 0))
    }
    console.log(`  [${name}] worst overlap ${(worst * 1000).toFixed(3)} mm, closest centres ${(closest * 1000).toFixed(0)} mm, impacts ${impacts}, max pitch ${maxTh.toFixed(3)} rad`)
    assert(impacts > 0, `1. ${name}: they collide`)
    assert(worst <= OVERLAP_MAX, `1. ${name}: overlap after the solver <= 2 mm at every step (${(worst * 1000).toFixed(3)} mm)`)
    assert(fixedPairs === 0, `1. ${name}: no planted foot overlaps another planted foot`)
    if (name.includes('duck')) assert(staggered, `1. ${name}: the duck staggers`)
  }
}

// ── 2. A static obstacle stops a robot; it never passes through ────────────
{
  for (const mk of [() => balancer(7, 0, -0.5, 0), () => duck(8, 0, -0.5, 0)]) {
    const R = mk()
    const post: Obstacle = { x: 0.01, z: 0.2, r: 0.08 }
    let worst = 0, zMax = -Infinity
    for (let i = 0; i < 2000; i++) {
      drive(R, 0.01, 1, 0.25)
      solveContacts([R], [post])
      worst = Math.max(worst, maxOverlap([R], [post]).worst)
      zMax = Math.max(zMax, R.z())
    }
    console.log(`  [${R.kind} into a post] furthest z ${zMax.toFixed(3)} (post face at ${(post.z - post.r).toFixed(3)}), worst overlap ${(worst * 1000).toFixed(3)} mm`)
    assert(worst <= OVERLAP_MAX, `2. ${R.kind} driven into a post: overlap <= 2 mm at every step`)
    // A balancer stops at it; a duck may side-step round it -- either way, never through it.
    if (R.kind === 'balancer') assert(zMax < post.z, `2. balancer driven into a post: stops short of it (${zMax.toFixed(3)} < ${post.z})`)
  }
}

// ── 3. Balancer impacts: bounded wobble and recovery, or a fall and righting ──
{
  const hitRun = (v: number, part = 0, seconds = 8) => {
    const s = new BalancerSim({ seed: 9, noise: true })
    for (let i = 0; i < 40; i++) s.step({ speed: 0, yawRate: 0 })
    s.collide({ x: 0, z: -1 }, 0, v, 'robot', part)
    let maxTh = 0, fell = false, back = -1, settled = -1
    for (let i = 0; i < seconds / DT; i++) {
      s.step({ speed: 0, yawRate: 0 })
      maxTh = Math.max(maxTh, Math.abs(s.th))
      if (s.mode !== 'balancing') fell = true
      if (fell && back < 0 && s.mode === 'balancing' && !s.busy) back = (i + 1) * DT
      const calm = s.mode === 'balancing' && Math.abs(s.th) < 0.01 && Math.abs(s.xd) < 0.02
      if (!calm) settled = -1
      else if (settled < 0) settled = (i + 1) * DT
    }
    return { maxTh, fell, back, settled, s }
  }
  // Threshold: the smallest closing-speed share (m/s) that topples it, hit mid-frame, noise off.
  let lo = 0, hi = 2
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2
    const s = new BalancerSim({ seed: 9, noise: false })
    s.collide({ x: 0, z: -1 }, 0, mid, 'robot', 0)
    let fell = false
    for (let i = 0; i < 600 && !fell; i++) {
      s.step({ speed: 0, yawRate: 0 })
      fell = s.mode !== 'balancing'
    }
    if (fell) hi = mid
    else lo = mid
  }
  console.log(`  measured: a mid-frame hit topples the balancer above a closing-speed share of ${hi.toFixed(3)} m/s`)
  const soft = hitRun(0.15)
  const firm = hitRun(0.6 * hi)
  const hard = hitRun(1.3 * hi)
  console.log(`  soft hit: max pitch ${soft.maxTh.toFixed(3)} rad, settled ${soft.settled.toFixed(2)} s; firm: ${firm.maxTh.toFixed(3)} rad, settled ${firm.settled.toFixed(2)} s; hard: fell ${hard.fell}, balancing again at ${hard.back.toFixed(2)} s`)
  assert(soft.maxTh > 0.01 && soft.maxTh < 0.1 && !soft.fell, '3. a soft bump makes a visible wobble (> 0.01 rad) and no fall')
  assert(firm.maxTh < LIMITS.fallAngle && !firm.fell && firm.settled > 0 && firm.settled < 4, `3. 0.6 x the threshold: bounded wobble (${firm.maxTh.toFixed(3)} rad), settled in ${firm.settled.toFixed(2)} s`)
  assert(hard.fell && hard.back > 0 && hard.back < 5 && !hard.s.busy, `3. 1.3 x the threshold: falls, rights itself with the kickstand, balancing at ${hard.back.toFixed(2)} s`)
  {
    // Sideways hit: the wheels cannot roll sideways -- a short damped skid.
    const s = new BalancerSim({ seed: 9, noise: false })
    s.collide({ x: 1, z: 0 }, 0.004, 0.3, 'robot', 0)
    const x0 = s.X
    const roll0 = s.sL
    let steps = 0
    while ((s.skidX !== 0 || s.skidZ !== 0) && steps < 400) {
      s.step({ speed: 0, yawRate: 0 })
      steps++
    }
    const slid = s.X - x0
    console.log(`  sideways hit: skid ${(slid * 1000).toFixed(1)} mm over ${(steps * DT).toFixed(3)} s, wheel arc change ${(s.sL - roll0).toExponential(1)} m`)
    assert(slid > 0.002 && slid < 0.03 && steps * DT < 0.3, '3. a sideways hit skids a few mm and stops within 0.3 s')
    assert(Math.abs(s.sL - roll0) < 1e-3 && Math.abs(s.th) < 0.01, '3. a sideways hit does not roll the wheels or tip the body')
  }
  {
    // The positional push rolls the wheels along the heading (no slide) and the controller accepts it.
    const s = new BalancerSim({ seed: 9, noise: false })
    s.collide({ x: 0, z: -1 }, 0.01, 0, 'robot', 0)
    assert(Math.abs(s.sL + 0.01) < 1e-12 && Math.abs(s.sR + 0.01) < 1e-12 && Math.abs(s.Z + 0.01) < 1e-12, '3. a 10 mm push back rolls both wheels back 10 mm (arc = displacement, nothing slides)')
    let drift = 0
    for (let i = 0; i < 600; i++) {
      s.step({ speed: 0, yawRate: 0 })
      drift = Math.max(drift, s.Z + 0.01)
    }
    assert(drift < 0.002, `3. ...and it does not drive back into what pushed it (${(drift * 1000).toFixed(2)} mm)`)
  }
}

// ── 4. Cascade: a shoved balancer falls into its neighbour ─────────────────
{
  // Rear robot faces +Z; a shove tips it backward (-Z), head first into the one behind.
  const A = balancer(10, 0, 0.12, 0)
  const B = balancer(11, 0, -0.12, 0)
  A.bal!.impulse(-1.2 * IMPULSE_FALL)
  let worst = 0, hitB = 0, impacts = 0
  for (let i = 0; i < 1600; i++) {
    A.step(0, 0)
    B.step(0, 0)
    solveContacts([A, B], [], () => impacts++)
    worst = Math.max(worst, maxOverlap([A, B], []).worst)
    hitB = Math.max(hitB, Math.abs(B.bal!.th))
  }
  console.log(`  cascade: impacts ${impacts}, neighbour max pitch ${hitB.toFixed(3)} rad, worst overlap ${(worst * 1000).toFixed(3)} mm`)
  assert(impacts > 0 && hitB > 0.02, '4. a falling balancer knocks its neighbour (its head circle hits; the neighbour wobbles)')
  assert(worst <= OVERLAP_MAX, '4. cascade: overlap <= 2 mm at every step, lying body included')
  assert(!A.bal!.busy && !B.bal!.busy, '4. cascade: both end up balancing')
}

// ── 5. Duck: pushed and walking into things, stance feet never slide ──────
{
  const sk = createSkeleton()
  const sols: [LegSolution, LegSolution] = [0, 1].map(() => ({ hipYaw: 0, hipRoll: 0, hipPitch: 0, knee: 0, anklePitch: 0, ankleRoll: 0, dist: 0, clamped: false, limited: false })) as any
  const D = duck(12, 0, -0.4, 0)
  const Bal = balancer(13, 0.02, 0.15, Math.PI)
  const ref: ({ id: number, p: THREE.Vector3 } | null)[] = [null, null]
  let drift = 0, clamps = 0, staggers = 0, wasBusy = false, worst = 0
  for (let i = 0; i < 2400; i++) {
    // The duck walks at the balancer; later the balancer drives slowly into the standing duck.
    drive(D, Bal.x(), Bal.z(), i < 1200 ? 0.2 : 0)
    Bal.step(i > 1400 ? 0.06 : 0, 0)
    solveContacts([D, Bal], [])
    worst = Math.max(worst, maxOverlap([D, Bal], []).worst)
    const g = D.duck!
    if (g.busy && !wasBusy) staggers++
    wasBusy = g.busy
    poseSkeleton(sk, g.cur, sols)
    sk.root.updateMatrixWorld(true)
    for (let k = 0; k < 2; k++) {
      if (sols[k]!.clamped || sols[k]!.limited) clamps++
      const p = sk.legs[k]!.foot.localToWorld(new THREE.Vector3(0, SOLE_OFFSET, 0))
      if (g.planted[k]) {
        const r = ref[k]
        if (!r || r.id !== g.stanceId[k]) ref[k] = { id: g.stanceId[k]!, p }
        else drift = Math.max(drift, p.distanceTo(r.p))
      }
      else {
        ref[k] = null
      }
    }
  }
  console.log(`  duck into a balancer, then pushed: staggers ${staggers}, stance drift ${drift.toExponential(2)} m, IK clamps/limits ${clamps}, worst overlap ${(worst * 1000).toFixed(3)} mm`)
  assert(staggers >= 1, `5. the duck staggers (or trips and falls) when it runs into the balancer and when it is pushed (${staggers})`)
  assert(drift <= 1e-6, '5. stance soles never move through collisions, pushes and staggers (posed skeleton, <= 1e-6 m)')
  assert(clamps === 0, '5. the legs never hit an IK clamp or joint limit while being pushed')
  assert(worst <= OVERLAP_MAX, '5. overlap <= 2 mm at every step')
}

// ── 6. Solver cost: 8 bodies in a crowd ───────────────────────────────────
{
  const crowd: SimBody[] = []
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2
    crowd.push(k % 2 ? balancer(20 + k, 0.18 * Math.cos(a), 0.18 * Math.sin(a), a + Math.PI) : duck(20 + k, 0.18 * Math.cos(a), 0.18 * Math.sin(a), a + Math.PI))
  }
  const obstacles: Obstacle[] = [{ x: 0.5, z: 0, r: 0.1 }, { x: -0.5, z: 0, r: 0.1 }]
  let ms = 0, worst = 0
  const N = 2000
  for (let i = 0; i < N; i++) {
    for (const b of crowd) drive(b, 0, 0, 0.15)
    const t0 = performance.now()
    solveContacts(crowd, obstacles)
    ms += performance.now() - t0
    worst = Math.max(worst, maxOverlap(crowd, obstacles).worst)
  }
  console.log(`  8 bodies driven into one another: solver ${(ms / N * 1000).toFixed(1)} us per step, worst overlap ${(worst * 1000).toFixed(3)} mm`)
  assert(ms / N < 0.2, `6. solver < 0.2 ms per step for 8 bodies (${(ms / N).toFixed(4)} ms)`)
  assert(worst <= OVERLAP_MAX, '6. an 8-body crowd: overlap <= 2 mm at every step')
}

// ── The hero director, headless ───────────────────────────────────────────

const palette = readPalette()
// createMaterials draws one blob texture into a canvas; give it a stub.
;(globalThis as any).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' }) }),
}
const materials = createMaterials(palette)
/**
 * The page's text as the hero sees it (heroKeepOut, fractions of the slot):
 * a words block on the left, the key and controls box bottom right, the hint
 * top right -- the sample layout the coordinator specified -- and the nav
 * rail along the bottom (the page publishes it too).
 */
const SAMPLE: ScreenRect[] = [{ x0: 0.04, x1: 0.34, y0: 0.1, y1: 0.85 }, { x0: 0.55, x1: 0.97, y0: 0.75, y1: 0.93 }, { x0: 0.67, x1: 0.96, y0: 0.035, y1: 0.07 }, { x0: 0.3, x1: 0.7, y0: 0.94, y1: 0.99 }]
heroKeepOut.rects = SAMPLE
heroKeepOut.version++
const { default: createHero, largestFree } = await import('../app/three/scenes/hero')
type Hero = Awaited<ReturnType<typeof createHero>>
const SW = 1440, SH = 900

async function hero(coarse = false, seed = 0) {
  const h = await createHero({ materials, palette, posterMode: false, coarse, width: SW, height: SH }, seed)
  h.resize(SW, SH)
  return h
}

/** Slot pointer at a ground point (what SceneSlot would deliver). */
function pointerAt(h: Hero, kind: 'move' | 'tap', x: number, z: number) {
  const p = new THREE.Vector3(x, 0, z).project(h.camera)
  h.pointer({ kind, x: (p.x + 1) / 2 * SW, y: (1 - p.y) / 2 * SH, ndc: { x: p.x, y: p.y } })
}
/** Slot pointer at a screen fraction. */
function pointerAtScreen(h: Hero, kind: 'move' | 'tap', fx: number, fy: number) {
  h.pointer({ kind, x: fx * SW, y: fy * SH, ndc: { x: fx * 2 - 1, y: 1 - fy * 2 } })
}

interface Watch { worst: number, busyRun: number[], maxBusy: number, fixedPairs: number }
function watch(h: Hero): Watch {
  return { worst: 0, busyRun: h.debug.robots.map(() => 0), maxBusy: 0, fixedPairs: 0 }
}
function stepWatch(h: Hero, w: Watch) {
  h.step(DT)
  const o = h.debug.overlap()
  w.worst = Math.max(w.worst, o.worst)
  w.fixedPairs += o.fixedPairs
  h.debug.robots.forEach((r, k) => {
    w.busyRun[k] = r.busy ? w.busyRun[k]! + 1 : 0
    w.maxBusy = Math.max(w.maxBusy, w.busyRun[k]! * DT)
  })
}

/**
 * The largest overlap, in CSS px, between anything moving on screen -- each
 * part of each robot's body (its visible meshes, box by box; not its floor
 * shadow or hidden ring) and the ball -- and the page's text rects. The
 * robots are drawn first (frame).
 */
const gb = new THREE.Box3(), v3 = new THREE.Vector3()
function intoText(h: Hero) {
  h.frame(1)
  let worst = 0
  const boxes: THREE.Box3[] = []
  for (const r of h.debug.robots) {
    r.root.updateMatrixWorld(true)
    r.root.traverseVisible((o: any) => {
      if (!o.geometry || o.material === materials.shadow || o.isLineSegments) return
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
      boxes.push(gb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).clone())
    })
  }
  const b = h.debug.ball
  boxes.push(new THREE.Box3(new THREE.Vector3(b.x - BALL.r, 0, b.z - BALL.r), new THREE.Vector3(b.x + BALL.r, 2 * BALL.r, b.z + BALL.r)))
  for (const bx of boxes) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let c = 0; c < 8; c++) {
      v3.set(c & 1 ? bx.max.x : bx.min.x, c & 2 ? bx.max.y : bx.min.y, c & 4 ? bx.max.z : bx.min.z).project(h.camera)
      x0 = Math.min(x0, (v3.x + 1) / 2 * SW)
      x1 = Math.max(x1, (v3.x + 1) / 2 * SW)
      y0 = Math.min(y0, (1 - v3.y) / 2 * SH)
      y1 = Math.max(y1, (1 - v3.y) / 2 * SH)
    }
    for (const q of heroKeepOut.rects) {
      const ox = Math.min(x1, q.x1 * SW) - Math.max(x0, q.x0 * SW), oy = Math.min(y1, q.y1 * SH) - Math.max(y0, q.y0 * SH)
      if (ox > 0 && oy > 0) worst = Math.max(worst, Math.min(ox, oy))
    }
  }
  return worst
}

// ── 7. Easter eggs: bounded, back to play, nobody overlapping or stuck ─────
{
  for (const name of ['dance', 'party', 'line-up', 'conga', 'sleep'] as const) {
    const h = await hero()
    h.debug.routines(false)
    const w = watch(h)
    for (let i = 0; i < 600; i++) stepWatch(h, w)
    const status = h.action(name)
    const start = h.debug.robots.map(r => [r.position.x, r.position.z, r.heading])
    let ended = -1
    let moved = 0
    let lineErr = 0
    let spin = 0
    let hops = 0
    const was = h.debug.robots.map(r => r.busy)
    for (let i = 0; i < 12 / DT; i++) {
      const before = h.debug.robots.map(r => r.heading)
      stepWatch(h, w)
      if (i * DT < 8) {
        h.debug.robots.forEach((r, k) => {
          if (r.kind === 'balancer') spin += Math.abs(wrap(r.heading - before[k]!))
          if (r.kind === 'duck' && r.busy && !was[k]) hops++
          was[k] = r.busy
        })
      }
      if (name === 'line-up' && i === Math.round(5.2 / DT)) {
        lineErr = Math.max(...h.debug.robots.map((r, k) => Math.hypot(r.position.x - h.debug.goal(k).x, r.position.z - h.debug.goal(k).z)))
      }
      if (ended < 0 && h.debug.egg() === null) ended = (i + 1) * DT
      h.debug.robots.forEach((r, k) => {
        if (i * DT < 8) moved = Math.max(moved, Math.hypot(r.position.x - start[k]![0]!, r.position.z - start[k]![1]!))
      })
    }
    const stillBusy = h.debug.robots.some(r => r.fallen)
    console.log(`  [${name}] "${status}" ended at ${ended.toFixed(2)} s, worst overlap ${(w.worst * 1000).toFixed(3)} mm, longest busy ${w.maxBusy.toFixed(2)} s, furthest any robot moved during it ${(moved * 1000).toFixed(0)} mm`)
    assert(typeof status === 'string' && status.length > 0, `7. ${name}: returns a status string`)
    assert(ended > 0 && ended <= 8 + 1e-9, `7. ${name}: ends within 8 s (${ended.toFixed(2)} s) and hands back to play`)
    assert(w.worst <= OVERLAP_MAX && w.fixedPairs === 0, `7. ${name}: no overlap > 2 mm at any step`)
    assert(w.maxBusy < 4 && !stillBusy, `7. ${name}: nobody fallen-and-stuck (longest busy ${w.maxBusy.toFixed(2)} s; all free at the end)`)
    if (name !== 'sleep') assert(moved > 0.03, `7. ${name}: the robots actually move`)
    if (name === 'dance' || name === 'party') {
      console.log(`    balancers spun ${spin.toFixed(1)} rad in total, duck hops/staggers ${hops}`)
      // One wheel-leg in the cast: two bars of spinning at its 2 rad/s limit, less ramp-up.
      assert(spin > 5 && hops >= 2, `7. ${name}: the wheel-leg spins in place and the ducks hop on the beat`)
    }
    // (Makey walks at 0.15 m/s, and a bump on the way costs it a moment.)
    if (name === 'line-up') assert(lineErr < 0.12, `7. line-up: in a line across the front before the bow (worst slot error ${(lineErr * 1000).toFixed(0)} mm)`)
    h.dispose()
  }
  {
    // Sleep wakes on a pointer move, with a startle, and is back to play.
    const h = await hero()
    for (let i = 0; i < 400; i++) h.step(DT)
    h.action('sleep')
    for (let i = 0; i < 400; i++) h.step(DT)
    const P = h.debug.pitch
    pointerAt(h, 'move', P.x0 + 0.3, P.z0 + 0.2)
    pointerAt(h, 'move', P.x1 - 0.3, P.z1 - 0.2)
    assert(h.debug.egg() === null, '7. sleep: a pointer move wakes them')
    h.dispose()
  }
}

// ── 8. The pointer: deliberate only ─────────────────────────────────────────
{
  // (a) A click on the open floor: the nearest robot(s) go there, then back to the game.
  const h = await hero()
  const w = watch(h)
  for (let i = 0; i < 400; i++) stepWatch(h, w)
  const P = h.debug.pitch
  const tx = P.x0 + 0.25, tz = P.z1 - 0.12
  pointerAt(h, 'tap', tx, tz)
  const target = h.debug.dot()?.clone()
  const sent = h.debug.chasers()
  let reached = -1, ended = -1, markerSeen = false
  for (let i = 0; i < 6 / DT; i++) {
    stepWatch(h, w)
    h.frame(1)
    markerSeen ||= h.debug.marker()
    const d = Math.min(...h.debug.robots.map(r => Math.hypot(r.position.x - tx, r.position.z - tz)))
    if (reached < 0 && d < 0.25) reached = (i + 1) * DT
    if (ended < 0 && h.debug.dot() === null) ended = (i + 1) * DT
  }
  console.log(`  click target: ${sent.length} sent, nearest within 0.25 m after ${reached.toFixed(2)} s, target over after ${ended.toFixed(2)} s`)
  assert(target !== undefined && sent.length === 2 && markerSeen, '8. a click on the floor sets a target (cyan marker) and sends the two nearest robots')
  assert(reached > 0 && reached <= 3, `8. a robot is within 0.25 m of the clicked target within 3 s (${reached.toFixed(2)} s)`)
  assert(ended > 0 && ended <= 4 + DT, `8. the target is done within 4 s (${ended.toFixed(2)} s) and they go back to the game`)
  assert(sent.every(i => h.debug.mode(i) !== 'dot'), '8. after the target, the robots sent are back in the game')
  assert(w.worst <= OVERLAP_MAX, '8. going to the target: overlap <= 2 mm at every step')
  // (b) A click over the words is the page's (a link, a word), not a call:
  // no target. Nor is the pointer parked on the text for longer than a rest.
  pointerAtScreen(h, 'tap', 0.2, 0.5)
  assert(h.debug.dot() === null, '8. a click over the text sets no target')
  pointerAtScreen(h, 'move', 0.2, 0.5)
  let parked = false
  for (let i = 0; i < 3 / DT; i++) {
    stepWatch(h, w)
    parked ||= h.debug.dot() !== null
  }
  assert(!parked, '8. the pointer resting on the text for 3 s sets no target')
  for (let i = 0; i < 2 / DT; i++) stepWatch(h, w)
  h.dispose()

  // (c) The pointer resting still on the floor for 1.2 s: one target, once.
  const r = await hero()
  for (let i = 0; i < 400; i++) r.step(DT)
  const RP = r.debug.pitch
  const rx = RP.x1 - 0.3, rz = RP.z0 + 0.2
  pointerAt(r, 'move', rx, rz)
  let setAt = -1, near = -1, targets = 0, was: unknown = null
  for (let i = 0; i < 10 / DT; i++) {
    r.step(DT)
    const d = r.debug.dot()
    if (d && !was) {
      targets++
      if (setAt < 0) setAt = (i + 1) * DT
    }
    was = d
    if (setAt > 0 && near < 0 && Math.min(...r.debug.robots.map(q => Math.hypot(q.position.x - rx, q.position.z - rz))) < 0.25) near = (i + 1) * DT - setAt
  }
  console.log(`  resting pointer: target after ${setAt.toFixed(2)} s, a robot there ${near.toFixed(2)} s later, ${targets} target(s) in 10 s`)
  assert(setAt > 1.1 && setAt < 1.4, `8. the pointer resting on the floor for 1.2 s sets a target (${setAt.toFixed(2)} s)`)
  assert(near >= 0 && near <= 3, `8. a robot is within 0.25 m of the resting pointer's target within 3 s (${near.toFixed(2)} s)`)
  assert(targets === 1, `8. a resting pointer sets ONE target, not a stream (${targets})`)
  r.dispose()

  // (d) Free moves change nothing: the same 10 s with the pointer wandering
  // over the playground (never resting) and without it: bitwise the same headings and positions.
  const run = async (moves: boolean) => {
    const q = await hero()
    const QP = q.debug.pitch
    for (let i = 0; i < 10 / DT; i++) {
      if (moves && i % 20 === 0) {
        const t = i * DT
        pointerAt(q, 'move', QP.x0 + (QP.x1 - QP.x0) * (0.5 + 0.45 * Math.sin(t * 0.9)), QP.z0 + (QP.z1 - QP.z0) * (0.5 + 0.4 * Math.cos(t * 1.3)))
      }
      q.step(DT)
    }
    const out = JSON.stringify(q.debug.robots.map(o => [o.heading, o.position.x, o.position.z]))
    const targetsSet = q.debug.dot() !== null
    q.dispose()
    return { out, targetsSet }
  }
  const still = await run(false), moving = await run(true)
  assert(still.out === moving.out && !moving.targetsSet, '8. free pointer moves change no robot\'s heading or position (bitwise), and set no target')

  // Keyboard follow still runs a chain behind the selected robot, and toggles off.
  const k = await hero()
  assert(k.action('follow')?.startsWith('Everyone is following') === true && k.debug.chain() === 'key', '8. keyboard follow starts a chain behind the selected robot')
  for (let i = 0; i < 1000; i++) k.step(DT)
  assert(k.action('follow') === 'Stopped following' && k.debug.chain() === null, '8. keyboard follow toggles off')
  k.dispose()

  // Touch: a tap on the floor sets a target too.
  const t = await hero(true)
  for (let i = 0; i < 400; i++) t.step(DT)
  // A spot on the floor clear of every robot (a tap on a robot is a nudge, not a target).
  const TP = t.debug.pitch
  const grid: number[][] = []
  for (let u = 0.05; u < 1; u += 0.1) for (let v = 0.1; v < 1; v += 0.2) grid.push([TP.x0 + (TP.x1 - TP.x0) * u, TP.z0 + (TP.z1 - TP.z0) * v])
  const spot = grid.find(([x, z]) => t.debug.robots.every(r => Math.hypot(r.position.x - x!, r.position.z - z!) > 0.22))!
  pointerAt(t, 'tap', spot[0]!, spot[1]!)
  assert(t.debug.dot() !== null && t.debug.chasers().length >= 1, '8. touch: a tap on the floor sets a target')
  t.dispose()
}

// ── 9. Obstacles in the hero ───────────────────────────────────────────────
{
  const h = await hero()
  const w = watch(h)
  const P = h.debug.pitch
  // On open floor (not on anyone's feet).
  h.addObstacle({ x: P.x0 + 0.45, z: P.z1 - 0.12, r: 0.05 })
  h.addObstacle({ x: P.x1 - 0.35, z: P.z0 + 0.2, r: 0.04 })
  for (let i = 0; i < 20 / DT; i++) {
    if (i % 1500 === 0) h.action(['line-up', 'conga', 'dance'][(i / 1500) % 3]!)
    stepWatch(h, w)
  }
  console.log(`  hero with two obstacles, 20 s of eggs: worst overlap ${(w.worst * 1000).toFixed(3)} mm, longest busy ${w.maxBusy.toFixed(2)} s`)
  assert(w.worst <= OVERLAP_MAX, '9. robots never overlap the scene\'s obstacles (or each other) by > 2 mm')
  h.dispose()
}

// ── 11. Every motion has a purpose: with the game off, robots hold their places ──
interface Log { impacts: [number, number, number, number][], reacts: [number, number, number][], dustMax: number }
/** Robot-robot and robot-static impacts (props excluded: the ball is meant to be hit). */
function logOf(h: Hero): Log {
  const log: Log = { impacts: [], reacts: [], dustMax: 0 }
  const n = h.debug.robots.length
  h.debug.hooks.impact = (i, j, s, t) => {
    if (s >= 0.05 && i < n && j < n) log.impacts.push([i, j, s, t])
  }
  h.debug.hooks.react = (i, o, t) => {
    log.reacts.push([i, o, t])
  }
  return log
}
{
  const h = await hero()
  h.debug.routines(false)
  const log = logOf(h)
  const w = watch(h)
  const start = h.debug.robots.map(r => r.position.clone())
  for (let i = 0; i < 20 / DT; i++) stepWatch(h, w)
  const moved = Math.max(...h.debug.robots.map((r, k) => r.position.distanceTo(start[k]!)))
  console.log(`  game off, 20 s: furthest a robot drifted ${(moved * 1000).toFixed(0)} mm, ${log.impacts.length} contacts`)
  assert(moved < 0.05 && log.impacts.length === 0, '11. with the game off nobody wanders: robots hold their places (< 5 cm) and never bump')
  h.dispose()
}

// ── 12. Reactions: one per robot per contact, cooldown, dust ────────────────
{
  const h = await hero()
  h.debug.routines(false)
  const log = logOf(h)
  for (let i = 0; i < 200; i++) h.step(DT)
  // A balancer standing just in front of a duck is shoved over backward: its pod hits the duck.
  const R = h.debug.robots as any[]
  const P = h.debug.pitch
  const cx = (P.x0 + P.x1) / 2, cz = (P.z0 + P.z1) / 2
  const iDuck = R.findIndex(r => r.kind === 'duck'), iBal = R.findIndex(r => r.kind === 'balancer')
  const bal1 = R[iBal], duck0 = R[iDuck]
  // Everyone else out of the way, in the pitch's corners.
  const corners = [[P.x0 + 0.25, P.z0 + 0.2], [P.x1 - 0.25, P.z0 + 0.2], [P.x0 + 0.25, P.z1 - 0.2], [P.x1 - 0.25, P.z1 - 0.2]]
  let c = 0
  R.forEach((r, k) => {
    if (k !== iDuck && k !== iBal) {
      const [x, z] = corners[c++]!
      r.placeAt(x!, z!, 0)
    }
  })
  bal1.placeAt(cx, cz + 0.05, 0)
  duck0.placeAt(cx + 0.02, cz - 0.2, 0)
  h.debug.ball.place(P.x1 - 0.1, cz)
  h.step(DT)
  bal1.react('shove')
  let dustSeen = 0, dustMax = 0, modeReact = false, modeBack = -1
  const w = watch(h)
  for (let i = 0; i < 6 / DT; i++) {
    stepWatch(h, w)
    // Dust is drawn (and expires) in frame(), as on the stage.
    h.frame(1)
    dustSeen = Math.max(dustSeen, h.debug.dust())
    dustMax = Math.max(dustMax, h.debug.dust())
    if (h.debug.mode(iDuck) === 'react') modeReact = true
    if (modeReact && modeBack < 0 && h.debug.mode(iDuck) !== 'react') modeBack = i * DT
  }
  const first = log.impacts[0]
  console.log(`  shove into a duck: impacts ${log.impacts.map(x => `${x[0]}-${x[1]} ${x[2].toFixed(2)} m/s @${x[3].toFixed(2)}`).join(', ')}; reactions ${log.reacts.map(r => `${r[0]}->${r[1]} @${r[2].toFixed(2)}`).join(', ')}; dust peak ${dustSeen}`)
  assert(first !== undefined && first[0] === Math.min(iDuck, iBal) && first[1] === Math.max(iDuck, iBal), '12. the falling balancer hits the duck')
  const triggering = log.impacts.filter((x, k) => !log.impacts.slice(0, k).some(y => y[0] === x[0] && (y[1] === x[1] || (y[1] < 0 && x[1] < 0)) && x[3] - y[3] < 1.5))
  const expected = triggering.reduce((s, x) => s + (x[1] >= 0 ? 2 : 1), 0)
  const reactionsOk = triggering.every(x => log.reacts.filter(r => r[2] === x[3] && (r[0] === x[0] || r[0] === x[1])).length === (x[1] >= 0 ? 2 : 1))
  assert(reactionsOk && log.reacts.length === expected, `12. every contact gives exactly one reaction per robot (${log.reacts.length} reactions for ${triggering.length} contacts)`)
  const repeats = log.reacts.filter((r, k) => log.reacts.slice(0, k).some(q => q[0] === r[0] && q[1] === r[1] && r[2] - q[2] < 1.5)).length
  assert(repeats === 0, '12. no second reaction for the same pair within the 1.5 s cooldown')
  assert(modeReact && modeBack > 0.75 && modeBack < 4.5, `12. the duck pauses, steps back and carries on (${modeBack.toFixed(2)} s after the hit)`)
  assert(dustSeen > 0 && dustMax <= DUST.pool && h.debug.dust() === 0, `12. a dust puff appears, the pool stays bounded (${dustMax} <= ${DUST.pool}) and it fades`)
  assert(w.worst <= OVERLAP_MAX, '12. overlap <= 2 mm throughout')
  h.dispose()
}
{
  // Many contacts at once (eggs, shoves, the game): the dust pool never grows
  // past its size, and no pair reacts twice inside its cooldown.
  const h = await hero()
  const log = logOf(h)
  let dustMax = 0
  for (let i = 0; i < 40 / DT; i++) {
    if (i % 1600 === 100) h.action(['dance', 'conga', 'party', 'line-up', 'conga'][Math.floor(i / 1600) % 5]!)
    if (i % 900 === 450) (h.debug.robots[i % 1800 === 450 ? 1 : 3] as any).react('shove')
    h.step(DT)
    h.frame(1)
    dustMax = Math.max(dustMax, h.debug.dust())
  }
  const repeats = log.reacts.filter((r, k) => log.reacts.slice(0, k).some(q => q[0] === r[0] && q[1] === r[1] && r[2] - q[2] < 1.5)).length
  console.log(`  40 s of eggs, shoves and play: ${log.impacts.length} contacts, ${log.reacts.length} reactions, dust peak ${dustMax}`)
  assert(dustMax <= DUST.pool, `12. dust pool bounded under load (${dustMax} <= ${DUST.pool})`)
  assert(repeats === 0, '12. no repeat reactions within the cooldown under load')
  h.dispose()
}

// ── 10. Determinism across frame rates ───────────────────────────────────
{
  const N = 6000
  const run = async (hz: number) => {
    const h = await hero()
    const log = logOf(h)
    const P = h.debug.pitch
    h.addObstacle({ x: P.x0 + 0.6, z: P.z0 + 0.3, r: 0.06 })
    const clock = new FixedClock()
    let now = 1000
    let n = 0
    clock.advance(now, () => {})
    while (n < N) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (n >= N) return
        if (n === 500) h.action('nudge')
        if (n === 900) h.action('dance')
        if (n === 2800) h.action('next')
        if (n === 2900) h.action('nudge')
        if (n === 3200) pointerAt(h, 'tap', P.x1 - 0.3, P.z1 - 0.15)
        if (n === 3500) h.action('conga')
        if (n === 5200) h.action('call')
        if (n === 5300) pointerAt(h, 'move', P.x0 + 0.3, P.z0 + 0.2)
        if (n === 1500 || n === 4100) (h.debug.robots[n === 1500 ? 1 : 3] as any).react('shove')
        if (n === 2000) h.action('kick')
        if (n === 4400) h.action('crash')
        // A scripted mouse drag: grab robot 0 at its body, drag it across, let go.
        if (n === 4600) h.debug.grab(0, h.debug.robots[0]!.position.clone().setY(0.2))
        if (n > 4600 && n < 4800) h.debug.drag(new THREE.Vector3(P.x0 + 0.2 + (n - 4600) * 0.003, 0.23, (P.z0 + P.z1) / 2))
        if (n === 4800) h.debug.grab(0, null)
        h.step(DT)
        n++
      })
    }
    const out = h.debug.robots.map(r => [r.position.x, r.position.z, r.heading, ...r.colliders.flatMap(c => [c.x, c.z, c.r])])
    out.push([h.debug.dust(), log.impacts.length, ...log.reacts.flat()])
    out.push([h.debug.ball.x, h.debug.ball.z, ...h.debug.ball.q, h.debug.kicks(), h.debug.crashes(), ...h.debug.goals()])
    h.dispose()
    return JSON.stringify(out)
  }
  const a = await run(30)
  const b = await run(60)
  const c = await run(144)
  assert(a === b && a === c, `10. hero with the game, collisions, a target, eggs, a crash and a mouse drag: same ${N} steps at 30/60/144 Hz give bitwise identical robots and ball`)
}

// Sanity: lying down, the balancer's pod circles lie well ahead of its axle (it can be tripped over).
{
  const s = new BalancerSim({ seed: 1, noise: false })
  s.th = GROUND_ANGLE.front
  s.updateColliders()
  assert(Math.hypot(s.colliders[4]!.x - s.X, s.colliders[4]!.z - s.Z) > 0.1, 'shape: a fallen balancer\'s pod circles lie > 0.1 m ahead of its axle')
}

// ── 13. The ball and the blocks ────────────────────────────────────────────
{
  // Alone on the mat: a hard kick bounces off the rails and dies away -- no perpetual motion.
  const ball = new Ball()
  ball.place(0, 0)
  ball.kick(1, 0.3, 1.2)
  const walls = { minX: -0.72, maxX: 0.72, minZ: -0.4, maxZ: 0.4 }
  const e0 = ball.energy
  let maxE = e0, rises = 0, leave = 0, bounces = 0, prevE = e0
  for (let i = 0; i < 20 / DT; i++) {
    ball.step(DT)
    solveContacts([ball], [], (_s, _x, _z, _i, j) => {
      if (j <= WALL) bounces++
    }, { walls })
    const e = ball.energy
    if (e > prevE + 1e-12) rises++
    prevE = e
    maxE = Math.max(maxE, e)
    leave = Math.max(leave, Math.abs(ball.x) + BALL.r - walls.maxX, Math.abs(ball.z) + BALL.r - walls.maxZ)
  }
  console.log(`  ball: ${bounces} rail bounces, energy ${e0.toFixed(4)} J -> ${ball.energy.toExponential(1)} J`)
  assert(bounces >= 2 && rises === 0 && ball.energy === 0, `13. a kicked ball bounces off the rails, loses energy every step and comes to rest (${bounces} bounces)`)
  assert(leave <= OVERLAP_MAX, `13. the ball never leaves the mat (worst ${(leave * 1000).toFixed(2)} mm into a rail)`)
  // The same kick is the same impulse: bitwise.
  const k1 = new Ball(), k2 = new Ball()
  k1.place(0.1, 0.05)
  k2.place(0.1, 0.05)
  k1.kick(0.3, -0.7, 0.8)
  k2.kick(0.3, -0.7, 0.8)
  for (let i = 0; i < 300; i++) {
    k1.step(DT)
    k2.step(DT)
  }
  assert(k1.x === k2.x && k1.z === k2.z && k1.q.every((v, i) => v === k2.q[i]), '13. a kick is deterministic (same kick, bitwise same roll)')
  // A block pushed slides a little, turns from an off-centre hit, and stops; never through a rail.
  const b = new Block()
  b.place(0.6, 0, 0.3)
  b.push(1, 0.2, 0.6)
  let bl = 0
  for (let i = 0; i < 600; i++) {
    b.step(DT)
    solveContacts([b], [], undefined, { walls })
    for (const c of b.colliders) bl = Math.max(bl, c.x + c.r - walls.maxX)
  }
  assert(b.energy === 0 && bl <= OVERLAP_MAX, `13. a shoved block hits the rail, stops and stays on the mat (${(bl * 1000).toFixed(2)} mm)`)
}
{
  // A ball squeezed against a planted duck foot. A stance sole is fixed, so
  // the ball gives way to it -- and a robot shoving the ball into it must
  // then take the push itself, or the last pair solved wins and the ball
  // ends up inside the foot (3 mm in the hero's game). A poster duck stands
  // stock-still, its feet planted throughout; a wheel-leg drives a tyre (not
  // the gap between its wheels, which the ball rolls through) at it.
  for (const [name, ang] of [['from the side', 0], ['from in front', Math.PI / 2]] as const) {
    const g = new DuckGait(31, true)
    g.placeAt(0, 0, Math.PI / 2)
    g.step(DT, { speed: 0, yawRate: 0 })
    const D: Body = { mass: DUCK_SHAPE.mass, colliders: g.colliders, collide: (n, d, v, o, p) => g.collide(n, d, v, o, p) }
    const f = g.colliders[4]!
    const ux = Math.cos(ang), uz = Math.sin(ang)
    // Start the ball just clear of the whole duck, on the far side of that sole.
    let s0 = f.r + BALL.r + 0.003
    while (g.colliders.some(c => c.r > 0 && Math.hypot(f.x + ux * s0 - c.x, f.z + uz * s0 - c.z) < c.r + BALL.r + 0.003)) s0 += 0.001
    const ball = new Ball()
    ball.place(f.x + ux * s0, f.z + uz * s0)
    const Bal = balancer(32, ball.x + ux * 0.12 - uz * 0.078, ball.z + uz * 0.12 + ux * 0.078, Math.atan2(-ux, -uz))
    let worst = 0, pressed = 0
    for (let i = 0; i < 600; i++) {
      g.step(DT, { speed: 0, yawRate: 0 })
      Bal.step(Bal.bal!.busy ? 0 : 0.3, 0)
      ball.step(DT)
      const bodies: Body[] = [D, Bal, ball]
      solveContacts(bodies, [], undefined, { skinBodies: 2 })
      worst = Math.max(worst, maxOverlap(bodies, []).worst)
      const touch = (c: { x: number, z: number, r: number }) => c.r > 0 && Math.hypot(c.x - ball.x, c.z - ball.z) < c.r + BALL.r + 0.001
      if (g.colliders.some(c => c.fixed && touch(c)) && Bal.colliders.some(touch)) pressed++
    }
    console.log(`  ball shoved into a planted duck foot ${name}: ${pressed} steps squeezed, worst overlap ${(worst * 1000).toFixed(3)} mm`)
    assert(pressed > 20 && worst <= OVERLAP_MAX, `13. a ball shoved into a planted duck foot ${name} never sinks into it, or the shover, by > 2 mm (${(worst * 1000).toFixed(3)} mm over ${pressed} squeezed steps)`)
  }
  // A ball between a duck and a wall: the duck walks at it, stepping in on
  // the ball while the rail holds it. Neither the planted soles nor the rail
  // can give, so the duck must: its swing foot re-aims, its body shifts.
  const walls = { minX: -0.6, maxX: 0.3, minZ: -0.4, maxZ: 0.4 }
  let D = duck(33, 0, 0, Math.PI / 2)
  D.step(0, 0)
  const toe0 = Math.max(...D.colliders.slice(4).map(c => c.x + c.r))
  D = duck(33, walls.maxX - 2 * BALL.r - 0.004 - toe0, 0, Math.PI / 2)
  D.step(0, 0)
  const toe = D.colliders.slice(4).reduce((m, c) => (c.x + c.r > m.x + m.r ? c : m))
  const ball = new Ball()
  ball.place(walls.maxX - BALL.r - 0.001, toe.z)
  let worst = 0, sandwiched = 0
  for (let i = 0; i < 1200; i++) {
    D.step(0.15, 0)
    ball.step(DT)
    const bodies: Body[] = [D, ball]
    solveContacts(bodies, [], undefined, { skinBodies: 1, walls })
    worst = Math.max(worst, maxOverlap(bodies, [], walls).worst)
    if (ball.x + BALL.r > walls.maxX - 0.001 && D.colliders.some(c => c.fixed && c.r > 0 && Math.hypot(c.x - ball.x, c.z - ball.z) < c.r + BALL.r + 0.001)) sandwiched++
  }
  console.log(`  ball between a walking duck and a rail: ${sandwiched} steps pinned between a planted sole and the rail, worst overlap ${(worst * 1000).toFixed(3)} mm`)
  assert(sandwiched > 10 && worst <= OVERLAP_MAX, `13. a ball between a duck's planted foot and a wall never sinks into either by > 2 mm (${(worst * 1000).toFixed(3)} mm over ${sandwiched} pinned steps)`)
}
{
  // A ball squeezed between two bodies, neither of them planted (in the game:
  // a falling dog onto a ball against a wheel-leg's tyre). Twenty times
  // lighter than either, the ball was shoved to and fro and the last pair
  // solved left it inside the other (8.6 mm). Once it has given way to one,
  // it is not pushed back into it: the other takes the push, or the ball
  // squirts out sideways. Two heavy pushers (they honour every push, so any
  // overlap left is the solver's) close on it head-on and a little off-line.
  for (const off of [0, 0.004]) {
    const ball = new Ball()
    ball.place(0, 0)
    const pusher = (x: number, z: number, vx: number) => {
      const c = { x, z, r: 0.03, vx, vz: 0, fixed: false, y0: 0, y1: 0.1 }
      const body: Body = { mass: 1.2, colliders: [c], collide(n, d) {
        c.x += n.x * d
        c.z += n.z * d
      } }
      return { c, body }
    }
    const a = pusher(0.07, off, -0.5), b = pusher(-0.07, -off, 0.5)
    let worst = 0, pressed = 0
    for (let i = 0; i < 300; i++) {
      a.c.x += a.c.vx * DT
      b.c.x += b.c.vx * DT
      ball.step(DT)
      const bodies: Body[] = [a.body, b.body, ball]
      solveContacts(bodies, [], undefined, { skinBodies: 2 })
      worst = Math.max(worst, maxOverlap(bodies, []).worst)
      const touch = (c: { x: number, z: number, r: number }) => Math.hypot(c.x - ball.x, c.z - ball.z) < c.r + BALL.r + 0.001
      if (touch(a.c) && touch(b.c)) pressed++
    }
    console.log(`  ball squeezed between two bodies ${off ? 'a little off-line' : 'head-on'}: ${pressed} steps squeezed, worst overlap ${(worst * 1000).toFixed(3)} mm`)
    assert(pressed > 5 && worst <= OVERLAP_MAX, `13. a ball squeezed between two robots (neither planted) ${off ? 'a little off-line' : 'head-on'} never sinks into either by > 2 mm (${(worst * 1000).toFixed(3)} mm over ${pressed} squeezed steps)`)
  }
}
/**
 * The game, left to itself for `seconds`, on match `seed` (0: the page's).
 * Everything it must never do is measured at every step.
 */
async function playMatch(seed: number, seconds: number) {
  const h = await hero(false, seed)
  const w = watch(h)
  const R = h.debug.robots
  let fell = 0, longestDown = 0, clashAt = -1, goalAt = -1, ballOut = 0, robotOut = 0, worstText = 0
  const wasFallen = R.map(() => false)
  const downFor = R.map(() => 0)
  for (let i = 0; i < seconds / DT; i++) {
    stepWatch(h, w)
    const t = (i + 1) * DT
    R.forEach((r, k) => {
      if (r.fallen && !wasFallen[k]) fell++
      wasFallen[k] = r.fallen
      downFor[k] = r.fallen ? downFor[k]! + DT : 0
      longestDown = Math.max(longestDown, downFor[k]!)
      if (!h.debug.isFree(r.position.x, r.position.z, -0.002)) robotOut++
    })
    if (clashAt < 0 && h.debug.clashes() > 0) clashAt = t
    if (goalAt < 0 && h.debug.goals()[0] + h.debug.goals()[1] > 0) goalAt = t
    // The ball against the real walls (the screen's edges, the text); the pitch's boards are the game's, and give way to a leaning robot.
    const b = h.debug.ball
    ballOut = Math.max(ballOut, h.debug.isFree(b.x, b.z, BALL.r - 0.002) ? 0 : 1)
    if (i % 20 === 0) worstText = Math.max(worstText, intoText(h))
  }
  const [g0, g1] = h.debug.goals()
  const m = { kicks: h.debug.kicks(), clashes: h.debug.clashes(), clashAt, goals: g0 + g1, longestDown, worst: w.worst, ballOut, robotOut, worstText }
  console.log(`  match ${seed}, ${seconds} s of football: ${m.kicks} strikes, ${m.clashes} clashes (first at ${clashAt.toFixed(1)} s), goals ${g0}-${g1} (first at ${goalAt.toFixed(1)} s), ${fell} falls (longest down ${longestDown.toFixed(2)} s), worst overlap ${(w.worst * 1000).toFixed(3)} mm, ball popped out of a squeeze ${h.debug.pops()}x, ball ${ballOut ? 'went into a wall' : 'always on free floor'}, ${robotOut} steps with a robot off the free floor, deepest into the text ${worstText.toFixed(1)} px`)
  h.dispose()
  return m
}
/** What must hold in EVERY match, however it plays out. */
function assertSafe(m: Awaited<ReturnType<typeof playMatch>>, tag: string) {
  // A robot bumped while it lies there starts its get-up again: allow for that.
  assert(m.longestDown < 9, `13. ${tag}: everyone who falls gets up again (longest down ${m.longestDown.toFixed(1)} s)`)
  assert(m.worst <= OVERLAP_MAX, `13. ${tag}: robots, ball, goals, cones and walls never interpenetrate by > 2 mm (${(m.worst * 1000).toFixed(3)} mm)`)
  assert(m.ballOut <= 0.002 && m.robotOut === 0, `13. ${tag}: no robot and no ball leaves the screen or enters the text's walls`)
  assert(m.worstText <= 1, `13. ${tag}: no robot, prop or ball is ever drawn over the page's text (${m.worstText.toFixed(1)} px)`)
}
{
  // The page's match, 240 s. Its counts (strikes, clashes, goals) depend on
  // how this one game happens to go, so they are asserted on it alone.
  const m = await playMatch(0, 240)
  assert(m.kicks >= 10, `13. the robots play the ball on their own (${m.kicks} strikes in 4 minutes)`)
  assert(m.clashAt > 0 && m.clashAt <= 30, `13. a clash in the first 30 s of autonomous play (${m.clashAt.toFixed(1)} s)`)
  assert(m.clashes >= 12, `13. clashes keep coming: about every 10-15 s (${m.clashes} in 240 s)`)
  assert(m.goals >= 2, `13. goals are scored (${m.goals} in 240 s)`)
  assertSafe(m, 'the page\'s match')
}
{
  // Eight more matches, every draw reshuffled, 120 s each: the safety rules
  // hold on all of them, so passing does not rest on one lucky path.
  for (let seed = 1; seed <= 8; seed++) assertSafe(await playMatch(seed, 120), `match ${seed}`)
}

// ── 14. Grab and fling ─────────────────────────────────────────────────────
{
  // Held still where it was picked, then let go: no energy appears.
  const h = await hero()
  h.debug.routines(false)
  for (let i = 0; i < 200; i++) h.step(DT)
  const P = h.debug.pitch
  const cx = (P.x0 + P.x1) / 2, cz = (P.z0 + P.z1) / 2
  const iB = h.debug.robots.findIndex(r => r.kind === 'balancer')
  const bal = h.debug.robots[iB] as any
  const at = bal.position.clone().setY(0.17)
  h.debug.grab(iB, at)
  for (let i = 0; i < 300; i++) {
    h.debug.drag(at)
    h.step(DT)
  }
  h.debug.grab(iB, null)
  let maxV = 0
  for (let i = 0; i < 200; i++) {
    h.step(DT)
    maxV = Math.max(maxV, Math.abs(bal.sim.xd), Math.abs(bal.sim.thd) * 0.1)
  }
  assert(maxV < 0.05, `14. grabbed and released at rest: it is not flung (max speed ${maxV.toFixed(3)} m/s)`)
  // Flung: whip the wheel-leg forward along its heading at pod height and let go -- it
  // goes over (its LQR cannot hold a 9 N yank at the pod), lands, rights itself.
  const w = watch(h)
  // Clear the lane: everyone else to the far (left) end; the wheel-leg is flung toward +X.
  const spots = [[P.x0 + 0.2, P.z0 + 0.15], [P.x0 + 0.2, P.z1 - 0.15], [P.x0 + 0.48, P.z0 + 0.15], [P.x0 + 0.48, P.z1 - 0.15]]
  let sp = 0
  h.debug.robots.forEach((r, k) => {
    if (k !== iB) {
      const [x, z] = spots[sp++]!
      r.placeAt(x!, z!, 0)
    }
  })
  bal.placeAt(cx - 0.1, cz, Math.PI / 2)
  h.debug.ball.place(cx, P.z1 - 0.1)
  for (let i = 0; i < 100; i++) h.step(DT)
  const start = bal.position.clone()
  const fwd = new THREE.Vector3(Math.sin(bal.heading), 0, Math.cos(bal.heading))
  const grabAt = start.clone().setY(0.2)
  h.debug.grab(iB, grabAt)
  let balFell = false
  for (let i = 0; i < 240; i++) {
    h.debug.drag(grabAt.clone().addScaledVector(fwd, 0.8 * Math.min(1, i / 60)))
    stepWatch(h, w)
    balFell ||= bal.fallen
  }
  h.debug.grab(iB, null)
  for (let i = 0; i < 8 / DT; i++) {
    stepWatch(h, w)
    balFell ||= bal.fallen
  }
  console.log(`  fling: wheel-leg fell ${balFell}, worst overlap ${(w.worst * 1000).toFixed(3)} mm, all up again ${!h.debug.robots.some(r => r.fallen)}`)
  assert(balFell, '14. a hard yank on the grabbed wheel-leg topples it')
  assert(w.worst <= OVERLAP_MAX, '14. flung robots never interpenetrate by > 2 mm')
  assert(!h.debug.robots.some(r => r.fallen), '14. everyone is up again within 8 s')
  // A duck dragged hard falls and gets up.
  const iD = h.debug.robots.findIndex(r => r.kind === 'duck')
  const duck = h.debug.robots[iD]!
  const dAt = duck.position.clone().setY(0.2)
  h.debug.grab(iD, dAt)
  let duckFell = false
  for (let i = 0; i < 100; i++) {
    h.debug.drag(dAt.clone().add(new THREE.Vector3(0.3, 0, 0)))
    stepWatch(h, w)
    duckFell ||= duck.fallen
  }
  h.debug.grab(iD, null)
  for (let i = 0; i < 6 / DT; i++) stepWatch(h, w)
  assert(duckFell && !duck.fallen && !duck.busy, '14. a duck yanked hard falls over and gets back up')
  h.dispose()
}

// ── 15. The text is a wall: thrown at it, a robot stops at it ──────────────
{
  const h = await hero()
  const w = watch(h)
  for (let i = 0; i < 200; i++) stepWatch(h, w)
  const R = h.debug.robots
  let worstText = 0, robotOut = 0
  // Each robot in turn grabbed and dragged hard into the words (the drag
  // target over the words is held at their wall), then flung at them.
  for (let k = 0; k < R.length; k++) {
    const r = R[k]!
    const at = r.position.clone().setY(0.15)
    h.debug.grab(k, at)
    for (let i = 0; i < 160; i++) {
      // Toward the middle of the words block, as far as the drag allows.
      h.debug.drag(new THREE.Vector3(-1.2, 0.18, 0))
      stepWatch(h, w)
      if (i % 10 === 0) worstText = Math.max(worstText, intoText(h))
      R.forEach(q => { if (!h.debug.isFree(q.position.x, q.position.z, -0.002)) robotOut++ })
    }
    h.debug.grab(k, null)
    for (let i = 0; i < 300; i++) {
      stepWatch(h, w)
      if (i % 10 === 0) worstText = Math.max(worstText, intoText(h))
    }
  }
  // The ball kicked hard at the words and at the key box.
  h.debug.ball.kick(-1, 0.2, 1.5)
  for (let i = 0; i < 400; i++) {
    stepWatch(h, w)
    if (i % 10 === 0) worstText = Math.max(worstText, intoText(h))
  }
  console.log(`  thrown at the text: deepest any robot or the ball is drawn into a text rect ${worstText.toFixed(1)} px, ${robotOut} steps off the free floor, worst overlap ${(w.worst * 1000).toFixed(3)} mm`)
  assert(worstText <= 1 && robotOut === 0, '15. dragged and thrown at the text, robots and the ball stop at its wall: never drawn over it')
  assert(w.worst <= OVERLAP_MAX, '15. against the text\'s walls, overlap <= 2 mm')
  h.dispose()
}

// ── 16. The page moves its text: new walls, nobody left inside them ─────────
{
  const h = await hero()
  for (let i = 0; i < 400; i++) h.step(DT)
  const before = { ...h.debug.pitch }
  // The words block grows (a font loads, say): the robots in its way are lifted out.
  heroKeepOut.rects = [{ x0: 0.04, x1: 0.62, y0: 0.1, y1: 0.85 }, SAMPLE[1]!, SAMPLE[2]!, SAMPLE[3]!]
  heroKeepOut.version++
  h.step(DT)
  const inside = h.debug.robots.filter(r => !h.debug.isFree(r.position.x, r.position.z, -0.002)).length
  assert(h.debug.pitch.x0 > before.x0 && inside === 0, '16. a layout change rebuilds the walls and the pitch, and lifts out anyone it put inside')
  // Phone: no text beside the playground -- the whole slot is the playground.
  heroKeepOut.rects = []
  heroKeepOut.version++
  h.resize(390, 574)
  h.step(DT)
  assert(h.debug.walls.keepOut!.length === 3, '16. with no text rects, only the screen\'s own edges are walls')
  heroKeepOut.rects = SAMPLE
  heroKeepOut.version++
  h.dispose()
}

// ── 17. Layout: fast, exact, never fooled by its inputs ─────────────────────
{
  // A keep-out needs an area: two points, or points on a line, are none.
  assert(keepOutOf([0, 0, 1, 1]) === null && keepOutOf([0, 0, 0.5, 0.5, 1, 1, 0.2, 0.2]) === null && keepOutOf([0, 0, 1, 0, 0, 1]) !== null, '17. degenerate keep-outs (fewer than three corners, or collinear) are dropped')
  // The free-floor search: the best rectangle meets no keep-out; none at all
  // when the keep-outs cover the floor.
  const bounds = { minX: -1, maxX: 1, minZ: -0.6, maxZ: 0.6 }
  const keeps = [keepOutOf([-1.2, -0.7, -0.3, -0.7, -0.5, 0.7, -1.2, 0.7])!, keepOutOf([0.4, -0.7, 1.2, -0.7, 1.2, 0.1, 0.6, 0.1])!]
  const f = largestFree(bounds, keeps)!
  const kd = { d: 0, e: 0 }
  let clear = true
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 40; j++) {
      const x = f.minX + (f.maxX - f.minX) * i / 40, z = f.minZ + (f.maxZ - f.minZ) * j / 40
      for (const k of keeps) if (keepOutDistance(k, x, z, kd).d < -1e-6) clear = false
    }
  }
  const all = keepOutOf([-2, -2, 2, -2, 2, 2, -2, 2])!
  assert(clear && f.maxX - f.minX > 0.5 && largestFree(bounds, [all]) === null, `17. the largest free rectangle meets no keep-out (${f.minX.toFixed(3)}..${f.maxX.toFixed(3)} x ${f.minZ.toFixed(3)}..${f.maxZ.toFixed(3)}), and there is none on a covered floor`)
  // Rects set before the scene is made (the page's first layout, the lab's
  // ?keepout=) are walls from the first step, before any resize.
  const h = await createHero({ materials, palette, posterMode: false, coarse: false, width: SW, height: SH })
  const atCreate = h.debug.walls.keepOut!.length
  h.resize(SW, SH)
  assert(atCreate === h.debug.walls.keepOut!.length && atCreate > 3, `17. text rects set before create are walls from the start (${atCreate} keep-outs)`)
  // The same size and text again: nothing rebuilt.
  const board = h.scene.getObjectByName('pitch')
  h.resize(SW, SH)
  h.step(DT)
  assert(h.scene.getObjectByName('pitch') === board, '17. a resize to the same size with the same text rebuilds nothing')
  // A relayout (a window being dragged: a new size every frame) stays well inside a frame.
  const N = 20
  const t0 = performance.now()
  for (let i = 0; i < N; i++) h.resize(SW + (i % 2 ? 7 : -7), SH + (i % 3))
  const ms = (performance.now() - t0) / N
  console.log(`  relayout: ${ms.toFixed(2)} ms each`)
  assert(ms <= 8, `17. a relayout takes <= 8 ms (${ms.toFixed(2)} ms)`)
  h.dispose()
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
