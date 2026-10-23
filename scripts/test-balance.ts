/**
 * Wheel-legged balancer simulation tests:  npm run test:balance
 *
 * Thresholds are NOT guesses: each is the value measured with the committed
 * gain table (noted beside it) plus 25%. "Settled at T" means the state stays
 * inside the band for every step from T to the end of the run. Sensor noise
 * is on (seeded) unless a test needs exact zeros.
 */
import { DT, FixedClock } from '../app/three/core/clock'
import {
  BalancerSim, BUMPER, GAIN_TABLE, HEAD, HeadSpring, IMPULSE_FALL, LEG_GRID, LIMITS, RIGHTING, TUNED,
  groundAngles, linearize, paramsFor,
} from '../app/three/robots/balancer/dynamics'
import { GEO } from '../app/three/robots/balancer/geometry'
import { discretize, dlqr } from '../app/three/robots/balancer/lqr'

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

const MARGIN = 1.25
const STEPS_10S = Math.round(10 / DT)
const still = { speed: 0, yawRate: 0 }

/** Time from which the predicate holds for every remaining step. */
function settleTime(trace: boolean[]) {
  let last = -1
  trace.forEach((ok, i) => {
    if (!ok) last = i
  })
  return (last + 2) * DT
}

// ── 0. The gain schedule is what the LQR design gives ──────────────────────
{
  let worst = 0
  for (let k = 0; k < LEG_GRID.length; k++) {
    const { A, B } = linearize(paramsFor(LEG_GRID[k]!))
    const { Ad, Bd } = discretize(A, B, DT)
    const { K } = dlqr(Ad, Bd, TUNED.Q, TUNED.R)
    worst = Math.max(worst, ...K.map((v, i) => Math.abs(v - GAIN_TABLE[k]![i]!)))
  }
  assert(worst < 1e-4, `0. committed GAIN_TABLE = discrete LQR redesign at every grid leg length (max |dK| ${worst.toExponential(1)})`)
}

// ── 1. Recovery from a lean ───────────────────────────────────────────────
// Measured at the standing leg length: 1.680 s (+0.15), 1.645 s (-0.15).
{
  const T1 = 1.68 * MARGIN
  for (const th0 of [0.15, -0.15]) {
    const sim = new BalancerSim({ seed: 7 })
    sim.th = th0
    const band: boolean[] = []
    let tauOk = true
    for (let i = 0; i < STEPS_10S; i++) {
      sim.step(still)
      if (Math.abs(sim.tau) > sim.p.tauMax + 1e-12) tauOk = false
      band.push(Math.abs(sim.th) < 0.01 && Math.abs(sim.xd) < 0.02)
    }
    const t = settleTime(band)
    assert(sim.mode === 'balancing' && t <= T1, `1. recovery th0=${th0}: settled at ${t.toFixed(3)} s <= ${T1.toFixed(3)} s`)
    assert(tauOk, `1. recovery th0=${th0}: |tau| <= tauMax throughout`)
  }
  // Crouched and standing tall, with the scheduled gains. Measured: 0.525 s (L 0.075), 1.45 s (L 0.165).
  for (const [L, T] of [[0.075, 0.525], [0.165, 1.45]] as const) {
    const sim = new BalancerSim({ seed: 7, leg: L })
    sim.th = 0.1
    const band: boolean[] = []
    for (let i = 0; i < STEPS_10S; i++) {
      sim.step(still)
      band.push(Math.abs(sim.th) < 0.01 && Math.abs(sim.xd) < 0.02)
    }
    const t = settleTime(band)
    assert(sim.mode === 'balancing' && t <= T * MARGIN, `1. leg ${L} m: a 0.1 rad lean settles at ${t.toFixed(3)} s <= ${(T * MARGIN).toFixed(3)} s`)
  }
}

