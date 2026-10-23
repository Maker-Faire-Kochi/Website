import { THETA_DOWN, THETA_UP, type Phase } from './cycle'
import { DECK, ROPES, SCOOP, boomToWorld, type V3 } from './layout'

/**
 * Where the fishers' hands are on the red operating ropes, as a pure function
 * of the dip cycle (no three.js, so the tests run the same numbers the scene
 * draws).
 *
 * THE RIG. Each rope is tied under the boom's rear end and runs down to a
 * block (a pin on a post, waist high on the deck); from the block its hauled
 * part -- the TAIL -- runs level along the deck to the fisher behind it. The
 * tail is a fixed straight line, so a hand on it is given as `h`, its distance
 * from the block, and is always exactly on the drawn rope. Hauling the tail
 * toward himself shortens the rope between block and boom: the rear end comes
 * down and the net comes up. That is why the boom's lift IS the haul here: a
 * hand gripping the rope moves with the rope's material, h = const + (rope
 * hauled so far), never by a clock.
 *
 * Over one cycle:
 *  - rest: the hands hold the tail in front of the belly, one forward, one back;
 *  - lower: the rope pays out toward the block -- the gripping hands are drawn
 *    forward with it, arms out, the body leaning in, until they reach forward
 *    as far as they comfortably go and the rope runs through them (a smooth
 *    cap, so a hand slows into it rather than stopping dead);
 *  - soak: they take their hauling grips again (forward hand forward, back
 *    hand back), then hold;
 *  - lift: hand over hand, STROKES[i] strokes, the two hands alternating. A
 *    gripping hand moves exactly with the rope; the other comes forward past
 *    it, lifted over it (`off`), to take a new grip. The haul phase (strokes
 *    done / 2) is the pull-rope stance's rope phase, so the body leans back on
 *    every stroke. After the last stroke the hands are back at the rest hold.
 * Every hand path is continuous in position and velocity: gripping hands move
 * with the rope, whose speed eases to zero at both ends of the lift and of the
 * lowering, and each recovery is a Hermite curve that matches the rope speed
 * at both of its ends.
 */

/** Rope i's boom end (world) at tilt theta. */
export function ropeFrom(i: number, theta: number, out: V3 = [0, 0, 0]): V3 {
  return boomToWorld(ROPES[i]!.from, theta, out)
}

/** Rope i's block on the deck (world, fixed): where the boom part ends and the tail begins. */
export function ropeTo(i: number): V3 {
  return ROPES[i]!.to
}

const _f: V3 = [0, 0, 0]
/** Length of rope i between the boom and its block. */
export function ropeLength(i: number, theta: number) {
  const f = ropeFrom(i, theta, _f)
  const t = ROPES[i]!.to
  return Math.hypot(f[0] - t[0], f[1] - t[1], f[2] - t[2])
}

/** Unit direction of each tail on the deck, from its block toward its fisher (level, a little outboard). */
export const TAIL: [number, number][] = ROPES.map((r) => {
  const l = Math.hypot(r.tail[0], r.tail[1])
  return [r.tail[0] / l, r.tail[1] / l]
})
/** A fisher stands this far back from his block, along the tail. */
export const FISHER_AT = 0.85
/** The forward hand grips this far in front of the fisher (arms comfortably out). */
const REACH = 0.36
/** The tail point at distance h from block i (world). */
export function tailPoint(i: number, h: number, out: V3 = [0, 0, 0]): V3 {
  const b = ROPES[i]!.to
  out[0] = b[0] + TAIL[i]![0] * h
  out[1] = b[1]
  out[2] = b[2] + TAIL[i]![1] * h
  return out
}
/** Where a fisher stands (deck frame x, z) and his heading (facing his block). */
export function fisherPlace(i: number) {
  const b = ROPES[i]!.to
  const x = b[0] + TAIL[i]![0] * FISHER_AT
  const z = b[2] + TAIL[i]![1] * FISHER_AT
  return { x, z, heading: Math.atan2(b[0] - x, b[2] - z) }
}
/** Where the tail leaves the hands (in front of the belly) and where it lies on the deck beside him. */
export function tailEnds(i: number) {
  const p = fisherPlace(i)
  const e = tailPoint(i, FISHER_AT - 0.15)
  const t = TAIL[i]!
  // Square to the tail, toward his inboard side (toward the boom; outboard is the deck edge).
  let nx = -t[1]
  let nz = t[0]
  if (nz * ROPES[i]!.to[2] > 0) {
    nx = -nx
    nz = -nz
  }
  // The hauled rope drops to the deck ahead of him on that side, well clear of his legs.
  const c: V3 = [p.x - t[0] * 0.45 + nx * 0.6, DECK.top + 0.01, p.z - t[1] * 0.45 + nz * 0.6]
  return { e, c }
}

