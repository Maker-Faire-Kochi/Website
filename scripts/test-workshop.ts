import * as THREE from 'three'
import { DT, FixedClock } from '../app/three/core/clock'
import type { Materials, MatKey } from '../app/three/core/kit'
import { createPerson } from '../app/three/people/person'
import { B } from '../app/three/people/motion'
import { Carpenter } from '../app/three/scenes/workshop/carpenter'
import {
  BOARD, CARPENTER, CHISEL, H, MALLET, MIRROR, PLANE, REST, SAW, STOOL_PARTS,
  stoolPartPosition, type ToolKey,
} from '../app/three/scenes/workshop/layout'
import { PEAK } from '../app/three/core/voice'
import { eulerXYZ } from '../app/three/scenes/workshop/grips'
import { PHASE, SNAP, WorkshopSim, sawTeethY, type WorkshopEvent } from '../app/three/scenes/workshop/sim'
import { workshopSound } from '../app/three/scenes/workshop/sound'
import { DURATION, MAX_QUEUE, phaseOf, type Tool } from '../app/three/scenes/workshop/timeline'

/**
 * Pure-logic checks for the workshop scene (section 3): the action loop, the
 * tools staying on the work, the stool's exploded view, the particles,
 * determinism, the sound hooks (each blow, seat and tap fires exactly once;
 * the rasp only on the push) and the voices' peak level and silence on pause,
 * against a stand-in AudioContext. Run: npx --yes tsx scripts/test-workshop.ts
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

const EPS = 1e-9
const TOOLS: ToolKey[] = ['saw', 'plane', 'chisel', 'mallet']
const OWNER: Record<ToolKey, Tool> = { saw: 'saw', plane: 'plane', chisel: 'chisel', mallet: 'chisel' }
const atRest = (sim: WorkshopSim, k: ToolKey) => sim.pose[k].every((v, i) => v === REST[k][i])

function snap(sim: WorkshopSim) {
  return Array.from(sim.snapshot(new Float64Array(SNAP.size)))
    .concat(Array.from(sim.particles.pos.slice(0, sim.particles.count * 3)))
}

// ── 1. One tool at a time, a calm deterministic loop ─────────────────────
{
  const sim = new WorkshopSim(7)
  let overlap = 0
  let moved = 0
  const order: Tool[] = []
  let last: Tool | null = null
  for (let i = 0; i < 200 * 120; i++) {
    sim.step(DT)
    const cur = sim.timeline.current
    if (cur && cur !== last) order.push(cur)
    last = cur
    for (const k of TOOLS) {
      if (atRest(sim, k)) continue
      moved++
      if (OWNER[k] !== cur) overlap++
    }
  }
  assert(moved > 0, 'tools leave their rest poses at all')
  assert(overlap === 0, `only the current action's tool is ever off its rest pose (violations: ${overlap})`)
  assert(order.slice(0, 6).join(',') === 'saw,plane,chisel,saw,plane,chisel', `automatic order is saw, plane, chisel, repeating (${order.slice(0, 6).join(',')})`)
  const durOk = Object.values(DURATION).every(d => d >= 3.5 && d <= 7.5)
  assert(durOk, 'each action lasts about 4-7 s (reach, fetch, work, put back)')
}

// ── 2. Taps queue in order behind the working tool ───────────────────────
{
  const sim = new WorkshopSim(7)
  while (sim.timeline.current !== 'saw') sim.step(DT)
  const r1 = sim.request('chisel')
  const r2 = sim.request('plane')
  const r3 = sim.request('saw')
  const r4 = sim.request('plane')
  assert(r1 === 'queued' && r2 === 'queued' && r3 === 'queued', 'taps while sawing are queued')
  assert(MAX_QUEUE === 3 && r4 === 'full', 'the queue is capped')
  const started: Tool[] = []
  let last: Tool | null = 'saw'
  for (let i = 0; i < 200 * 40 && started.length < 4; i++) {
    sim.step(DT)
    const cur = sim.timeline.current
    if (cur && cur !== last) started.push(cur)
    last = cur
  }
  assert(started.slice(0, 3).join(',') === 'chisel,plane,saw', `queued taps run in order after the saw (${started.join(',')})`)
  assert(started[3] === 'plane', 'the automatic loop resumes after the queue drains (next auto: plane)')

  const idle = new WorkshopSim(7)
  assert(idle.request('plane') === 'started', 'a tap while idle starts at once')
  const busy = new WorkshopSim(7)
  busy.request('saw')
  busy.request('plane')
  busy.clearQueue()
  let ranPlane = false
  for (let i = 0; i < 200 * 5; i++) {
    busy.step(DT)
    if (busy.timeline.current === 'plane') ranPlane = true
  }
  assert(!ranPlane, 'clearing the queue (pause) drops queued taps')
}

// ── 3. The stool returns exactly to its assembled transforms ─────────────
{
  const base = STOOL_PARTS.map(p => p.base.slice())
  const pos: [number, number, number] = [0, 0, 0]
  const exact = (u: number) => STOOL_PARTS.every((p, i) => {
    stoolPartPosition(p, u, pos)
    return pos[0] === base[i]![0] && pos[1] === base[i]![1] && pos[2] === base[i]![2]
  })
  const sim = new WorkshopSim(7)
  sim.toggleStool()
  for (let i = 0; i < 200 * 2; i++) sim.step(DT)
  assert(sim.stoolU === 1, 'a tap explodes the stool fully')
  stoolPartPosition(STOOL_PARTS[0]!, 1, pos)
  const seatLift = pos[1] - base[0]![1]!
  assert(seatLift > 0.15, `the seat lifts clear (${seatLift.toFixed(3)} m)`)
  sim.toggleStool()
  for (let i = 0; i < 200 * 2; i++) sim.step(DT)
  assert(sim.stoolU === 0 && exact(sim.stoolU), 'a second tap reassembles it to the exact assembled transforms')

  // The automatic show (after the chisel) explodes, holds, and closes by itself.
  const auto = new WorkshopSim(7)
  let peak = 0
  let closedAfterPeak = false
  for (let i = 0; i < 200 * 30; i++) {
    auto.step(DT)
    peak = Math.max(peak, auto.stoolU)
    if (peak === 1 && auto.stoolU === 0) closedAfterPeak = true
  }
  assert(peak === 1 && closedAfterPeak && exact(auto.stoolU), 'the automatic stool show opens fully and closes exactly')

  // Frame order: the seat leads on the way out and trails on the way back.
  const seat = STOOL_PARTS.findIndex(p => p.kind === 'seat')
  const leg = STOOL_PARTS.findIndex(p => p.kind === 'leg')
  stoolPartPosition(STOOL_PARTS[seat]!, 0.3, pos)
  const seatMoved = pos[1] !== base[seat]![1]
  stoolPartPosition(STOOL_PARTS[leg]!, 0.3, pos)
  const legStill = pos[0] === base[leg]![0]
  assert(seatMoved && legStill, 'the seat lifts before the legs spread (and drops on last)')
}

// ── 4. Tools stay on the work ────────────────────────────────────────────
{
  const sim = new WorkshopSim(7)
  let sawSteps = 0
  let sawBad = 0
  let toeBad = 0
  let kerfMax = 0
  let planeSteps = 0
  let planeBad = 0
  let chiselBad = 0
  let faceBad = 0
  let blows = 0
  let lastMortise = 0
  for (let i = 0; i < 200 * 45; i++) {
    sim.step(DT)
    const cur = sim.timeline.current
    const ph = cur ? phaseOf(cur, sim.timeline.t).name : null
    if (cur === 'saw' && ph === 'work') {
      sawSteps++
      const p = sim.pose.saw
      const kerfBottom = BOARD.top - sim.kerf
      // In its kerf: blade in the board's middle plane, teeth through the kerf bottom at the end grain.
      if (p[2] !== BOARD.z || p[5] !== -SAW.angle || Math.abs(sawTeethY(p, BOARD.x1) - kerfBottom) > EPS) sawBad++
      if (sim.kerf > SAW.maxDepth + EPS) sawBad++
      // Inside the board, the teeth never go below the kerf they have cut.
      for (let x = BOARD.x1 - 0.2; x <= BOARD.x1; x += 0.01) {
        const kerfAt = kerfBottom + (BOARD.x1 - x) * Math.tan(SAW.angle)
        if (sawTeethY(p, x) < kerfAt - EPS) sawBad++
      }
      // The toe, beyond the board, stays above the bench top.
      if (p[1]! <= H) toeBad++
      kerfMax = Math.max(kerfMax, sim.kerf)
    }
    if (cur === 'plane' && ph === 'work') {
      planeSteps++
      const p = sim.pose.plane
      const onEdge = p[1] === BOARD.top && p[2] === BOARD.z && p[3] === 0 && p[4] === 0 && p[5] === 0
      const onBoard = p[0]! - PLANE.len / 2 >= BOARD.x0 && p[0]! + PLANE.len / 2 <= BOARD.x1
      if (!onEdge || !onBoard) planeBad++
    }
    if (cur === 'chisel' && ph === 'work') {
      const c = sim.pose.chisel
      if (c[0] !== CHISEL.x || c[2] !== BOARD.z || Math.abs(c[1]! - (BOARD.top - sim.mortise)) > EPS) chiselBad++
      // The striking face never passes through the chisel top.
      const m = sim.pose.mallet
      const th = m[5]!
      const faceY = m[1]! - MALLET.R * Math.sin(th) - MALLET.hh * Math.cos(th)
      const top = c[1]! + CHISEL.len
      if (faceY < top - 1e-6) faceBad++
      if (sim.mortise > lastMortise) blows++
      lastMortise = sim.mortise
    }
  }
  assert(sawSteps > 0 && sawBad === 0, `saw rides its kerf: teeth on the kerf bottom, never below it (${sawSteps} work steps)`)
  assert(toeBad === 0, 'saw toe stays above the bench top')
  assert(kerfMax > 0.03 && kerfMax <= SAW.maxDepth, `kerf deepens to ${(kerfMax * 1000).toFixed(1)} mm (max ${SAW.maxDepth * 1000} mm)`)
  assert(planeSteps > 0 && planeBad === 0, 'plane glides with its sole on the board edge, wholly on the board')
  assert(chiselBad === 0, 'chisel stands on the mortise bottom while it is struck')
  assert(faceBad === 0, 'mallet face meets the chisel top but never passes through it')
  assert(blows === PHASE.BLOWS * 2, `each chisel action lands ${PHASE.BLOWS} blows (${blows} over two actions)`)
}

// ── 5. Particles and the shaving never fall through the floor ────────────
{
  const sim = new WorkshopSim(11)
  let below = 0
  let floating = 0
  let maxCount = 0
  let shavingLanded = false
  for (let i = 0; i < 200 * 90; i++) {
    if (i === 200 * 3) sim.request('saw')
    if (i === 200 * 5) sim.request('chisel')
    sim.step(DT)
    const P = sim.particles
    maxCount = Math.max(maxCount, P.count)
    for (let j = 0; j < P.count; j++) {
      const y = P.pos[j * 3 + 1]!
      if (y < 0) below++
      if (P.resting[j] && ![0, H, BOARD.top].some(s => Math.abs(y - s) < 1e-6)) floating++
    }
    const s = sim.shaving
    if (!s.attached && s.L > 0 && s.y - s.radius < -1e-9) below++
    if (s.resting) shavingLanded = true
  }
  assert(maxCount > 40, `sawdust and chips are produced (${maxCount} live in the ring)`)
  assert(maxCount <= sim.particles.capacity, 'particles stay inside the fixed preallocated buffer')
  assert(below === 0, 'no particle or shaving ever falls below the floor')
  assert(floating === 0, 'every settled particle rests on a real surface (floor, bench top, board edge)')
  assert(shavingLanded, 'the shaving breaks free after the stroke and comes to rest')
}

// ── 6. Determinism: same seed + same step count = same state ─────────────
{
  const a = new WorkshopSim(5)
  const b = new WorkshopSim(5)
  // Drive A at 60 Hz and B at 144 Hz through the stage's fixed clock, reading
  // a snapshot every frame as the renderer does, until both reach N steps.
  const N = 200 * 40
  const run = (sim: WorkshopSim, hz: number) => {
    const clock = new FixedClock()
    let steps = 0
    let now = 0
    const out = new Float64Array(SNAP.size)
    clock.advance(now, () => {})
    while (steps < N) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (steps < N) {
          sim.step(DT)
          steps++
        }
      })
      sim.snapshot(out)
    }
    return steps
  }
  const na = run(a, 60)
  const nb = run(b, 144)
  const sa = snap(a)
  const sb = snap(b)
  assert(na === N && nb === N, `both reach ${N} steps`)
  assert(sa.length === sb.length && sa.every((v, i) => Object.is(v, sb[i])), 'state is bit-identical at 60 Hz and 144 Hz')

  const c = new WorkshopSim(6)
  for (let i = 0; i < N; i++) c.step(DT)
  const sc = snap(c)
  assert(sc.some((v, i) => v !== sa[i]), 'a different seed gives different dust (the seed is actually used)')
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

// ── 7. Sound hooks: each physical event fires exactly once, in step ──────
{
  const sim = new WorkshopSim(7)
  const counts = { knock: 0, explode: 0, frame: 0, seat: 0, tap: 0 }
  let knockBad = 0
  let lastMortise = 0
  let blowsSeen = 0
  let order = ''
  let raspBad = 0
  let raspSteps = 0
  let pullSteps = 0
  let swishBad = 0
  let swishSteps = 0
  let prevSawX = sim.pose.saw[0]!
  let landedDust = 0
  let landedChips = 0
  let stoolOpens = 0
  let stoolCloses = 0
  let prevU = 0
  for (let i = 0; i < 200 * 45; i++) {
    if (i === 200 * 2) sim.requestPuff(0.1, H, -0.1)
    if (i === 200 * 3) sim.toggleStool()
    if (i === 200 * 4) sim.toggleStool()
    sim.step(DT)
    const cur = sim.timeline.current
    const ph = cur ? phaseOf(cur, sim.timeline.t) : null
    for (const e of sim.events) {
      if (e.kind === 'knock') {
        counts.knock++
        // The knock lands on exactly the step the blow deepens the mortise.
        if (sim.mortise <= lastMortise || e.blow !== blowsSeen % PHASE.BLOWS) knockBad++
        blowsSeen++
      }
      else if (e.kind === 'seat') {
        counts[e.part]++
        order += e.part[0]
      }
      else {
        counts[e.kind]++
        if (e.kind === 'explode') order += 'x'
      }
    }
    if (sim.mortise > lastMortise && !sim.events.some(e => e.kind === 'knock')) knockBad++
    lastMortise = sim.mortise
    if (prevU === 0 && sim.stoolU > 0) stoolOpens++
    if (prevU > 0 && sim.stoolU === 0) stoolCloses++
    prevU = sim.stoolU
    // Rasp only on the push (the saw moving toward its toe, +x), silent on the pull.
    // (From the second work step: on the first the fetch arc hands over at zero speed.)
    const sawWork = cur === 'saw' && ph!.name === 'work' && ph!.t > DT / 2
    const dx = sim.pose.saw[0]! - prevSawX
    prevSawX = sim.pose.saw[0]!
    if (sim.rasp > 0) raspSteps++
    if (sawWork && dx < 0) pullSteps++
    if ((sim.rasp > 0) !== (sawWork && dx > 0)) raspBad++
    if (sim.rasp < 0 || sim.rasp > 1) raspBad++
    const planeWork = cur === 'plane' && ph!.name === 'work' && ph!.t > 0
    if (sim.swish > 0) swishSteps++
    if ((sim.swish > 0 && !planeWork) || sim.swish > 1) swishBad++
    landedDust += sim.particles.landedDust
    landedChips += sim.particles.landedChips
  }
  assert(counts.knock === 2 * PHASE.BLOWS && knockBad === 0, `one knock per blow, on the step it lands (${counts.knock} knocks)`)
  assert(raspSteps > 100 && pullSteps > 100 && raspBad === 0, `the rasp sounds on every push step and never on the return stroke (${raspSteps} push, ${pullSteps} pull steps)`)
  assert(swishSteps > 100 && swishBad === 0, 'the plane swish sounds only while the plane glides on the board')
  assert(stoolOpens >= 2 && counts.explode === stoolOpens, `one whoosh per stool explode (${counts.explode})`)
  assert(stoolCloses >= 2 && counts.frame === stoolCloses && counts.seat === stoolCloses, 'per reassembly: one clack as the frame seats, one as the seat drops on')
  assert(/^(xfs)+(x|xf)?$/.test(order), `stool sounds come in order: explode, frame, seat (${order})`)
  assert(counts.tap === 1, 'one knuckle tap per bench tap')
  assert(landedDust > 20 && landedChips > 0, `settling grains are counted for the sprinkle (dust ${landedDust}, chips ${landedChips})`)

  // The event log is the same step for step at any frame rate.
  const runLog = (hz: number) => {
    const s = new WorkshopSim(3)
    const clock = new FixedClock()
    const out: string[] = []
    let n = 0
    let now = 0
    clock.advance(now, () => {})
    while (n < 200 * 25) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (n >= 200 * 25) return
        if (n === 300) s.requestPuff(0, H, 0)
        if (n === 900) s.request('chisel')
        s.step(DT)
        for (const e of s.events) out.push(`${n} ${JSON.stringify(e)}`)
        if (s.rasp > 0) out.push(`${n} rasp ${s.rasp}`)
        n++
      })
    }
    return out.join('\n')
  }
  const l60 = runLog(60)
  assert(l60.length > 0 && l60 === runLog(144) && l60 === runLog(30), 'event log is identical at 30, 60 and 144 Hz')

  // A tap's puff of dust settles on real surfaces, like the rest.
  const p = new WorkshopSim(9)
  p.requestPuff(-0.3, H, -0.15)
  p.step(DT)
  const born = p.particles.count
  for (let i = 0; i < 200 * 3; i++) p.step(DT)
  // The puff took the first ten slots of the ring (sawdust follows after them).
  let resting = 0
  for (let j = 0; j < born; j++) {
    const y = p.particles.pos[j * 3 + 1]!
    if (p.particles.resting[j] && [0, H, BOARD.top].some(s => Math.abs(y - s) < 1e-6)) resting++
  }
  assert(born === 10 && resting === born, `a bench tap throws up a puff of dust that settles (${resting}/${born})`)
}

// ── 8. Voices: silent without a context, capped and stoppable with one ───
{
  const s = workshopSound()
  let threw = false
  try {
    s.event({ kind: 'knock', blow: 0 })
    s.event({ kind: 'seat', part: 'frame' })
    s.step(DT, 1, 3, 1)
    s.frame(1, 1)
    s.silence()
  }
  catch {
    threw = true
  }
  assert(!threw, 'with no audio context (headless, no gesture) every voice is a silent no-op')

  installMockAudio()
  const v = workshopSound()
  const events: WorkshopEvent[] = [
    { kind: 'knock', blow: 0 }, { kind: 'knock', blow: 2 }, { kind: 'explode' },
    { kind: 'seat', part: 'frame' }, { kind: 'seat', part: 'seat' }, { kind: 'tap' },
  ]
  for (const e of events) v.event(e)
  for (let f = 0; f < 60; f++) {
    v.step(DT, 1, 3, f % 7 === 0 ? 1 : 0)
    v.frame(f / 60, 1)
  }
  const ctx = MockContext.last!
  const outs = ctx.outputs()
  const peak = Math.max(...outs.map(n => n.gain.max))
  assert(MockContext.made === 1, 'the voices use the one shared context (never their own)')
  assert(outs.length >= 20 && peak <= PEAK, `every output stage peaks at <= ${PEAK} (max ${peak.toFixed(3)} over ${outs.length} stages)`)
  const drones = ctx.nodes.filter(n => n.kind === 'osc' || (n.kind === 'buffer' && n.loop))
  v.silence()
  assert(outs.every(n => n.gain.last <= 1e-4), 'silence() fades every sounding output to zero')
  assert(drones.length >= 3 && drones.every(n => n.stopped > 0), 'silence() stops the rasp and swish loops')
  const before = ctx.nodes.length
  v.setMuted(true)
  for (const e of events) v.event(e)
  v.step(DT, 1, 3, 1)
  v.frame(1, 1)
  assert(ctx.nodes.length === before, 'a muted (thumbnail) scene creates no sound at all')
}

// ── 9. The carpenter: hands on the handles, strikes on time, steady body ──

/** Stand-in for the stage's materials (the real ones need a canvas for the shadow blob). */
function fakeMaterials(): Materials {
  const keys: MatKey[] = ['red', 'cyan', 'accent', 'light', 'mid', 'dark', 'wood', 'woodDark', 'stone', 'metal', 'water', 'leaf']
  const face = Object.fromEntries(keys.map(k => [k, new THREE.MeshLambertMaterial()])) as Materials['face']
  return { face, line: new THREE.LineBasicMaterial(), lineFaint: new THREE.LineBasicMaterial(), shadow: new THREE.MeshBasicMaterial(), dispose() {} }
}
const pctx = { materials: fakeMaterials() }