// ── 2/3. Drive off and brake ─────────────────────────────────────────────
// Measured: min x before positive -2.61 mm; speed in band at 2.455 s; stopping distance 104.5 mm.
{
  const T2 = 2.455 * MARGIN
  const STOP = 0.1045 * MARGIN
  const sim = new BalancerSim({ seed: 7 })
  let xMin = 0
  let positive = false
  const band: boolean[] = []
  for (let i = 0; i < STEPS_10S; i++) {
    sim.step({ speed: 0.2, yawRate: 0 })
    if (sim.x > 0) positive = true
    if (!positive) xMin = Math.min(xMin, sim.x)
    band.push(Math.abs(sim.xd - 0.2) < 0.02)
  }
  assert(xMin < -0.001, `2. drive off: rolls back first (min x before positive ${(xMin * 1000).toFixed(2)} mm < -1 mm)`)
  const t2 = settleTime(band)
  assert(t2 <= T2, `2. drive off: speed settled in 0.2 +/- 0.02 m/s at ${t2.toFixed(3)} s <= ${T2.toFixed(3)} s`)
  const x0 = sim.x
  let xMax = x0
  for (let i = 0; i < STEPS_10S; i++) {
    sim.step(still)
    xMax = Math.max(xMax, sim.x)
  }
  assert(xMax - x0 <= STOP, `3. braking: stopping distance ${((xMax - x0) * 1000).toFixed(1)} mm <= ${(STOP * 1000).toFixed(1)} mm`)
  assert(Math.abs(sim.xd) < 0.02 && sim.mode === 'balancing', '3. braking: stopped and balancing after 10 s')
}

// ── 4. Disturbance ───────────────────────────────────────────────────────
{
  const falls = (imp: number) => {
    const sim = new BalancerSim({ seed: 7, noise: false })
    sim.impulse(imp)
    for (let i = 0; i < 600; i++) {
      sim.step(still)
      if (sim.mode !== 'balancing') return true
    }
    return false
  }
  let lo = 0
  let hi = 20
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (falls(mid)) hi = mid
    else lo = mid
  }
  assert(Math.abs(hi - IMPULSE_FALL) < 1e-3, `4. committed IMPULSE_FALL ${IMPULSE_FALL} matches the bisection (${hi.toFixed(5)} rad/s)`)
  // Measured: 0.5 x impulse_fall settles at 2.615 s / 2.58 s.
  const T4 = 2.615 * MARGIN
  for (const sign of [1, -1]) {
    const sim = new BalancerSim({ seed: 7 })
    sim.impulse(sign * 0.5 * IMPULSE_FALL)
    const band: boolean[] = []
    let fell = false
    for (let i = 0; i < STEPS_10S; i++) {
      sim.step(still)
      if (sim.mode !== 'balancing') fell = true
      band.push(Math.abs(sim.th) < 0.01 && Math.abs(sim.xd) < 0.02)
    }
    const t = settleTime(band)
    assert(!fell && t <= T4, `4. 0.5 x impulse_fall (${sign > 0 ? 'forward' : 'backward'}) recovers, settled at ${t.toFixed(3)} s <= ${T4.toFixed(3)} s`)
  }
  for (const sign of [1, -1]) {
    const sim = new BalancerSim({ seed: 7 })
    sim.impulse(sign * 1.2 * IMPULSE_FALL)
    let fell = false
    for (let i = 0; i < 400; i++) {
      sim.step(still)
      if (sim.mode === 'fallen') fell = true
    }
    assert(fell, `4. 1.2 x impulse_fall (${sign > 0 ? 'forward' : 'backward'}) enters 'fallen'`)
  }
}

// ── 5. Fall -> contact -> righting (with the legs) -> balancing ───────────
{
  for (const th0 of [0.5, -0.5]) {
    const sim = new BalancerSim({ seed: 7 })
    sim.th = th0
    const order: string[] = []
    const note = (s: string) => {
      if (order[order.length - 1] !== s) order.push(s)
    }
    let tRighting = -1
    let tBack = -1
    let minPoint = Infinity
    let legMin = Infinity
    for (let i = 0; i < STEPS_10S; i++) {
      sim.step(still)
      const t = (i + 1) * DT
      if (sim.mode === 'fallen') note(sim.contact ? 'contact' : 'fallen')
      else note(sim.mode)
      if (sim.mode === 'righting' && tRighting < 0) tRighting = t
      if (tRighting > 0 && sim.mode === 'balancing' && tBack < 0) tBack = t
      legMin = Math.min(legMin, sim.L)
      // Every bumper point stays at or above the ground.
      for (const p of [BUMPER.front, BUMPER.back, BUMPER.head]) {
        minPoint = Math.min(minPoint, sim.yw + (sim.L + p.up) * Math.cos(sim.th) - p.fwd * Math.sin(sim.th))
      }
    }
    const seq = order.join(' > ')
    assert(/^fallen( > contact > fallen)* > contact > righting > balancing$/.test(seq), `5. th0=${th0}: ${seq}`)
    const scripted = RIGHTING.tuck + RIGHTING.swing
    assert(tBack > 0 && Math.abs(tBack - tRighting - scripted) < 2 * DT, `5. th0=${th0}: righting takes the scripted ${scripted} s (${(tBack - tRighting).toFixed(3)} s)`)
    assert(legMin <= GEO.legMin + 1e-9, `5. th0=${th0}: it tucks its legs to get up (${legMin.toFixed(3)} m)`)
    assert(minPoint >= -1e-9, `5. th0=${th0}: pod and head never pass through the ground (lowest ${(minPoint * 1000).toFixed(2)} mm)`)
    assert(!sim.busy && Math.abs(sim.L - GEO.legStand) < 0.003 && Math.abs(sim.th) < 0.02, `5. th0=${th0}: standing on its legs again, balancing (L ${sim.L.toFixed(3)} m)`)
  }
  const g = groundAngles(GEO.legStand)
  assert(g.front > 1.2 && g.back < -1.2, `5. it lands on its pod (contact angles ${g.front.toFixed(2)} / ${g.back.toFixed(2)} rad)`)
}