/**
 * Where the scoop net rests (world): `p` the pole's axis beside fisher 0's left
 * hip (his left hand takes it there, and holds it there all through the
 * scoop), `dir` the pole's direction toward the hoop (his forward, level).
 */
export function scoopRest() {
  const f = fisherPlace(0)
  const fx = Math.sin(f.heading)
  const fz = Math.cos(f.heading)
  // His left: forward turned a quarter to the left (+90 deg about y).
  const lx = fz
  const lz = -fx
  const p: V3 = [f.x + lx * SCOOP.side, DECK.top + SCOOP.rackY, f.z + lz * SCOOP.side]
  const dir: V3 = [fx, 0, fz]
  return { p, dir }
}

export const L_UP = ROPES.map((_, i) => ropeLength(i, THETA_UP))
export const L_DOWN = ROPES.map((_, i) => ropeLength(i, THETA_DOWN))
/** Rope hauled per lift. */
export const HAUL = ROPES.map((_, i) => L_DOWN[i]! - L_UP[i]!)
/**
 * Hand-over-hand strokes per lift, per rope (even: the hands end where they
 * started): as few as give each hand a long, deliberate pull of about 0.2 m --
 * short strokes read as twitching.
 */
export const STROKES = HAUL.map(x => 2 * Math.max(1, Math.round(x / 0.4)))
/** Rope hauled per stroke (each hand's pull, and the hands' spacing at rest). */
export const STROKE = HAUL.map((x, i) => x / STROKES[i]!)
const H_FRONT = FISHER_AT - REACH
/** The forward hand can go this much further when paying out (leaning in); the back one stops this far behind it. */
const PAY_REACH = 0.03
const PAY_GAP = 0.13
/** Softness of the pay-out cap (m). */
const SOFT = 0.03
/** How far a recovering hand lifts over the gripping one (m), and over what gap. */
export const PASS = 0.13
const PASS_GAP = 0.13
/** Fraction of the soak spent re-taking the hauling grips. */
const REGRIP = 0.6

/** Smooth maximum (log-sum-exp): within SOFT ln 2 of max(a, b), smooth across a = b. */
function smax(a: number, b: number) {
  return Math.max(a, b) + SOFT * Math.log1p(Math.exp(-Math.abs(a - b) / SOFT))
}

/** Cubic Hermite from a to b over q in [0, 1] with end slopes m0, m1 (dh/dq). */
function hermite(a: number, b: number, m0: number, m1: number, q: number) {
  const q2 = q * q
  const q3 = q2 * q
  return (2 * q3 - 3 * q2 + 1) * a + (q3 - 2 * q2 + q) * m0 + (-2 * q3 + 3 * q2) * b + (q3 - q2) * m1
}

const smoother = (u: number) => {
  const x = Math.min(1, Math.max(0, u))
  return x * x * x * (x * (x * 6 - 15) + 10)
}
/** sin^2 bump over [0, 1]: zero value and slope at both ends. */
const bump = (u: number) => Math.sin(Math.PI * Math.min(1, Math.max(0, u))) ** 2

export interface Grip {
  /** Distance from the block along the tail: [forward hand, back hand] at the rest hold. */
  h: [number, number]
  /** Lift of a recovering hand over the other (m; 0 = on the rope). */
  off: [number, number]
  /** Whether each hand is holding the rope (moving with it) this instant. */
  grip: [boolean, boolean]
  /** Haul phase in [0, 1): advances only while hauling (the lift). */
  ropePhase: number
  /** Torso lean (rad, + forward) the work asks for. */
  lean: number
}