function crew(seed = 7) {
  const sim = new WorkshopSim(seed)
  const person = createPerson(pctx, { seed: CARPENTER.seed, variant: CARPENTER.variant, accent: true })
  const carpenter = new Carpenter(person, sim)
  /** One stage step, in the scene's order: hold?, sim, hands + person. */
  const step = () => {
    sim.step(DT, carpenter.hold(DT))
    carpenter.step(DT)
  }
  return { sim, person, carpenter, step }
}
const hw = new THREE.Vector3()
const SIDES = ['left', 'right'] as const
const STATIC_PH = new Set(['reach', 'pass', 'set', 'unpass'])

{
  const { sim, person, carpenter, step } = crew()
  let handErr = 0
  let gripSteps = 0
  let unheld = 0
  let knocks = 0
  let knockBad = 0
  let maxKnockErr = 0
  let tooClose = 0
  let handClearance = Infinity
  let clearanceSteps = 0
  const leftPalm = new THREE.Vector3()
  const rightPalm = new THREE.Vector3()
  const seen = new Set<string>()
  for (let i = 0; i < 200 * 90; i++) {
    if (i === 200 * 2) sim.request('chisel')
    if (i === 200 * 3) sim.request('plane')
    if (i === 200 * 40) sim.toggleStool()
    step()
    const cur = sim.timeline.current
    const ph = cur ? phaseOf(cur, sim.timeline.t).name : null
    if (cur && ph) seen.add(`${cur}:${ph}`)
    if (cur === 'saw' && ph === 'work') {
      person.handWorld('left', leftPalm)
      person.handWorld('right', rightPalm)
      handClearance = Math.min(handClearance, leftPalm.distanceTo(rightPalm))
      clearanceSteps++
    }
    // Every grip on a tool that is moving (or about to) is exact.
    for (const side of SIDES) {
      const h = carpenter.hands[side]
      if (!h?.tool || !ph || ph === 'reach') continue
      // (A hand steadying the board, which never moves, counts once it is there.)
      if ((STATIC_PH.has(ph) || h.tool === 'board') && !h.settled) continue
      person.handWorld(side, hw)
      handErr = Math.max(handErr, Math.hypot(hw.x - h.target.x, hw.y - h.target.y, hw.z - h.target.z))
      gripSteps++
    }
    // A tool only ever leaves its rest in a settled hand.
    for (const k of TOOLS) {
      if (atRest(sim, k)) continue
      if (!SIDES.some(s => carpenter.hands[s]?.tool === k && carpenter.hands[s]!.settled)) unheld++
    }
    for (const e of sim.events) {
      if (e.kind !== 'knock') continue
      knocks++
      // The blow lands with the mallet's face on the chisel top, in the carpenter's right hand.
      const m = sim.pose.mallet
      const c = sim.pose.chisel
      const faceY = m[1]! - MALLET.R * Math.sin(m[5]!) - MALLET.hh * Math.cos(m[5]!)
      if (Math.abs(faceY - (c[1]! + CHISEL.len)) > 1e-6) knockBad++
      const h = carpenter.hands.right
      if (h?.tool !== 'mallet') knockBad++
      else {
        person.handWorld('right', hw)
        maxKnockErr = Math.max(maxKnockErr, Math.hypot(hw.x - h.target.x, hw.y - h.target.y, hw.z - h.target.z))
      }
    }
    // The carpenter never stands in the bench or the board.
    if (person.position.z < BOARD.front + 0.25) tooClose++
  }
  const phases = ['saw:pass', 'saw:work', 'saw:unpass', 'plane:set', 'plane:work', 'chisel:work', 'chisel:return']
  assert(phases.every(p => seen.has(p)), `the loop runs every action through its phases (${seen.size} seen)`)
  assert(gripSteps > 4000 && handErr <= 1e-3, `hand on handle within 1 mm through every action (max ${(handErr * 1000).toFixed(3)} mm over ${gripSteps} hand-steps)`)
  assert(unheld === 0, `no tool ever moves without a settled hand on it (${unheld} violations)`)
  assert(knocks >= PHASE.BLOWS && knockBad === 0 && maxKnockErr <= 1e-3,
    `every knock lands on the strike: face on the chisel, right hand on the mallet (${knocks} knocks, hand ${(maxKnockErr * 1000).toFixed(3)} mm)`)
  assert(tooClose === 0, 'the carpenter always stands clear of the bench and the board')
  assert(clearanceSteps > 0 && Number.isFinite(handClearance) && handClearance >= 0.3,
    `the actual free hand stays clear of the saw hand throughout its stroke (${(handClearance * 100).toFixed(1)} cm, ${clearanceSteps} samples)`)
}

