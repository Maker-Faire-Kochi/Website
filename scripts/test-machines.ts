import { EVENT, EVENT_END, EVENT_START } from '../app/composables/useCountdown'
import { DT, FixedClock } from '../app/three/core/clock'
import { rng } from '../app/three/core/rng'
import {
  ESCAPE, ESCAPE_OFFSET, GEARS, MESHES, MOTION, SHAFTS,
  centreDistance, escapeOutline, gear, gearOutline, inside, outerR, palletCorners, pitchR, place, shaftAngle,
  type GearId,
} from '../app/three/scenes/machines/gears'
import { carried, expectedReading, flapState, reading, wheelPositions, wheels } from '../app/three/scenes/machines/odometer'
import { EV, MachineSim, SNAP, tickEased } from '../app/three/scenes/machines/sim'
import {
  AXLE_Y, BEAM, CARD_H, CRANK, FLAP, FLAP_Z, FOLIOT, GLYPH_H, LABEL, LAYER, PANEL_PAD, PLATE_X,
  board, display, nameplate, viewAngles,
} from '../app/three/scenes/machines/layout'
import { plateLines } from '../app/three/scenes/machines/flaps'

/**
 * Pure-logic checks for the machine room (the Countdown sheet): the counter
 * always reads the true countdown at rest, carries the odometer way, the gear
 * train meshes (ratios, senses, centre distances, no interpenetration), the
 * crank can never wind the time backwards, and the motion is the same at any
 * frame rate. Run: npx --yes tsx scripts/test-machines.ts
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

const START = EVENT_START.getTime()
const END = EVENT_END.getTime()
const W2 = wheels(2)
const R = rng(2027)

/** A sim on a virtual clock that advances exactly with its steps. */
function simAt(ms: number) {
  let now = ms
  const sim = new MachineSim({ startMs: START, endMs: END, now: () => now })
  return {
    sim,
    run(seconds: number) {
      const n = Math.round(seconds / DT)
      for (let i = 0; i < n; i++) {
        now += DT * 1000
        sim.step(DT)
      }
    },
    get now() {
      return now
    },
  }
}

/** What useCountdown shows at wall time ms (partsFor: floor of the distance; zeros once live). */
function truth(ms: number) {
  const n = ms >= START ? 0 : Math.floor((START - ms) / 1000)
  return expectedReading(n, 2)
}

