/**
 * Duck biped gait + IK tests (plan A1.1 §4, A1.3). Run: npm run test:gait
 *
 * Every sole check reads the ACTUAL posed skeleton: the gait's pose goes
 * through poseSkeleton() (the same function the renderer calls), and the
 * soles are read back from the three.js foot nodes' world matrices -- not
 * from the gait's stored targets.
 */
import * as THREE from 'three'
import { DT, FixedClock } from '../app/three/core/clock'
import { rng } from '../app/three/core/rng'
import { DuckGait, GAIT, HOP_TOTAL, lerpPose, newPose, type Command } from '../app/three/robots/duck/gait'
import { D_MAX, D_MIN, JOINTS, LEG, LIMITS, apply, fkLeg, pelvisRotation, rotY, solveLeg, transpose, type LegSolution } from '../app/three/robots/duck/ik'
import { createSkeleton, poseSkeleton, SOLE_OFFSET } from '../app/three/robots/duck/model'
import { BODY_POINTS, FALL } from '../app/three/robots/duck/fall'

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
const deg = Math.PI / 180
const REACH = LEG.L1 + LEG.L2
function sol(): LegSolution {
  return { hipYaw: 0, hipRoll: 0, hipPitch: 0, knee: 0, anklePitch: 0, ankleRoll: 0, dist: 0, clamped: false, limited: false }
}

// ── IK unit tests ─────────────────────────────────────────────────────────

{
  // Randomized round trip: random joint angles inside the limits -> FK -> IK -> FK.
  // Poses are drawn from the leg's working branch: a leg standing on its foot
  // (hip above the ankle in the sole frame), knee bent backward, pelvis tilts
  // inside the gait's bounds, any yaw.
  const R = rng(42)
  let worst = 0
  let tested = 0
  for (let n = 0; n < 6000; n++) {
    const q: any = {}
    for (const j of JOINTS) q[j] = R.range(LIMITS[j][0] * 0.98, LIMITS[j][1] * 0.98)
    const P: [number, number, number] = [R.range(-2, 2), R.range(0.05, 0.4), R.range(-2, 2)]
    const PR = pelvisRotation(R.range(-Math.PI, Math.PI), R.range(-8, 8) * deg, R.range(-6, 6) * deg)
    const side = R.next() < 0.5 ? 1 : -1
    const a = fkLeg(P, PR, side, q)
    const d = Math.hypot(a.hip[0] - a.ankle[0], a.hip[1] - a.ankle[1], a.hip[2] - a.ankle[2])
    if (d <= D_MIN || d >= D_MAX) continue
    const up = apply(transpose(a.soleR), [a.hip[0] - a.ankle[0], a.hip[1] - a.ankle[1], a.hip[2] - a.ankle[2]])
    if (up[1] <= 0) continue
    const s = solveLeg(P, PR, side, a.sole, a.soleR)
    const b = fkLeg(P, PR, side, s)
    let e = Math.hypot(a.sole[0] - b.sole[0], a.sole[1] - b.sole[1], a.sole[2] - b.sole[2])
    for (let k = 0; k < 9; k++) e = Math.max(e, Math.abs(a.soleR[k]! - b.soleR[k]!))
    worst = Math.max(worst, e)
    tested++
  }
  assert(tested > 1500 && worst <= 1e-6, `IK->FK round trip over ${tested} random reachable poses: worst error ${worst.toExponential(2)} <= 1e-6`)
}

