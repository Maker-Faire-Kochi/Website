import { DT, FixedClock } from '../app/three/core/clock'
import { dimsFor } from '../app/three/people/body'
import { PersonMotion } from '../app/three/people/motion'
import { dist, JOINTS, PER_SESSION, REACH, SEAT, type V3 } from '../app/three/scenes/electronics/bench-layout'
import {
  BEV, BSNAP, contactPose, evalSession, HOME, ironHome, JOBS, newSessionState, planLength, sessionPlan,
  WorkbenchSim, type Job,
} from '../app/three/scenes/electronics/bench-sim'
import { ironGrip, OperatorDriver, solderGrip } from '../app/three/scenes/electronics/operator'
import {
  ARRIVE, clampProgress, framingAt, newFraming, SHOT_MAX, ShotFollower, SHOTS, type Framing,
} from '../app/three/scenes/electronics/shots'
import {
  BEEPS, BOOT, BOOT_CHASE, COUNTER_STEP, ElectronicsSim, EV, LED_COUNT, PATTERNS, pressDepth, SERVO, SNAP, SWEEP,
  trackAngle,
} from '../app/three/scenes/electronics/sim'

/**
 * Pure-logic checks for the electronics workbench (Domains, Electronics &
 * IoT): the boot timeline, the LEDs following it, the servo's eased and
 * bounded motion, pointer tracking, the button's patterns, the idle flicker;
 * then the bench: the soldering timeline (deterministic, eased, the iron
 * always in its holder or within the seated operator's reach), the tool-job
 * queue (never two jobs at once), the scroll shots (continuous, monotone
 * zoom, no overshoot, one action per arrival), and determinism across frame
 * rates. Run: npx --yes tsx scripts/test-electronics.ts
 */

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

const A_STEP = SERVO.accel * DT + 1e-9
const EPS = 1e-9

/** One boot from a fresh sim; records everything the boot drives, per step. */
function bootTrace(seed: number) {
  const sim = new ElectronicsSim(seed)
  sim.boot()
  const rows: string[] = []
  const ev: number[] = []
  let steps = 0
  while (sim.booting && steps < 30 / DT) {
    const bt = sim.bootT
    sim.step(DT)
    steps++
    const e = sim.takeEvents()
    ev.push(e)
    // The activity LED is part of the boot only inside its burst window.
    const act = bt + DT >= BOOT.reset && bt + DT < BOOT.actEnd ? +sim.act : '-'
    rows.push([+sim.power, act, sim.leds.map(Number).join(''), sim.angle.toFixed(9), +sim.buzzer, +sim.booted].join(' '))
  }
  return { sim, rows, ev, steps }
}

// ── 1. The boot timeline is deterministic and independent of the seed ────
{
  const a = bootTrace(1)
  const b = bootTrace(2)
  const c = bootTrace(99)
  assert(a.steps === b.steps && b.steps === c.steps, `boot takes the same number of steps for every seed (${a.steps})`)
  assert(a.rows.join('\n') === b.rows.join('\n') && b.rows.join('\n') === c.rows.join('\n'), 'power, burst, LEDs, servo angle and buzzer trace identically for seeds 1, 2, 99')
  const secs = a.steps * DT
  assert(secs > 4 && secs < 9, `boot completes in a few seconds (${secs.toFixed(2)} s)`)
  assert(a.sim.booted && !a.sim.booting, 'the sim is booted afterwards')
  const a2 = bootTrace(1)
  assert(a2.rows.join('\n') === a.rows.join('\n'), 'same seed replays the same boot')
}