// ── 1. The counter reads the countdown, carrying like an odometer ────────
{
  const samples: number[] = [0, 1, 9, 10, 59, 60, 61]
  for (const P of [60, 600, 3600, 36000, 86400, 864000]) {
    for (let k = 1; k <= 9; k++) for (let d = -2; d <= 2; d++) samples.push(P * k + d)
  }
  // Every hour boundary across three days (the 23 -> 00 day carry included).
  for (let h = 0; h < 72; h++) for (const d of [-1, 0, 1]) samples.push(h * 3600 + d)
  for (let i = 0; i < 20000; i++) samples.push(Math.floor(R.range(0, 99.99 * 86400)))
  const ok = samples.filter(n => n >= 0).every(n => reading(n, W2) === expectedReading(n, 2))
  assert(ok, `reading(n) equals DD HH MM SS for ${samples.length} counts incl. every minute/hour/day rollover`)

  const W3 = wheels(3)
  const ok3 = [0, 99 * 86400, 100 * 86400 - 1, 100 * 86400, 123 * 86400 + 4000].every(n => reading(n, W3) === expectedReading(n, 3))
  assert(ok3, 'with three day wheels the hundreds roll correctly (99 -> 100 days)')

  // Carry: stepping the count down by one changes a wheel only when the wheel
  // to its right wraps (shows a HIGHER digit after the step: 0 -> 9, 0 -> 5, 00 -> 23).
  let bad = 0
  let rightmostStill = 0
  for (const n0 of samples) {
    const n = n0 + 1
    const a = reading(n, W2)
    const b = reading(n - 1, W2)
    if (a[a.length - 1] === b[b.length - 1]) rightmostStill++
    for (let i = 0; i < W2.length - 1; i++) {
      const changed = a[i] !== b[i]
      const rightWrapped = Number(b[i + 1]) > Number(a[i + 1])
      if (changed && !rightWrapped) bad++
    }
  }
  assert(bad === 0, `a wheel moves only when the wheel to its right wraps (violations: ${bad})`)
  assert(rightmostStill === 0, 'the seconds wheel changes on every step')

  // Positions are continuous through every roll (no wheel jumps more than a sliver per sliver of count).
  let jumps = 0
  let notWhole = 0
  const pa = new Float64Array(W2.length)
  const pb = new Float64Array(W2.length)
  for (const n0 of samples.slice(0, 3000)) {
    const n = n0 + 1
    wheelPositions(n, W2, pa)
    if (pa.some(p => Math.abs(p - Math.round(p)) > 1e-9)) notWhole++
    for (let s = 1; s <= 40; s++) {
      wheelPositions(n - s / 40, W2, pb)
      for (let i = 0; i < W2.length; i++) {
        const f = W2[i]!.faces
        let d = Math.abs(pb[i]! - pa[i]!) % f
        d = Math.min(d, f - d)
        if (d > 0.2) jumps++
      }
      pa.set(pb)
    }
  }
  assert(notWhole === 0, 'every wheel stands exactly on a face at a whole count')
  assert(jumps === 0, `wheel positions are continuous through the roll (jumps: ${jumps})`)
  assert(carried(9.5, 10) === 0.5 && carried(5.5, 10) === 0 && carried(19.25, 10) === 1.25, 'carried(): moves only in the last unit before the place rolls')
}

// ── 2. At rest the counter equals the true countdown ─────────────────────
{
  const times: number[] = []
  const day = 86400000
  for (let i = 0; i < 300; i++) times.push(START - Math.floor(R.range(1000, 95 * day)))
  // Seconds before day, hour and minute boundaries, the last minute, and the start itself.
  for (const k of [3 * day, 2 * day, day, 3600000 * 5, 3600000, 60000, 10000]) {
    for (const d of [-1500, -900, -400, 0, 400, 900, 1500]) times.push(START - k + d)
  }
  for (let d = -5000; d <= 5000; d += 250) times.push(START + d)
  times.push(END - 2000, END + 2000)

  let wrong = 0
  let checks = 0
  const bad: string[] = []
  for (const t0 of times) {
    const v = simAt(t0)
    // Sample 30 instants over 3 s; at rest = at least one tick roll past the last second boundary.
    for (let i = 0; i < 30; i++) {
      v.run(0.1)
      const sinceBoundary = ((START - v.now) % 1000 + 1000) % 1000
      const e = 1000 - sinceBoundary
      if (v.now < START && (e < ESCAPE.tick * 1000 + 6 || e > 999)) continue
      checks++
      const got = reading(v.sim.count(), W2)
      if (got !== truth(v.now)) {
        wrong++
        if (bad.length < 3) bad.push(`${new Date(v.now).toISOString()} shows ${got}, true ${truth(v.now)}`)
      }
    }
  }
  assert(wrong === 0, `at rest the counter reads the true countdown at ${checks} instants incl. rollovers and the start (wrong: ${wrong}${bad.length ? ': ' + bad.join('; ') : ''})`)

  const live = simAt(START + 3000)
  live.run(1)
  assert(live.sim.phase() === 'live' && reading(live.sim.count(), W2) === '00000000', 'after the start the phase is live and the counter reads 00 00 00 00')
  const g0 = live.sim.train()
  live.run(2)
  assert(live.sim.train() > g0 + 1.9, 'while live the train keeps ticking (2 s -> 2 units of g)')
  const ended = simAt(END + 1000)
  const e0 = ended.sim.train()
  ended.run(3)
  assert(ended.sim.phase() === 'ended' && ended.sim.train() === e0, 'after the end the train stands still')

  // The roll itself: eased, monotonic, exactly whole after the tick.
  let mono = true
  let prev = tickEased(10.999999)
  for (let r = 10.999; r > 9; r -= 0.001) {
    const v = tickEased(r)
    if (v > prev + 1e-12) mono = false
    prev = v
  }
  assert(mono && tickEased(10.5) === 10 && Math.abs(tickEased(11 - 1e-9) - 11) < 1e-6, 'tick roll is monotonic, starts at the old second and rests exactly on the new one')
}