{
  // Unreachable and degenerate targets stay finite and report the clamp.
  const P: [number, number, number] = [0, 0.15, 0]
  const PR = pelvisRotation(0.3, 0.05, -0.04)
  const hip = apply(PR, [LEG.hipW, 0, 0]).map((v, k) => v + P[k]!)
  const soleFor = (ankle: number[]): [number, number, number] => [ankle[0]!, ankle[1]! - LEG.ankleH, ankle[2]!]
  const cases: [string, [number, number, number]][] = [
    ['1 m away', [1, -0.85, 0.3]],
    ['straight down, too far', [LEG.hipW, -2, 0]],
    ['ankle 3 mm from the hip (too close)', soleFor([hip[0]! + 0.001, hip[1]! - 0.002, hip[2]! + 0.002])],
    ['zero-length hip-ankle', soleFor(hip)],
  ]
  for (const [name, s] of cases) {
    const r = solveLeg(P, PR, 1, s, rotY(0.3))
    const finite = JOINTS.every(j => Number.isFinite(r[j]))
    assert(finite && r.clamped, `IK finite and flagged clamped for unreachable target: ${name}`)
  }
  const nan = solveLeg(P, PR, 1, [Number.NaN, 0, 0], rotY(0))
  assert(JOINTS.every(j => Number.isFinite(nan[j])), 'IK finite for a NaN target (rest pose)')
}

{
  // The three.js skeleton and ik.fkLeg are the same chain.
  const sk = createSkeleton()
  const sols: [LegSolution, LegSolution] = [sol(), sol()]
  const R = rng(5)
  let worst = 0
  for (let n = 0; n < 200; n++) {
    const pose = newPose()
    pose.x = R.range(-1, 1); pose.z = R.range(-1, 1); pose.y = GAIT.standH + R.range(-0.01, 0.005)
    pose.yaw = R.range(-3, 3); pose.pitch = R.range(-8, 8) * deg; pose.roll = R.range(-6, 6) * deg
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1
      const f = pose.feet[i]!
      f.yaw = pose.yaw + R.range(-0.4, 0.4)
      f.x = pose.x + Math.cos(pose.yaw) * side * LEG.hipW + R.range(-0.03, 0.03)
      f.z = pose.z - Math.sin(pose.yaw) * side * LEG.hipW + R.range(-0.03, 0.03)
      f.y = R.range(0, 0.02)
    }
    poseSkeleton(sk, pose, sols)
    sk.root.updateMatrixWorld(true)
    for (let i = 0; i < 2; i++) {
      const fk = fkLeg([pose.x, pose.y, pose.z], pelvisRotation(pose.yaw, pose.pitch, pose.roll), i === 0 ? 1 : -1, sols[i]!)
      const p = sk.legs[i]!.foot.localToWorld(new THREE.Vector3(0, SOLE_OFFSET, 0))
      worst = Math.max(worst, Math.hypot(p.x - fk.sole[0], p.y - fk.sole[1], p.z - fk.sole[2]))
    }
  }
  assert(worst < 1e-9, `three.js skeleton matches ik.fkLeg (worst ${worst.toExponential(2)})`)
}

// ── Gait scenarios, checked on the posed skeleton ─────────────────────────

const FOOT = { hw: 0.021, back: -0.0325, front: 0.0525 }

interface Stats {
  posErr: number
  yawErr: number
  tilt: number
  minY: number
  clamps: number
  limits: number
  dMin: number
  dMax: number
  hipYaw: number
  pitch: number
  roll: number
  stances: number
  governed: number
}