// ── 10. A tap on the carpenter: look up, wave, then back to the same cut ──
{
  const { sim, person, carpenter, step } = crew()
  sim.request('saw')
  while (!(sim.timeline.current === 'saw' && phaseOf('saw', sim.timeline.t).name === 'work' && sim.kerf > 0.01)) step()
  const msg = carpenter.requestWave()
  const before = sim.snapshot(new Float64Array(SNAP.size))
  const t0 = sim.timeline.t
  let waved = false
  let frozen = true
  let n = 0
  for (; n < 200 * 6; n++) {
    step()
    if (person.action === 'wave') waved = true
    if (carpenter.wave === 'waving') {
      const s = sim.snapshot(new Float64Array(SNAP.size))
      for (let k = 0; k < 24; k++) if (s[k] !== before[k]) frozen = false
    }
    if (waved && carpenter.wave === 'none') break
  }
  assert(msg.includes('waves') && waved, `a tap mid-cut: the carpenter lets go and waves (${msg})`)
  assert(frozen && sim.timeline.t > t0 - 1e-9, 'while they wave the saw stands in its kerf: nothing moves, the cut resumes after')
  let err = 0
  for (let i = 0; i < 100; i++) {
    step()
    const h = carpenter.hands.right
    if (h?.tool === 'saw') {
      person.handWorld('right', hw)
      err = Math.max(err, Math.hypot(hw.x - h.target.x, hw.y - h.target.y, hw.z - h.target.z))
    }
  }
  assert(n < 200 * 6 && err <= 1e-3, `back on the saw within 1 mm after the wave (${(err * 1000).toFixed(3)} mm)`)

  // Mid-swing with the mallet the wave waits until both hands are free.
  const c = crew(3)
  c.sim.request('chisel')
  while (!(c.sim.timeline.current === 'chisel' && phaseOf('chisel', c.sim.timeline.t).name === 'work')) c.step()
  const m2 = c.carpenter.requestWave()
  let early = false
  let later = false
  for (let i = 0; i < 200 * 8; i++) {
    c.step()
    if (c.person.action === 'wave') {
      if (c.sim.timeline.current === 'chisel') early = true
      else later = true
    }
  }
  assert(!early && later && m2.includes('after'), `with chisel and mallet in hand the wave waits for the tools to be put down (${m2})`)
}