// ── 3. The gear train meshes ─────────────────────────────────────────────
{
  let distOk = true
  for (const [p, q] of MESHES) {
    const P = SHAFTS[gear(p).shaft]
    const Q = SHAFTS[gear(q).shaft]
    const d = Math.hypot(Q.x - P.x, Q.y - P.y)
    if (Math.abs(d - centreDistance(gear(p).teeth, gear(q).teeth)) > 1e-12) distOk = false
    if (gear(p).layer !== gear(q).layer) distOk = false
  }
  assert(distOk, 'every meshing pair: centre distance = sum of pitch radii, same layer')

  // Angular velocity by finite difference over a small step, away from wraps.
  const omega = (id: GearId, g: number) => {
    const s = gear(id).shaft
    const h = 1e-4
    let d = shaftAngle(s, g + h) - shaftAngle(s, g - h)
    d = Math.atan2(Math.sin(d), Math.cos(d))
    return d / (2 * h)
  }
  let ratioOk = true
  let senseOk = true
  let maxErr = 0
  for (const g of [3.3, 1234.567, 8.3e6 + 0.42, -7.7e6 - 0.13]) {
    for (const [p, q] of MESHES) {
      const wp = omega(p, g)
      const wq = omega(q, g)
      const want = -gear(p).teeth / gear(q).teeth
      const err = Math.abs(wq / wp - want)
      maxErr = Math.max(maxErr, err)
      if (err > 1e-6) ratioOk = false
      if (Math.sign(wq) === Math.sign(wp)) senseOk = false
    }
    if (Math.abs(omega('B', g) - omega('C', g)) > 1e-9) ratioOk = false
  }
  assert(ratioOk, `angular velocity ratios equal the tooth ratios exactly (max error ${maxErr.toExponential(1)})`)
  assert(senseOk, 'adjacent gears counter-rotate')
  const per = Object.fromEntries(Object.entries(MOTION).map(([k, m]) => [k, m.period]))
  assert(per.O === 10 && per.M === 20 && per.K === 60 && per.X === 30, `periods: axle 10 s (seconds drum), crank 60 s, escape arbor 30 s (${JSON.stringify(per)})`)
  const axleRate = Math.abs(omega('D', 77.7)) * 10 / (2 * Math.PI)
  assert(Math.abs(axleRate - 1) < 1e-6, 'the seconds drum turns one face per displayed second')

  // Teeth interleave: no outline vertex of one gear inside its mate, at many angles.
  const outline = Object.fromEntries(GEARS.map(g => [g.id, gearOutline(g.teeth)])) as Record<GearId, number[]>
  let hits = 0
  let samples = 0
  const tight: number[] = []
  for (let i = 0; i < 400; i++) {
    const g = i < 200 ? i * 0.0731 : R.range(-9e6, 9e6)
    for (const [p, q] of MESHES) {
      const P = SHAFTS[gear(p).shaft]
      const Q = SHAFTS[gear(q).shaft]
      const a = place(outline[p], shaftAngle(gear(p).shaft, g), P.x, P.y)
      const b = place(outline[q], shaftAngle(gear(q).shaft, g), Q.x, Q.y)
      for (let k = 0; k < a.length; k += 2) if (inside(b, a[k]!, a[k + 1]!)) hits++
      for (let k = 0; k < b.length; k += 2) if (inside(a, b[k]!, b[k + 1]!)) hits++
      // How deep the teeth actually reach into each other: tips of p inside q's outer circle.
      let deepest = Infinity
      for (let k = 0; k < a.length; k += 2) deepest = Math.min(deepest, Math.hypot(a[k]! - Q.x, a[k + 1]! - Q.y))
      tight.push(outerR(gear(q).teeth) - deepest)
      samples++
    }
  }
  assert(hits === 0, `no tooth interpenetration across ${samples} sampled mesh positions (vertices inside the mate: ${hits})`)
  const engage = Math.min(...tight)
  assert(engage > 0.01, `teeth genuinely engage: at every sample a tooth reaches over a module into its mate (min ${(engage * 1000).toFixed(1)} mm)`)
  // Anti-test: shift one gear by a quarter pitch and the check must catch it.
  {
    const P = SHAFTS.O
    const Q = SHAFTS.M
    const a = place(outline.D, shaftAngle('O', 0), P.x, P.y)
    const b = place(outline.C, shaftAngle('M', 0) + Math.PI / 24 / 2, Q.x, Q.y)
    let caught = 0
    for (let k = 0; k < a.length; k += 2) if (inside(b, a[k]!, a[k + 1]!)) caught++
    assert(caught > 0, `the interpenetration check detects a quarter-pitch phase error (${caught} vertices)`)
  }
  // Gears sharing a layer that do not mesh stay clear of each other.
  let clear = true
  for (const a of GEARS) {
    for (const b of GEARS) {
      if (a.id >= b.id || a.layer !== b.layer || a.shaft === b.shaft) continue
      if (MESHES.some(m => m.includes(a.id) && m.includes(b.id))) continue
      const A = SHAFTS[a.shaft]
      const B = SHAFTS[b.shaft]
      if (Math.hypot(A.x - B.x, A.y - B.y) < outerR(a.teeth) + outerR(b.teeth) + 0.005) clear = false
    }
  }
  assert(clear, 'non-meshing gears on one layer keep at least 5 mm between tip circles')
  assert(pitchR(36) === 0.18, 'pitch radius from the module: 36 teeth at m = 10 mm is 180 mm')
}