// ── 2. The LEDs and buzzer follow the sequence ───────────────────────────
{
  const sim = new ElectronicsSim(3)
  // Idle for a while first so the boot interrupts a running board.
  for (let i = 0; i < 3 / DT; i++) sim.step(DT)
  sim.takeEvents()
  sim.boot()
  let powerOffOk = true
  let chaseOk = true
  let offOk = true
  let chimes = 0
  let beeps = 0
  let clicks = 0
  let maxA = -Infinity
  let minA = Infinity
  const visits: number[] = []
  let burstOn = 0
  let burstN = 0
  while (sim.booting) {
    sim.step(DT)
    const t = sim.bootT
    const e = sim.takeEvents()
    if (e & EV.CHIME) chimes++
    if (e & EV.BEEP) beeps++
    if (e & (EV.CLICK_DOWN | EV.CLICK_UP)) clicks++
    if (t < 0) break
    if (t < BOOT.reset - 1e-9) {
      if (sim.power || sim.act || sim.leds.some(Boolean)) powerOffOk = false
    }
    else if (t > BOOT.reset + 1e-9 && t < BOOT.actEnd) {
      burstN++
      burstOn += +sim.act
    }
    const k = Math.floor((t - BOOT.chase) / BOOT.chaseStep)
    if (t >= BOOT.chase + 1e-9 && k < BOOT_CHASE.length && Math.abs(t - BOOT.chase - k * BOOT.chaseStep) > 1e-6) {
      const lit = sim.leds.map((l, i) => (l ? i : -1)).filter(i => i >= 0)
      if (lit.length !== 1 || lit[0] !== BOOT_CHASE[k]) chaseOk = false
    }
    if ((t < BOOT.chase - 1e-9 || t > BOOT.chase + BOOT_CHASE.length * BOOT.chaseStep + 1e-6) && sim.leds.some(Boolean)) offOk = false
    maxA = Math.max(maxA, sim.angle)
    minA = Math.min(minA, sim.angle)
    if (sim.vel === 0 && SWEEP.includes(sim.angle) && visits[visits.length - 1] !== sim.angle && t > BOOT.sweep) visits.push(sim.angle)
  }
  assert(powerOffOk, 'during the reset the power LED, activity LED and LEDs are all dark')
  assert(chimes === 1, `the boot chime sounds once, at power-on (${chimes})`)
  assert(burstN > 0 && burstOn / burstN > 0.4 && burstOn / burstN < 0.9, `the activity LED bursts densely while the OS loads (${(burstOn / burstN * 100).toFixed(0)}% on)`)
  assert(chaseOk, `the LED chase lights exactly one LED at a time in the order ${BOOT_CHASE.join('')}`)
  assert(offOk, 'the LEDs are dark outside the chase window during boot')
  assert(minA === 0 && maxA === 180, `the servo sweeps the full 0..180 (${minA}..${maxA})`)
  assert(visits.join(',') === SWEEP.join(','), `the sweep stops at 0, then 180, then 90 (${visits.join(',')})`)
  assert(beeps === BEEPS.length, `the buzzer chirps ${BEEPS.length} beeps after the sweep (${beeps})`)
  assert(clicks === 0, 'no button clicks without a press')
  assert(sim.booted && sim.power && sim.angle === 90, 'the board ends booted, powered, servo at 90')
  assert(sim.boot() === 'started' && sim.boot() === 'busy', 'a boot already running is not restarted')
  assert(sim.sweep() === 'busy', 'a servo tap while booting is refused (the boot is sweeping it)')
}

// ── 3. Servo: always within 0..180, eased, never a velocity jump ─────────
{
  const sim = new ElectronicsSim(4)
  let inRange = true
  let maxDv = 0
  let maxV = 0
  let maxDa = 0
  let worst = ''
  let prevV = sim.vel
  let prevA = sim.angle
  // A hostile script: boot, then random pointer targets (some far outside
  // the travel), sweeps mid-motion, pauses, all at arbitrary steps.
  const script = new Map<number, () => void>([[10, () => sim.boot()]])
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
  for (let s = 2000; s < 200 * 90; s += 37 + Math.floor(rnd() * 400)) {
    const r = rnd()
    if (r < 0.6) script.set(s, () => sim.setTrack(-200 + rnd() * 600))
    else if (r < 0.75) script.set(s, () => sim.sweep())
    else if (r < 0.85) script.set(s, () => sim.clearInputs())
    else if (r < 0.95) script.set(s, () => sim.setTrack(trackAngle((rnd() - 0.5) * 8, 0.6)))
    else script.set(s, () => sim.setTrack(null))
  }
  for (let i = 0; i < 200 * 90; i++) {
    script.get(i)?.()
    sim.step(DT)
    if (!(sim.angle >= 0 && sim.angle <= 180)) inRange = false
    const dv = Math.abs(sim.vel - prevV)
    if (dv > maxDv) {
      maxDv = dv
      worst = `step ${i}: v ${prevV.toFixed(3)} -> ${sim.vel.toFixed(3)}`
    }
    maxV = Math.max(maxV, Math.abs(sim.vel))
    maxDa = Math.max(maxDa, Math.abs(sim.angle - prevA))
    prevV = sim.vel
    prevA = sim.angle
  }
  assert(inRange, 'the servo angle never leaves 0..180')
  assert(maxDv <= A_STEP, `velocity changes by at most accel * DT per step: eased starts and stops (max ${maxDv.toFixed(4)} <= ${(A_STEP).toFixed(4)}; ${worst})`)
  assert(maxV <= SERVO.vmax + EPS, `speed never exceeds ${SERVO.vmax} deg/s (${maxV.toFixed(2)})`)
  assert(maxDa <= SERVO.vmax * DT + 0.05 + EPS, `position moves continuously (max ${maxDa.toFixed(4)} deg per step)`)
  let settled = true
  for (const goal of [0, 37.3, 90, 151.9, 180]) {
    sim.setTrack(goal)
    for (let i = 0; i < 200 * 2; i++) sim.step(DT)
    if (sim.angle !== goal || sim.vel !== 0) settled = false
  }
  assert(settled, 'after any history the servo settles exactly on a held target (no chatter)')

  // A sweep from rest starts at zero speed and comes to rest at each stop.
  const s2 = new ElectronicsSim(4)
  s2.sweep()
  const v: number[] = []
  for (let i = 0; i < 200 * 6 && (s2.sweeping || v.length < 2); i++) {
    s2.step(DT)
    v.push(s2.vel)
  }
  assert(Math.abs(v[0]!) <= A_STEP, `the sweep starts from rest (first step speed ${Math.abs(v[0]!).toFixed(3)})`)
  assert(!s2.sweeping && s2.vel === 0 && s2.angle === 90, 'the sweep ends at rest on 90')
  const peak = Math.max(...v.map(Math.abs))
  assert(peak > SERVO.vmax * 0.9, `the long legs of the sweep reach cruising speed (${peak.toFixed(1)} deg/s)`)
}

