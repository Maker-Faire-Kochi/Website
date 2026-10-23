/**
 * People and art props: motion, IK and physics checks (npx --yes tsx scripts/test-people.ts).
 *
 * Everything is checked on the ACTUAL posed skeleton -- forward kinematics of
 * the joint angles the controller produced -- never on the targets it was given.
 */
import * as THREE from 'three'
import { DT, FixedClock } from '../app/three/core/clock'
import type { Materials, MatKey } from '../app/three/core/kit'
import { VARIANTS, dimsFor, type Variant } from '../app/three/people/body'
import { ELBOW_MAX, apply, fkArm, fkLeg, mul, rotX, rotY, solveArm, type Mat3, type Vec3 } from '../app/three/people/ik'
import { B, BODY_STANCES, LIMITS, PARENT, PersonMotion, type Action, type BodyStance, type PlayOptions } from '../app/three/people/motion'
import { createPerson, variantGeometry } from '../app/three/people/person'
import { TONES, resolveLook, type Look } from '../app/three/people/style'
import { KiteSim, MobileSim, PendulumSim, RockSim, catenary } from '../app/three/people/props-sim'

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
const fmt = (x: number) => x.toExponential(2)

// Stand-in for the stage's materials (the real ones need a canvas for the shadow blob).
function fakeMaterials(): Materials {
  const keys: MatKey[] = ['red', 'cyan', 'accent', 'light', 'mid', 'dark', 'wood', 'woodDark', 'stone', 'metal', 'water', 'leaf']
  const face = Object.fromEntries(keys.map(k => [k, new THREE.MeshLambertMaterial()])) as Materials['face']
  return { face, line: new THREE.LineBasicMaterial(), lineFaint: new THREE.LineBasicMaterial(), shadow: new THREE.MeshBasicMaterial(), dispose() {} }
}
const ctx = { materials: fakeMaterials() }

// ── FK helpers on a pose ─────────────────────────────────────────────────

/** World sole corners (heel/toe x inner/outer) of both feet, from the posed legs. */
function soleCorners(m: PersonMotion): Vec3[][] {
  const P = m.pose
  const d = m.d
  const out: Vec3[][] = []
  for (const i of [0, 1] as const) {
    const fk = fkLeg(m.leg, P.pelvisPos, P.R[B.pelvis]!, i === 0 ? 1 : -1, m.legs[i])
    const pts: Vec3[] = []
    for (const z of [-d.heel, d.footLen - d.heel]) {
      for (const x of [-d.footW / 2, d.footW / 2]) {
        const c = apply(fk.soleR, [x, 0, z])
        pts.push(m.toWorld([fk.sole[0] + c[0], fk.sole[1] + c[1], fk.sole[2] + c[2]]))
      }
    }
    out.push(pts)
  }
  return out
}

function soleWorld(m: PersonMotion, i: 0 | 1): Vec3 {
  const fk = fkLeg(m.leg, m.pose.pelvisPos, m.pose.R[B.pelvis]!, i === 0 ? 1 : -1, m.legs[i])
  return m.toWorld(fk.sole)
}

const elbowSin = (R: Mat3) => R[7]
const dist = (a: Vec3, b: { x: number, y: number, z: number }) => Math.hypot(a[0] - b.x, a[1] - b.y, a[2] - b.z)

// ── 1. Arm IK ─────────────────────────────────────────────────────────────
{
  const UA = 0.32, FA = 0.25
  let maxErr = 0, finite = true, elbowOk = true
  let seed = 1
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  for (let k = 0; k < 4000; k++) {
    const dir: Vec3 = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]
    const l = Math.hypot(...dir) || 1
    const r = (0.3 + 0.68 * rnd()) * (UA + FA)
    const t: Vec3 = [dir[0] / l * r, dir[1] / l * r, dir[2] / l * r]
    const s = solveArm(t, [rnd() - 0.5, -1, rnd() - 0.5], UA, FA)
    const w = fkArm(s.R, s.elbow, UA, FA).wrist
    maxErr = Math.max(maxErr, Math.hypot(w[0] - t[0], w[1] - t[1], w[2] - t[2]))
    if (s.elbow > 1e-12 || s.elbow < -ELBOW_MAX - 1e-9) elbowOk = false
  }
  assert(maxErr < 1e-9, `arm IK reaches every target within reach (max error ${fmt(maxErr)} m)`)
  for (const t of [[0, 0, 5], [0, 0, 0], [NaN, 0, 0], [1e9, -1e9, 3], [0, -0.0001, 0]] as Vec3[]) {
    const s = solveArm(t, [0, -1, 0], UA, FA)
    const w = fkArm(s.R, s.elbow, UA, FA).wrist
    if (![...s.R, s.elbow, ...w].every(Number.isFinite)) finite = false
    if (s.elbow > 1e-12 || s.elbow < -ELBOW_MAX - 1e-9) elbowOk = false
  }
  assert(finite, 'arm IK stays finite for out-of-reach, zero-length and NaN targets')
  assert(elbowOk, 'arm IK never inverts the elbow (0 >= elbow >= -150 deg)')
  // Pole parallel to the reach line still gives a valid frame.
  const s = solveArm([0, -0.3, 0], [0, -1, 0], UA, FA)
  assert([...s.R, s.elbow].every(Number.isFinite), 'arm IK with the pole along the reach line is finite')
}

// ── 2. Scripted run: ground, planted feet, limits, leg reach ─────────────
interface Event { at: number, run: (m: PersonMotion) => void }
const SPOT = { x: 0.3, y: 0.2, z: 0.9 }
function script(): Event[] {
  const ev: Event[] = []
  let t = 0
  const at = (dt: number, run: (m: PersonMotion) => void) => { t += dt; ev.push({ at: Math.round(t / DT), run }) }
  const play = (a: Action, o: PlayOptions = {}) => (m: PersonMotion) => m.play(a, o)
  at(0.5, m => m.lookAt(SPOT))
  at(1, play('point', { target: SPOT }))
  at(2, play('wave'))
  at(3, play('clap'))
  at(3, play('crouch', { target: { x: 0.2, y: 0, z: 0.6 } }))
  at(3, play('step-back', { from: { x: 0.4, z: 1 } }))
  at(3, play('watch'))
  at(2, m => m.lookAt({ x: -3, y: 2, z: -1 }))
  at(2, play('pull-rope'))
  at(4, play('idle'))
  at(1, m => m.setStance('wide'))
  at(3, m => m.setStance('kneel'))
  at(4, m => m.setStance('sit', { seatHeight: 0.42 * m.scale * m.d.H / 1.7 }))
  at(4, m => m.setStance('stand'))
  at(3, play('step-back', { from: { x: 0, z: -2 } }))
  at(3, play('idle'))
  return ev
}

function run(variant: Variant, seed: number, steps: number, each?: (m: PersonMotion, k: number) => void, scale = 1) {
  const m = new PersonMotion(dimsFor(variant), seed, { scale })
  m.placeAt(0.2, -0.1, 0.4)
  const ev = script()
  for (let k = 0; k < steps; k++) {
    for (const e of ev) if (e.at === k) e.run(m)
    m.step(DT)
    each?.(m, k)
  }
  return m
}

{
  let minY = Infinity, slide = 0, clampedPlanted = 0, limitViolation = 0, nonFinite = 0, elbowBad = 0
  const STEPS = Math.round(48 / DT)
  for (const v of VARIANTS) {
    const anchor: (Vec3 | null)[] = [null, null]
    run(v, 7, STEPS, (m) => {
      for (const pts of soleCorners(m)) for (const p of pts) minY = Math.min(minY, p[1])
      for (const i of [0, 1] as const) {
        if (m.planted[i]) {
          const s = soleWorld(m, i)
          if (anchor[i]) slide = Math.max(slide, Math.hypot(s[0] - anchor[i]![0], s[1] - anchor[i]![1], s[2] - anchor[i]![2]))
          else anchor[i] = s
          if (m.legs[i].clamped || m.legs[i].limited) clampedPlanted++
        }
        else {
          anchor[i] = null
        }
      }
      if (Math.abs(m.headYaw.x) > LIMITS.headYaw + 1e-9 || Math.abs(m.torsoYaw.x) > LIMITS.torsoYaw + 1e-9
        || Math.abs(m.pelvisYaw.x) > LIMITS.pelvisYaw + 1e-9 || m.headPitch.x < LIMITS.headPitchUp - 1e-9
        || m.headPitch.x > LIMITS.headPitchDown + 1e-9) limitViolation++
      if (!m.pose.R.every(R => R.every(Number.isFinite)) || !m.pose.pelvisPos.every(Number.isFinite)) nonFinite++
      if (elbowSin(m.pose.R[B.faL]!) > 1e-9 || elbowSin(m.pose.R[B.faR]!) > 1e-9) elbowBad++
    }, v === 'child' ? 0.8 : 1)
  }
  assert(minY >= -1e-6, `feet never below the ground in any action or stance, all variants (lowest sole corner ${minY.toFixed(5)} m)`)
  assert(slide <= 1e-6, `planted feet do not slide: step-back, stance changes, reaching (max drift ${fmt(slide)} m)`)
  assert(clampedPlanted === 0, `leg IK never clamps or hits a joint limit on a planted foot (${clampedPlanted} steps did)`)
  assert(limitViolation === 0, `look-at angles stay within natural limits (${limitViolation} violations)`)
  assert(nonFinite === 0, 'pose stays finite throughout')
  assert(elbowBad === 0, 'elbows never invert during any action')
}