// ── 4. Escapement: the locking pallet sits in a space, never in a tooth ──
{
  const wheel = escapeOutline()
  const X = SHAFTS.X
  let inTooth = 0
  let duringTick = 0
  let lockedChecks = 0
  const v = simAt(START - 40 * 86400000 + 123)
  for (let i = 0; i < 6000; i++) {
    v.run(DT)
    const snap = v.sim.snapshot(new Float64Array(SNAP.size))
    const w = place(wheel, shaftAngle('X', snap[SNAP.g]!) + ESCAPE_OFFSET, X.x, X.y)
    const c = palletCorners(snap[SNAP.swing]!)
    for (let k = 0; k < c.length; k += 2) {
      if (inside(w, c[k]!, c[k + 1]!)) inTooth++
    }
    const rem = v.sim.rem()
    const e = Math.floor(rem) + 1 - rem
    if (e < ESCAPE.tick) {
      for (let k = 0; k < c.length; k += 2) if (Math.hypot(c[k]! - X.x, c[k + 1]! - X.y) < ESCAPE.ra) duringTick++
    }
    else {
      // Locked: exactly one pallet below the tip circle.
      let below = 0
      for (let k = 0; k < c.length; k += 4) if (Math.hypot(c[k]! - X.x, c[k + 1]! - X.y) < ESCAPE.ra) below++
      if (e > ESCAPE.tick + 0.1 && e < 0.95 && below === 1) lockedChecks++
      else if (e > ESCAPE.tick + 0.1 && e < 0.95) inTooth += 1000
    }
  }
  assert(inTooth === 0, 'pallet corners never inside an escape-wheel tooth over 30 s of ticking')
  assert(duringTick === 0, 'both pallets are clear of the tooth tips while the wheel turns')
  assert(lockedChecks > 2000, `between ticks exactly one pallet is down in a space (${lockedChecks} checks)`)
}

