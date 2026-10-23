/**
 * Robot dog gait, IK and scripted fall tests. Run: npx --yes tsx scripts/test-dog.ts
 *
 * Every foot check goes through poseJoints() -- the same function the
 * renderer calls -- and reads the feet back with forward kinematics, so what
 * is tested is what is drawn.
 */
import { DT, FixedClock } from '../app/three/core/clock'
import { rng } from '../app/three/core/rng'
import { maxOverlap, solveContacts, type Body, type Obstacle, type Walls } from '../app/three/robots/contact'
import { DOG_GAIT, DOG_SHAPE, DOG_STEP, DogGait, FALL_TOTAL, HOP_TOTAL, lerpPose, newPose, poseJoints, type DogPose } from '../app/three/robots/dog/gait'
import { D_MAX, D_MIN, DOG, LIMITS, fkLeg, solveLeg } from '../app/three/robots/dog/ik'
import { bodyRotation, type Vec3 } from '../app/three/robots/dog/kin'
import type { Command } from '../app/three/robots/dog/stepper'

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

// ── IK ────────────────────────────────────────────────────────────────────

{
  // Random joint angles inside the limits -> FK -> IK -> FK, on the knee-back branch.
  const R = rng(11)
  let worst = 0
  let n = 0
  for (let k = 0; k < 5000; k++) {
    const i = k % 4
    const abd = R.range(LIMITS.abd[0] * 0.95, LIMITS.abd[1] * 0.95)
    const hip = R.range(-1.2, 2.4)
    const knee = R.range(LIMITS.knee[0] * 0.98, -0.6)
    const body: Vec3 = [R.range(-1, 1), R.range(0.05, 0.3), R.range(-1, 1)]
    const Rb = bodyRotation(R.range(-3, 3), R.range(-0.4, 0.4), R.range(-0.3, 0.3))
    const a = fkLeg(body, Rb, i, abd, hip, knee)
    // Only the branch where the foot hangs below the abduction axis.
    const s = solveLeg(body, Rb, i, a.foot)
    if (s.clamped || s.limited) continue
    const b = fkLeg(body, Rb, i, s.abd, s.hip, s.knee)
    const e = Math.hypot(a.foot[0] - b.foot[0], a.foot[1] - b.foot[1], a.foot[2] - b.foot[2])
    // A different (mirror) abduction branch can also reach the same foot; only the foot position must agree.
    worst = Math.max(worst, e)
    n++
  }
  assert(n > 2000 && worst < 1e-6, `IK->FK round trip over ${n} reachable feet: worst foot error ${worst.toExponential(2)} m`)
}

{
  const body: Vec3 = [0, 0.18, 0]
  const Rb = bodyRotation(0.3, 0.1, -0.05)
  const cases: [string, Vec3][] = [['1 m away', [1, -0.5, 0.4]], ['on the hip', [0.03, 0.18, 0.116]], ['NaN', [Number.NaN, 0, 0]]]
  for (const [name, f] of cases) {
    const s = solveLeg(body, Rb, 0, f)
    assert(Number.isFinite(s.abd + s.hip + s.knee) && s.clamped, `IK finite and flagged clamped for ${name}`)
  }
  assert(D_MIN > 0 && D_MAX < DOG.L1 + DOG.L2, 'IK reach band is inside the leg')
}

// ── Gait helpers ───────────────────────────────────────────────────────────

const Q = new Array(12).fill(0)
/** Pad-contact points (y of the pad bottom) of a pose, as drawn. */
function drawnFeet(p: DogPose) {
  poseJoints(p, Q)
  const R = bodyRotation(p.yaw, p.pitch, p.roll)
  const out: Vec3[] = []
  for (let i = 0; i < 4; i++) {
    const f = fkLeg([p.x, p.y, p.z], R, i, Q[3 * i]!, Q[3 * i + 1]!, Q[3 * i + 2]!).foot
    out.push([f[0], f[1] - DOG.footR, f[2]])
  }
  return out
}