// ── 3. Determinism across frame rates (with frame() interpolation in between) ─
{
  const N = Math.round(30 / DT)
  const snapshot = (hz: number) => {
    const p = createPerson(ctx, { seed: 5, variant: 'kurta' })
    p.placeAt(0, 0, 0.3)
    const ev = script()
    const clock = new FixedClock()
    let k = 0
    let now = 0
    const target = new THREE.Vector3()
    while (k < N) {
      now += 1000 / hz
      const alpha = clock.advance(now, () => {
        if (k >= N) return
        for (const e of ev) if (e.at === k) e.run(p.motion)
        // A tool handle moving: the scene drives the hand every step.
        if (k > N / 2) p.setHandTarget('right', { position: target.set(0.25 + 0.1 * Math.sin(k * DT * 5), 0.9, 0.45) })
        p.step(DT)
        k++
      })
      p.frame(alpha)
    }
    const m = p.motion
    const s = [...m.pose.pelvisPos, ...m.pose.R.flat(), m.pos.x, m.pos.z, m.feet[0].x, m.feet[1].z]
    p.dispose()
    return s
  }
  const a = snapshot(30), b = snapshot(60), c = snapshot(144)
  const same = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => v === y[i])
  assert(same(a, b) && same(a, c), 'same seed + same step count = identical pose at 30, 60 and 144 Hz')
}

// ── 4. Hand targets: exact within reach, in every stance; finite beyond ───
{
  const results: string[] = []
  let worst = 0, slide = 0, minY = Infinity, nonFinite = 0, elbowBad = 0, outOfReach = 0
  for (const stance of BODY_STANCES) {
    for (const v of ['shirt', 'skirt', 'child'] as Variant[]) {
      const m = new PersonMotion(dimsFor(v), 3)
      m.placeAt(0, 0, 0)
      const H = m.d.H
      m.setStance(stance as BodyStance, { seatHeight: 0.26 * H })
      for (let k = 0; k < Math.round(3 / DT); k++) m.step(DT)
      // A saw stroke for the right hand, a steadying left hand: both in front, within reach.
      // Work height a little below the shoulders of each stance, inside arm's reach.
      const base = stance === 'sit' ? 0.46 * H : stance === 'kneel' ? 0.4 * H : 0.64 * H
      const anchor = [soleWorld(m, 0), soleWorld(m, 1)]
      let err = 0
      for (let k = 0; k < Math.round(6 / DT); k++) {
        const t = k * DT
        const right = { x: -0.06 * H, y: base + 0.02 * H * Math.sin(t * 7), z: 0.21 * H + 0.04 * H * Math.sin(t * 5) }
        const left = { x: 0.1 * H, y: base - 0.02 * H, z: 0.17 * H }
        m.setHandTarget('right', { position: right, normal: { x: 0, y: 1, z: 0 } })
        m.setHandTarget('left', { position: left })
        m.step(DT)
        if (t > 0.6) {
          if (m.reachExcess > 0) outOfReach++
          err = Math.max(err, dist(m.handWorld('right'), right), dist(m.handWorld('left'), left))
        }
        for (const i of [0, 1] as const) {
          const s = soleWorld(m, i)
          slide = Math.max(slide, Math.hypot(s[0] - anchor[i]![0], s[1] - anchor[i]![1], s[2] - anchor[i]![2]))
        }
        for (const pts of soleCorners(m)) for (const p of pts) minY = Math.min(minY, p[1])
        if (elbowSin(m.pose.R[B.faL]!) > 1e-9 || elbowSin(m.pose.R[B.faR]!) > 1e-9) elbowBad++
      }
      worst = Math.max(worst, err)
      results.push(`${stance}/${v} ${(err * 1000).toFixed(3)}mm`)
    }
  }
  console.log('  hand error by stance/variant:', results.join(', '))
  assert(outOfReach === 0, 'the test targets are inside arm reach in every stance')
  assert(worst <= 1e-3, `hand targets within reach are held to <= 1 mm in every stance (worst ${(worst * 1000).toFixed(4)} mm)`)
  assert(slide <= 1e-6, `feet stay planted while reaching, every stance (max drift ${fmt(slide)} m)`)
  assert(minY >= -1e-6, `no sole corner below the ground while reaching (lowest ${minY.toFixed(5)} m)`)
  assert(elbowBad === 0, 'elbows never invert while gripping')

  // Out of reach: finite, the torso leans, then a standing person steps toward it.
  const m = new PersonMotion(dimsFor('shirt'), 4)
  m.placeAt(0, 0, 0)
  const far = { x: 0, y: 1.0, z: 1.6 }
  let leaned = 0
  for (let k = 0; k < Math.round(6 / DT); k++) {
    m.setHandTarget('right', { position: far })
    m.step(DT)
    leaned = Math.max(leaned, m.reachLean)
    if (!m.pose.R.every(R => R.every(Number.isFinite))) nonFinite++
  }
  assert(nonFinite === 0, 'hand target beyond reach stays finite')
  assert(leaned > 0.2 && m.pos.z > 0.1, `beyond reach the torso leans (${leaned.toFixed(2)} rad) and the person steps toward it (moved ${m.pos.z.toFixed(2)} m)`)
  for (let k = 0; k < Math.round(4 / DT); k++) { m.setHandTarget('right', { position: far }); m.step(DT) }
  const errFar = dist(m.handWorld('right'), far)
  assert(errFar <= 1e-3, `after stepping closer the hand reaches the far target (${(errFar * 1000).toFixed(3)} mm)`)
  const bad = { x: NaN, y: 1, z: 0.3 }
  const n = new PersonMotion(dimsFor('kurta'), 2)
  n.setHandTarget('left', { position: bad })
  for (let k = 0; k < 100; k++) n.step(DT)
  n.lookAt({ x: NaN, y: 1, z: Infinity })
  n.setRopePhase(NaN)
  n.setLean(NaN, NaN)
  for (let k = 0; k < 100; k++) n.step(DT)
  assert(n.pose.R.every(R => R.every(Number.isFinite)) && n.pose.pelvisPos.every(Number.isFinite), 'NaN hand, look, rope-phase and lean inputs do not poison the pose')
}

// ── 5. Pull-rope follows an external phase ────────────────────────────────
{
  // Two identical haulers held at phases 0.1 and 0.2: the gripping (left) hand
  // is a tenth of a cycle further along the rope, i.e. half a stroke x 0.2.
  const at = (phase: number) => {
    const m = new PersonMotion(dimsFor('mundu'), 9)
    m.play('pull-rope')
    for (let k = 0; k < 600; k++) { m.setRopePhase(phase); m.step(DT) }
    return { m, h: m.handWorld('left') }
  }
  const a = at(0.1), b = at(0.2)
  const moved = Math.hypot(a.h[0] - b.h[0], a.h[1] - b.h[1], a.h[2] - b.h[2])
  const expect = a.m.ropeHaulPerCycle / 2 * 0.2
  assert(Math.abs(moved - expect) < 1e-6 && a.m.ropePhase === 0.1, `pull-rope grip follows the scene's ropePhase exactly (${(moved * 1000).toFixed(2)} vs ${(expect * 1000).toFixed(2)} mm; ${a.m.ropeHaulPerCycle.toFixed(3)} m per cycle)`)
}

