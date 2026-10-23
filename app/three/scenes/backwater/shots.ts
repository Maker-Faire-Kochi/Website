import { FISH_UV } from './catch'
import { BOOM, CLUSTER_DEPTH, DECK, FULCRUM, HANG_LOCAL, NET, PALMS, ROPES, boomToWorld, netCorners, netPoint, palmPoint, type V3 } from './layout'
import { THETA_DOWN, THETA_UP } from './cycle'

/**
 * Scroll-driven camera shots for the backwater. The page pins the Kochi
 * chapter while the visitor scrolls through its four panels and writes
 * `scrollShot.progress` (0 at the first panel, SHOTS.length - 1 at the last,
 * fractions in between).
 *
 * The camera is a PERSPECTIVE one (FOV_DEG vertical). Each shot is a
 * FRAMING -- a world target, the camera's distance from it, and its azimuth
 * and elevation -- fitted around that shot's subject points for the focus
 * box's aspect (by their projected bounds), so the subject is inside the box
 * at any screen shape. The scene eases a smoothed progress toward the input
 * with a critically damped spring clamped so it never overshoots, and blends
 * the two neighbouring framings: a smoothstep weight (no speed at a shot), the
 * distance blended geometrically (an even push-in, monotone between
 * neighbours), the target and the angles linearly.
 *
 * Every shot looks at the MACHINE, three-quarter on:
 *   0 wide     the whole cheena vala, a hero portrait: from the shore, at a
 *              standing man's eye level, a little up -- the counterweight end
 *              and the deck near, the A-frame, the boom and the net in the
 *              air rising against the sky, the horizon in the lower third
 *   1-3        looking down a little (15-17 deg), low
 *   1 fishers  the mechanism: the pivot and the counterweight end, the stones
 *              on their ropes, the ropes down to the blocks and the two men
 *              hauling them (the men pull, the stones' end dips, the net
 *              rises)
 *   2 net      the catch: the lifted net, its fish, the boom tip and the
 *              spreader poles above it, a FIXED frame (going down, the net
 *              leaves the bottom of it; it rises back in with the catch)
 *   3 bank     the people, the kite and the palms, the cheena vala behind
 *
 * Pure (no three.js): the tests use the same maths as the scene.
 */

export interface Shot { id: 'wide' | 'fishers' | 'net' | 'bank', title: string }

export const SHOTS: Shot[] = [
  { id: 'wide', title: 'The cheena vala' },
  { id: 'fishers', title: 'The balance' },
  { id: 'net', title: 'The catch' },
  { id: 'bank', title: 'On the bank' },
]
export const SHOT_MAX = SHOTS.length - 1

/** The page's input, written by the DOM. Not reactive on purpose: the scene reads it every step. */
export const scrollShot = { progress: 0 }

/** The camera: a target, its distance from it (m), azimuth and elevation (rad; + looks down). */
export interface Framing { target: V3, dist: number, az: number, el: number }

export function newFraming(): Framing {
  return { target: [0, 0, 0], dist: 10, az: 0, el: 0 }
}

/** The perspective camera's vertical field of view (deg), and the tangent of its half. */
export const FOV_DEG = 40
const TAN_HALF = Math.tan(FOV_DEG * Math.PI / 360)

/**
 * Camera angles (azimuth from +z toward +x, elevation, rad: + looks down) and
 * margin per shot; the wide shot also stands its camera at a height (m).
 */
export const ANGLE: Record<Shot['id'], { az: number, el: number, pad: number, eye?: number }> = {
  // From the shore, a man's eye level, looking a little UP: the counterweight end and the deck near,
  // the boom reaching away to the net in the air; the horizon (eye level) in the lower third.
  wide: { az: 1.3, el: -0.13, pad: 1.04, eye: 1.7 },
  // Nearly side-on to the lever, a little from the bank: pivot, stones and haulers in one view.
  fishers: { az: 0.45, el: 0.28, pad: 1.08 },
  // From over the water off the net's outer side, looking back at the machine behind it.
  net: { az: -0.6, el: 0.27, pad: 1.02 },
  // From the bank, looking back toward the cheena vala past the people.
  bank: { az: 1.1, el: 0.27, pad: 1.12 },
}
/** The wide shot's camera direction (from the subject toward the camera), for the scene's first frame. */
export const WIDE_AZ = ANGLE.wide.az
export const WIDE_EL = ANGLE.wide.el
export const WIDE_DIR: V3 = [Math.sin(WIDE_AZ) * Math.cos(WIDE_EL), Math.sin(WIDE_EL), Math.cos(WIDE_AZ) * Math.cos(WIDE_EL)]