// ── 5. The crank: winds ahead, never back past now, always comes home ────
{
  const v = simAt(START - 10 * 86400000 - 3456789)
  v.run(1.5)
  let behind = 0
  let negative = 0
  let ratchets = 0
  const drag = rng(9)
  for (let round = 0; round < 40; round++) {
    v.sim.beginDrag()
    for (let i = 0; i < 120; i++) {
      // Mostly forward, sometimes hard backwards.
      v.sim.dragBy(drag.range(-0.35, 0.25) * MOTION.K.sense)
      v.run(DT * 2)
      if (v.sim.takeEvents() & EV.RATCHET) ratchets++
      if (v.sim.lead < 0) negative++
      if (v.sim.count() > v.sim.trueCount() + 1e-9) behind++
    }
    v.sim.endDrag()
    v.run(0.3)
  }
  assert(negative === 0, 'the lead never goes negative under random winding')
  assert(behind === 0, 'the counter never shows more time left than there is (never wound back past now)')
  assert(ratchets > 0, 'winding backwards into the true time hits the ratchet')
  v.run(3)
  assert(v.sim.mode === 'idle' && v.sim.lead === 0, 'after release the crank eases home: lead exactly 0')
  v.run(0.5)
  assert(reading(v.sim.count(), W2) === truth(v.now), 'and the counter reads the true time again')

  // Forward winding races ahead by the crank ratio: one turn = one minute.
  const f = simAt(START - 5 * 86400000 - 500)
  f.run(0.4)
  f.sim.beginDrag()
  for (let i = 0; i < 100; i++) {
    f.sim.dragBy(MOTION.K.sense * 2 * Math.PI / 100)
    f.run(DT)
  }
  f.run(0.3)
  const ahead = f.sim.lead
  assert(Math.abs(ahead - 60) < 1, `one crank turn winds the counter one minute ahead (${ahead.toFixed(2)} s)`)
  f.sim.endDrag()
  assert((f.sim.takeEvents() & EV.RELEASE) !== 0, 'letting go raises the release (ratchet click) event')
  f.run(2.7)
  f.run(0.4)
  assert(f.sim.lead === 0 && reading(f.sim.count(), W2) === truth(f.now), 'released: back on the true time')

  // Scripted crank: three turns ahead, held, then home.
  const s = simAt(START - 20 * 86400000 - 250)
  s.run(0.5)
  s.sim.crank()
  s.run(2.6)
  const peak = s.sim.lead
  assert(Math.abs(peak - 180) < 2, `action crank: three turns = three minutes ahead (${peak.toFixed(1)} s)`)
  s.run(4)
  assert(s.sim.mode === 'idle' && s.sim.lead === 0 && reading(s.sim.count(), W2) === truth(s.now), 'action crank returns to the true time by itself')
  s.sim.crank()
  s.run(1)
  assert(s.sim.reset() && s.sim.mode === 'return', 'reset mid-crank rolls straight back')
  s.run(3)
  assert(s.sim.lead === 0, 'reset ends exactly on the true time')
  // Near the start the counter stops at zero rather than winding past it.
  const z = simAt(START - 30500)
  z.run(0.5)
  z.sim.beginDrag()
  for (let i = 0; i < 200; i++) {
    z.sim.dragBy(MOTION.K.sense * 0.2)
    z.run(DT)
  }
  assert(z.sim.count() >= 0 && reading(z.sim.count(), W2) === '00000000', 'winding past the start stops the counter at 00 00 00 00')
}