function jointsOk() {
  return Q.every(Number.isFinite)
}

interface Run { maxSlide: number, maxErr: number, minFootY: number, minBodyY: number, limited: number, steps: number, stances: number }

/** Run a gait for `secs` with a command schedule; track planted-foot slide and IK error on every step. */
function run(g: DogGait, secs: number, cmd: (t: number) => Command, check = true): Run {
  const r: Run = { maxSlide: 0, maxErr: 0, minFootY: Infinity, minBodyY: Infinity, limited: 0, steps: 0, stances: 0 }
  const anchor: (Vec3 | null)[] = [null, null, null, null]
  const ids = [...g.stepper.stanceId]
  const n = Math.round(secs / DT)
  for (let k = 0; k < n; k++) {
    g.step(DT, cmd(k * DT))
    r.steps++
    if (!check) continue
    const feet = drawnFeet(g.cur)
    if (!jointsOk()) r.limited++
    for (let i = 0; i < 4; i++) {
      const f = feet[i]!
      r.minFootY = Math.min(r.minFootY, f[1])
      if (g.mode === 'fall') {
        anchor[i] = null
        continue
      }
      const planted = g.stepper.planted[i]!
      if (planted) {
        const t = g.stepper.feet[i]!
        r.maxErr = Math.max(r.maxErr, Math.hypot(f[0] - t.x, f[1] - t.y, f[2] - t.z))
        if (g.stepper.stanceId[i] !== ids[i] || !anchor[i]) {
          anchor[i] = f
          ids[i] = g.stepper.stanceId[i]!
          r.stances++
        }
        else {
          r.maxSlide = Math.max(r.maxSlide, Math.hypot(f[0] - anchor[i]![0], f[1] - anchor[i]![1], f[2] - anchor[i]![2]))
        }
      }
      else anchor[i] = null
    }
    r.minBodyY = Math.min(r.minBodyY, g.cur.y)
  }
  return r
}

// ── Gait ──────────────────────────────────────────────────────────────────

{
  const g = new DogGait(5)
  g.placeAt(0, 0, 0)
  const r = run(g, 8, t => ({ speed: t < 6 ? 0.3 : 0, yawRate: t > 2 && t < 4 ? 0.9 : 0 }))
  assert(r.stances > 40, `trot plants feet (${r.stances} stances)`)
  assert(r.maxSlide < 1e-6, `trot: planted feet never slide (max ${r.maxSlide.toExponential(2)} m)`)
  assert(r.maxErr < 2e-4, `trot: drawn planted feet sit on their footholds (max ${(r.maxErr * 1000).toFixed(3)} mm)`)
  assert(r.minFootY > -1e-4, `trot: no foot below the ground (min ${(r.minFootY * 1000).toFixed(2)} mm)`)
  assert(Math.hypot(g.stepper.bx, g.stepper.bz) > 1, `trot covers ground (${Math.hypot(g.stepper.bx, g.stepper.bz).toFixed(2)} m)`)
  assert(g.mode === 'stand' && g.stepper.squared(), 'trot ends in a squared stance')
}

{
  // Strafe, back up, spin on the spot, side-step.
  const g = new DogGait(9)
  const r = run(g, 9, t => (t < 2 ? { speed: -0.12, yawRate: 0 } : t < 4.5 ? { speed: 0, yawRate: 1.6 } : t < 7 ? { speed: 0.05, yawRate: 0, strafe: 0.12 } : { speed: 0, yawRate: 0 }))
  assert(r.maxSlide < 1e-6 && r.maxErr < 2e-4, `reverse / spin / strafe: no slide (${r.maxSlide.toExponential(2)}), feet on footholds (${(r.maxErr * 1000).toFixed(3)} mm)`)
  assert(r.limited === 0, 'reverse / spin / strafe: joints finite')
}