/** Camera basis for azimuth / elevation: dir (toward the camera), right and up. */
export function basis(az: number, el: number) {
  const ce = Math.cos(el)
  const dir: V3 = [Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce]
  // right = normalize(worldUp x dir) = (dir.z, 0, -dir.x) / |..|
  const rl = Math.hypot(dir[2], dir[0]) || 1
  const right: V3 = [dir[2] / rl, 0, -dir[0] / rl]
  // up = dir x right
  const up: V3 = [
    dir[1] * right[2] - dir[2] * right[1],
    dir[2] * right[0] - dir[0] * right[2],
    dir[0] * right[1] - dir[1] * right[0],
  ]
  return { dir, right, up }
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** A point the camera must stand at least `min` metres back from (along its view) whenever it shows. */
export interface Keep { p: V3, min: number }
/**
 * How far the page extends a shot's frame beyond the focus box, in the box's
 * own -1..1 units: to its left on a desktop (box 0.44-1 of the width), below
 * it on a phone (box 0-0.6 of the height). The union of the two.
 */
export const SLOT_U = -1 - 2 * 0.44 / 0.56
export const SLOT_V = -1 - 2 * 0.4 / 0.6

/**
 * Fit a framing around points by their projected bounds: the camera (looking
 * along az / el) as close as it can stand with every point inside the box of
 * this aspect, `pad` of margin; centred on them. With `eye`, the camera stands
 * at that height (world y) instead, as close as it then can.
 */
export function fitFraming(pts: V3[], az: number, el: number, aspect: number, pad: number, out: Framing = newFraming(), eye?: number, keep: Keep[] = []): Framing {
  const { dir, right, up } = basis(az, el)
  const kY = TAN_HALF / pad
  const kX = kY * aspect
  let ax = -Infinity
  let bx = -Infinity
  let ay = -Infinity
  let by = -Infinity
  let zMax = -Infinity
  let zMean = 0
  for (const p of pts) {
    const x = dot(p, right)
    const y = dot(p, up)
    const z = dot(p, dir)
    ax = Math.max(ax, x + kX * z)
    bx = Math.max(bx, -x + kX * z)
    ay = Math.max(ay, y + kY * z)
    by = Math.max(by, -y + kY * z)
    zMax = Math.max(zMax, z)
    zMean += z
  }
  zMean /= Math.max(1, pts.length)
  // The camera at (cx, cy, cz) in the view basis: x within +-kX (cz - z) of cx, y within +-kY (cz - z) of cy.
  let cz = Math.max((ax + bx) / (2 * kX), (ay + by) / (2 * kY), zMax + 0.5)
  const cx = (ax - bx) / 2
  let cy = (ay - by) / 2
  // With `eye`, the camera's world height (cy up.y + cz dir.y; right is level) is held there.
  const a = eye === undefined ? 0 : eye / up[1]
  const b = dir[1] / up[1]
  if (eye !== undefined) {
    cz = Math.max(cz, (ay - a) / (kY - b), (by + a) / (kY + b))
    cy = a - b * cz
  }
  // Things that must not loom: standing back along the view until every one of them that shows
  // anywhere the page can extend the frame (the slot beyond the box: SLOT_U to its left, SLOT_V
  // below it) is at least its `min` away.
  for (let pass = 0; pass < 40; pass++) {
    let need = cz
    for (const k of keep) {
      const z = dot(k.p, dir)
      const depth = cz - z
      if (depth <= 0 || depth >= k.min) continue
      const u = (dot(k.p, right) - cx) / (depth * TAN_HALF * aspect)
      const v = (dot(k.p, up) - cy) / (depth * TAN_HALF)
      if (u >= SLOT_U && u <= 1.05 && v >= SLOT_V && v <= 1.05) need = Math.max(need, z + k.min)
    }
    if (need <= cz) break
    cz = need
    if (eye !== undefined) cy = a - b * cz
  }
  const dist = cz - zMean
  for (let k = 0; k < 3; k++) out.target[k] = right[k]! * cx + up[k]! * cy + dir[k]! * (cz - dist)
  out.dist = dist
  out.az = az
  out.el = el
  return out
}

/** The camera's position for a framing (world). */
export function cameraAt(f: Framing): V3 {
  const { dir } = basis(f.az, f.el)
  return [f.target[0] + dir[0] * f.dist, f.target[1] + dir[1] * f.dist, f.target[2] + dir[2] * f.dist]
}

/** A point on screen in a framing: u, v in -1..1 across the box (of this aspect), and its depth (m). */
export function project(f: Framing, p: V3, aspect: number): [number, number, number] {
  const { dir, right, up } = basis(f.az, f.el)
  const c = cameraAt(f)
  const r: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]
  const depth = -dot(r, dir)
  return [dot(r, right) / (depth * TAN_HALF * aspect), dot(r, up) / (depth * TAN_HALF), depth]
}