// ── 4. Pointer tracking clamps and only applies once booted ──────────────
{
  let clamped = true
  let monotone = true
  let continuous = true
  for (const servoX of [-3, -0.9, -0.2, 0, 0.35, 0.62, 0.9, 3, NaN]) {
    let last = Infinity
    for (let x = -10; x <= 10; x += 0.005) {
      const a = trackAngle(x, servoX)
      if (!(a >= 0 && a <= 180)) clamped = false
      if (a > last + EPS) monotone = false
      // Steepest legal slope: 90 deg over the 0.1 NDC left beside a servo clamped at 0.9.
      if (last !== Infinity && Math.abs(a - last) > 90 * 0.005 / 0.1 + 1e-9) continuous = false
      last = a
    }
    const sx = Number.isFinite(servoX) ? Math.min(0.9, Math.max(-0.9, servoX)) : 0
    if (Math.abs(trackAngle(sx - 1e-7, servoX) - trackAngle(sx + 1e-7, servoX)) > 1e-3) continuous = false
    for (const bad of [NaN, Infinity, -Infinity]) {
      const a = trackAngle(bad, servoX)
      if (!(a >= 0 && a <= 180)) clamped = false
    }
  }
  assert(clamped, 'trackAngle stays within 0..180 for any pointer and servo position, including NaN and Infinity')
  assert(monotone, 'trackAngle turns the arm toward the pointer side (monotone in pointer x)')
  assert(continuous, 'trackAngle has no jumps as the pointer crosses the servo')
  assert(trackAngle(0.62, 0.62) === 90 && trackAngle(-1, 0.62) === 180 && trackAngle(1, 0.62) === 0,
    'level with the servo = 90, slot left edge = 180, slot right edge = 0')
  assert(trackAngle(-7, 0.62) === 180 && trackAngle(7, 0.62) === 0, 'a pointer beyond the slot clamps to the end stops')

  const sim = new ElectronicsSim(5)
  sim.setTrack(0)
  for (let i = 0; i < 200 * 2; i++) sim.step(DT)
  assert(sim.angle === 90, 'before boot the servo ignores the pointer and holds 90')
  sim.boot()
  while (sim.booting) sim.step(DT)
  sim.setTrack(1e6)
  assert(sim.track === 180, 'setTrack clamps an out-of-range target to 180')
  for (let i = 0; i < 200 * 2; i++) sim.step(DT)
  assert(sim.angle === 180 && sim.vel === 0, 'booted, the servo follows the pointer and settles exactly at the end stop')
  sim.setTrack(-1e6)
  for (let i = 0; i < 200 * 2; i++) sim.step(DT)
  assert(sim.angle === 0, 'and at the other end stop')
  sim.setTrack(null)
  const held = sim.angle
  for (let i = 0; i < 200; i++) sim.step(DT)
  assert(sim.angle === held, 'pointer gone: the servo holds its angle')
}

// ── 5. Button: eased travel, clicks, and the pattern cycles ──────────────
{
  const sim = new ElectronicsSim(6)
  sim.boot()
  while (sim.booting) sim.step(DT)
  sim.takeEvents()
  const seen: string[] = [sim.pattern]
  let maxJump = 0
  let depthMax = 0
  let ev = 0
  for (let p = 0; p < PATTERNS.length; p++) {
    seen.push(sim.press())
    let prev = 0
    for (let i = 0; i < 200 * 0.5; i++) {
      sim.step(DT)
      ev |= sim.takeEvents()
      const d = sim.snapshot(new Float64Array(SNAP.size))[SNAP.press]!
      maxJump = Math.max(maxJump, Math.abs(d - prev))
      depthMax = Math.max(depthMax, d)
      prev = d
    }
    assert(prev === 0, `the button returns fully after press ${p + 1}`)
  }
  assert(seen.join(',') === 'idle,counter,bounce,idle', `presses cycle the LED pattern (${seen.join(',')})`)
  assert(depthMax === 1 && maxJump < 0.2, `the press travels fully and smoothly (max jump ${maxJump.toFixed(3)} per step)`)
  assert((ev & EV.CLICK_DOWN) !== 0 && (ev & EV.CLICK_UP) !== 0, 'a press raises the down and release clicks')
  assert(pressDepth(-1) === 0 && pressDepth(10) === 0, 'no travel before or long after a press')

  // Counter pattern shows the count in binary, MSB on the left LED.
  sim.press()
  let binOk = true
  for (let i = 0; i < 200 * 6; i++) {
    sim.step(DT)
    const t = (i + 1) * DT
    if (Math.abs(t / COUNTER_STEP - Math.round(t / COUNTER_STEP)) < 1e-6) continue
    const v = Math.floor(t / COUNTER_STEP) % 16
    const want = Array.from({ length: LED_COUNT }, (_, k) => ((v >> (LED_COUNT - 1 - k)) & 1) === 1)
    if (want.some((w, k) => w !== sim.leds[k])) binOk = false
  }
  assert(sim.pattern === 'counter' && binOk, 'the counter pattern shows 0..15 in binary on the four LEDs')
}