{
  // Postures: sit, bow, lie, stand -- all with feet planted.
  const g = new DogGait(3)
  g.setPosture('sit')
  let r = run(g, 1.5, () => ({ speed: 0, yawRate: 0 }))
  const sitPitch = g.cur.pitch
  assert(sitPitch < -0.25, `sit: nose up (pitch ${sitPitch.toFixed(2)} rad)`)
  assert(r.maxSlide < 1e-6 && r.maxErr < 1e-3, `sit: feet stay put and reached (${(r.maxErr * 1000).toFixed(3)} mm)`)
  g.setPosture('bow')
  r = run(g, 0.8, () => ({ speed: 0, yawRate: 0 }))
  assert(g.cur.pitch > 0.25, `bow: front down, rear up (pitch ${g.cur.pitch.toFixed(2)})`)
  assert(r.maxSlide < 1e-6 && r.maxErr < 1e-3, `bow: feet stay put and reached (${(r.maxErr * 1000).toFixed(3)} mm)`)
  r = run(g, 3, () => ({ speed: 0, yawRate: 0 }))
  assert(Math.abs(g.cur.pitch) < 0.12 && g.posture === 'stand', `bow returns to standing by itself (pitch ${g.cur.pitch.toFixed(3)}, look tilt included)`)
  g.setPosture('sit')
  run(g, 1, () => ({ speed: 0, yawRate: 0 }))
  r = run(g, 3, () => ({ speed: 0.2, yawRate: 0 }))
  assert(g.posture === 'stand' && g.mode === 'walk', 'a walk command stands it up from a sit, then it trots')
}

{
  const g = new DogGait(4)
  g.react('tap')
  const r = run(g, HOP_TOTAL + 1.2, () => ({ speed: 0, yawRate: 0 }))
  assert(g.hops === 1 && g.mode === 'stand' && !g.busy, 'tap: one hop, then standing and free')
  assert(r.minFootY > -1e-4, 'hop: no foot below the ground')
  assert(r.maxErr < 2e-4, `hop: planted feet on their footholds (${(r.maxErr * 1000).toFixed(3)} mm)`)
}

{
  const g = new DogGait(6)
  g.react('shove')
  const r = run(g, 3, () => ({ speed: 0, yawRate: 0 }))
  assert(g.stepper.bz < -0.03 && !g.busy && g.mode === 'stand', `shove: stumbles back (${g.stepper.bz.toFixed(3)} m) and recovers`)
  assert(r.maxSlide < 1e-6, 'shove: planted feet never slide while stumbling')
}

{
  // Knocked over from both sides: falls, lies, rights itself, stands.
  for (const dir of [1, -1]) {
    const g = new DogGait(8)
    g.placeAt(0.2, -0.1, 0.7)
    run(g, 1, () => ({ speed: 0.25, yawRate: 0 }))
    const c = Math.cos(g.heading), s = Math.sin(g.heading)
    g.startFall(c * dir, -s * dir)
    assert(g.fallen && g.busy, `fall ${dir > 0 ? 'left' : 'right'}: fallen and busy`)
    let minRoll = 0, maxRoll = 0, lowest = Infinity
    const n = Math.round((FALL_TOTAL + 0.5) / DT)
    let sawSide = false
    for (let k = 0; k < n; k++) {
      g.step(DT, { speed: 0, yawRate: 0 })
      minRoll = Math.min(minRoll, g.cur.roll)
      maxRoll = Math.max(maxRoll, g.cur.roll)
      if (g.fallen && g.script.tag === 'ground') sawSide = Math.abs(Math.abs(g.cur.roll) - Math.PI / 2) < 0.1
      if (g.fallen && g.script.tag !== 'rise') lowest = Math.min(lowest, g.cur.y)
      for (const f of drawnFeet(g.cur)) lowest = Math.min(lowest, f[1] + 1)
    }
    assert(sawSide, `fall ${dir > 0 ? 'left' : 'right'}: lies on its side during the beat on the ground`)
    assert((dir > 0 ? minRoll : -maxRoll) < -1.4, `fall ${dir > 0 ? 'left' : 'right'}: rolls the right way (${minRoll.toFixed(2)} .. ${maxRoll.toFixed(2)})`)
    assert(!g.fallen && !g.busy && g.mode === 'stand', `fall ${dir > 0 ? 'left' : 'right'}: gets up and is free again`)
    assert(Math.abs(g.cur.y - DOG_GAIT.standH) < 0.006 && Math.abs(g.cur.roll) < 0.05, `fall ${dir > 0 ? 'left' : 'right'}: standing height and level afterwards`)
    const r = run(g, 3, () => ({ speed: 0.2, yawRate: 0.3 }))
    assert(r.maxSlide < 1e-6 && r.maxErr < 2e-4, 'walks off after getting up, feet planted')
  }
}