// ── 6. Geometry sharing and draw calls ────────────────────────────────────
{
  // Same variant AND same look share every buffer (the look is part of the cache key).
  const a = createPerson(ctx, { seed: 1, variant: 'mundu' })
  const b = createPerson(ctx, { seed: 2, variant: 'mundu', look: a.look })
  const c = createPerson(ctx, { seed: 3, variant: 'child' })
  const geos = (p: typeof a) => {
    const g: THREE.BufferGeometry[] = []
    p.root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) g.push((o as THREE.Mesh).geometry) })
    return g
  }
  const ga = geos(a), gb = geos(b), gc = geos(c)
  assert(ga.length > 0 && ga.length === gb.length && ga.every((g, i) => g === gb[i]), `two people of one variant share the same BufferGeometry objects (${ga.length} each)`)
  assert(!gc.some(g => ga.includes(g)), 'different variants do not share geometry')
  let maxCalls = 0, maxTris = 0, maxLineV = 0, badAttr = 0, maxBuild = 0
  const heavy: Partial<Look> = { glasses: true, facial: 'beard', apron: true, sleeves: 'rolled' }
  for (const v of VARIANTS) {
    for (const look of [{}, heavy] as Partial<Look>[]) {
      const t0 = performance.now()
      const p = createPerson(ctx, { seed: 4, variant: v, accent: true, look })
      maxBuild = Math.max(maxBuild, performance.now() - t0)
      let calls = 0, tris = 0
      p.root.traverse((o) => {
        if (!(((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine) && o.visible)) return
        calls++
        const g = (o as THREE.Mesh).geometry
        const pos = g.attributes.position!
        if (!(pos.array as Float32Array).every(Number.isFinite)) badAttr++
        if ((o as THREE.SkinnedMesh).isSkinnedMesh && (o as THREE.Mesh).isMesh) tris += (g.index ? g.index.count : pos.count) / 3
        if ((o as THREE.Line).isLine && (o as THREE.Object3D).name.endsWith(':lines')) {
          maxLineV = Math.max(maxLineV, pos.count)
          if (!g.attributes.eN1 || !g.attributes.eN2 || g.attributes.eN1.count !== pos.count) badAttr++
        }
      })
      maxCalls = Math.max(maxCalls, calls)
      maxTris = Math.max(maxTris, tris)
      p.dispose()
    }
  }
  assert(maxCalls <= 8, `one person is at most ${maxCalls} draw calls, with every look incl. an apron (budget 8)`)
  assert(maxTris <= 9000, `one person is at most ${maxTris} triangles (budget 9000)`)
  assert(badAttr === 0, `person geometry is finite and the hairlines carry both face normals (${maxLineV} line vertices max)`)
  console.log(`  slowest first build of a variant + look: ${maxBuild.toFixed(1)} ms`)
  a.dispose()
  assert(variantGeometry('mundu') !== null, 'shared geometry survives while another person still uses it')
  b.dispose()
  c.dispose()
  assert(variantGeometry('mundu') === null && variantGeometry('child') === null, 'shared geometry is released with its last person')
}

// ── 7. Prop physics: bounded and settling ─────────────────────────────────
{
  const levels = [
    { areaArm: 0.12, area: 0.004, inertia: 0.006 },
    { areaArm: -0.08, area: 0.002, inertia: 0.002 },
    { areaArm: 0.05, area: 0.001, inertia: 0.0006 },
  ]
  const mob = new MobileSim(levels, 3, false)
  let maxW = 0
  let s = 11
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5 }
  for (let k = 0; k < Math.round(10 / DT); k++) {
    if (k % 7 === 0) mob.wind(rnd() * 40, rnd() * 40)
    if (k % 400 === 0) mob.push(1)
    mob.step(DT)
    maxW = Math.max(maxW, ...mob.omega.map(Math.abs))
  }
  const e0 = mob.energy()
  for (let k = 0; k < Math.round(90 / DT); k++) mob.step(DT)
  assert(maxW <= 6 && mob.theta.every(Number.isFinite), `mobile stays bounded under violent pointer wind (max spin ${maxW.toFixed(2)} rad/s)`)
  assert(mob.energy() < 1e-6 * Math.max(1, e0) || mob.energy() < 1e-8, `mobile settles once the wind stops (energy ${fmt(e0)} -> ${fmt(mob.energy())})`)

  const kite = new KiteSim([0, 1, 0], 3, [0.3, -1], 5, false)
  const eq = kite.equilibriumElevation()
  let maxV = 0
  for (let k = 0; k < Math.round(8 / DT); k++) {
    if (k % 300 === 0) kite.tug(1)
    kite.step(DT)
    maxV = Math.max(maxV, Math.hypot(...kite.v))
  }
  for (let k = 0; k < Math.round(30 / DT); k++) kite.step(DT)
  const r = Math.hypot(kite.p[0], kite.p[1] - 1, kite.p[2])
  const elev = Math.asin((kite.p[1] - 1) / r)
  assert(maxV <= 12 && kite.p.every(Number.isFinite), `kite stays bounded through repeated tugs (max speed ${maxV.toFixed(2)} m/s)`)
  assert(Math.hypot(...kite.v) < 1e-3 && Math.abs(elev - eq) < 0.02, `kite settles at its equilibrium string angle (${(elev * 180 / Math.PI).toFixed(1)} vs ${(eq * 180 / Math.PI).toFixed(1)} deg)`)

  const pts = new Float32Array(33 * 3)
  catenary([0, 1, 0], [1.2, 3.5, -1.6], 3.2, 32, pts)
  let len = 0
  for (let i = 0; i < 32; i++) len += Math.hypot(pts[i * 3 + 3]! - pts[i * 3]!, pts[i * 3 + 4]! - pts[i * 3 + 1]!, pts[i * 3 + 5]! - pts[i * 3 + 2]!)
  const endErr = Math.hypot(pts[96]! - 1.2, pts[97]! - 3.5, pts[98]! + 1.6)
  assert(Math.abs(len - 3.2) < 0.01 && endErr < 1e-4, `kite string catenary has its length and meets both ends (length ${len.toFixed(4)}, end error ${fmt(endErr)})`)

  const lamp = new PendulumSim(0.3, 0.05, 2, false)
  lamp.push(1, 0.4, 1)
  for (let k = 0; k < 400; k++) lamp.wind(30, -30)
  for (let k = 0; k < Math.round(60 / DT); k++) lamp.step(DT)
  assert(Math.abs(lamp.a[0]!) < 1e-4 && Math.abs(lamp.a[1]!) < 1e-4, 'lantern pendulum settles after a push and a gust')
  const pot = new RockSim()
  pot.knock(0.5, 5)
  let maxPhi = 0
  for (let k = 0; k < Math.round(10 / DT); k++) { pot.step(DT); maxPhi = Math.max(maxPhi, Math.abs(pot.phi)) }
  assert(maxPhi <= 0.16 && Math.abs(pot.phi) < 1e-4, `pot rocking is bounded (${maxPhi.toFixed(3)} rad) and settles`)
}

// ── 8. Legs: IK -> FK round trip ──────────────────────────────────────────
{
  const m = new PersonMotion(dimsFor('shirt'), 1)
  const fk = fkLeg(m.leg, m.pose.pelvisPos, m.pose.R[B.pelvis]!, 1, m.legs[0])
  const target = m.slotLocal(0)
  const R = mul(rotY(target.yaw), rotX(target.pitch))
  const err = Math.hypot(fk.sole[0] - target.x, fk.sole[1] - target.y, fk.sole[2] - target.z)
  const nErr = Math.abs(fk.soleR[4] - R[4])
  assert(err < 1e-9 && nErr < 1e-9, `standing leg FK lands on its foot slot (${fmt(err)} m)`)
  const knee = m.legs[0].knee * 180 / Math.PI
  assert(knee > 3 && knee < 20, `standing knee is nearly straight (${knee.toFixed(1)} deg), bending forward`)
}

// ── 9. Looks and colours ──────────────────────────────────────────────────
{
  const a = resolveLook('mundu', 21), b = resolveLook('mundu', 21)
  assert(JSON.stringify(a) === JSON.stringify(b), 'the same seed gives the same look')
  const looks = new Set<string>()
  for (let seed = 1; seed <= 40; seed++) looks.add(resolveLook('shirt', seed).hair + resolveLook('shirt', seed).facial)
  assert(looks.size >= 4, `seeds give a varied crowd (${looks.size} hair/face combinations over 40 shirt seeds)`)
  const pinned = createPerson(ctx, { seed: 3, variant: 'mundu', look: { lungi: true, folded: true, apron: true } })
  assert(pinned.look.lungi && pinned.look.folded && pinned.look.apron, 'a pinned look (lungi, folded, apron) is honoured')
  const kid = resolveLook('child', 5, { facial: 'beard', lungi: true })
  const scarf = resolveLook('headscarf', 5, { hair: 'long' })
  assert(kid.facial === 'none' && !kid.lungi && scarf.hair === 'none', 'impossible combinations are corrected (no beard on a child, no lungi off a mundu, no hair out of a headscarf)')
  // Different looks of one variant do not share; the cache entry goes with its last person.
  const other = createPerson(ctx, { seed: 3, variant: 'mundu', look: { lungi: false, folded: false, apron: false } })
  const g1: THREE.BufferGeometry[] = [], g2: THREE.BufferGeometry[] = []
  pinned.root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) g1.push((o as THREE.Mesh).geometry) })
  other.root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) g2.push((o as THREE.Mesh).geometry) })
  assert(!g1.some(g => g2.includes(g)), 'different looks of one variant do not share geometry')
  pinned.dispose()
  other.dispose()
  assert(variantGeometry('mundu') === null, 'look-keyed geometry is released with its last person')
  // Skin is always a real skin tone unless the scene pins a colour.
  let skinOk = true
  for (const v of VARIANTS) {
    for (let seed = 1; seed <= 12; seed++) {
      const p = createPerson(ctx, { seed, variant: v })
      p.root.traverse((o) => {
        if (!(o as THREE.SkinnedMesh).isSkinnedMesh || !o.name.endsWith(':skin')) return
        const c = ((o as THREE.Mesh).material as THREE.MeshLambertMaterial).color.getHexString()
        if (!Object.entries(TONES).some(([k, hex]) => k.startsWith('skin') && new THREE.Color(hex).getHexString() === c)) skinOk = false
      })
      p.dispose()
    }
  }
  assert(skinOk, 'every seeded skin colour is one of the human skin tones (never a grey or palette swatch)')
}