// ── 6. Idle: card-reader flicker and an occasional chase ─────────────────
{
  const sim = new ElectronicsSim(7)
  let on = 0
  let toggles = 0
  let last = sim.act
  let longestGap = 0
  let gap = 0
  let chases = 0
  let lit = false
  let multi = false
  let powerOk = true
  const N = 200 * 60
  for (let i = 0; i < N; i++) {
    sim.step(DT)
    on += +sim.act
    if (sim.act !== last) toggles++
    last = sim.act
    gap = sim.act ? 0 : gap + DT
    longestGap = Math.max(longestGap, gap)
    const n = sim.leds.filter(Boolean).length
    if (n > 1) multi = true
    if (n > 0 && !lit) chases += sim.leds[0] ? 1 : 0
    lit = n > 0
    if (!sim.power) powerOk = false
  }
  assert(powerOk, 'idle: the board stays powered')
  assert(toggles > 60 && on / N > 0.02 && on / N < 0.4, `idle: the activity LED flickers irregularly (${toggles / 2 | 0} blinks/min, ${(on / N * 100).toFixed(1)}% on)`)
  assert(longestGap > 1, `idle: the flicker has quiet gaps between bursts (longest ${longestGap.toFixed(2)} s)`)
  assert(chases >= 3 && chases <= 12, `idle: an LED chase runs now and then (${chases} in 60 s)`)
  assert(!multi, 'idle: a chase lights one LED at a time')
  assert(sim.angle === 90 && sim.vel === 0, 'idle: the servo rests')
}

// ── 7. Determinism across frame rates ────────────────────────────────────
{
  const N = 200 * 30
  const inputs = (sim: ElectronicsSim, step: number) => {
    if (step === 200) sim.boot()
    if (step === 1900) sim.press()
    if (step === 2600) sim.setTrack(trackAngle(-0.7, 0.6))
    if (step === 3100) sim.chirp()
    if (step === 3500) sim.setTrack(trackAngle(0.9, 0.6))
    if (step === 4200) sim.sweep()
    if (step === 5000) sim.clearInputs()
  }
  const state = (sim: ElectronicsSim) => [
    ...sim.snapshot(new Float64Array(SNAP.size)),
    sim.vel, sim.target, sim.t, sim.patternIndex, +sim.booted, +sim.act, ...sim.leds.map(Number),
  ]
  const run = (seed: number, hz: number) => {
    const sim = new ElectronicsSim(seed)
    const clock = new FixedClock()
    const out = new Float64Array(SNAP.size)
    let steps = 0
    let now = 0
    clock.advance(now, () => {})
    while (steps < N) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (steps < N) {
          inputs(sim, steps)
          sim.step(DT)
          steps++
        }
      })
      sim.snapshot(out)
      sim.takeEvents()
    }
    return { steps, s: state(sim) }
  }
  const a = run(9, 30)
  const b = run(9, 60)
  const c = run(9, 144)
  assert(a.steps === N && b.steps === N && c.steps === N, `all three runs reach ${N} steps`)
  const same = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]))
  assert(same(a.s, b.s) && same(b.s, c.s), 'same seed + same inputs = bit-identical state at 30, 60 and 144 Hz')
  const d = run(10, 60)
  assert(!same(d.s, b.s), 'a different seed changes the idle flicker (the seed is actually used)')
}

// ── 8. A manual LED chase leaves the seeded idle untouched ───────────────
{
  const a = new ElectronicsSim(7)
  const b = new ElectronicsSim(7)
  a.step(DT)
  b.step(DT)
  assert(b.chase() === 'started' && b.chase() === 'busy', 'chase() starts once and refuses while running')
  const lit: number[] = []
  for (let i = 0; i < 200 * 2; i++) {
    a.step(DT)
    b.step(DT)
    const on = b.leds.map((l, k) => (l ? k : -1)).filter(k => k >= 0)
    if (on.length === 1 && lit[lit.length - 1] !== on[0]) lit.push(on[0]!)
  }
  assert(lit.join('') === BOOT_CHASE.join(''), `the chase runs ${BOOT_CHASE.join('')} across the LEDs (${lit.join('')})`)
  assert(!b.chasing, 'and ends by itself')
  for (let i = 0; i < 200 * 30; i++) {
    a.step(DT)
    b.step(DT)
  }
  assert(a.act === b.act && a.leds.join() === b.leds.join() && a.t === b.t, 'a chase does not shift the seeded idle flicker or chases')
}