function run(name: string, seconds: number, drive: (t: number, g: DuckGait, n: number) => Command, seed = 3): Stats {
  const g = new DuckGait(seed)
  g.placeAt(0.1, -0.2, 0.4)
  const sk = createSkeleton()
  const sols: [LegSolution, LegSolution] = [sol(), sol()]
  const ref: ({ id: number, p: THREE.Vector3, yaw: number } | null)[] = [null, null]
  const st: Stats = { posErr: 0, yawErr: 0, tilt: 0, minY: Infinity, clamps: 0, limits: 0, dMin: Infinity, dMax: 0, hipYaw: 0, pitch: 0, roll: 0, stances: 0, governed: 0 }
  const m = new THREE.Matrix4()
  const ex = new THREE.Vector3(), ey = new THREE.Vector3(), ez = new THREE.Vector3()
  const steps = Math.round(seconds / DT)
  for (let n = 0; n < steps; n++) {
    g.step(DT, drive(n * DT, g, n))
    if (g.governed) st.governed++
    poseSkeleton(sk, g.cur, sols)
    sk.root.updateMatrixWorld(true)
    if (g.fallen) {
      // Falling and getting up is checked on its own (below): no planted feet, no gait limits.
      ref[0] = ref[1] = null
      continue
    }
    st.pitch = Math.max(st.pitch, Math.abs(g.cur.pitch))
    st.roll = Math.max(st.roll, Math.abs(g.cur.roll))
    for (let i = 0; i < 2; i++) {
      const s = sols[i]!
      if (s.clamped) st.clamps++
      if (s.limited) st.limits++
      st.dMin = Math.min(st.dMin, s.dist)
      st.dMax = Math.max(st.dMax, s.dist)
      st.hipYaw = Math.max(st.hipYaw, Math.abs(s.hipYaw))
      const foot = sk.legs[i]!.foot
      m.copy(foot.matrixWorld)
      m.extractBasis(ex, ey, ez)
      const p = new THREE.Vector3(0, SOLE_OFFSET, 0).applyMatrix4(m)
      const yaw = Math.atan2(ez.x, ez.z)
      st.tilt = Math.max(st.tilt, Math.acos(Math.min(1, ey.y / ey.length())))
      for (const cx of [-FOOT.hw, FOOT.hw]) {
        for (const cz of [FOOT.back, FOOT.front]) {
          st.minY = Math.min(st.minY, new THREE.Vector3(cx, SOLE_OFFSET, cz).applyMatrix4(m).y)
        }
      }
      if (g.planted[i]) {
        const r = ref[i]
        if (!r || r.id !== g.stanceId[i]) {
          ref[i] = { id: g.stanceId[i]!, p, yaw }
          st.stances++
        }
        else {
          st.posErr = Math.max(st.posErr, p.distanceTo(r.p))
          st.yawErr = Math.max(st.yawErr, Math.abs(Math.atan2(Math.sin(yaw - r.yaw), Math.cos(yaw - r.yaw))))
        }
      }
      else {
        ref[i] = null
      }
    }
  }
  const margin = 0.02 * REACH
  console.log(`  [${name}] stances ${st.stances}, stance drift ${st.posErr.toExponential(2)} m / ${st.yawErr.toExponential(2)} rad, `
    + `sole tilt ${(st.tilt / deg).toFixed(3)} deg, min sole y ${st.minY.toExponential(2)}, `
    + `hip-ankle ${(st.dMin / REACH).toFixed(3)}..${(st.dMax / REACH).toFixed(3)} L, |hip yaw| ${(st.hipYaw / deg).toFixed(1)} deg, `
    + `|pitch| ${(st.pitch / deg).toFixed(2)} deg, |roll| ${(st.roll / deg).toFixed(2)} deg, governed ${st.governed} steps`)
  assert(st.stances >= 2, `${name}: feet planted and lifted`)
  assert(st.posErr <= 1e-6, `${name}: stance sole world position constant (<= 1e-6 m)`)
  assert(st.yawErr <= 1e-6, `${name}: stance sole world yaw constant (<= 1e-6 rad)`)
  assert(st.tilt <= 1 * deg, `${name}: sole normal within 1 deg of vertical`)
  assert(st.minY >= -1e-9, `${name}: no sole corner below ground`)
  assert(st.clamps === 0 && st.limits === 0, `${name}: IK never clamped, no joint at a limit`)
  assert(st.dMin >= D_MIN + margin && st.dMax <= D_MAX - margin, `${name}: hip-ankle distance stays 0.02 L inside both clamp limits`)
  assert(st.hipYaw <= 40 * deg, `${name}: |hip yaw| <= 40 deg`)
  assert(st.pitch <= 8 * deg + 1e-12 && st.roll <= 6 * deg + 1e-12, `${name}: pelvis pitch <= 8 deg and roll <= 6 deg`)
  return st
}

const at = (t: number, pts: [number, number, number][]): Command => {
  let c: Command = { speed: 0, yawRate: 0 }
  for (const [t0, speed, yawRate] of pts) if (t >= t0) c = { speed, yawRate }
  return c
}

