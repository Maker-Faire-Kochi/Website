import * as THREE from 'three'
import { DT, FixedClock } from '../app/three/core/clock'
import { rng } from '../app/three/core/rng'
import {
  ARP, ARP_NOTE, NOTES, SCALE, SEMIS, Voice, clamp01, cutoffHz, glide, knobAngle, noteSemis, quantize,
} from '../app/three/scenes/noise/music'
import { AREA, CAP, DRAW_S, PAPER, PARK, Plotter } from '../app/three/scenes/noise/plotter'
import { frameCamera, makeCamera } from '../app/three/scenes/noise/frame'
import { TABLE, benchBox, subjectBoxes, tableTop, type Box } from '../app/three/scenes/noise/layout'
import { NoiseSim, SNAP, XBACK, XMAX } from '../app/three/scenes/noise/sim'

/**
 * Pure-logic checks for the "Make Some Noise" scene: the synth's scale and
 * portamento, the knobs, the speaker cone, the plotter's drawing and its
 * kinematics, determinism across frame rates, and the framing in the focus box.
 * Run: npx --yes tsx scripts/test-noise.ts
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

const inScale = (semis: number) => (SCALE as readonly number[]).includes(((semis % 12) + 12) % 12)

// ── 1. Pitch quantisation stays in the scale ─────────────────────────────
{
  let ok = true
  let mono = true
  let last = -1
  for (let i = 0; i <= 1000; i++) {
    const s = quantize(i / 1000)
    if (!inScale(s) || s < 0 || s > SEMIS) ok = false
    if (s < last) mono = false
    last = s
  }
  assert(ok, 'every quantised pitch is a minor-pentatonic note within two octaves')
  assert(mono, 'pitch never falls as the control moves right')
  assert(quantize(0) === 0 && quantize(1) === SEMIS, 'the control spans root to double octave')
  assert(quantize(-3) === 0 && quantize(7) === SEMIS, 'out-of-range control positions clamp')
  const all = new Set(Array.from({ length: 1001 }, (_, i) => quantize(i / 1000)))
  assert(all.size === NOTES, `all ${NOTES} scale notes are reachable (${all.size})`)
  assert(ARP.every(i => inScale(noteSemis(i))), 'every arpeggio note is in the scale')
}

// ── 2. Portamento is continuous, monotonic, never overshoots ─────────────
{
  const v = new Voice()
  v.hold(0, 0.5)
  for (let i = 0; i < 400; i++) v.step(DT)
  assert(Math.abs(v.semis) < 0.01, 'held at the left edge the pitch settles on the root')
  v.move(1, 0.5)
  const bound = SEMIS * (1 - Math.exp(-DT / 0.085)) + 1e-9
  let maxStep = 0
  let mono = true
  let over = false
  let prev = v.semis
  for (let i = 0; i < 200; i++) {
    v.step(DT)
    const d = v.semis - prev
    maxStep = Math.max(maxStep, Math.abs(d))
    if (d < -1e-12) mono = false
    if (v.semis > SEMIS + 1e-9) over = true
    prev = v.semis
  }
  assert(mono && !over, 'a jump to a new note glides monotonically and never overshoots')
  assert(maxStep <= bound, `no step moves the pitch more than the glide allows (${maxStep.toFixed(4)} <= ${bound.toFixed(4)})`)
  assert(Math.abs(v.semis - SEMIS) < 0.02, 'the glide arrives within a second')
  // A reversal mid-glide is still continuous.
  v.move(0, 0.5)
  for (let i = 0; i < 10; i++) v.step(DT)
  v.move(0.6, 0.5)
  prev = v.semis
  let jump = 0
  for (let i = 0; i < 100; i++) {
    v.step(DT)
    jump = Math.max(jump, Math.abs(v.semis - prev))
    prev = v.semis
  }
  assert(jump <= bound, 'reversing direction mid-glide does not jump')
  assert(Math.abs(glide(3, 9, 0, 0.1) - 3) < 1e-12 && glide(3, 9, 1e9, 0.1) === 9, 'glide(): dt 0 holds, long dt arrives')
  assert(cutoffHz(0) > 200 && cutoffHz(1) < 4500 && cutoffHz(2) === cutoffHz(1), 'filter cutoff spans 220 Hz..4 kHz and clamps')
}

// ── 3. Knobs are clamped ─────────────────────────────────────────────────
{
  const v = new Voice()
  v.setKnob(0, 5)
  v.setKnob(1, -3)
  assert(v.knobs[0] === 1 && v.knobs[1] === 0, 'knob values clamp to 0..1')
  v.setKnob(0, Number.NaN)
  assert(v.knobs[0] === 0, 'a NaN knob value reads as 0, never escapes the range')
  assert(Math.abs(knobAngle(0) + 0.75 * Math.PI) < 1e-12 && Math.abs(knobAngle(1) - 0.75 * Math.PI) < 1e-12, 'a pot sweeps 270 degrees')
  assert(knobAngle(9) === knobAngle(1) && knobAngle(-9) === knobAngle(0), 'knob angles clamp with their values')
  assert(clamp01(0.4) === 0.4, 'clamp01 passes in-range values through')
}

// ── 4. Sequenced playing: the arpeggio and the touch phrase end by themselves ─
{
  const v = new Voice()
  v.arp()
  const notes = new Set<number>()
  let steps = 0
  while (v.mode === 'arp' && steps < 200 * 30) {
    v.step(DT)
    notes.add(v.target)
    steps++
  }
  const dur = steps * DT
  assert(Math.abs(dur - ARP.length * ARP_NOTE) < 2 * DT, `the four-bar arpeggio lasts 32 eighths at 112 bpm (${dur.toFixed(3)} s)`)
  for (let i = 0; i < 200; i++) v.step(DT)
  assert(!v.sounding, 'it releases to silence after its last note')
  v.phrase(0.5)
  let n = 0
  while (v.mode === 'phrase' && n < 200 * 5) {
    v.step(DT)
    n++
  }
  assert(n * DT > 1 && n * DT < 1.3, `a tap's phrase is a short one (${(n * DT).toFixed(2)} s)`)
  v.hold(0.5, 0.5)
  for (let i = 0; i < 40; i++) v.step(DT)
  v.silence()
  assert(!v.sounding && v.env === 0, 'silence() cuts the voice with no tail')
}

// ── 5. The cone: bounded, and it pumps with the level ────────────────────
{
  const sim = new NoiseSim(3)
  let lo = Infinity
  let hi = -Infinity
  let sum = 0
  let n = 0
  sim.voice.arp()
  for (let i = 0; i < 200 * 9; i++) {
    sim.step(DT)
    lo = Math.min(lo, sim.cone)
    hi = Math.max(hi, sim.cone)
    sum += sim.cone
    n++
  }
  // Worst case: the measured drive slamming between 0 and 1 every 20 ms.
  for (let i = 0; i < 200 * 4; i++) {
    sim.drive = Math.floor(i / 4) % 2
    sim.step(DT)
    lo = Math.min(lo, sim.cone)
    hi = Math.max(hi, sim.cone)
  }
  sim.drive = null
  assert(lo >= -XBACK * XMAX - 1e-12 && hi <= XMAX + 1e-12, `cone excursion stays within [-${XBACK}, 1] x XMAX (${(lo * 1000).toFixed(2)}..${(hi * 1000).toFixed(2)} mm)`)
  assert(sum / n > 0.25 * XMAX, 'the cone pumps out while the arpeggio plays')
  const quiet = new NoiseSim(3)
  let still = 0
  for (let i = 0; i < 200 * 5; i++) {
    quiet.step(DT)
    still = Math.max(still, Math.abs(quiet.cone))
  }
  assert(still === 0, 'with nothing playing the cone does not move')
}

// ── 6. The plotter: deterministic, on the paper, pen tip on the line ─────
const papX = PAPER.w / 2
const papZ0 = PAPER.cz - PAPER.d / 2
const papZ1 = PAPER.cz + PAPER.d / 2
{
  const drive = (seed: number, inputSeed: number, steps: number, check?: (p: Plotter, i: number) => void) => {
    const p = new Plotter(seed)
    const r = rng(inputSeed)
    let input = { pitch01: 0.5, active: false, level: 0 }
    for (let i = 0; i < steps; i++) {
      if (i % 300 === 0) input = { pitch01: r.next(), active: r.next() < 0.6, level: r.next() }
      p.step(DT, input)
      check?.(p, i)
    }
    return p
  }
  const N = 200 * 95 // about three drawings
  let outside = 0
  let offLine = 0
  let downOutsideDraw = 0
  let liftBad = 0
  let maxMove = 0
  let swaps = 0
  let last = { x: PARK.x, z: PARK.z }
  let lastSheet = 0
  let opBad = 0
  const a = drive(5, 9, N, (p) => {
    const c = p.count[p.cur]!
    const b = p.buf[p.cur]!
    if (p.penDown) {
      // Down only while drawing, or at the instant the raise begins.
      if (p.phase !== 'draw' && !(p.phase === 'raise' && p.t === 0)) downOutsideDraw++
      if (c === 0 || b[(c - 1) * 2] !== Math.fround(p.pen.x) || b[(c - 1) * 2 + 1] !== Math.fround(p.pen.z)) offLine++
    }
    if (p.pen.lift < 0 || p.pen.lift > 1) liftBad++
    maxMove = Math.max(maxMove, Math.hypot(p.pen.x - last.x, p.pen.z - last.z))
    last = { x: p.pen.x, z: p.pen.z }
    if (p.sheetNo !== lastSheet) {
      swaps++
      lastSheet = p.sheetNo
    }
    for (const s of p.sheets) if (s.op < 0 || s.op > 1) opBad++
  })
  // Every stored point of both buffers, as they stand at the end.
  for (const s of [0, 1]) {
    const b = a.buf[s]!
    for (let k = 0; k < a.count[s]!; k++) {
      const x = b[k * 2]!
      const z = b[k * 2 + 1]!
      if (Math.abs(x) > AREA.hx + 1e-6 || Math.abs(z - PAPER.cz) > AREA.hz + 1e-6 || Math.abs(x) > papX || z < papZ0 || z > papZ1) outside++
    }
  }
  // And every point ever drawn, checked as it is appended.
  let everOutside = 0
  drive(5, 9, N, (p) => {
    if (!p.penDown) return
    if (Math.abs(p.pen.x) > AREA.hx + 1e-9 || Math.abs(p.pen.z - PAPER.cz) > AREA.hz + 1e-9) everOutside++
  })
  assert(swaps >= 3, `the plotter finishes drawings and starts fresh sheets on its own (${swaps} sheets in ${N * DT}s)`)
  assert(outside === 0 && everOutside === 0, 'no drawn point ever leaves the drawable area of the paper')
  assert(offLine === 0, 'while the pen is down its tip is exactly the last point drawn')
  assert(downOutsideDraw === 0, 'the pen is only down while drawing (never while travelling or swapping)')
  assert(liftBad === 0 && opBad === 0, 'pen lift and sheet opacity stay within 0..1')
  assert(maxMove < 0.6 * DT, `the gantry never jumps (max ${(maxMove / DT).toFixed(3)} m/s)`)

  const b = drive(5, 9, N)
  const same = [0, 1].every(s => a.count[s] === b.count[s] && a.buf[s]!.every((v, i) => Object.is(v, b.buf[s]![i])))
  assert(same, 'the same seed and inputs draw the same picture')
  const c = drive(6, 9, N)
  assert(c.buf[0]!.some((v, i) => v !== a.buf[0]![i]), 'a different seed draws a different picture')
  const d = drive(5, 10, N)
  assert(d.buf[0]!.some((v, i) => v !== a.buf[0]![i]), 'the music (pitch and level) changes the drawing')
  assert(CAP > DRAW_S * 200, 'the line buffer holds a whole drawing at one point per step')
}

// ── 7. 'plot' finishes the drawing early and feeds a fresh sheet ─────────
{
  const p = new Plotter(5)
  const input = { pitch01: 0.5, active: false, level: 0 }
  while (!(p.phase === 'draw' && p.progress > 0.3)) p.step(DT, input)
  const sheet = p.sheetNo
  assert(p.restart() === 'started', 'restart() accepts while drawing')
  assert(p.restart() === 'busy', 'a second restart while the pen lifts is reported as busy')
  let downAfter = 0
  let steps = 0
  while (p.sheetNo === sheet && steps < 200 * 10) {
    p.step(DT, input)
    if (p.penDown) downAfter++
    steps++
  }
  assert(p.sheetNo === sheet + 1 && p.count[p.cur] === 0, `a new sheet starts within ${(steps * DT).toFixed(1)} s`)
  assert(downAfter === 0, 'the pen stays up from the restart to the new sheet')
}

// ── 8. Determinism across frame rates ────────────────────────────────────
{
  // A scripted session (keyed to the step count, as the stage delivers input
  // between steps): theremin, a knob turn, a release, the arpeggio, a restart.
  const script = (sim: NoiseSim, i: number) => {
    if (i === 300) sim.voice.hold(0.3, 0.6)
    if (i === 900) sim.voice.move(0.8, 0.2)
    if (i === 1400) sim.voice.setKnob(0, 0.9)
    if (i === 2000) sim.voice.release()
    if (i === 2600) sim.voice.arp()
    if (i === 5200) sim.plot.restart()
  }
  const N = 200 * 40
  const run = (hz: number) => {
    const sim = new NoiseSim(11)
    const clock = new FixedClock()
    const out = new Float64Array(SNAP.size)
    let steps = 0
    let now = 0
    clock.advance(now, () => {})
    while (steps < N) {
      now += 1000 / hz
      clock.advance(now, () => {
        if (steps < N) {
          script(sim, steps)
          sim.step(DT)
          steps++
        }
      })
      sim.snapshot(out)
    }
    return { sim, snap: Array.from(sim.snapshot(out)), steps }
  }
  const r30 = run(30)
  const r60 = run(60)
  const r144 = run(144)
  const eq = (a: typeof r30, b: typeof r30) =>
    a.snap.every((v, i) => Object.is(v, b.snap[i]))
    && [0, 1].every(s => a.sim.plot.count[s] === b.sim.plot.count[s] && a.sim.plot.buf[s]!.every((v, i) => Object.is(v, b.sim.plot.buf[s]![i])))
    && Object.is(a.sim.voice.semis, b.sim.voice.semis) && Object.is(a.sim.voice.env, b.sim.voice.env)
  assert(r30.steps === N && r60.steps === N && r144.steps === N, `all three runs reach ${N} steps`)
  assert(eq(r30, r60) && eq(r60, r144), 'state (voice, cone, knobs, pen, both drawings) is bit-identical at 30, 60 and 144 Hz')
}

// ── 9. The framing: machines fill the focus box, bench and all stay inside ─
{
  // The homepage's chapter focus boxes (fractions x0 x1 y0 y1), per screen.
  const DESK = [0.36, 1, 0, 1] as const
  const PHONE = [0, 1, 0, 0.6] as const
  const sizes = [[1440, 900, DESK], [1920, 1080, DESK], [2560, 1080, DESK], [390, 844, PHONE]] as const
  const ndc = (cam: THREE.OrthographicCamera, boxes: Box[]) => {
    const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }
    const p = new THREE.Vector3()
    for (const box of boxes) {
      for (const x of [box.x0, box.x1]) {
        for (const y of [box.y0, box.y1]) {
          for (const z of [box.z0, box.z1]) {
            p.set(x, y, z).project(cam)
            b.x0 = Math.min(b.x0, p.x)
            b.x1 = Math.max(b.x1, p.x)
            b.y0 = Math.min(b.y0, p.y)
            b.y1 = Math.max(b.y1, p.y)
          }
        }
      }
    }
    return b
  }
  for (const [W, H, f] of sizes) {
    const w = W * (f[1] - f[0])
    const h = H * (f[3] - f[2])
    const cam = makeCamera()
    const place = frameCamera(cam, w, h)
    // Without a view offset the camera's frustum IS the focus box (stage.ts adds the offset).
    const s = ndc(cam, subjectBoxes(place))
    const all = ndc(cam, [...subjectBoxes(place), benchBox(place)])
    const inside = (b: typeof s) => b.x0 >= -1 && b.x1 <= 1 && b.y0 >= -1 && b.y1 <= 1
    const share = (s.x1 - s.x0) / 2
    assert(inside(s) && inside(all), `${W}x${H} (${place}): machine, plotter and bench stay inside the focus box`)
    assert(share >= 0.75 && share <= 0.85, `${W}x${H}: the machines span ${Math.round(share * 100)}% of the focus box width (75..85)`)
  }
  // Both machines stand on the top, clear of each other and inside its edges.
  for (const place of ['wide', 'tall'] as const) {
    const [m, p] = subjectBoxes(place) as [Box, Box]
    const top = tableTop(place)
    const apart = m.x1 <= p.x0 || p.x1 <= m.x0 || m.z1 <= p.z0 || p.z1 <= m.z0
    const onTop = [m, p].every(b => b.x0 > top.x0 && b.x1 < top.x1 && b.z0 > top.z0 && b.z1 < top.z1 && b.y0 === TABLE.h)
    assert(apart && onTop, `${place}: machine and plotter stand apart, on the bench top`)
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall noise checks passed')
