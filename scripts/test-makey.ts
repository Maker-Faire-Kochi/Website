/**
 * Makey gait, IK, wave and scripted fall tests. Run: npx --yes tsx scripts/test-makey.ts
 *
 * Sole checks go through poseJoints() -- the function the renderer calls --
 * and read the soles back with forward kinematics: what is tested is what is drawn.
 */
import { DT, FixedClock } from '../app/three/core/clock'
import { rng } from '../app/three/core/rng'
import { bodyRotation, rotY, type Vec3 } from '../app/three/robots/dog/kin'
import type { Command } from '../app/three/robots/dog/stepper'
import { FALL_TOTAL, HOP_TOTAL, MAKEY_GAIT, MakeyGait, NQ, lerpPose, newPose, poseJoints, type MakeyPose } from '../app/three/robots/makey/gait'
import { JOINTS, LEG, LIMITS, fkLeg, solveLeg } from '../app/three/robots/makey/ik'

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
  const R = rng(3)
  let worst = 0, n = 0
  for (let k = 0; k < 6000; k++) {
    const q = JOINTS.map(j => R.range(LIMITS[j][0] * 0.95, LIMITS[j][1] * 0.95))
    const P: Vec3 = [R.range(-1, 1), R.range(0.05, 0.2), R.range(-1, 1)]
    const PR = bodyRotation(R.range(-3, 3), R.range(-0.2, 0.2), R.range(-0.15, 0.15))
    const side = k % 2 ? 1 : -1
    const a = fkLeg(P, PR, side, q)
    const s = solveLeg(P, PR, side, a.sole, a.soleR)
    if (s.clamped || s.limited) continue
    const b = fkLeg(P, PR, side, JOINTS.map(j => s[j]))
    let e = Math.hypot(a.sole[0] - b.sole[0], a.sole[1] - b.sole[1], a.sole[2] - b.sole[2])
    for (let i = 0; i < 9; i++) e = Math.max(e, Math.abs(a.soleR[i]! - b.soleR[i]!))
    // Only the knee-forward branch the solver uses is comparable.
    if (q[3]! > 0) {
      worst = Math.max(worst, e)
      n++
    }
  }
  assert(n > 1500 && worst < 1e-6, `IK->FK round trip over ${n} reachable poses: worst error ${worst.toExponential(2)}`)
  const P: Vec3 = [0, 0.1, 0]
  for (const [name, s] of [['far', [1, -1, 0]], ['NaN', [Number.NaN, 0, 0]], ['at the hip', [LEG.hipW, 0.1 - LEG.ankleH, 0]]] as [string, Vec3][]) {
    const r = solveLeg(P, bodyRotation(0, 0, 0), 1, s, rotY(0))
    assert(JOINTS.every(j => Number.isFinite(r[j])) && r.clamped, `IK finite and clamped: ${name}`)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

const Q = new Array(NQ).fill(0)
function drawnSoles(p: MakeyPose) {
  poseJoints(p, Q)
  const R = bodyRotation(p.yaw, p.pitch, p.roll)
  return [0, 1].map(s => fkLeg([p.x, p.y, p.z], R, s === 0 ? 1 : -1, Q, s * 6))
}

interface Run { maxSlide: number, maxErr: number, maxTilt: number, stances: number, bad: number }
function run(g: MakeyGait, secs: number, cmd: (t: number) => Command, check = true): Run {
  const r: Run = { maxSlide: 0, maxErr: 0, maxTilt: 0, stances: 0, bad: 0 }
  const anchor: (Vec3 | null)[] = [null, null]
  const ids = [...g.stepper.stanceId]
  for (let k = 0, n = Math.round(secs / DT); k < n; k++) {
    g.step(DT, cmd(k * DT))
    if (!check || g.mode === 'fall') {
      anchor[0] = anchor[1] = null
      continue
    }
    const soles = drawnSoles(g.cur)
    if (!Q.every(Number.isFinite)) r.bad++
    for (let i = 0; i < 2; i++) {
      if (!g.stepper.planted[i]) {
        anchor[i] = null
        continue
      }
      const f = soles[i]!, t = g.stepper.feet[i]!
      r.maxErr = Math.max(r.maxErr, Math.hypot(f.sole[0] - t.x, f.sole[1] - t.y, f.sole[2] - t.z))
      // A planted sole is flat: its normal is +Y.
      r.maxTilt = Math.max(r.maxTilt, Math.acos(Math.min(1, f.soleR[4])))
      if (g.stepper.stanceId[i] !== ids[i] || !anchor[i]) {
        anchor[i] = [f.sole[0], f.sole[1], f.sole[2]]
        ids[i] = g.stepper.stanceId[i]!
        r.stances++
      }
      else r.maxSlide = Math.max(r.maxSlide, Math.hypot(f.sole[0] - anchor[i]![0], f.sole[1] - anchor[i]![1], f.sole[2] - anchor[i]![2]))
    }
  }
  return r
}

// ── Walking ───────────────────────────────────────────────────────────────

{
  const g = new MakeyGait(5)
  g.autoWave = false
  const r = run(g, 9, t => ({ speed: t < 7 ? 0.15 : 0, yawRate: t > 2 && t < 4 ? 0.8 : 0 }))
  assert(r.stances > 20, `walk plants feet (${r.stances} stances)`)
  assert(r.maxSlide < 1e-6, `walk: planted feet never slide (${r.maxSlide.toExponential(2)} m)`)
  assert(r.maxErr < 2e-4 && r.maxTilt < 1e-4, `walk: drawn soles on their footholds (${(r.maxErr * 1000).toFixed(3)} mm) and flat (${r.maxTilt.toExponential(1)} rad)`)
  assert(r.bad === 0, 'walk: joints finite')
  assert(g.mode === 'stand' && g.stepper.squared(), 'walk ends squared and standing')
}

{
  const g = new MakeyGait(8)
  g.autoWave = false
  const r = run(g, 8, t => (t < 2 ? { speed: -0.08, yawRate: 0 } : t < 4.5 ? { speed: 0, yawRate: 1.4 } : t < 6.5 ? { speed: 0, yawRate: 0, strafe: 0.08 } : { speed: 0, yawRate: 0 }))
  assert(r.maxSlide < 1e-6 && r.maxErr < 2e-4, `back / spin / side-step: no slide (${r.maxSlide.toExponential(2)}), on footholds (${(r.maxErr * 1000).toFixed(3)} mm)`)
}

// ── Waving ────────────────────────────────────────────────────────────────

{
  const g = new MakeyGait(2)
  // A target to its left holding still: it waves with its left arm, once, then cools down.
  g.lookAt({ x: 0.4, y: 0.15, z: 0.5 })
  let maxRoll = 0, waved = 0
  for (let k = 0; k < Math.round(3 / DT); k++) {
    g.lookAt({ x: 0.4, y: 0.15, z: 0.5 })
    g.step(DT, { speed: 0, yawRate: 0 })
    maxRoll = Math.max(maxRoll, g.cur.q[13]!)
    if (g.waving) waved++
  }
  assert(g.waves === 1 && maxRoll > 1.8, `greets a still target on its left with the left arm raised (${maxRoll.toFixed(2)} rad)`)
  assert(!g.waving && g.cur.q[13]! < 0.4, 'the arm comes back down')
  const w = g.waves
  run(g, 2, () => ({ speed: 0, yawRate: 0 }), false)
  assert(g.waves === w, 'cooldown: no second wave straight away')
  const h = new MakeyGait(2)
  h.lookAt({ x: 3, y: 0.15, z: 3 })
  run(h, 3, () => ({ speed: 0, yawRate: 0 }), false)
  assert(h.waves === 0, 'does not wave at something far away')
}

{
  const g = new MakeyGait(4)
  g.react('tap')
  let both = false
  for (let k = 0; k < Math.round((HOP_TOTAL + 1.5) / DT); k++) {
    g.step(DT, { speed: 0, yawRate: 0 })
    if (g.cur.q[13]! > 1 && g.cur.q[18]! < -1) both = true
  }
  assert(g.hops === 1 && both && g.mode === 'stand' && !g.busy, 'tap: two-arm wave and a hop, then free')
}

{
  const g = new MakeyGait(6)
  g.autoWave = false
  g.react('shove')
  const r = run(g, 3, () => ({ speed: 0, yawRate: 0 }))
  assert(g.stepper.bz < -0.02 && !g.busy, `shove: stumbles back (${g.stepper.bz.toFixed(3)} m) and recovers`)
  assert(r.maxSlide < 1e-6, 'shove: planted feet never slide')
}

// ── Falls ─────────────────────────────────────────────────────────────────

for (const [name, nx, nz] of [['backward', 0, -1], ['forward', 0, 1], ['sideways', 1, 0]] as const) {
  const g = new MakeyGait(9)
  g.autoWave = false
  g.startFall(nx, nz)
  assert(g.fallen && g.busy, `${name} fall: fallen and busy`)
  let lowest = Infinity, maxPitch = 0, tags = new Set<string>()
  for (let k = 0; k < Math.round((FALL_TOTAL + 0.3) / DT); k++) {
    g.step(DT, { speed: 0, yawRate: 0 })
    if (g.fallen) tags.add(g.script.tag)
    maxPitch = Math.max(maxPitch, Math.abs(g.cur.pitch))
    for (const s of drawnSoles(g.cur)) {
      const R = s.soleR
      for (const [cx, cz] of [[LEG.footHalfW, LEG.toe], [-LEG.footHalfW, LEG.toe], [LEG.footHalfW, LEG.heel], [-LEG.footHalfW, LEG.heel]]) {
        lowest = Math.min(lowest, s.sole[1] + R[3] * cx! + R[5] * cz!)
      }
    }
  }
  assert(maxPitch > 1.2, `${name} fall: goes all the way down (pitch ${maxPitch.toFixed(2)})`)
  assert(tags.has('ground') && tags.has('push') && tags.has('rise'), `${name} fall: a beat on the ground, a push-off, a rise (${[...tags].join(' > ')})`)
  assert(lowest > -0.004, `${name} fall: soles never under the floor (${(lowest * 1000).toFixed(2)} mm)`)
  assert(!g.fallen && Math.abs(g.cur.y - MAKEY_GAIT.standH) < 0.006, `${name} fall: standing again`)
  // Dust off, then wave.
  let waved = false
  for (let k = 0; k < Math.round(2.5 / DT); k++) {
    g.step(DT, { speed: 0, yawRate: 0 })
    if (g.waving) waved = true
  }
  assert(waved && !g.busy, `${name} fall: dusts off and waves, then free`)
  const r = run(g, 3, () => ({ speed: 0.12, yawRate: 0.3 }))
  assert(r.maxSlide < 1e-6 && r.maxErr < 2e-4, `${name} fall: walks off with planted feet`)
}

{
  const g = new MakeyGait(1)
  g.grab({ x: 0, y: 0.18, z: 0 })
  g.dragTo({ x: 0.12, y: 0.2, z: 0 })
  run(g, 1.5, () => ({ speed: 0, yawRate: 0 }), false)
  assert(g.stepper.bx > 0.02 && !g.fallen, `gentle drag walks it along (${g.stepper.bx.toFixed(3)} m)`)
  g.dragTo({ x: 1.5, y: 0.2, z: 0 })
  run(g, 0.6, () => ({ speed: 0, yawRate: 0 }), false)
  assert(g.fallen, 'hard drag knocks it over')
  g.grab(null)
  run(g, FALL_TOTAL + 3, () => ({ speed: 0, yawRate: 0 }), false)
  assert(!g.fallen && !g.busy, 'released, it gets up')
  const h = new MakeyGait(1)
  h.collide({ x: 0, z: 1 }, 0.003, 0.7, 'robot', 0)
  assert(h.fallen, 'hard hit: falls')
}

// ── Determinism ──────────────────────────────────────────────────────────

{
  const go = (hz: number) => {
    const g = new MakeyGait(77)
    const clock = new FixedClock()
    let sim = 0
    for (let now = 0; sim < 12 * 200; now += 1000 / hz) {
      clock.advance(now, () => {
        const t = sim * DT
        if (sim === 200) g.react('tap')
        if (sim === 1200) g.startFall(1, 0.3)
        g.lookAt(t > 3 && t < 5 ? { x: 0.3, y: 0.1, z: 0.4 } : null)
        g.step(DT, { speed: t < 4 ? 0.14 : 0, yawRate: t > 2 && t < 3 ? 1 : 0 })
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
  const g = new MakeyGait(5)
  g.autoWave = false
  run(g, 1, () => ({ speed: 0.15, yawRate: 0.5 }), false)
  const p = newPose()
  let worst = 0
  for (let k = 0; k < 300; k++) {
    g.step(DT, { speed: 0.15, yawRate: 0.5 })
    lerpPose(g.prev, g.cur, 0.5, p)
    const soles = drawnSoles(p)
    for (let i = 0; i < 2; i++) {
      const t = g.stepper.feet[i]!
      if (!g.stepper.planted[i] || g.prev.feet[i]!.x !== t.x) continue
      worst = Math.max(worst, Math.hypot(soles[i]!.sole[0] - t.x, soles[i]!.sole[1] - t.y, soles[i]!.sole[2] - t.z))
    }
  }
  assert(worst < 2e-4, `interpolated frames: planted soles on footholds (${(worst * 1000).toFixed(3)} mm)`)
}

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nAll Makey tests passed.')