// ── 9. Soldering timeline: deterministic, contiguous, eased, home to home ─
{
  const plan = sessionPlan([0, 1, 2])
  let contiguous = plan[0]!.t0 === 0
  for (let i = 1; i < plan.length; i++) if (Math.abs(plan[i]!.t0 - plan[i - 1]!.t1) > 1e-12) contiguous = false
  assert(contiguous, `session phases are contiguous (${plan.map(p => p.name).join(' > ')})`)
  const dwells = plan.filter(p => p.name === 'dwell').map(p => p.joint)
  assert(dwells.join() === '0,1,2', 'a session dwells once on each of its joints, in order')

  const trace = (seed: number) => {
    const sim = new WorkbenchSim(seed)
    sim.request('solder')
    const rows: string[] = []
    let sizzles = 0
    let contactOutsideDwell = false
    let maxStep = 0
    let maxDv = 0
    let lastV = 0
    let prev = [...sim.session.iron.tip] as V3
    let n = 0
    while (n < 200 * 30 && (sim.job === 'solder' || n === 0)) {
      sim.step(DT)
      n++
      const s = sim.session
      if (sim.takeEvents() & BEV.SIZZLE) sizzles++
      if (s.contact && s.phase !== 'dwell') contactOutsideDwell = true
      const d = dist(prev, s.iron.tip)
      maxStep = Math.max(maxStep, d)
      maxDv = Math.max(maxDv, Math.abs(d / DT - lastV))
      lastV = d / DT
      prev = [...s.iron.tip] as V3
      rows.push(`${s.phase} ${s.iron.tip.map(x => x.toFixed(9)).join(',')} ${s.solder.tip.map(x => x.toFixed(9)).join(',')} ${s.grip.toFixed(9)}`)
    }
    return { rows, sizzles, contactOutsideDwell, maxStep, maxDv, n, sim }
  }
  const a = trace(1)
  const b = trace(1)
  const c = trace(42)
  assert(a.rows.join('\n') === b.rows.join('\n'), 'same seed replays the same session step for step')
  assert(a.rows.join('\n') === c.rows.join('\n'), 'a requested session is identical for every seed (the timeline draws no randomness)')
  const secs = a.n * DT
  assert(Math.abs(secs - planLength(plan)) < 0.01, `the session lasts its plan (${secs.toFixed(2)} s)`)
  assert(a.sizzles === PER_SESSION, `one sizzle per joint (${a.sizzles})`)
  assert(!a.contactOutsideDwell, 'the tip touches a joint only while dwelling')
  assert(ironHome(a.sim.session) && a.sim.session.grip === 0, 'the iron ends back in its holder and the hand back at rest')
  assert(a.maxStep / DT < 1.2, `the iron moves at hand speed (peak ${(a.maxStep / DT).toFixed(2)} m/s)`)
  assert(a.maxDv < 0.2, `the iron never jerks: speed changes by at most ${a.maxDv.toFixed(3)} m/s per step`)
  let filletsOk = true
  for (let k = 0; k < JOINTS; k++) if ((k < PER_SESSION) !== (a.sim.fillet[k]! > 0.99)) filletsOk = false
  assert(filletsOk && a.sim.done === PER_SESSION, `the joints soldered get their fillets and only those (${Array.from(a.sim.fillet).map(f => f.toFixed(1)).join(' ')})`)

  // Each phase starts and ends at rest (s5 easing): zero speed at every boundary.
  const st = newSessionState()
  let boundaryOk = true
  for (const p of plan) {
    for (const t of [p.t0 + 1e-6, p.t1 - 1e-6]) {
      const x0 = [...evalSession(plan, t - 1e-5, st).iron.tip]
      const x1 = [...evalSession(plan, t + 1e-5, st).iron.tip]
      if (p.name !== 'dwell' && dist(x0 as V3, x1 as V3) / 2e-5 > 0.02) boundaryOk = false
    }
  }
  assert(boundaryOk, 'every phase of the iron starts and stops at rest')
  const ct = evalSession(plan, plan.find(p => p.name === 'dwell')!.t0 + 0.5, st).iron.tip
  assert(dist(ct, contactPose(0).tip) < 0.0006, 'while dwelling the tip stays on its pad (within half a millimetre)')

  // A second request while soldering waits; with all joints done, a fresh board goes in.
  const sim = new WorkbenchSim(3)
  sim.request('solder')
  assert(sim.request('solder') === 'busy', 'asking to solder while soldering changes nothing')
  let sessions = 1
  let sawFresh = false
  for (let i = 0; i < 200 * 120; i++) {
    const before = sim.job
    sim.step(DT)
    if (sim.job === 'solder' && before !== 'solder') {
      sessions++
      if (sim.done === 0 && sim.fillet.every(f => f === 0)) sawFresh = true
    }
  }
  assert(sessions >= 4 && sawFresh, `idle sessions keep coming and a fresh board goes in after all ${JOINTS} joints (${sessions} sessions)`)
}

