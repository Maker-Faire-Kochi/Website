import * as THREE from 'three'
import { DT } from '../core/clock'
import { addLights, type MatKey } from '../core/kit'
import { rng } from '../core/rng'
import { heroAnchors, heroKeepOut, type ScreenRect } from '../core/signal'
import { nextTask, type SceneContext, type SlotPointer } from '../core/stage'
import { createBalancer } from '../robots/balancer/balancer'
import { createDuck } from '../robots/duck/duck'
import { createDog } from '../robots/dog/dog'
import { createMakey } from '../robots/makey/makey'
import { AGENT_STRIDE, avoid, type Steer } from '../robots/avoid'
import { bandsMeet, keepOutDistance, passesOver, keepOutOf, maxOverlap, solveContacts, WALL, type Body, type Box, type ContactOptions, type KeepOut, type Normal, type Obstacle, type Walls } from '../robots/contact'
import { Dust } from '../robots/dust'
import { CONE, FIELD, GOAL, buildField, buildPitch, buildProps, fieldObstacles, pitchCentre, type Pitch } from '../robots/arena/arena'
import { Ball, BALL } from '../robots/arena/props'
import { playScrape, playTick } from '../robots/arena/sound'
import { noiseBuffer, soundContext } from '../../composables/usePanelSound'
import type { Robot, RobotCommand, RobotOptions } from '../robots/types'

/**
 * The hero: robot football on the whole first screen. Makey, two
 * Open-Duck-Mini ducks, an Ascento-style wheel-legged balancer and a
 * quadruped dog play on the hero's yellow field, which is the floor from edge
 * to edge.
 *
 * The floor is the page's own yellow (arena.ts): no board, no plinths; the
 * page's text floats on it as on the rest of the page.
 *
 * THE PAGE'S TEXT IS A WALL. The page publishes the screen areas its words,
 * key and controls occupy (heroKeepOut, fractions of the slot). Each is
 * projected onto the floor through this camera and becomes a solid box in the
 * contact solver -- extended toward the viewer by a robot's height, so that
 * no robot standing in front of the text ever reaches up into it on screen.
 * The wall is invisible: nothing is drawn to show it. The screen's edges are
 * walls the same way. Robots, the ball and a thrown robot bounce off them;
 * every goal the director sets is clamped outside them. The pitch spans the
 * free screen: its goals at the far ends of the longest free span across
 * it, its touchlines as far up and down from there as the floor is free all
 * the way across, its markings stopping short of the text; the robots range
 * over all the free floor, past the lines. Rebuilt when the layout changes.
 *
 * This file is only the DIRECTOR. It decides where each robot wants to be and
 * what it looks at, and turns that into bounded commands; each robot's own
 * controller or gait moves its body. Nothing here writes a robot's position
 * (except to lift one out of a wall that a layout change put it inside).
 *
 * EVERY MOTION HAS A PURPOSE. Two teams (red defends the -X goal, blue the
 * +X goal; a robot's accent is its shirt). Each robot has a role:
 *   keeper   stays in its goal mouth, sliding with the ball; clears a slow
 *            ball out of its box
 *   presser  the team's field player first to the ball. With the ball (the
 *            attacking side) it runs round behind it, dribbles it toward
 *            the other goal and shoots once in range, aiming away from the
 *            keeper. Without it, it marks: holds a spot between the ball and
 *            its own goal, watching
 *   support  the team's other field player: takes a spot off the ball on the
 *            far side of the pitch and watches it
 * Possession changes hands on a shot, a goal, a goal kick, a keeper's
 * clearance and a clash, so the play reads as attack, shot, save or goal,
 * the other way. Every 10-15 s (seeded) the marker goes in for the ball: both
 * pressers go flat out for it and then for each other -- a clash, and one of
 * them is knocked over and gets up its own way. A goal stops play: the scorers
 * celebrate (Makey waves, the dog hops, the wheel-leg jumps, a duck hops),
 * the ball is re-spotted at the centre. A
 * ball behind a goal line but not in the goal is a goal kick.
 *
 * THE POINTER only counts when it means something. Moving it changes
 * nothing -- the game plays on and nobody turns to it. A click or tap on the
 * floor, or the pointer resting still on it for 1.2 s, puts down a target
 * (a cyan ring): the nearest robot (two, on the desktop cast) goes there --
 * Makey waves on arrival -- and goes back to the game once there, or after
 * 4 s. Over the text the target sits at the text's wall. A press on a robot
 * grabs it (a spring through its own physics, robots/grab.ts).
 *
 * Collisions: look-ahead avoidance (robots/avoid.ts) in steer() keeps robots
 * that are not contesting the ball from bumping; the contact solver
 * (robots/contact.ts) is the hard guarantee (overlap <= 2 mm, tested); every
 * real contact gets a reaction, a dust puff and a bump voice.
 */

type Mode = 'play' | 'dot' | 'celebrate' | 'tackle' | 'clear' | 'kick' | 'charge' | 'go' | 'called' | 'chain' | 'egg' | 'react' | 'held'
export type Egg = 'dance' | 'party' | 'line-up' | 'conga' | 'sleep'
type Team = 0 | 1

/** A run at the ball: get behind it on the line to the aim, then go through it. */
interface Run { phase: 'approach' | 'dash', t0: number, x0: number, z0: number, dx: number, dz: number, plan: number, touched: boolean, last: number, bold: boolean, ax: number, az: number }

interface Actor {
  robot: Robot
  mode: Mode
  team: Team
  keeper: boolean
  goal: THREE.Vector3
  until: number
  /** Chain / conga: index of the robot ahead (-1 = leader). */
  target: number
  /** Scratch look target (no per-step allocation). */
  look: THREE.Vector3
  /** Egg beat, or a celebration's one-shot (-1 = not yet). */
  beat: number
  index: number
  run: Run
  /** Reached the laser dot (Makey waves once per arrival). */
  arrived: boolean
  react: { t0: number, other: number, x: number, z: number, resume: Mode }
}

/**
 * The camera: orthographic, square on and 34 deg down -- a broadcast view of
 * the game running left to right. Square on, a rectangle of the page is a
 * rectangle of floor: the text's walls are plain boxes whose edges run along
 * the text's own, and the screen's edges are level lines on the floor.
 * (Turned, every line of the floor slants across the words.) CAMERA is its position
 * (also "the viewer").
 */
const CAM_AZ = 0
const CAM_EL = 0.6
const LOOK_AT = new THREE.Vector3(0, 0, 0)
const CAMERA = new THREE.Vector3(Math.sin(CAM_AZ) * Math.cos(CAM_EL), Math.sin(CAM_EL), Math.cos(CAM_AZ) * Math.cos(CAM_EL)).multiplyScalar(4)
/**
 * Robots' size on screen: px per metre = perH x the slot's height, but at
 * least `minWidth` m of floor across. 0.7 of 900 px is 1.3x the robots'
 * size in the first version of this hero.
 */
const VIEW = { perH: 0.7, minWidth: 1.0 }
/** The page stacks the hero under this media query (phone layout, phone poster): the phone cast plays there. */
export const HERO_STACKED = '(max-width: 900px), (max-height: 600px)'
/**
 * Walls from the screen: the tallest robot (m: its head must stay on screen
 * and off the text -- a duck mid-hop reaches 0.39 m), the padding round each keep-out (m) -- deeper on its far
 * side, where a robot that falls toward the viewer would lay its head on the
 * text -- and the gap kept from the screen's edges (m). (The nav rail is one
 * of the page's rects.)
 */
const KEEP = { head: 0.42, pad: 0.08, padBack: 0.14, edge: 0.04 }
/** The pitch's lines stand `inset` m in from the free floor's edges. */
const FIELD_FIT = { inset: 0.04 }

type Make = (c: SceneContext, o: RobotOptions) => Robot
/** Robot factories by kind. A new robot joins with ONE line here and a CAST entry below. */
const FACTORIES: Partial<Record<Robot['kind'], Make>> = {
  duck: createDuck,
  balancer: createBalancer,
  dog: createDog,
  makey: createMakey,
}
/**
 * A cast slot: which robot, its shirt, its team and role, and where it starts
 * (fractions of the pitch's half-extents from its centre, and a heading).
 * Keepers start in their own goal mouth.
 */
export interface CastEntry { kind: Robot['kind'], accent: RobotOptions['accent'], team: Team, keeper?: boolean, at: [number, number, number] }
const RIGHT = Math.PI / 2
/**
 * Desktop: red (defends -X) Makey + dog in the field, a duck in goal; blue
 * the wheel-leg in the field, a duck in goal. Entries whose kind has no
 * factory are skipped and the next fills in. Phone: Makey v a duck, no keepers.
 */
const CAST_WIDE: CastEntry[] = [
  { kind: 'makey', accent: 'red', team: 0, at: [-0.4, 0.38, RIGHT] },
  { kind: 'duck', accent: 'accent', team: 1, keeper: true, at: [1, 0, -RIGHT] },
  { kind: 'balancer', accent: 'accent', team: 1, at: [0.3, -0.05, -RIGHT] },
  { kind: 'duck', accent: 'red', team: 0, keeper: true, at: [-1, 0, RIGHT] },
  { kind: 'dog', accent: 'dark', team: 0, at: [-0.2, -0.35, RIGHT] },
  { kind: 'balancer', accent: 'dark', team: 0, at: [-0.2, -0.35, RIGHT] },
]
const CAST_PHONE: CastEntry[] = [
  { kind: 'makey', accent: 'red', team: 0, at: [-0.4, 0.15, RIGHT] },
  { kind: 'duck', accent: 'accent', team: 1, at: [0.4, -0.15, -RIGHT] },
  { kind: 'balancer', accent: 'accent', team: 1, at: [0.4, -0.15, -RIGHT] },
]
const LABEL: Record<Robot['kind'], string> = { duck: 'Duck', balancer: 'Wheel-leg', dog: 'Dog', makey: 'Makey' }
/** The cast actually built: the first `max` entries whose robots exist. */
export function castFor(wide: boolean) {
  return (wide ? CAST_WIDE : CAST_PHONE).filter(e => FACTORIES[e.kind]).slice(0, wide ? 5 : 2)
}

/**
 * Football. Ball speeds leaving a strike (m/s), the range a presser shoots
 * from (m from the goal mouth), how long a celebration lasts and when the
 * ball is re-spotted (s), the referee's restart if nobody has touched the
 * ball for `stall` s, and the run-up behind the ball (m).
 */
const PLAY = { shot: 1.0, dribble: 0.4, clear: 0.55, range: 0.6, dash: 1.2, celebrate: 2.8, respot: 1.6, stall: 14, runUp: 0.06 }
/**
 * Where each kind strikes the ball from, m ahead of its centre: Makey's and a
 * duck's toes, the front of the wheel-leg's tyres, the dog's front paws. The
 * ball can pass under a wheel-leg's pod between its wheels and between a
 * walker's feet, so a strike is that point reaching the ball, not a body
 * contact.
 */
const REACH: Record<Robot['kind'], number> = { makey: 0.07, duck: 0.07, balancer: 0.06, dog: 0.17 }
/** Clashes: the first after `first` s, then every `gap` s (seeded); a tackle gives up after `time` s. */
const CLASH = { first: [6, 9], gap: [10, 14], time: 6, near: 1.4 }
/**
 * A target: robots sent (desktop cast), how long it lasts at most (s), how
 * long they linger on arrival (s), and the pointer rest that sets one (s).
 */
const DOT = { chasers: 2, life: 4, linger: 0.8, rest: 1.2 }
const CRASH = { time: 3, sprint: 0.7 }
/** Chain: gap between one robot's footprint and the next, m. */
const CHAIN_GAP = 0.1
/**
 * Personal distance beyond the two footprints (robot.radius), m: in the game
 * (players work close to each other -- more and their spots overlap and two
 * wait for each other for ever), in the egg routines, round an obstacle,
 * extra for a pair that has just bumped, and round anyone lying on the floor.
 */
const PERSONAL = { margin: 0.1, play: -0.04, egg: 0.06, obstacle: 0.05, cooling: 0.1, fallen: 0.08 }
/**
 * Contact reactions. A contact closing faster than `min` (m/s) is a real
 * bump: head snaps round for `look` s; still until `pause`; a step away until
 * `back`; then carry on. `cool`: no second reaction for the same pair.
 * In the game a contact slower than `play` (any: a hard hit staggers or
 * floors a robot by its own physics) only turns the head -- players work
 * shoulder to shoulder, and stopping for every bump would stop the game.
 */
