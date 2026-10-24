import * as THREE from 'three'
import { DT } from '../../core/clock'
import type { Materials } from '../../core/kit'
import { rng } from '../../core/rng'
import { createKite, type Kite } from '../../people/art'
import { apply, mul, type Vec3 } from '../../people/ik'
import { B, type HandTarget } from '../../people/motion'
import { createPerson, type Person, type Variant } from '../../people/person'
import { Catch } from './catch'
import { THETA_UP, phaseAt, type Phase } from './cycle'
import { TAIL, fisherPlace, grips, newGrip, scoopRest, tailPoint, type Grip } from './haul'
import { BANK, BASKET, DECK, NET, NUT_R, PALMS, SCOOP, boomToWorld, netCorners, netPoint as netAt, palmPoint, type V3 } from './layout'
import type { World } from './sim'

/**
 * The people of the backwater: two fishers working the cheena vala from its
 * jetty, and three on the bank -- a visitor, a child flying a kite, and a man
 * watching the net with his hands behind his back.
 *
 * FRAMES. People stand on y = 0 of their parent, so the fishers live in an
 * unscaled group raised to the deck top and the bank people in one raised to
 * the bank top. Everything handed to a person (hand targets, look and point
 * targets) is converted into that frame; the kite is in the world (its sim
 * takes the hand converted back).
 *
 * THE FISHERS haul the red operating ropes' tails (haul.ts), overhand: each
 * palm over the rope, the fingers wrapped round it (the people library's wrap
 * grip, given the rope's axis). Their hand targets are set every step from
 * the simulation's cycle clock and boom angle (never from frame time), so the
 * palms ride exactly on the drawn rope: holding at
 * rest, drawn forward paying out as the net goes down, re-gripping and holding
 * while it soaks, and hauling hand over hand while it comes up -- in the
 * 'pull-rope' stance, whose rope phase is the haul phase, so the body leans
 * back on every stroke. They keep that one stance all cycle: a change of
 * stance re-blends the arms, which would let a gripping hand slip off a moving
 * rope.
 *
 * Tapping a fisher: at rest he waves with his right hand (the other keeps the
 * rope); mid-dip his hands are full, so he glances up and waves at the next rest.
 *
 * THE SCOOP. At rest, with fish in the net, fisher 0 lands them: his left hand
 * takes the long scoop off its rack beside his left hip and holds it there, at
 * the hip, all through; the pole swings out past his side to the net's belly,
 * his right hand joining it further along, comes back in sliding through his
 * hands, is tipped over the basket and laid back on the rack. Each hand goes
 * over from rope to pole and back along a smooth blend.
 *
 * THE BANK: the child's left hand holds the kite line in a pinch, out in front
 * of the shoulder (the kite's anchor is that palm, every step); when the net
 * comes up out of the water the child points at it with the other hand. A dropped coconut makes the bank person nearest
 * its palm point at it as it falls and rolls.
 *
 * COCONUTS ON HEADS. The bank people stand in the palms' shade, and the
 * nuts come down on their own now and then (seeded, every 12-18 s) -- most
 * of them aimed, still a free fall, at the top of a head; a tap on a palm or
 * the drop button aims at the person nearest it. The nut bounces off with a
 * soft bonk and rolls away, and each person reacts in their own way, then
 * goes back to what they were doing; nobody is hurt:
 *  - the child flinches with both hands to the head, the kite line goes slack
 *    and the kite sinks; the kite hand goes back to the line while the other
 *    rubs the head; a look up at the palm, and the kite goes up again;
 *  - the watcher flinches, rubs his head, shakes his fist up at the palm, then
 *    puts his hand behind his back again;
 *  - the visitor clutches her head, looks up, steps back to see into the
 *    crown, points up at the culprit laughing, then steps back to her place.
 * Their hands glide (never jump) to the head and back, round the shoulder or
 * the side rather than through them, and are handed back to the stance only
 * where the stance has them.
 */

/** The fishers: which rope, and which hand leads (holds forward at rest). */
const FISHERS: { rope: 0 | 1, seed: number, variant: Variant, lead: 'left' | 'right' }[] = [
  { rope: 0, seed: 7, variant: 'mundu', lead: 'left' },
  { rope: 1, seed: 13, variant: 'mundu', lead: 'right' },
]

/** Bank people (bank frame). */
// Up the bank from the jetty, behind where the shore-side cameras stand to look at the cheena vala:
// never between a camera and the machine, never looming at the edge of a frame.
const WATCHER = { x: 8.95, z: -1.35, variant: 'kurta' as Variant, seed: 5 }
const VISITOR = { x: 9.95, z: -1.6, variant: 'headscarf' as Variant, seed: 19 }
const CHILD = { x: 10.85, z: -2.1, heading: 0.15, variant: 'child' as Variant, seed: 29 }
/** Kite: line length and wind (the sea breeze blows inland, +x). */
const KITE_LINE = 3.0
const KITE_WIND: [number, number] = [1, -0.22]
const KITE_SPEED = 3
/** The breeze the kite gets while nobody holds its line taut: it sinks, slowly. */
const KITE_SLACK = 1.5

/** Radius the hands close round on the red rope's tail (m). */
export const ROPE_GRIP_R = 0.02
/** How far a gripping palm's centre sits off the axis of a rope or pole of radius r, for a person of height H. */
export const palmOff = (H: number, r: number) => r + 0.011 * H
/** The scoop pole: how far ahead of the left hand the right one holds it (m). */
export const SCOOP_FRONT = 0.38

const WAVE_TIME = 2.7
/** How long the child points at the net, and a bank person at a coconut (s). */
const POINT_NET = 3.2
const POINT_NUT = 3.0
/** The child's reaction beats, seconds after the hit. */
export const BONK = { flinch: 0.55, rub: 2.4, look: 3.2, relaunch: 4.4 }
/** The watcher's and the visitor's, and how long each reaction takes. */
const WATCHER_HIT = { flinch: 0.45, rub: 1.5, fist: 2.7, done: 3.1 }
const VISITOR_HIT = { flinch: 0.4, clutch: 1.3, look: 2.0, stagger: 2.8, laugh: 4.6, done: 5.0 }
/** A nut aims at someone whose head is within this of its crown (m, level): it falls, it is not thrown. */
export const HIT_RANGE = 1.6
/** Autonomous drops: the first after a few seconds, then every 12-18 s; this share is aimed at someone. */
const AUTO_FIRST: [number, number] = [5, 8]
const AUTO_EVERY: [number, number] = [12, 18]
const AUTO_AIMED = 0.8

export type ChildState = 'flying' | 'net' | 'busy' | 'bonk'

export interface Crew {
  readonly people: Person[]
  readonly fishers: Person[]
  readonly bankPeople: Person[]
  readonly child: Person
  readonly kite: Kite
  /** Raised frames the people stand in (deck, bank); add both to the scene. */
  readonly deck: THREE.Group
  readonly bank: THREE.Group
  /** Each fisher's haul state this step (tests read it). */
  readonly hauls: Grip[]
  /** Which hand of each fisher is grip 0 of its haul. */
  readonly lead: ('left' | 'right')[]
  /** The palm nearest the child (the one whose nuts can be aimed). */
  readonly bonkPalm: number
  /** The fish: in the net, in the scoop, landed in the basket. */
  readonly catch: Catch
  /** Whether fish in the net can be seen (the net is up out of the water). */
  readonly netShown: boolean
  /** Fisher 0's hands are still on their way back to the rope after the scoop. */
  readonly regripping: boolean
  /** Whether each rope's tail is in its fisher's hands (fisher 0 lets go to work the scoop). */
  readonly ropeHeld: boolean[]
  /** The scoop net this step and last (world): hoop centre and pole butt; scooping = in use. */
  readonly scoop: { hoop: THREE.Vector3, butt: THREE.Vector3, prevHoop: THREE.Vector3, prevButt: THREE.Vector3, scooping: boolean, t: number }
  /** World points the camera fit must keep in view (the kite's whole envelope). */
  readonly fitPoints: THREE.Vector3[]
  /** Hits taken per bank person (watcher, visitor, child), and whether each is reacting now. */
  readonly hits: number[]
  reacting(i: number): boolean
  /** The beat of bank person i's reaction ('' when none). */
  beat(i: number): string
  /** What the child is doing; the bonk beat ('' when not in one). */
  readonly childState: ChildState
  readonly bonkBeat: string
  step(dt: number): void
  frame(alpha: number): void
  /** Index into `people` of the person (or -2 for the kite) under the ray, else -1. */
  pick(ray: THREE.Raycaster): number
  setHover(i: number): void
  tap(i: number): string
  /** Keyboard: the next person waves. */
  wave(): string
  tugKite(): string
  /**
   * Drop a nut from a palm (tap or key), aimed at the person nearest it when
   * someone free stands within HIT_RANGE of its crown (`target` picks the bank
   * person instead). Returns false if the palm has nothing to drop.
   */
  dropNut(palm: number, target?: number): boolean
  setPaused(p: boolean): void
  dispose(): void
}