/** Whether every point lies inside a framing's box (for an aspect), with a margin fraction. */
export function contains(f: Framing, pts: V3[], aspect: number, margin = 0) {
  return pts.every((p) => {
    const [u, v, d] = project(f, p, aspect)
    return d > 0 && Math.abs(u) <= 1 - margin + 1e-9 && Math.abs(v) <= 1 - margin + 1e-9
  })
}

// ── Subjects ───────────────────────────────────────────────────────────────

/** A standing person for framing: ground point (world) and height. */
export interface Figure { x: number, y: number, z: number, h: number }

/** The people and things the shots frame (world). */
export interface Cast {
  fishers: Figure[]
  bank: Figure[]
  /** The kite's flying envelope. */
  kite: V3[]
}

/** A figure as a box: feet to head, a body's width around it. */
function figurePts(f: Figure, out: V3[]) {
  const r = 0.32
  for (const dx of [-r, r]) for (const dz of [-r, r]) for (const y of [0, f.h + 0.05]) out.push([f.x + dx, f.y + y, f.z + dz])
}

/** Tilts from the boom fully down to fully up (the machine through its whole working). */
const tilts = (n: number) => Array.from({ length: n + 1 }, (_, i) => THETA_DOWN + (THETA_UP - THETA_DOWN) * i / n)

/** The counterweight end at tilt theta: the boom's rear end and the hanging stones under it. */
function rearPts(theta: number, out: V3[]) {
  out.push(boomToWorld([-BOOM.rear - 0.2, 0.3, 0], theta))
  const h = boomToWorld(HANG_LOCAL, theta)
  // The stones hang in a cluster about half a metre across.
  for (const dx of [-0.45, 0.45]) for (const dz of [-0.3, 0.3]) out.push([h[0] + dx, h[1] - CLUSTER_DEPTH - 0.1, h[2] + dz])
}

/** The whole cheena vala: the A-frame and pivot, the boom and net through the tilt, the stones, the deck. */
export function machineSubject(): V3[] {
  const pts: V3[] = [[FULCRUM[0], FULCRUM[1] + 0.35, FULCRUM[2]]]
  // The net and the boom's tip in the air (lifted): going down they may leave the frame, the
  // counterweight end (which rises as they go down) is held through the whole tilt.
  for (const c of netCorners(THETA_UP)) pts.push([c[0], Math.max(0, c[1]), c[2]])
  pts.push(boomToWorld([BOOM.front + 0.3, 0.3, 0], THETA_UP))
  for (const th of tilts(8)) rearPts(th, pts)
  // The deck, down to just under its boards (its legs may run out of the bottom of the frame).
  for (const x of [DECK.x0, DECK.x1]) for (const z of [-DECK.z, DECK.z]) pts.push([x, DECK.top - 0.3, z], [x, DECK.top, z])
  return pts
}