const REACT = { min: 0.05, look: 0.9, pause: 0.35, back: 0.8, backSpeed: 0.1, cool: 1.5, play: Infinity }
/** Below this impact speed a bump is a rubber thud, above it a clank; dust only above `dust`. */
const BUMP = { gap: 0.08, rubber: 0.18, dust: 0.03, dustGap: 0.15 }
/** Contact skin: a little air between footprints, more along the camera's line of sight. */
const VIEW_DIR = new THREE.Vector3().subVectors(LOOK_AT, CAMERA).setY(0).normalize()
const CONTACT_OPTS: ContactOptions = { skin: 0.004, viewSkin: 0.012, viewX: VIEW_DIR.x, viewZ: VIEW_DIR.z }
/** A drag lifts the grabbed point this much over the plane it was picked on. */
const DRAG_LIFT = 0.03
const REST_PX = 8
/** Easter eggs: each is bounded (s), deterministic, and returns to play. */
const EGG_S: Record<Egg, number> = { 'dance': 8, 'party': 8, 'line-up': 8, 'conga': 8, 'sleep': 8 }
const BEAT = 0.5
/** 'party' cycles every head through the palette: the one sanctioned break of colour-with-purpose. */
const PARTY: MatKey[] = ['red', 'cyan', 'accent', 'leaf', 'wood']
/** The conga loop as fractions of the pitch. */
const CONGA = { rx: 0.7, rz: 0.6, lead: 0.7 }
/** Line-up rows: the front row `z` in front of the robots' middle, the back row `gap` behind it. */
const LINE = { half: 0.45, z: 0.14, gap: 0.22, bowAt: 5.2, bowFor: 1.4 }

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const clamp = THREE.MathUtils.clamp

/** Only one hero instance publishes leader-line anchors: the largest (the lab also draws a thumbnail). */
let anchorOwner: object | null = null
let anchorOwnerW = 0

/** True if box r and convex keep-out k overlap (separating axes: the box's, then the outline's edges). */
function boxMeetsKeep(r: Box, k: KeepOut) {
  if (k.minX >= r.maxX - 1e-9 || k.maxX <= r.minX + 1e-9 || k.minZ >= r.maxZ - 1e-9 || k.maxZ <= r.minZ + 1e-9) return false
  const p = k.planes
  for (let i = 0; i < p.length; i += 3) {
    const nx = p[i]!, nz = p[i + 1]!, c = p[i + 2]!
    // The box's corner furthest into the half-plane.
    const v = Math.min(nx * r.minX, nx * r.maxX) + Math.min(nz * r.minZ, nz * r.maxZ) - c
    if (v >= -1e-9) return false
  }
  return true
}

/** Grid of the free-floor search, m: the pitch's edges land on it (at most this much inside the exact best). */
const FREE_CELL = 0.01
/** The smallest free rectangle worth a pitch, m (below it, the caller keeps the pitch it had). */
const FREE_MIN = 0.05
let freeRow = new Uint8Array(0)
let freeH = new Int32Array(0)
let freeStack = new Int32Array(0)

/**
 * The largest rectangle inside `bounds` that meets none of the keep-outs,
 * on a FREE_CELL grid: each grid row marks the cells a keep-out reaches
 * (its exact x-extent within the row's strip -- convex, so one interval),
 * and a histogram sweep up the rows visits every maximal empty rectangle.
 * Long rectangles are preferred (goals go at the ends): the score grows
 * with both width and depth, so the best is always a maximal one. O(rows x
 * (cols + keep-out edges)): a millisecond or two, where testing every pair
 * of candidate edges against every keep-out took tens. Null if no free
 * rectangle is at least FREE_MIN each way.
 */
export function largestFree(bounds: Box, keeps: readonly KeepOut[]): Box | null {
  const cols = Math.floor((bounds.maxX - bounds.minX) / FREE_CELL)
  const rows = Math.floor((bounds.maxZ - bounds.minZ) / FREE_CELL)
  if (cols <= 0 || rows <= 0) return null
  if (freeRow.length < cols) {
    freeRow = new Uint8Array(cols)
    freeH = new Int32Array(cols + 1)
    freeStack = new Int32Array(cols + 1)
  }
  freeH.fill(0)
  let best: Box | null = null, score = -1
  for (let r = 0; r < rows; r++) {
    const z0 = bounds.minZ + r * FREE_CELL, z1 = z0 + FREE_CELL
    freeRow.fill(0, 0, cols)
    for (const k of keeps) {
      if (k.maxZ <= z0 || k.minZ >= z1 || k.maxX <= bounds.minX || k.minX >= bounds.maxX) continue
      // The outline's x-extent inside the strip z0..z1: vertices in it, and
      // where its edges cross the strip's two lines.
      const o = k.outline, m = o.length
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i < m; i += 2) {
        const ax = o[i]!, az = o[i + 1]!, bx = o[(i + 2) % m]!, bz = o[(i + 3) % m]!
        if (az >= z0 && az <= z1) {
          lo = Math.min(lo, ax)
          hi = Math.max(hi, ax)
        }
        for (let s = 0; s < 2; s++) {
          const z = s ? z1 : z0
          if ((z - az) * (z - bz) < 0) {
            const x = ax + (bx - ax) * (z - az) / (bz - az)
            lo = Math.min(lo, x)
            hi = Math.max(hi, x)
          }
        }
      }
      if (hi <= lo) continue
      // Every cell whose open span meets (lo, hi).
      const c0 = Math.max(0, Math.floor((lo - bounds.minX) / FREE_CELL)), c1 = Math.min(cols - 1, Math.ceil((hi - bounds.minX) / FREE_CELL) - 1)
      for (let c = c0; c <= c1; c++) freeRow[c] = 1
    }
    for (let c = 0; c < cols; c++) freeH[c] = freeRow[c] ? 0 : freeH[c]! + 1
    // Histogram sweep: each bar popped is the tallest rectangle at its height
    // spanning from the bar left of it on the stack to the current column.
    let sp = 0
    for (let c = 0; c <= cols; c++) {
      const hc = c < cols ? freeH[c]! : 0
      while (sp > 0 && freeH[freeStack[sp - 1]!]! >= hc) {
        const hb = freeH[freeStack[--sp]!]!
        const left = sp > 0 ? freeStack[sp - 1]! + 1 : 0
        const w = (c - left) * FREE_CELL, d = hb * FREE_CELL
        if (w < FREE_MIN || d < FREE_MIN) continue
        const sc = w * d * Math.min(1, w / (1.2 * d))
        if (sc <= score) continue
        score = sc
        best = { minX: bounds.minX + left * FREE_CELL, maxX: bounds.minX + c * FREE_CELL, minZ: z1 - d, maxZ: z1 }
      }
      freeStack[sp++] = c
    }
  }
  if (!best) return null
  // Off the grid: each side out as far as it goes (within a cell, by
  // bisection), so the pitch is the exact free rectangle, not the cells in it.
  const sides = ['minX', 'maxX', 'minZ', 'maxZ'] as const
  for (const side of sides) {
    const out = side === 'minX' || side === 'minZ' ? -1 : 1
    const limit = bounds[side]
    let lo = 0, hi = Math.min(FREE_CELL, Math.abs(limit - best[side]))
    const at = best[side]
    for (let it = 0; it < 12 && hi > 1e-5; it++) {
      const mid = (lo + hi) / 2
      best[side] = at + out * mid
      if (keeps.some(k => boxMeetsKeep(best!, k))) hi = mid
      else lo = mid
    }
    best[side] = at + out * lo
  }
  return best
}

/** A soft, low rubber thud for a gentle bump: a sine that drops, no click. */
function playRubber(speed: number) {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(150, t)
  o.frequency.exponentialRampToValueAtTime(70, t + 0.08)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.02 + 0.06 * Math.min(1, speed / 0.18), t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
  o.connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.13)
}

/** A metallic clank for robots bumping: two inharmonic partials over a click, gain from the impact. */
function playClank(speed: number) {
  const ac = soundContext()
  const noise = noiseBuffer()
  if (!ac || !noise) return
  const t = ac.currentTime
  const level = Math.min(1, speed / 0.5)
  for (const [f, d] of [[620, 0.16], [1530, 0.09]] as const) {
    const o = ac.createOscillator()
    o.type = 'triangle'
    o.frequency.value = f * (1 - 0.06 * level)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.03 + 0.15 * level, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + d)
    o.connect(g).connect(ac.destination)
    o.start(t)
    o.stop(t + d + 0.01)
  }
  const src = ac.createBufferSource()
  src.buffer = noise
  const bp = ac.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 2600
  const g = ac.createGain()
  g.gain.setValueAtTime(0.04 + 0.1 * level, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
  src.connect(bp).connect(g).connect(ac.destination)
  src.start(t)
  src.stop(t + 0.04)
}

/**
 * `seed` reshuffles the match (the director's draws and every robot's own
 * stream); 0, what the stage passes, is the page's one canonical match. The
 * tests play several to show nothing depends on one lucky path.
 */