{
  // The support solver: nothing under the floor during the whole scripted fall.
  const g = new DogGait(12)
  g.startFall(1, 0)
  let worst = 0
  const n = Math.round(FALL_TOTAL / DT)
  for (let k = 0; k < n; k++) {
    g.step(DT, { speed: 0, yawRate: 0 })
    for (const f of drawnFeet(g.cur)) worst = Math.min(worst, f[1])
  }
  assert(worst > -0.003, `scripted fall: no foot pad below the ground (${(worst * 1000).toFixed(2)} mm)`)
}

{
  // Grab: a hard drag knocks it over; a gentle one walks it along.
  const g = new DogGait(2)
  run(g, 0.3, () => ({ speed: 0, yawRate: 0 }))
  g.grab({ x: 0, y: 0.2, z: 0 })
  g.dragTo({ x: 0.15, y: 0.25, z: 0 })
  run(g, 1.5, () => ({ speed: 0, yawRate: 0 }), false)
  assert(g.stepper.bx > 0.02 && !g.fallen, `gentle drag walks it toward the hand (${g.stepper.bx.toFixed(3)} m)`)
  g.dragTo({ x: 1.5, y: 0.25, z: 0 })
  run(g, 0.6, () => ({ speed: 0, yawRate: 0 }), false)
  assert(g.fallen, 'hard drag pulls it over')
  g.grab(null)
  run(g, FALL_TOTAL + 0.5, () => ({ speed: 0, yawRate: 0 }), false)
  assert(!g.fallen, 'released, it rights itself')
}

{
  // Contact: a hard hit knocks it over, a soft one staggers it.
  const g = new DogGait(1)
  g.collide({ x: 1, z: 0 }, 0.004, 0.2, 'robot', 0)
  assert(!g.fallen && g.busy, 'soft hit: stagger, not a fall')
  const h = new DogGait(1)
  h.collide({ x: 1, z: 0 }, 0.004, 0.8, 'robot', 0)
  assert(h.fallen, 'hard hit: knocked over')
}