// ── 10. Idle life: weight on one leg, then the other; feet stay put ───────
{
  const m = new PersonMotion(dimsFor('shirt'), 12)
  m.placeAt(0, 0, 0)
  const anchors = [soleWorld(m, 0), soleWorld(m, 1)]
  let lo = Infinity, hi = -Infinity, slide = 0, roll = 0
  for (let k = 0; k < Math.round(40 / DT); k++) {
    m.step(DT)
    const x = m.pose.pelvisPos[0]
    lo = Math.min(lo, x)
    hi = Math.max(hi, x)
    roll = Math.max(roll, Math.abs(Math.atan2(m.pose.R[B.head]![3]!, m.pose.R[B.head]![4]!)))
    for (const i of [0, 1] as const) {
      const s = soleWorld(m, i)
      slide = Math.max(slide, Math.hypot(s[0] - anchors[i]![0], s[1] - anchors[i]![1], s[2] - anchors[i]![2]))
    }
  }
  const range = (hi - lo) / m.d.hipW
  assert(range > 0.6, `an idle person shifts their weight from leg to leg (hips travel ${range.toFixed(2)} x hip width)`)
  assert(slide <= 1e-6, `weight shifts never move a planted foot (drift ${fmt(slide)} m)`)
  assert(roll < 0.12, `the head stays nearly level over the tilting body (max roll ${roll.toFixed(3)} rad)`)
  const poster = new PersonMotion(dimsFor('shirt'), 12, { posterMode: true })
  const before = JSON.stringify(poster.pose)
  for (let k = 0; k < 2000; k++) poster.step(DT)
  assert(JSON.stringify(poster.pose) === before, 'poster mode holds a fixed pose (no idle life)')
}

// ── 11. Seated on a rung, rest-pose variety, skin weights ─────────────────
{
  const m = new PersonMotion(dimsFor('shirt'), 8)
  m.placeAt(0, 0, 0)
  const H = m.d.H
  m.setStance('sit', { seatHeight: 0.26 * H, footHeight: 0.12 * H, instant: true })
  for (let k = 0; k < Math.round(2 / DT); k++) m.step(DT)
  const soles = [soleWorld(m, 0), soleWorld(m, 1)]
  const onRung = soles.every(s => Math.abs(s[1] - 0.12 * H) < 1e-6)
  const clamped = m.legs[0].clamped || m.legs[1].clamped
  assert(onRung && !clamped, `seated with footHeight, both feet rest on the rung (${soles.map(s => s[1].toFixed(3)).join(', ')} m) without over-stretching`)
  const hip = m.pose.pelvisPos[1] - 0.26 * H
  assert(hip > 0.04 * H && hip < 0.07 * H, `seated, the hip joints sit just above the seat so the thighs rest on it (${(hip / H).toFixed(3)} H)`)
  // Rest poses differ across a crowd and change over time.
  const poses = new Set<string>()
  for (let seed = 1; seed <= 16; seed++) {
    const p = new PersonMotion(dimsFor('kurta'), seed)
    for (let k = 0; k < Math.round(30 / DT); k++) {
      p.step(DT)
      if (k % 400 === 0) poses.add(JSON.stringify(p.pose.R[B.uaL]!.map(v => Math.round(v * 3))))
    }
  }
  assert(poses.size >= 4, `idle people rest their arms in varied ways (${poses.size} distinct arm poses over 16 people)`)
}
{
  // Every skin weight is normalised and the bind pose reproduces the authored part (rigid parts unchanged).
  const p = createPerson(ctx, { seed: 2, variant: 'mundu', look: { apron: true } })
  let bad = 0, maxSum = 0
  p.root.traverse((o) => {
    if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return
    const w = (o as THREE.Mesh).geometry.attributes.skinWeight as THREE.BufferAttribute
    for (let i = 0; i < w.count; i++) {
      const s = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i)
      maxSum = Math.max(maxSum, Math.abs(s - 1))
      if (!Number.isFinite(s)) bad++
    }
  })
  assert(bad === 0 && maxSum < 1e-5, `every skin weight sums to 1 (max error ${fmt(maxSum)})`)
  p.dispose()
}

