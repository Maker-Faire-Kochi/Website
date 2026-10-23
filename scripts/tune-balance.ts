/**
 * Designs the wheel-legged balancer's scheduled LQR gains and checks them
 * against the committed table, then measures the scenarios the tests assert.
 *
 *   npx --yes tsx scripts/tune-balance.ts
 *
 * Exit code 0: the cross-check holds and GAIN_TABLE in
 * app/three/robots/balancer/dynamics.ts is exactly what the design gives (to
 * the 5 decimals committed). Exit code 1: either failed; on a table diff it
 * prints every entry that changed and the regenerated table, ready to paste
 * over GAIN_TABLE. Run it after changing the robot's mass, geometry, motor,
 * LEG_GRID or the TUNED weights; scripts/test-balance.ts (section 0) holds the
 * committed table to the same design.
 *
 * 1. Cross-check, independent of the design code:
 *    a. linearize(paramsFor(L)) against central finite differences of the
 *       nonlinear equations of motion the simulator itself integrates
 *       (BalancerSim's accel), at every LEG_GRID length;
 *    b. the exact-ZOH discretisation (lqr.ts: expm by scaling and squaring,
 *       degree-6 Pade) against a fine RK4 integration of the same linear
 *       system over one DT;
 *    c. the closed loop with each designed K is stable.
 * 2. The gain schedule: discrete LQR (lqr.ts: Riccati recursion) for the
 *    TUNED weights at each LEG_GRID length, compared entry by entry with
 *    the committed GAIN_TABLE. START_TUNING's gains are printed for the record.
 * 3. The test scenarios simulated with the committed gains at the standing
 *    leg length: settle times, peaks, stopping distance, impulse_fall. The
 *    thresholds in scripts/test-balance.ts are these numbers + 25%.
 */
import { DT } from '../app/three/core/clock'
import {
  BalancerSim, GAIN_TABLE, GROUND_ANGLE, IMPULSE_FALL, LEG_GRID, LIMITS, START_TUNING, TUNED, linearize, paramsFor,
} from '../app/three/robots/balancer/dynamics'
import { GEO } from '../app/three/robots/balancer/geometry'
import { discretize, dlqr, type Mat } from '../app/three/robots/balancer/lqr'

let bad = 0
const fmt = (K: readonly number[]) => `[${K.map(k => k.toFixed(5)).join(', ')}]`

