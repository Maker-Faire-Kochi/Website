import * as THREE from 'three'
import { DT, FixedClock } from '../app/three/core/clock'
import { DUR, DipCycle, ORDER, PERIOD, THETA_DOWN, THETA_UP, phaseAt, thetaAt } from '../app/three/scenes/backwater/cycle'
import {
  BANK, BOOM, CLUSTER_DEPTH, DECK, FULCRUM, HANG_LOCAL, NET, NUT_R, NUTS, PALMS, TRUNK_TOP,
  boomToWorld, crownTilt, netCorners, netPoint, palmPoint,
} from '../app/three/scenes/backwater/layout'
import { BRUSH_MAX, LEAN_MAX, World, type SimEvent } from '../app/three/scenes/backwater/sim'
import { PEAK } from '../app/three/core/voice'
import { backwaterSound } from '../app/three/scenes/backwater/sound'
import type { Materials, MatKey } from '../app/three/core/kit'
import { HIT_RANGE, ROPE_GRIP_R, SCOOP_FRONT, createCrew, palmOff } from '../app/three/scenes/backwater/crew'
import { PASS, STROKE, TAIL, ropeFrom, ropeLength, ropeTo, tailEnds } from '../app/three/scenes/backwater/haul'
import { ELBOW_MAX, apply, fkLeg, mul, type Vec3 } from '../app/three/people/ik'
import { B } from '../app/three/people/motion'
import type { Person } from '../app/three/people/person'
import {
  ANGLE, FOV_DEG, SHOTS, SHOT_MAX, ShotFollower, bankSubject, basis, cameraAt, contains, fishersSubject, framingAt, project,
  catchSubject, machineSubject, netFraming, newFraming, shotFramings, type Cast,
} from '../app/three/scenes/backwater/shots'
import { FAR, ROPES, SCOOP, type V3 } from '../app/three/scenes/backwater/layout'
import { FISH_LEN } from '../app/three/scenes/backwater/catch'

// Stand-in for the stage's materials (the real ones need a canvas).
function fakeMaterials(): Materials {
  const keys: MatKey[] = ['red', 'cyan', 'accent', 'light', 'mid', 'dark', 'wood', 'woodDark', 'stone', 'metal', 'water', 'leaf']
  const face = Object.fromEntries(keys.map(k => [k, new THREE.MeshLambertMaterial()])) as Materials['face']
  return { face, line: new THREE.LineBasicMaterial(), lineFaint: new THREE.LineBasicMaterial(), shadow: new THREE.MeshBasicMaterial(), dispose() {} }
}


/**
 * Pure-logic checks for the backwater scene: the dip cycle, the boom /
 * counterweight lever, coconut falls, determinism across frame rates, and
 * that the pure kinematics agree with the three.js node chains the renderer
 * builds; the sound hooks (each physical event fires exactly once, the same
 * at every frame rate), the pointer lean's bounds, and the voices' peak level
 * and silence on pause, against a stand-in AudioContext. Run: npx --yes tsx scripts/test-backwater.ts
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

// ── Dip cycle ─────────────────────────────────────────────────────────────

{
  let periodic = true
  let bounded = true
  let maxJump = 0
  for (let t = 0; t < PERIOD; t += 0.0137) {
    if (Math.abs(thetaAt(t) - thetaAt(t + PERIOD)) > 1e-12 || Math.abs(thetaAt(t) - thetaAt(t + 3 * PERIOD)) > 1e-12) periodic = false
    const th = thetaAt(t)
    if (th < THETA_DOWN - 1e-12 || th > THETA_UP + 1e-12) bounded = false
    maxJump = Math.max(maxJump, Math.abs(thetaAt(t + 0.001) - th))
  }
  assert(periodic, `thetaAt is periodic with PERIOD = ${PERIOD.toFixed(2)} s`)
  assert(PERIOD >= 10 && PERIOD <= 12, 'cycle period is 10-12 s')
  assert(bounded, 'boom tilt stays within [THETA_DOWN, THETA_UP]')
  assert(maxJump < 0.001, `boom tilt is continuous (max change per ms ${maxJump.toExponential(2)} rad)`)

  // Every start and stop eases: angular velocity ~0 at each phase boundary.
  let t0 = 0
  let eased = true
  for (const p of ORDER) {
    for (const t of [t0 + 1e-4, t0 + DUR[p] - 1e-4]) {
      const v = (thetaAt(t + 1e-5) - thetaAt(t - 1e-5)) / 2e-5
      if (Math.abs(v) > 0.01) eased = false
    }
    t0 += DUR[p]
  }
  assert(eased, 'boom angular velocity is ~0 at every phase boundary (eased starts/stops)')
  assert(phaseAt(0.1).phase === 'lower' && phaseAt(DUR.lower + 0.1).phase === 'soak'
    && phaseAt(DUR.lower + DUR.soak + 0.1).phase === 'lift' && phaseAt(PERIOD - 0.1).phase === 'rest', 'phases run lower > soak > lift > rest')

  const a = new DipCycle()
  const b = new DipCycle()
  const steps = Math.round(PERIOD / DT)
  const seen: string[] = []
  for (let i = 0; i < steps; i++) {
    a.step(DT)
    if (seen[seen.length - 1] !== a.phase) seen.push(a.phase)
  }
  assert(Math.abs(a.t - b.t) < 1e-9 && Math.abs(a.theta - b.theta) < 1e-9, 'stepped cycle returns to the same state after one period of steps')
  assert(seen.join(',') === 'rest,lower,soak,lift,rest', `stepped cycle visits phases in order (${seen.join(',')})`)

  const c = new DipCycle()
  c.t = DUR.lower + 0.5
  assert(!c.dip() && c.phase === 'soak', 'dip() is refused mid-cycle')
  c.t = PERIOD - 1
  assert(c.dip() && c.phase === 'lower' && Math.abs(c.theta - THETA_UP) < 1e-9, 'dip() from rest starts lowering seamlessly from the raised angle')
}

// ── Boom and counterweight ────────────────────────────────────────────────

{
  let opposite = true
  let within = true
  let prevTip = 0
  let prevRear = 0
  let counter = true
  for (let i = 0; i <= 2000; i++) {
    const th = thetaAt((i / 2000) * PERIOD)
    const tip = boomToWorld([BOOM.front, 0, 0], th)
    const rear = boomToWorld([-BOOM.rear, 0, 0], th)
    const tipEl = Math.atan2(tip[1] - FULCRUM[1], Math.hypot(tip[0] - FULCRUM[0], tip[2] - FULCRUM[2]))
    const rearEl = Math.atan2(rear[1] - FULCRUM[1], Math.hypot(rear[0] - FULCRUM[0], rear[2] - FULCRUM[2]))
    if (Math.abs(tipEl + rearEl) > 1e-9) opposite = false
    if (tipEl < THETA_DOWN - 1e-9 || tipEl > THETA_UP + 1e-9) within = false
    if (i > 0) {
      const dt = tip[1] - prevTip
      const dr = rear[1] - prevRear
      if (Math.abs(dt) > 1e-9 && Math.sign(dt) === Math.sign(dr)) counter = false
    }
    prevTip = tip[1]
    prevRear = rear[1]
  }
  assert(opposite, 'counterweight arm elevation is always exactly opposite the net arm')
  assert(within, 'net arm elevation stays within limits over a whole cycle')
  assert(counter, 'counterweight end always moves opposite to the net end')

  const lowest = (th: number) => {
    const c = netCorners(th)
    let m = Infinity
    for (let u = 0; u <= 1; u += 0.1) for (let v = 0; v <= 1; v += 0.1) m = Math.min(m, netPoint(c, u, v, NET.sag + 0.35)[1])
    return m
  }
  assert(lowest(THETA_UP) > 0.5, `raised net hangs clear of the water (lowest ${lowest(THETA_UP).toFixed(2)} m)`)
  assert(netCorners(THETA_DOWN).every(c => c[1] < 0), 'lowered net has all four corners under water')

  // Stones never touch the deck, even swinging.
  const w = new World(3)
  let clear = Infinity
  let maxPhi = 0
  for (let i = 0; i < Math.round(3 * PERIOD / DT); i++) {
    w.step(DT)
    const h = boomToWorld(HANG_LOCAL, w.theta)
    clear = Math.min(clear, h[1] - CLUSTER_DEPTH * Math.cos(w.phi) - DECK.top)
    maxPhi = Math.max(maxPhi, Math.abs(w.phi))
  }
  assert(clear > 0.05, `counterweight stones clear the deck by >= 5 cm (min ${clear.toFixed(3)} m)`)
  assert(maxPhi > 0.002 && maxPhi < 0.2, `stones swing a little as the boom starts and stops (max ${(maxPhi * 180 / Math.PI).toFixed(2)} deg)`)
}

// ── Coconuts ──────────────────────────────────────────────────────────────

{
  const w = new World(9)
  for (let p = 0; p < PALMS.length; p++) w.requestDrop(p)
  let aboveGround = true
  let notSunk = true
  let landedBank = 0
  let landedWater = 0
  for (let i = 0; i < Math.round(8 / DT); i++) {
    w.step(DT)
    for (const b of w.bodies) {
      if (b.mode === 'off') continue
      if (b.x >= BANK.x0 && b.y < BANK.top + NUT_R - 1e-6) aboveGround = false
      if (b.x < BANK.x0 && b.y < -NUT_R) notSunk = false
    }
  }
  for (const b of w.bodies) {
    if (b.mode === 'rest' && b.x >= BANK.x0 && b.vx === 0 && b.vz === 0) landedBank++
    if (b.mode === 'float' && Math.abs(b.vy) < 0.01 && Math.abs(b.y - 0.02) < 0.01) landedWater++
  }
  assert(w.bodies.filter(b => b.mode !== 'off').length === PALMS.length, 'one coconut falls per tapped palm')
  assert(aboveGround, 'a coconut never goes below the bank surface')
  assert(notSunk, 'a coconut in the water never goes fully under')
  assert(landedBank + landedWater === PALMS.length, `every coconut comes to rest (bank ${landedBank}, floating ${landedWater})`)
  assert(PALMS.every((_, p) => w.palms[p]!.nuts.filter(n => n.state !== 'on').length === 1), 'each tapped palm lost exactly one nut')

  for (let i = 0; i < Math.round(30 / DT); i++) w.step(DT)
  assert(w.bodies.every(b => b.mode === 'off'), 'fallen coconuts are cleared after a while')
  assert(PALMS.every((_, p) => w.palms[p]!.nuts.every(n => n.state === 'on')), 'palms regrow their nuts')
}

// ── Determinism across frame rates ────────────────────────────────────────

{
  const N = 6000
  const inputs = (w: World, n: number) => {
    if (n === 400) w.requestDrop(1)
    if (n === 900) w.requestDip()
    if (n === 1500) w.setLean(2, 0.02, -0.01)
    if (n === 2600) w.requestDrop(0)
    if (n === 3000) w.setLean(-1, 0, 0)
  }
  const run = (frameMs: number) => {
    const w = new World(42)
    const clock = new FixedClock()
    let n = 0
    let now = 1000
    clock.advance(now, () => {})
    while (n < N) {
      now += frameMs
      clock.advance(now, () => {
        if (n >= N) return
        inputs(w, n)
        w.step(DT)
        n++
      })
      // A render reads interpolated state; it must never change the simulation.
      w.swayOf(w.palms[0]!, 0.5)
      w.nutWorld(1, 2, 0.3)
    }
    return w.snapshot()
  }
  const a = run(1000 / 60)
  const b = run(1000 / 144)
  const c = run(1000 / 30)
  assert(a === b && b === c, 'same seed + same step count + same inputs = same state at 30, 60 and 144 Hz')
  const w1 = new World(42)
  const w2 = new World(43)
  assert(w1.snapshot() !== w2.snapshot(), 'a different seed gives a different scene')
  assert(new World(42).snapshot() === w1.snapshot() && Math.abs(w1.theta - THETA_UP) < 1e-12, 'the initial (poster) state is fixed: net raised')
}

// ── Pure kinematics agree with the three.js node chains ───────────────────

{
  const pivot = new THREE.Group()
  pivot.position.set(...FULCRUM)
  pivot.rotation.y = Math.PI
  const tilt = new THREE.Group()
  pivot.add(tilt)
  let maxErr = 0
  for (const th of [THETA_DOWN, 0, 0.11, THETA_UP]) {
    tilt.rotation.z = th
    pivot.updateMatrixWorld(true)
    for (const p of [[BOOM.front, 0, 0], [-BOOM.rear, -0.11, 0.16], [1, 2, -3]] as [number, number, number][]) {
      const v = new THREE.Vector3(...p).applyMatrix4(tilt.matrixWorld)
      const q = boomToWorld(p, th)
      maxErr = Math.max(maxErr, Math.abs(v.x - q[0]), Math.abs(v.y - q[1]), Math.abs(v.z - q[2]))
    }
  }
  assert(maxErr < 1e-9, `boomToWorld matches the pivot/tilt node chain (err ${maxErr.toExponential(1)})`)

  maxErr = 0
  for (const spec of PALMS) {
    const root = new THREE.Group()
    root.position.set(...spec.base)
    root.rotation.y = spec.yaw
    root.scale.setScalar(spec.scale)
    const lean = new THREE.Group()
    lean.rotation.z = spec.lean
    const bend = new THREE.Group()
    bend.rotation.set(0.01, 0, -0.02)
    const crownBase = new THREE.Group()
    crownBase.position.set(...TRUNK_TOP)
    crownBase.rotation.z = crownTilt(spec)
    const sway = new THREE.Group()
    sway.rotation.set(0.05, 0, -0.08)
    root.add(lean)
    lean.add(bend)
    bend.add(crownBase)
    crownBase.add(sway)
    root.updateMatrixWorld(true)
    for (const n of NUTS) {
      const v = new THREE.Vector3(...n).applyMatrix4(sway.matrixWorld)
      const q = palmPoint(spec, [0.01, -0.02], [0.05, -0.08], n)
      maxErr = Math.max(maxErr, Math.abs(v.x - q[0]), Math.abs(v.y - q[1]), Math.abs(v.z - q[2]))
    }
  }
  assert(maxErr < 1e-9, `palmPoint matches the palm node chain, so nuts stay on their crowns (err ${maxErr.toExponential(1)})`)
}

// ── A stand-in AudioContext: records every node, connection and gain value ──

/**
 * Just enough of WebAudio to run the voices outside a browser. Output stages
 * are the gain nodes connected straight to the destination; every value
 * scheduled on them is recorded, so the PEAK cap is checked on what would
 * actually reach the speakers.
 */