// ── 12. Grips, wrists, continuity, clearances ────────────────────────────
{
  /** Body-frame position and rotation of a bone from the pose (heading 0, scale 1 here). */
  const fk = (m: PersonMotion, bone: number) => {
    const chain: number[] = []
    for (let b = bone; b >= 0; b = PARENT[b]!) chain.unshift(b)
    let R: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    let p: Vec3 = [0, 0, 0]
    for (const b of chain) {
      const o = b === B.pelvis ? m.pose.pelvisPos : m.offsets[b]!
      const lift = b === B.uaL || b === B.uaR ? m.pose.shoulderLift : 0
      const off = apply(R, [o[0], o[1] + lift, o[2]])
      p = [p[0] + off[0], p[1] + off[1], p[2] + off[2]]
      R = mul(R, m.pose.R[b]!)
    }
    return { p, R }
  }
  const colv = (R: Mat3, j: number): Vec3 => [R[j]!, R[3 + j]!, R[6 + j]!]
  const dotv = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const ang = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dotv(a, b) / (Math.hypot(...a) * Math.hypot(...b) || 1)))) * 180 / Math.PI
  const wristAngles = (m: PersonMotion, i: 0 | 1) => {
    const W = m.pose.R[i === 0 ? B.handL : B.handR]!
    const hy = colv(W, 1), hx = colv(W, 0)
    const bend = ang([0, 1, 0], hy)
    const ex: Vec3 = [1 - hy[0] * hy[0], -hy[0] * hy[1], -hy[0] * hy[2]]
    return { bend, twist: ang(ex, hx) }
  }

  // Wrist limits over random grips, with and without a handle axis.
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  let maxBend = 0, maxTwist = 0, maxErr = 0
  for (let trial = 0; trial < 40; trial++) {
    const m = new PersonMotion(dimsFor('shirt'), trial + 1)
    m.placeAt(0, 0, 0)
    const H = m.d.H
    const pos = { x: (rnd() - 0.5) * 0.5 * H, y: (0.45 + rnd() * 0.3) * H, z: (0.12 + rnd() * 0.16) * H }
    const nv: Vec3 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]
    const av: Vec3 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]
    const normal = { x: nv[0], y: nv[1], z: nv[2] }
    const axis = trial % 2 ? { x: av[0], y: av[1], z: av[2] } : undefined
    for (let k = 0; k < Math.round(1.5 / DT); k++) {
      m.setHandTarget('right', { position: pos, normal, axis })
      m.step(DT)
      const w = wristAngles(m, 1)
      maxBend = Math.max(maxBend, w.bend)
      maxTwist = Math.max(maxTwist, w.twist)
    }
    if (m.reachExcess <= 0) maxErr = Math.max(maxErr, dist(m.handWorld('right'), pos))
  }
  assert(maxBend <= 75.5 && maxTwist <= 90.5, `wrists stay within 75 deg of bend and 90 deg of twist over random grips (max ${maxBend.toFixed(1)}, ${maxTwist.toFixed(1)}); the forearm takes the rest`)
  assert(maxErr <= 1e-3, `with the wrist limited the palm still lands on reachable grips (worst ${(maxErr * 1000).toFixed(3)} mm)`)

  // A wrap with a handle axis: fingers across the handle, palm on it.
  {
    const m = new PersonMotion(dimsFor('mundu'), 3)
    m.placeAt(0, 0, 0)
    const H = m.d.H
    const cases: { axis: Vec3, normal: Vec3 }[] = [
      { axis: [1, 0, 0], normal: [0, 1, 0] }, // a mallet handle lying across, palm on top
      { axis: [0, 1, 0], normal: [0, 0, -1] }, // an upright chisel, palm from behind
      { axis: [0, 0.4, 1], normal: [1, 0, 0] }, // a saw handle pointing ahead
    ]
    let worstAlong = 0, worstPalm = 0, worstErr = 0
    for (const c of cases) {
      const pos = { x: -0.06 * H, y: 0.55 * H, z: 0.2 * H }
      for (let k = 0; k < Math.round(1.5 / DT); k++) {
        m.setHandTarget('right', { position: pos, normal: { x: c.normal[0], y: c.normal[1], z: c.normal[2] }, axis: { x: c.axis[0], y: c.axis[1], z: c.axis[2] }, kind: 'wrap', radius: 0.016 })
        m.step(DT)
      }
      const h = fk(m, B.handR)
      const fingers = colv(h.R, 1).map(v => -v) as Vec3
      const palmDir = colv(h.R, 0) // right hand: the palm faces +X of the hand
      const a = c.axis
      const al = Math.hypot(...a)
      worstAlong = Math.max(worstAlong, Math.abs(dotv(fingers, a) / al))
      worstPalm = Math.max(worstPalm, ang(palmDir, [-c.normal[0], -c.normal[1], -c.normal[2]]))
      worstErr = Math.max(worstErr, dist(m.handWorld('right'), pos))
    }
    assert(worstAlong < 0.3 && worstPalm <= 30.5 && worstErr <= 1e-3, `a wrap with an axis puts the fingers across the handle (|f.axis| ${worstAlong.toFixed(2)}) and the palm on it (${worstPalm.toFixed(1)} deg), palm exact (${(worstErr * 1000).toFixed(3)} mm)`)
  }

  // Continuity: target switches, lean and stance changes never teleport a hand or pop a shoulder.
  {
    const m = new PersonMotion(dimsFor('shirt'), 5)
    m.placeAt(0, 0, 0)
    const H = m.d.H
    let maxHand = 0, maxShoulder = 0, elbowUp = 0
    let prevP: Vec3[] | null = null, prevS: Vec3[] | null = null
    const targets = [
      { x: -0.2 * H, y: 0.5 * H, z: 0.2 * H }, { x: 0.15 * H, y: 0.62 * H, z: 0.15 * H }, { x: -0.05 * H, y: 0.45 * H, z: -0.12 * H }, null,
    ]
    for (let k = 0; k < Math.round(24 / DT); k++) {
      const tt = k * DT
      const beat = Math.floor(tt / 1.2)
      const tg = targets[beat % targets.length]!
      m.setHandTarget('right', tg ? { position: tg } : null)
      if (beat % 3 === 0) m.setLean(beat % 2 ? 0.6 : 0)
      if (k === Math.round(8 / DT)) m.play('crouch')
      if (k === Math.round(11 / DT)) m.play('idle')
      if (k === Math.round(14 / DT)) m.setStance('wide')
      if (k === Math.round(18 / DT)) m.play('clap')
      m.step(DT)
      const palms = [m.handWorld('left'), m.handWorld('right')]
      const sh = [fk(m, B.uaL).p, fk(m, B.uaR).p]
      if (prevP && prevS) {
        for (const i of [0, 1]) {
          maxHand = Math.max(maxHand, Math.hypot(palms[i]![0] - prevP[i]![0], palms[i]![1] - prevP[i]![1], palms[i]![2] - prevP[i]![2]) / DT)
          maxShoulder = Math.max(maxShoulder, Math.hypot(sh[i]![0] - prevS[i]![0], sh[i]![1] - prevS[i]![1], sh[i]![2] - prevS[i]![2]) / DT)
        }
      }
      // During blends toward targets below the shoulder the elbow stays below the shoulder.
      const el = fk(m, B.faR).p
      if (tg && tg.y < sh[1]![1] - 0.1 * H && el[1] > sh[1]![1] + 0.01) elbowUp++
      prevP = palms
      prevS = sh
    }
    assert(maxHand <= 4, `hands never jump: at most ${maxHand.toFixed(2)} m/s through target switches, leans and stance changes (limit 4)`)
    assert(maxShoulder <= 1, `shoulders never pop: at most ${maxShoulder.toFixed(2)} m/s (limit 1)`)
    assert(elbowUp === 0, `the elbow stays below the shoulder while a hand swings to a low target (${elbowUp} steps above)`)
  }

  // Regression (backwater visitor, "hit: look"): both palms flat on a coconut held up by the
  // head, then swept down and out behind the back at ~2 m/s. Palms turned away right by the
  // shoulder are a grip no wrist can take; the palm used to skip about at up to 30 m/s.
  {
    const RDT = 0.005
    const keys: [number, number, number, number][] = [
      [0, 0.14, 1.475, -0.145], [1.75, 0.142, 1.464, -0.149], [1.875, 0.234, 1.205, -0.136], [2.0, 0.325, 0.946, -0.124],
      [2.125, 0.351, 0.944, 0.065], [2.25, 0.351, 1.042, 0.322], [2.375, 0.323, 0.937, 0.191], [3.0, 0.323, 0.937, 0.191],
    ]
    const at = (t: number): Vec3 => {
      let k = 0
      while (k < keys.length - 2 && keys[k + 1]![0] <= t) k++
      const a = keys[k]!, b = keys[k + 1]!
      const u = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])))
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u]
    }
    let worst = 0
    for (const yaw of [0, -0.746]) {
      const m = new PersonMotion(dimsFor('headscarf'), 19)
      m.placeAt(0, 0, yaw)
      const c = Math.cos(yaw), s = Math.sin(yaw)
      const w = (x: number, y: number, z: number) => ({ x: c * x + s * z, y, z: -s * x + c * z })
      let prev: Vec3[] | null = null
      for (let k = 0; k < Math.round(3 / RDT); k++) {
        const p = at(k * RDT)
        m.setHandTarget('left', { position: w(p[0], p[1], p[2]), normal: w(1, 0, 0), elbow: w(0.6, -1, 0), kind: 'flat' })
        m.setHandTarget('right', { position: w(-p[0], p[1], p[2]), normal: w(-1, 0, 0), elbow: w(-0.6, -1, 0), kind: 'flat' })
        m.step(RDT)
        const palms = [m.handWorld('left'), m.handWorld('right')]
        if (prev) for (const i of [0, 1]) worst = Math.max(worst, Math.hypot(palms[i]![0] - prev[i]![0], palms[i]![1] - prev[i]![1], palms[i]![2] - prev[i]![2]) / RDT)
        prev = palms
      }
    }
    assert(worst <= 4, `palms stay continuous on a grip the wrist cannot take (flat palms swept behind the head): at most ${worst.toFixed(2)} m/s (limit 4)`)
  }

  // Gaze: a look target with priority holds the eyes while the hands work (fishers watching
  // the net, a child watching the kite), the hands get a glance on request; a moving look
  // target called every step is tracked (it used to restart the reaction delay every call).
  {
    const headOff = (m: PersonMotion, to: { x: number, y: number, z: number }) => {
      const h = fk(m, B.head)
      const eye: Vec3 = [h.p[0], h.p[1] + 0.06 * m.d.H, h.p[2]]
      return ang(colv(h.R, 2), [to.x - eye[0], to.y - eye[1], to.z - eye[2]])
    }
    const net = { x: 1.6, y: 0.1, z: 4 }
    const m = new PersonMotion(dimsFor('mundu'), 7)
    m.placeAt(0, 0, 0)
    const H = m.d.H
    let on = 0, all = 0, worst = 0, handLook = 180
    for (let k = 0; k < Math.round(9 / DT); k++) {
      const t = k * DT
      const z = 0.17 * H + 0.04 * H * Math.sin(Math.PI * t)
      m.setHandTarget('left', { position: { x: 0.06 * H, y: 0.56 * H, z }, axis: { x: 1, y: 0, z: 0 }, kind: 'wrap', radius: 0.012 })
      m.setHandTarget('right', { position: { x: -0.06 * H, y: 0.56 * H, z }, axis: { x: 1, y: 0, z: 0 }, kind: 'wrap', radius: 0.012 })
      m.lookAt(net, { priority: 'target' })
      if (k === Math.round(6 / DT)) m.glanceAtHands(0.8)
      m.step(DT)
      if (t > 1.5 && t < 6) {
        const a = headOff(m, net)
        all++
        if (a <= 30) on++
        worst = Math.max(worst, a)
      }
      if (t > 6.4 && t < 6.8) handLook = Math.min(handLook, headOff(m, { x: 0, y: 0.56 * H, z }))
    }
    assert(on === all && worst <= 30, `a look target with priority holds the eyes while both hands work a rope (worst ${worst.toFixed(0)} deg off, limit 30)`)
    assert(handLook <= 25, `glanceAtHands looks down at the hands for a moment (${handLook.toFixed(0)} deg off them)`)

    const n = new PersonMotion(dimsFor('shirt'), 8)
    n.placeAt(0, 0, 0)
    let tOn = 0, tAll = 0
    for (let k = 0; k < Math.round(8 / DT); k++) {
      const t = k * DT
      const az = 0.9 * Math.sin(0.5 * t)
      const kite = { x: 6 * Math.sin(az), y: 3 + Math.sin(0.7 * t), z: 6 * Math.cos(az) }
      n.lookAt(kite, {})
      n.step(DT)
      if (t > 1) {
        tAll++
        if (headOff(n, kite) <= 20) tOn++
      }
    }
    assert(tOn / tAll >= 0.95, `a moving look target set every step (with options) is tracked (${(100 * tOn / tAll).toFixed(0)}% of the time within 20 deg)`)
  }

  // Releasing one hand leaves the other alone, and no blend to or from a rest pose jumps
  // (the hands-behind-back pose used to sit inside the body clearance: 15-46 m/s).
  {
    let worstV = 0, worstHold = 0, where = ''
    const kinds = ['hang', 'clasp', 'hip', 'pocket', 'folded', 'behind', 'watch'] as const
    for (const kind of kinds) {
      const m = new PersonMotion(dimsFor('shirt'), 11)
      m.placeAt(0, 0, 0)
      const H = m.d.H
      if (kind === 'watch') m.play('watch')
      else (m as unknown as { idleLife: { hands: string } }).idleLife.hands = kind
      const gripL = { position: { x: 0.12 * H, y: 0.55 * H, z: 0.22 * H }, normal: { x: 0, y: 1, z: 0 }, kind: 'flat' as const }
      const gripR = { position: { x: -0.12 * H, y: 0.55 * H, z: 0.22 * H }, normal: { x: 0, y: 1, z: 0 }, kind: 'flat' as const }
      let prev: Vec3[] | null = null
      for (let k = 0; k < Math.round(10 / DT); k++) {
        const t = k * DT
        // Both hands on, then the left lets go, then the right, then both again, and so on.
        const ph = Math.floor(t / 1.25) % 4
        const holdL = ph === 1, holdR = ph === 1 || ph === 2
        m.setHandTarget('left', holdL ? gripL : null)
        m.setHandTarget('right', holdR ? gripR : null)
        m.step(DT)
        const palms = [m.handWorld('left'), m.handWorld('right')]
        if (prev) for (const i of [0, 1]) {
          const v = Math.hypot(palms[i]![0] - prev[i]![0], palms[i]![1] - prev[i]![1], palms[i]![2] - prev[i]![2]) / DT
          if (v > worstV) { worstV = v; where = `${kind} t=${t.toFixed(2)} ${i ? 'right' : 'left'}` }
        }
        // While the right hand holds on after the left lets go, it stays exactly on its grip.
        if (ph === 2 && (t % 1.25) > 0.6) worstHold = Math.max(worstHold, dist(palms[1]!, gripR.position))
        prev = palms
      }
    }
    assert(worstV <= 4, `taking hold and letting go, from and to every rest pose, never jumps a hand: at most ${worstV.toFixed(2)} m/s (${where})`)
    assert(worstHold <= 1e-3, `letting go with one hand does not disturb the other on its grip (${(worstHold * 1000).toFixed(2)} mm)`)
  }

  // Head touches (a hand to the temple, flat on the head): the elbow comes out and forward
  // and the forearm makes a real angle -- not folded tight at the shoulder ("near" reach,
  // the palm short of the head) nor winged out behind it.
  {
    let err = 0, inner = 180, fwd = 1, out = 1
    for (const variant of ['shirt', 'headscarf', 'child'] as const) for (const given of [true, false]) {
      const m = new PersonMotion(dimsFor(variant), 3)
      m.placeAt(0, 0, 0)
      const d = m.d, H = d.H
      for (let k = 0; k < Math.round(2 / DT); k++) {
        const hd = fk(m, B.head)
        const top = apply(hd.R, [0, d.neck + d.headH, 0.008 * H])
        for (const side of [1, -1] as const) {
          const lx = side * (d.headW / 2 + 0.045 * H / 1.6 + (d.headscarf ? 0.03 : 0))
          const pos = { x: hd.p[0] + top[0] + lx, y: hd.p[1] + top[1] - d.headH * 0.28, z: hd.p[2] + top[2] + 0.05 * H / 1.6 }
          m.setHandTarget(side === 1 ? 'left' : 'right', { position: pos, normal: { x: side, y: 0, z: 0 }, elbow: given ? { x: side, y: -0.8, z: 0.3 } : undefined, kind: 'flat' })
        }
        m.step(DT)
        if (k * DT < 1.2) continue
        for (const side of [1, -1] as const) {
          const ua = side === 1 ? B.uaL : B.uaR
          const S = fk(m, ua).p, E = fk(m, ua + 1).p, W = fk(m, ua + 2).p
          inner = Math.min(inner, ang([S[0] - E[0], S[1] - E[1], S[2] - E[2]], [W[0] - E[0], W[1] - E[1], W[2] - E[2]]))
          fwd = Math.min(fwd, (E[2] - S[2]) / H)
          out = Math.min(out, side * (E[0] - S[0]) / H)
          err = Math.max(err, dist(m.handWorld(side === 1 ? 'left' : 'right'), m.handT[side === 1 ? 0 : 1]!.position))
        }
      }
    }
    assert(err <= 2e-3 && inner >= 38 && fwd >= 0.02 && out >= 0.03, `a hand to the temple lands (worst ${(err * 1000).toFixed(1)} mm) with the elbow out (${out.toFixed(3)} H) and forward (${fwd.toFixed(3)} H) and the forearm at least 38 deg off the upper arm (${inner.toFixed(0)} deg)`)
  }

  // Folded arms: the forearms lie one over the other, a forearm's thickness apart, and
  // never pass through each other folding or unfolding (to a grip, a wave, hands behind).
  {
    const segDist = (a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3) => {
      let best = Infinity
      for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
        const p = a0.map((v, k) => v + (a1[k]! - v) * i / 12), q = b0.map((v, k) => v + (b1[k]! - v) * j / 12)
        best = Math.min(best, Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!))
      }
      return best
    }
    type Go = (m: PersonMotion, H: number) => void
    const both = (y: number, z: number): Go => (m, H) => {
      m.setHandTarget('left', { position: { x: 0.15 * H, y: y * H, z: z * H } })
      m.setHandTarget('right', { position: { x: -0.15 * H, y: y * H, z: z * H } })
    }
    const cases: [string, Go | null, Go][] = [
      ['to a grip', null, both(0.55, 0.25)],
      ['to a high grip', null, both(0.95, 0.25)],
      ['to one hand', null, (m, H) => m.setHandTarget('right', { position: { x: -0.1 * H, y: 0.6 * H, z: 0.3 * H }, axis: { x: 1, y: 0, z: 0 }, kind: 'wrap' })],
      ['to hands behind', null, m => m.play('watch')],
      ['to a wave', null, m => m.play('wave')],
      ['from a grip', both(0.55, 0.25), m => { m.setHandTarget('left', null); m.setHandTarget('right', null) }],
      ['from hands behind', m => m.play('watch'), m => m.play('idle')],
    ]
    let worst = Infinity, where = ''
    for (const variant of ['shirt', 'mundu'] as const) for (const [name, before, go] of cases) {
      const m = new PersonMotion(dimsFor(variant), 5)
      m.placeAt(0, 0, 0)
      const life = (m as unknown as { idleLife: { hands: string, nextHands: number } }).idleLife
      life.hands = 'folded'
      life.nextHands = 1e9
      const H = m.d.H, rArm = 0.5 * m.d.arm
      before?.(m, H)
      for (let k = 0; k < Math.round(3.5 / DT); k++) {
        if (k === Math.round(2 / DT)) go(m, H)
        m.step(DT)
        if (k * DT < 1.5) continue
        const s = segDist(fk(m, B.faL).p, fk(m, B.handL).p, fk(m, B.faR).p, fk(m, B.handR).p) / rArm
        if (s < worst) { worst = s; where = `${variant} ${name} t=${(k * DT).toFixed(2)}` }
      }
    }
    assert(worst >= 1.6, `folded forearms stay a forearm apart, folding and unfolding (closest ${worst.toFixed(2)} forearm radii, limit 1.6: ${where})`)
  }

  // A hand going to a grip arrives turned: the palm faces its grip when it gets there and
  // does not swing round afterwards (it used to finish turning up to 0.1 s later).
  {
    const angR = (A: Mat3, Bm: Mat3) => { let tr = 0; for (let r = 0; r < 9; r++) tr += A[r]! * Bm[r]!; return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180 / Math.PI }
    const cases: { position: Vec3, normal: Vec3, axis?: Vec3, kind: 'wrap' | 'pinch' | 'flat', radius?: number }[] = [
      { position: [-0.06, 0.55, 0.2], normal: [0, 1, 0], axis: [1, 0, 0], kind: 'wrap', radius: 0.016 }, // a mallet handle
      { position: [-0.05, 0.62, 0.22], normal: [1, 0, 0], axis: [0, 0, 1], kind: 'pinch', radius: 0.004 }, // a pencil
      { position: [-0.16, 0.48, 0.08], normal: [-1, 0, 0], axis: [0, 0, 1], kind: 'wrap', radius: 0.016 }, // close by, a big turn
      { position: [-0.12, 0.5, 0.25], normal: [0, 1, 0], kind: 'flat' }, // flat on a bench
    ]
    let worstFace = 0, worstTurn = 0
    for (const c of cases) {
      const m = new PersonMotion(dimsFor('shirt'), 3)
      m.placeAt(0, 0, 0)
      const H = m.d.H
      const pos = { x: c.position[0] * H, y: c.position[1] * H, z: c.position[2] * H }
      const v3 = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] })
      for (let k = 0; k < Math.round(0.5 / DT); k++) m.step(DT)
      let arrived = -1
      let R0: Mat3 | null = null
      for (let k = 0; k < Math.round(1.5 / DT); k++) {
        m.setHandTarget('right', { position: pos, normal: v3(c.normal), axis: c.axis ? v3(c.axis) : undefined, kind: c.kind, radius: c.radius })
        m.step(DT)
        const R = fk(m, B.handR).R
        if (arrived < 0 && dist(m.handWorld('right'), pos) <= 1e-3) {
          arrived = k
          R0 = R
          // Right hand: the palm faces +X of the hand, onto the grip (against its normal).
          worstFace = Math.max(worstFace, ang(colv(R, 0), [-c.normal[0], -c.normal[1], -c.normal[2]]))
        }
        if (R0 && k - arrived <= Math.round(0.15 / DT)) worstTurn = Math.max(worstTurn, angR(R0, R))
      }
      if (arrived < 0) worstFace = 180
    }
    assert(worstFace <= 20 && worstTurn <= 6, `a hand arrives at its grip already turned to it (palm ${worstFace.toFixed(0)} deg off on arrival, limit 20; turning ${worstTurn.toFixed(1)} deg more in the next 0.15 s, limit 6)`)
  }

  // Upright handles (a chisel, a pole) held from behind, from in front and from the side:
  // the hand holds steady -- it used to flick between two ways round the handle every few
  // steps (10-15 deg a step, the palm up to 80 deg off it).
  {
    const angR = (A: Mat3, Bm: Mat3) => { let tr = 0; for (let r = 0; r < 9; r++) tr += A[r]! * Bm[r]!; return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180 / Math.PI }
    const cases: { position: Vec3, normal: Vec3, axis: Vec3 }[] = [
      { position: [-0.1, 0.6, 0.25], normal: [0, 0, -1], axis: [0, 1, 0] },
      { position: [-0.1, 0.6, 0.25], normal: [0, 0, 1], axis: [0, 1, 0] },
      { position: [-0.15, 0.55, 0.2], normal: [1, 0, 0], axis: [0, 1, 0] },
      { position: [-0.12, 0.5, 0.25], normal: [1, 0, 0], axis: [0, 0.4, 1] },
    ]
    let jitter = 0, palmOff = 0
    for (const v of ['shirt', 'mundu'] as const) for (const c of cases) {
      const m = new PersonMotion(dimsFor(v), 3)
      m.placeAt(0, 0, 0)
      const H = m.d.H
      let prev: Mat3 | null = null
      for (let k = 0; k < Math.round(3 / DT); k++) {
        const t = k * DT
        const sway = 0.01 * H * Math.sin(2 * t)
        m.setHandTarget('right', { position: { x: c.position[0] * H + sway, y: c.position[1] * H, z: c.position[2] * H }, normal: { x: c.normal[0], y: c.normal[1], z: c.normal[2] }, axis: { x: c.axis[0], y: c.axis[1], z: c.axis[2] }, kind: 'wrap', radius: 0.016 })
        m.step(DT)
        const R = fk(m, B.handR).R
        if (t > 1.5) {
          if (prev) jitter = Math.max(jitter, angR(prev, R))
          palmOff = Math.max(palmOff, ang(colv(R, 0), [-c.normal[0], -c.normal[1], -c.normal[2]]))
        }
        prev = R
      }
    }
    assert(jitter <= 1 && palmOff <= 20, `a hand on an upright handle holds steady (at most ${jitter.toFixed(1)} deg a step, limit 1) with the palm on it (${palmOff.toFixed(0)} deg off, limit 20)`)
  }

  // Clearances: hands out of the head; palms apart when clapping and behind the back.
  {
    const m = new PersonMotion(dimsFor('headscarf'), 4)
    m.placeAt(0, 0, 0)
    const d = m.d, H = d.H
    let minHead = Infinity
    for (let k = 0; k < Math.round(2 / DT); k++) {
      const hb = fk(m, B.head)
      const c = apply(hb.R, [0, d.neck + 0.5 * d.headH, 0.01 * H])
      const hc: Vec3 = [hb.p[0] + c[0], hb.p[1] + c[1], hb.p[2] + c[2]]
      m.setHandTarget('left', { position: { x: hc[0], y: hc[1], z: hc[2] + 0.02 * H } })
      m.step(DT)
      if (k > 300) minHead = Math.min(minHead, Math.hypot(...(m.handWorld('left').map((v, i) => v - hc[i]!) as Vec3)) - d.headW * 0.5)
    }
    assert(minHead >= 0.005, `a hand sent into the head stops outside it (${(minHead * 1000).toFixed(1)} mm clear of the head's half-width)`)
    const gapOf = (a: 'clap' | 'watch') => {
      const n = new PersonMotion(dimsFor('shirt'), 6)
      n.placeAt(0, 0, 0)
      n.play(a)
      let g = Infinity
      for (let k = 0; k < Math.round(2.2 / DT); k++) {
        n.step(DT)
        if (k > 100) g = Math.min(g, Math.hypot(...(n.handWorld('left').map((v, i) => v - n.handWorld('right')[i]!) as Vec3)))
      }
      return g / n.d.H
    }
    const clap = gapOf('clap'), behind = gapOf('watch')
    assert(clap >= 0.022 && behind >= 0.022, `palms never merge: clapping ${(clap * 100).toFixed(1)}% of stature apart (min 2.2), behind the back ${(behind * 100).toFixed(1)}%`)
  }
}