// ── 10. The iron is always in its holder or within the operator's reach ──
{
  const sim = new WorkbenchSim(5)
  let inReach = true
  let leftReach = true
  let worst = 0
  let worstL = 0
  let handJump = 0
  let prevR = ironGrip(sim.session).position.slice() as V3
  let prevL = solderGrip(sim.session).position.slice() as V3
  let homeSteps = 0
  let outSteps = 0
  let seed = 99
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
  for (let i = 0; i < 200 * 240; i++) {
    if (i % 997 === 0) sim.request(JOBS[Math.floor(rnd() * JOBS.length)]!)
    sim.step(DT)
    const s = sim.session
    const r = ironGrip(s)
    const l = solderGrip(s)
    if (ironHome(s)) homeSteps++
    else {
      outSteps++
      const d = dist(r.position, REACH.right)
      worst = Math.max(worst, d)
      if (d > REACH.r) inReach = false
    }
    const dl = dist(l.position, REACH.left)
    worstL = Math.max(worstL, dl)
    if (dl > REACH.r) leftReach = false
    handJump = Math.max(handJump, dist(r.position, prevR), dist(l.position, prevL))
    prevR = r.position.slice() as V3
    prevL = l.position.slice() as V3
  }
  assert(homeSteps > 0 && outSteps > 0, `over four minutes the iron spends time both in the holder and in the hand (${(homeSteps * DT).toFixed(0)} s / ${(outSteps * DT).toFixed(0)} s)`)
  assert(inReach, `out of its holder, the iron's grip is always within ${REACH.r} m of the right shoulder (worst ${worst.toFixed(3)} m)`)
  assert(leftReach, `the solder pinch is always within reach of the left shoulder (worst ${worstL.toFixed(3)} m)`)
  assert(handJump < 1.2 * DT, `the hand targets move continuously (largest step ${(handJump * 1000).toFixed(2)} mm)`)
  const rest = ironGrip(newSessionState())
  assert(dist(rest.position, REACH.right) < REACH.r, 'the right hand rests within reach')
  assert(HOME.tip.every((v, i) => v === sim.session.iron.tip[i]) || !ironHome(sim.session), 'ironHome agrees with the holder pose')
}

// ── 11. Tool jobs queue and never overlap ─────────────────────────────────
{
  const sim = new WorkbenchSim(8)
  const started: Job[] = []
  let overlap = false
  let quietOk = true
  let dupes = false
  let seed = 4242
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
  const asked: Job[] = []
  for (let i = 0; i < 200 * 300; i++) {
    const before = sim.job
    if (rnd() < 0.002) {
      const j = JOBS[Math.floor(rnd() * JOBS.length)]!
      if (sim.request(j) !== 'busy') asked.push(j)
    }
    sim.step(DT)
    if (sim.job && sim.job !== before) started.push(sim.job)
    // Only the running job's machine may move.
    const active = [sim.job === 'solder' || !ironHome(sim.session), sim.drill > 0 || sim.drillSpin > 0, sim.saw > 0 || sim.sawSpin > 0, sim.knob > 0]
    if (active.filter(Boolean).length > 1) overlap = true
    if (sim.job !== 'drill' && (sim.drill !== 0 || sim.drillSpin !== 0)) quietOk = false
    if (sim.job !== 'saw' && (sim.saw !== 0 || sim.sawSpin !== 0)) quietOk = false
    if (new Set(sim.queue).size !== sim.queue.length || sim.queue.includes(sim.job!)) dupes = true
  }
  const manual = started.filter(j => j !== 'solder')
  const askedManual = asked.filter(j => j !== 'solder')
  assert(!overlap, `never two tools at once (${started.length} jobs ran)`)
  assert(quietOk, 'the drill press and saw are still unless their job is running')
  assert(!dupes, 'the queue never holds a job twice, nor the one running')
  assert(manual.length >= askedManual.length - 3 && askedManual.length > 5, `every requested drill, saw and measure runs (${manual.length} of ${askedManual.length}; the last few may still wait)`)

  const q = new WorkbenchSim(2)
  assert(q.request('drill') === 'started', 'a job on a free bench starts at once')
  assert(q.request('saw') === 'queued' && q.request('measure') === 'queued', 'others queue behind it')
  assert(q.request('saw') === 'busy', 'asking again for a queued job changes nothing')
  const order: Job[] = ['drill']
  let cuts = 0
  let beeps = 0
  for (let i = 0; i < 200 * 12; i++) {
    const before = q.job
    q.step(DT)
    const e = q.takeEvents()
    if (e & BEV.CUT) cuts++
    if (e & BEV.METER) beeps++
    if (q.job && q.job !== before) order.push(q.job)
  }
  assert(order.slice(0, 3).join() === 'drill,saw,measure', `queued jobs run in order (${order.join(', ')})`)
  assert(cuts === 1 && beeps === 1, 'the saw cuts once and the meter beeps once')
  const sn = q.snapshot(new Float64Array(BSNAP.size))
  assert(sn[BSNAP.drill] === 0 && sn[BSNAP.saw] === 0 && sn[BSNAP.knob] === 0, 'afterwards the quill is up, the saw arm raised and the knob back on volts')
  q.request('drill')
  q.request('saw')
  q.clearInputs()
  assert(q.queue.length === 0, 'pause drops the queue (the running job finishes)')
}