run('straight walk, start and stop', 7, t => at(t, [[0.5, 0.2, 0], [5, 0, 0]]))
const turn = run('turn in place', 6, t => at(t, [[0.3, 0, 1.6], [3, 0, -1.6], [5, 0, 0]]))
assert(turn.pitch > 0.5 * deg && turn.roll > 1 * deg, 'turn in place: pelvis pitch and roll are nonzero (the test covers a tilted pelvis)')
const arc = run('arcs', 9, t => at(t, [[0.3, 0.15, 0.8], [3.5, 0.12, -1.2], [6, 0.2, 0.5], [8, 0, 0]]))
assert(arc.pitch > 3 * deg && arc.roll > 1 * deg, 'arcs: pelvis pitch and roll are nonzero')
run('start/stop/reverse every 0.7 s', 10, t => {
  const k = Math.floor(t / 0.7) % 4
  return [{ speed: 0.2, yawRate: 0 }, { speed: 0, yawRate: 0 }, { speed: -0.12, yawRate: 0.5 }, { speed: 0.2, yawRate: -1.6 }][k]!
})
run('abrupt full reversals', 8, t => {
  const k = Math.floor(t / 1.1) % 2
  return { speed: k ? -0.12 : 0.2, yawRate: k ? -1.6 : 1.6 }
})
{
  const R = rng(99)
  let c: Command = { speed: 0, yawRate: 0 }
  run('seeded random commands', 40, (_t, _g, n) => {
    if (n % 90 === 0) c = R.next() < 0.2 ? { speed: 0, yawRate: 0 } : { speed: R.range(-0.15, 0.25), yawRate: R.range(-2, 2) }
    return c
  })
}
{
  let hopped = 0
  const st = run('hop from standing and from walking', 7, (t, g, n) => {
    if (n === 100 || n === 900) { g.react('tap'); hopped++ }
    return t > 2.5 && t < 4.5 ? { speed: 0.2, yawRate: 0.4 } : { speed: 0, yawRate: 0 }
  })
  assert(hopped === 2 && st.stances >= 6, 'hop: lands on planted footholds (new stances after each hop)')
}
{
  // Hop end state: back to a squared stance, moved forward by the hop distance.
  const g = new DuckGait(1)
  g.placeAt(0, 0, 0.5)
  g.react('tap')
  let busy = false, maxFootY = 0
  for (let n = 0; n < Math.ceil((HOP_TOTAL + 0.2) / DT); n++) {
    g.step(DT, { speed: 0, yawRate: 0 })
    busy ||= g.busy
    maxFootY = Math.max(maxFootY, g.cur.feet[0].y)
  }
  const moved = Math.hypot(g.bx, g.bz)
  assert(busy && !g.busy && g.mode === 'stand', 'hop: busy during the hop, standing afterward')
  assert(maxFootY > 0.03 && Math.abs(moved - 0.035) < 1e-9, `hop: feet leave the ground (${(maxFootY * 1000).toFixed(1)} mm) and land ${(moved * 1000).toFixed(1)} mm ahead`)
}
run('shove: stagger from walking and from standing', 7, (t, g, n) => {
  if (n === 300 || n === 1000) g.react('shove')
  return t < 1 ? { speed: 0.15, yawRate: 0 } : { speed: 0, yawRate: 0 }
})
{
  const g = new DuckGait(2)
  g.react('shove')
  let x0 = g.bz, minZ = 0, steps = 0
  for (let n = 0; n < 600 && (n < 5 || g.busy); n++) {
    g.step(DT, { speed: 0.2, yawRate: 0 })
    minZ = Math.min(minZ, g.bz - x0)
    steps = n
  }
  assert(minZ < -0.03 && !g.busy && steps < 400, `shove: staggers back ${(-minZ * 1000).toFixed(0)} mm, ignores commands while busy, recovers in ${(steps * DT).toFixed(2)} s`)
}

// ── Side-steps and collisions (contact response, robots/contact.ts) ─────────