// ── 11. Determinism with the carpenter: 30, 60 and 144 Hz ────────────────
{
  const N = 200 * 30
  const run = (hz: number) => {
    const c = crew(5)
    const clock = new FixedClock()
    let steps = 0
    let now = 0
    clock.advance(now, () => {})
    while (steps < N) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (steps >= N) return
        if (steps === 600) c.sim.request('plane')
        if (steps === 3000) c.carpenter.requestWave()
        c.step()
        steps++
      })
      c.person.frame(0.5)
    }
    const P = c.person.motion.pose
    return snap(c.sim).concat(P.pelvisPos, ...P.R, [c.person.position.x, c.person.position.z, c.person.heading])
  }
  const a = run(60)
  const b = run(144)
  const d = run(30)
  assert(a.every((x, i) => Object.is(x, b[i]) && Object.is(x, d[i])), 'sim and carpenter are bit-identical at 30, 60 and 144 Hz')
}

// ── 12. Body plausibility through every action ──────────────────────────
// A long run of the whole loop -- saw, plane (walking through the stroke),
// chisel and mallet, the stool's show with its step back, the walks between
// places, and waves mid-saw, mid-plane and idle -- checked every step by
// forward kinematics of the person's own pose. The body is modelled coarsely
// (torso as an elliptic cylinder in the spine frame, head as a sphere, limbs
// as capsules), the tools as solid boxes in their own frames.
{
  type V = [number, number, number]
  const { sim, person, carpenter, step } = crew(13)
  const mo = person.motion
  const d = person.dims
  const H = d.H
  const rArm = d.arm * 0.5
  /** Joint world positions and world rotations, by FK of the motion pose. */
  const mulM = (a: number[], b: number[]) => {
    const o = new Array(9)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!
    return o
  }
  const app = (m: number[], v: V): V => [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]]
  const addV = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const subV = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const len = (a: V) => Math.hypot(a[0], a[1], a[2])
  const BN = { pelvis: 0, spine: 1, head: 2, uaL: 3, faL: 4, handL: 5, uaR: 6, faR: 7, handR: 8 }
  function fk() {
    const P = mo.pose
    const c = Math.cos(mo.heading), s = Math.sin(mo.heading)
    const root = [c, 0, s, 0, 1, 0, -s, 0, c]
    const toW = (v: V): V => { const r = app(root, v); return [r[0] + mo.pos.x, r[1], r[2] + mo.pos.z] }
    const Rp = mulM(root, P.R[BN.pelvis] as unknown as number[])
    const pel = toW(P.pelvisPos as V)
    const Rs = mulM(Rp, P.R[BN.spine] as unknown as number[])
    const spine = addV(pel, app(Rp, mo.offsets[BN.spine] as V))
    const out = { spine, Rs, neck: addV(spine, app(Rs, mo.offsets[BN.head] as V)), Rh: mulM(Rs, P.R[BN.head] as unknown as number[]), arm: {} as Record<'left' | 'right', { sh: V, el: V, wr: V, palm: V, Rf: number[], Rh: number[], W: number[], E: number[] }> }
    for (const side of ['left', 'right'] as const) {
      const ua = side === 'left' ? BN.uaL : BN.uaR
      const so = mo.offsets[ua] as V
      const sh = addV(spine, app(Rs, [so[0], so[1] + P.shoulderLift, so[2]]))
      const Ru = mulM(Rs, P.R[ua] as unknown as number[])
      const el = addV(sh, app(Ru, mo.offsets[ua + 1] as V))
      const Rf = mulM(Ru, P.R[ua + 1] as unknown as number[])
      const wr = addV(el, app(Rf, mo.offsets[ua + 2] as V))
      const Rh = mulM(Rf, P.R[ua + 2] as unknown as number[])
      const palm = addV(wr, app(Rh, [0, -d.hand * 0.45, 0]))
      out.arm[side] = { sh, el, wr, palm, Rf, Rh, W: P.R[ua + 2] as unknown as number[], E: P.R[ua + 1] as unknown as number[] }
    }
    return out
  }
  /** A world point in the spine frame. */
  const inSpine = (f: ReturnType<typeof fk>, p: V): V => {
    const v = subV(p, f.spine)
    const R = f.Rs
    return [R[0]! * v[0] + R[3]! * v[1] + R[6]! * v[2], R[1]! * v[0] + R[4]! * v[1] + R[7]! * v[2], R[2]! * v[0] + R[5]! * v[1] + R[8]! * v[2]]
  }
  // Torso: elliptic cylinder from the waist to below the shoulders, inflated by the arm's radius.
  const tA = 0.62 * d.torsoW + rArm, tB = 0.42 * d.torsoD + rArm
  const inTorso = (f: ReturnType<typeof fk>, p: V) => {
    const q = inSpine(f, p)
    return q[1] > 0.05 && q[1] < d.spineLen * 0.78 && (q[0] / tA) ** 2 + (q[2] / tB) ** 2 < 1
  }
  const headR = 0.42 * d.headH
  const segDist = (a0: V, a1: V, b0: V, b1: V) => {
    let best = Infinity
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const p = addV(a0, subV(a1, a0).map(x => x * i / 8) as V)
      const q = addV(b0, subV(b1, b0).map(x => x * j / 8) as V)
      best = Math.min(best, len(subV(p, q)))
    }
    return best
  }
  /** Solid parts of each tool, boxes in the tool's frame (shrunk a millimetre: contact is allowed). */
  const SOLID: Record<ToolKey, [V, V][]> = {
    saw: [[[-0.4, 0, -0.001], [0, 0.08, 0.001]], [[-0.535, 0.02, -0.011], [-0.5, 0.115, 0.011]]],
    plane: [[[-0.12, 0, -0.025], [0.12, 0.03, 0.025]]],
    chisel: [[[-0.012, 0.12, -0.012], [0.012, 0.22, 0.012]], [[-0.008, 0, -0.0025], [0.008, 0.1, 0.0025]]],
    mallet: [[[-0.2925, -0.055, -0.0375], [-0.2275, 0.055, 0.0375]], [[-0.29, -0.011, -0.013], [0, 0.011, 0.013]]],
  }
  const toTool = (k: ToolKey, w: V): V => {
    // World -> the sim's frame (mirrored in x) -> the tool's frame.
    const p = sim.pose[k]
    const R = eulerXYZ(p[3]!, p[4]!, p[5]!)
    const v: V = [MIRROR * w[0] - p[0]!, w[1] - p[1]!, w[2] - p[2]!]
    return [R[0]! * v[0] + R[3]! * v[1] + R[6]! * v[2], R[1]! * v[0] + R[4]! * v[1] + R[7]! * v[2], R[2]! * v[0] + R[5]! * v[1] + R[8]! * v[2]]
  }
  const inBox = (p: V, [lo, hi]: [V, V]) => p.every((x, i) => x > lo[i]! + 0.001 && x < hi[i]! - 0.001)

  const bad = { torso: 0, head: 0, arms: 0, invert: 0, elbowSide: 0, elbowBack: 0, ownSide: 0, wrist: 0, palm: 0, finger: 0, handFast: 0, shoulderFast: 0, footSlide: 0, legClamp: 0, look: 0, held: 0 }
  let maxHandV = 0, maxShV = 0, maxWristBend = 0, maxPalm = 0, maxChiselPalm = 0, maxLook = 0, lookSteps = 0, steps = 0
  let prev: ReturnType<typeof fk> | null = null
  const prevFeet = mo.feet.map(f => ({ ...f }))
  const seen = new Set<string>()
  const where: Record<string, string> = {}
  const note = (k: keyof typeof bad, tag: string) => {
    bad[k]++
    where[k] ??= tag
  }
  const work = { x: 0, y: 0, z: 0 }
  for (let i = 0; i < 200 * 75; i++) {
    if (i === 200 * 4) carpenter.requestWave() // mid-saw
    if (i === 200 * 14) carpenter.requestWave() // around the plane
    if (i === 200 * 27) sim.toggleStool()
    if (i === 200 * 52) carpenter.requestWave() // whatever is happening
    step()
    steps++
    const cur = sim.timeline.current
    const ph = cur ? phaseOf(cur, sim.timeline.t).name : 'idle'
    const tag = `${cur ?? 'idle'}:${ph}@${(i * DT).toFixed(2)}s`
    seen.add(`${cur ?? 'idle'}:${ph}`)
    if (carpenter.walking) seen.add('walking')
    if (carpenter.wave === 'waving') seen.add('waving')
    const f = fk()
    for (const side of SIDES) {
      const a = f.arm[side]
      const sgn = side === 'left' ? 1 : -1
      // Arm through the torso: forearm and the elbow half of the upper arm.
      for (let k = 0; k <= 6; k++) {
        const u = k / 6
        const pf = addV(a.el, subV(a.wr, a.el).map(x => x * u) as V)
        const pu = addV(a.el, subV(a.sh, a.el).map(x => x * u * 0.55) as V)
        if (inTorso(f, pf) || inTorso(f, pu)) { note('torso', tag); break }
      }
      // Hand or forearm through the head.
      const headC = addV(f.neck, app(f.Rh, [0, d.neck + d.headH * 0.5, 0]))
      for (let k = 0; k <= 4; k++) {
        const p = addV(a.wr, subV(a.palm, a.wr).map(x => x * k / 4) as V)
        if (len(subV(p, headC)) < headR + rArm * 0.6) { note('head', tag); break }
      }
      // Elbow: never bent backwards, outboard of the ribs, never behind the back.
      const E = a.E
      if (E[7]! > 1e-6 || Math.acos(Math.max(-1, Math.min(1, E[4]!))) > (150 + 1) * Math.PI / 180) note('invert', tag)
      const el = inSpine(f, a.el)
      const wr = inSpine(f, a.wr)
      const sx = d.shoulderX
      const driving = side === 'right'
      const h = carpenter.hands[side]
      const settled = !!h && h.settled && carpenter.wave === 'none'
      if (settled) {
        // Outboard of the ribs (unless the grip itself is across the body), and
        // never behind the back plane while inside the body's width.
        const need = Math.min(0.6 * sx, sgn * wr[0] + 0.08)
        if (sgn * el[0] < need) note('elbowSide', tag)
        if (el[2] < -0.5 * d.torsoD && Math.abs(el[0]) < 0.8 * d.torsoW) note('elbowBack', tag)
        // The driving hand works on its own side of the body.
        if (driving && ph === 'work' && sgn * wr[0] < -0.05) note('ownSide', tag)
      }
      // Wrist: bend within 75 degrees, twist within 90.
      // (Measured as the people library defines them: bend between the forearm's
      // and the hand's long axes; twist about the hand's axis, past what the
      // forearm itself has turned.)
      const W = a.W
      const bend = Math.acos(Math.max(-1, Math.min(1, W[4]!)))
      const hy: V = [W[1]!, W[4]!, W[7]!], hx: V = [W[0]!, W[3]!, W[6]!]
      const ref: V = [1 - hy[0] * hy[0], -hy[1] * hy[0], -hy[2] * hy[0]]
      const cr: V = [ref[1] * hx[2] - ref[2] * hx[1], ref[2] * hx[0] - ref[0] * hx[2], ref[0] * hx[1] - ref[1] * hx[0]]
      const tw = Math.abs(Math.atan2(dot(cr, hy), dot(ref, hx)))
      maxWristBend = Math.max(maxWristBend, bend)
      if (bend > 75 * Math.PI / 180 + 1e-6 || tw > Math.PI / 2 + 1e-6) note('wrist', tag)
      // Holding a tool: palm on the grip within 1 mm, palm facing the grip within 45 degrees.
      if (h) {
        person.handWorld(side, hw)
        const e = Math.hypot(hw.x - h.target.x, hw.y - h.target.y, hw.z - h.target.z)
        // (A steadying hand on the board only counts once it has arrived.)
        const settledPhase = carpenter.wave === 'none' && (h.tool === 'board' ? h.settled : !STATIC_PH.has(ph) || h.settled)
        if (settledPhase && e > 1e-3) note('held', tag)
        if (settledPhase && e < 1e-3) {
          // The library turns the palm (hand X, by side) toward -normal.
          const nWorld: V = [h.normal.x, h.normal.y, h.normal.z]
          const palmX: V = [a.Rh[0]! * sgn, a.Rh[3]! * sgn, a.Rh[6]! * sgn]
          const ang = Math.acos(Math.max(-1, Math.min(1, dot(palmX, nWorld))))
          maxPalm = Math.max(maxPalm, ang)
          // The chisel is held from the side, thumb up the handle: steady and square through the work.
          if (h.tool === 'chisel' && ph === 'work') maxChiselPalm = Math.max(maxChiselPalm, ang)
          if (ang > Math.PI / 4) note('palm', tag)
        }
      }
      // Fingers through a tool, for a hand holding one: from the palm centre out along the fingers.
      const fingers: V = [-a.Rh[1]!, -a.Rh[4]!, -a.Rh[7]!]
      const tip = addV(a.palm, fingers.map(x => x * d.hand * 0.55) as V)
      for (const k of settled ? TOOLS : []) {
        for (let s = 1; s <= 4; s++) {
          const p = toTool(k, addV(a.palm, subV(tip, a.palm).map(x => x * s / 4) as V))
          if (SOLID[k].some(b => inBox(p, b))) { note('finger', `${tag} ${side} in ${k}`); break }
        }
      }
      // Speeds.
      if (prev) {
        const pa = prev.arm[side]
        const hv = len(subV(a.palm, pa.palm)) / DT
        const sv = len(subV(a.sh, pa.sh)) / DT
        maxHandV = Math.max(maxHandV, hv)
        maxShV = Math.max(maxShV, sv)
        if (hv > 4) note('handFast', tag)
        if (sv > 1) note('shoulderFast', tag)
      }
    }
    // Forearms clear of each other.
    // (While the carpenter holds something: idle hands are the people library's own.)
    if ((carpenter.hands.left || carpenter.hands.right) && segDist(f.arm.left.el, f.arm.left.wr, f.arm.right.el, f.arm.right.wr) < 1.6 * rArm) note('arms', tag)
    // Feet: a planted foot (on the ground before and after) does not move; legs are never over-stretched.
    for (const k of [0, 1] as const) {
      const ft = mo.feet[k], pf = prevFeet[k]!
      if (ft.y === 0 && pf.y === 0 && Math.hypot(ft.x - pf.x, ft.z - pf.z) > 1e-9) note('footSlide', tag)
      if (mo.legs[k].clamped) note('legClamp', tag)
      Object.assign(pf, ft)
    }
    // Eyes on the cut while a stroke is under way (the head's forward axis within 40 degrees).
    if (cur && ph === 'work' && carpenter.wave === 'none') {
      carpenter.workPoint(cur, work)
      const eye = addV(f.neck, app(f.Rh, [0, d.neck + d.headH * 0.45, 0]))
      const fwd: V = [f.Rh[2]!, f.Rh[5]!, f.Rh[8]!]
      const to = subV([work.x, work.y, work.z], eye)
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(fwd, to) / len(to))))
      maxLook = Math.max(maxLook, ang)
      lookSteps++
      if (ang > 35 * Math.PI / 180) note('look', tag)
    }
    prev = f
  }
  const deg = (r: number) => (r * 180 / Math.PI).toFixed(0)
  const cover = ['saw:work', 'plane:work', 'chisel:work', 'saw:fetch', 'saw:return', 'plane:fetch', 'plane:return', 'chisel:fetch', 'chisel:return', 'walking', 'waving', 'idle:idle']
  const at = (k: keyof typeof bad) => bad[k] ? ` -- first at ${where[k]}` : ''
  assert(cover.every(c => seen.has(c)), `plausibility run covers saw, plane, chisel, pick-up / put-down, walking, waving and idle (${cover.filter(c => !seen.has(c)).join(', ') || 'all'})`)
  assert(bad.torso === 0, `no forearm or upper arm passes through the torso (${bad.torso} steps)${at('torso')}`)
  assert(bad.head === 0, `no hand or forearm passes through the head (${bad.head})${at('head')}`)
  assert(bad.arms === 0, `the forearms never pass through each other (${bad.arms})${at('arms')}`)
  assert(bad.invert === 0, `elbows never bend backwards or past 150 degrees (${bad.invert})${at('invert')}`)
  assert(bad.elbowSide === 0 && bad.elbowBack === 0, `a working elbow stays outboard of the ribs and never behind the back (${bad.elbowSide} / ${bad.elbowBack})${at('elbowSide')}${at('elbowBack')}`)
  assert(bad.ownSide === 0, `the driving (right) hand stays on its own side of the body (${bad.ownSide})${at('ownSide')}`)
  assert(bad.wrist === 0, `wrists bend at most 75 degrees and twist at most 90 (max bend ${deg(maxWristBend)})${at('wrist')}`)
  assert(bad.held === 0, `every grip on a moving tool is within 1 mm (${bad.held})${at('held')}`)
  assert(bad.palm === 0, `palms face their grips within 45 degrees (max ${deg(maxPalm)})${at('palm')}`)
  assert(bad.finger === 0, `fingers never pass through a tool (${bad.finger})${at('finger')}`)
  assert(bad.handFast === 0 && bad.shoulderFast === 0, `hands at most 4 m/s, shoulders at most 1 m/s (max ${maxHandV.toFixed(2)} / ${maxShV.toFixed(2)})${at('handFast')}${at('shoulderFast')}`)
  assert(bad.footSlide === 0 && bad.legClamp === 0, `planted feet never slide and legs never over-stretch (${bad.footSlide} / ${bad.legClamp})${at('footSlide')}${at('legClamp')}`)
  assert(maxChiselPalm <= 30 * Math.PI / 180, `the chisel hand's palm faces the handle within 30 degrees through the work (max ${deg(maxChiselPalm)})`)
  assert(lookSteps > 1000 && bad.look === 0, `eyes on the cut through every stroke (max ${deg(maxLook)} degrees off, ${lookSteps} steps)${at('look')}`)
  void H
  void steps
}