{
  // Held against a static wall or post while the director keeps walking it
  // forward: it must never be stuck "busy" (a stumble restarting over and
  // over), and it must end up sliding along the obstacle or walking away.
  const walls = { minX: -10, maxX: 0.35, minZ: -10, maxZ: 10 }
  const post = [{ x: 0.42, z: 0, r: 0.06 }]
  const cases = [['wall at an angle', Math.PI / 2 - 0.6, true], ['wall head-on', Math.PI / 2, true], ['post head-on', Math.PI / 2, false]] as const
  for (const [name, heading, wall] of cases) {
    const g = new DogGait(14)
    g.placeAt(0, 0, heading)
    const body: Body = { mass: DOG_SHAPE.mass, colliders: g.colliders, collide: (n, d, v, o, i) => g.collide(n, d, v, o, i) }
    let streak = 0, worstStreak = 0, busyT = 0, fell = false
    const z0 = g.cur.z
    for (let k = 0, n = Math.round(10 / DT); k < n; k++) {
      g.step(DT, { speed: 0.25, yawRate: 0 })
      solveContacts([body], wall ? [] : post, undefined, wall ? { walls } : {})
      streak = g.busy ? streak + DT : 0
      worstStreak = Math.max(worstStreak, streak)
      if (g.busy) busyT += DT
      if (g.fallen) fell = true
    }
    assert(!fell, `${name}: walking into it does not knock it over`)
    assert(worstStreak < 2 && !g.busy, `${name}: never busy for more than 2 s at a time (longest ${worstStreak.toFixed(2)} s), commandable at the end`)
    assert(busyT < 2.5, `${name}: one step back, not a stumble loop (busy ${busyT.toFixed(2)} s of 10)`)
    if (name === 'wall at an angle') assert(g.cur.z - z0 > 0.4, `${name}: slides along the wall (${(g.cur.z - z0).toFixed(2)} m)`)
    if (name === 'post head-on') assert(Math.abs(g.cur.z - z0) > 0.1 || g.cur.x > 0.5, `${name}: works its way round the post (${g.cur.x.toFixed(2)}, ${(g.cur.z - z0).toFixed(2)})`)
  }
}

{
  // Knocked over next to a post, a goal net and a wall (on either side, from
  // either direction): through the fall, the beat on the ground, the roll and
  // the get-up it is never more than 2 mm into any of them -- the lying body
  // and its legs are pushed out whole -- and it ends standing, clear.
  let worstAll = 0, cases = 0, away = 0, awayCases = 0
  for (const kind of ['post', 'net', 'wall'] as const) {
    for (const side of [1, -1]) {
      for (const dir of [1, -1]) {
        const g = new DogGait(3)
        g.placeAt(0, 0, 0)
        // Obstacles to its left (side 1) or right (side -1); heading 0 faces +Z, left is +X.
        const obs: Obstacle[] = kind === 'post' ? [{ x: side * 0.15, z: 0.02, r: 0.02, h: 0.055 }]
          : kind === 'net' ? Array.from({ length: 9 }, (_, k) => ({ x: side * 0.14, z: (k - 4) * 0.05, r: 0.012, h: 0.05 }))
            : []
        const walls: Walls | undefined = kind === 'wall' ? (side > 0 ? { minX: -10, maxX: 0.14, minZ: -10, maxZ: 10 } : { minX: -0.14, maxX: 10, minZ: -10, maxZ: 10 }) : undefined
        const body: Body = { mass: DOG_SHAPE.mass, colliders: g.colliders, collide: (n, d, v, o, i) => g.collide(n, d, v, o, i) }
        const solve = () => solveContacts([body], obs, undefined, walls ? { walls } : {})
        // Side-step into it first, so it has touched it.
        for (let k = 0; k < 120; k++) {
          g.step(DT, { speed: 0, yawRate: 0, strafe: side * 0.12 })
          solve()
        }
        g.startFall(dir, 0)
        let worst = 0, minRoll = 0, maxRoll = 0
        for (let k = 0, n = Math.round((FALL_TOTAL + 1.5) / DT); k < n; k++) {
          g.step(DT, { speed: 0, yawRate: 0 })
          solve()
          worst = Math.max(worst, maxOverlap([body], obs, walls).worst)
          minRoll = Math.min(minRoll, g.cur.roll)
          maxRoll = Math.max(maxRoll, g.cur.roll)
        }
        worstAll = Math.max(worstAll, worst)
        cases++
        // It went over away from the obstacle: roll < 0 tips its top toward +X (left).
        if (kind === 'wall') {
          awayCases++
          if (side > 0 ? maxRoll > 1.2 : minRoll < -1.2) away++
        }
        assert(!g.fallen && !g.busy && maxOverlap([body], obs, walls).worst < 1e-4,
          `fall next to a ${kind} on its ${side > 0 ? 'left' : 'right'}, pushed ${dir > 0 ? 'left' : 'right'}: up again and clear (worst ${(worst * 1000).toFixed(2)} mm)`)
      }
    }
  }
  assert(worstAll <= 0.002, `falls beside posts, nets and walls: never more than 2 mm into them (worst ${(worstAll * 1000).toFixed(2)} mm over ${cases} falls)`)
  assert(away === awayCases, `beside a wall it always goes over away from it (${away}/${awayCases})`)
}