class MockParam {
  max = -Infinity
  last = NaN
  private v: number
  constructor(v: number) {
    this.v = v
  }

  get value() { return this.v }
  set value(x: number) { this.rec(x) }
  private rec(x: number) {
    if (!Number.isFinite(x)) throw new Error(`non-finite param value ${x}`)
    this.max = Math.max(this.max, x)
    this.last = x
    this.v = x
  }

  setValueAtTime(x: number) { this.rec(x); return this }
  linearRampToValueAtTime(x: number) { this.rec(x); return this }
  exponentialRampToValueAtTime(x: number) {
    if (x <= 0) throw new Error('exponential ramp to <= 0')
    this.rec(x)
    return this
  }

  setTargetAtTime(x: number) { this.rec(x); return this }
  cancelScheduledValues() { return this }
  cancelAndHoldAtTime() { return this }
}

class MockNode {
  out: unknown = null
  started = 0
  stopped = 0
  constructor(readonly context: MockContext, readonly kind: string) {
    context.nodes.push(this)
  }

  connect(to: unknown) {
    this.out = to
    return to instanceof MockNode ? to : undefined
  }

  start() { this.started++ }
  stop() { this.stopped++ }
}

class MockContext {
  nodes: (MockNode & Record<string, any>)[] = []
  currentTime = 0
  sampleRate = 8000
  state = 'running'
  destination = { kind: 'destination' }
  static made = 0
  static last: MockContext | null = null
  constructor() {
    MockContext.made++
    MockContext.last = this
  }

  resume() {}
  createGain() { return Object.assign(new MockNode(this, 'gain'), { gain: new MockParam(1) }) }
  createOscillator() {
    return Object.assign(new MockNode(this, 'osc'), { type: 'sine', frequency: new MockParam(440), detune: new MockParam(0) })
  }

  createBiquadFilter() {
    return Object.assign(new MockNode(this, 'filter'), { type: 'lowpass', frequency: new MockParam(350), Q: new MockParam(1) })
  }

  createBufferSource() { return Object.assign(new MockNode(this, 'buffer'), { buffer: null, loop: false }) }
  createBuffer(_ch: number, length: number, sampleRate: number) {
    const data = new Float32Array(length)
    return { duration: length / sampleRate, getChannelData: () => data }
  }

  /** Output stages: gains wired straight to the speakers. */
  outputs() { return this.nodes.filter(n => n.kind === 'gain' && n.out === this.destination) }
}

function installMockAudio() {
  ;(globalThis as any).window = { AudioContext: MockContext }
  Object.defineProperty(globalThis.navigator, 'userActivation', { value: { hasBeenActive: true }, configurable: true })
}

// ── Sound hooks: each physical event fires exactly once, deterministically ──

{
  // Three dips, coconuts from every palm (bank and water), drips after each lift.
  const w = new World(11)
  const log: string[] = []
  const steps = Math.round(3 * PERIOD / DT)
  let lowers = 0
  let lastPhase = w.phase
  let splashBad = 0
  let dripExpected = 0
  let dripSeen = 0
  let dripBad = 0
  let bankExpected = 0
  let plopExpected = 0
  const counts: Record<SimEvent['kind'], number> = { 'splash': 0, 'drip': 0, 'nut-drop': 0, 'nut-bank': 0, 'nut-plop': 0, 'nut-bonk': 0 }
  const fallAt: number[] = []
  let fallErr = 0
  const pending: { due: number }[] = []
  for (let n = 0; n < steps; n++) {
    if (n === 400) for (let p = 0; p < PALMS.length; p++) w.requestDrop(p)
    if (n === 3000) w.requestDrop(0)
    // Independent expectations, read from the state before and after the step.
    const dripsOn = w.drops.map(d => d.on && d.drip)
    const before = w.bodies.map(b => ({ mode: b.mode, vy: b.vy }))
    w.step(DT)
    w.drops.forEach((d, i) => {
      if (dripsOn[i] && !d.on && d.x < BANK.x0) dripExpected++
    })
    w.bodies.forEach((b, i) => {
      const was = before[i]!
      if (was.mode !== 'fall') return
      if (b.mode === 'float') plopExpected++
      else if (b.x >= BANK.x0 && b.y === BANK.top + NUT_R && b.t > 0 && -(was.vy - 9.81 * DT) > 0.4) bankExpected++
      else if (b.mode === 'roll' && b.t === 0 && -(was.vy - 9.81 * DT) > 0.4) bankExpected++
    })
    if (w.phase === 'lower' && lastPhase !== 'lower') lowers++
    lastPhase = w.phase
    for (const e of w.events) {
      counts[e.kind]++
      log.push(`${n} ${JSON.stringify(e)}`)
      if (e.kind === 'splash') {
        // The splash belongs to the step the net's first rings appear.
        if (w.phase !== 'lower' || !w.rings.some(r => r.on && r.age === DT && r.R >= 1)) splashBad++
      }
      if (e.kind === 'drip') {
        dripSeen++
        if (w.wet || e.x >= BANK.x0) dripBad++
      }
      if (e.kind === 'nut-drop') pending.push({ due: n + e.fall / DT })
      if (e.kind === 'nut-bank' || e.kind === 'nut-plop') {
        // First impact of a falling nut lands when its nut-drop said it would.
        let k = -1
        pending.forEach((p, i) => {
          if (Math.abs(p.due - n) < 0.1 / DT && (k < 0 || Math.abs(p.due - n) < Math.abs(pending[k]!.due - n))) k = i
        })
        if (k >= 0) {
          fallAt.push(n)
          fallErr = Math.max(fallErr, Math.abs(pending[k]!.due - n) * DT)
          pending.splice(k, 1)
        }
      }
    }
  }
  assert(lowers === 3 && counts.splash === lowers, `one splash per net entry (${counts.splash} splashes, ${lowers} dips)`)
  assert(splashBad === 0, 'each splash fires while lowering, on the step the entry rings appear')
  assert(counts.drip > 20 && counts.drip === dripExpected && dripSeen === dripExpected, `one plink per drip landing in the water (${counts.drip} of ${dripExpected})`)
  assert(dripBad === 0, 'drips only plink while the net is out of the water, and only on water')
  assert(counts['nut-drop'] === PALMS.length + 1, `one whoosh per coconut released (${counts['nut-drop']})`)
  assert(counts['nut-plop'] === plopExpected && plopExpected >= 1, `one plop per coconut entering the water (${counts['nut-plop']})`)
  assert(counts['nut-bank'] === bankExpected && bankExpected >= PALMS.length, `one thunk per hard bank impact, bounces included (${counts['nut-bank']})`)
  assert(fallAt.length === PALMS.length + 1 && fallErr < 0.02, `each nut-drop predicts its first impact (worst ${(fallErr * 1000).toFixed(1)} ms)`)

  // The same inputs give the same event log, step for step, at any frame rate.
  const runLog = (frameMs: number) => {
    const v = new World(11)
    const clock = new FixedClock()
    const out: string[] = []
    let n = 0
    let now = 0
    clock.advance(now, () => {})
    while (n < 6000) {
      now += frameMs
      clock.advance(now, () => {
        if (n >= 6000) return
        if (n === 400) for (let p = 0; p < PALMS.length; p++) v.requestDrop(p)
        if (n === 900) v.requestBrush(1, 0.1, 0.05)
        v.step(DT)
        for (const e of v.events) out.push(`${n} ${JSON.stringify(e)}`)
        n++
      })
    }
    return out.join('\n')
  }
  const l60 = runLog(1000 / 60)
  assert(l60.length > 0 && l60 === runLog(1000 / 144) && l60 === runLog(1000 / 30), 'event log is identical at 30, 60 and 144 Hz')
}