run('side-steps: left, right, then stop', 7, t => ({ speed: 0, yawRate: 0, strafe: t < 2 ? 0.07 : t < 4.5 ? -0.07 : 0 }))
run('side-steps while walking and turning', 7, t => ({ speed: t < 5 ? 0.1 : 0, yawRate: t < 5 ? 0.5 : 0, strafe: t < 2.5 ? 0.05 : t < 5 ? -0.05 : 0 }))
{
  // Hits from behind, the left, the right and the front (normal = push direction), standing and walking,
  // with the body overlap applied as a positional push. Stance soles must still never move.
  const hits: [number, number, number][] = [[300, Math.PI, 0.27], [700, Math.PI / 2, 0.2], [1100, -Math.PI / 2, 0.28], [1500, 0, 0.15]]
  let staggered = 0
  run('collision staggers in four directions', 10, (t, g, n) => {
    for (const [at, rel, v] of hits) {
      if (n === at) {
        const a = g.yaw + rel
        g.collide({ x: Math.sin(a), z: Math.cos(a) }, 0.006, v, 'robot', 0)
        if (g.busy) staggered++
      }
    }
    return t > 4 && t < 6 ? { speed: 0.15, yawRate: 0.3 } : { speed: 0, yawRate: 0 }
  })
  assert(staggered === hits.length, `collision: every hit starts a stagger (${staggered}/${hits.length})`)
}
{
  // The stagger goes along the push and scales with the impact; planted feet are fixed colliders.
  const trial = (v: number, rel: number) => {
    const g = new DuckGait(5)
    g.placeAt(0, 0, 0.3)
    const a = 0.3 + rel
    const n = { x: Math.sin(a), z: Math.cos(a) }
    const fixedBefore = g.colliders.slice(4).every(c => c.fixed && c.r > 0)
    g.collide(n, 0, v, 'robot', 0)
    for (let i = 0; i < 400 && (i < 5 || g.busy); i++) g.step(DT, { speed: 0, yawRate: 0 })
    return { along: g.bx * n.x + g.bz * n.z, fixedBefore, busy: g.busy }
  }
  const soft = trial(0.1, Math.PI / 2)
  const hard = trial(0.28, Math.PI / 2)
  const back = trial(0.25, Math.PI)
  console.log(`  stagger along the push: soft ${(soft.along * 1000).toFixed(0)} mm, hard ${(hard.along * 1000).toFixed(0)} mm, from the front ${(back.along * 1000).toFixed(0)} mm`)
  assert(soft.fixedBefore, 'collision: planted soles are fixed contact circles')
  assert(soft.along > 0.01 && back.along > 0.01, 'collision: the duck staggers away along the push (sideways and backward)')
  assert(hard.along > soft.along * 1.3, 'collision: a harder hit staggers further')
  assert(!soft.busy && !hard.busy && !back.busy, 'collision: recovers and stands again')
}

run('sleep (sink, droop, breathe), wake with a startle, walk off', 7, (t, g, n) => {
  if (n === 100) g.setSleep(true)
  if (n === 900) g.setSleep(false)
  return t > 4.6 && t < 6 ? { speed: 0.15, yawRate: 0.4 } : { speed: 0, yawRate: 0 }
})

// ── Falling over and getting up ───────────────────────────────────────────