export function newGrip(): Grip {
  return { h: [0, 0], off: [0, 0], grip: [true, true], ropePhase: 0, lean: 0 }
}

/** The two hands at the end of the lowering (the soak re-grip starts from here). */
function paidOut(i: number, paid: number, out: [number, number]) {
  // Less the cap's pull at paid = 0, so the lowering starts exactly from the rest hold.
  const a0 = H_FRONT
  const a1 = H_FRONT + STROKE[i]!
  const b0 = H_FRONT - PAY_REACH
  const b1 = H_FRONT - PAY_REACH + PAY_GAP
  out[0] = smax(a0 - paid, b0) - (smax(a0, b0) - a0)
  out[1] = smax(a1 - paid, b1) - (smax(a1, b1) - a1)
  return out
}
const _pay: [number, number] = [0, 0]
const LEAN_PAY = 0.2

/**
 * Rope i's hands for a moment of the cycle: `phase` and `u` (fraction through
 * it) from the cycle clock, `theta` the boom tilt at that moment.
 */
export function grips(i: number, phase: Phase, u: number, theta: number, out: Grip = newGrip()): Grip {
  const S = STROKE[i]!
  out.off[0] = out.off[1] = 0
  out.grip[0] = out.grip[1] = true
  out.ropePhase = 0
  out.lean = 0
  if (phase === 'rest') {
    out.h[0] = H_FRONT
    out.h[1] = H_FRONT + S
    return out
  }
  if (phase === 'lower') {
    const paid = Math.max(0, ropeLength(i, theta) - L_UP[i]!)
    paidOut(i, paid, out.h)
    out.lean = LEAN_PAY * smoother(paid / 0.15)
    return out
  }
  if (phase === 'soak') {
    paidOut(i, HAUL[i]!, _pay)
    const q = smoother(u / REGRIP)
    out.h[0] = _pay[0] + (H_FRONT - _pay[0]) * q
    out.h[1] = _pay[1] + (H_FRONT + S - _pay[1]) * q
    out.grip[0] = out.grip[1] = u >= REGRIP + 0.02
    out.lean = LEAN_PAY * smoother(HAUL[i]! / 0.15) * (1 - q)
    return out
  }
  // Lift: hand over hand, paced by the rope.
  const phi = Math.min(STROKES[i]! / 2, Math.max(0, (L_DOWN[i]! - ropeLength(i, theta)) / (2 * S)))
  out.ropePhase = phi - Math.floor(phi)
  // The stance leans back on every stroke; the shoulders stay over the rope a little, so the
  // forward hand can take its new grip.
  out.lean = 0.06 * bump(u)
  for (const k of [0, 1] as const) {
    const p = (phi + (k === 0 ? 0 : 0.5)) % 1
    if (p < 0.5) {
      out.h[k] = H_FRONT + S * (p / 0.5)
    }
    else {
      const q = (p - 0.5) / 0.5
      out.h[k] = hermite(H_FRONT + S, H_FRONT, S, S, q)
      out.grip[k] = false
      out.off[k] = Math.sin(Math.PI * q)
    }
  }
  // Lift a recovering hand only where it passes the gripping one.
  for (const k of [0, 1] as const) {
    if (out.off[k] > 0) out.off[k] *= PASS * Math.exp(-(((out.h[k] - out.h[1 - k]!) / PASS_GAP) ** 2))
  }
  return out
}

/** Cycle seconds at which the lift's haul phase reaches `phi` (for the poster pose). */
export function liftTimeAt(i: number, phi: number, thetaOf: (t: number) => number, liftStart: number, liftDur: number) {
  const target = L_DOWN[i]! - 2 * STROKE[i]! * phi
  let lo = 0
  let hi = liftDur
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2
    if (ropeLength(i, thetaOf(liftStart + mid)) > target) lo = mid
    else hi = mid
  }
  return liftStart + (lo + hi) / 2
}