export default async function create(ctx: SceneContext, seed = 0) {
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20)
  camera.position.copy(CAMERA)
  camera.lookAt(LOOK_AT)
  camera.updateMatrixWorld()

  // The page stacks the hero (its phone layout and phone poster) under this
  // query: the cast follows the same one, so the two never disagree.
  const wide = typeof window === 'undefined' || typeof window.matchMedia !== 'function' || !window.matchMedia(HERO_STACKED).matches
  const cast = castFor(wide)

  // ── The layout: camera scale, walls, keep-outs and the pitch ────────────

  /** The screen's edges (walls) and the page's text (keep-out boxes) on the floor. */
  const walls: Walls = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, keepOut: [] }
  const pitch: Pitch = { x0: -0.6, x1: 0.6, z0: -0.4, z1: 0.4, gz: 0, back: 0, keep: [] }
  /** Pitch centre and half-extents. */
  const P = { cx: 0, cz: 0, hx: 0.6, hz: 0.4 }
  let px = 611
  /** The slot size and heroKeepOut.version the layout was built for. */
  let layoutW = 0, layoutH = 0, layoutVersion = -1

  const caster = new THREE.Raycaster()
  const level = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const ndcAt = new THREE.Vector2()
  /** The point at height y under screen fraction (fx, fy), y down; null if that ray misses the plane. */
  const floorAt = (fx: number, fy: number, y: number) => {
    ndcAt.set(fx * 2 - 1, 1 - fy * 2)
    caster.setFromCamera(ndcAt, camera)
    level.constant = -y
    return caster.ray.intersectPlane(level, new THREE.Vector3())
  }
  /** Each corner of a screen rect at height y, mapped by f; null (drop the rect) if one misses the floor. */
  const cornersAt = (r: ScreenRect, y: number, f: (q: THREE.Vector3, fx: number, fy: number) => void) => {
    for (const [fx, fy] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]] as const) {
      const q = floorAt(fx, fy, y)
      if (!q) return false
      f(q, fx, fy)
    }
    return true
  }

  /**
   * Fit the camera to the slot and rebuild the walls, the base and the pitch.
   * A robot standing at a floor point is drawn reaching up the screen to
   * where a floor point `head * cot(el)` further back is drawn (toward the
   * camera's ground direction, turned by the azimuth): that is how far each
   * keep-out reaches out in front of its text, and how far the far wall
   * stands in from the top of the screen.
   */
  function layout(w: number, h: number, rects: readonly ScreenRect[]) {
    if (!(w > 0 && h > 0)) return
    px = Math.min(VIEW.perH * h, w / VIEW.minWidth)
    camera.left = -w / 2 / px
    camera.right = w / 2 / px
    camera.top = h / 2 / px
    camera.bottom = -h / 2 / px
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    const rise = KEEP.head * Math.cos(CAM_EL) / Math.sin(CAM_EL)
    const rx = rise * Math.sin(CAM_AZ), rz = rise * Math.cos(CAM_AZ)
    // The screen's corners on the floor: the walls are the screen.
    const tl = floorAt(0, 0, 0), tr = floorAt(1, 0, 0), bl = floorAt(0, 1, 0), br = floorAt(1, 1, 0)
    // (The camera looks down: every screen ray meets the floor. If one ever
    // did not, keep the layout there was rather than build one round a zero.)
    if (!tl || !tr || !bl || !br) return
    walls.minX = Math.min(tl.x, bl.x)
    walls.maxX = Math.max(tr.x, br.x)
    walls.minZ = Math.min(tl.z, tr.z)
    walls.maxZ = Math.max(bl.z, br.z) - KEEP.edge
    // The screen's own edges are slanted lines on the floor (the camera is
    // turned): each is a keep-out wedge beyond its line -- the left and right
    // pulled in by a margin, the top by a robot's height too (its head rises
    // straight up the screen, so the sides need no more).
    const wedge = (ax: number, az: number, bx: number, bz: number, ox: number, oz: number) => {
      const ex = (bx - ax) * 4, ez = (bz - az) * 4
      return keepOutOf([ax - ex, az - ez, bx + ex, bz + ez, bx + ex + ox * 6, bz + ez + oz * 6, ax - ex + ox * 6, az - ez + oz * 6])
    }
    const solid = (k: KeepOut | null): k is KeepOut => k !== null
    const e = KEEP.edge
    const screen = [
      wedge(tl.x + e, tl.z, bl.x + e, bl.z, -1, 0),
      wedge(tr.x - e, tr.z, br.x - e, br.z, 1, 0),
      wedge(tl.x + rx, tl.z + rz + e, tr.x + rx, tr.z + rz + e, 0, -1),
    ].filter(solid)
    // Each rect's corners on the floor, and again a robot's height in front;
    // padded all round; their convex hull is the keep-out (a slanted outline:
    // the camera is turned).
    walls.keepOut = rects.map((r) => {
      const pts: number[] = []
      const ok = cornersAt(r, 0, (q) => {
        for (const [x, z] of [[q.x, q.z], [q.x + rx, q.z + rz]] as const) {
          for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) pts.push(x + dx * KEEP.pad, z + (dz < 0 ? -KEEP.padBack : KEEP.pad))
        }
      })
      return ok ? keepOutOf(pts) : null
    })
      .filter(solid)
      // Only what reaches the floor the robots can stand on.
      .filter(b => b.maxX > walls.minX && b.minX < walls.maxX && b.maxZ > walls.minZ && b.minZ < walls.maxZ)
    walls.keepOut = [...walls.keepOut, ...screen]
    pitch.keep = walls.keepOut
    // The pitch: the largest free rectangle of floor (long preferred) -- the
    // goals at its two ends, half-way between the touchlines. The robots
    // range over all the free floor round it, past its lines. None at all
    // (the text over nearly everything): keep the pitch there was.
    const free = largestFree(walls, walls.keepOut!)
    if (!free) return
    pitch.x0 = free.minX + FIELD_FIT.inset
    pitch.x1 = free.maxX - FIELD_FIT.inset
    pitch.z0 = free.minZ + FIELD_FIT.inset
    pitch.z1 = free.maxZ - FIELD_FIT.inset
    pitch.gz = (pitch.z0 + pitch.z1) / 2
    // The strip behind each goal to the end of the free floor is filled (Pitch.back).
    pitch.back = FIELD_FIT.inset + 0.01
    Object.assign(P, pitchCentre(pitch))
  }

  const kd = { d: 0, e: 0 }
  /** Inside the walls by `m` and outside every keep-out by `m`. */
  function isFree(x: number, z: number, m: number) {
    if (x < walls.minX + m || x > walls.maxX - m || z < walls.minZ + m || z > walls.maxZ - m) return false
    for (const k of walls.keepOut!) if (keepOutDistance(k, x, z, kd).d < m) return false
    return true
  }

  /** The nearest point to p that is `m` clear of every wall and keep-out (in place). */
  function clampFree(p: THREE.Vector3, m = 0.1) {
    p.y = 0
    for (let pass = 0; pass < 4; pass++) {
      p.x = clamp(p.x, walls.minX + m, walls.maxX - m)
      p.z = clamp(p.z, walls.minZ + m, walls.maxZ - m)
      const k = walls.keepOut!.find(k => keepOutDistance(k, p.x, p.z, kd).d < m)
      if (!k) return p
      // Out through the edge it is least far inside.
      keepOutDistance(k, p.x, p.z, kd)
      const push = m - kd.d + 1e-3
      p.x += k.planes[kd.e]! * push
      p.z += k.planes[kd.e + 1]! * push
    }
    return p
  }

  // Rects the page (or the lab's ?keepout=) set before the scene was made count from the start.
  layoutW = ctx.width || 1440
  layoutH = ctx.height || 900
  layoutVersion = heroKeepOut.version
  layout(layoutW, layoutH, heroKeepOut.rects)

  const rand = rng(2027 + seed)
  const field = buildField()
  scene.add(field.mesh)
  /** What the drawn board depends on (to 0.1 mm): a relayout that leaves it alone keeps the meshes. */
  const boardSig = () => JSON.stringify(pitch, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e4) : v))
  let builtSig = boardSig()
  let pitchView = buildPitch(ctx.materials, pitch)
  scene.add(pitchView.group)
  // One robot per task: building a robot is the expensive part.
  const actors: Actor[] = []
  const at = new THREE.Vector3()
  /** Where a cast entry stands on the current pitch (a keeper: in its goal mouth). */
  const startOf = (e: CastEntry, out: THREE.Vector3) => (e.keeper
    ? out.set(e.at[0] < 0 ? pitch.x0 + GOAL.depth + 0.16 : pitch.x1 - GOAL.depth - 0.16, 0, P.cz)
    : out.set(P.cx + e.at[0] * P.hx, 0, P.cz + e.at[1] * P.hz))
  for (const [i, entry] of cast.entries()) {
    await nextTask()
    const robot = FACTORIES[entry.kind]!(ctx, { accent: entry.accent, seed: 101 + i * 17 + seed * 7919, posterMode: ctx.posterMode })
    clampFree(startOf(entry, at), robot.radius)
    robot.placeAt(at.x, at.z, entry.at[2])
    scene.add(robot.root)
    actors.push({
      robot, mode: 'play', team: entry.team, keeper: Boolean(entry.keeper), goal: at.clone(), until: 0, target: -1, look: new THREE.Vector3(), beat: -1,
      index: i, run: { phase: 'approach', t0: 0, x0: 0, z0: 0, dx: 1, dz: 0, plan: 0, touched: false, last: -Infinity, bold: false, ax: 0, az: 0 }, arrived: false,
      react: { t0: -Infinity, other: -1, x: 0, z: 0, resume: 'play' },
    })
  }
  const robots = actors.map(a => a.robot)
  const n = actors.length
  await nextTask()

  const ball = new Ball()
  ball.place(P.cx, P.cz)
  const props = buildProps(ctx.materials, ball, [])
  scene.add(props.group)
  /** Every body the contact solver sees: robots first (they get the contact skin), then the ball. */
  const bodies: Body[] = [...robots, ball]
  const solveOpts: ContactOptions = { ...CONTACT_OPTS, skinBodies: n, walls }
  /** Static obstacles: the pitch's (goal nets, cones), then any the page adds. */
  const extraObstacles: Obstacle[] = []
  const obstacles: Obstacle[] = []
  /**
   * The ones robots steer round (avoidance): the cones, the page's
   * own -- not the goals' nets. Nobody is sent into a goal, and a keeper's
   * spot in its mouth sits within a net post's personal space: steering
   * round them only froze keepers. The solver still keeps everyone out of them.
   */
  const steerObstacles: Obstacle[] = []
  const rebuildObstacles = () => {
    obstacles.length = 0
    obstacles.push(...fieldObstacles(pitch), ...extraObstacles)
    steerObstacles.length = 0
    steerObstacles.push(...obstacles.filter(o => o.r > GOAL.net + 1e-9 || extraObstacles.includes(o)))
  }
  rebuildObstacles()

  /**
   * The ball's last word after the contact solve. The solver pins a ball
   * that has given way, so robots squeezing it take the push -- but a body
   * cannot always move the whole way (a duck's swing foot re-aims only part
   * of a push, a planted sole not at all), and then the ball would be left
   * inside it. Here the ball alone is pushed out of every robot circle its
   * band meets, then out of the walls, the text and the obstacles, until
   * nothing moves it. If it still cannot fit -- caught between a foot and a
   * cone, say -- it pops up onto whatever holds it and drops back: a ball
   * squeezed out of a gap, never one sunk into a robot.
   */
  const SETTLE = { passes: 12, slop: 0.0005 }
  const settleN: Normal = { x: 0, z: 0 }
  const settleK = { d: 0, e: 0 }
  let pops = 0
  function pushBall(nx: number, nz: number, depth: number) {
    settleN.x = nx
    settleN.z = nz
    ball.collide(settleN, depth, 0, 'robot')
  }
  /** Is any robot part touching the ball (within 4 mm)? */
  function leaningOnBall() {
    for (const r of robots) {
      for (const c of r.colliders) if (c.r > 0 && Math.hypot(c.x - ball.x, c.z - ball.z) < c.r + BALL.r + 0.004) return true
    }
    return false
  }
  function settleBall() {
    const c = ball.colliders[0]!
    for (let it = 0; it < SETTLE.passes; it++) {
      let moved = false
      for (const r of robots) {
        for (const k of r.colliders) {
          if (k.r <= 0 || !bandsMeet(k, c)) continue
          const dx = ball.x - k.x, dz = ball.z - k.z, d = Math.hypot(dx, dz)
          const depth = k.r + BALL.r - d
          if (depth <= SETTLE.slop) continue
          if (d > 1e-9) pushBall(dx / d, dz / d, depth)
          else pushBall(1, 0, depth)
          moved = true
        }
      }
      for (const o of obstacles) {
        if (passesOver(c, o.h)) continue
        const dx = ball.x - o.x, dz = ball.z - o.z, d = Math.hypot(dx, dz)
        const depth = o.r + BALL.r - d
        if (depth <= 0) continue
        if (d > 1e-9) pushBall(dx / d, dz / d, depth)
        else pushBall(1, 0, depth)
        moved = true
      }
      if (!passesOver(c, walls.h)) {
        const x = clamp(ball.x, walls.minX + BALL.r, walls.maxX - BALL.r), z = clamp(ball.z, walls.minZ + BALL.r, walls.maxZ - BALL.r)
        if (x !== ball.x || z !== ball.z) {
          pushBall(Math.sign(x - ball.x), 0, Math.abs(x - ball.x))
          pushBall(0, Math.sign(z - ball.z), Math.abs(z - ball.z))
          moved = true
        }
      }
      for (const k of walls.keepOut ?? []) {
        keepOutDistance(k, ball.x, ball.z, settleK)
        if (settleK.d >= BALL.r) continue
        pushBall(k.planes[settleK.e]!, k.planes[settleK.e + 1]!, BALL.r - settleK.d)
        moved = true
      }
      if (!moved) return
    }
    // No room on the floor: up onto the highest part it is caught in (again
    // if, raised, it now meets something higher -- a body above a foot).
    for (let round = 0; round < 3; round++) {
      let top = 0
      for (const r of robots) {
        for (const k of r.colliders) {
          if (k.r <= 0 || !bandsMeet(k, c)) continue
          if (k.r + BALL.r - Math.hypot(ball.x - k.x, ball.z - k.z) > SETTLE.slop) top = Math.max(top, k.y1 ?? 0)
        }
      }
      if (top <= c.y0!) return
      pops++
      ball.pop(top)
    }
  }

  if (ctx.posterMode) {
    // Poster: the ball caught mid-roll between the two sides.
    ball.place(P.cx + 0.03, P.cz + 0.03)
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, 0.4, -0.6))
    ball.q[0] = q.x
    ball.q[1] = q.y
    ball.q[2] = q.z
    ball.q[3] = q.w
    props.step()
    props.step()
  }
  /** Until when each robot pair (i * n + j) is cooling down after a contact; per robot for obstacles. */
  const cool = new Float64Array(n * n)
  const coolStatic = new Float64Array(n)
  /** Last dust puff per pair (same layout), so a pushing contact does not smoke continuously. */
  const lastDust = new Float64Array(n * n + n).fill(-Infinity)
  // Puffs fade into the ground they rise from: the field yellow.
  const dust = new Dust(ctx.palette.ink, FIELD)
  scene.add(dust.lines)
  if (ctx.posterMode) {
    for (const a of actors) a.robot.lookAt(new THREE.Vector3(ball.x, BALL.r, ball.z))
  }

  // The laser dot's ground marker: a cyan ring and centre spot, unlit, on the floor.
  const markerMerged = new THREE.BufferGeometry()
  {
    const ring = new THREE.RingGeometry(0.03, 0.04, 40), spot = new THREE.CircleGeometry(0.01, 20)
    const a = ring.toNonIndexed(), b = spot.toNonIndexed()
    const pa = a.attributes.position!.array as Float32Array, pb = b.attributes.position!.array as Float32Array
    const all = new Float32Array(pa.length + pb.length)
    all.set(pa)
    all.set(pb, pa.length)
    markerMerged.setAttribute('position', new THREE.BufferAttribute(all, 3))
    markerMerged.rotateX(-Math.PI / 2)
    for (const g of [ring, spot, a, b]) g.dispose()
  }
  const markerMat = new THREE.MeshBasicMaterial({ color: ctx.palette.cyan, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })
  const marker = new THREE.Mesh(markerMerged, markerMat)
  marker.visible = false
  marker.renderOrder = 1
  scene.add(marker)

  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const hit = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const ballAt = new THREE.Vector3()
  /** The pointer: where it was last moved to (px), when (sim time), and whether its rest has fired. */
  const pointer = { active: false, x: 0, y: 0, ground: new THREE.Vector3(), movedAt: 0, rested: true, onFloor: false }
  const lookPreset = { index: -1, until: 0, point: new THREE.Vector3() }
  const cmd: RobotCommand = { speed: 0, yawRate: 0, strafe: 0 }
  /** Follow the leader (keyboard). */
  const chain = { kind: null as null | 'key', order: [] as number[], goal: new THREE.Vector3() }
  const egg = { name: null as Egg | null, t0: 0, until: 0, order: [] as number[] }
  /** The target: where (clamped clear of the walls), until when, when all have arrived, who goes. */
  const dot = { on: false, p: new THREE.Vector3(), until: 0, done: Infinity, chasers: [] as number[] }
  /** The game: pressers per team, goals, the celebration in progress, the last touch. */
  /** The shot in flight: which side defends, where it crosses the mouth, and whether the keeper reads it (seeded). */
  const shot = { team: -1 as -1 | Team, t: 0, z: 0, save: false }
  const game = { attack: 0 as Team, press: [-1, -1] as [number, number], goals: [0, 0] as [number, number], scorer: -1 as -1 | Team, t0: 0, until: 0, respotted: true, lastTouch: 0, touches: 0 }
  /** A contested ball: the two pressers, when, and when the next is due. */
  const clash = { a: -1, b: -1, t0: 0, next: 0, hit: false, count: 0 }
  clash.next = rand.range(CLASH.first[0]!, CLASH.first[1]!)
  /** The keyboard 'crash': who charges whom, until when. */
  const crash = { charger: -1, victim: -1, until: 0, hit: false, count: 0 }
  /** The mouse grab: which robot, and the height of the plane it is dragged on. */
  const grab = { i: -1, y: 0, cursor: '' }
  let selected = -1
  let time = 0
  let slotW = ctx.width || 1440
  let slotH = ctx.height || 900
  let paused = false
  let lastBump = -Infinity
  let lastTick = -Infinity
  /** The game runs by itself (tests switch it off to watch robots hold their places). */
  let auto = true
  /** Avoidance tables: robots then obstacles, AGENT_STRIDE numbers each; per-agent margins. */
  let agents = new Float64Array((n + 40) * AGENT_STRIDE)
  let margins = new Float64Array(n + 40)
  const steerOut: Steer = { x: 0, z: 0, slow: 1 }
  /** Test and lab hooks (null in production: no allocation). */
  const hooks: {
    react: null | ((i: number, other: number, t: number) => void)
    impact: null | ((i: number, j: number, speed: number, t: number) => void)
    command: null | ((i: number, c: RobotCommand) => void)
  } = { react: null, impact: null, command: null }

  /** The goal line a team attacks. */
  const attackX = (t: Team) => (t === 0 ? pitch.x1 : pitch.x0)
  const keeperOf = (t: Team) => actors.find(a => a.team === t && a.keeper)

  /**
   * A new layout (the slot resized, the page's text moved): rebuild the
   * walls, the pitch and its obstacles; anyone the change left inside a wall
   * is lifted out to the nearest free spot, and so is the ball.
   */
  /** Is the slot point (x, y) px over any of the page's text rects? */
  function overText(x: number, y: number) {
    const fx = x / slotW, fy = y / slotH
    for (const r of heroKeepOut.rects) if (fx >= r.x0 && fx <= r.x1 && fy >= r.y0 && fy <= r.y1) return true
    return false
  }

  function relayout(w: number, h: number) {
    layoutW = w
    layoutH = h
    layoutVersion = heroKeepOut.version
    layout(w, h, heroKeepOut.rects)
    // The drawn board, only if what it shows changed (a resize that moves
    // nothing on the floor, or text that moved within its plinth, keeps it).
    const sig = boardSig()
    if (sig !== builtSig) {
      builtSig = sig
      pitchView.dispose()
      pitchView = buildPitch(ctx.materials, pitch)
      scene.add(pitchView.group)
    }
    rebuildObstacles()
    for (const a of actors) {
      const r = a.robot
      if (!isFree(r.position.x, r.position.z, r.radius * 0.8)) {
        clampFree(tmp.copy(r.position), r.radius)
        r.placeAt(tmp.x, tmp.z, r.heading)
      }
      a.run.plan = 0
    }
    if (!isFree(ball.x, ball.z, BALL.r)) {
      clampFree(tmp.set(ball.x, 0, ball.z), BALL.r + 0.02)
      ball.place(tmp.x, tmp.z)
    }
  }

  /** Pack every robot's ground position, velocity and footprint, then the obstacles, then the ball. */
  function packAgents() {
    const m = n + steerObstacles.length + 1
    if (agents.length < m * AGENT_STRIDE) {
      agents = new Float64Array((m + 8) * AGENT_STRIDE)
      margins = new Float64Array(m + 8)
    }
    for (let i = 0; i < n; i++) {
      const r = actors[i]!.robot
      const c0 = r.colliders[0]!, c1 = r.colliders[1]!
      const o = i * AGENT_STRIDE
      agents[o] = r.position.x
      agents[o + 1] = r.position.z
      // Mean of the first two circles: a balancer turning on the spot is not moving.
      agents[o + 2] = (c0.vx + c1.vx) / 2
      agents[o + 3] = (c0.vz + c1.vz) / 2
      agents[o + 4] = r.radius
      if (r.fallen) {
        // Lying, a robot reaches a body length along the floor, not its
        // standing footprint: steer round all of it (every bump starts its
        // get-up over), as a circle round its contact circles.
        let cx = 0, cz = 0, cn = 0
        for (const c of r.colliders) {
          if (c.r <= 0) continue
          cx += c.x
          cz += c.z
          cn++
        }
        if (cn > 0) {
          cx /= cn
          cz /= cn
          let rr = r.radius
          for (const c of r.colliders) if (c.r > 0) rr = Math.max(rr, Math.hypot(c.x - cx, c.z - cz) + c.r)
          agents[o] = cx
          agents[o + 1] = cz
          agents[o + 4] = rr
        }
      }
    }
    for (let k = 0; k < steerObstacles.length; k++) {
      const ob = steerObstacles[k]!
      const o = (n + k) * AGENT_STRIDE
      agents[o] = ob.x
      agents[o + 1] = ob.z
      agents[o + 2] = 0
      agents[o + 3] = 0
      agents[o + 4] = ob.r
    }
    // The ball: walked round on the way to it, so a robot on the wrong side
    // does not push it back toward its own goal on the way.
    const o = (n + steerObstacles.length) * AGENT_STRIDE
    agents[o] = ball.x
    agents[o + 1] = ball.z
    agents[o + 2] = ball.vx
    agents[o + 3] = ball.vz
    agents[o + 4] = BALL.r
  }

  /** In a game role (not a routine, an egg, a reaction or held). */
  const playing = (a: Actor) => a.mode === 'play'

  /**
   * Turn toward the goal, roll only once roughly facing it, slow on the
   * approach -- bending round and braking for anyone in the way (avoid.ts).
   * The goal is first moved clear of the walls and the page's text.
   * `ahead`: the robot being trailed in a chain, kept at its chain gap.
   */
  function steer(a: Actor, maxSpeed: number, arrive = 0.04, ahead = -1, boost = false) {
    const r = a.robot
    clampFree(a.goal, r.radius * 0.8)
    const dx = a.goal.x - r.position.x
    const dz = a.goal.z - r.position.z
    const d = Math.hypot(dx, dz)
    if (d < arrive) return true
    const want = Math.min(maxSpeed, boost && r.kind === 'balancer' ? 0.45 : r.maxSpeed, 0.8 * d + 0.03)
    const i = a.index
    // Its own stopping distance at its current speed: a wheel-leg needs ~10 cm
    // to stop from full speed (its controller leans back first), a duck less.
    const sv = Math.hypot(agents[i * AGENT_STRIDE + 2]!, agents[i * AGENT_STRIDE + 3]!)
    const stop = sv * sv / (2 * (r.kind === 'balancer' ? 0.3 : 0.5))
    // Contesting the ball (pressing, a keyboard kick, a keeper's clearance), a
    // field player may come close to another -- but not touch: contact is the
    // clash's job, and a bump costs both a reaction. Otherwise it keeps its distance.
    const contest = a.mode === 'kick' || a.mode === 'clear' || (a.mode === 'play' && game.press[a.team] === i)
    for (let j = 0; j < n; j++) {
      const o = actors[j]!
      const inGame = a.mode === 'play' || a.mode === 'kick' || a.mode === 'clear' || a.mode === 'dot'
      // Wide of anyone lying on the floor: every bump starts its get-up over.
      margins[j] = (j === ahead ? CHAIN_GAP - 0.03 : o.robot.fallen ? PERSONAL.fallen : a.mode === 'egg' || o.mode === 'egg' ? PERSONAL.egg : inGame ? (o.keeper ? 0.06 : PERSONAL.play) : PERSONAL.margin)
        + (time < cool[i < j ? i * n + j : j * n + i]! ? PERSONAL.cooling : 0) + (j === ahead ? 0 : stop)
    }
    for (let k = 0; k < steerObstacles.length; k++) margins[n + k] = PERSONAL.obstacle * (contest ? 0.4 : 1) + (time < coolStatic[i]! ? PERSONAL.cooling : 0)
    // The ball: walked round by everyone except whoever is playing it.
    margins[n + steerObstacles.length] = strikeOf(a) > 0 ? -r.radius : 0.03
    avoid(i, dx / d, dz / d, want, agents, n + steerObstacles.length + 1, margins, steerOut, -1, d / Math.max(want, 0.05))
    const err = wrap(Math.atan2(steerOut.x, steerOut.z) - r.heading)
    cmd.yawRate = clamp(3 * err, -1.6, 1.6)
    const facing = Math.max(0, Math.cos(err))
    cmd.speed = want * facing ** 3 * steerOut.slow
    cmd.boost = boost
    return false
  }

  function face(a: Actor, point: THREE.Vector3) {
    const err = wrap(Math.atan2(point.x - a.robot.position.x, point.z - a.robot.position.z) - a.robot.heading)
    cmd.yawRate = Math.abs(err) > 0.1 ? clamp(2.5 * err, -1.4, 1.4) : 0
  }

  /** Straight at a point, flat out for its kind, no avoidance: a tackle, a charge, a strike. */
  function sprintAt(a: Actor, x: number, z: number, speed: number) {
    const r = a.robot
    const err = wrap(Math.atan2(x - r.position.x, z - r.position.z) - r.heading)
    cmd.yawRate = clamp(3.5 * err, -1.8, 1.8)
    cmd.speed = speed * Math.max(0, Math.cos(err)) ** 2
    cmd.boost = true
  }

  // ── Running at the ball ────────────────────────────────────────────────

  /**
   * The direction to play the ball: toward (ax, az), turned (by as little as
   * possible) until the run-up spot behind the ball is free floor and nobody
   * stands on it, so a ball against a wall is played along it, not into it.
   */
  function planRun(a: Actor, ax: number, az: number) {
    const r = a.robot
    const back = REACH[r.kind] + BALL.r + PLAY.runUp
    const base = Math.atan2(ax - ball.x, az - ball.z)
    for (const turn of [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2, -2]) {
      const ang = base + turn
      const dx = Math.sin(ang), dz = Math.cos(ang)
      const bx = ball.x - dx * back, bz = ball.z - dz * back
      if (!isFree(bx, bz, r.radius * 0.5)) continue
      let blocked = false
      for (let j = 0; j < n && !blocked; j++) {
        if (j === a.index) continue
        const o = actors[j]!.robot.position
        if (Math.hypot(o.x - bx, o.z - bz) < actors[j]!.robot.radius + r.radius * 0.6) blocked = true
      }
      if (blocked && turn !== 2 && turn !== -2) continue
      a.run.dx = dx
      a.run.dz = dz
      return
    }
  }

  function startRun(a: Actor) {
    a.run.phase = 'approach'
    a.run.t0 = time
    a.run.plan = 0
    a.run.touched = false
  }

  /**
   * Play the ball toward (ax, az): run straight at it (so it arrives facing
   * it), and when its
   * striking point (REACH) or its body meets the ball, the ball leaves along
   * the line at `strike` m/s (Ball.strike; body contacts via onImpact). The
   * line is the director's, not the robot's heading: a slow walker that
   * reaches the ball at an angle still plays it on (a flick). Returns true
   * once it has struck.
   */
  function runAt(a: Actor, ax: number, az: number, strike: number) {
    const r = a.robot
    const run = a.run
    if (run.touched) return true
    // Just struck: watch it go before going again (a ball against a wall
    // would otherwise be struck every step).
    if (time - run.last < 0.5) {
      face(a, ballAt)
      return false
    }
    run.ax = ax
    run.az = az
    if (time >= run.plan) {
      planRun(a, ax, az)
      run.plan = time + 0.4
    }
    const fx = r.position.x + Math.sin(r.heading) * REACH[r.kind], fz = r.position.z + Math.cos(r.heading) * REACH[r.kind]
    if (Math.hypot(ball.x - fx, ball.z - fz) < BALL.r + 0.03) {
      strikeBy(a, strike)
      return true
    }
    // Round behind the ball first (to the run-up spot on the line), unless it
    // already is behind it; then the last run straight at it.
    const rel = (r.position.x - ball.x) * run.dx + (r.position.z - ball.z) * run.dz
    const off = Math.abs((r.position.x - ball.x) * run.dz - (r.position.z - ball.z) * run.dx)
    const back = REACH[r.kind] + BALL.r + 0.08
    if (run.phase === 'approach' && !(rel < -0.02 && off < 0.07 + -rel * 0.4)) {
      a.goal.set(ball.x - run.dx * back, 0, ball.z - run.dz * back)
      if (steer(a, strike >= PLAY.clear ? 0.35 : 0.25, 0.06, -1, true) || Math.hypot(a.goal.x - r.position.x, a.goal.z - r.position.z) < 0.1) run.phase = 'dash'
      return false
    }
    run.phase = 'dash'
    if (rel > 0.05) run.phase = 'approach'
    a.goal.set(ball.x, 0, ball.z)
    const d = Math.hypot(ball.x - r.position.x, ball.z - r.position.z)
    // The last stretch is straight at it: avoidance near a crowded ball bends
    // a player one way and then the other and it circles for ever. The
    // contact solver keeps it off the others; a brush only turns heads.
    // ...but not at a ball at a keeper's feet or by someone lying on the
    // floor (walk round them, do not flatten them -- a fallen robot bumped
    // starts its get-up over), and not through anyone standing on the way
    // (it would lean on them for ever): then it steers round.
    // (Each other robot as packAgents sized it: a lying one by its whole body.)
    const sx = ball.x - r.position.x, sz = ball.z - r.position.z, s2 = sx * sx + sz * sz || 1
    let byKeeper = false, blocked = false
    for (let k = 0; k < n; k++) {
      const o = actors[k]!
      if (o === a) continue
      const ox = agents[k * AGENT_STRIDE]!, oz = agents[k * AGENT_STRIDE + 1]!, or = agents[k * AGENT_STRIDE + 4]!
      if ((o.keeper || o.robot.fallen) && Math.hypot(ox - ball.x, oz - ball.z) < or + 0.15) byKeeper = true
      const t = clamp(((ox - r.position.x) * sx + (oz - r.position.z) * sz) / s2, 0, 1)
      if (Math.hypot(ox - r.position.x - sx * t, oz - r.position.z - sz * t) < or + r.radius * 0.7) blocked = true
    }
    if (d < 0.45 && !byKeeper && !blocked) {
      const err = wrap(Math.atan2(ball.x - r.position.x, ball.z - r.position.z) - r.heading)
      cmd.yawRate = clamp(3 * err, -1.8, 1.8)
      cmd.speed = Math.min(r.kind === 'balancer' ? 0.35 : r.maxSpeed, 0.8 * d + 0.06) * Math.max(0, Math.cos(err)) ** 2
      cmd.boost = true
    }
    else {
      steer(a, strike >= PLAY.clear ? 0.35 : 0.25, 0, -1, true)
    }
    return false
  }

  /**
   * The strike: the ball leaves along the robot's planned line at `strike`
   * m/s. A shot or a clearance hands the ball over: the other side collects a
   * shot (saved or wide), the keeper's side plays out of a clearance.
   */
  function strikeBy(a: Actor, strike: number) {
    const run = a.run
    // Aimed from where the ball is now (the run's line was planned a moment ago).
    const lx = run.ax - ball.x, lz = run.az - ball.z, ll = Math.hypot(lx, lz)
    if (ll > 0.05 && (run.ax !== 0 || run.az !== 0)) {
      run.dx = lx / ll
      run.dz = lz / ll
    }
    // Never back through the striker: a touch from its side or back sends the
    // ball out away from it, bent toward the line.
    const r = a.robot
    const ox = ball.x - r.position.x, oz = ball.z - r.position.z
    const ol = Math.hypot(ox, oz) || 1
    const out = (run.dx * ox + run.dz * oz) / ol
    if (out < 0.3) ball.strike(ox / ol + run.dx * 0.6, oz / ol + run.dz * 0.6, strike * 0.6)
    else ball.strike(run.dx, run.dz, strike)
    run.touched = true
    run.last = time
    game.touches++
    game.lastTouch = time
    if (a.mode === 'clear') game.attack = a.team
    // A shot is struck from behind the ball. A touch from the side squirts
    // off at walking pace: no shot, the striker keeps the ball (it used to
    // hand it over and send the keeper diving at a ball going nowhere).
    else if (strike >= PLAY.shot && out >= 0.3) {
      const def: Team = a.team === 0 ? 1 : 0
      game.attack = def
      // The keeper guesses: it reads it, or it commits the wrong way.
      const mouth = attackX(a.team) - Math.sign(attackX(a.team) - P.cx) * GOAL.depth
      const vx = ball.vx, vz = ball.vz
      shot.team = def
      shot.t = time
      shot.z = Math.abs(vx) > 1e-3 ? ball.z + vz / vx * (mouth - ball.x) : ball.z
      shot.save = rand.next() < 0.35
    }
    playTick(strike)
  }

  /** The strike a robot on the ball makes now (0: it is not playing the ball). */
  function strikeOf(a: Actor) {
    if (a.mode === 'clear') return PLAY.clear
    if (a.mode === 'kick') return PLAY.shot
    if (a.mode === 'play' && !a.keeper && game.press[a.team] === a.index && a.team === game.attack) return shooting(a) ? PLAY.shot : PLAY.dribble
    return 0
  }

  /** Nobody but the keeper within a body of the line from the ball to (x, z). */
  function laneClear(a: Actor, x: number, z: number) {
    const lx = x - ball.x, lz = z - ball.z, l2 = lx * lx + lz * lz || 1
    for (const o of actors) {
      if (o === a || o.keeper) continue
      const p = o.robot.position
      const t = clamp(((p.x - ball.x) * lx + (p.z - ball.z) * lz) / l2, 0, 1)
      if (Math.hypot(p.x - ball.x - lx * t, p.z - ball.z - lz * t) < o.robot.radius * 0.8 + BALL.r) return false
    }
    return true
  }

  /** In range of the goal it attacks. */
  const shooting = (a: Actor) => Math.abs(attackX(a.team) - ball.x) < PLAY.range + GOAL.depth

  // ── The game ──────────────────────────────────────────────────────────

  /**
   * Each team's presser: its field player first to the ball (distance over
   * its own top speed -- the dog presses, Makey supports, unless Makey is
   * right there), sticky by 0.4 s so two do not swap back and forth.
   */
  function pickPressers() {
    for (const t of [0, 1] as const) {
      let best = -1, bd = Infinity
      for (let k = 0; k < n; k++) {
        const a = actors[k]!
        if (a.team !== t || a.keeper || !playing(a) || a.robot.busy) continue
        let d = Math.hypot(a.robot.position.x - ball.x, a.robot.position.z - ball.z) / a.robot.maxSpeed
        if (k === game.press[t]) d -= 0.4
        if (d < bd) {
          bd = d
          best = k
        }
      }
      if (best !== game.press[t] && best >= 0) startRun(actors[best]!)
      game.press[t] = best
    }
  }

  /** The presser: dribble toward the other goal, shoot once in range, aiming away from the keeper. */
  function pressPlay(a: Actor) {
    const ax = attackX(a.team)
    const k = keeperOf(a.team === 0 ? 1 : 0)
    const side = k ? (k.robot.position.z > P.cz ? -1 : 1) : (ball.z >= P.cz ? 1 : -1)
    const tz = P.cz + side * (GOAL.half - 0.045)
    // Shoot in range with a clear lane (the keeper aside); else dribble on.
    const shot = shooting(a) && laneClear(a, ax, tz)
    const az = shot ? tz : P.cz + side * (GOAL.half - 0.045) * 0.4
    if (runAt(a, ax, az, shot ? PLAY.shot : PLAY.dribble)) startRun(a)
  }

  /**
   * The marker (the presser of the side without the ball): goal-side of the
   * ball but well off the line to goal -- shadowing, not blocking (a marker
   * on the line would stop every shot dead) -- facing the ball. It does not
   * touch it: going in is the clash.
   */
  function markPlay(a: Actor) {
    const own = attackX(a.team === 0 ? 1 : 0)
    const gx = own - ball.x, gz = P.cz - ball.z
    const l = Math.hypot(gx, gz) || 1
    // The side of the line nearer the middle of the pitch. When a clash is
    // due it closes in on the ball, to go in for it.
    const side = ball.z >= P.cz ? 1 : -1
    const due = time > clash.next && clash.a < 0 && Math.abs(ball.x - P.cx) < P.hx - GOAL.depth - 0.15
    const back = due ? 0.12 : 0.2, across = due ? 0.1 : 0.24
    a.goal.set(ball.x + gx / l * back + gz / l * across * side, 0, ball.z + gz / l * back - gx / l * across * side)
    if (steer(a, 0.2, 0.05)) face(a, ballAt)
  }

  /**
   * The support: a spot off the ball, on the other side of the pitch from its
   * own presser (so the two never cross) and nearer the goal it attacks;
   * watches the ball.
   */
  function supportPlay(a: Actor) {
    const s = Math.sign(attackX(a.team) - P.cx)
    const mate = actors[game.press[a.team]]
    const ref = mate ? mate.robot.position.z : ball.z
    a.goal.set(clamp(P.cx + (ball.x - P.cx) * 0.6 + s * 0.12, pitch.x0 + 0.2, pitch.x1 - 0.2), 0, P.cz + (ref > P.cz ? -1 : 1) * P.hz * 0.6)
    if (steer(a, 0.14, 0.06)) face(a, ballAt)
  }

  /** The keeper: on its line, sliding with the ball; a slow ball in its box gets cleared. */
  function keeperPlay(a: Actor) {
    const own = attackX(a.team === 0 ? 1 : 0)
    const s = Math.sign(P.cx - own)
    const inBox = Math.abs(ball.x - own) < 0.32 && Math.abs(ball.z - P.cz) < GOAL.half + 0.12
    if (inBox && ball.speed < 0.25 && !a.robot.busy) {
      a.mode = 'clear'
      a.until = time + 3.5
      startRun(a)
      return
    }
    // A shot on its goal: it goes for where the ball will cross the mouth --
    // or, guessing wrong, for the other side (seeded at the strike). Else it
    // covers the middle and follows the ball only part way.
    const diving = shot.team === a.team && time - shot.t < 1.2
    const z = diving
      ? (shot.save ? clamp(shot.z, P.cz - GOAL.half + 0.09, P.cz + GOAL.half - 0.09) : P.cz - Math.sign(shot.z - P.cz || 1) * (GOAL.half - 0.09))
      : P.cz + clamp((ball.z - P.cz) * 0.25, -(GOAL.half - 0.15), GOAL.half - 0.15)
    a.goal.set(own + s * (GOAL.depth + 0.16), 0, z)
    if (steer(a, diving ? Math.min(a.robot.maxSpeed, 0.14) : 0.08, 0.02)) face(a, ballAt)
  }

  function directClear(a: Actor) {
    const own = attackX(a.team === 0 ? 1 : 0)
    // Out toward the wing on the ball's side, away from the goal.
    const done = runAt(a, own + Math.sign(P.cx - own) * 0.5, ball.z >= P.cz ? pitch.z1 : pitch.z0, PLAY.clear)
    if (done || time > a.until || Math.abs(ball.x - own) > 0.45) a.mode = 'play'
  }

  /** Past a goal's mouth, between its posts: a goal for the team attacking that end. */
  function checkGoal() {
    if (game.scorer >= 0 || ctx.posterMode) return
    if (Math.abs(ball.z - P.cz) > GOAL.half - BALL.r * 0.5) return
    const inRight = ball.x > pitch.x1 - GOAL.depth + BALL.r * 0.3, inLeft = ball.x < pitch.x0 + GOAL.depth - BALL.r * 0.3
    if (!inRight && !inLeft) return
    const scorer: Team = inRight ? 0 : 1
    game.goals[scorer]++
    game.attack = scorer === 0 ? 1 : 0
    game.scorer = scorer
    game.t0 = time
    game.until = time + PLAY.celebrate
    game.respotted = false
    endClash()
    for (const a of actors) {
      a.beat = -1
      if (a.mode === 'play' || a.mode === 'clear' || a.mode === 'kick' || a.mode === 'tackle') a.mode = 'celebrate'
    }
  }

  /**
   * Behind a goal line but not in the goal: out. A goal kick -- the ball is
   * placed in front of that end's keeper box, and the keeper clears it.
   */
  function checkOut() {
    if (game.scorer >= 0) return
    const right = ball.x > pitch.x1 - GOAL.depth + BALL.r * 0.3, left = ball.x < pitch.x0 + GOAL.depth - BALL.r * 0.3
    if (!right && !left) return
    if (Math.abs(ball.z - P.cz) < GOAL.half - BALL.r * 0.5) return
    const x = right ? pitch.x1 - CONE.off - 0.05 : pitch.x0 + CONE.off + 0.05
    // The side defending that end plays it out.
    game.attack = right ? 1 : 0
    ball.place(x, P.cz + (ball.z >= P.cz ? 1 : -1) * 0.1)
    game.lastTouch = time
    dust.puff(ball.x, ball.z, 0.2, time)
    playTick(0.3)
  }

  /** Per step: re-spot the ball, end the celebration. */
  function updateCelebration() {
    if (game.scorer < 0) return
    if (!game.respotted && time > game.t0 + PLAY.respot) {
      game.respotted = true
      respot()
    }
    if (time > game.until) {
      game.scorer = -1
      for (const a of actors) if (a.mode === 'celebrate') a.mode = 'play'
    }
  }

  function respot() {
    ball.place(P.cx, P.cz)
    game.lastTouch = time
    dust.puff(P.cx, P.cz, 0.25, time)
    playTick(0.3)
    for (const a of actors) startRun(a)
  }

  /** Scorers celebrate in their own way, once each, to the crowd; the others watch the ball. */
  function directCelebrate(a: Actor) {
    const r = a.robot
    const t = time - game.t0
    if (a.team !== game.scorer) {
      face(a, ballAt)
      return
    }
    if (a.beat < 0 && t > 0.2 + 0.15 * a.index) {
      a.beat = 1
      if (r.kind === 'makey') r.wave?.(0)
      else r.react('tap')
    }
    face(a, CAMERA)
  }

  // ── Clashes ───────────────────────────────────────────────────────────

  function startClash() {
    const p0 = game.press[0], p1 = game.press[1]
    if (p0 < 0 || p1 < 0 || actors[p0]!.robot.busy || actors[p1]!.robot.busy) return false
    // Both close enough to the ball to meet there.
    for (const k of [p0, p1]) if (Math.hypot(actors[k]!.robot.position.x - ball.x, actors[k]!.robot.position.z - ball.z) > CLASH.near) return false
    clash.a = p0
    clash.b = p1
    clash.t0 = time
    clash.hit = false
    actors[p0]!.mode = 'tackle'
    actors[p1]!.mode = 'tackle'
    return true
  }

  function endClash() {
    for (const k of [clash.a, clash.b]) {
      const a = actors[k]
      if (a && a.mode === 'tackle') a.mode = 'play'
    }
    if (clash.a >= 0) clash.next = time + rand.range(CLASH.gap[0]!, CLASH.gap[1]!)
    clash.a = clash.b = -1
  }

  /** Both go flat out for the ball, then for each other: whoever arrives second hits the first. */
  function directTackle(a: Actor) {
    const other = actors[a.index === clash.a ? clash.b : clash.a]!
    if (time - clash.t0 > CLASH.time || other.robot.busy) {
      endClash()
      return
    }
    const r = a.robot
    const nearBall = Math.hypot(r.position.x - ball.x, r.position.z - ball.z) < r.radius + 0.12
    const tx = nearBall ? other.robot.position.x : ball.x, tz = nearBall ? other.robot.position.z : ball.z
    sprintAt(a, tx, tz, r.kind === 'balancer' ? 0.5 : r.maxSpeed)
  }

  // ── The laser dot ─────────────────────────────────────────────────────

  /** A target: the nearest robot(s) free to go are sent; everyone else plays on. */
  function dotOn(p: THREE.Vector3) {
    dotOff()
    dot.on = true
    // Over the text the target sits at the text's wall: as close as a robot may come.
    clampFree(dot.p.copy(p), 0.06)
    dot.until = time + DOT.life
    dot.done = Infinity
    const free = actors.filter(a => !a.robot.busy && (a.mode === 'play' || a.mode === 'celebrate'))
    free.sort((q, r) => q.robot.position.distanceTo(dot.p) - r.robot.position.distanceTo(dot.p))
    dot.chasers = free.slice(0, n > 2 ? DOT.chasers : 1).map(a => a.index)
    if (dot.chasers.includes(clash.a) || dot.chasers.includes(clash.b)) endClash()
    for (const i of dot.chasers) {
      const a = actors[i]!
      a.mode = 'dot'
      a.arrived = false
    }
  }

  function dotOff() {
    if (!dot.on) return
    dot.on = false
    for (const i of dot.chasers) {
      const a = actors[i]!
      if (a.mode === 'dot') {
        a.mode = 'play'
        startRun(a)
      }
      a.arrived = false
    }
    dot.chasers.length = 0
  }

  /** The target lasts until all have arrived (and lingered a moment) or its time is up. */
  function updateDot() {
    if (dot.on && (time > dot.until || time > dot.done)) dotOff()
  }

  function directDot(a: Actor) {
    const r = a.robot
    a.goal.copy(dot.p)
    const arrive = r.radius * 0.6 + 0.02
    if (steer(a, r.maxSpeed, arrive, -1, true)) {
      face(a, dot.p)
      if (!a.arrived) {
        a.arrived = true
        r.wave?.(0)
        if (dot.chasers.every(i => actors[i]!.arrived)) dot.done = time + DOT.linger
      }
    }
  }

  // ── Keyboard follow (chain) ──────────────────────────────────────────

  /** Chain order from a leader: each next link is the nearest robot not yet in it. */
  function chainFrom(leader: number) {
    const order = [leader]
    const left = actors.map((_, i) => i).filter(i => i !== leader)
    while (left.length) {
      const last = actors[order[order.length - 1]!]!.robot.position
      let best = 0
      for (let k = 1; k < left.length; k++) {
        if (actors[left[k]!]!.robot.position.distanceTo(last) < actors[left[best]!]!.robot.position.distanceTo(last)) best = k
      }
      order.push(left.splice(best, 1)[0]!)
    }
    return order
  }

  function startChain(leader: number) {
    chain.kind = 'key'
    chain.order = chainFrom(leader)
    chain.order.forEach((idx, k) => {
      const a = actors[idx]!
      a.target = k === 0 ? -1 : chain.order[k - 1]!
      if (a.mode !== 'called') a.mode = 'chain'
    })
  }

  function endChain() {
    if (!chain.kind) return
    chain.kind = null
    for (const a of actors) if (a.mode === 'chain') a.mode = 'play'
  }

  /**
   * The point behind the robot ahead, one footprint gap back along its
   * heading, approached like a car following another: the leader's own speed
   * plus a term that closes the gap error.
   */
  function trail(a: Actor, ahead: Actor, maxSpeed: number) {
    const o = ahead.robot
    const gap = a.robot.radius + o.radius + CHAIN_GAP
    a.goal.set(o.position.x - Math.sin(o.heading) * gap, 0, o.position.z - Math.cos(o.heading) * gap)
    const dx = o.position.x - a.robot.position.x
    const dz = o.position.z - a.robot.position.z
    const d = Math.hypot(dx, dz)
    const q = ahead.index * AGENT_STRIDE
    const vAhead = d > 1e-6 ? (agents[q + 2]! * dx + agents[q + 3]! * dz) / d : 0
    const v = clamp(vAhead + 1.2 * (d - gap), 0, maxSpeed)
    if (steer(a, v, 0.04, ahead.index)) face(a, o.position)
  }

  // ── Easter eggs ─────────────────────────────────────────────────────────

  function startEgg(name: Egg) {
    endEgg(false)
    endChain()
    endClash()
    egg.name = name
    egg.t0 = time
    egg.until = time + EGG_S[name]
    for (const a of actors) {
      a.mode = 'egg'
      a.beat = -1
    }
    if (name === 'line-up') {
      // One row for up to four; five or more stand in two rows. The ones
      // furthest back take the back row; each row's slots go left to right in
      // the order they already stand -- so nobody has to cross anybody.
      const m = actors.length
      const front = m > 4 ? Math.ceil(m / 2) : m
      const byDepth = actors.map((_, i) => i).sort((p, q) => actors[p]!.robot.position.z - actors[q]!.robot.position.z)
      const rows = [byDepth.slice(m - front), byDepth.slice(0, m - front)]
      // Where they are: the rows stand round the robots' own middle (on the
      // pitch), not its centre -- on a pitch the size of the screen the walk
      // there would outlast the routine.
      let mx = 0, mz = 0
      for (const a of actors) {
        mx += a.robot.position.x / m
        mz += a.robot.position.z / m
      }
      const lx = clamp(mx, pitch.x0 + LINE.half + 0.2, pitch.x1 - LINE.half - 0.2)
      const lz = clamp(mz, pitch.z0 + LINE.gap + 0.1, pitch.z1 - LINE.z - 0.1)
      egg.order = []
      rows.forEach((members, row) => {
        members.sort((p, q) => actors[p]!.robot.position.x - actors[q]!.robot.position.x)
        const cnt = members.length
        const half = Math.min(LINE.half, P.hx - 0.15) * (cnt - 1) / Math.max(1, front - 1)
        // (A back row of one fewer, spread over a narrower span, stands in the front row's gaps.)
        members.forEach((idx, slot) => {
          const x = lx + (cnt > 1 ? -half + 2 * half * slot / (cnt - 1) : 0)
          const g = actors[idx]!.goal.set(x, 0, lz + (row === 0 ? LINE.z : LINE.z - LINE.gap))
          // Clear of the goals' nets and the cones: a slot inside one's personal space is never reached.
          for (const ob of obstacles) {
            const ox = g.x - ob.x, oz = g.z - ob.z, od = Math.hypot(ox, oz), need = ob.r + actors[idx]!.robot.radius + PERSONAL.egg + 0.01
            if (od < need && od > 1e-6) g.set(ob.x + ox / od * need, 0, ob.z + oz / od * need)
          }
          egg.order.push(idx)
        })
      })
    }
    if (name === 'conga') {
      egg.order = chainFrom(selected >= 0 ? selected : 0)
      egg.order.forEach((idx, k) => {
        actors[idx]!.target = k === 0 ? -1 : egg.order[k - 1]!
      })
    }
    if (name === 'sleep') for (const a of actors) a.robot.setSleep(true)
  }

  /** Back to the game. */
  function endEgg(back = true) {
    if (!egg.name) return
    const was = egg.name
    egg.name = null
    for (const a of actors) {
      if (was === 'sleep') a.robot.setSleep(false)
      if (was === 'party') a.robot.setAccent(null)
      if (back && a.mode === 'egg') {
        a.mode = 'play'
        startRun(a)
      }
      if (a.mode === 'react' && a.react.resume === 'egg') a.react.resume = 'play'
    }
  }

  function directEgg(a: Actor, i: number) {
    const t = time - egg.t0
    const r = a.robot
    switch (egg.name) {
      case 'dance':
      case 'party': {
        // 120 bpm, four bars of four. Walkers: side-step left, hop, side-step
        // right, hop. Wheel-legs: rock on the beat, spin, rock, spin back.
        const b = Math.floor(t / BEAT)
        const bar = Math.floor(b / 4) % 4
        const onBeat = b !== a.beat
        a.beat = b
        if (egg.name === 'party' && onBeat) r.setAccent(PARTY[(b + i) % PARTY.length]!)
        if (r.kind === 'duck') {
          if (bar === 0) cmd.strafe = 0.07
          else if (bar === 2) cmd.strafe = -0.07
          else if (onBeat && b % 4 === 0) r.react('tap')
        }
        else if (bar === 0 || bar === 2) {
          cmd.speed = b % 2 === 0 ? 0.18 : -0.18
        }
        else {
          cmd.yawRate = bar === 1 ? 2 : -2
        }
        return
      }
      case 'line-up': {
        if (steer(a, 0.2, 0.03) || t > LINE.bowAt) face(a, CAMERA)
        return
      }
      case 'conga': {
        if (a.target < 0) {
          // The leader walks an ellipse round the pitch, aiming a little ahead of itself.
          const rx = P.hx * CONGA.rx, rz = P.hz * CONGA.rz
          const phi = Math.atan2((r.position.z - P.cz) / rz, (r.position.x - P.cx) / rx) + CONGA.lead
          a.goal.set(P.cx + rx * Math.cos(phi), 0, P.cz + rz * Math.sin(phi))
          steer(a, 0.16, 0)
        }
        else {
          trail(a, actors[a.target]!, 0.2)
        }
        return
      }
      case 'sleep':
        // Settled: no commands. The robots droop and breathe on their own (setSleep).
    }
  }

  // ── Contacts ──────────────────────────────────────────────────────────

  /** A routine a bump interrupts goes back to the game afterwards. */
  const ROUTINE: Mode[] = ['tackle', 'clear', 'kick', 'charge', 'go']

  /** One reaction per robot per contact: look, stop, step away, carry on (see REACT). */
  function startReaction(a: Actor, other: number, x: number, z: number, speed = 1) {
    a.react.t0 = time
    a.react.other = other
    a.react.x = x
    a.react.z = z
    if (auto && speed < REACT.play && (a.mode === 'play' || a.mode === 'clear' || a.mode === 'kick' || a.mode === 'dot')) {
      hooks.react?.(a.index, other, time)
      return
    }
    if (a.mode === 'charge') endCrash()
    if (egg.name !== 'sleep' && a.mode !== 'react' && a.mode !== 'held') {
      a.react.resume = ROUTINE.includes(a.mode) ? 'play' : a.mode
      a.mode = 'react'
    }
    hooks.react?.(a.index, other, time)
  }

  /** Solver callback: clashes, sound, dust and reactions for each impact. */
  function onImpact(speed: number, x: number, z: number, i: number, j: number) {
    if (ctx.posterMode) return
    hooks.impact?.(i, j, speed, time)
    if (i >= n || j >= n) {
      // A robot on the ball: a touch (the referee's stall clock restarts) --
      // and if it is the one playing the ball, a strike along its line.
      if (j === n && i < n) {
        game.lastTouch = time
        const a = actors[i]!
        const s = strikeOf(a)
        if (s > 0 && time - a.run.last > 0.5) strikeBy(a, s)
      }
      if (speed > 0.04 && time - lastTick > 0.06) {
        lastTick = time
        if (i === n || j === n) playTick(speed)
        else playScrape(speed)
      }
      if (speed > 0.3 && time - lastDust[n * n + Math.min(i, n - 1)]! >= BUMP.dustGap) {
        lastDust[n * n + Math.min(i, n - 1)] = time
        dust.puff(x, z, speed * 0.6, time)
      }
      return
    }
    if (crash.charger >= 0 && !crash.hit && ((i === crash.charger && j === crash.victim) || (j === crash.charger && i === crash.victim))) {
      crash.hit = true
      crash.count++
    }
    if (clash.a >= 0 && !clash.hit && speed > 0.04 && ((i === clash.a && j === clash.b) || (i === clash.b && j === clash.a))) {
      // The clash: one of them goes over (seeded), the other comes away with the ball.
      clash.hit = true
      clash.count++
      const loser = rand.next() < 0.5 ? clash.a : clash.b
      const winner = loser === clash.a ? clash.b : clash.a
      actors[loser]!.robot.react('tumble')
      const w = actors[winner]!
      game.attack = w.team
      if (Math.hypot(ball.x - x, ball.z - z) < 0.25) {
        ball.strike(Math.sign(attackX(w.team) - P.cx) * 0.8, ball.z > P.cz ? -0.6 : 0.6, 0.4)
        game.lastTouch = time
      }
      endClash()
    }
    if (j <= WALL) j = -1
    if (speed >= 0.05 && time - lastBump >= BUMP.gap) {
      lastBump = time
      if (speed < BUMP.rubber) playRubber(speed)
      else playClank(speed)
    }
    const key = j >= 0 ? i * n + j : n * n + i
    if (speed >= BUMP.dust && time - lastDust[key]! >= BUMP.dustGap) {
      lastDust[key] = time
      dust.puff(x, z, speed, time)
    }
    if (speed < REACT.min) return
    if (j >= 0) {
      if (time < cool[key]!) return
      cool[key] = time + REACT.cool
      startReaction(actors[i]!, j, x, z, speed)
      startReaction(actors[j]!, i, x, z, speed)
    }
    else {
      if (time < coolStatic[i]!) return
      coolStatic[i] = time + REACT.cool
      startReaction(actors[i]!, j, x, z, speed)
    }
  }

  /** The reaction's moves: still, then a step away from the contact, then back to what it was doing. */
  function directReact(a: Actor) {
    const t = time - a.react.t0
    if (t < REACT.pause) return
    // A keeper stands its ground: a step back would be into its own net.
    if (t < REACT.back && a.keeper) return
    if (t < REACT.back) {
      const r = a.robot
      // Away from the contact: reverse if it was in front, a step forward if behind.
      const ahead = (a.react.x - r.position.x) * Math.sin(r.heading) + (a.react.z - r.position.z) * Math.cos(r.heading)
      cmd.speed = ahead >= 0 ? -REACT.backSpeed : 0.8 * REACT.backSpeed
      return
    }
    const resume = a.react.resume
    if (resume === 'react' || (resume === 'chain' && !chain.kind) || (resume === 'egg' && !egg.name) || (resume === 'dot' && !dot.on) || (resume === 'celebrate' && game.scorer < 0)) a.mode = 'play'
    else a.mode = resume
    startRun(a)
  }

  // ── Keyboard crash ────────────────────────────────────────────────────

  const otherKind = (i: number) => {
    // The nearest robot of another kind, else the nearest robot.
    let best = -1, bestD = Infinity, any = -1, anyD = Infinity
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const d = actors[j]!.robot.position.distanceTo(actors[i]!.robot.position)
      if (d < anyD) {
        anyD = d
        any = j
      }
      if (actors[j]!.robot.kind !== actors[i]!.robot.kind && d < bestD) {
        bestD = d
        best = j
      }
    }
    return best >= 0 ? best : any
  }

  function startCrash(i: number) {
    const v = otherKind(i)
    if (v < 0) return false
    crash.charger = i
    crash.victim = v
    crash.until = time + CRASH.time
    crash.hit = false
    actors[i]!.mode = 'charge'
    return true
  }

  function endCrash() {
    const a = actors[crash.charger]
    if (a && a.mode === 'charge') a.mode = 'play'
    crash.charger = -1
  }

  /** Flat out at the victim: no avoidance, no braking. What happens on contact is physics. */
  function directCharge(a: Actor) {
    const v = actors[crash.victim]!.robot
    if (crash.hit || time > crash.until) {
      endCrash()
      return
    }
    sprintAt(a, v.position.x, v.position.z, a.robot.kind === 'balancer' ? CRASH.sprint : a.robot.maxSpeed)
  }

  // ── Direction ─────────────────────────────────────────────────────────

  function direct(a: Actor, i: number) {
    cmd.speed = 0
    cmd.yawRate = 0
    cmd.strafe = 0
    cmd.boost = false
    const r = a.robot
    if (ctx.posterMode || a.mode === 'held') return
    if (r.busy) {
      if (a.mode === 'charge' && r.fallen) endCrash()
      if (a.mode === 'tackle' && r.fallen) endClash()
      return
    }
    switch (a.mode) {
      case 'egg': return directEgg(a, i)
      case 'react': return directReact(a)
      case 'charge': return directCharge(a)
      case 'tackle': return directTackle(a)
      case 'dot': return directDot(a)
      case 'celebrate': return directCelebrate(a)
      case 'clear': return directClear(a)
      case 'kick': {
        if (runAt(a, attackX(a.team), P.cz, PLAY.shot) || time > a.until) a.mode = 'play'
        return
      }
      case 'called': {
        if (steer(a, 0.2)) {
          face(a, CAMERA)
          if (time > a.until) a.mode = 'play'
        }
        else {
          a.until = time + 3
        }
        return
      }
      case 'go': {
        if (steer(a, 0.2, 0.05) || time > a.until) a.mode = 'play'
        return
      }
      case 'chain': {
        if (a.target < 0) {
          a.goal.copy(chain.goal)
          if (steer(a, 0.2, 0.05)) face(a, CAMERA)
        }
        else {
          trail(a, actors[a.target]!, 0.2)
        }
        return
      }
      case 'play': {
        // The game is off (tests): hold the place, watch the ball.
        if (!auto || game.scorer >= 0) {
          face(a, ballAt)
          return
        }
        if (a.keeper) return keeperPlay(a)
        if (game.press[a.team] === i) return a.team === game.attack ? pressPlay(a) : markPlay(a)
        return supportPlay(a)
      }
    }
  }

  /** Head height to aim at another robot's face. */
  const headOf = (a: Actor, out: THREE.Vector3) => out.copy(a.robot.position).setY(0.2)

  function eggLook(a: Actor, i: number) {
    const t = time - egg.t0
    switch (egg.name) {
      case 'sleep':
        a.robot.lookAt(null)
        return
      case 'line-up': {
        if (t > LINE.bowAt && t < LINE.bowAt + LINE.bowFor) {
          // The bow: eyes to the floor just in front of its own feet.
          const r = a.robot
          a.robot.lookAt(a.look.set(r.position.x + Math.sin(r.heading) * 0.12, 0, r.position.z + Math.cos(r.heading) * 0.12))
        }
        else {
          a.robot.lookAt(CAMERA)
        }
        return
      }
      case 'conga':
        a.robot.lookAt(a.target >= 0 ? headOf(actors[a.target]!, a.look) : a.look.copy(a.goal).setY(0.1))
        return
      default:
        // Dancing: to the audience, then to the partner on each other bar.
        a.robot.lookAt(Math.floor(t / (4 * BEAT)) % 2 ? headOf(actors[(i + 1) % actors.length]!, a.look) : CAMERA)
    }
  }

  function updateLooks() {
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i]!
      if (ctx.posterMode) continue
      if (time - a.react.t0 < REACT.look) {
        // Snap round to whoever (or whatever) it just bumped into.
        const o = a.react.other
        a.robot.lookAt(o >= 0 ? headOf(actors[o]!, a.look) : a.look.set(a.react.x, 0.08, a.react.z))
      }
      else if (egg.name) eggLook(a, i)
      else if (a.mode === 'dot') a.robot.lookAt(dot.p)
      else if (a.mode === 'charge') a.robot.lookAt(headOf(actors[crash.victim]!, a.look))
      else if (a.mode === 'tackle') a.robot.lookAt(ballAt)
      else if (a.mode === 'called' || (a.mode === 'celebrate' && a.team === game.scorer)) a.robot.lookAt(CAMERA)
      else if (a.mode === 'chain' && a.target >= 0) a.robot.lookAt(headOf(actors[a.target]!, a.look))
      else if (lookPreset.index >= 0 && time < lookPreset.until) a.robot.lookAt(lookPreset.index === 3 ? headOf(actors[(i + 1) % actors.length]!, a.look) : lookPreset.point)
      else a.robot.lookAt(ballAt)
    }
  }

  function select(i: number) {
    if (selected >= 0) actors[selected]?.robot.setSelected(false)
    selected = i
    actors[i]?.robot.setSelected(true)
  }

  function hideAnchors() {
    if (anchorOwner !== instance) return
    for (const a of heroAnchors) a.visible = false
  }

  const counts = actors.map((a, i) => actors.slice(0, i + 1).filter(o => o.robot.kind === a.robot.kind).length)
  const names = actors.map((a, i) => `${LABEL[a.robot.kind]} ${counts[i]}`)
  /** Leader-line ids: kind-number ('duck-1', 'balancer-1', ...). */
  const ids = actors.map((a, i) => `${a.robot.kind}-${counts[i]}`)

  function setCursor(c: string) {
    if (grab.cursor === c || typeof document === 'undefined' || !document.body) return
    grab.cursor = c
    document.body.style.cursor = c
  }

  function releaseGrab() {
    if (grab.i < 0) return
    const a = actors[grab.i]!
    a.robot.grab(null)
    if (a.mode === 'held') {
      a.mode = 'play'
      startRun(a)
    }
    grab.i = -1
    setCursor('')
  }

  const tmp2 = new THREE.Vector3()
  /** The robot under the ray (and the hit point), or -1. */
  function pickRobot(out: THREE.Vector3) {
    let best = -1, bestD = Infinity
    for (let k = 0; k < n; k++) {
      if (actors[k]!.robot.hit(ray, tmp2)) {
        const d = tmp2.distanceTo(ray.ray.origin)
        if (d < bestD) {
          bestD = d
          best = k
          out.copy(tmp2)
        }
      }
    }
    return best
  }
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

  function takeHold(i: number, p: THREE.Vector3) {
    releaseGrab()
    const a = actors[i]!
    if (crash.charger === i) endCrash()
    if (clash.a === i || clash.b === i) endClash()
    grab.i = i
    grab.y = p.y
    a.mode = 'held'
    a.robot.grab(p)
  }

  const EGG_STATUS: Record<Egg, string> = {
    'dance': 'The robots are dancing',
    'party': 'Party! The robots are dancing in colour',
    'line-up': 'The robots are lining up to take a bow',
    'conga': 'Conga line!',
    'sleep': 'The robots are asleep. Move the pointer or tap to wake them',
  }

  const instance = {
    scene,
    camera,
    step(dt: number) {
      time += DT
      // The page moved its text: new walls.
      if (heroKeepOut.version !== layoutVersion || slotW !== layoutW || slotH !== layoutH) relayout(slotW, slotH)
      if (egg.name && time >= egg.until) endEgg()
      ballAt.set(ball.x, BALL.r, ball.z)
      const running = auto && !egg.name && !ctx.posterMode
      if (running) {
        checkGoal()
        checkOut()
        updateCelebration()
        pickPressers()
        // A contested ball every 10-15 s -- not in front of a goal: a clash in
        // a goal mouth would flatten the keeper too. And the referee restarts a ball
        // nobody has touched for a while.
        if (game.scorer < 0 && !dot.on && clash.a < 0 && time > clash.next && Math.abs(ball.x - P.cx) < P.hx - GOAL.depth - 0.15) {
          if (!startClash()) clash.next = time + 1
        }
        if (game.scorer < 0 && time - game.lastTouch > PLAY.stall) {
          game.attack = game.attack === 0 ? 1 : 0
          respot()
        }
      }
      // The pointer resting still on the floor: one target, once (it re-arms when it moves on).
      if (pointer.active && pointer.onFloor && !pointer.rested && time - pointer.movedAt > DOT.rest && !ctx.coarse && !ctx.posterMode && grab.i < 0) {
        pointer.rested = true
        // A pointer parked on the text (reading the headline, over a button) is not a call.
        if (!overText(pointer.x, pointer.y)) dotOn(pointer.ground)
      }
      updateDot()
      packAgents()
      updateLooks()
      for (let i = 0; i < actors.length; i++) {
        const a = actors[i]!
        direct(a, i)
        if (hooks.command) hooks.command(i, cmd)
        a.robot.step(dt, cmd)
      }
      ball.step(dt)
      if (!ctx.posterMode) {
        // The pitch's touchlines are boards for the ball (the robots may run
        // past them; the ball stays in play), as round a robot football pitch.
        // They are the game's, not walls: a ball a robot is leaning on (one
        // falling, say) goes past them, and comes back once it is free.
        // BEFORE the solve, so the solver has the last word: a ball put back
        // on the boards next to a robot is pushed clear of it, never left in it.
        const knock = leaningOnBall() ? 0 : ball.confine(pitch.x0, pitch.x1, pitch.z0, pitch.z1)
        if (knock > 0.04 && time - lastTick > 0.06) {
          lastTick = time
          playTick(knock)
        }
        solveContacts(bodies, obstacles, onImpact, solveOpts)
        settleBall()
      }
      props.step()
    },
    frame(alpha: number) {
      for (let i = 0; i < actors.length; i++) actors[i]!.robot.frame(alpha)
      props.frame(Math.min(1, Math.max(0, alpha)))
      dust.update(time)
      marker.visible = dot.on && !paused
      if (marker.visible) {
        marker.position.set(dot.p.x, 0.0012, dot.p.z)
        marker.scale.setScalar(1 + 0.15 * Math.sin(time * 7))
      }
      if (anchorOwner !== instance) return
      for (let i = 0; i < actors.length; i++) {
        const p = actors[i]!.robot.headPoint(tmp).project(camera)
        const an = heroAnchors[i]
        if (!an) continue
        an.x = (p.x + 1) / 2 * slotW
        an.y = (1 - p.y) / 2 * slotH
        an.visible = !paused && an.x >= 0 && an.x <= slotW && an.y >= 0 && an.y <= slotH
      }
    },
    resize(w: number, h: number) {
      slotW = w
      slotH = h
      // Same size, same text: nothing to rebuild.
      if (w !== layoutW || h !== layoutH || heroKeepOut.version !== layoutVersion) relayout(w, h)
      if (!anchorOwner || anchorOwner === instance || w > anchorOwnerW) {
        if (anchorOwner !== instance) {
          heroAnchors.length = 0
          for (const id of ids) heroAnchors.push({ id, x: 0, y: 0, visible: false })
        }
        anchorOwner = instance
        anchorOwnerW = w
      }
    },
    pointer(p: SlotPointer) {
      if (p.kind === 'leave') {
        pointer.active = false
        if (grab.i < 0) setCursor('')
        return
      }
      ray.setFromCamera(ndc.set(p.ndc.x, p.ndc.y), camera)
      if (p.kind === 'down') {
        // Grab: a robot under the pointer is picked at the point hit and dragged by a spring.
        const i = pickRobot(hit)
        if (i < 0 || ctx.posterMode) return
        endEgg()
        takeHold(i, hit)
        select(i)
        setCursor('grabbing')
        return
      }
      if (p.kind === 'up') {
        releaseGrab()
        return
      }
      if (p.kind === 'move' && grab.i >= 0) {
        if (!p.buttons) {
          releaseGrab()
          return
        }
        // Drag on the horizontal plane at the height it was picked, lifted a
        // little -- never into the text: the spring pulls toward a point clear of it.
        dragPlane.constant = -grab.y
        if (ray.ray.intersectPlane(dragPlane, hit)) {
          clampFree(hit, 0.02)
          hit.y = grab.y + DRAG_LIFT
          actors[grab.i]!.robot.dragTo(hit)
        }
        return
      }
      if (p.kind === 'move' && !ctx.coarse) setCursor(pickRobot(tmp) >= 0 ? 'grab' : '')
      // Any touch or move wakes the sleepers -- with a startle.
      if (egg.name === 'sleep' && (p.kind === 'tap' || Math.hypot(p.x - pointer.x, p.y - pointer.y) > REST_PX)) endEgg()
      if (p.kind === 'tap') {
        // The ball first: a tap knocks it away from where it was touched.
        const pb = ray.intersectObject(props.ballMesh, false)[0]
        if (pb && ray.ray.intersectPlane(ground, hit)) {
          ball.kick(ball.x - hit.x + VIEW_DIR.x * 0.02, ball.z - hit.z + VIEW_DIR.z * 0.02, 0.8)
          game.lastTouch = time
          playTick(0.5)
          return
        }
        const i = pickRobot(hit)
        if (i >= 0) {
          select(i)
          actors[i]!.robot.react('tap')
          return
        }
        // A click or tap on the floor: a target. Not one on the text: that
        // is the page's (a link, a word), and its floor is behind a wall.
        if (ray.ray.intersectPlane(ground, hit) && !ctx.posterMode && !overText(p.x, p.y)) dotOn(hit)
        return
      }
      if (p.kind !== 'move' || !ray.ray.intersectPlane(ground, hit)) return
      // A move changes nothing in the game: it only (re)starts the rest clock.
      if (!pointer.active || Math.hypot(p.x - pointer.x, p.y - pointer.y) > REST_PX) {
        pointer.x = p.x
        pointer.y = p.y
        pointer.movedAt = time
        pointer.rested = false
      }
      pointer.active = true
      pointer.ground.copy(hit)
      pointer.onFloor = p.x >= 0 && p.y >= 0 && p.x <= slotW && p.y <= slotH
    },
    setPaused(next: boolean) {
      paused = next
      for (const a of actors) a.robot.setPaused(next)
      if (next) {
        releaseGrab()
        if (crash.charger >= 0) endCrash()
        endClash()
        dotOff()
        endChain()
        endEgg()
        lookPreset.index = -1
        hideAnchors()
      }
    },
    action(name: string) {
      if (name in EGG_S) {
        startEgg(name as Egg)
        return EGG_STATUS[name as Egg]
      }
      if (name === 'next') {
        select((selected + 1) % actors.length)
        return `${names[selected]} selected`
      }
      if (name === 'play') {
        endEgg()
        endChain()
        dotOff()
        for (const a of actors) if (!a.robot.busy && a.mode !== 'held') a.mode = 'play'
        respot()
        return 'Kick-off! The ball is back on the centre spot'
      }
      if (selected < 0) select(0)
      const a = actors[selected]!
      const who = names[selected]!
      switch (name) {
        case 'nudge':
          if (a.robot.busy) return `${who} is busy`
          a.robot.react('tap')
          return a.robot.kind === 'balancer' ? `${who} jumped` : `${who} hopped`
        case 'tumble':
          if (a.robot.fallen) return `${who} is already down`
          a.robot.react('tumble')
          return `${who} took a tumble. Watch it get up`
        case 'kick': {
          if (a.robot.busy) return `${who} is busy`
          endEgg()
          if (crash.charger === selected) endCrash()
          a.mode = 'kick'
          a.until = time + 5
          startRun(a)
          return `${who} is going for goal`
        }
        case 'crash': {
          if (a.robot.busy) return `${who} is busy`
          endEgg()
          if (crash.charger >= 0) endCrash()
          if (!startCrash(selected)) return `${who} has nobody to crash into`
          return `${who} is charging at ${names[crash.victim]}!`
        }
        case 'call':
          endEgg()
          a.goal.set(P.cx, 0, pitch.z1 - 0.12)
          a.mode = 'called'
          a.until = time + 3
          return `${who} is coming over`
        case 'follow':
          if (chain.kind === 'key') {
            endChain()
            return 'Stopped following'
          }
          endEgg()
          startChain(selected)
          chain.goal.set(P.cx, 0, pitch.z1 - 0.12)
          return `Everyone is following ${who}`
        case 'shoo': {
          endEgg()
          // Back to its own end of the pitch for a moment.
          const own = attackX(a.team === 0 ? 1 : 0)
          a.goal.set(own + Math.sign(P.cx - own) * 0.3, 0, P.cz + (a.robot.position.z >= P.cz ? 1 : -1) * P.hz * 0.6)
          a.mode = 'go'
          a.until = time + 4
          return `${who} backed off to its own end`
        }
        case 'look': {
          lookPreset.index = (lookPreset.index + 1) % 4
          lookPreset.until = time + 4
          const to = [[pitch.x0, P.cz], [P.cx, pitch.z1], [pitch.x1, P.cz]][lookPreset.index]
          if (to) lookPreset.point.set(to[0]!, 0, to[1]!)
          return ['Looking left', 'Looking at you', 'Looking right', 'Looking at each other'][lookPreset.index]!
        }
      }
      return null
    },
    /**
     * A static obstacle on the ground the robots collide with and steer
     * round. Mutable: move it by writing x/z. removeObstacle() takes it away.
     */
    addObstacle(o: Obstacle) {
      const ob = { x: o.x, z: o.z, r: o.r }
      extraObstacles.push(ob)
      rebuildObstacles()
      return ob
    },
    removeObstacle(o: Obstacle) {
      const k = extraObstacles.indexOf(o)
      if (k >= 0) extraObstacles.splice(k, 1)
      rebuildObstacles()
    },
    /** For tests and the lab. */
    debug: {
      robots,
      obstacles,
      ball,
      blocks: [] as { x: number, z: number, yaw: number }[],
      walls,
      pitch,
      routines: (on: boolean) => {
        auto = on
      },
      kicks: () => game.touches,
      crashes: () => clash.count + crash.count,
      clashes: () => clash.count,
      goals: () => [game.goals[0], game.goals[1]] as const,
      grabbed: () => grab.i,
      /** The laser dot (null when off) and who is chasing it. */
      dot: () => (dot.on ? dot.p : null),
      chasers: () => dot.chasers.slice(),
      marker: () => marker.visible,
      team: (i: number) => actors[i]!.team,
      /** Each team's presser, and a robot's run at the ball (phase, line). */
      press: () => [game.press[0], game.press[1]] as const,
      attack: () => game.attack,
      run: (i: number) => actors[i]!.run,
      /** Free floor: inside the walls and clear of the text by m. */
      isFree,
      /** Mouse grab without a DOM (tests): pick robot i at a world point, drag, release. */
      grab: (i: number, p: THREE.Vector3 | null) => {
        if (!p) {
          releaseGrab()
          return
        }
        takeHold(i, p)
      },
      drag: (to: THREE.Vector3) => {
        if (grab.i >= 0) actors[grab.i]!.robot.dragTo(clampFree(to.clone(), 0.02).setY(to.y))
      },
      overlap: () => maxOverlap(bodies, obstacles, walls),
      /** Times the ball had no room on the floor and popped up out of a squeeze. */
      pops: () => pops,
      /** Live dust puffs (pool-bounded). */
      dust: () => dust.active,
      /** Set to observe reactions and impacts (tests). */
      hooks,
      mode: (i: number) => actors[i]!.mode,
      goal: (i: number) => actors[i]!.goal,
      egg: () => egg.name,
      chain: () => chain.kind,
    },
    dispose() {
      hideAnchors()
      if (anchorOwner === instance) {
        anchorOwner = null
        anchorOwnerW = 0
      }
      releaseGrab()
      for (const a of actors) a.robot.dispose()
      dust.dispose()
      props.dispose()
      pitchView.dispose()
      field.dispose()
      markerMerged.dispose()
      markerMat.dispose()
    },
  }
  return instance
}