{
  const dirs: [string, number][] = [['backward', Math.PI], ['forward', 0], ['to its left', Math.PI / 2], ['to its right', -Math.PI / 2]]
  for (const [name, rel] of dirs) {
    const g = new DuckGait(11)
    g.placeAt(0, 0, 0.3)
    const sk = createSkeleton()
    const sols: [LegSolution, LegSolution] = [sol(), sol()]
    const phases: string[] = []
    let minBody = Infinity, minSole = Infinity, standAt = -1, maxTilt = 0
    const pt = new THREE.Vector3()
    for (let n = 0; n < 7 / DT; n++) {
      if (n === 40) g.startFall(Math.sin(0.3 + rel), Math.cos(0.3 + rel), 0.6)
      g.step(DT, { speed: 0, yawRate: 0 })
      if (g.fallen && phases[phases.length - 1] !== g.fall.phase) phases.push(g.fall.phase)
      if (n > 40 && !g.fallen && standAt < 0) standAt = (n - 40) * DT
      poseSkeleton(sk, g.cur, sols)
      sk.root.updateMatrixWorld(true)
      for (const p of BODY_POINTS) minBody = Math.min(minBody, pt.set(p[0], p[1], p[2]).applyMatrix4(sk.pelvis.matrixWorld).y)
      for (let i = 0; i < 2; i++) {
        for (const cx of [-FOOT.hw, FOOT.hw]) {
          for (const cz of [FOOT.back, FOOT.front]) minSole = Math.min(minSole, pt.set(cx, SOLE_OFFSET, cz).applyMatrix4(sk.legs[i]!.foot.matrixWorld).y)
        }
      }
      maxTilt = Math.max(maxTilt, Math.abs(g.cur.pitch), Math.abs(g.cur.roll))
    }
    console.log(`  [fall ${name}] ${phases.join(' > ')}, standing again after ${standAt.toFixed(2)} s, lay at ${(maxTilt * 180 / Math.PI).toFixed(0)} deg, lowest body point ${(minBody * 1000).toFixed(1)} mm, lowest sole corner ${(minSole * 1000).toFixed(1)} mm`)
    assert(phases.join(' > ') === 'topple > lie > roll > rise', `fall ${name}: topples, lies, rolls up and rises (${phases.join(' > ')})`)
    assert(maxTilt > 1.2, `fall ${name}: it really goes down (${(maxTilt * 180 / Math.PI).toFixed(0)} deg)`)
    assert(minBody >= -0.001 && minSole >= -0.001, `fall ${name}: nothing passes through the ground (body ${(minBody * 1000).toFixed(1)} mm, soles ${(minSole * 1000).toFixed(1)} mm)`)
    assert(standAt > 0 && standAt < 5, `fall ${name}: standing again within 5 s (${standAt.toFixed(2)} s)`)
    assert(!g.busy && g.mode === 'stand', `fall ${name}: it recovers its balance and is free again`)
  }
  {
    // A push too weak to carry it over the edge rocks it back onto its feet.
    const g = new DuckGait(12)
    g.placeAt(0, 0, 0)
    g.fall.start(0, -1, 0, g.cur, g.feet)
    let back = false
    for (let n = 0; n < 400 && !back; n++) back = g.fall.step(DT, -2)
    assert(back && g.fall.phi === 0, 'fall: a drag pulling it back upright rocks it back onto its feet')
  }
  {
    const st = run('tumble, lie, get up, then walk off with planted feet', 10, (t, g, n) => {
      if (n === 100) g.react('tumble')
      return t > 5.5 && t < 8.5 ? { speed: 0.15, yawRate: 0.3 } : { speed: 0, yawRate: 0 }
    })
    assert(st.stances >= 4, 'tumble: walking again afterwards (planted-foot checks above cover the walk)')
  }
  {
    // A steady hard grab-pull drags it over; a gentle one only makes it step toward the pull.
    const g = new DuckGait(13)
    g.placeAt(0, 0, 0)
    let fell = false
    for (let n = 0; n < 200; n++) {
      g.ext.x = 7
      g.ext.h = 0.2
      g.step(DT, { speed: 0, yawRate: 0 })
      fell ||= g.fallen
    }
    const h = new DuckGait(13)
    h.placeAt(0, 0, 0)
    let stepped = false, hfell = false
    for (let n = 0; n < 200; n++) {
      h.ext.x = 3
      h.ext.h = 0.2
      h.step(DT, { speed: 0, yawRate: 0 })
      stepped ||= h.busy
      hfell ||= h.fallen
    }
    assert(fell && !hfell && stepped, `grab: a hard pull (7 N) drags it over, a gentle one (3 N) only makes it step (${fell}, ${hfell}, ${stepped})`)
    void FALL
  }
}

// ── Look springs ──────────────────────────────────────────────────────────