// ── 1. Cross-check ───────────────────────────────────────────────────────
console.log('1. Cross-check')
/** The simulator's own nonlinear EOM, (xdd, thdd), at leg length L (private: reached through a cast). */
function simAccel(L: number) {
  const sim = new BalancerSim({ leg: L, noise: false }) as unknown as {
    accel(th: number, xd: number, thd: number, tau: number, tauD: number, fx: number, tx: number): [number, number]
  }
  return (s: readonly number[], u: number) => sim.accel(s[2]!, s[1]!, s[3]!, u, 0, 0, 0).slice() as [number, number]
}
let linErr = 0, zohErr = 0, rhoMax = 0
const RK_N = 2000
const designed: number[][] = []
for (const L of LEG_GRID) {
  const { A, B } = linearize(paramsFor(L))
  // a. Central differences about the upright equilibrium, column by column (the 5th is the torque).
  const acc = simAccel(L)
  const f = (s: readonly number[], u: number) => {
    const [xdd, thdd] = acc(s, u)
    return [s[1]!, xdd, s[3]!, thdd]
  }
  const h = 1e-6
  for (let j = 0; j < 5; j++) {
    const sp = [0, 0, 0, 0], sm = [0, 0, 0, 0]
    if (j < 4) {
      sp[j] = h
      sm[j] = -h
    }
    const fp = f(sp, j < 4 ? 0 : h), fm = f(sm, j < 4 ? 0 : -h)
    for (let i = 0; i < 4; i++) {
      const fd = (fp[i]! - fm[i]!) / (2 * h)
      const an = j < 4 ? A[i]![j]! : B[i]!
      linErr = Math.max(linErr, Math.abs(fd - an) / Math.max(1, Math.abs(an)))
    }
  }
  // b. ZOH against RK4 of the linear system (u held over DT), column by column.
  const { Ad, Bd } = discretize(A, B, DT)
  const lin = (s: number[], u: number) => A.map((row, i) => row.reduce((sum, a, k) => sum + a * s[k]!, 0) + B[i]! * u)
  const dt = DT / RK_N
  for (let j = 0; j < 5; j++) {
    let s = [0, 0, 0, 0]
    if (j < 4) s[j] = 1
    const u = j < 4 ? 0 : 1
    for (let n = 0; n < RK_N; n++) {
      const k1 = lin(s, u)
      const k2 = lin(s.map((v, i) => v + k1[i]! * dt / 2), u)
      const k3 = lin(s.map((v, i) => v + k2[i]! * dt / 2), u)
      const k4 = lin(s.map((v, i) => v + k3[i]! * dt), u)
      s = s.map((v, i) => v + dt / 6 * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!))
    }
    for (let i = 0; i < 4; i++) zohErr = Math.max(zohErr, Math.abs(s[i]! - (j < 4 ? Ad[i]![j]! : Bd[i]![0]!)))
  }
  // c. Design, then the closed loop's spectral radius by power iteration.
  const { K } = dlqr(Ad, Bd, TUNED.Q, TUNED.R)
  designed.push(K)
  const Acl: Mat = Ad.map((row, i) => row.map((v, k) => v - Bd[i]![0]! * K[k]!))
  let v = [1, 0.3, -0.2, 0.1], rho = 0
  for (let it = 0; it < 4000; it++) {
    v = Acl.map(row => row.reduce((sum, a, k) => sum + a * v[k]!, 0))
    rho = Math.hypot(...v)
    v = v.map(x => x / rho)
  }
  rhoMax = Math.max(rhoMax, rho)
}
const okLin = linErr < 1e-6, okZoh = zohErr < 1e-10, okRho = rhoMax < 1
console.log(`  a. linearize vs finite differences of the simulator's EOM: max rel err ${linErr.toExponential(2)}  ${okLin ? 'MATCH' : 'MISMATCH'}`)
console.log(`  b. exact ZOH vs RK4 (${RK_N} substeps) over DT: max |diff| ${zohErr.toExponential(2)}  ${okZoh ? 'MATCH' : 'MISMATCH'}`)
console.log(`  c. closed-loop spectral radius, worst over the grid: ${rhoMax.toFixed(6)} per step (time constant ~ ${(-DT / Math.log(rhoMax)).toFixed(3)} s)  ${okRho ? 'STABLE' : 'UNSTABLE'}`)
if (!okLin || !okZoh || !okRho) bad++

// ── 2. The gain schedule ─────────────────────────────────────────────────
console.log(`\n2. Gain schedule: TUNED Q=diag(${TUNED.Q}) R=${TUNED.R}, LEG_GRID [${LEG_GRID.join(', ')}] m`)
let diffs = 0
LEG_GRID.forEach((L, k) => {
  const have = GAIN_TABLE[k]
  const same = !!have && designed[k]!.every((v, i) => v.toFixed(5) === have[i]!.toFixed(5))
  if (!same) diffs++
  console.log(`  L ${L.toFixed(3)}: K = ${fmt(designed[k]!)}${same ? '  = committed' : `  committed ${have ? fmt(have) : '(missing)'}  <-- DIFF`}`)
})
if (GAIN_TABLE.length !== LEG_GRID.length) {
  diffs++
  console.log(`  GAIN_TABLE has ${GAIN_TABLE.length} rows for ${LEG_GRID.length} grid lengths  <-- DIFF`)
}
if (diffs) {
  bad++
  console.log('\n  Regenerated table (paste over GAIN_TABLE in app/three/robots/balancer/dynamics.ts):')
  console.log(`export const GAIN_TABLE: readonly Gains[] = [\n${designed.map(K => `  ${fmt(K)},`).join('\n')}\n]`)
}
else {
  console.log('  GAIN_TABLE is exactly the design.')
}
{
  const { A, B } = linearize(paramsFor(GEO.legStand))
  const { Ad, Bd } = discretize(A, B, DT)
  console.log(`  for the record, START_TUNING Q=diag(${START_TUNING.Q}) R=${START_TUNING.R} at L ${GEO.legStand}: K = ${fmt(dlqr(Ad, Bd, START_TUNING.Q, START_TUNING.R).K)}`)
}

// ── 3. Scenarios with the committed gains ────────────────────────────────
const STEPS_10S = Math.round(10 / DT)