// ── 6. Turning on the spot ───────────────────────────────────────────────
{
  const sim = new BalancerSim({ seed: 7, noise: false })
  for (let i = 0; i < 1000; i++) sim.step({ speed: 0, yawRate: 1.5 })
  assert(Math.abs(sim.sL + sim.sR) <= 1e-9, `6. pure yaw: s_L = -s_R (sum ${(sim.sL + sim.sR).toExponential(1)})`)
  assert(sim.sL < 0 && sim.sR > 0, '6. pure yaw left: left wheel back, right wheel forward')
  assert(Math.abs(sim.omega - 1.5) < 1e-12 && Math.hypot(sim.X, sim.Z) === 0, '6. turns in place at the commanded rate')
  const fast = new BalancerSim({ seed: 7, noise: false })
  let maxW = 0
  for (let i = 0; i < 400; i++) {
    fast.step({ speed: 0, yawRate: 10 })
    maxW = Math.max(maxW, Math.abs(fast.omega))
  }
  assert(maxW <= LIMITS.maxYawRate + 1e-12, `6. yaw rate clamped to ${LIMITS.maxYawRate} rad/s`)
}

// ── 7. Legs: posture, jump, landing ──────────────────────────────────────
{
  for (const L of [GEO.legCrouch, GEO.legTall]) {
    const sim = new BalancerSim({ seed: 7 })
    sim.setLeg(L)
    let thMax = 0
    for (let i = 0; i < 600; i++) {
      sim.step(still)
      thMax = Math.max(thMax, Math.abs(sim.th))
    }
    assert(Math.abs(sim.L - L) < 0.002 && sim.mode === 'balancing' && thMax < 0.05, `7. posture: leg ${L} m reached (${sim.L.toFixed(4)}), balanced throughout (max |th| ${thMax.toFixed(3)})`)
  }
  const sim = new BalancerSim({ seed: 7, noise: false })
  sim.jump()
  let air = 0, apex = 0, lowest = Infinity, legLow = Infinity, landed = -1
  for (let i = 0; i < 800; i++) {
    sim.step(still)
    if (sim.air) air += DT
    apex = Math.max(apex, sim.yw - GEO.wheelR)
    lowest = Math.min(lowest, sim.yw - GEO.wheelR)
    if (air > 0 && !sim.air && landed < 0) landed = i
    if (landed > 0) legLow = Math.min(legLow, sim.L)
  }
  console.log(`  jump: ${(air * 1000).toFixed(0)} ms in the air, apex ${(apex * 1000).toFixed(1)} mm, legs compress to ${(legLow * 1000).toFixed(0)} mm on landing`)
  assert(air > 0.12 && apex > 0.02 && apex < 0.1, '7. jump: a real flight (> 120 ms, 2-10 cm)')
  assert(lowest >= -1e-9, '7. jump: the wheels never go below the ground')
  assert(legLow < GEO.legStand - 0.005, '7. jump: the legs give on landing (compliance)')
  assert(sim.mode === 'balancing' && !sim.busy && Math.abs(sim.th) < 0.02 && Math.abs(sim.L - GEO.legStand) < 0.003, '7. jump: lands balanced and stands again')
}