// ── 12. Scroll shots: continuous, monotone zoom, no overshoot, one action per arrival ─
{
  const bench: Framing = { target: [0.05, 0.7, -0.05], viewH: 2.6, az: -0.92, el: 0.46 }
  assert(clampProgress(-3) === 0 && clampProgress(99) === SHOT_MAX && clampProgress(NaN) === 0, 'progress is clamped to the shots (and NaN reads as the bench)')
  let continuous = true
  let monotone = true
  let worst = 0
  const f0 = newFraming()
  const f1 = newFraming()
  for (let i = 0; i < SHOT_MAX; i++) {
    const dir = Math.sign(framingAt(i + 1, bench).viewH - framingAt(i, bench).viewH)
    for (let p = i; p < i + 1 - 1e-9; p += 0.001) {
      framingAt(p, bench, f0)
      framingAt(p + 0.001, bench, f1)
      const dt = dist(f0.target, f1.target)
      worst = Math.max(worst, dt)
      if (dt > 0.01 || Math.abs(Math.log(f1.viewH / f0.viewH)) > 0.01 || Math.abs(f1.az - f0.az) > 0.004 || Math.abs(f1.el - f0.el) > 0.004) continuous = false
      if (Math.sign(f1.viewH - f0.viewH) * dir < 0) monotone = false
    }
  }
  assert(continuous, `the camera framing changes continuously with progress (largest target step ${(worst * 1000).toFixed(2)} mm per 0.001)`)
  assert(monotone, 'between neighbouring shots the view height only grows or only shrinks')
  const at = (p: number) => framingAt(p, bench)
  assert(at(0).viewH === bench.viewH && dist(at(0).target, bench.target) === 0, 'progress 0 is exactly the whole-bench framing')
  assert([1, 2, 3].every(i => at(i).viewH <= 0.6), `the detail shots push in (${SHOTS.map((_, i) => at(i).viewH.toFixed(2)).join(' > ')} m)`)

  // The follower: eased, never past the goal, frame-rate independent.
  const f = new ShotFollower()
  let overshoot = false
  let jumps = 0
  let prev = 0
  const arrivals: number[] = []
  const script: [number, number][] = [[0, 0.3], [1, 3], [2, 3], [3, 3], [1.4, 1], [3, 3], [0, 3], [2.6, 0.2], [2, 3], [2, 3]]
  for (const [goal, secs] of script) {
    const from = f.s
    for (let i = 0; i < secs / DT; i++) {
      const a = f.step(DT, goal)
      if (a >= 0) arrivals.push(a)
      if ((goal - from) * (f.s - goal) > 1e-9) overshoot = true
      jumps = Math.max(jumps, Math.abs(f.s - prev))
      prev = f.s
    }
  }
  assert(!overshoot, 'the eased progress never swings past the shot it is heading to')
  assert(jumps < 0.05, `the eased progress moves smoothly (largest step ${jumps.toFixed(4)} per 5 ms)`)
  // Settles on 1, 2, 3; scrolled straight back past 2 to 1.4 (nothing: 2 was
  // passed at speed, 1 never reached); back to 3 (fires again: it was left);
  // to 0 (the bench has no action); a short flick; then settles on 2 and
  // holds there (fires once, not again while it dwells).
  assert(arrivals.join(',') === '1,2,3,3,2', `an action fires once per settled arrival, never when scrolled past or held (${arrivals.join(',')})`)
  assert(Math.abs(f.s - 2) < ARRIVE, 'and the camera settles on the shot asked for')

  const run = (hz: number) => {
    const g = new ShotFollower()
    const clock = new FixedClock()
    let now = 0
    let steps = 0
    const hits: number[] = []
    clock.advance(now, () => {})
    while (steps < 200 * 8) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (steps >= 200 * 8) return
        const goal = steps < 600 ? 1 : steps < 1100 ? 3 : 0.5
        const a = g.step(DT, goal)
        if (a >= 0) hits.push(steps)
        steps++
      })
    }
    return `${g.s}|${g.v}|${hits.join(',')}`
  }
  assert(run(30) === run(60) && run(60) === run(144), 'the shot camera and its arrivals are identical at 30, 60 and 144 Hz')
}