// Check the actual skinned free-arm vertices, including fingers: testing only
// palm targets missed their visible overlap with the blade in the camera view.
{
  const { sim, person, step } = crew()
  const meshes: { mesh: THREE.SkinnedMesh, indices: number[] }[] = []
  const freeBones = new Set<number>([B.faL, B.handL, B.fiL])
  person.root.traverse(o => {
    const mesh = o as THREE.SkinnedMesh
    if (!mesh.isSkinnedMesh || mesh.name !== `${CARPENTER.variant}:skin`) return
    const a = mesh.geometry.attributes
    const indices: number[] = []
    for (let i = 0; i < a.position!.count; i++) {
      for (let k = 0; k < 4; k++) {
        if (freeBones.has(a.skinIndex!.getComponent(i, k)) && a.skinWeight!.getComponent(i, k) > 0.1) {
          indices.push(i)
          break
        }
      }
    }
    meshes.push({ mesh, indices })
  })
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 40)
  const target = new THREE.Vector3(0.2, 0.62, 0.05)
  camera.position.copy(target).add(new THREE.Vector3(2.45 * MIRROR, 1.3, 1.6).normalize().multiplyScalar(12))
  camera.lookAt(target)
  camera.updateMatrixWorld()
  const vertices = [new THREE.Vector3(-SAW.teeth, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.08, 0), new THREE.Vector3(-SAW.teeth, 0.12, 0)]
  const blade = [new THREE.Triangle(vertices[0]!, vertices[1]!, vertices[2]!), new THREE.Triangle(vertices[0]!, vertices[2]!, vertices[3]!)]
  const world = new THREE.Matrix4(), local = new THREE.Matrix4(), drawing = new THREE.Matrix4()
  const q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), nearest = new THREE.Vector3()
  const projected = vertices.map(() => new THREE.Vector3())
  const projectedBlade = [new THREE.Triangle(projected[0]!, projected[1]!, projected[2]!), new THREE.Triangle(projected[0]!, projected[2]!, projected[3]!)]
  let clearance = Infinity, screenClearance = Infinity, samples = 0
  for (let n = 0; n < 200 * 10; n++) {
    step()
    if (n % 4 || sim.timeline.current !== 'saw' || phaseOf('saw', sim.timeline.t).name !== 'work') continue
    person.frame(1)
    person.root.updateMatrixWorld(true)
    const p = sim.pose.saw
    q.setFromEuler(e.set(p[3]!, p[4]!, p[5]!))
    world.makeScale(MIRROR, 1, 1).multiply(local.compose(v.set(p[0]!, p[1]!, p[2]!), q, nearest.set(1, 1, 1)))
    local.copy(world).invert()
    drawing.multiplyMatrices(camera.matrixWorldInverse, world)
    vertices.forEach((point, i) => { projected[i]!.copy(point).applyMatrix4(drawing).z = 0 })
    for (const { mesh, indices } of meshes) {
      mesh.skeleton.update()
      for (const i of indices) {
        mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld).applyMatrix4(local)
        for (const triangle of blade) clearance = Math.min(clearance, triangle.closestPointToPoint(v, nearest).distanceTo(v))
        v.applyMatrix4(drawing).z = 0
        for (const triangle of projectedBlade) screenClearance = Math.min(screenClearance, triangle.closestPointToPoint(v, nearest).distanceTo(v))
      }
    }
    samples++
  }
  assert(samples > 100 && meshes.length > 0 && clearance > 0.1, `rendered free fingers and forearm stay clear of the blade (${(clearance * 100).toFixed(1)} cm, ${samples} full-mesh samples)`)
  assert(Number.isFinite(screenClearance) && screenClearance > 0.03, `free fingers and forearm never visually overlap the blade (${(screenClearance * 100).toFixed(1)} cm projected gap)`)
  person.dispose()
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall workshop checks passed')