/** World point of the net's middle at tilt theta (what people watch). */
function netCentre(theta: number, out: THREE.Vector3) {
  const p = boomToWorld([8, -NET.drop + 0.3, 0], theta)
  return out.set(p[0], p[1], p[2])
}

/**
 * The top of a person's head in their parent frame, by forward kinematics of
 * the motion's own pose for this step (deterministic: no scene-graph read).
 */
function headTop(p: Person, out: THREE.Vector3) {
  const m = p.motion
  const P = m.pose
  const d = m.d
  const Rp = P.R[B.pelvis]!
  const Rs = mul(Rp, P.R[B.spine]!)
  const Rh = mul(Rs, P.R[B.head]!)
  const o = m.offsets
  const a = apply(Rp, o[B.spine]!)
  const b = apply(Rs, o[B.head]!)
  const c = apply(Rh, [0, d.neck + d.headH, 0.008 * d.H])
  const v: Vec3 = [P.pelvisPos[0] + a[0] + b[0] + c[0], P.pelvisPos[1] + a[1] + b[1] + c[1], P.pelvisPos[2] + a[2] + b[2] + c[2]]
  const w = m.toWorld(v)
  return out.set(w[0], w[1], w[2])
}

export async function createCrew(
  ctx: { materials: Materials, posterMode?: boolean },
  sim: World,
  yieldTask: () => Promise<void> = async () => {},
  opts: { autoNuts?: boolean } = {},
): Promise<Crew> {
  const poster = !!ctx.posterMode
  const deck = new THREE.Group()
  deck.name = 'crew:deck'
  deck.position.y = DECK.top
  const bank = new THREE.Group()
  bank.name = 'crew:bank'
  bank.position.y = BANK.top

  // ── Fishers: each behind his block, facing it, the tail in front of him ──
  const fishers: Person[] = []
  for (const f of FISHERS) {
    const p = createPerson(ctx, { seed: f.seed, variant: f.variant, posterMode: poster })
    const at = fisherPlace(f.rope)
    p.placeAt(at.x, at.z, at.heading)
    // Braced: feet apart, body weight hung back on the rope (fisher 0, at the
    // deck's edge, stands with his feet closer).
    p.setStance('wide', { instant: true })
    p.play('pull-rope')
    deck.add(p.root)
    fishers.push(p)
    await yieldTask()
  }

  // ── Bank people ─────────────────────────────────────────────────────────
  const netW = netCentre(sim.theta, new THREE.Vector3())
  const toBank = (w: THREE.Vector3, out: THREE.Vector3) => out.set(w.x, w.y - BANK.top, w.z)
  const watcher = createPerson(ctx, { seed: WATCHER.seed, variant: WATCHER.variant, posterMode: poster })
  watcher.placeAt(WATCHER.x, WATCHER.z, Math.atan2(netW.x - WATCHER.x, netW.z - WATCHER.z))
  watcher.play('watch')
  await yieldTask()
  const visitor = createPerson(ctx, { seed: VISITOR.seed, variant: VISITOR.variant, posterMode: poster, accent: true })
  visitor.placeAt(VISITOR.x, VISITOR.z, Math.atan2(netW.x - VISITOR.x, netW.z - VISITOR.z) + 0.9)
  await yieldTask()
  const child = createPerson(ctx, { seed: CHILD.seed, variant: CHILD.variant, posterMode: poster })
  child.placeAt(CHILD.x, CHILD.z, CHILD.heading)
  bank.add(watcher.root, visitor.root, child.root)
  const bankPeople = [watcher, visitor, child]
  const people = [...fishers, ...bankPeople]
  const CHILD_I = fishers.length + 2

  // The child's left arm points up the kite line (bank frame); the kite is
  // built once the arm is there, from that palm (world).
  const kiteAim = new THREE.Vector3(CHILD.x + 1.5, 2.4, CHILD.z - 0.35)
  child.play('idle')
  let kite!: Kite

  // The palm nearest the child, and a point up in its crown to look at.
  let bonkPalm = 0
  {
    const dist = (i: number) => {
      const c = palmPoint(PALMS[i]!, [0, 0], [0, 0], [0, -0.2, 0])
      return Math.hypot(c[0] - CHILD.x, c[2] - CHILD.z)
    }
    PALMS.forEach((_, i) => {
      if (dist(i) < dist(bonkPalm)) bonkPalm = i
    })
  }
  const crownLook = (() => {
    const c = palmPoint(PALMS[bonkPalm]!, [0, 0], [0, 0], [0, -0.2, 0])
    return new THREE.Vector3(c[0], c[1] - BANK.top, c[2])
  })()

  // ── Direction state (all stepped; nothing reads the wall clock) ─────────
  const R = rng(97)
  const fishCatch = new Catch(23)
  let netShown = false
  // ── The scoop net (worked by fisher 0 at rest, when there is a catch) ──
  const L = SCOOP.len
  const scoop = {
    hoop: new THREE.Vector3(),
    butt: new THREE.Vector3(),
    prevHoop: new THREE.Vector3(),
    prevButt: new THREE.Vector3(),
    scooping: false,
    t: -1,
  }
  // Key poses. The pole turns and slides in his left hand, which holds it at
  // his left hip all through the scoop, where it rests on its rack: P is the
  // pole's axis there (world); d its direction (toward the hoop) and s the
  // hoop's distance from P. Out to the net's belly the pole points ahead and
  // to his right, so behind his left hand it runs back past his left side,
  // clear of him; his right hand holds it SCOOP_FRONT further on.
  const rest = scoopRest()
  const P = new THREE.Vector3(...rest.p)
  const dStore = new THREE.Vector3(...rest.dir)
  const sStore = SCOOP.hoopOut
  const belly = (() => {
    const c = netCorners(THETA_UP)
    const b = netAt(c, 0.5, 0.5, NET.sag)
    return new THREE.Vector3(b[0], b[1] + 0.05, b[2])
  })()
  const dOut = belly.clone().sub(P)
  let sOut = dOut.length()
  dOut.normalize()
  const overBasket = new THREE.Vector3(BASKET.x, DECK.top + BASKET.h + 0.48, BASKET.z)
  const dIn = overBasket.clone().sub(P)
  const sIn = dIn.length()
  dIn.normalize()
  /**
   * The scoop's beats (s from the start of the rest): the left hand takes the
   * pole; the right joins it as it swings out; through the belly; back in,
   * sliding through his hands; tipped over the basket; back on the rack.
   */
  const SC = { take: 0.45, reach: 0.8, join: 1.35, out: 1.35, dip: 1.6, back: 2.2, tip: 2.45, done: 2.75 }
  let selectedFish = -1
  const releaseAt = [0, 0, 0]
  /** Fisher 0's left hand goes back to the rope over this long after the scoop (s). */
  const REGRIP = 0.5
  const dNow = new THREE.Vector3().copy(dStore)
  const sm = (u: number) => {
    const x = Math.min(1, Math.max(0, u))
    return x * x * x * (x * (x * 6 - 15) + 10)
  }
  /** The pole at scoop time t (beat-by-beat blends between the key poses). */
  function polePose(t: number) {
    let s0: number
    if (t < SC.take || t >= SC.done) {
      dNow.copy(dStore)
      s0 = sStore
    }
    else if (t < SC.out) {
      const w = sm((t - SC.take) / (SC.out - SC.take))
      dNow.lerpVectors(dStore, dOut, w).normalize()
      s0 = sStore + (sOut - sStore) * w
    }
    else if (t < SC.dip) {
      // Through the belly and up again, under the fish.
      const u = (t - SC.out) / (SC.dip - SC.out)
      dNow.copy(dOut).add(tmp.set(0, -0.025 * Math.sin(Math.PI * u), 0)).normalize()
      s0 = sOut
    }
    else if (t < SC.back) {
      const w = sm((t - SC.dip) / (SC.back - SC.dip))
      dNow.lerpVectors(dOut, dIn, w).normalize()
      s0 = sOut + (sIn - sOut) * w
    }
    else if (t < SC.tip) {
      // Tip it: the hoop turns down over the basket (a small turn: the long
      // butt behind him only rises a little).
      const u = (t - SC.back) / (SC.tip - SC.back)
      dNow.copy(dIn).add(tmp.set(0, -0.1 * Math.sin(Math.PI * u), 0)).normalize()
      s0 = sIn
    }
    else {
      const w = sm((t - SC.tip) / (SC.done - SC.tip))
      dNow.lerpVectors(dIn, dStore, w).normalize()
      s0 = sIn + (sStore - sIn) * w
    }
    scoop.hoop.copy(P).addScaledVector(dNow, s0)
    scoop.butt.copy(scoop.hoop).addScaledVector(dNow, -L)
  }
  scoop.hoop.copy(P).addScaledVector(dStore, sStore)
  scoop.butt.copy(scoop.hoop).addScaledVector(dStore, -L)
  scoop.prevHoop.copy(scoop.hoop)
  scoop.prevButt.copy(scoop.butt)
  const hauls = fishers.map(() => newGrip())
  let time = 0
  let paused = false
  let wasWet = sim.wet
  const netLook = new THREE.Vector3()
  const netBank = new THREE.Vector3()
  const netDeck = new THREE.Vector3()
  const netPoint = new THREE.Vector3()
  /** Per person: until when an override (wave, point) runs; a fisher's queued wave. */
  const busyUntil = people.map(() => 0)
  const waveHand = fishers.map(() => false)
  const waveQueued = fishers.map(() => false)
  const glanceUntil = fishers.map(() => 0)
  let childNetUntil = 0
  let nutWho = -1
  let nutBody = -1
  const nutAim = new THREE.Vector3()
  let waveTurn = 0
  let hovered = -1
  const viewer = new THREE.Vector3()
  const visitorLookSwap = R.range(3, 6)
  /** Coconut hits: per bank person, the time of the hit (-1 = none), the beat; the one a nut is falling at. */
  const hitAt = bankPeople.map(() => -1)
  const hitBeat = bankPeople.map(() => '')
  const hits = bankPeople.map(() => 0)
  let aimedAt = -1
  let bonkBeat = ''
  let nextAuto = R.range(...AUTO_FIRST)
  let autoTurn = 0
  const homes = bankPeople.map(p => ({ x: p.position.x, z: p.position.z }))
  const crowns = PALMS.map((sp) => {
    const c = palmPoint(sp, [0, 0], [0, 0], [0, -0.2, 0])
    return new THREE.Vector3(c[0], c[1] - BANK.top, c[2])
  })

  const tmp = new THREE.Vector3()
  const tmpN = new THREE.Vector3()
  const up = new THREE.Vector3()
  const head = new THREE.Vector3()
  const p3: V3 = [0, 0, 0]
  const cw4: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const hoopDeck = new THREE.Vector3()
  const ropeHeldNow = FISHERS.map(() => true)
  /** Fisher 0's left hand is finding the rope again after the scoop, until then. */
  let regripUntil = 0
  let regripGlanced = true
  const lastPhase: Phase[] = fishers.map(() => 'rest')
  const axisV = new THREE.Vector3()
  const ropeT = { position: new THREE.Vector3(), normal: new THREE.Vector3(), axis: new THREE.Vector3(), elbow: new THREE.Vector3() }
  const poleT = { position: new THREE.Vector3(), normal: new THREE.Vector3(), axis: new THREE.Vector3(), elbow: new THREE.Vector3() }
  const hand: HandTarget = { position: new THREE.Vector3(), normal: new THREE.Vector3(), axis: new THREE.Vector3(), elbow: new THREE.Vector3(), kind: 'wrap' }
  const handPos = hand.position as THREE.Vector3
  const handN = hand.normal as THREE.Vector3
  const handAx = hand.axis as THREE.Vector3
  const handEl = hand.elbow as THREE.Vector3
  const fwdV = new THREE.Vector3()
  const fwdOf = (p: Person) => fwdV.set(Math.sin(p.heading), 0, Math.cos(p.heading))

  /**
   * Fisher i's grip k on his rope (deck frame), from his haul state: an
   * overhand grip, the palm over the rope and turned a little in toward his
   * middle, the fingers wrapped round it; a recovering hand lifts up and a
   * little out over the other one. Elbows out to the side and down.
   */
  function ropeGrip(i: number, k: 0 | 1, side: 'left' | 'right', out: typeof ropeT) {
    const p = fishers[i]!
    const f = FISHERS[i]!
    const g = hauls[i]!
    const d = TAIL[f.rope]!
    const sgn = side === 'left' ? 1 : -1
    const c = Math.cos(p.heading)
    const s = Math.sin(p.heading)
    out.axis.set(d[0], 0, d[1])
    // His side, square to the rope: the palm's normal is up and a little toward it.
    tmpN.set(c * sgn, 0, -s * sgn)
    tmpN.addScaledVector(out.axis, -tmpN.dot(out.axis)).normalize()
    out.normal.set(0, 1, 0).addScaledVector(tmpN, 0.45).normalize()
    up.set(0, 1, 0).addScaledVector(tmpN, 0.3).normalize()
    const q = tailPoint(f.rope, g.h[k], p3)
    out.position.set(q[0], q[1] - DECK.top, q[2]).addScaledVector(out.normal, palmOff(p.dims.H, ROPE_GRIP_R)).addScaledVector(up, g.off[k])
    out.elbow.set(c * sgn, -1, -s * sgn).addScaledVector(fwdOf(p), -0.15)
    return out
  }

  /** Fisher 0's grip on the scoop pole (deck frame): the left at P, the right SCOOP_FRONT on; overhand, both. */
  function poleGrip(side: 'left' | 'right', out: typeof poleT) {
    const p = fishers[0]!
    const c = Math.cos(p.heading)
    const s = Math.sin(p.heading)
    out.axis.copy(dNow)
    out.normal.set(0, 1, 0).addScaledVector(dNow, -dNow.y).normalize()
    out.position.copy(P).addScaledVector(dNow, side === 'left' ? 0 : SCOOP_FRONT)
    out.position.y -= DECK.top
    out.position.addScaledVector(out.normal, palmOff(p.dims.H, SCOOP.poleR))
    // The hand at his hip: elbow back and out. The forward one: down and out.
    if (side === 'left') out.elbow.set(c * 0.5, -0.6, -s * 0.5).addScaledVector(fwdOf(p), -1)
    else out.elbow.set(-c * 0.8, -1, s * 0.8)
    return out
  }

  /** Set a wrap grip on hand `side` of p: the rope grip blended toward the pole grip by w. */
  function setGrip(p: Person, side: 'left' | 'right', a: typeof ropeT, b: typeof poleT | null, w: number) {
    if (!b || w <= 0) {
      handPos.copy(a.position)
      handN.copy(a.normal)
      handAx.copy(a.axis)
      handEl.copy(a.elbow)
    }
    else {
      handPos.lerpVectors(a.position, b.position, w)
      handN.lerpVectors(a.normal, b.normal, w).normalize()
      // Either sign of an axis is the same handle: blend through the nearer.
      axisV.copy(b.axis).multiplyScalar(a.axis.dot(b.axis) < 0 ? -1 : 1)
      handAx.lerpVectors(a.axis, axisV, w).normalize()
      handEl.lerpVectors(a.elbow, b.elbow, w)
    }
    hand.kind = 'wrap'
    hand.radius = b && w >= 0.5 ? SCOOP.poleR : ROPE_GRIP_R
    p.setHandTarget(side, hand)
  }

  /** Hand targets for fisher i from his haul state (fisher 0: and the scoop). */
  function setFisherHands(i: number) {
    const p = fishers[i]!
    const f = FISHERS[i]!
    const g = hauls[i]!
    // Fisher 0 and the scoop: each hand goes over from its rope grip to its
    // grip on the pole and back again, along a smooth blend between the two
    // (both of which move smoothly): the left takes the pole off its rack, the
    // right joins it as it swings out and lets go once it is tipped; the left
    // lays it back on the rack and only then finds the rope again.
    let wL = 0
    let wR = 0
    if (i === 0) {
      const t = scoop.scooping ? scoop.t : -1
      if (scoop.scooping) {
        wL = sm(t / SC.take)
        wR = t < SC.tip ? sm((t - SC.reach) / (SC.join - SC.reach)) : 1 - sm((t - SC.tip) / (SC.done - SC.tip))
      }
      else if (time < regripUntil) wL = 1 - sm(1 - (regripUntil - time) / REGRIP)
    }
    for (const k of [0, 1] as const) {
      const side: 'left' | 'right' = (k === 0) === (f.lead === 'left') ? 'left' : 'right'
      if (side === 'right' && waveHand[i]) {
        p.setHandTarget('right', null)
        continue
      }
      ropeGrip(i, k, side, ropeT)
      const w = side === 'left' ? wL : wR
      setGrip(p, side, ropeT, w > 0 ? poleGrip(side, poleT) : null, w)
    }
    const scooping = i === 0 && (scoop.scooping || time < regripUntil)
    p.setRopePhase(scooping ? 0 : g.ropePhase)
    // Reaching back along the rope for his grip after the scoop, he leans in to it a little.
    p.setLean(scooping ? (scoop.scooping ? 0 : 0.06) : g.lean, 0)
  }

  function nearestBank(x: number, z: number) {
    let best = 0
    let bd = Infinity
    bankPeople.forEach((p, i) => {
      const d = Math.hypot(p.position.x - x, p.position.z - z)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    return best
  }

  // ── Glides: a bank person's hand never jumps. Taken for something (the
  // head, the kite line, a fist), it glides there from wherever it is, no
  // faster than a hand moves; let go, it glides back to where it was taken
  // from (in the person's own frame: they may have stepped) -- round by their
  // side when that is behind them -- and only then is it handed back to the
  // stance, which has it there already.
  /** Hand speeds (m/s): going to something, and going back. */
  const GRAB_V = 2.1
  const LET_GO_V = 2.0
  interface Glide {
    /** 'home': back where it was taken from, waiting for the other hand (both are handed back together). */
    state: 'off' | 'on' | 'back' | 'home'
    cur: THREE.Vector3
    /** Where it was taken from, and the way round (person frame: x left, z forward). */
    home: THREE.Vector3
    /** Waypoints still to pass (person frame), in order; `n` of them in use. */
    via: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]
    n: number
    k: number
    want: { position: THREE.Vector3, normal: THREE.Vector3 | null, axis: THREE.Vector3 | null, elbow: THREE.Vector3 | null, kind: HandTarget['kind'], radius: number | undefined }
  }
  const glides = new Map<Person, [Glide, Glide]>()
  const newGlide = (): Glide => ({
    state: 'off', cur: new THREE.Vector3(), home: new THREE.Vector3(), via: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], n: 0, k: 0,
    want: { position: new THREE.Vector3(), normal: null, axis: null, elbow: null, kind: undefined, radius: undefined },
  })
  function glideOf(p: Person, side: 'left' | 'right') {
    let g = glides.get(p)
    if (!g) {
      g = [newGlide(), newGlide()]
      glides.set(p, g)
    }
    return g[side === 'left' ? 0 : 1]
  }
  /** Person frame <-> bank frame (x left, y up, z forward). */
  function toLocal(p: Person, w: THREE.Vector3, out: THREE.Vector3) {
    const c = Math.cos(p.heading)
    const sn = Math.sin(p.heading)
    const dx = w.x - p.position.x
    const dz = w.z - p.position.z
    return out.set(c * dx - sn * dz, w.y, sn * dx + c * dz)
  }
  function fromLocal(p: Person, l: THREE.Vector3, out: THREE.Vector3) {
    const c = Math.cos(p.heading)
    const sn = Math.sin(p.heading)
    return out.set(p.position.x + c * l.x + sn * l.z, l.y, p.position.z - sn * l.x + c * l.z)
  }
  /** Beside the hip on the hand's own side, a little forward: the way round for a hand behind the back. */
  function sideWay(p: Person, side: 'left' | 'right', out: THREE.Vector3) {
    return out.set((side === 'left' ? 1 : -1) * 0.36 * p.dims.H / 1.6, 0.56 * p.dims.H, -0.12)
  }
  /** Out beside the hip, a little forward: between the front of the body and behind it. */
  function outWay(p: Person, side: 'left' | 'right', out: THREE.Vector3) {
    return out.set((side === 'left' ? 1 : -1) * 0.42 * p.dims.H / 1.6, 0.6 * p.dims.H, 0.14 * p.dims.H / 1.6)
  }
  /** Out in front of the shoulder: the way round for a hand going up to the head or back down (never through the shoulder). */
  function frontWay(p: Person, side: 'left' | 'right', out: THREE.Vector3) {
    return out.set((side === 'left' ? 1 : -1) * 0.14 * p.dims.H / 1.6, 0.78 * p.dims.H, 0.42 * p.dims.H / 1.6)
  }
  /** The way round from local point a to local point b: by the side if either is behind, in front of the shoulder if one is up at the head. */
  function route(p: Person, side: 'left' | 'right', a: THREE.Vector3, b: THREE.Vector3, g: Glide) {
    g.n = 0
    g.k = 0
    // Behind the back: low and behind (a hand up at the head may be a little behind the feet).
    const high = 0.8 * p.dims.H
    const behindA = a.z < -0.08 && a.y < 0.75 * p.dims.H
    const behindB = b.z < -0.08 && b.y < 0.75 * p.dims.H
    const crosses = (a.y > high) !== (b.y > high)
    if (behindA) {
      sideWay(p, side, g.via[g.n++]!)
      if (crosses) outWay(p, side, g.via[g.n++]!)
    }
    if (crosses) frontWay(p, side, g.via[g.n++]!)
    if (behindB && !behindA) {
      if (crosses) outWay(p, side, g.via[g.n++]!)
      sideWay(p, side, g.via[g.n++]!)
    }
  }
  const glideTmp = new THREE.Vector3()
  const glideTmp2 = new THREE.Vector3()
  /** Hand `side` of p to target t (bank frame), gliding there; `snap` puts it there at once (setting up). */
  function hold(p: Person, side: 'left' | 'right', t: HandTarget, snap = false) {
    const g = glideOf(p, side)
    if (g.state === 'off') {
      p.handWorld(side, g.cur)
      toLocal(p, g.cur, g.home)
    }
    if (g.state === 'home') g.n = g.k = 0
    const was = g.state
    g.state = 'on'
    const w = g.want
    // A new goal (not the same one moving along): the way round is worked out again.
    const jump = was !== 'on' || w.position.distanceToSquared(glideTmp.set(t.position.x, t.position.y, t.position.z)) > 0.09
    w.position.set(t.position.x, t.position.y, t.position.z)
    w.normal = t.normal ? (w.normal ?? new THREE.Vector3()).set(t.normal.x, t.normal.y, t.normal.z) : null
    w.axis = t.axis ? (w.axis ?? new THREE.Vector3()).set(t.axis.x, t.axis.y, t.axis.z) : null
    w.elbow = t.elbow ? (w.elbow ?? new THREE.Vector3()).set(t.elbow.x, t.elbow.y, t.elbow.z) : null
    w.kind = t.kind
    w.radius = t.radius
    if (jump) route(p, side, toLocal(p, g.cur, glideTmp), toLocal(p, w.position, glideTmp2), g)
    if (snap) {
      g.cur.copy(w.position)
      g.n = g.k = 0
      p.setHandTarget(side, { position: g.cur, normal: w.normal ?? undefined, axis: w.axis ?? undefined, elbow: w.elbow ?? undefined, kind: w.kind, radius: w.radius } as HandTarget)
    }
  }
  /** Let hand `side` of p go: it glides back to where it was taken from, then the stance has it. */
  function letGo(p: Person, side: 'left' | 'right') {
    const g = glideOf(p, side)
    if (g.state !== 'on') return
    g.state = 'back'
    route(p, side, toLocal(p, g.cur, glideTmp), g.home, g)
  }
  /** Move toward goal by at most v dt; true once there. */
  function glideTo(cur: THREE.Vector3, goal: THREE.Vector3, v: number, dt: number) {
    const d = cur.distanceTo(goal)
    if (d <= v * dt + 1e-9) {
      cur.copy(goal)
      return true
    }
    cur.lerp(goal, v * dt / d)
    return false
  }
  const glideN = new THREE.Vector3()
  const glideT = { position: new THREE.Vector3(), normal: undefined as THREE.Vector3 | undefined, axis: undefined as THREE.Vector3 | undefined, elbow: new THREE.Vector3(), kind: undefined as HandTarget['kind'], radius: undefined as number | undefined }
  /** Every step, before the people step: each hand on its way. */
  function stepGlides(dt: number) {
    for (const [p, pair] of glides) {
      pair.forEach((g, k) => {
        const side = k === 0 ? 'left' : 'right'
        if (g.state === 'off') return
        const round = g.k < g.n
        if (round) {
          // Round by the waypoints first.
          if (glideTo(g.cur, fromLocal(p, g.via[g.k]!, glideTmp), g.state === 'on' ? GRAB_V : LET_GO_V, dt)) g.k++
        }
        else if (g.state === 'on') glideTo(g.cur, g.want.position, GRAB_V, dt)
        else if (g.state === 'home') g.cur.copy(fromLocal(p, g.home, glideTmp))
        // Home: handed back once the other hand is not still on its way back
        // too (letting one hand go re-blends the other).
        else if (glideTo(g.cur, fromLocal(p, g.home, glideTmp), LET_GO_V, dt)) g.state = 'home'
        glideT.position.copy(g.cur)
        if (g.state === 'on' && !round) {
          glideT.normal = g.want.normal ?? undefined
          glideT.axis = g.want.axis ?? undefined
          glideT.kind = g.want.kind
          glideT.radius = g.want.radius
          if (g.want.elbow) glideT.elbow.copy(g.want.elbow)
          else glideT.elbow.set(0, -1, 0)
        }
        else {
          // On the way (round, or back): an easy open hand, elbow down and out.
          const sg = k === 0 ? 1 : -1
          // The palm toward the thigh (its normal out to the side): one steady way up for the hand all the way.
          glideT.normal = glideN.set(Math.cos(p.heading) * sg, 0, -Math.sin(p.heading) * sg)
          glideT.axis = undefined
          glideT.kind = 'flat'
          glideT.radius = undefined
          glideT.elbow.set(Math.cos(p.heading) * sg * 0.6, -1, -Math.sin(p.heading) * sg * 0.6)
          // Behind the back, the elbow goes back and out (the forearm across the small of the back, not into it).
          if (toLocal(p, g.cur, glideTmp).z < -0.05) glideT.elbow.set(Math.cos(p.heading) * sg * 0.8, -0.5, -Math.sin(p.heading) * sg * 0.8).addScaledVector(fwdOf(p), -0.8)
        }
        p.setHandTarget(side, glideT as HandTarget)
      })
      if (pair.some(g => g.state === 'home') && !pair.some(g => g.state === 'back')) {
        pair.forEach((g, k) => {
          if (g.state !== 'home') return
          g.state = 'off'
          p.setHandTarget(k === 0 ? 'left' : 'right', null)
        })
      }
    }
  }

  function childDefault() {
    letGo(child, 'right')
    child.setLean(0, 0)
    child.play('idle')
    kiteHold = true
  }

  /**
   * The child's left hand on the kite line: a pinch, at chest-to-head height
   * out in front of the left shoulder toward the kite, the line running from
   * the fingers up to it; elbow down and out.
   */
  let kiteHold = true
  const kiteHand = new THREE.Vector3()
  const kiteT: HandTarget = { position: kiteHand, axis: new THREE.Vector3(), elbow: new THREE.Vector3(), kind: 'pinch', radius: 0.004 }
  function holdKite(snap = false) {
    const p = child
    const c = Math.cos(p.heading)
    const sn = Math.sin(p.heading)
    tmp.set(kiteAim.x - p.position.x, 0, kiteAim.z - p.position.z).normalize()
    kiteHand.set(p.position.x + c * 0.16 + tmp.x * 0.24, 0.8 * p.dims.H, p.position.z - sn * 0.16 + tmp.z * 0.24).addScaledVector(fwdOf(p), 0.1)
    ;(kiteT.axis as THREE.Vector3).subVectors(kiteAim, kiteHand).normalize()
    ;(kiteT.elbow as THREE.Vector3).set(c, -1.2, -sn)
    hold(p, 'left', kiteT, snap)
  }

  /** What each bank person looks at when nothing has caught their eye. */
  function bankLook(i: number, phase: Phase) {
    const p = bankPeople[i]!
    // Options make a moving target tracked (a plain lookAt never settles on one that moves).
    if (i === 0) return p.lookAt(netBank, {})
    if (i === 1) {
      // The visitor follows the kite, and turns to the net while it is worked.
      const kiteTime = Math.floor((time + visitorLookSwap) / 7) % 2 === 0
      return p.lookAt(phase === 'lift' || !kiteTime ? netBank : kiteAim)
    }
    // The kite holds the child's eyes, the hand on its line only gets glances.
    return p.lookAt(kiteAim, { priority: 'target' })
  }

  function waveFisher(i: number) {
    waveHand[i] = true
    busyUntil[i] = time + WAVE_TIME
    setFisherHands(i)
    fishers[i]!.play('wave', { hand: 'right' })
  }

  /** The net's middle, in the world and in each frame. */
  function watchNet() {
    netCentre(sim.theta, netLook)
    toBank(netLook, netBank)
    netDeck.set(netLook.x, netLook.y - DECK.top, netLook.z)
  }

  function haulAll() {
    const { phase, u } = phaseAt(sim.cycle.t)
    for (let i = 0; i < fishers.length; i++) grips(FISHERS[i]!.rope, phase, u, sim.theta, hauls[i]!)
    return phase
  }

  /** The child is free to be surprised (flying the kite, nothing else going on). */
  const childFree = () => bankFree(2)
  /** A bank person is free to be surprised: not reacting, not the target of a falling nut, not busy. */
  function bankFree(i: number) {
    return hitAt[i]! < 0 && aimedAt !== i && time >= busyUntil[fishers.length + i]! && nutWho !== i && (i !== 2 || childNetUntil === 0)
  }

  /** The free bank person nearest a palm's crown, within HIT_RANGE, or -1. */
  function targetFor(palm: number) {
    let best = -1
    let bd = HIT_RANGE
    bankPeople.forEach((p, i) => {
      if (!bankFree(i)) return
      const d = Math.hypot(p.position.x - crowns[palm]!.x, p.position.z - crowns[palm]!.z)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    return best
  }

  // ── Reactions: a hand goes straight to where it is wanted (the person's
  // own blend takes it there round the body, elbow down, at a hand's speed)
  // and is let go when it is done, so the stance takes it back the same way.
  const headT: HandTarget = { position: new THREE.Vector3(), normal: new THREE.Vector3(), elbow: new THREE.Vector3(), kind: 'flat' }
  const upT = { position: new THREE.Vector3(), elbow: new THREE.Vector3(), kind: 'flat' as const }
  const fistT: HandTarget = { position: new THREE.Vector3(), axis: new THREE.Vector3(), elbow: new THREE.Vector3(), kind: 'wrap', radius: 0.008 }
  const goalV = new THREE.Vector3()
  /** Where a palm rests flat on the side of the head, just outside it (and a headscarf); its normal points out. */
  function headSide(p: Person, side: 1 | -1, rub: number, out: THREE.Vector3, nrm: THREE.Vector3) {
    headTop(p, head)
    const d = p.dims
    const c = Math.cos(p.heading)
    const sn = Math.sin(p.heading)
    const lx = side * (d.headW / 2 + 0.045 * d.H / 1.6 + (d.headscarf ? 0.03 : 0))
    // At the temple, a little forward of the ear: the elbow comes up in front, never folded tight at the shoulder.
    const fw = rub + 0.05 * d.H / 1.6
    out.set(head.x + c * lx + sn * fw, head.y - d.headH * 0.28, head.z - sn * lx + c * fw)
    nrm.set(c * side, 0, -sn * side)
    return out
  }
  /** A flat palm on the side of p's head (rubbing it by `rub`, m along the head), the elbow out and down. */
  function handToHead(p: Person, side: 'left' | 'right', rub = 0) {
    const sg = side === 'left' ? 1 : -1
    headSide(p, sg, rub, headT.position as THREE.Vector3, headT.normal as THREE.Vector3)
    ;(headT.elbow as THREE.Vector3).set(Math.cos(p.heading) * sg, -0.8, -Math.sin(p.heading) * sg).addScaledVector(fwdOf(p), 0.3)
    hold(p, side, headT)
  }

  /** The watcher: flinch, a hand to his head and rubbing, a fist shaken up at the palm, then back behind him. */
  function watcherReact(t: number) {
    const W = WATCHER_HIT
    const beat = t < W.flinch ? 'flinch' : t < W.rub ? 'rub' : t < W.fist ? 'fist' : t < W.done ? 'back' : ''
    const p = watcher
    if (beat !== hitBeat[0]) {
      hitBeat[0] = beat
      if (beat === 'flinch') p.setLean(-0.15, 0)
      else if (beat === 'fist') p.setLean(0, 0)
      else if (beat === 'back') letGo(p, 'right')
      else if (beat === '') {
        if (glideOf(p, 'right').state !== 'off') {
          hitBeat[0] = 'back'
          return
        }
        hitAt[0] = -1
        return
      }
    }
    if (beat === 'flinch' || beat === 'rub') handToHead(p, 'right', beat === 'rub' ? 0.02 * Math.sin(2 * Math.PI * 1.6 * t) : 0)
    else if (beat === 'fist') {
      // Up at the palm: out on his right side, above his head, shaking.
      headTop(p, head)
      const c = Math.cos(p.heading)
      const sn = Math.sin(p.heading)
      ;(fistT.position as THREE.Vector3).set(head.x - c * 0.24, head.y + 0.1 + 0.05 * Math.sin(2 * Math.PI * 5 * t), head.z + sn * 0.24).addScaledVector(fwdOf(p), 0.1)
      ;(fistT.axis as THREE.Vector3).set(c, 0, -sn)
      ;(fistT.elbow as THREE.Vector3).set(-c, -0.6, sn)
      hold(p, 'right', fistT)
    }
    p.lookAt(crownNear(0))
  }

  /** The visitor: clutches her head, looks up, steps back to see into the crown, points up at the culprit, steps back. */
  function visitorReact(t: number) {
    const V = VISITOR_HIT
    const beat = t < V.flinch ? 'flinch' : t < V.clutch ? 'clutch' : t < V.look ? 'look' : t < V.stagger ? 'stagger' : t < V.laugh ? 'laugh' : t < V.done ? 'home' : ''
    const p = visitor
    if (beat !== hitBeat[1]) {
      hitBeat[1] = beat
      if (beat === 'flinch') p.setLean(-0.1, 0)
      else if (beat === 'clutch') p.setLean(-0.03, 0)
      else if (beat === 'look') {
        p.setLean(0, 0)
        letGo(p, 'left')
        letGo(p, 'right')
      }
      else if (beat === 'stagger') {
        // Back a step, to see up into the crown.
        p.play('step-back', { from: { x: p.position.x + Math.sin(p.heading) * 0.5, z: p.position.z + Math.cos(p.heading) * 0.5 }, distance: 0.22 })
      }
      else if (beat === 'laugh') {
        // A hand up toward the culprit, laughing it off.
        const c = Math.cos(p.heading)
        const sn = Math.sin(p.heading)
        const crown = crownNear(1)
        upT.position.set(p.position.x - c * 0.2, 0.82 * p.dims.H, p.position.z + sn * 0.2)
        glideTmp.subVectors(crown, upT.position).normalize()
        upT.position.addScaledVector(glideTmp, 0.5 * p.dims.H / 1.6)
        upT.elbow.set(-c, -0.7, sn)
        hold(p, 'right', upT)
      }
      else if (beat === 'home') {
        letGo(p, 'right')
        const h = homes[1]!
        const dx = h.x - p.position.x
        const dz = h.z - p.position.z
        const d = Math.hypot(dx, dz)
        if (d > 0.03) p.play('step-back', { from: { x: p.position.x - dx, z: p.position.z - dz }, distance: d })
      }
      else {
        if (p.busy || glideOf(p, 'right').state !== 'off') {
          hitBeat[1] = 'home'
          return
        }
        p.play('idle')
        hitAt[1] = -1
        return
      }
    }
    if (beat === 'flinch' || beat === 'clutch') {
      handToHead(p, 'left')
      handToHead(p, 'right')
    }
    // Hands on her head, eyes down ahead of her; then up at the palm.
    p.lookAt(beat === 'laugh' || beat === 'home' ? kiteAim : beat === 'flinch' || beat === 'clutch' ? aheadOf(p) : crownNear(1))
  }
  /** A point on the ground a couple of metres ahead of p (bank frame): where eyes go when a hit makes them wince. */
  const aheadV = new THREE.Vector3()
  function aheadOf(p: Person) {
    return aheadV.set(p.position.x + Math.sin(p.heading) * 2, 0.3, p.position.z + Math.cos(p.heading) * 2)
  }

  /** The crown above bank person i (the nearest one), bank frame. */
  function crownNear(i: number) {
    const p = bankPeople[i]!
    let best = crowns[0]!
    for (const c of crowns) if (Math.hypot(c.x - p.position.x, c.z - p.position.z) < Math.hypot(best.x - p.position.x, best.z - p.position.z)) best = c
    return best
  }

  /** Aim a nut from `palm` at bank person i's head (world). */
  function aimAt(palm: number, i: number) {
    headTop(bankPeople[i]!, head)
    aimedAt = i
    busyUntil[fishers.length + i] = time + 3
    sim.requestDrop(palm, [head.x, head.y + BANK.top + NUT_R, head.z])
  }

  /** On their own: now and then a nut comes down, most of them on someone. */
  function autoDrop() {
    nextAuto = time + R.range(...AUTO_EVERY)
    const aimed = R.next() < AUTO_AIMED
    for (let k = 0; k < bankPeople.length; k++) {
      const i = (autoTurn + k) % bankPeople.length
      if (!bankFree(i)) continue
      let palm = -1
      crowns.forEach((c, j) => {
        const d = Math.hypot(c.x - bankPeople[i]!.position.x, c.z - bankPeople[i]!.position.z)
        if (d < HIT_RANGE && sim.hasNut(j) && (palm < 0 || d < Math.hypot(crowns[palm]!.x - bankPeople[i]!.position.x, crowns[palm]!.z - bankPeople[i]!.position.z))) palm = j
      })
      if (palm < 0 || !sim.hasFreeBody()) continue
      autoTurn = i + 1
      if (aimed) aimAt(palm, i)
      else sim.requestDrop(palm)
      return
    }
  }

  /** The bonk reaction, beat by beat, from the time since the hit. */
  function childReact(t: number) {
    const beat = t < BONK.flinch ? 'flinch' : t < BONK.rub ? 'rub' : t < BONK.look ? 'look' : t < BONK.relaunch ? 'relaunch' : ''
    if (beat !== bonkBeat) {
      bonkBeat = beat
      hitBeat[2] = beat
      if (beat === 'flinch') {
        // Both hands to the head; the kite line goes slack and the kite sinks.
        child.setLean(-0.18, 0)
        kite.sim.windSpeed = KITE_SLACK
        kiteHold = false
      }
      else if (beat === 'rub') {
        // The kite hand goes back to the line; the other keeps rubbing.
        child.setLean(0.12, 0)
        kiteHold = true
      }
      else if (beat === 'look') {
        child.setLean(0, 0)
        letGo(child, 'right')
      }
      else if (beat === 'relaunch') {
        // Up again: the breeze takes the kite.
        childDefault()
        kite.sim.windSpeed = KITE_SPEED
        kite.react()
      }
      else {
        hitAt[2] = -1
        return
      }
    }
    if (beat === 'flinch') {
      handToHead(child, 'left')
      handToHead(child, 'right')
    }
    else if (beat === 'rub') handToHead(child, 'right', 0.02 * Math.sin(2 * Math.PI * 1.6 * t))
    if (beat === 'flinch' || beat === 'rub') child.lookAt(aheadOf(child))
    else if (beat === 'look') child.lookAt(crownLook)
    else child.lookAt(kiteAim, { priority: 'target' })
  }

  function step(dt: number) {
    if (!poster) time += dt
    const phase = haulAll()
    watchNet()

    // The net breaking out of the water on the way up, full: the child points.
    const surfaced = wasWet && !sim.wet && phase === 'lift'
    wasWet = sim.wet
    if (!paused && surfaced && childFree()) {
      childNetUntil = time + POINT_NET
      netPoint.copy(netLook)
      child.play('point', { target: toBank(netPoint, new THREE.Vector3()), hand: 'right' })
    }
    if (childNetUntil > 0 && time >= childNetUntil) {
      childNetUntil = 0
      childDefault()
    }

    for (const e of sim.events) {
      // The bonk: the reaction starts on the step the nut reaches the head.
      if (e.kind === 'nut-bonk') {
        aimedAt = -1
        const who = nearestBank(e.x, e.z)
        // Whatever they were doing stops: a point, a wave.
        if (nutWho === who) nutWho = -1
        if (who === 2 && childNetUntil > 0) childNetUntil = 0
        hitAt[who] = time
        hitBeat[who] = ''
        hits[who]!++
        if (who === 2) bonkBeat = ''
        busyUntil[fishers.length + who] = time + (who === 0 ? WATCHER_HIT.done : who === 1 ? VISITOR_HIT.done : BONK.relaunch)
        continue
      }
      // A coconut leaving its crown: the nearest bank person points at it while it falls and rolls.
      if (e.kind !== 'nut-drop' || paused) continue
      const b = sim.bodies.findIndex(x => x.mode === 'fall' && x.t <= dt + 1e-9)
      if (b < 0) continue
      const spec = PALMS[e.palm]!
      // An aimed nut: nobody sees it coming (the one it is falling at least of all).
      if (sim.bodies[b]!.aim) continue
      const who = nearestBank(spec.base[0], spec.base[2])
      const k = fishers.length + who
      if (!bankFree(who)) continue
      if (nutWho >= 0 && nutWho !== who) restoreBank(nutWho)
      nutWho = who
      nutBody = b
      busyUntil[k] = time + POINT_NUT
      const body = sim.bodies[b]!
      nutAim.set(body.x, body.y - BANK.top, body.z)
      bankPeople[who]!.play('point', { target: nutAim })
    }
    if (nutWho >= 0) {
      const body = sim.bodies[nutBody]!
      if (body.mode !== 'off') nutAim.set(body.x, body.y - BANK.top, body.z)
      if (time >= busyUntil[fishers.length + nutWho]!) {
        restoreBank(nutWho)
        nutWho = -1
      }
    }
    // An aimed nut that missed (the head moved): nothing happens after all.
    if (aimedAt >= 0 && !sim.bodies.some(b => b.aim) && !sim.events.some(e => e.kind === 'nut-bonk')) aimedAt = -1
    if (!paused && !poster && opts.autoNuts !== false && time >= nextAuto) autoDrop()

    // The catch: what swims into the net on its way in, shown once it is out of the water.
    for (const e of sim.events) if (e.kind === 'splash') fishCatch.roll()
    netShown = !sim.wet && (phase === 'lift' || phase === 'rest')
    fishCatch.step(dt, netShown)
    if (netShown) {
      for (const k of fishCatch.flapped) {
        const fsh = fishCatch.fish[k]!
        if (fsh.where !== 'net') continue
        const c = netCorners(sim.theta, cw4)
        const q = netAt(c, fsh.u, fsh.v, sim.sag, p3)
        sim.splash(q[0], q[1], q[2], 2)
      }
    }
    // At rest with fish in the net, fisher 0 scoops them out and tips them in the basket.
    scoop.prevHoop.copy(scoop.hoop)
    scoop.prevButt.copy(scoop.butt)
    if (!scoop.scooping && time >= regripUntil && phase === 'rest' && !paused && fishCatch.count('net') > 0 && !waveHand[0] && netShown) {
      selectedFish = fishCatch.fish.findIndex(f => f.where === 'net')
      const fish = fishCatch.fish[selectedFish]!
      const at = netAt(netCorners(sim.theta, cw4), fish.u, fish.v, sim.sag, p3)
      // Put the bag directly under this fish rather than scooping the whole belly.
      dOut.set(at[0], at[1] + 0.175, at[2]).sub(P)
      sOut = dOut.length()
      dOut.normalize()
      scoop.scooping = true
      scoop.t = 0
      glanceUntil[0] = 0
    }
    if (scoop.scooping) {
      const was = scoop.t
      scoop.t += dt
      polePose(scoop.t)
      if (was < (SC.out + SC.dip) / 2 && scoop.t >= (SC.out + SC.dip) / 2) fishCatch.toHoop(selectedFish)
      if (was < (SC.back + SC.tip) / 2 && scoop.t >= (SC.back + SC.tip) / 2) {
        releaseAt[0] = scoop.hoop.x
        releaseAt[1] = scoop.hoop.y - 0.14
        releaseAt[2] = scoop.hoop.z
        fishCatch.toBasket(releaseAt)
      }
      if (scoop.t >= SC.done) {
        scoop.scooping = false
        scoop.t = -1
        regripUntil = time + REGRIP
        regripGlanced = false
      }
    }

    sim.holdCycle = phase === 'rest' && (fishCatch.count('net') > 0 || scoop.scooping || time < regripUntil)

    // Fishers: queued waves wait for the boom to rest; the hands follow the haul.
    for (let i = 0; i < fishers.length; i++) {
      if (waveHand[i] && time >= busyUntil[i]!) waveHand[i] = false
      if (waveQueued[i] && phase === 'rest' && !paused && !(i === 0 && scoop.scooping)) {
        waveQueued[i] = false
        waveFisher(i)
      }
      setFisherHands(i)
      // Eyes on the net (or the scoop's hoop) over the hands: they look down
      // at their hands only as they take new grips -- the re-grip in the soak,
      // and after the scoop.
      const f = fishers[i]!
      if (glanceUntil[i]! > time) f.lookAt(viewer, { priority: 'target' })
      else f.lookAt(i === 0 && scoop.scooping ? hoopDeck.set(scoop.hoop.x, scoop.hoop.y - DECK.top, scoop.hoop.z) : netDeck, { priority: 'target' })
      if ((phase === 'soak' && lastPhase[i] !== 'soak') || (i === 0 && regripUntil > 0 && time < regripUntil && !regripGlanced)) {
        f.glanceAtHands(0.8)
        if (i === 0 && time < regripUntil) regripGlanced = true
      }
      lastPhase[i] = phase
    }

    for (let i = 0; i < bankPeople.length; i++) {
      if (hitAt[i]! >= 0) {
        if (i === 0) watcherReact(time - hitAt[0]!)
        else if (i === 1) visitorReact(time - hitAt[1]!)
        else childReact(time - hitAt[2]!)
        continue
      }
      if (i === 2 && childNetUntil > 0) {
        child.lookAt(netBank)
        continue
      }
      if (i === nutWho) {
        bankPeople[i]!.lookAt(nutAim)
        continue
      }
      bankLook(i, phase)
    }

    // The child's arm follows the kite through a slow low-pass: it tracks
    // where the kite flies, not every flutter of the gusts.
    const ka = Math.min(1, dt / 1.2)
    kiteAim.x += (kite.sim.p[0] - kiteAim.x) * ka
    kiteAim.y += (kite.sim.p[1] - BANK.top - kiteAim.y) * ka
    kiteAim.z += (kite.sim.p[2] - kiteAim.z) * ka
    if (kiteHold) holdKite()
    stepGlides(dt)
    for (const p of people) p.step(dt)
    // The kite's line is tied to the child's left palm (world).
    kite.setAnchor(child.handWorld('left', tmp).setY(tmp.y + BANK.top))
    kite.step(dt)
  }

  function restoreBank(i: number) {
    busyUntil[fishers.length + i] = 0
    if (i === 0) watcher.play('watch')
    else if (i === 1) visitor.play('idle')
    else childDefault()
  }

  // Settle: set the hands on the ropes and let the arms finish reaching for
  // them before the first frame (a fixed number of steps of the people only,
  // so it is as deterministic as the rest).
  haulAll()
  watchNet()
  for (let i = 0; i < fishers.length; i++) setFisherHands(i)
  bankLook(0, 'rest')
  bankLook(1, 'rest')
  bankLook(2, 'rest')
  holdKite(true)
  const settle = poster ? 1 : Math.ceil(0.6 / DT)
  for (let n = 0; n < settle; n++) {
    for (const p of people) p.step(DT)
  }
  const handW = child.handWorld('left', new THREE.Vector3())
  handW.y += BANK.top
  kite = createKite({ materials: ctx.materials, posterMode: poster }, { seed: 9, anchor: handW, line: KITE_LINE, windDir: KITE_WIND })
  kite.sim.windSpeed = KITE_SPEED
  // A steady sea breeze: the kite sim's gusts, slower and gentler.
  const gusts = kite.sim.gusts
  if (gusts) kite.sim.gusts = (t, axis) => 0.6 * gusts(t * 0.6, axis)
  kiteAim.set(kite.sim.p[0], kite.sim.p[1] - BANK.top, kite.sim.p[2])
  child.lookAt(kiteAim, { priority: 'target' })
  // The poster never steps again: aim the hand at where the kite actually is.
  if (poster) {
    holdKite(true)
    child.step(DT)
  }
  await yieldTask()

  // Camera envelope of the kite: its equilibrium spot, plus the gusts' swing.
  const fitPoints: THREE.Vector3[] = []
  {
    const el = kite.sim.equilibriumElevation()
    const wl = Math.hypot(...KITE_WIND)
    const kx = handW.x + KITE_WIND[0] / wl * KITE_LINE * Math.cos(el)
    const kz = handW.z + KITE_WIND[1] / wl * KITE_LINE * Math.cos(el)
    const ky = handW.y + KITE_LINE * Math.sin(el)
    for (const dx of [-0.9, 0.9]) for (const dy of [-0.9, 0.7]) fitPoints.push(new THREE.Vector3(kx + dx, ky + dy, kz))
  }

  const crew: Crew = {
    people,
    fishers,
    bankPeople,
    child,
    kite,
    deck,
    bank,
    hauls,
    lead: FISHERS.map(f => f.lead),
    bonkPalm,
    catch: fishCatch,
    get netShown() { return netShown },
    get regripping() { return time < regripUntil },
    get ropeHeld() {
      ropeHeldNow[0] = !(scoop.scooping && scoop.t > (SC.reach + SC.join) / 2 && scoop.t < (SC.tip + SC.done) / 2)
      return ropeHeldNow
    },
    scoop,
    fitPoints,
    hits,
    reacting: i => hitAt[i]! >= 0,
    beat: i => (i === 2 ? bonkBeat : hitBeat[i] ?? ''),
    get childState(): ChildState {
      if (hitAt[2]! >= 0 || aimedAt === 2) return 'bonk'
      if (childNetUntil > 0) return 'net'
      return time < busyUntil[CHILD_I]! || nutWho === 2 ? 'busy' : 'flying'
    },
    get bonkBeat() { return bonkBeat },
    step,
    frame(alpha) {
      for (const p of people) p.frame(alpha)
      kite.frame(alpha)
    },
    pick(ray) {
      if (kite.hit(ray)) return -2
      let best = -1
      let bd = Infinity
      // Nearest along the ray: people overlap on screen.
      people.forEach((p, i) => {
        if (!p.hit(ray)) return
        const d = ray.ray.origin.distanceToSquared(tmp.copy(p.position).add((p.root.parent ?? deck).position))
        if (d < bd) {
          bd = d
          best = i
        }
      })
      return best
    },
    setHover(i) {
      if (i === hovered) return
      if (hovered === -2) kite.setSelected(false)
      else if (hovered >= 0) people[hovered]!.setSelected(false)
      hovered = i
      if (i === -2) kite.setSelected(true)
      else if (i >= 0) people[i]!.setSelected(true)
    },
    tap(i) {
      if (paused) return ''
      if (i === -2) return kite.react()
      if (i < fishers.length) {
        if (i === 0 && scoop.scooping) return 'The fisher is landing the catch.'
        if (sim.phase === 'rest' && !waveHand[i]) {
          waveFisher(i)
          return 'A fisher waves, one hand still on the rope.'
        }
        if (waveHand[i]) return 'The fisher is already waving.'
        waveQueued[i] = true
        glanceUntil[i] = time + 1.6
        // "You": a point toward the viewer at head height.
        viewer.set(fishers[i]!.position.x + 3, 1.6, fishers[i]!.position.z + 6)
        return 'The fisher\'s hands are full; he will wave when the net is up.'
      }
      const b = i - fishers.length
      if (time < busyUntil[i]! || (b === 2 && !childFree())) return 'They are busy just now.'
      busyUntil[i] = time + WAVE_TIME
      bankPeople[b]!.play('wave', { hand: 'right' })
      return b === 2 ? 'The child waves, still holding the kite.' : 'A visitor on the bank waves.'
    },
    wave() {
      const order = [CHILD_I, fishers.length + 1, 0, fishers.length, 1]
      for (let k = 0; k < order.length; k++) {
        const i = order[(waveTurn + k) % order.length]!
        if (i >= fishers.length && time < busyUntil[i]!) continue
        if (i === CHILD_I && !childFree()) continue
        if (i < fishers.length && (waveHand[i] || waveQueued[i])) continue
        waveTurn = (waveTurn + k + 1) % order.length
        return crew.tap(i)
      }
      return 'Everyone is busy just now.'
    },
    tugKite() {
      if (hitAt[2]! >= 0) return 'The kite is down for a moment.'
      return kite.react()
    },
    dropNut(palm, target) {
      if (!sim.hasNut(palm) || !sim.hasFreeBody()) return false
      const who = paused ? -1 : target !== undefined ? (bankFree(target) ? target : -1) : targetFor(palm)
      if (who >= 0) aimAt(palm, who)
      else sim.requestDrop(palm)
      return true
    },
    setPaused(p) {
      paused = p
      for (const q of people) q.setPaused(p)
      kite.setPaused(p)
      if (p) {
        waveQueued.fill(false)
        glanceUntil.fill(0)
        crew.setHover(-1)
      }
    },
    dispose() {
      for (const p of people) p.dispose()
      kite.dispose()
      deck.removeFromParent()
      bank.removeFromParent()
    },
  }
  return crew
}