// ── Pointer lean and brush: visible, damped, bounded ─────────────────────

{
  const extra = (setup: (w: World) => void, palm: number) => {
    const a = new World(5)
    const b = new World(5)
    setup(b)
    let peak = 0
    let firstStep = 0
    for (let n = 0; n < Math.round(6 / DT); n++) {
      a.step(DT)
      b.step(DT)
      const d = Math.hypot(b.palms[palm]!.sway[0] - a.palms[palm]!.sway[0], b.palms[palm]!.sway[1] - a.palms[palm]!.sway[1])
      if (n === 0) firstStep = d
      peak = Math.max(peak, d)
    }
    return { peak, firstStep, settled: b }
  }
  const lean = extra(w => w.setLean(1, 1, 0), 1)
  assert(lean.peak > 0.04 && lean.peak <= 0.08, `pointer lean reads but stays bounded (peak extra sway ${lean.peak.toFixed(3)} rad, limit 0.08)`)
  assert(lean.firstStep < 1e-4, 'the lean eases in (no jump on the first step)')
  const l = lean.settled.palms[1]!.lean
  assert(Math.abs(Math.hypot(l[0], l[1]) - LEAN_MAX) < 1e-6, `lean target is clamped to LEAN_MAX (${LEAN_MAX} rad)`)
  const off = new World(5)
  off.setLean(2, 0.05, 0)
  for (let n = 0; n < 400; n++) off.step(DT)
  off.clearInputs()
  for (let n = 0; n < Math.round(4 / DT); n++) off.step(DT)
  assert(Math.hypot(...off.palms[2]!.lean) < 1e-6, 'pause clears the lean and the crown eases back')
  const brush = extra(w => w.requestBrush(0, 5, 5), 0)
  assert(brush.peak > 0.01 && brush.peak < 0.06, `a brush flicks the crown visibly but gently (peak ${brush.peak.toFixed(3)} rad; kick capped at ${BRUSH_MAX} rad/s)`)
}

// ── Voices: silent without a context, capped and stoppable with one ──────

{
  const s = backwaterSound()
  let threw = false
  try {
    s.event({ kind: 'splash', x: 0, z: 0, speed: 0.3 })
    s.event({ kind: 'drip', x: 0, z: 0 })
    s.frame(1, true)
    s.rustle(1)
    s.leave()
    s.silence()
  }
  catch {
    threw = true
  }
  assert(!threw, 'with no audio context (headless, no gesture) every voice is a silent no-op')

  installMockAudio()
  const v = backwaterSound()
  const events: SimEvent[] = [
    { kind: 'splash', x: -7, z: 0, speed: 0.34 }, { kind: 'drip', x: -6, z: 0.3 }, { kind: 'nut-drop', palm: 0, fall: 1.1 },
    { kind: 'nut-bank', speed: 11 }, { kind: 'nut-plop', speed: 11 },
  ]
  for (const e of events) v.event(e)
  v.rustle(1)
  for (let f = 0; f < 60; f++) {
    v.frame(f / 30, true)
  }
  const ctx = MockContext.last!
  const outs = ctx.outputs()
  const peak = Math.max(...outs.map(n => n.gain.max))
  assert(MockContext.made === 1, 'the voices use the one shared context (never their own)')
  assert(outs.length >= 12 && peak <= PEAK, `every output stage peaks at <= ${PEAK} (max ${peak.toFixed(3)} over ${outs.length} stages)`)
  const drones = ctx.nodes.filter(n => n.kind === 'osc' || (n.kind === 'buffer' && n.loop))
  v.silence()
  assert(outs.every(n => n.gain.last === 0 || n.gain.last <= 1e-4), 'silence() fades every sounding output to zero')
  assert(drones.every(n => n.stopped > 0), 'silence() stops every running oscillator and noise loop')
  const before = ctx.nodes.length
  v.setMuted(true)
  v.event(events[0]!)
  v.frame(1, true)
  v.rustle(1)
  assert(ctx.nodes.length === before, 'a muted (thumbnail) scene creates no sound at all')
}

// ── People: fishers on the ropes, the bank, the kite ─────────────────────

/** A sole's position (deck frame) from the posed leg (FK of the joint angles, not the targets). */
function soleOf(p: Person, i: 0 | 1) {
  const m = p.motion
  const fk = fkLeg(m.leg, m.pose.pelvisPos, m.pose.R[B.pelvis]!, i === 0 ? 1 : -1, m.legs[i])
  return m.toWorld(fk.sole)
}

/** Distance from a world point to rope i's tail (block to where it leaves the hands). */
function tailDistance(i: number, p: THREE.Vector3) {
  const b = ropeTo(i)
  const e = tailEnds(i).e
  const seg = new THREE.Line3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(e[0], e[1], e[2]))
  return seg.closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p)
}

{
  const sim = new World(11)
  const t0 = performance.now()
  const crew = await createCrew({ materials: fakeMaterials() }, sim)
  console.log(`  (crew built in ${(performance.now() - t0).toFixed(0)} ms)`)
  const h = new THREE.Vector3()
  const handSide = (i: number, k: 0 | 1) => (k === 0 ? crew.lead[i]! : crew.lead[i] === 'left' ? 'right' : 'left')
  let onRope = 0
  let lifted = 0
  let liftedSteps = 0
  let excess = -Infinity
  let stepped = false
  let phaseOutsideLift = 0
  let haulOutsideLift = 0
  let haulInLift = 0
  let soleMove = 0
  let soleHeight = 0
  let minHands = Infinity
  let kiteOver = 0
  let kiteUnder = Infinity
  const feet0 = crew.fishers.map(f => [soleOf(f, 0), soleOf(f, 1)])
  const prevH = crew.hauls.map(g => [...g.h])
  const prevPhase = crew.hauls.map(g => g.ropePhase)
  const N = Math.round(PERIOD / DT)
  const ts = performance.now()
  for (let n = 0; n < N; n++) {
    sim.step(DT)
    crew.step(DT)
    const phase = sim.phase
    crew.fishers.forEach((f, i) => {
      const g = crew.hauls[i]!
      excess = Math.max(excess, f.motion.reachExcess)
      if (f.busy) stepped = true
      // At rest fisher 0 may be landing the catch with the scoop (checked below).
      if (i === 0 && crew.scoop.scooping) return
      const hands: THREE.Vector3[] = []
      for (const k of [0, 1] as const) {
        f.handWorld(handSide(i, k), h)
        h.y += DECK.top
        hands.push(h.clone())
        // An overhand grip: the palm's centre rides just over the rope, off its axis by the grip's offset.
        const d = tailDistance(i, h) - palmOff(f.dims.H, ROPE_GRIP_R)
        if (g.off[k] === 0) onRope = Math.max(onRope, Math.abs(d))
        else {
          lifted = Math.max(lifted, d)
          liftedSteps++
        }
        // A gripping hand drawn toward the fisher is hauling.
        if (g.grip[k] && g.h[k] > prevH[i]![k]! + 1e-6) {
          if (phase === 'lift') haulInLift++
          else haulOutsideLift++
        }
        prevH[i]![k] = g.h[k]
      }
      minHands = Math.min(minHands, hands[0]!.distanceTo(hands[1]!))
      if (g.ropePhase !== prevPhase[i] && phase !== 'lift' && !(prevPhase[i]! > 0.9 && g.ropePhase === 0)) phaseOutsideLift++
      prevPhase[i] = g.ropePhase
      for (const k of [0, 1] as const) {
        const sp = soleOf(f, k)
        const s0 = feet0[i]![k]!
        soleMove = Math.max(soleMove, Math.hypot(sp[0] - s0[0], sp[2] - s0[2]))
        soleHeight = Math.max(soleHeight, Math.abs(sp[1]))
      }
    })
    const a = crew.kite.sim.anchor
    const kp = crew.kite.sim.p
    kiteOver = Math.max(kiteOver, Math.hypot(kp[0] - a[0], kp[1] - a[1], kp[2] - a[2]) - crew.kite.sim.lineLen)
    kiteUnder = Math.min(kiteUnder, kp[1] - a[1])
  }
  const perStep = (performance.now() - ts) / N
  assert(onRope <= 1e-3, `fishers' palms stay on their rope (overhand, just over it) through a whole cycle, every hand not passing the other (max ${(onRope * 1000).toFixed(3)} mm off)`)
  assert(liftedSteps > 0 && lifted <= PASS + 1e-3, `a recovering hand only lifts over the other while passing it (max ${(lifted * 100).toFixed(1)} cm, ${liftedSteps} hand-steps)`)
  assert(minHands >= 0.12, `the two hands on a rope stay 12 cm apart, passing too (closest ${(minHands * 100).toFixed(1)} cm apart)`)
  assert(Math.min(...STROKE) >= 0.15, `each haul stroke is a long pull, at least 15 cm of rope per hand (${STROKE.map(x => (x * 100).toFixed(1)).join(', ')} cm)`)
  assert(excess <= 1e-9 && !stepped, `every grip is within reach: no over-reach, no step (worst ${excess.toFixed(4)} m)`)
  assert(haulInLift > 0 && haulOutsideLift === 0 && phaseOutsideLift === 0, `they haul only while the net comes up (${haulInLift} hauling hand-steps in the lift, ${haulOutsideLift} outside)`)
  assert(soleMove < 1e-9 && soleHeight < 1e-3, `fishers' feet stay planted on the deck: no slide (${soleMove.toExponential(1)} m), soles on the deck top (${(soleHeight * 1000).toFixed(2)} mm)`)
  // The kite's line is a stiff spring in the kite sim (people/props-sim): it stretches a little in the gusts.
  assert(kiteOver < 0.15 * crew.kite.sim.lineLen && kiteUnder >= 0.2 - 1e-9, `kite string length stays bounded (at most +${(kiteOver * 100).toFixed(0)} cm on a ${crew.kite.sim.lineLen} m line in the gusts) and the kite above the hand`)
  console.log(`  (sim + 5 people + kite: ${(perStep * 1000).toFixed(0)} us per step)`)

  // The gripping hands move exactly with the rope hauled through the block.
  let worst = 0
  let lastL = ropeLength(0, sim.theta)
  let lastH = [...crew.hauls[0]!.h]
  let lastGrip = [...crew.hauls[0]!.grip]
  for (let n = 0; n < N; n++) {
    sim.step(DT)
    crew.step(DT)
    const g = crew.hauls[0]!
    const L = ropeLength(0, sim.theta)
    for (const k of [0, 1] as const) {
      if (sim.phase === 'lift' && g.grip[k] && lastGrip[k] && lastH[k]! < g.h[k]) worst = Math.max(worst, Math.abs((g.h[k] - lastH[k]!) - (lastL - L)))
    }
    lastL = L
    lastH = [...g.h]
    lastGrip = [...g.grip]
  }
  assert(worst < 1e-6, `a gripping hand moves exactly as far as the rope is hauled (err ${worst.toExponential(1)} m per step)`)
}