/** Last time the predicate was false (+DT): the robot is inside the band from then to the end. */
function settleTime(trace: boolean[]) {
  let last = -1
  trace.forEach((ok, i) => {
    if (!ok) last = i
  })
  return (last + 2) * DT
}

function recovery(th0: number, noise: boolean) {
  const sim = new BalancerSim({ seed: 7, noise })
  sim.th = th0
  const band: boolean[] = []
  let tauPeak = 0
  let xMin = 0
  let xMax = 0
  for (let i = 0; i < STEPS_10S; i++) {
    sim.step({ speed: 0, yawRate: 0 })
    tauPeak = Math.max(tauPeak, Math.abs(sim.tau))
    xMin = Math.min(xMin, sim.x)
    xMax = Math.max(xMax, sim.x)
    band.push(Math.abs(sim.th) < 0.01 && Math.abs(sim.xd) < 0.02)
  }
  return { settle: settleTime(band), tauPeak, xMin, xMax, mode: sim.mode }
}

console.log(`\n3. Scenarios (committed gains, standing leg ${GEO.legStand} m):`)
for (const th0 of [0.15, -0.15]) {
  for (const noise of [false, true]) {
    const r = recovery(th0, noise)
    console.log(`  1. recovery th0=${th0} noise=${noise}: settled ${r.settle.toFixed(3)} s, |tau| peak ${r.tauPeak.toFixed(4)} N m, x [${r.xMin.toFixed(4)}, ${r.xMax.toFixed(4)}] m, mode ${r.mode}`)
  }
}

function drive() {
  const sim = new BalancerSim({ seed: 7, noise: true })
  let xMinBeforePositive = 0
  let positive = false
  let thPeak = 0
  let thMinDuringAccel = Infinity
  const band: boolean[] = []
  for (let i = 0; i < STEPS_10S; i++) {
    sim.step({ speed: 0.2, yawRate: 0 })
    if (sim.x > 0) positive = true
    if (!positive) xMinBeforePositive = Math.min(xMinBeforePositive, sim.x)
    thPeak = Math.max(thPeak, sim.th)
    const accelerating = sim.vRef < 0.2 - 1e-9
    if (accelerating && i * DT > 0.05) thMinDuringAccel = Math.min(thMinDuringAccel, sim.th)
    band.push(Math.abs(sim.xd - 0.2) < 0.02)
  }
  // Braking from steady 0.2 m/s.
  const x0 = sim.x
  let thMinBrake = 0
  let thMaxDuringDecel = -Infinity
  let stopBand: boolean[] = []
  let xMax = sim.x
  for (let i = 0; i < STEPS_10S; i++) {
    sim.step({ speed: 0, yawRate: 0 })
    thMinBrake = Math.min(thMinBrake, sim.th)
    if (sim.vRef > 1e-9 && i * DT > 0.05) thMaxDuringDecel = Math.max(thMaxDuringDecel, sim.th)
    xMax = Math.max(xMax, sim.x)
    stopBand.push(Math.abs(sim.xd) < 0.02)
  }
  return {
    xMinBeforePositive, thPeak, thMinDuringAccel, speedSettle: settleTime(band),
    thMinBrake, thMaxDuringDecel, stopDistance: xMax - x0, stopSettle: settleTime(stopBand),
  }
}
const d = drive()
console.log(`  2. step 0 -> 0.2 m/s: min x before positive ${(d.xMinBeforePositive * 1000).toFixed(2)} mm, peak th ${d.thPeak.toFixed(4)} rad, min th while accelerating (after 50 ms) ${d.thMinDuringAccel.toFixed(4)}, speed settled in band at ${d.speedSettle.toFixed(3)} s`)
console.log(`  3. brake 0.2 -> 0: min th ${d.thMinBrake.toFixed(4)} rad, max th while decelerating (after 50 ms) ${d.thMaxDuringDecel.toFixed(4)}, stopping distance ${(d.stopDistance * 1000).toFixed(1)} mm, stopped (|xd|<0.02) at ${d.stopSettle.toFixed(3)} s`)