{
  // Step response: a target 60 deg to the left and 20 deg down, from rest.
  const g = new DuckGait(4)
  g.placeAt(0, 0, 0)
  const ty = 60 * deg
  const eye = { y: GAIT.standH + 0.22, z: 0.11 }
  const dist = 1
  const tp = -20 * deg
  const target = { x: Math.sin(ty) * dist * Math.cos(tp), y: eye.y + Math.sin(tp) * dist, z: eye.z + Math.cos(ty) * dist * Math.cos(tp) }
  g.lookAt(target)
  let neckT = -1, headT = -1
  const tol = 0.01
  for (let n = 1; n <= 600; n++) {
    g.step(DT, { speed: 0, yawRate: 0 })
    const near = (a: number, b: number) => Math.abs(a - b) <= tol * Math.abs(b)
    const neckOk = near(g.cur.neckYaw, ty) && near(g.cur.neckPitch, tp)
    const headOk = near(g.cur.headYaw, ty) && near(g.cur.headPitch, tp)
    if (neckOk && neckT < 0) neckT = n * DT
    if (!neckOk) neckT = -1
    if (headOk && headT < 0) headT = n * DT
    if (!headOk) headT = -1
  }
  // Critically damped, omega = 9: x(t) = 1 - (1 + wt) e^-wt reaches 99% at wt = 6.64, t = 0.738 s
  // analytically; measured 0.755 s at the 5 ms semi-implicit step. The head chases the neck, so it
  // settles later: measured 0.835 s. Bounds = measured + 25%.
  console.log(`  neck within 1% at ${neckT.toFixed(3)} s, head at ${headT.toFixed(3)} s`)
  assert(neckT > 0 && neckT <= 0.755 * 1.25, 'neck spring converges to a fixed target within its bound (0.94 s)')
  assert(headT > 0 && headT <= 0.835 * 1.25, 'head spring (follow-through) converges within its bound (1.04 s)')
}
{
  // Limits hold for any target, including behind and straight above/below, and while walking and hopping.
  const g = new DuckGait(8)
  const R = rng(17)
  let yawMax = 0, pitchMax = 0
  for (let n = 0; n < 8000; n++) {
    if (n % 60 === 0) g.lookAt(R.next() < 0.1 ? null : { x: R.range(-2, 2), y: R.range(-1, 2), z: R.range(-2, 2) })
    if (n % 1500 === 700) g.react('tap')
    if (n % 1500 === 1200) g.react('shove')
    g.step(DT, { speed: n % 2000 < 1000 ? 0.15 : 0, yawRate: 0.8 })
    yawMax = Math.max(yawMax, Math.abs(g.cur.neckYaw), Math.abs(g.cur.headYaw))
    pitchMax = Math.max(pitchMax, Math.abs(g.cur.neckPitch), Math.abs(g.cur.headPitch))
  }
  assert(yawMax <= 70 * deg + 1e-12 && pitchMax <= 35 * deg + 1e-12, `look limits respected: |yaw| ${(yawMax / deg).toFixed(1)} <= 70 deg, |pitch| ${(pitchMax / deg).toFixed(1)} <= 35 deg`)
}

// ── Determinism across frame rates ────────────────────────────────────────

{
  const N = 3000
  const sim = (fps: number) => {
    const g = new DuckGait(21)
    g.placeAt(0, 0, 0.3)
    const clock = new FixedClock()
    const tmp = newPose()
    let count = 0
    let now = 0
    while (count < N) {
      const alpha = clock.advance(now, () => {
        if (count >= N) return
        if (count === 400) g.react('tap')
        if (count === 1500) g.react('shove')
        if (count === 2000) g.lookAt({ x: 1, y: 0, z: 1 })
        if (count === 2300) g.collide({ x: 0.6, z: 0.8 }, 0.003, 0.25, 'robot', 0)
        g.step(DT, { speed: count > 800 && count < 1400 ? 0.18 : 0, yawRate: count > 1000 && count < 2600 ? 1.1 : 0, strafe: count > 2600 ? -0.06 : 0 })
        count++
      })
      lerpPose(g.prev, g.cur, alpha, tmp)
      now += 1000 / fps
    }
    return g.snapshot()
  }
  const a = sim(60), b = sim(30), c = sim(144)
  assert(a === b && a === c, `determinism: identical state after ${N} steps at 30, 60 and 144 Hz frame rates (bitwise)`)
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll gait checks passed')