// ── Coconuts on heads: every bank person can be hit, and recovers ─────────

{
  const names = ['watcher', 'visitor', 'child']
  const palmFor = (crew: Awaited<ReturnType<typeof createCrew>>, i: number) => {
    const p = crew.bankPeople[i]!
    let best = 0
    let bd = Infinity
    PALMS.forEach((sp, j) => {
      const c = palmPoint(sp, [0, 0], [0, 0], [0, -0.2, 0])
      const d = Math.hypot(c[0] - p.position.x, c[2] - p.position.z)
      if (d < bd) {
        bd = d
        best = j
      }
    })
    return { palm: best, d: bd }
  }
  for (let i = 0; i < 3; i++) {
    const sim = new World(11)
    // No nuts of their own here: one hit at a time, on purpose.
    const crew = await createCrew({ materials: fakeMaterials() }, sim, undefined, { autoNuts: false })
    const run = (secs: number, each?: () => void) => {
      for (let n = 0; n < Math.round(secs / DT); n++) {
        sim.step(DT)
        crew.step(DT)
        each?.()
      }
    }
    // Past the first net coming up (the child points at it), in the quiet before the next.
    run(12)
    const { palm, d } = palmFor(crew, i)
    const home = crew.bankPeople[i]!.position.clone()
    const before = crew.bankPeople[i]!.action
    // The nearest palm aims at whoever is nearest it; name the person here (the auto drops rotate through them).
    const ok = crew.dropNut(palm, i)
    let hit: { x: number, z: number } | null = null
    let reacted = false
    let kiteLow = Infinity
    const kiteStart = crew.kite.sim.p[1]
    const beats: string[] = []
    run(i === 1 ? 8.5 : 6.5, () => {
      for (const e of sim.events) if (e.kind === 'nut-bonk') hit = { x: e.x, z: e.z }
      if (crew.reacting(i)) reacted = true
      if (i === 2) {
        kiteLow = Math.min(kiteLow, crew.kite.sim.p[1])
        if (crew.bonkBeat && beats[beats.length - 1] !== crew.bonkBeat) beats.push(crew.bonkBeat)
      }
    })
    const p = crew.bankPeople[i]!
    const off = hit ? Math.hypot(hit.x - p.position.x, hit.z - p.position.z) : Infinity
    assert(ok && d < HIT_RANGE && crew.hits[i] === 1 && off < 0.35, `a nut from the palm over the ${names[i]} (crown ${d.toFixed(2)} m off) lands on their head (${off.toFixed(2)} m off centre)`)
    assert(reacted && !crew.reacting(i) && p.action === before && p.position.distanceTo(home) < 0.05, `the ${names[i]} reacts and goes back to what they were doing (${p.action}, ${(p.position.distanceTo(home) * 100).toFixed(1)} cm from where they stood)`)
    if (i === 2) {
      assert(beats.join('>') === 'flinch>rub>look>relaunch', `the child flinches with both hands to the head, rubs it, looks up at the palm and relaunches the kite (${beats.join('>')})`)
      assert(kiteLow < kiteStart - 0.4 && crew.kite.sim.p[1] - crew.kite.sim.anchor[1] > 1.5, `the kite sinks while its line is slack (dips ${(kiteStart - kiteLow).toFixed(2)} m) and climbs back`)
      assert(crew.childState === 'flying', `the child is back to flying the kite (${crew.childState})`)
    }
    const nut = sim.bodies.find(b => b.mode === 'rest' || b.mode === 'roll')
    assert(!!nut && nut.x >= BANK.x0 && Math.hypot(nut.x - p.position.x, nut.z - p.position.z) > 0.2, `the nut bounces off the ${names[i]} and comes to rest on the bank, clear of them`)
  }

  // On their own: a hit within 20 s of the scene starting, and they keep coming.
  {
    const sim = new World(11)
    const crew = await createCrew({ materials: fakeMaterials() }, sim)
    let first = -1
    for (let n = 0; n < Math.round(60 / DT); n++) {
      sim.step(DT)
      crew.step(DT)
      if (first < 0 && crew.hits.some(h => h > 0)) first = n * DT
    }
    const total = crew.hits.reduce((a, b) => a + b, 0)
    assert(first >= 0 && first <= 20, `a coconut lands on someone on its own within 20 s (at ${first.toFixed(1)} s)`)
    assert(total >= 3 && total <= 6, `in a minute, ${total} hits (${crew.hits.join(' / ')} on the watcher / visitor / child): now and then, not a hail`)
  }
}

// ── Determinism with people, across frame rates ──────────────────────────

{
  const N = 5000
  const run = async (frameMs: number) => {
    const sim = new World(42)
    const crew = await createCrew({ materials: fakeMaterials() }, sim)
    const clock = new FixedClock()
    let n = 0
    let now = 1000
    clock.advance(now, () => {})
    while (n < N) {
      now += frameMs
      clock.advance(now, () => {
        if (n >= N) return
        if (n === 300) crew.tap(crew.fishers.length + 1)
        if (n === 500) crew.dropNut(crew.bonkPalm, 2)
        if (n === 900) sim.requestDip()
        if (n === 1400) crew.tap(0)
        if (n === 2600) crew.dropNut(0)
        if (n === 3000) crew.tugKite()
        sim.step(DT)
        crew.step(DT)
        n++
      })
      // Drawing reads interpolated state; it must never change the simulation.
      crew.frame(0.5)
    }
    const v = new THREE.Vector3()
    const people = crew.people.map(p => [p.position.toArray(), p.heading, p.action, p.motion.pose.R, p.motion.pose.pelvisPos, p.handWorld('left', v).toArray(), p.handWorld('right', v).toArray()])
    return JSON.stringify([sim.snapshot(), people, crew.kite.sim.p, crew.kite.sim.anchor, crew.catch.snapshot(), crew.scoop.hoop.toArray()])
  }
  const a = await run(1000 / 60)
  const b = await run(1000 / 144)
  const c = await run(1000 / 30)
  assert(a === b && b === c, 'with the people, kite and easter egg: same seed + steps + inputs = same state at 30, 60 and 144 Hz')
}

// ── Scroll shots: framing, containment, easing ───────────────────────────