/** Does a pitch-rate impulse from rest (noise off) make it fall? */
function falls(imp: number) {
  const sim = new BalancerSim({ seed: 7, noise: false })
  sim.impulse(imp)
  for (let i = 0; i < 600; i++) {
    sim.step({ speed: 0, yawRate: 0 })
    if (sim.mode !== 'balancing') return true
  }
  return false
}
let lo = 0
let hi = 20
for (let i = 0; i < 60; i++) {
  const mid = (lo + hi) / 2
  if (falls(mid)) hi = mid
  else lo = mid
}
const impulseFall = hi
let loN = 0
let hiN = 20
for (let i = 0; i < 60; i++) {
  const mid = (loN + hiN) / 2
  if (falls(-mid)) hiN = mid
  else loN = mid
}
console.log(`  4. impulse_fall = ${impulseFall.toFixed(5)} rad/s forward, ${hiN.toFixed(5)} rad/s backward (committed IMPULSE_FALL ${IMPULSE_FALL})`)
for (const k of [0.4, 0.5]) {
  const sim = new BalancerSim({ seed: 7, noise: true })
  sim.impulse(-k * impulseFall)
  const band: boolean[] = []
  let thPeak = 0
  let xPeak = 0
  for (let i = 0; i < STEPS_10S; i++) {
    sim.step({ speed: 0, yawRate: 0 })
    thPeak = Math.max(thPeak, Math.abs(sim.th))
    xPeak = Math.max(xPeak, Math.abs(sim.x))
    band.push(Math.abs(sim.th) < 0.01 && Math.abs(sim.xd) < 0.02)
  }
  console.log(`     ${k} * impulse_fall (backward): peak |th| ${thPeak.toFixed(4)}, peak |x| ${(xPeak * 1000).toFixed(0)} mm, settled ${settleTime(band).toFixed(3)} s, mode ${sim.mode}`)
}

function fallCycle(th0: number) {
  const sim = new BalancerSim({ seed: 7, noise: true })
  sim.th = th0
  let tFallen = -1
  let tContact = -1
  let tRighting = -1
  let tBalancing = -1
  let tStowed = -1
  let thMin = Infinity
  let thMax = -Infinity
  const band: boolean[] = []
  for (let i = 0; i < STEPS_10S; i++) {
    sim.step({ speed: 0, yawRate: 0 })
    const t = (i + 1) * DT
    if (sim.mode === 'fallen' && tFallen < 0) tFallen = t
    if (sim.contact && tContact < 0) tContact = t
    if (sim.mode === 'righting' && tRighting < 0) tRighting = t
    if (tRighting > 0 && sim.mode === 'balancing' && tBalancing < 0) tBalancing = t
    if (tBalancing > 0 && !sim.busy && tStowed < 0) tStowed = t
    thMin = Math.min(thMin, sim.th)
    thMax = Math.max(thMax, sim.th)
    band.push(sim.mode === 'balancing' && Math.abs(sim.th) < 0.01 && Math.abs(sim.xd) < 0.02)
  }
  return { tFallen, tContact, tRighting, tBalancing, tStowed, settle: settleTime(band), thMin, thMax, mode: sim.mode }
}
for (const th0 of [0.5, -0.5]) {
  const f = fallCycle(th0)
  console.log(`  5. fall from th0=${th0}: fallen ${f.tFallen.toFixed(3)} s, contact ${f.tContact.toFixed(3)} s, righting ${f.tRighting.toFixed(3)} s, balancing ${f.tBalancing.toFixed(3)} s, kickstand stowed ${f.tStowed.toFixed(3)} s, settled ${f.settle.toFixed(3)} s; th range [${f.thMin.toFixed(3)}, ${f.thMax.toFixed(3)}]`)
}
console.log(`     ground angles: front ${GROUND_ANGLE.front.toFixed(4)} rad, back ${GROUND_ANGLE.back.toFixed(4)} rad; fallAngle ${LIMITS.fallAngle}`)

// Shove (1.2 * impulse_fall, backward, the UI's hard push) through the full cycle.
{
  const sim = new BalancerSim({ seed: 7, noise: true })
  sim.impulse(-1.2 * impulseFall)
  let tBal = -1
  let seen = false
  for (let i = 0; i < STEPS_10S; i++) {
    sim.step({ speed: 0, yawRate: 0 })
    if (sim.mode !== 'balancing') seen = true
    if (seen && sim.mode === 'balancing' && tBal < 0) tBal = (i + 1) * DT
  }
  console.log(`     shove 1.2 * impulse_fall backward: fell ${seen}, back to balancing at ${tBal.toFixed(3)} s, final mode ${sim.mode}`)
}

if (bad) {
  console.log('\nFAILED: see above.')
  process.exit(1)
}
console.log('\nOK: the cross-check holds and GAIN_TABLE is the design.')