// ── 13. Workbench determinism across frame rates ─────────────────────────
{
  const N = 200 * 40
  const inputs = (sim: WorkbenchSim, step: number) => {
    if (step === 100) sim.elec.boot()
    if (step === 700) sim.request('drill')
    if (step === 900) sim.request('solder')
    if (step === 1200) sim.request('saw')
    if (step === 1900) sim.elec.press()
    if (step === 2400) sim.toggleLamp()
    if (step === 3000) sim.request('measure')
    if (step === 3100) sim.elec.chase()
    if (step === 4000) sim.clearInputs()
    if (step === 5200) sim.request('saw')
  }
  const state = (sim: WorkbenchSim) => [
    ...sim.snapshot(new Float64Array(BSNAP.size)), ...sim.elec.snapshot(new Float64Array(SNAP.size)),
    sim.t, sim.jobT, sim.done, sim.reading, +sim.lampOn, JOBS.indexOf(sim.job!), ...sim.smoke.flatMap(p => [p.x, p.y, p.z, p.age]),
    ...sim.dust.flatMap(p => [p.x, p.y, p.z, p.age]),
  ]
  const run = (seed: number, hz: number) => {
    const sim = new WorkbenchSim(seed)
    const clock = new FixedClock()
    let steps = 0
    let now = 0
    clock.advance(now, () => {})
    while (steps < N) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (steps < N) {
          inputs(sim, steps)
          sim.step(DT)
          steps++
        }
      })
      sim.takeEvents()
      sim.elec.takeEvents()
    }
    return state(sim)
  }
  const same = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]))
  const a = run(9, 30)
  const b = run(9, 60)
  const c = run(9, 144)
  assert(same(a, b) && same(b, c), 'the whole bench (iron, tools, smoke, dust, meter, electronics) is bit-identical at 30, 60 and 144 Hz')
  assert(!same(run(10, 60), b), 'a different seed changes the idle timing and the meter flicker')
}

// ── 14. The seated maker: hand locked on the iron, wire meets tip, deterministic ─
{
  // The people library's pure motion controller, driven exactly as the scene drives the person.
  const run = (hz: number, steps: number, wave?: number) => {
    const m = new PersonMotion(dimsFor('shirt'), 5)
    m.placeAt(SEAT.x, SEAT.z, SEAT.heading)
    m.setStance('sit', { seatHeight: SEAT.top, instant: true })
    const sim = new WorkbenchSim(11)
    const drv = new OperatorDriver(m)
    const clock = new FixedClock()
    let n = 0
    let now = 0
    let worstOn = 0
    let worstRest = 0
    let worstLeft = 0
    let meet = 0
    let meetN = 0
    let settled = false
    clock.advance(now, () => {})
    while (n < steps) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (n >= steps) return
        if (n === 400) sim.request('solder')
        if (wave !== undefined && n === wave) sim.wave()
        sim.step(DT)
        drv.drive(sim, [SEAT.x - 2, 2.2, SEAT.z + 2])
        m.step(DT)
        n++
        if (n < 200) return
        settled = true
        if (sim.waveT > 0 || sim.wavePending) return
        const s = sim.session
        const hr = m.handWorld('right') as V3
        const hl = m.handWorld('left') as V3
        const e = dist(hr, ironGrip(s).position)
        if (!ironHome(s) || s.grip > 0) worstOn = Math.max(worstOn, e)
        else worstRest = Math.max(worstRest, e)
        worstLeft = Math.max(worstLeft, dist(hl, solderGrip(s).position))
        if (s.phase === 'dwell' && s.feed > 0.05 && s.feed < 0.95) {
          meet = Math.max(meet, dist(s.solder.tip, s.iron.tip))
          meetN++
        }
      })
    }
    const pose = m.pose.R.flatMap(r => [...r])
    return { worstOn, worstRest, worstLeft, meet, meetN, settled, pose, hand: m.handWorld('right') }
  }
  const a = run(60, 200 * 16)
  assert(a.settled && a.worstOn <= 0.001, `the right palm stays on the iron's grip through the whole session, holder to joints and back (worst ${(a.worstOn * 1000).toFixed(3)} mm)`)
  assert(a.worstRest <= 0.001, `between sessions it rests exactly where the contract puts it (worst ${(a.worstRest * 1000).toFixed(3)} mm)`)
  assert(a.worstLeft <= 0.001, `the left palm stays on the solder wire's pinch (worst ${(a.worstLeft * 1000).toFixed(3)} mm)`)
  assert(a.meetN > 100 && a.meet <= 0.0025, `while feeding, the wire's end is on the iron's tip at the joint (within ${(a.meet * 1000).toFixed(2)} mm over ${a.meetN} steps)`)
  const b = run(30, 200 * 16)
  const c = run(144, 200 * 16)
  const same = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]))
  assert(same(a.pose, b.pose) && same(b.pose, c.pose), 'the maker whole-body pose is bit-identical at 30, 60 and 144 Hz')
  const w = run(60, 200 * 4, 300)
  assert(w.settled, 'a wave runs and hands back to the iron cleanly (no throw)')
  const sim = new WorkbenchSim(2)
  sim.request('solder')
  for (let i = 0; i < 200; i++) sim.step(DT)
  assert(sim.wave() === 'after' && sim.waveT === 0, 'tapped mid-solder, he looks up but waves only once the iron is back in its holder')
  let waited = 0
  while (sim.waveT === 0 && waited < 200 * 30) {
    sim.step(DT)
    waited++
  }
  assert(sim.waveT > 0 && sim.job !== 'solder' && ironHome(sim.session), `the wave comes once the iron is home (${(waited * DT).toFixed(1)} s later)`)
  assert(sim.request('drill') === 'queued', 'no tool job starts while he waves')
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll electronics checks passed')