// ── 6. Determinism across frame rates ────────────────────────────────────
{
  const run = (hz: number) => {
    let now = START - 3 * 86400000 - 777
    const sim = new MachineSim({ startMs: START, endMs: END, now: () => now })
    const clock = new FixedClock()
    const frame = 1000 / hz
    let t = 0
    clock.advance(t, () => sim.step(DT))
    sim.crank()
    let steps = 0
    // 6 s of frames: the crank, its hold and part of the return.
    while (t < 6000 - 1e-6) {
      t += frame
      now += frame
      clock.advance(t, () => {
        sim.step(DT)
        steps++
      })
    }
    return { steps, snap: Array.from(sim.snapshot(new Float64Array(SNAP.size))), lead: sim.lead }
  }
  const a = run(30)
  const b = run(60)
  const c = run(144)
  const n = Math.min(a.steps, b.steps, c.steps)
  assert(Math.max(a.steps, b.steps, c.steps) - n <= 1, `step counts agree at 30/60/144 Hz (${a.steps}, ${b.steps}, ${c.steps})`)
  // Compare at equal step counts.
  const at = (hz: number, steps: number) => {
    let now = START - 3 * 86400000 - 777
    const sim = new MachineSim({ startMs: START, endMs: END, now: () => now })
    sim.crank()
    for (let i = 0; i < steps; i++) {
      now += DT * 1000
      sim.step(DT)
    }
    return Array.from(sim.snapshot(new Float64Array(SNAP.size)))
  }
  const ref = at(0, n)
  const same = (s: number[]) => s.every((x, i) => x === ref[i])
  const [ra, rb, rc] = [a, b, c].map(r => r.steps === n ? same(r.snap) : true)
  assert(Boolean(ra && rb && rc), 'same step count -> identical train, counter and escapement state at 30/60/144 Hz')
}