{
  // A lifted foot that starts inside a low obstacle is cleared at once, not over several steps.
  const ramp: Obstacle[] = [0.09, 0.14, 0.2, 0.25].map(x => ({ x, z: 0.3, r: 0.08, h: 0.04 }))
  let worst = 0
  for (const a of [0, 0.4, -0.4]) {
    const g = new DogGait(3)
    g.placeAt(0.15, -0.1, a)
    const body: Body = { mass: DOG_SHAPE.mass, colliders: g.colliders, collide: (n, d, v, o, i) => g.collide(n, d, v, o, i) }
    for (let k = 0; k < 6 / DT; k++) {
      g.step(DT, { speed: 0.25, yawRate: k * DT > 3 ? 1 : 0 })
      solveContacts([body], ramp)
      worst = Math.max(worst, maxOverlap([body], ramp).worst)
    }
  }
  assert(worst <= 0.002, `trotting into a low ramp: feet and body never more than 2 mm into it (${(worst * 1000).toFixed(2)} mm)`)
}

// ── Determinism ────────────────────────────────────────────────────────────

{
  const script = (t: number): Command => ({ speed: t < 3 ? 0.25 : 0.05, yawRate: t > 1.5 && t < 3.5 ? 1 : 0, strafe: t > 4 ? 0.06 : 0 })
  const go = (hz: number) => {
    const g = new DogGait(77)
    const clock = new FixedClock()
    let sim = 0
    let tapped = false
    let fell = false
    const frame = 1000 / hz
    for (let now = 0; sim < 9.5 * 200; now += frame) {
      clock.advance(now, () => {
        const t = sim * DT
        if (!tapped && t >= 1) { g.react('tap'); tapped = true }
        if (!fell && t >= 5) { g.startFall(0, 1); fell = true }
        g.step(DT, script(t))
        sim++
      })
    }
    return { snap: g.snapshot(), sim }
  }
  const a = go(30), b = go(60), c = go(144)
  assert(a.sim === b.sim && b.sim === c.sim, `same number of steps at 30/60/144 Hz (${a.sim})`)
  assert(a.snap === b.snap && b.snap === c.snap, 'identical state at 30/60/144 Hz')
}

{
  // Interpolated frames between steps keep planted feet on their footholds too.
  const g = new DogGait(5)
  run(g, 1, () => ({ speed: 0.3, yawRate: 0.5 }), false)
  const p = newPose()
  let worst = 0
  for (let k = 0; k < 200; k++) {
    g.step(DT, { speed: 0.3, yawRate: 0.5 })
    lerpPose(g.prev, g.cur, 0.5, p)
    const feet = drawnFeet(p)
    for (let i = 0; i < 4; i++) {
      if (!g.stepper.planted[i]) continue
      const t = g.stepper.feet[i]!
      if (g.prev.feet[i]!.x !== t.x || g.prev.feet[i]!.z !== t.z) continue
      worst = Math.max(worst, Math.hypot(feet[i]![0] - t.x, feet[i]![1] - t.y, feet[i]![2] - t.z))
    }
  }
  assert(worst < 2e-4, `interpolated frames: planted feet on footholds (${(worst * 1000).toFixed(3)} mm)`)
}

assert(DOG_STEP.groups.flat().length === 4, 'trot pairs cover all four feet')

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nAll dog tests passed.')