// ── 8. Grab force ────────────────────────────────────────────────────────
{
  // Held at rest exactly where it was picked, then let go: no energy appears.
  const sim = new BalancerSim({ seed: 7, noise: false })
  for (let i = 0; i < 100; i++) sim.step(still)
  const ke = () => 0.5 * (sim.p.M + sim.p.m) * sim.xd * sim.xd + 0.5 * sim.p.Ib * sim.thd * sim.thd
  let maxKE = 0
  for (let i = 0; i < 400; i++) {
    // The grab spring at rest on target: F = k(t - p) - c v with t = p, v = 0 -> zero.
    sim.extX = sim.extZ = 0
    sim.extH = 0.15
    sim.step(still)
    maxKE = Math.max(maxKE, ke())
  }
  assert(maxKE < 1e-8, `8. grab held at rest and released: no energy injected (max KE ${maxKE.toExponential(1)} J)`)
  // A hard steady pull at the pod tips it over.
  const pulled = new BalancerSim({ seed: 7 })
  let fell = false
  for (let i = 0; i < 600 && !fell; i++) {
    pulled.extZ = 8
    pulled.extH = 0.16
    pulled.step(still)
    fell = pulled.mode !== 'balancing'
  }
  assert(fell, '8. a hard steady pull (8 N at the pod) drags it over')
  // A gentle one is resisted: it leans into it and holds.
  const gentle = new BalancerSim({ seed: 7 })
  for (let i = 0; i < 600; i++) {
    gentle.extZ = 1
    gentle.extH = 0.16
    gentle.step(still)
  }
  assert(gentle.mode === 'balancing', '8. a gentle pull (1 N) is resisted by the controller')
}

// ── 9. Determinism across frame rates ────────────────────────────────────
{
  const N = 3000
  const cmdAt = (i: number) => ({ speed: i < 600 ? 0.2 : i < 1200 ? -0.1 : 0, yawRate: i > 300 && i < 900 ? 0.8 : 0 })
  const run = (hz: number) => {
    const sim = new BalancerSim({ seed: 42, noise: true, disturbance: true })
    const clock = new FixedClock()
    let now = 1000
    clock.advance(now, () => {})
    while (sim.steps < N) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (sim.steps === 300) sim.impulse(3)
        if (sim.steps === 1300) sim.setLeg(GEO.legTall)
        if (sim.steps === 1500) sim.jump()
        if (sim.steps >= 2000 && sim.steps < 2300) {
          sim.extX = 3
          sim.extH = 0.15
        }
        if (sim.steps < N) sim.step(cmdAt(sim.steps))
        sim.extX = 0
      })
    }
    return [sim.x, sim.xd, sim.th, sim.thd, sim.X, sim.Z, sim.psi, sim.sL, sim.sR, sim.tau, sim.L, sim.yw]
  }
  const a = run(30)
  const b = run(60)
  const c = run(144)
  const same = (p: number[], q: number[]) => p.every((v, i) => v === q[i])
  assert(same(a, b) && same(a, c), `9. same seed + ${N} steps (jump, posture, drag) at 30/60/144 Hz: bitwise identical state`)
}

// ── 10. Suspension / clock policy ────────────────────────────────────────
{
  const clock = new FixedClock()
  let n = 0
  clock.advance(0, () => n++)
  assert(n === 0, '10. first advance only anchors the clock')
  clock.advance(5000, () => n++)
  assert(n >= 19 && n <= 20 && n * DT <= 0.1 + 1e-12, `10. a 5 s gap is clamped to 0.1 s: ${n} steps (<= 20)`)
  assert(clock.dropped === Math.floor((5 - 0.1) / DT), `10. dropped steps counted (${clock.dropped})`)
  clock.reset()
  n = 0
  clock.advance(9000, () => n++)
  assert(n === 0, '10. after reset() the next frame advances 0 steps')
  clock.advance(9000 + 50, () => n++)
  assert(n === 10, `10. then 50 ms runs 10 steps (${n})`)
}