// ── 7. The split-flap display: flips, layout, nothing collides ───────────
{
  // A unit at rest shows its face; between faces exactly one flap turns,
  // from up (still covering the figure being left) to down (the new figure).
  let restOk = true
  let monoOk = true
  let edgeOk = true
  for (const faces of [9, 10, 12]) {
    for (let a = -3; a < 30; a++) {
      const r = flapState(a, faces)
      if (r.theta !== Math.PI || r.face !== ((a % faces) + faces) % faces) restOk = false
      let last = Math.PI
      for (let k = 1; k < 100; k++) {
        const s = flapState(a + k / 100, faces)
        if (!(s.theta < last) || s.face !== r.face || s.from !== ((a + 1) % faces + faces) % faces) monoOk = false
        last = s.theta
      }
      // Just below the next whole position the flap stands straight up, carrying the
      // figure the unit showed at a + 1, so nothing jumps when a fall begins.
      if (flapState(a + 1 - 1e-7, faces).theta > 1e-5) edgeOk = false
    }
  }
  assert(restOk, 'split-flap: at a whole position the flap hangs down and the unit shows that face')
  assert(monoOk, 'split-flap: between faces one flap falls, monotonically, from the figure being left to the new one')
  assert(edgeOk, 'split-flap: the fall starts with the flap straight up (seamless from the figure before)')
  // The flaps show the true reading at rest.
  let shownOk = true
  const W3 = wheels(3)
  const pos = new Float64Array(W3.length)
  for (let i = 0; i < 3000; i++) {
    const n = Math.floor(R.range(0, 150 * 86400))
    wheelPositions(n, W3, pos)
    const shown = W3.map((w, j) => w.label(flapState(pos[j]!, w.faces).face)).join('')
    if (shown !== expectedReading(n, 3)) shownOk = false
  }
  assert(shownOk, 'the flaps at rest read the true DDD HH MM SS (3000 random counts)')

  for (const list of [wheels(2), W3]) {
    const D = display(list)
    const tag = `${list.length} units`
    const bottom = D.groups.filter(g => g.group === 'minutes' || g.group === 'seconds')
    assert(bottom.every(g => g.hinge === AXLE_Y), `${tag}: the bottom row hinges on the drive axle's line`)
    assert(Math.abs(D.caseY[0] - BEAM.t) < 1e-9, `${tag}: the case stands on its foot rails (bottom at ${(D.caseY[0] * 1000).toFixed(1)} mm)`)
    // No two groups overlap; each row's cards clear the plates of the row above it.
    let apart = true
    for (const a of D.groups) {
      for (const b of D.groups) {
        if (a === b) continue
        const xOverlap = a.x0 < b.x1 + 0.03 && b.x0 < a.x1 + 0.03
        const yOverlap = Math.abs(a.hinge - b.hinge) < CARD_H + LABEL.h + 0.04
        if (xOverlap && yOverlap) apart = false
      }
      if (a.labelY + LABEL.h / 2 > a.hinge - CARD_H / 2 - 0.02) apart = false
      if (LABEL.w > a.x1 - a.x0 + FLAP.gap + 0.02) apart = false
    }
    assert(apart, `${tag}: groups, cards and name plates never overlap`)
    const inCase = D.groups.every(g => g.x0 > D.caseX[0] && g.x1 < D.caseX[1] && g.labelY - LABEL.h / 2 > D.caseY[0] && g.hinge + CARD_H / 2 < D.caseY[1])
    assert(inCase, `${tag}: every card and plate lies on the case's face`)
    assert(D.caseX[1] < PLATE_X - 2.5 * BEAM.t, `${tag}: the case side is clear of the train's rearmost brace`)
    // Room to breathe: every ink panel (a group's cards plus PANEL_PAD) keeps clear of
    // the other panels, of its own and the other plates, and of the case's edges.
    const panels = D.groups.map(g => ({ g, x0: g.x0 - PANEL_PAD, x1: g.x1 + PANEL_PAD, y0: g.hinge - CARD_H / 2 - PANEL_PAD, y1: g.hinge + CARD_H / 2 + PANEL_PAD }))
    let gapPP = Infinity
    let gapPL = Infinity
    let gapEdge = Infinity
    for (const p of panels) {
      gapEdge = Math.min(gapEdge, p.x0 - D.caseX[0], D.caseX[1] - p.x1, D.caseY[1] - p.y1)
      for (const q of panels) {
        if (p === q) continue
        const dx = Math.max(q.x0 - p.x1, p.x0 - q.x1)
        const dy = Math.max(q.y0 - p.y1, p.y0 - q.y1)
        gapPP = Math.min(gapPP, Math.max(dx, dy))
      }
      for (const g of D.groups) {
        const lx0 = (g.x0 + g.x1) / 2 - LABEL.w / 2
        const lx1 = (g.x0 + g.x1) / 2 + LABEL.w / 2
        if (lx1 < p.x0 || lx0 > p.x1) continue
        gapPL = Math.min(gapPL, Math.max(p.y0 - (g.labelY + LABEL.h / 2), (g.labelY - LABEL.h / 2) - p.y1))
      }
      gapEdge = Math.min(gapEdge, Math.min(...D.groups.map(g => g.labelY - LABEL.h / 2)) - D.caseY[0])
    }
    assert(gapPP >= 0.05 && gapPL >= 0.02 && gapEdge >= 0.05 - 1e-9, `${tag}: panels ${(gapPP * 1000).toFixed(0)} mm apart, plates ${(gapPL * 1000).toFixed(0)} mm off the panels, ${(gapEdge * 1000).toFixed(0)} mm from the case edges`)
    const B = board(list)
    assert(B.z1 > FLAP_Z + FLAP.half + FLAP.split / 2 && B.x0 < D.caseX[0], `${tag}: the board reaches past a falling flap's sweep`)
  }
  // The nameplate fills the patch a third day unit leaves; with two there is no patch and no plate.
  {
    const D = display(W3)
    const np = nameplate(W3)!
    const rects = [
      ...D.groups.map(g => ({ x0: g.x0 - PANEL_PAD, x1: g.x1 + PANEL_PAD, y0: g.hinge - CARD_H / 2 - PANEL_PAD, y1: g.hinge + CARD_H / 2 + PANEL_PAD })),
      ...D.groups.map(g => ({ x0: (g.x0 + g.x1) / 2 - LABEL.w / 2, x1: (g.x0 + g.x1) / 2 + LABEL.w / 2, y0: g.labelY - LABEL.h / 2, y1: g.labelY + LABEL.h / 2 })),
    ]
    const clear = Math.min(...rects.map(r => Math.max(r.x0 - np.x1, np.x0 - r.x1, r.y0 - np.y1, np.y0 - r.y1)))
    const edge = Math.min(np.x0 - D.caseX[0], D.caseX[1] - np.x1, np.y0 - D.caseY[0], D.caseY[1] - np.y1)
    assert(Boolean(np) && clear >= 0.03 && edge >= 0.05 - 1e-9, `three day units: the nameplate clears every panel and plate by ${(clear * 1000).toFixed(0)} mm and the case edges by ${(edge * 1000).toFixed(0)} mm`)
    const D2 = display(wheels(2))
    const col = (a: string, b: string) => {
      const ga = D2.groups.find(g => g.group === a)!
      const gb = D2.groups.find(g => g.group === b)!
      return Math.abs(ga.x0 - gb.x0) < 1e-12 && Math.abs(ga.x1 - gb.x1) < 1e-12
    }
    assert(nameplate(wheels(2)) === null && col('days', 'minutes') && col('hours', 'seconds'), 'two day units: the rows line up exactly, no patch, no plate')
    const ist = EVENT_START.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).toUpperCase()
    assert(plateLines('upcoming').join(' ') === `OPENS ${ist}` && ist.startsWith(`${Number(EVENT.rangeStart.iso.slice(8))} `), `the plate reads "${plateLines('upcoming').join(' ')}" from EVENT_START in Kochi time`)
    assert(plateLines('live').join(' ') === 'OPEN NOW' && plateLines('ended').join(' ') === 'THANK YOU', 'the plate reads OPEN NOW while live and THANK YOU after')
  }
  assert(FLAP.gap >= 0.08 * FLAP.w && FLAP.gap <= 0.12 * FLAP.w, `cards in a group stand apart by ${(100 * FLAP.gap / FLAP.w).toFixed(0)} % of a card's width`)
  assert(PANEL_PAD >= 0.1 * FLAP.w, `each group's ink panel runs ${(PANEL_PAD * 1000).toFixed(0)} mm past its cards`)
  // Dela Gothic One's figures are up to about their own height wide; the card holds that with a margin.
  assert(GLYPH_H <= 0.88 * FLAP.w && GLYPH_H <= 0.7 * CARD_H, `the figure (${GLYPH_H * 1000} mm) fits its card (${FLAP.w * 1000} x ${(CARD_H * 1000).toFixed(0)} mm) with a margin`)
  let elMax = 0
  for (let a = 0.3; a <= 4; a += 0.01) elMax = Math.max(elMax, viewAngles(a).el)
  assert(elMax <= 20 * Math.PI / 180, `the upright cards are seen within 20 deg of square-on at every stage aspect (max ${(elMax * 180 / Math.PI).toFixed(0)} deg)`)
  const low = Math.min(SHAFTS.M.y - outerR(24), SHAFTS.K.y - outerR(36), SHAFTS.K.y - CRANK.arm - 0.013)
  assert(low > 0.02, `the train and the crank's sweep clear the board (${(low * 1000).toFixed(0)} mm)`)
  assert(CRANK.z - 0.007 > LAYER[1]! + 0.009 && FOLIOT.z - 0.006 > LAYER[2]! + 0.006, 'the crank and the foliot ride outside the gear layers they pass over')
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
if (failed) process.exit(1)