{
  const sim = new World(11)
  const crew = await createCrew({ materials: fakeMaterials() }, sim)
  const fig = (p: Person, y: number) => ({ x: p.position.x, y, z: p.position.z, h: p.dims.H })
  const cast: Cast = {
    fishers: crew.fishers.map(p => fig(p, DECK.top)),
    bank: crew.bankPeople.map(p => fig(p, BANK.top)),
    kite: crew.fitPoints.map(v => [v.x, v.y, v.z] as V3),
  }
  assert(SHOTS.map(s => s.id).join(',') === 'wide,fishers,net,bank', `four shots in the chapter's order (${SHOTS.map(s => s.id).join(', ')})`)
  // The focus boxes as the page measures them (the box stops at the dock's top, SceneChapter.vue):
  // desktop 0.44-1 x 0-0.742 of 1440x900 and 0.44-1 x 0-0.727 of 2560x1080 (21:9), phone 0-0.439 of 390x844.
  const BOX_H = [0.742, 0.727, 0.439]
  const aspects = [0.56 * 1440 / (BOX_H[0]! * 900), 0.56 * 2560 / (BOX_H[1]! * 1080), 390 / (BOX_H[2]! * 844)]
  // The focus boxes' heights in px, for how big a fish draws.
  const boxPx = [BOX_H[0]! * 900, BOX_H[1]! * 1080, BOX_H[2]! * 844]
  let inside = true
  let fishersFill = Infinity
  const fishPx: number[] = []
  const wideFill: number[] = []
  for (const [ai, aspect] of aspects.entries()) {
    const frames = shotFramings(cast, aspect, SHOTS.map(() => newFraming()))
    // The whole machine through its whole tilt in the wide shot.
    if (!contains(frames[0]!, machineSubject(), aspect)) inside = false
    // The net shot holds the lifted net's catch (and the net round it, and the boom's tip over it);
    // going down, the net may leave the frame.
    if (!contains(frames[2]!, catchSubject(), aspect)) inside = false
    // The shortest fish, lying across the view within 35 deg (foreshortened to 0.85 at worst), at the
    // belly's distance from the camera, in px.
    {
      const f = frames[2]!
      const belly = netPoint(netCorners(THETA_UP), 0.5, 0.5, NET.sag) as V3
      const { right } = basis(f.az, f.el)
      const l = FISH_LEN[0] * 0.85
      const a = project(f, belly, aspect)
      const b = project(f, [belly[0] + right[0] * l, belly[1] + right[1] * l, belly[2] + right[2] * l], aspect)
      fishPx.push(Math.abs(b[0] - a[0]) / 2 * boxPx[ai]! * aspect)
    }
    if (!contains(frames[1]!, fishersSubject(cast), aspect) || !contains(frames[3]!, bankSubject(cast), aspect)) inside = false
    // How much of the box a fisher fills: his projected height over the box's.
    {
      const g = cast.fishers[0]!
      const feet = project(frames[1]!, [g.x, g.y, g.z], aspect)
      const head = project(frames[1]!, [g.x, g.y + g.h, g.z], aspect)
      fishersFill = Math.min(fishersFill, (head[1] - feet[1]) / 2)
    }
    // The hero shot: the machine fills the box along whichever side limits it (a three-quarter view is
    // as wide as it is tall, so on a wide box its height does, on a narrow one its width).
    {
      const pr = machineSubject().map(p => project(frames[0]!, p, aspect))
      const span = (k: 0 | 1) => (Math.max(...pr.map(q => q[k])) - Math.min(...pr.map(q => q[k]))) / 2
      wideFill.push(Math.max(span(0), span(1)))
    }
  }
  assert(inside, 'each detail shot keeps its subject inside the focus box at desktop, 21:9 and phone (the lifted net with its catch)')

  // The WHOLE slot, not just the focus box: the view offset extends each shot's frame over the rest of
  // the full-bleed slot (desktop: to the left of the box; phone: below it), and with a perspective
  // camera anything near it there looms. Every person, the kite and every palm that shows anywhere in
  // the slot keeps 6 m from the camera (palms 8 m: their trunks would slice the frame), and a person or
  // the kite stands at most 45% of the slot's height.
  {
    const slots = [
      // Below the box: the dock and the nav's band (desktop), the dock and the panels' (phone).
      { name: '1440x900', aspect: aspects[0]!, u0: -1 - 2 * 0.44 / 0.56, v0: -1 - 2 * (1 - BOX_H[0]!) / BOX_H[0]! },
      { name: '2560x1080', aspect: aspects[1]!, u0: -1 - 2 * 0.44 / 0.56, v0: -1 - 2 * (1 - BOX_H[1]!) / BOX_H[1]! },
      { name: 'phone', aspect: aspects[2]!, u0: -1, v0: -1 - 2 * (1 - BOX_H[2]!) / BOX_H[2]! },
    ]
    type Thing = { name: string, pts: V3[], near: number, tall: boolean }
    const things: Thing[] = []
    crew.people.forEach((p, i) => {
      const y = i < crew.fishers.length ? DECK.top : BANK.top
      const pts: V3[] = []
      for (let k = 0; k <= 6; k++) for (const [dx, dz] of [[0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) pts.push([p.position.x + dx!, y + p.dims.H * k / 6, p.position.z + dz!])
      things.push({ name: i < crew.fishers.length ? `fisher ${i}` : ['watcher', 'visitor', 'child'][i - crew.fishers.length]!, pts, near: 6, tall: true })
    })
    things.push({ name: 'kite', pts: crew.fitPoints.map(v => [v.x, v.y, v.z] as V3), near: 6, tall: false })
    PALMS.forEach((sp, j) => {
      const c = palmPoint(sp, [0, 0], [0, 0], [0, 0, 0])
      const pts: V3[] = []
      for (let k = 0; k <= 10; k++) pts.push([sp.base[0] + (c[0] - sp.base[0]) * k / 10, sp.base[1] + (c[1] - sp.base[1]) * k / 10, sp.base[2] + (c[2] - sp.base[2]) * k / 10])
      things.push({ name: `palm ${j}`, pts, near: 8, tall: false })
    })
    let worst = ''
    let worstNear = Infinity
    let worstTall = 0
    for (const sl of slots) {
      const frames = shotFramings(cast, sl.aspect, SHOTS.map(() => newFraming()))
      frames.forEach((f, si) => {
        for (const t of things) {
          const pr = t.pts.map(p => project(f, p, sl.aspect))
          const shown = pr.some(([u, v, d]) => d > 0 && u >= sl.u0 && u <= 1 && v >= sl.v0 && v <= 1)
          if (!shown) continue
          const dMin = Math.min(...pr.map(q => q[2]))
          if (dMin - t.near < worstNear) {
            worstNear = dMin - t.near
            if (dMin < t.near) worst = `${t.name} ${dMin.toFixed(1)} m from the camera in shot ${si} (${sl.name})`
          }
          if (t.tall) {
            const vs = pr.map(q => q[1])
            const share = (Math.max(...vs) - Math.min(...vs)) / (1 - sl.v0)
            if (share > worstTall) worstTall = share
            if (share > 0.45) worst = `${t.name} ${(share * 100).toFixed(0)}% of the slot's height in shot ${si} (${sl.name})`
          }
        }
      })
    }
    assert(worstNear >= 0 && worstTall <= 0.45, `nothing looms anywhere in the full slot, at every shot and screen: people and the kite 6+ m from the camera and at most 45% of the slot's height, palms 8+ m (tallest ${(worstTall * 100).toFixed(0)}%, closest margin ${worstNear.toFixed(1)} m${worst ? `; ${worst}` : ''})`)
  }
  // (45 px at desktop: the frame also holds the boom's tip and its spreader poles through the whole dip,
  // so the machine never leaves it while the net is down, and the box stops at the dock's top.)
  assert(fishPx[0]! >= 45 && fishPx[1]! >= 45 && fishPx[2]! >= 25, `the net shot is close on the catch: the shortest fish is ${fishPx.map(x => x.toFixed(0)).join(' / ')} px long at 1440x900 / 2560x1080 / phone (at least 45 / 45 / 25)`)
  {
    const a = netFraming(1.2)
    const b = netFraming(1.2)
    assert(JSON.stringify(a) === JSON.stringify(b), 'the net shot is a fixed frame (no camera sliding with the dip): the same framing whatever the boom does')
  }
  assert(fishersFill > 0.25, `the mechanism shot is close enough to see the haulers: a fisher is ${(fishersFill * 100).toFixed(0)}% of the box's height (> 1/4)`)
  // Low cameras: shots 1-3 look down on the machine a little (15 to 30 deg), not on the water.
  const els = SHOTS.slice(1).map(s => ANGLE[s.id].el * 180 / Math.PI)
  assert(els.every(e => e >= 15 && e <= 30), `the detail shots are low views, 15-30 deg down (${els.map(e => e.toFixed(0)).join(', ')} deg)`)
  // The hero shot: from the shore at a man's eye level (1.5-3 m above the water), looking a little up,
  // the horizon (eye level) in the lower third, the machine filling most of the box (70-85% at desktop).
  {
    const f = shotFramings(cast, aspects[0]!, SHOTS.map(() => newFraming()))[0]!
    const eye = cameraAt(f)[1]
    const horizon = Math.tan(f.el) / Math.tan(FOV_DEG * Math.PI / 360)
    assert(eye >= 1.5 && eye <= 3, `the hero shot's camera stands at eye level, ${eye.toFixed(2)} m above the water (1.5-3 m)`)
    assert(horizon <= -1 / 3 && horizon >= -1, `the hero shot's horizon is in the lower third of the box (${((1 - horizon) / 2 * 100).toFixed(0)}% down)`)
    assert(wideFill.every(x => x >= 0.8 && x <= 0.98), `the hero shot's machine fills the box along its limiting side: ${wideFill.map(x => (x * 100).toFixed(0)).join(' / ')}% at 1440x900 / 2560x1080 / phone (80-98%)`)
    // ... seen against the sky from below: the A-frame's top and the raised tip above the horizon.
    const tip = project(f, boomToWorld([BOOM.front, 0, 0], THETA_UP) as V3, aspects[0]!)
    const apex = project(f, FULCRUM as V3, aspects[0]!)
    assert(tip[1] > horizon && apex[1] > horizon, `the hero shot's pivot and raised boom tip stand against the sky (v ${apex[1].toFixed(2)}, ${tip[1].toFixed(2)} above the horizon at ${horizon.toFixed(2)})`)
  }

  // Continuity and monotone zoom between neighbours.
  const frames = shotFramings(cast, aspects[0]!, SHOTS.map(() => newFraming()))
  let jump = 0
  let monotone = true
  const a = newFraming()
  const b = newFraming()
  for (let i = 0; i < SHOT_MAX; i++) {
    let last = framingAt(i, frames, a).dist
    const dir = Math.sign(frames[i + 1]!.dist - frames[i]!.dist)
    for (let k = 1; k <= 400; k++) {
      const p = i + k / 400
      framingAt(p, frames, b)
      framingAt(p - 1 / 400, frames, a)
      jump = Math.max(jump, Math.hypot(b.target[0] - a.target[0], b.target[1] - a.target[1], b.target[2] - a.target[2]), Math.abs(b.az - a.az), Math.abs(b.el - a.el))
      if (dir * (b.dist - last) < -1e-12) monotone = false
      last = b.dist
    }
  }
  assert(jump < 0.08, `framing is continuous in scroll progress (largest move per 1/400 of a shot ${jump.toFixed(3)})`)
  assert(monotone, 'the zoom between neighbouring shots is monotone (an even push-in or pull-out)')
  const at = (p: number) => framingAt(p, frames, newFraming())
  assert(SHOTS.every((_, i) => Math.abs(at(i).dist - frames[i]!.dist) < 1e-9 && Math.abs(at(i).el - frames[i]!.el) < 1e-12), 'at a whole progress the camera is exactly on that shot')

  // The follower: eased, never past the goal, the same at any frame rate.
  const follow = (frameMs: number) => {
    const f = new ShotFollower()
    const clock = new FixedClock()
    let now = 0
    let n = 0
    let over = 0
    const trace: number[] = []
    clock.advance(now, () => {})
    while (n < 1600) {
      now += frameMs
      clock.advance(now, () => {
        const goal = n < 400 ? 1 : n < 800 ? 3 : n < 1200 ? 0.5 : 2
        const before = goal - f.s
        f.step(DT, goal)
        if (Math.sign(goal - f.s) !== Math.sign(before) && goal !== f.s) over++
        trace.push(f.s)
        n++
      })
    }
    return { trace, over }
  }
  const f60 = follow(1000 / 60)
  assert(f60.over === 0, 'the camera never swings past the shot it is heading for')
  assert(JSON.stringify(f60.trace) === JSON.stringify(follow(1000 / 144).trace) && JSON.stringify(f60.trace) === JSON.stringify(follow(1000 / 30).trace), 'shot easing is identical at 30, 60 and 144 Hz')
  assert(Math.abs(f60.trace[399]! - 1) < 1e-3 && Math.abs(f60.trace[30]! - 1) > 0.1, 'the camera eases into a shot (not a cut) and settles on it within 2 s')
  let mono = true
  for (let k = 1; k < 400; k++) if (f60.trace[k]! < f60.trace[k - 1]!) mono = false
  assert(mono, 'scrolling one way moves the camera one way (no wobble)')
}

// ── The catch: fish in the net, the scoop, the basket ────────────────────

{
  const sim = new World(11)
  const crew = await createCrew({ materials: fakeMaterials() }, sim)
  const c4: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
  let shownWet = 0
  let shownSteps = 0
  let outside = 0
  let basketDown = 0
  let lastBasket = 0
  let scoops = 0
  let wasScooping = false
  let scoopReach = -Infinity
  let hoopFar = 0
  let fishBeforeEntry = 0
  const cycles = 8
  for (let n = 0; n < Math.round(cycles * PERIOD / DT); n++) {
    const entering = sim.wet
    sim.step(DT)
    crew.step(DT)
    const cat = crew.catch
    if (!entering && !sim.wet && cat.dips === 0 && cat.count('net') > 0) fishBeforeEntry++
    const inNet = cat.fish.filter(f => f.where === 'net')
    if (inNet.length && crew.netShown) {
      shownSteps++
      if (sim.wet) shownWet++
      // Every fish lies inside the net: its point is a net point, inside the net's own extent.
      const c = netCorners(sim.theta, c4)
      let x0 = Infinity
      let x1 = -Infinity
      let z0 = Infinity
      let z1 = -Infinity
      let y0 = Infinity
      for (let u = 0; u <= 1; u += 0.1) {
        for (let v = 0; v <= 1; v += 0.1) {
          const q = netPoint(c, u, v, sim.sag)
          x0 = Math.min(x0, q[0])
          x1 = Math.max(x1, q[0])
          z0 = Math.min(z0, q[2])
          z1 = Math.max(z1, q[2])
          y0 = Math.min(y0, q[1])
        }
      }
      for (const f of inNet) {
        const q = netPoint(c, f.u, f.v, sim.sag)
        if (f.u < 0.3 || f.u > 0.7 || f.v < 0.3 || f.v > 0.7 || q[0] < x0 || q[0] > x1 || q[2] < z0 || q[2] > z1 || q[1] < y0 - 0.02) outside++
      }
    }
    if (cat.basket < lastBasket) basketDown++
    lastBasket = cat.basket
    if (crew.scoop.scooping) {
      scoopReach = Math.max(scoopReach, crew.fishers[0]!.motion.reachExcess)
      if (!wasScooping) scoops++
      // The scoop never reaches further than its pole: hoop to butt is the pole's length.
      hoopFar = Math.max(hoopFar, Math.abs(crew.scoop.hoop.distanceTo(crew.scoop.butt) - SCOOP.len))
    }
    wasScooping = crew.scoop.scooping
  }
  const cat = crew.catch
  assert(cat.dips >= cycles - 1 && cat.empty >= 1 && cat.empty < cat.dips, `a catch is rolled every dip, and some come up empty (${cat.empty} of ${cat.dips} dips)`)
  assert(shownSteps > 0 && shownWet === 0 && fishBeforeEntry === 0, `fish show in the net only while it is up out of the water (${shownSteps} steps shown, ${shownWet} while wet)`)
  assert(outside === 0, 'every fish lies inside the net, in its belly')
  assert(scoops >= 1 && cat.basket > 0 && basketDown === 0, `the catch is scooped into the basket and the count only goes up (${scoops} scoops, ${cat.basket} fish landed)`)
  assert(scoopReach <= 1e-9 && hoopFar < 1e-9, `the scoop is worked within reach and the pole keeps its length (worst reach ${scoopReach.toFixed(4)} m)`)
  assert(cat.count('hoop') === 0 || crew.scoop.scooping, 'no fish are left in the scoop when it is put away')
}

// ── Arms that look right: plausibility of every person's pose, all cycle ──

type P3v = [number, number, number]
const vadd = (a: P3v, b: P3v): P3v => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const vsub = (a: P3v, b: P3v): P3v => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const vdot = (a: P3v, b: P3v) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const vlerp = (a: P3v, b: P3v, t: number): P3v => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Closest distance between segments ab and cd. */
function segSeg(a: P3v, b: P3v, c: P3v, d: P3v) {
  const s1 = new THREE.Vector3(...a)
  const s2 = new THREE.Vector3(...b)
  const t1 = new THREE.Vector3(...c)
  const t2 = new THREE.Vector3(...d)
  const p = new THREE.Vector3()
  const q = new THREE.Vector3()
  // Sample-refine: robust and plenty for test sizes.
  let best = Infinity
  const seg = new THREE.Line3(t1, t2)
  for (let i = 0; i <= 24; i++) {
    p.lerpVectors(s1, s2, i / 24)
    seg.closestPointToPoint(p, true, q)
    best = Math.min(best, p.distanceTo(q))
  }
  return best
}

/** The posed skeleton of a person in the world, by forward kinematics of the motion's own joint angles. */
function skeleton(p: Person, yOff: number) {
  const m = p.motion
  const P = m.pose
  const d = m.d
  const o = m.offsets
  const toW = (v: Vec3): P3v => {
    const w = m.toWorld(v)
    return [w[0], w[1] + yOff, w[2]]
  }
  const c = Math.cos(m.heading)
  const s = Math.sin(m.heading)
  const dirW = (v: Vec3): P3v => [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]
  const Rp = P.R[B.pelvis]!
  const Rs = mul(Rp, P.R[B.spine]!)
  const spine0 = vadd(P.pelvisPos as P3v, apply(Rp, o[B.spine]!) as P3v)
  const neck = vadd(spine0, apply(Rs, [0, d.spineLen, 0]) as P3v)
  const Rh = mul(Rs, P.R[B.head]!)
  const headC = vadd(vadd(spine0, apply(Rs, o[B.head]!) as P3v), apply(Rh, [0, d.neck + d.headH * 0.5, 0.008 * d.H]) as P3v)
  const arms = ([B.uaL, B.uaR] as const).map((ua) => {
    const so = o[ua]!
    const S = vadd(spine0, apply(Rs, [so[0], so[1] + P.shoulderLift, so[2]]) as P3v)
    const Ru = mul(Rs, P.R[ua]!)
    const E = vadd(S, apply(Ru, o[ua + 1]!) as P3v)
    const Rf = mul(Ru, P.R[ua + 1]!)
    const W = vadd(E, apply(Rf, o[ua + 2]!) as P3v)
    const Rhd = mul(Rf, P.R[ua + 2]!)
    const palm = vadd(W, apply(Rhd, [0, -d.hand * 0.45, 0]) as P3v)
    const fr = P.R[ua + 1]!
    return {
      S: toW(S), E: toW(E), W: toW(W), palm: toW(palm),
      handX: dirW(apply(Rhd, [1, 0, 0])),
      elbowBody: E, shoulderBody: S,
      elbowAngle: Math.atan2(fr[7], fr[8]),
    }
  })
  const legs = ([1, -1] as const).map((side, i) => {
    const fk = fkLeg(m.leg, P.pelvisPos, Rp, side, m.legs[i as 0 | 1])
    return { hip: toW(fk.hip), knee: toW(fk.knee), ankle: toW(fk.ankle) }
  })
  return {
    d, spine0B: spine0, Rs,
    spine0: toW(spine0), neck: toW(neck), head: toW(headC), pelvis: toW(P.pelvisPos as Vec3), heading: m.heading,
    headFwd: dirW(apply(Rh, [0, 0, 1])),
    arms, legs,
    /** Body-frame point -> the spine's own frame (x across the chest, y up it, z out of the chest). */
    toSpine: (w: P3v): P3v => {
      const dx = w[0] - m.pos.x
      const dz = w[2] - m.pos.z
      const b: P3v = [c * dx - s * dz, w[1] - yOff, s * dx + c * dz]
      const r = vsub(b, spine0)
      return [Rs[0] * r[0] + Rs[3] * r[1] + Rs[6] * r[2], Rs[1] * r[0] + Rs[4] * r[1] + Rs[7] * r[2], Rs[2] * r[0] + Rs[5] * r[1] + Rs[8] * r[2]]
    },
  }
}

{
  const sim = new World(11)
  const crew = await createCrew({ materials: fakeMaterials() }, sim)
  const frameY = (p: Person) => (crew.fishers.includes(p) ? DECK.top : BANK.top)
  const names = ['fisher (rope 0)', 'fisher (rope 1)', 'watcher', 'visitor', 'child']
  const worst = { torso: 0, head: 0, arms: 0, side: 0, invert: 0, palm: 1, rope: Infinity, cloth: Infinity, pole: Infinity, spacing: Infinity, handV: 0, palmV: 0, shoulderV: 0, headHand: Infinity, stroke: Infinity }
  const where = { torso: '', head: '', arms: '', side: '', invert: '', palm: '', rope: '', cloth: '', pole: '', spacing: '', handV: '', palmV: '', shoulderV: '', headHand: '', stroke: '' }
  /** Gaze of the fishers on the net while it goes down and soaks: steps within 30 deg, of all. */
  /**
   * Per fisher, steps of the lower and soak, those looking at the net (within
   * 30 deg of it, or, where the net is behind him, of the furthest round a
   * head turns over the shoulder with both hands on a rope in front: GAZE_TURN).
   */
  const GAZE_TURN = 70
  const gazeOn = [0, 0]
  let gazeAll = 0
  let gazeWorst = 0
  /** Last step's palms and shoulders (world) per person, for speeds. */
  let prevJ: P3v[][] | null = null
  /** Per fisher and hand: where (along the rope) the current lift grip started. */
  const strokeFrom = crew.fishers.map(() => [NaN, NaN])
  const dbg = new Map<string, [number, string]>()
  const note = (k: keyof typeof worst, v: number, msg: string, bad: (a: number, b: number) => boolean) => {
    const key = k + ' | ' + msg.split(' at ')[0] + (msg.includes(': ') ? ' | ' + msg.split(': ').pop() : '') + (msg.includes('scooping') ? ' scoop' : '')
    const cur = dbg.get(key)
    if (!cur || bad(v, cur[0])) dbg.set(key, [v, msg])
    if (bad(v, worst[k])) {
      worst[k] = v
      where[k] = msg
    }
  }
  const cycles = 4
  for (let n = 0; n < Math.round(cycles * PERIOD / DT); n++) {
    sim.step(DT)
    crew.step(DT)
    // Every step: nothing jumps. A hand moves at most 4 m/s, a shoulder 1 m/s.
    {
      const sk = crew.people.map(p => skeleton(p, frameY(p)))
      const joints = sk.map(k => [k.arms[0]!.palm, k.arms[1]!.palm, k.arms[0]!.S, k.arms[1]!.S, k.arms[0]!.W, k.arms[1]!.W])
      if (prevJ) {
        joints.forEach((js, i) => js.forEach((j, q) => {
          const v = Math.hypot(...vsub(j, prevJ![i]![q]!)) / DT
          const msg = `${names[i]} ${q < 2 ? 'hand' : q < 4 ? 'shoulder' : 'wrist'} at ${sim.phase} t=${(n * DT).toFixed(2)}${i >= crew.fishers.length && crew.reacting(i - crew.fishers.length) ? ` (hit: ${crew.beat(i - crew.fishers.length)})` : ''}${i === 0 && crew.scoop.scooping ? ' (scooping)' : ''}`
          note(q < 2 ? 'handV' : q < 4 ? 'shoulderV' : 'palmV', v, msg, (a, b) => a > b)
        }))
      }
      prevJ = joints
      // Haul strokes: how far each gripping hand draws the rope in, grip to release (lift only).
      crew.fishers.forEach((_, i) => {
        if (i === 0 && (crew.scoop.scooping || crew.regripping)) return
        const g = crew.hauls[i]!
        for (const k of [0, 1] as const) {
          const hauling = sim.phase === 'lift' && g.grip[k] && g.off[k] === 0
          if (hauling && Number.isNaN(strokeFrom[i]![k]!)) strokeFrom[i]![k] = g.h[k]
          else if (!hauling && !Number.isNaN(strokeFrom[i]![k]!)) {
            const len = g.h[k] - strokeFrom[i]![k]!
            // A stroke cut short by the end of the lift is the last half-stroke home; count full ones.
            if (sim.phase === 'lift') note('stroke', len, `${names[i]} t=${(n * DT).toFixed(2)}`, (a, b) => a < b)
            strokeFrom[i]![k] = NaN
          }
        }
      })
    }
    if (n % 4) continue
    const tag = (i: number) => `${names[i]} at ${sim.phase} t=${(n * DT).toFixed(2)}${crew.scoop.scooping && i === 0 ? ' (scooping)' : ''}${i >= crew.fishers.length && crew.reacting(i - crew.fishers.length) ? ` (hit: ${crew.beat(i - crew.fishers.length)})` : ''}`
    const skels = crew.people.map(p => skeleton(p, frameY(p)))
    skels.forEach((k, i) => {
      const d = k.d
      const rArm = d.arm * 0.45
      const handOnHead = crew.reacting(i - crew.fishers.length)
      k.arms.forEach((a, side) => {
        // Arm segments, sampled, against the torso's own box (in the spine frame).
        // The upper arm from 60% of its length: in this rig the shoulder joint
        // itself sits just inside the chest's outline (shoulderX < torsoW), so
        // the top of any upper arm swung forward is inside it by construction.
        const segs: [P3v, P3v, number][] = [[a.S, a.E, 0.6], [a.E, a.W, 0]]
        for (const [p0, p1, skip] of segs) {
          for (let t = skip; t <= 1.0001; t += 0.1) {
            const q = k.toSpine(vlerp(p0, p1, t))
            // The torso's cross-section: an ellipse as wide as its outline at that
            // height (narrow at the waist, widest at the chest) and as deep as the
            // body, grown by the arm's radius. How far inside it the arm's axis is.
            const f = Math.min(1, Math.max(0, q[1] / (0.62 * d.spineLen)))
            const hw = d.torsoW * (0.78 + 0.16 * f) + rArm
            const hd = d.torsoD * 0.5 + rArm
            const e = Math.hypot(q[0] / hw, q[2] / hd)
            const inY = q[1] > 0.05 * d.spineLen && q[1] < 0.85 * d.spineLen
            if (e < 1 && inY) note('torso', (1 - e) * Math.min(hw, hd), tag(i), (v, w) => v > w)
          }
        }
        // ... the head (a hand put to the head on purpose may touch it, the forearm may not).
        for (const [p0, p1] of [[a.S, a.E], [a.E, vlerp(a.E, a.W, handOnHead ? 0.6 : 1)]] as [P3v, P3v][]) {
          // The head is narrower than it is tall: half its width, and a hair.
          const dh = segSeg(p0, p1, k.head, k.head) - (d.headW * 0.5 + 0.01 + rArm)
          note('head', -dh, tag(i), (v, w) => v > w)
        }
        // Elbows: on their own side of the body, and bending the right way.
        const lat = (side === 0 ? 1 : -1) * (a.elbowBody[0] - k.spine0B[0])
        note('side', -lat, tag(i), (v, w) => v > w)
        note('invert', Math.max(a.elbowAngle - 1e-6, -ELBOW_MAX - a.elbowAngle), tag(i), (v, w) => v > w)
      })
      // The two arms against each other (forearms and upper arms).
      const [L, R] = k.arms
      const pen = 2 * rArm - Math.min(segSeg(L!.E, vlerp(L!.E, L!.W, 0.8), R!.E, vlerp(R!.E, R!.W, 0.8)), segSeg(L!.S, L!.E, R!.S, R!.E))
      note('arms', pen, tag(i), (v, w) => v > w)
    })
    // Fishers on the rope: an overhand grip -- the palm faces down onto it
    // (its normal, out of the rope toward the palm, within 45 deg of up).
    crew.fishers.forEach((f, i) => {
      if (i === 0 && (crew.scoop.scooping || crew.regripping)) return
      const g = crew.hauls[i]!
      for (const k of [0, 1] as const) {
        if (g.off[k] !== 0) continue
        const side = k === 0 ? crew.lead[i]! : crew.lead[i] === 'left' ? 'right' : 'left'
        const sg = side === 'left' ? 1 : -1
        const a = skels[i]!.arms[side === 'left' ? 0 : 1]!
        note('palm', a.handX[1] * sg, tag(i), (v, w) => v < w)
      }
      // ... and the two hands on it keep apart.
      const [L, R] = skels[i]!.arms
      note('spacing', Math.hypot(...vsub(L!.palm, R!.palm)), tag(i), (v, w) => v < w)
    })
    // The scoop's two hands on the pole keep apart too.
    if (crew.scoop.scooping) {
      const [L, R] = skels[0]!.arms
      note('spacing', Math.hypot(...vsub(L!.palm, R!.palm)), tag(0), (v, w) => v < w)
    }
    // Every palm clear of its own head: a hand put to the head rests on it, not in it (nor in a headscarf).
    skels.forEach((k, i) => {
      const p = crew.people[i]!
      const r = k.d.headW * 0.5 + (p.dims.headscarf ? 0.02 : 0)
      for (const a of k.arms) note('headHand', Math.hypot(...vsub(a.palm, k.head)) - r, tag(i), (v, w) => v < w)
    })
    // The fishers watch the net while it goes down and soaks (eyes on the work, not on their hands).
    if (sim.phase === 'lower' || sim.phase === 'soak') {
      const nc = boomToWorld([8, -NET.drop + 0.3, 0], sim.theta)
      crew.fishers.forEach((_, i) => {
        const k = skels[i]!
        const to = vsub(nc as P3v, k.head)
        const l = Math.hypot(...to)
        // The net's bearing from his facing, turned no further than a head goes.
        const f = crew.fishers[i]!
        const rel = Math.atan2(Math.sin(Math.atan2(to[0], to[2]) - f.heading), Math.cos(Math.atan2(to[0], to[2]) - f.heading))
        const yaw = f.heading + Math.sign(rel) * Math.min(Math.abs(rel), GAZE_TURN * Math.PI / 180)
        const pitch = Math.asin(to[1] / l)
        const want: P3v = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
        const ang = Math.acos(Math.max(-1, Math.min(1, vdot(k.headFwd, want)))) * 180 / Math.PI
        if (i === 0) gazeAll++
        if (ang <= 30) gazeOn[i]!++
        gazeWorst = Math.max(gazeWorst, ang)
      })
    }
    // Ropes: clear of every body by 3 cm, but for the hands (and wrists) holding them.
    const runs: { a: P3v, b: P3v, holder: number, near?: 'a' | 'b' }[] = []
    ROPES.forEach((r, i) => {
      const fr = ropeFrom(i, sim.theta)
      const to = ropeTo(i) as P3v
      runs.push({ a: fr as P3v, b: to, holder: -1 })
      if (crew.ropeHeld[i]) {
        const te = tailEnds(i)
        runs.push({ a: to, b: te.e as P3v, holder: i, near: 'b' }, { a: te.e as P3v, b: te.c as P3v, holder: i, near: 'a' })
      }
      // Let go (the scoop): it drops from the block to the deck in front of him (as the scene draws it).
      else runs.push({ a: to, b: [to[0] + TAIL[i]![0] * 0.3, DECK.top + 0.01, to[2] + TAIL[i]![1] * 0.3], holder: -1 })
    })
    // The scoop pole: clear of every body by 2 cm but for fisher 0's hands on it.
    {
      const holding = crew.scoop.scooping
      skels.forEach((k, i) => {
        const d = k.d
        const caps: [P3v, P3v, number, string][] = [
          [k.spine0, k.neck, d.torsoD * 0.5, 'torso'], [k.head, k.head, d.headH * 0.42, 'head'],
          ...k.legs.flatMap(l => [[l.hip, l.knee, d.thigh * 0.5, 'thigh'], [l.knee, l.ankle, d.calf * 0.5, 'shin']] as [P3v, P3v, number, string][]),
          ...k.arms.flatMap(a => [[a.S, a.E, d.arm * 0.5, 'upper arm'], [a.E, vlerp(a.E, a.W, holding && i === 0 ? 0.3 : 1), d.arm * 0.45, 'forearm']] as [P3v, P3v, number, string][]),
        ]
        const b = crew.scoop.butt
        const h = crew.scoop.hoop
        for (const [p0, p1, r, part] of caps) {
          const clear = segSeg([b.x, b.y, b.z], [h.x, h.y, h.z], p0, p1) - r - SCOOP.poleR
          note('pole', clear, `${tag(i)}: ${part}`, (v, w) => v < w)
        }
      })
    }
    const ropeR = 0.024
    for (const run of runs) {
      skels.forEach((k, i) => {
        const d = k.d
        const caps: [P3v, P3v, number, string][] = [
          [k.spine0, k.neck, d.torsoD * 0.5, 'torso'], [k.head, k.head, d.headH * 0.42, 'head'],
          ...k.legs.flatMap(l => [[l.hip, l.knee, d.thigh * 0.5, 'thigh'], [l.knee, l.ankle, d.calf * 0.5, 'shin']] as [P3v, P3v, number, string][]),
          // A hand on the rope brings its forearm to it: only the elbow end of that forearm counts.
          ...k.arms.flatMap(a => [[a.S, a.E, d.arm * 0.5, 'upper arm'], [a.E, vlerp(a.E, a.W, run.holder === i ? 0.3 : 1), d.arm * 0.45, 'forearm']] as [P3v, P3v, number, string][]),
        ]
        for (const [p0, p1, r, part] of caps) {
          const clear = segSeg(run.a, run.b, p0, p1) - r - ropeR
          note('rope', clear, `${tag(i)}: ${part}`, (v, w) => v < w)
        }
        // A mundu or skirt: the cloth's outer surface (an ellipse about the
        // pelvis, as wide as the hem flares and as deep as the cloth), from the
        // waist to the hem. The rope's 12 cm next to the holder's own hands may
        // lie against his front.
        if (d.hem > 0 && (d.lower === 'mundu' || d.lower === 'skirt')) {
          const H = d.H
          const c = Math.cos(k.heading)
          const sn = Math.sin(k.heading)
          const len = Math.hypot(...vsub(run.b, run.a))
          for (let q = 0; q <= 40; q++) {
            const along = q / 40 * len
            if (run.holder === i && (run.near === 'a' ? along < 0.12 : len - along < 0.12)) continue
            const w = vlerp(run.a, run.b, q / 40)
            const dy = w[1] - k.pelvis[1]
            if (dy > d.waistY || dy < -d.hem) continue
            const dx = w[0] - k.pelvis[0]
            const dz = w[2] - k.pelvis[2]
            const lx = c * dx - sn * dz
            const lz = sn * dx + c * dz - 0.007 * H
            const f = Math.min(1, Math.max(0, -dy / d.hem))
            const A = d.hemW0 + (d.hemW1 * 1.06 - d.hemW0) * f + ropeR
            const Bz = 0.075 * H * d.build + ropeR
            const e = Math.hypot(lx / A, lz / Bz)
            note('cloth', (e - 1) * Math.min(A, Bz), `${tag(i)}: cloth`, (v, x) => v < x)
          }
        }
      })
    }
  }
  if (process.env.BW_DEBUG) for (const [k, [v, m]] of [...dbg.entries()].sort()) console.log('DBG', k.padEnd(48), v.toFixed(3), m)
  // 2.5 cm: the people library's own idle arms rest 2.0 cm into this simplified (elliptical) torso, so that is contact, not a pass-through.
  assert(worst.torso <= 0.025, `no arm passes into a torso, over ${cycles} cycles of the haul, the scoop and the coconut reactions (worst ${(worst.torso * 100).toFixed(1)} cm: ${where.torso || 'none'})`)
  assert(worst.head <= 0.01, `no arm passes through a head (worst ${(worst.head * 100).toFixed(1)} cm: ${where.head || 'none'})`)
  assert(worst.arms <= 0.01, `the two arms never run through each other (worst ${(worst.arms * 100).toFixed(1)} cm: ${where.arms || 'none'})`)
  assert(worst.side <= 0.01, `elbows stay on their own side of the body (worst ${(worst.side * 100).toFixed(1)} cm across: ${where.side || 'none'})`)
  assert(worst.invert <= 1e-6, `elbows only ever bend the right way (worst ${worst.invert.toExponential(1)} rad: ${where.invert || 'none'})`)
  assert(worst.palm >= Math.cos(Math.PI / 4), `palms grip the rope overhand, facing down onto it within 45 deg (worst ${(Math.acos(Math.max(-1, Math.min(1, worst.palm))) * 180 / Math.PI).toFixed(0)} deg: ${where.palm})`)
  assert(worst.spacing >= 0.12, `two hands on one rope or pole stay 12 cm apart (closest ${(worst.spacing * 100).toFixed(1)} cm: ${where.spacing})`)
  assert(worst.stroke >= 0.12, `every haul stroke draws at least 12 cm of rope (shortest ${(worst.stroke * 100).toFixed(1)} cm: ${where.stroke})`)
  assert(worst.pole >= 0.02, `the scoop pole keeps 2 cm clear of every body but the hands on it, stored and in use (closest ${(worst.pole * 100).toFixed(1)} cm: ${where.pole})`)
  assert(worst.handV <= 4, `no hand jumps: a hand (palm) moves at most 4 m/s (fastest ${worst.handV.toFixed(2)} m/s: ${where.handV})`)
  // The wrist also swings with the hand's turn about the palm when a grip changes kind, which the people library blends.
  console.log(`INFO: fastest wrist ${worst.palmV.toFixed(2)} m/s: ${where.palmV}`)
  assert(worst.shoulderV <= 1, `no shoulder jumps: at most 1 m/s (fastest ${worst.shoulderV.toFixed(2)} m/s: ${where.shoulderV})`)
  assert(worst.headHand >= 0, `no palm sinks into a head (closest ${(worst.headHand * 100).toFixed(1)} cm: ${where.headHand})`)
  // Most of the time, not all: they glance down at their hands as they take new grips (the soak's re-grip).
  const gazeShare = gazeOn.map(x => x / Math.max(1, gazeAll))
  assert(Math.min(...gazeShare) >= 0.6, `the fishers watch the net while it goes down and soaks: within 30 deg of it (or of as far round as a head turns, ${GAZE_TURN} deg, when it is behind) ${gazeShare.map(x => (100 * x).toFixed(0)).join('% / ')}% of the time (at least 60%; worst ${gazeWorst.toFixed(0)} deg, glancing at the hands)`)
  assert(worst.cloth >= 0.01, `the ropes stay outside a mundu's cloth (its flare to the hem), but against the holder's own hands (closest ${(worst.cloth * 100).toFixed(1)} cm: ${where.cloth})`)
  assert(worst.rope >= 0.03, `the ropes keep 3 cm clear of every body but the hands on them (closest ${(worst.rope * 100).toFixed(1)} cm: ${where.rope})`)
}

// ── No z-fighting in the rigid assemblies ────────────────────────────────
// Two faces on one plane, facing the same way and overlapping, fight for the
// same pixels and shimmer as the scroll moves the camera (the far shore's land
// and its stone edge once shared their front face). Every face's interior is
// sampled; no sample may lie strictly inside another coplanar, same-facing face.

{
  const { buildGround, buildBoom, buildStones } = await import('../app/three/scenes/backwater/cheenavala')
  const mats = fakeMaterials()
  for (const [name, group] of [['ground', buildGround(mats)], ['boom', buildBoom(mats)], ['stones', buildStones(mats)]] as const) {
    group.updateMatrixWorld(true)
    type Tri = { a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3, mesh: string }
    const planes = new Map<string, Tri[]>()
    group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const pos = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry).getAttribute('position')
      for (let i = 0; i < pos.count; i += 3) {
        const [a, b, c] = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, i + k).applyMatrix4(mesh.matrixWorld))
        const n = new THREE.Vector3().crossVectors(b!.clone().sub(a!), c!.clone().sub(a!))
        if (n.lengthSq() < 1e-14) continue
        n.normalize()
        const key = [n.x, n.y, n.z, n.dot(a!)].map(v => (Math.round(v * 1e3) / 1e3 + 0).toFixed(3)).join()
        const list = planes.get(key) ?? []
        list.push({ a: a!, b: b!, c: c!, n, mesh: mesh.name })
        planes.set(key, list)
      }
    })
    const tri = new THREE.Triangle()
    const bary = new THREE.Vector3()
    const p = new THREE.Vector3()
    const fights = new Set<string>()
    for (const list of planes.values()) {
      if (list.length < 2) continue
      for (const s of list) {
        const centroid = s.a.clone().add(s.b).add(s.c).divideScalar(3)
        for (const t of list) {
          if (t === s) continue
          tri.set(t.a, t.b, t.c)
          // The centroid and three points pulled in from the corners: strictly inside, never on a shared edge.
          const hit = [centroid, s.a, s.b, s.c].some((q) => {
            p.copy(q).lerp(centroid, q === centroid ? 0 : 0.2)
            tri.getBarycoord(p, bary)
            return Math.min(bary.x, bary.y, bary.z) > 1e-3 && Math.abs(t.n.dot(p) - t.n.dot(t.a)) < 1e-3
          })
          if (hit) fights.add(`${s.mesh} / ${t.mesh} at (${centroid.toArray().map(v => v.toFixed(2)).join(', ')})`)
        }
      }
    }
    assert(fights.size === 0, `${name}: no two coplanar same-facing faces overlap (z-fighting)${fights.size ? `: ${[...fights].slice(0, 5).join('; ')}` : ''}`)
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll backwater checks passed')