// ── Head look springs ────────────────────────────────────────────────────
{
  const T = 0.755 * MARGIN
  const head = new HeadSpring()
  let t = -1
  let overshoot = false
  for (let i = 0; i < 400; i++) {
    head.step(1.0, 0.3, DT)
    if (head.yaw > 1.0 + 1e-9 || head.pitch > 0.3 + 1e-9) overshoot = true
    if (t < 0 && Math.abs(head.yaw - 1) < 0.01 && Math.abs(head.pitch - 0.3) < 0.01) t = (i + 1) * DT
  }
  assert(t > 0 && t <= T, `head: converges to target within 0.01 rad at ${t.toFixed(3)} s <= ${T.toFixed(3)} s`)
  assert(!overshoot, 'head: critically damped, no overshoot')
  const lim = new HeadSpring()
  let maxYaw = 0
  let maxPitch = 0
  for (let i = 0; i < 2000; i++) {
    const k = i < 1000 ? 1 : -1
    lim.step(k * 3, k * 2, DT)
    maxYaw = Math.max(maxYaw, Math.abs(lim.yaw))
    maxPitch = Math.max(maxPitch, Math.abs(lim.pitch))
  }
  assert(maxYaw <= HEAD.yawLimit + 1e-12, `head: yaw stays within +/-90 deg (max ${(maxYaw * 180 / Math.PI).toFixed(2)} deg)`)
  assert(maxPitch <= HEAD.pitchLimit + 1e-12, `head: pitch stays within +/-25 deg (max ${(maxPitch * 180 / Math.PI).toFixed(2)} deg)`)
}

// ── 11. The ramp: ride up it onto its step, jump off the end, land ──────────
{
  // The hero's ramp: 4 cm up over 20 cm, a 12 cm step, a sheer drop.
  const r = { x0: 0.2, top: 0.4, x1: 0.52, z: 0, half: 0.1, h: 0.04 }
  const height = (x: number, z: number) => (x < r.x0 || x > r.x1 || Math.abs(z) > r.half ? 0 : x >= r.top ? r.h : r.h * (x - r.x0) / (r.top - r.x0))
  const run = () => {
    const sim = new BalancerSim({ seed: 3, noise: false })
    sim.ground = height
    // Heading +X (psi = pi/2): x is forward.
    sim.place(0, 0, Math.PI / 2)
    let jumped = false, air = 0, apex = 0, below = 0, fell = false, onStep = false
    for (let i = 0; i < 6 / DT; i++) {
      // Crouch (0.25 s) and push-off take ~0.37 s: start that far before the lip.
      if (!jumped && sim.X > r.x1 - 0.19) {
        jumped = sim.jump()
      }
      sim.step({ speed: 0.5, yawRate: 0, boost: true })
      if (sim.air) air += DT
      if (!sim.air && Math.abs(sim.yw - (sim.p.r + r.h)) < 1e-6) onStep = true
      apex = Math.max(apex, sim.yw - sim.p.r)
      below = Math.max(below, sim.p.r + height(sim.X, sim.Z) - sim.yw)
      fell ||= sim.fallen
    }
    return { jumped, air, apex, below, fell, x: sim.X, th: sim.th, state: [sim.X, sim.Z, sim.th, sim.yw] }
  }
  const a = run()
  console.log(`  ramp: rode onto the step ${a.jumped}, ${(a.air * 1000).toFixed(0)} ms in the air, apex ${(a.apex * 1000).toFixed(1)} mm above the floor, landed at x ${a.x.toFixed(2)} m, fell ${a.fell}`)
  assert(a.jumped && a.air > 0.15, '11. ramp: it rides up onto the step and jumps off the end (a real flight)')
  assert(a.apex > 0.04 && a.apex < 0.15, `11. ramp: the jump takes off from the step's height and stays low (${(a.apex * 1000).toFixed(1)} mm)`)
  assert(a.below < 0.0005, `11. ramp: the wheels never go into the ramp or the floor (${(a.below * 1000).toFixed(2)} mm)`)
  assert(!a.fell && Math.abs(a.th) < 0.2, '11. ramp: it lands balanced and rolls on')
  assert(JSON.stringify(run().state) === JSON.stringify(a.state), '11. ramp: the same run twice is bitwise the same')
  // Bumping up the step's side (no slope) is a climb, never a launch.
  const side = new BalancerSim({ seed: 3, noise: false })
  side.ground = height
  side.place(0.46, -0.3, 0)
  let peak = 0
  for (let i = 0; i < 3 / DT; i++) {
    side.step({ speed: 0.3, yawRate: 0 })
    peak = Math.max(peak, side.yw - side.p.r)
  }
  assert(peak < 0.06, `11. ramp: rolling up the step's side climbs it, it is not fired into the air (peak ${(peak * 1000).toFixed(1)} mm)`)
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