/**
 * The mechanism: the pivot, the counterweight end through the tilt (the
 * stones dip as the net rises), the ropes' blocks and the men hauling them.
 */
export function fishersSubject(c: Cast): V3[] {
  const pts: V3[] = [[FULCRUM[0], FULCRUM[1] + 0.35, FULCRUM[2]]]
  for (const th of tilts(4)) rearPts(th, pts)
  for (const f of c.fishers) figurePts(f, pts)
  // Their blocks, so the rope runs from block to hands are in frame too.
  for (const r of ROPES) pts.push([r.to[0], r.to[1] + 0.1, r.to[2]], [r.to[0], r.to[1] - 0.95, r.to[2]])
  return pts
}

/** The bank: the people and the kite, and the cheena vala's pivot and counterweight end behind them. */
export function bankSubject(c: Cast): V3[] {
  const pts: V3[] = []
  for (const f of c.bank) figurePts(f, pts)
  pts.push(...c.kite)
  pts.push([FULCRUM[0], FULCRUM[1] + 0.35, FULCRUM[2]])
  rearPts(THETA_UP, pts)
  return pts
}

const _c: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
/** The net at tilt theta: its corners, its belly, the boom tip, and the water it rings. */
export function netSubject(theta: number): V3[] {
  const c = netCorners(theta, _c)
  const mid = netPoint(c, 0.5, 0.5, 1.1)
  const pts: V3[] = c.map(p => [p[0], Math.max(p[1], 0), p[2]] as V3)
  pts.push([mid[0], Math.max(mid[1], 0), mid[2]], boomToWorld([8.3, 0.3, 0], theta))
  // The rings the net throws when it goes in.
  const cx = (c[0]![0] + c[3]![0]) / 2
  const cz = (c[0]![2] + c[3]![2]) / 2
  for (const dx of [-3.2, 3.2]) for (const dz of [-3.2, 3.2]) pts.push([cx + dx, 0, cz + dz])
  return pts
}

/** How far out from the catch the net shot frames (net u/v beyond the fish on every side). */
export const CATCH_MARGIN = 0.05
/**
 * The lifted net's middle, where the catch lies: net points (at the top of
 * the lift, sagging) over the fish's part of the net and a margin round it.
 */
export function catchSubject(): V3[] {
  const c = netCorners(THETA_UP)
  const lo = FISH_UV[0] - CATCH_MARGIN
  const hi = FISH_UV[1] + CATCH_MARGIN
  const pts: V3[] = []
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) pts.push(netPoint(c, lo + (hi - lo) * i / 4, lo + (hi - lo) * j / 4, NET.sag))
  }
  // The boom's tip block above it, where the spreader poles meet: the net is part of the machine.
  pts.push(boomToWorld([BOOM.front + 0.15, 0.25, 0], THETA_UP))
  // Room under the belly for a fish that hops.
  const belly = netPoint(c, 0.5, 0.5, NET.sag)
  pts.push([belly[0], belly[1] - 0.25, belly[2]])
  return pts
}

/**
 * The net shot: one fixed framing (the camera never follows the dip) close
 * on the LIFTED net, its catch filling the box. Going down the net drops out
 * of the bottom of the frame; coming up, it rises back into it with the catch.
 */
export function netFraming(aspect: number, out: Framing = newFraming(), keep: Keep[] = []): Framing {
  return fitFraming(catchSubject(), ANGLE.net.az, ANGLE.net.el, aspect, ANGLE.net.pad, out, undefined, keep)
}

/** The whole-machine shot for a screen shape. */
export function wideFraming(aspect: number, out: Framing = newFraming(), keep: Keep[] = []): Framing {
  return fitFraming(machineSubject(), ANGLE.wide.az, ANGLE.wide.el, aspect, ANGLE.wide.pad, out, ANGLE.wide.eye, keep)
}