// ── 13. Shoulders: the clavicle's shrug ──────────────────────────────────
{
  /**
   * Front view of the posed, skinned person: the top outline of the body (head and hair
   * left out) from the side of the neck out over the left shoulder to the raised arm, every
   * triangle sampled densely. A notch is a valley in it (lower than the outline on both
   * sides): the "ball" of an arm's top standing on a shoulder that stayed down.
   */
  const notch = (variant: Variant, targetDeg: number) => {
    const p = createPerson(ctx, { seed: 3, variant })
    p.placeAt(0, 0, 0)
    const d = p.dims, H = d.H, m = p.motion
    const sy = m.pose.pelvisPos[1] + d.waistY + d.shoulderY
    const a = targetDeg * Math.PI / 180, r = 0.95 * (d.UA + d.FA)
    for (let k = 0; k < Math.round(3 / DT); k++) {
      p.setHandTarget('left', { position: { x: d.shoulderX, y: sy - r * Math.cos(a), z: r * Math.sin(a) } })
      p.step(DT)
    }
    p.frame(1)
    p.root.updateMatrixWorld(true)
    const piv = new THREE.Vector3()
    p.root.traverse((o) => { if ((o as THREE.Bone).isBone && o.name === 'upperArmL') piv.setFromMatrixPosition(o.matrixWorld) })
    // (The raise of the upper arm from hanging, in the world: shoulder to elbow.)
    const elb = new THREE.Vector3()
    p.root.traverse((o) => { if ((o as THREE.Bone).isBone && o.name === 'lowerArmL') elb.setFromMatrixPosition(o.matrixWorld) })
    const raise = Math.acos(Math.max(-1, Math.min(1, -(elb.y - piv.y) / elb.distanceTo(piv)))) * 180 / Math.PI
    const xa = 0.04 * H, xb = piv.x + 0.03 * H, nb = 40
    const top = new Array<number>(nb).fill(-Infinity)
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3()
    p.root.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh
      if (!mesh.isSkinnedMesh || typeof mesh.getVertexPosition !== 'function' || (o as THREE.LineSegments).isLineSegments) return
      const g = mesh.geometry, idx = g.index
      const si = g.attributes.skinIndex!, sw = g.attributes.skinWeight!
      const lead = (i: number) => { let best = 0, bw = -1; for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k) } } return best }
      const cnt = idx ? idx.count : g.attributes.position!.count
      for (let t = 0; t < cnt; t += 3) {
        const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2
        if (lead(i0) === B.head || lead(i1) === B.head || lead(i2) === B.head) continue
        mesh.getVertexPosition(i0, va).applyMatrix4(mesh.matrixWorld)
        mesh.getVertexPosition(i1, vb).applyMatrix4(mesh.matrixWorld)
        mesh.getVertexPosition(i2, vc).applyMatrix4(mesh.matrixWorld)
        if (Math.max(va.x, vb.x, vc.x) < xa || Math.min(va.x, vb.x, vc.x) >= xb || Math.min(va.y, vb.y, vc.y) > piv.y + 0.1 * H) continue
        for (let u = 0; u <= 8; u++) for (let w = 0; w <= 8 - u; w++) {
          const a1 = u / 8, a2 = w / 8, a0 = 1 - a1 - a2
          const x = a0 * va.x + a1 * vb.x + a2 * vc.x, y = a0 * va.y + a1 * vb.y + a2 * vc.y
          if (x < xa || x >= xb || y > piv.y + 0.1 * H) continue
          const bi = Math.floor((x - xa) / (xb - xa) * nb)
          if (y > top[bi]!) top[bi] = y
        }
      }
    })
    let dip = 0
    // (Valleys up to the joint: past it the outline is the arm's own, a sleeve's edge and all.)
    for (let j = 1; j < nb - 1 && xa + (j + 0.5) * (xb - xa) / nb <= piv.x + 0.005 * H; j++) {
      let lm = -Infinity, rm = -Infinity
      for (let i = 0; i < j; i++) lm = Math.max(lm, top[i]!)
      for (let k = j + 1; k < nb; k++) rm = Math.max(rm, top[k]!)
      dip = Math.max(dip, Math.min(lm, rm) - top[j]!)
    }
    p.dispose()
    return { dip: dip / H, raise }
  }
  let worst = 0, where = '', raises: number[] = []
  for (const v of ['shirt', 'kurta', 'skirt', 'child'] as Variant[]) for (const deg of [105, 180]) {
    const r = notch(v, deg)
    raises.push(Math.round(r.raise))
    if (r.dip > worst) { worst = r.dip; where = `${v}, upper arm raised ${r.raise.toFixed(0)} deg` }
  }
  assert(worst <= 0.0035 && Math.min(...raises) <= 93 && Math.max(...raises) >= 138, `a raised arm meets its shoulder in one outline, no notch, at about 90 and 140-150 deg (deepest ${(worst * 100).toFixed(2)}% of stature, limit 0.35%: ${where})`)

  // Grips stay exact while the arm rises overhead and comes down (the arm is solved from the
  // shrugged shoulder), and the shoulder never jumps.
  const m = new PersonMotion(dimsFor('shirt'), 6)
  m.placeAt(0, 0, 0)
  const d = m.d
  const sy = m.pose.pelvisPos[1] + d.waistY + d.shoulderY
  let worstErr = 0, worstSh = 0, maxShrug = 0
  let prevS: Vec3 | null = null
  for (let k = 0; k < Math.round(8 / DT); k++) {
    const t = k * DT
    const a = (20 + 155 * (0.5 - 0.5 * Math.cos(Math.PI * t / 4))) * Math.PI / 180
    const r = 0.9 * (d.UA + d.FA)
    const pos = { x: d.shoulderX * 0.8, y: sy - r * Math.cos(a), z: r * Math.sin(a) }
    m.setHandTarget('left', { position: pos, normal: { x: 0, y: -Math.sin(a), z: Math.cos(a) }, kind: 'flat' })
    m.step(DT)
    const sh = (m as unknown as { shrug: { x: number }[] }).shrug[0]!.x
    maxShrug = Math.max(maxShrug, sh)
    if (t > 1.2) worstErr = Math.max(worstErr, dist(m.handWorld('left'), pos))
    const S = (() => { const R = mul(m.pose.R[B.pelvis]!, m.pose.R[B.spine]!); const o = m.offsets[B.uaL]!; const sp = apply(m.pose.R[B.pelvis]!, m.offsets[B.spine]!); const q = apply(R, [o[0], o[1] + m.pose.shoulderLift, o[2]]); return [m.pose.pelvisPos[0] + sp[0] + q[0], m.pose.pelvisPos[1] + sp[1] + q[1], m.pose.pelvisPos[2] + sp[2] + q[2]] as Vec3 })()
    if (prevS) worstSh = Math.max(worstSh, Math.hypot(S[0] - prevS[0], S[1] - prevS[1], S[2] - prevS[2]) / DT)
    prevS = S
  }
  assert(maxShrug > 0.8 && worstErr <= 1e-3 && worstSh <= 1, `raising a hand overhead and back, the shoulder shrugs (to ${maxShrug.toFixed(2)}) while the palm stays on its target (worst ${(worstErr * 1000).toFixed(3)} mm) and the shoulder moves at most ${worstSh.toFixed(2)} m/s`)

  // One limb from shoulder to wrist at every raise: along each arm, every 2 mm slab across
  // the upper arm and the forearm is ringed by skin or sleeve all the way round (no
  // missing ring, no gap at the elbow or a sleeve's hem), arms hanging and raised forward
  // 90, 150 and 175 deg; short and long sleeves, kurta and hijab.
  {
    const ringGaps = (variant: Variant, deg: number | null) => {
      const p = createPerson(ctx, { seed: 5, variant })
      p.placeAt(0, 0, 0)
      const d = p.dims, H = d.H
      const sy = p.motion.pose.pelvisPos[1] + d.waistY + d.shoulderY
      for (let k = 0; k < Math.round(2.5 / DT); k++) {
        for (const s of [1, -1] as const) {
          if (deg === null) { p.setHandTarget(s === 1 ? 'left' : 'right', null); continue }
          const a = deg * Math.PI / 180, r = 0.95 * (d.UA + d.FA)
          p.setHandTarget(s === 1 ? 'left' : 'right', { position: { x: s * d.shoulderX, y: sy - r * Math.cos(a), z: r * Math.sin(a) } })
        }
        p.step(DT)
      }
      p.frame(1)
      p.root.updateMatrixWorld(true)
      const bone: Record<string, THREE.Vector3> = {}
      p.root.traverse((o) => { if ((o as THREE.Bone).isBone) bone[o.name] = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld) })
      // Skin and cloth near the arms, sampled densely over every triangle.
      const tris: THREE.Vector3[][] = []
      const near = (v: THREE.Vector3) => ['L', 'R'].some((s) => {
        const S = bone[`upperArm${s}`]!, E = bone[`lowerArm${s}`]!, W = bone[`hand${s}`]!
        const segD = (A: THREE.Vector3, Bv: THREE.Vector3) => { const ab = Bv.clone().sub(A); const t = Math.max(0, Math.min(1, v.clone().sub(A).dot(ab) / ab.lengthSq())); return v.distanceTo(A.clone().addScaledVector(ab, t)) }
        return Math.min(segD(S, E), segD(E, W)) < 0.06 * H
      })
      p.root.traverse((o) => {
        const mesh = o as THREE.SkinnedMesh
        if (!mesh.isSkinnedMesh || typeof mesh.getVertexPosition !== 'function' || (o as THREE.LineSegments).isLineSegments) return
        const g = mesh.geometry, idx = g.index
        const cnt = idx ? idx.count : g.attributes.position!.count
        for (let t = 0; t < cnt; t += 3) {
          const vs = [0, 1, 2].map(q => mesh.getVertexPosition(idx ? idx.getX(t + q) : t + q, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld))
          if (vs.some(near)) tris.push(vs)
        }
      })
      const pts: THREE.Vector3[] = []
      for (const [a, b, c] of tris) {
        const n = Math.max(2, Math.ceil(Math.max(a!.distanceTo(b!), b!.distanceTo(c!), c!.distanceTo(a!)) / 0.0015))
        for (let u = 0; u <= n; u++) for (let w = 0; w <= n - u; w++) {
          const a1 = u / n, a2 = w / n
          pts.push(a!.clone().multiplyScalar(1 - a1 - a2).addScaledVector(b!, a1).addScaledVector(c!, a2))
        }
      }
      // Along each segment, a slab every 2 mm: which twelfths of the way round have skin.
      let worst = 0, where = ''
      for (const s of ['L', 'R']) {
        const S = bone[`upperArm${s}`]!, E = bone[`lowerArm${s}`]!, W = bone[`hand${s}`]!
        for (const [A, Bv, from] of [[S, E, 0.03 * H], [E, W, 0]] as const) {
          const ax = Bv.clone().sub(A), L = ax.length()
          ax.normalize()
          const ref = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
          const e1 = ref.clone().sub(ax.clone().multiplyScalar(ref.dot(ax))).normalize(), e2 = ax.clone().cross(e1)
          let run = 0
          for (let x = from; x <= L - 0.004 * H; x += 0.002) {
            const P = A.clone().addScaledVector(ax, x)
            const bins = new Array<boolean>(12).fill(false)
            for (const q of pts) {
              const dv = q.clone().sub(P)
              const along = dv.dot(ax)
              if (Math.abs(along) > 0.00125) continue
              const r1 = dv.dot(e1), r2 = dv.dot(e2)
              if (Math.hypot(r1, r2) > 0.05 * H) continue
              bins[Math.floor(((Math.atan2(r2, r1) + Math.PI) / (2 * Math.PI)) * 12) % 12] = true
            }
            const ok = bins.filter(Boolean).length >= 11
            run = ok ? 0 : run + 0.002
            if (run > worst) { worst = run; where = `${variant} ${deg ?? 'hanging'}: arm ${s} ${A === S ? 'upper' : 'fore'} at ${(x * 100).toFixed(1)} cm` }
          }
        }
      }
      p.dispose()
      return { worst, where }
    }
    let worst = 0, where = ''
    for (const v of ['skirt', 'kurta', 'headscarf', 'shirt'] as Variant[]) for (const deg of [null, 90, 150, 175]) {
      const r = ringGaps(v, deg)
      if (r.worst > worst) { worst = r.worst; where = r.where }
    }
    assert(worst < 0.002, `each arm is one closed limb, shoulder to wrist, hanging and raised 90 to 175 deg (longest unringed stretch ${(worst * 1000).toFixed(1)} mm, limit 2${where ? `: ${where}` : ''})`)
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll people checks passed.')