/**
 * All four framings for a screen shape, each fitted round its subject. None
 * depends on time: the shots hold still; only scrolling moves the camera.
 */
export function shotFramings(cast: Cast, aspect: number, out: Framing[]) {
  const keep = keepAway(cast)
  wideFraming(aspect, out[0], keep)
  fitFraming(fishersSubject(cast), ANGLE.fishers.az, ANGLE.fishers.el, aspect, ANGLE.fishers.pad, out[1], undefined, keep)
  netFraming(aspect, out[2], keep)
  fitFraming(bankSubject(cast), ANGLE.bank.az, ANGLE.bank.el, aspect, ANGLE.bank.pad, out[3], undefined, keep)
  return out
}

/**
 * What must not loom near a camera (a perspective one, whose frame the page
 * extends over the whole full-bleed slot): the people (6 m), the kite (6 m)
 * and the palms' trunks (8 m: a near trunk slices the whole frame).
 */
export function keepAway(cast: Cast): Keep[] {
  const out: Keep[] = []
  for (const f of [...cast.fishers, ...cast.bank]) out.push({ p: [f.x, f.y, f.z], min: 6.6 }, { p: [f.x, f.y + f.h, f.z], min: 6.6 })
  for (const p of cast.kite) out.push({ p, min: 6.6 })
  for (const sp of PALMS) {
    const c = palmPoint(sp, [0, 0], [0, 0], [0, 0, 0])
    for (let k = 0; k <= 10; k++) out.push({ p: [sp.base[0] + (c[0] - sp.base[0]) * k / 10, sp.base[1] + (c[1] - sp.base[1]) * k / 10, sp.base[2] + (c[2] - sp.base[2]) * k / 10], min: 8.5 })
  }
  return out
}

export function clampProgress(p: number) {
  if (!Number.isFinite(p)) return 0
  return Math.min(SHOT_MAX, Math.max(0, p))
}

/**
 * Framing at progress p between the shot framings. Between shots i and i + 1
 * the weight is a smoothstep of the fraction, so the camera has no speed at a
 * shot; the distance blends geometrically.
 */
export function framingAt(p: number, frames: Framing[], out: Framing = newFraming()): Framing {
  const q = clampProgress(p)
  const i = Math.min(SHOT_MAX - 1, Math.floor(q))
  const f = q - i
  const a = frames[i]!
  const b = frames[i + 1]!
  const w = f * f * (3 - 2 * f)
  for (let k = 0; k < 3; k++) out.target[k] = a.target[k]! + (b.target[k]! - a.target[k]!) * w
  out.dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * w)
  out.az = a.az + (b.az - a.az) * w
  out.el = a.el + (b.el - a.el) * w
  return out
}

/** Spring stiffness (1/s): about 0.8 s to settle across one shot. */
export const SHOT_OMEGA = 6
/** Within this much progress of a shot, slow, the camera is there (no creep). */
const SNAP = 0.002

/**
 * The eased progress the camera follows. Step it at the fixed DT: frame-rate
 * independent and deterministic. Critically damped, and clamped at the goal,
 * so it never swings past a shot.
 */
export class ShotFollower {
  s = 0
  v = 0

  step(dt: number, input: number) {
    const x = clampProgress(input)
    const e0 = x - this.s
    const w = SHOT_OMEGA
    this.v += (w * w * e0 - 2 * w * this.v) * dt
    this.s += this.v * dt
    const e1 = x - this.s
    // ... and lands on it: the last millimetres of a critically damped
    // approach would otherwise creep on for seconds after scrolling stops.
    if (e0 === 0 || Math.sign(e1) !== Math.sign(e0) || (Math.abs(e1) < SNAP && Math.abs(this.v) < SNAP * SHOT_OMEGA)) {
      this.s = x
      this.v = 0
    }
  }

  /** Snap without easing (posters, first frame). */
  jump(input: number) {
    this.s = clampProgress(input)
    this.v = 0
  }
}
