import * as THREE from 'three'
import { Assembly, addLights, beamGeometry, blockGeometry, contactShadow, discGeometry, fitOrtho, pinGeometry } from '../core/kit'
import { rng } from '../core/rng'
import { nextTask, type SceneContext, type SceneInstance, type SlotPointer } from '../core/stage'
import { createEasel, createKite, createLantern, createMobile, createPottery, type ArtProp, type Kite } from './art'
import type { Variant } from './body'
import type { Action, PlayOptions } from './motion'
import { createPerson, type Look, type Person } from './person'

/**
 * /lab/people: a small fair group round a robot's spot (the marker on the
 * ground stands in for a hero robot), three people at work, and every art
 * prop. A tiny director per person cycles them through a seeded script; the
 * visitor's input overrides it for a while, then the script resumes.
 *
 * The three workers show the hand-target API the machine scenes use: the
 * scene moves a tool and puts the hands on it every step.
 *  - the sawyer: right hand on the saw handle as it strokes, left hand
 *    steadying the plank on the trestles;
 *  - the hauler: both hands on a red operating rope, synced to the scene's
 *    rope phase (pull-rope + setRopePhase);
 *  - the maker: seated on a stool at a small table, tapping, left hand flat.
 *
 * - Pointer move: everyone turns to look at the pointer's point on the ground,
 *   each after their own reaction delay (the workers only glance up from their
 *   work); hovering a person or prop marks it cyan; pointer motion is wind for
 *   the mobile and the lantern.
 * - Tap a person: they wave (or clap). Tap a prop: its reaction. Tap the
 *   ground: the group looks there and the nearest person points.
 * - Keyboard: action('wave' | 'clap' | 'point' | 'look-here' | 'plot' |
 *   'mobile' | 'kite' | 'pots' | 'lantern').
 * - posterMode: a fixed composition with everyone mid-action.
 */

const SPOT = new THREE.Vector3(0, 0, 0)
const SPOT_LOOK = new THREE.Vector3(0, 0.22, 0)

type Work = 'saw' | 'tap' | 'kite'
interface Beat { a: Action, d: number, o?: 'spot' | 'home' | 'away' }
interface Cast { variant: Variant, seed: number, x: number, z: number, heading?: number, accent?: boolean, script: Beat[], poster: Action, work?: Work }

const CAST: Cast[] = [
  {
    variant: 'shirt', seed: 11, x: -1.18, z: 0.47, poster: 'point',
    script: [{ a: 'idle', d: 3 }, { a: 'point', d: 4, o: 'spot' }, { a: 'idle', d: 2 }, { a: 'step-back', d: 3, o: 'away' }, { a: 'clap', d: 3 }, { a: 'crouch', d: 5, o: 'spot' }, { a: 'step-back', d: 3, o: 'home' }],
  },
  { variant: 'kurta', seed: 23, x: -1.05, z: -1.6, heading: 2.1, poster: 'idle', script: [{ a: 'idle', d: 1e9 }], work: 'saw' },
  {
    variant: 'mundu', seed: 37, x: 0.64, z: -1.77, poster: 'pull-rope',
    script: [{ a: 'pull-rope', d: 12 }, { a: 'idle', d: 3 }, { a: 'watch', d: 4 }],
  },
  { variant: 'skirt', seed: 41, x: -1.17, z: 1.74, heading: 1.9, poster: 'idle', script: [{ a: 'idle', d: 1e9 }], work: 'tap' },
  {
    variant: 'headscarf', seed: 53, x: 1.11, z: 0.5, accent: true, poster: 'wave',
    script: [{ a: 'watch', d: 5 }, { a: 'wave', d: 3 }, { a: 'idle', d: 3 }, { a: 'crouch', d: 4, o: 'spot' }, { a: 'clap', d: 3 }],
  },
  { variant: 'child', seed: 67, x: 0.24, z: 1.48, poster: 'point', script: [{ a: 'point', d: 1e9 }], work: 'kite' },
]
const SAWYER = 1
const PULLER = 2
const MAKER = 3
const KITE_HOLDER = 5
/** Ground stake the hauler pulls toward, near the robot's spot. */
const STAKE = new THREE.Vector3(0.21, 0, -0.83)
const STOOL_H = 0.44
const TABLE_H = 0.68
const TRESTLE_H = 0.82

/**
 * Inspection modes (dev lab only), read from the page URL:
 *   ?lineup=1          every variant and look in a row, facing the camera
 *   ?person=<name|i>   frame one person (cast: sawyer, hauler, maker, child,
 *                      pointer, visitor; lineup: an index)
 *   &vh=<metres>       view height of that close-up (default 1.1)
 *   &yaw=<deg>         orbit the close-up camera round the person
 *   &turn=<deg>        (lineup) turn everyone by this much (90: a side view)
 *   &pose=<name>       (lineup) everyone holds a pose: reach (both arms forward at
 *                      shoulder height), up (hands raised forward), sit (on a stool),
 *                      temple (hands to the head), upright (an upright handle, palm
 *                      from behind), work (hands on a bench in front), forward / overhead
 *                      (straight arms raised 120 / 175 deg), or any action
 */
function labQuery() {
  try {
    return new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
  }
  catch {
    return new URLSearchParams('')
  }
}

const LINEUP: { variant: Variant, seed: number, look?: Partial<Look>, accent?: boolean }[] = [
  { variant: 'shirt', seed: 3, look: { hair: 'side', glasses: true, sleeves: 'short', facial: 'none' } },
  { variant: 'shirt', seed: 8, look: { hair: 'curly', facial: 'beard', sleeves: 'rolled' } },
  { variant: 'kurta', seed: 5, look: { hair: 'short', facial: 'beard' } },
  { variant: 'kurta', seed: 12, look: { hair: 'receding', facial: 'moustache', glasses: true } },
  { variant: 'mundu', seed: 7, look: { hair: 'short', facial: 'moustache', sleeves: 'short' } },
  { variant: 'mundu', seed: 13, look: { hair: 'receding', lungi: true, folded: true, apron: true, sleeves: 'rolled' } },
  { variant: 'skirt', seed: 41, look: { hair: 'plait' } },
  { variant: 'skirt', seed: 44, look: { hair: 'bun', glasses: true } },
  { variant: 'skirt', seed: 46, look: { hair: 'long' } },
  { variant: 'headscarf', seed: 53, accent: true },
  { variant: 'headscarf', seed: 54, look: { glasses: true } },
  { variant: 'child', seed: 67, look: { hair: 'ponytail' } },
  { variant: 'child', seed: 68, look: { hair: 'curly' } },
]

async function lineup(ctx: SceneContext, q: URLSearchParams): Promise<SceneInstance> {
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60)
  const dir = new THREE.Vector3(6.2, 4.8, 10.4).normalize()
  const heading = Math.atan2(dir.x, dir.z)
  const people: Person[] = []
  const gap = 0.62
  const turn = (Number(q.get('turn')) || 0) * Math.PI / 180
  const pose = q.get('pose')
  LINEUP.forEach((c, i) => {
    const x = (i - (LINEUP.length - 1) / 2) * gap
    const p = createPerson(ctx, { seed: c.seed, variant: c.variant, posterMode: ctx.posterMode, look: c.look, accent: c.accent })
    // Along a line square to the view, so nobody hides anybody.
    p.placeAt(Math.cos(heading) * x, -Math.sin(heading) * x, heading + turn)
    scene.add(p.root)
    people.push(p)
  })
  /** A pose's hand targets, in the person's own frame (x left, z forward), metres for a 1.7 m adult. */
  const holdPose = (p: Person) => {
    const H = p.dims.H / 1.7
    const h = p.heading
    const w = (x: number, y: number, z: number) => ({ x: p.position.x + Math.cos(h) * x + Math.sin(h) * z, y, z: p.position.z - Math.sin(h) * x + Math.cos(h) * z })
    const dir = (x: number, y: number, z: number) => ({ x: Math.cos(h) * x + Math.sin(h) * z, y, z: -Math.sin(h) * x + Math.cos(h) * z })
    const both = (f: (s: 1 | -1) => Parameters<Person['setHandTarget']>[1]) => {
      p.setHandTarget('left', f(1))
      p.setHandTarget('right', f(-1))
    }
    if (pose === 'reach') both(s => ({ position: w(s * 0.16 * H, 1.32 * H, 0.5 * H), normal: dir(0, 1, 0), kind: 'flat' }))
    else if (pose === 'up') both(s => ({ position: w(s * 0.14 * H, 1.75 * H, 0.38 * H), normal: dir(0, -1, 0), kind: 'flat' }))
    else if (pose === 'overhead' || pose === 'forward') {
      // Straight arms, raised forward by 120 deg (forward) or 175 deg (overhead).
      const d = p.dims
      const a = (pose === 'overhead' ? 175 : 120) * Math.PI / 180
      const r = 0.95 * (d.UA + d.FA)
      const sy = d.standY + d.waistY + d.shoulderY
      both(s => ({ position: w(s * d.shoulderX, sy - r * Math.cos(a), r * Math.sin(a)) }))
    }
    else if (pose === 'work') both(s => ({ position: w(s * 0.17 * H, 0.9 * H, 0.38 * H), normal: dir(0, 1, 0), kind: 'flat' }))
    else if (pose === 'upright') {
      p.setHandTarget('right', { position: w(-0.1 * H, 1.0 * H, 0.36 * H), normal: dir(0, 0, -1), axis: dir(0, 1, 0), kind: 'wrap', radius: 0.016 } as never)
    }
    else if (pose === 'temple') {
      const d = p.dims
      both(s => ({ position: w(s * (d.headW / 2 + 0.03 + (d.headscarf ? 0.03 : 0)), d.H - d.headH * 0.36, 0.05 * H), normal: dir(s, 0, 0), kind: 'flat' }))
    }
  }
  for (const p of people) {
    if (pose === 'sit') p.setStance('sit', { seatHeight: 0.46 * p.dims.H / 1.7, instant: true })
    else if (pose && !['reach', 'up', 'work', 'upright', 'temple', 'overhead', 'forward'].includes(pose)) p.play(pose as Action)
  }
  await nextTask()
  const pick = q.get('person')
  const who = pick === null ? -1 : Math.max(0, Math.min(people.length - 1, Number(pick) || 0))
  const aim = new THREE.Vector3(0, 0.85, 0)
  if (who >= 0) aim.set(people[who]!.position.x, people[who]!.dims.H * 0.62, people[who]!.position.z)
  if (q.get('aimy')) aim.y = Number(q.get('aimy'))
  // &aimf=<fraction of that person's height> (0.9: the face)
  if (who >= 0 && q.get('aimf')) aim.y = people[who]!.dims.H * Number(q.get('aimf'))
  camera.position.copy(aim).addScaledVector(dir, 12)
  camera.lookAt(aim)
  const vh = Number(q.get('vh')) || (who >= 0 ? 1.1 : 2.4)
  let time = 0
  return {
    scene,
    camera,
    step(dt) {
      time += dt
      for (const p of people) {
        holdPose(p)
        // A one-shot (wave, clap) is played again as soon as it ends.
        if ((pose === 'wave' || pose === 'clap') && p.action !== pose) p.play(pose)
        p.step(dt)
      }
    },
    frame(alpha) {
      for (const p of people) p.frame(alpha)
    },
    resize(w, h) {
      fitOrtho(camera, w, h, vh)
    },
    pointer() {},
    setPaused(p) {
      for (const pe of people) pe.setPaused(p)
    },
    action(name) {
      if (name === 'wave') { people.forEach(p => p.play('wave')); return 'Everyone waves.' }
      return null
    },
    dispose() {
      for (const p of people) p.dispose()
    },
  }
}

export default async function create(ctx: SceneContext): Promise<SceneInstance> {
  const q = labQuery()
  if (q.get('lineup')) return lineup(ctx, q)
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60)
  camera.position.set(6.2, 4.8, 10.4)
  const aim = new THREE.Vector3(-0.3, 1.55, -0.3)
  camera.lookAt(aim)
  const M = ctx.materials
  const owned: THREE.BufferGeometry[] = []
  const ownedMats: THREE.Material[] = []
  const own = <T extends THREE.BufferGeometry>(g: T) => { owned.push(g); return g }
  const builtGroups: THREE.Object3D[] = []

  // The robot's spot: a plate on the ground with a ring and a centre pin, and the hauler's stake.
  {
    const a = new Assembly()
      .add(own(discGeometry(0.2, 0.006, [], 40)), 'light', { rot: [-Math.PI / 2, 0, 0], pos: [0, 0.003, 0] })
      .add(own(discGeometry(0.035, 0.012, [], 24)), 'mid', { rot: [-Math.PI / 2, 0, 0], pos: [0, 0.006, 0] })
      .add(own(pinGeometry(0.014, 0.2)), 'dark', { rot: [-Math.PI / 2, 0, 0], pos: [STAKE.x, 0.1, STAKE.z] })
    const g = a.build(M, 'spot')
    builtGroups.push(g)
    scene.add(g)
  }

  // ── People ────────────────────────────────────────────────────────────
  const people: Person[] = []
  const kiteAim = new THREE.Vector3(0, 3, -1)
  for (const c of CAST) {
    const p = createPerson(ctx, { seed: c.seed, variant: c.variant, posterMode: ctx.posterMode, accent: c.accent })
    const heading = c.heading ?? Math.atan2(SPOT.x - c.x, SPOT.z - c.z)
    p.placeAt(c.x, c.z, heading)
    scene.add(p.root)
    people.push(p)
    await nextTask()
  }

  // ── Work stations, built in each worker's own frame ──────────────────
  const frameOf = (p: Person) => {
    const g = new THREE.Group()
    g.position.copy(p.position)
    g.rotation.y = p.heading
    scene.add(g)
    return g
  }
  // Sawyer: two trestles and a plank across them, in front; a saw that strokes along the cut.
  const sawyer = people[SAWYER]!
  sawyer.setStance('wide', { instant: true })
  const sawFrame = frameOf(sawyer)
  const PLANK_Z = 0.5
  {
    const a = new Assembly()
    const top = own(beamGeometry({ length: 0.5, width: 0.05, thickness: 0.03 }))
    const leg = own(beamGeometry({ length: TRESTLE_H, width: 0.035, thickness: 0.022, holes: [0.02, TRESTLE_H - 0.03] }))
    for (const x of [-0.42, 0.42]) {
      a.add(top, 'wood', { pos: [x, TRESTLE_H - 0.025, PLANK_Z - 0.25], rot: [0, -Math.PI / 2, 0] })
      for (const dz of [-0.16, 0.16]) {
        for (const sx of [-1, 1]) {
          a.add(leg, 'woodDark', { pos: [x + sx * 0.1, 0, PLANK_Z + dz], rot: [0, 0, Math.PI / 2 - sx * 0.14] })
        }
      }
    }
    a.add(own(blockGeometry(1.1, 0.032, 0.22)), 'wood', { pos: [0, TRESTLE_H + 0.016, PLANK_Z] })
    const g = a.build(M, 'trestles')
    builtGroups.push(g)
    sawFrame.add(g)
  }
  const saw = new THREE.Group()
  {
    // Blade along +Z from the handle, teeth down; handle at the origin.
    const blade = new THREE.Shape()
    blade.moveTo(-0.0, 0.03)
    blade.lineTo(0.48, 0.012)
    blade.lineTo(0.48, -0.04)
    blade.lineTo(0.0, -0.075)
    blade.closePath()
    const bladeG = own(new THREE.ExtrudeGeometry(blade, { depth: 0.002, bevelEnabled: false }))
    bladeG.translate(0, 0, -0.001)
    bladeG.rotateY(-Math.PI / 2)
    const a = new Assembly()
      .add(bladeG, 'metal')
      .add(own(blockGeometry(0.026, 0.11, 0.09)), 'woodDark', { pos: [0, -0.02, -0.03] })
    const g = a.build(M, 'saw')
    builtGroups.push(g)
    saw.add(g)
    sawFrame.add(saw)
  }
  // Maker: a stool under the seat and a small table in front.
  const maker = people[MAKER]!
  maker.setStance('sit', { seatHeight: STOOL_H, instant: true })
  const makerFrame = frameOf(maker)
  const TABLE_Z = 0.5
  {
    const a = new Assembly()
    a.add(own(discGeometry(0.16, 0.035, [], 32)), 'wood', { rot: [-Math.PI / 2, 0, 0], pos: [0, STOOL_H - 0.0175, 0] })
    const sl = own(beamGeometry({ length: STOOL_H - 0.03, width: 0.035, thickness: 0.022, holes: [0.03] }))
    for (let k = 0; k < 3; k++) {
      const an = k * Math.PI * 2 / 3 + 0.4
      a.add(sl, 'woodDark', { pos: [Math.cos(an) * 0.11, 0, Math.sin(an) * 0.11], rot: [0, -an, Math.PI / 2] })
    }
    a.add(own(blockGeometry(0.62, 0.03, 0.42)), 'wood', { pos: [0, TABLE_H - 0.015, TABLE_Z] })
    const tl = own(beamGeometry({ length: TABLE_H - 0.03, width: 0.04, thickness: 0.024, holes: [0.03] }))
    for (const x of [-0.27, 0.27]) for (const z of [TABLE_Z - 0.17, TABLE_Z + 0.17]) a.add(tl, 'woodDark', { pos: [x, 0, z], rot: [0, 0, Math.PI / 2] })
    // A small board on the table: the thing being worked on.
    a.add(own(blockGeometry(0.16, 0.012, 0.11)), 'dark', { pos: [-0.07, TABLE_H + 0.006, TABLE_Z - 0.09] })
    const g = a.build(M, 'maker-table')
    builtGroups.push(g)
    makerFrame.add(g)
  }
  await nextTask()

  // ── Props ─────────────────────────────────────────────────────────────
  const pctx = { materials: M, posterMode: ctx.posterMode }
  const easel = createEasel(pctx, { seed: 3 })
  easel.root.position.set(-3.35, 0, 1.41)
  easel.root.rotation.y = 0.85
  await nextTask()
  const mobile = createMobile(pctx, { seed: 5 })
  mobile.root.position.set(-3.6, 0, -0.77)
  mobile.root.rotation.y = 0.35
  await nextTask()
  const holder = people[KITE_HOLDER]!
  const hand = holder.handWorld('right', new THREE.Vector3())
  const kite = createKite(pctx, { seed: 9, anchor: hand, line: 2.7, windDir: [0.5, -1] }) as Kite
  const pottery = createPottery(pctx, { seed: 4 })
  pottery.root.position.set(2.5, 0, -2.65)
  pottery.root.rotation.y = -0.45
  await nextTask()
  const lantern = createLantern(pctx, { seed: 6 })
  lantern.root.position.set(2.3, 0, -1.02)
  lantern.root.rotation.y = -0.6
  const props: ArtProp[] = [easel, mobile, kite, pottery, lantern]
  for (const pr of props) scene.add(pr.root)

  // The hauler's rope: red (the force being applied), a thin ribbon facing the camera.
  const ropeMat = new THREE.MeshBasicMaterial({ color: ctx.palette.red, side: THREE.DoubleSide })
  ownedMats.push(ropeMat)
  const ROPE_PTS = 4
  const ropePos = new THREE.BufferAttribute(new Float32Array(ROPE_PTS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage)
  const ropeGeo = own(new THREE.BufferGeometry())
  ropeGeo.setAttribute('position', ropePos)
  const idx: number[] = []
  for (let i = 0; i < ROPE_PTS - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3)
  ropeGeo.setIndex(idx)
  const rope = new THREE.Mesh(ropeGeo, ropeMat)
  rope.frustumCulled = false
  scene.add(rope)
  const stakeShadow = contactShadow(M, 0.06)
  own(stakeShadow.geometry)
  stakeShadow.position.set(STAKE.x, 0.0005, STAKE.z)
  scene.add(stakeShadow)

  // Lab close-up of one cast member (?person=sawyer&vh=1.2).
  let closeUp = 0
  {
    const names: Record<string, number> = { pointer: 0, sawyer: SAWYER, hauler: PULLER, maker: MAKER, visitor: 4, child: KITE_HOLDER }
    const pick = q.get('person')
    if (pick !== null) {
      const i = names[pick] ?? Math.max(0, Math.min(people.length - 1, Number(pick) || 0))
      const p = people[i]!
      const d = camera.position.clone().sub(aim).normalize()
      // &yaw=<deg> orbits the close-up round the person (back, side, front views).
      d.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Number(q.get('yaw')) || 0) * Math.PI / 180)
      aim.set(p.position.x, Number(q.get('aimy')) || p.dims.H * 0.55, p.position.z)
      camera.position.copy(aim).addScaledVector(d, 12)
      camera.lookAt(aim)
      closeUp = Number(q.get('vh')) || 1.3
    }
  }

  // ── Director ──────────────────────────────────────────────────────────
  const R = rng(4242)
  const homes = CAST.map(c => ({ x: c.x, z: c.z }))
  const dir = CAST.map(c => ({ beat: Math.floor(R.next() * c.script.length), t: R.range(0, 2), override: 0 }))
  let time = 0
  let pointerLook: THREE.Vector3 | null = null
  let lookPreset = -1
  let presetUntil = 0
  let waveTurn = 0
  let tapToggle = 0
  let paused = false
  const pendingShots: { at: number, who: number, a: Action }[] = []
  /** Workers put their tools down for a moment to wave back. */
  const workPause = CAST.map(() => 0)

  function stance(i: number, b: Beat) {
    const p = people[i]!
    if (i === KITE_HOLDER) {
      p.play('point', { target: kiteAim, hand: 'right', look: false })
      return
    }
    if (b.a === 'step-back') {
      const pos = p.position
      const h = homes[i]!
      if (b.o === 'home') {
        const dx = h.x - pos.x, dz = h.z - pos.z
        const d = Math.hypot(dx, dz)
        if (d > 0.05) p.play('step-back', { from: { x: pos.x - dx, z: pos.z - dz }, distance: d })
      }
      else {
        p.play('step-back', { from: { x: SPOT.x, z: SPOT.z } })
      }
      return
    }
    // The hauler's rope runs down to the stake: tell the haul its slope.
    p.play(b.a, b.o === 'spot' ? { target: SPOT_LOOK } : b.a === 'pull-rope' ? { ropePitch: -0.55 } : {})
  }

  if (ctx.posterMode) {
    CAST.forEach((c, i) => {
      if (i === KITE_HOLDER) stance(i, c.script[0]!)
      else stance(i, { a: c.poster, d: 1, o: c.poster === 'point' || c.poster === 'crouch' ? 'spot' : undefined })
      people[i]!.lookAt(SPOT_LOOK)
    })
  }
  else {
    dir.forEach((d, i) => stance(i, CAST[i]!.script[d.beat]!))
  }

  // Work, driven from the scene clock every step: the tools move, the hands follow.
  const tmp = new THREE.Vector3()
  const tmpN = new THREE.Vector3()
  const toWorld = (frame: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) => {
    const c = Math.cos(frame.rotation.y), s = Math.sin(frame.rotation.y)
    return out.set(frame.position.x + c * x + s * z, y, frame.position.z - s * x + c * z)
  }
  const dirWorld = (frame: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) => {
    const c = Math.cos(frame.rotation.y), s = Math.sin(frame.rotation.y)
    return out.set(c * x + s * z, y, -s * x + c * z)
  }
  const SAW_DOWN = 0.55
  const SAW_GRIP = 0.36
  function work(t: number) {
    // Sawing: the blade's contact point runs back and forth along the cut, 1.1 strokes a second.
    const sawing = time >= workPause[SAWYER]!
    const stroke = 0.1 * Math.sin(Math.PI * 2 * 1.1 * t)
    const cz = PLANK_Z - 0.02 + stroke
    const top = TRESTLE_H + 0.032
    // Handle SAW_GRIP behind the contact point, up the blade's slope.
    const hx = -0.13, hy = top + SAW_GRIP * Math.sin(SAW_DOWN) + 0.03, hz = cz - SAW_GRIP * Math.cos(SAW_DOWN)
    saw.position.set(hx, hy, hz)
    saw.rotation.set(SAW_DOWN, 0, 0)
    if (sawing) {
      // Grip: palm facing the body's midline, so the surface normal points to the sawyer's right.
      sawyer.setHandTarget('right', { position: toWorld(sawFrame, hx, hy - 0.01, hz, tmp), normal: dirWorld(sawFrame, -1, 0, 0, tmpN) })
      sawyer.setHandTarget('left', { position: toWorld(sawFrame, 0.2, top + 0.012, PLANK_Z - 0.03, tmp), normal: tmpN.set(0, 1, 0) })
      sawyer.setLean(0.3, 0)
    }
    else {
      sawyer.setHandTarget('right', null)
      sawyer.setHandTarget('left', null)
      sawyer.setLean(0, 0)
    }
    // Tapping at the table: bursts of quick taps, the left hand flat on the board.
    const tapping = time >= workPause[MAKER]!
    if (tapping) {
      const burst = Math.sin(Math.PI * 2 * t / 3.6) > -0.2
      const tap = burst ? Math.abs(Math.sin(Math.PI * 3.2 * t)) ** 1.6 : 0.4
      const surf = TABLE_H + 0.012
      maker.setHandTarget('right', { position: toWorld(makerFrame, -0.1, surf + 0.012 + 0.04 * tap, TABLE_Z - 0.12, tmp), normal: tmpN.set(0, 1, 0) })
      maker.setHandTarget('left', { position: toWorld(makerFrame, 0.13, surf + 0.012, TABLE_Z - 0.16, tmp), normal: tmpN.set(0, 1, 0) })
      maker.setLean(0.12, 0)
    }
    else {
      maker.setHandTarget('right', null)
      maker.setHandTarget('left', null)
      maker.setLean(0, 0)
    }
  }
  work(ctx.posterMode ? 0.3 : 0)

  const presets = [
    { label: 'the robot spot', p: SPOT_LOOK },
    { label: 'you', p: null as THREE.Vector3 | null },
    { label: 'the easel', p: new THREE.Vector3(-3.35, 1.0, 1.41) },
    { label: 'the pottery shelf', p: new THREE.Vector3(2.5, 0.8, -2.65) },
    { label: 'the kite', p: kiteAim },
  ]
  const toViewer = new THREE.Vector3()

  function lookTarget(i: number): THREE.Vector3 | null {
    if (pointerLook) return pointerLook
    if (time < presetUntil && lookPreset >= 0) {
      const pr = presets[lookPreset]!
      if (pr.p) return pr.p
      // "You": a point toward the camera, at head height.
      toViewer.copy(camera.position).sub(aim).setY(0).normalize().multiplyScalar(4).setY(1.5)
      return toViewer
    }
    if (i === KITE_HOLDER) return Math.sin(time * 0.25) > 0.2 ? kiteAim : SPOT_LOOK
    if (CAST[i]!.work) return null
    const b = CAST[i]!.script[dir[i]!.beat]!
    return b.a === 'idle' && i % 2 === 0 ? null : SPOT_LOOK
  }

  // ── Pointer helpers ───────────────────────────────────────────────────
  const ndc = new THREE.Vector2()
  const ray = new THREE.Raycaster()
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const gp = new THREE.Vector3()
  const lastGP = new THREE.Vector3()
  let lastMoveT = -1
  let hovered: Person | ArtProp | null = null

  function pick(p: SlotPointer): Person | ArtProp | null {
    ndc.set(p.ndc.x, p.ndc.y)
    ray.setFromCamera(ndc, camera)
    for (const pr of props) if (pr.hit(ray)) return pr
    for (const pe of people) if (pe.hit(ray)) return pe
    return null
  }

  function setHover(h: Person | ArtProp | null) {
    if (h === hovered) return
    hovered?.setSelected(false)
    hovered = h
    hovered?.setSelected(true)
  }

  function nearestPerson(x: number, z: number) {
    let best = 0, bd = Infinity
    people.forEach((p, i) => {
      if (CAST[i]!.work) return
      const d = Math.hypot(p.position.x - x, p.position.z - z)
      if (d < bd) { bd = d; best = i }
    })
    return best
  }

  function personReact(i: number) {
    if (i === KITE_HOLDER) return kite.react()
    const a: Action = tapToggle++ % 2 === 0 ? 'wave' : 'clap'
    if (CAST[i]!.work) workPause[i] = time + 3.2
    people[i]!.play(a)
    return a === 'wave' ? 'A visitor waves.' : 'A visitor claps.'
  }

  function override(i: number, a: Action, o: PlayOptions, secs: number) {
    dir[i]!.override = time + secs
    people[i]!.play(a, o)
  }

  const ropeA = new THREE.Vector3(), ropeB = new THREE.Vector3(), ropeC = new THREE.Vector3(), ropeD = new THREE.Vector3()
  const toCam = new THREE.Vector3(), side = new THREE.Vector3()
  function updateRope() {
    const p = people[PULLER]!
    const a = ropePos.array as Float32Array
    ropeA.copy(STAKE).setY(0.19)
    p.handWorld('right', ropeB)
    p.handWorld('left', ropeC)
    // The hand nearer the stake holds the rope first.
    if (ropeB.distanceTo(STAKE) > ropeC.distanceTo(STAKE)) { side.copy(ropeB); ropeB.copy(ropeC); ropeC.copy(side) }
    // Tail: from the rear hand down to the ground behind the hauler.
    ropeD.set(p.position.x - Math.sin(p.heading) * 0.35 + 0.1, 0.01, p.position.z - Math.cos(p.heading) * 0.35)
    const pts = [ropeA, ropeB, ropeC, ropeD]
    toCam.subVectors(camera.position, aim).normalize()
    for (let i = 0; i < ROPE_PTS; i++) {
      const prev = pts[Math.max(0, i - 1)]!, next = pts[Math.min(ROPE_PTS - 1, i + 1)]!
      side.subVectors(next, prev).cross(toCam).normalize().multiplyScalar(0.011)
      const q = pts[i]!
      a.set([q.x - side.x, q.y - side.y, q.z - side.z, q.x + side.x, q.y + side.y, q.z + side.z], i * 6)
    }
    ropePos.needsUpdate = true
    rope.visible = p.action === 'pull-rope'
  }

  return {
    scene,
    camera,
    step(dt) {
      if (!ctx.posterMode) time += dt
      if (!ctx.posterMode && !paused) {
        dir.forEach((d, i) => {
          if (CAST[i]!.work) return
          const p = people[i]!
          if (time < d.override || p.busy) return
          d.t += dt
          const script = CAST[i]!.script
          if (d.t >= script[d.beat]!.d) {
            d.t = 0
            d.beat = (d.beat + 1) % script.length
            stance(i, script[d.beat]!)
          }
        })
        for (let k = pendingShots.length - 1; k >= 0; k--) {
          const s = pendingShots[k]!
          if (time >= s.at) {
            people[s.who]!.play(s.a)
            pendingShots.splice(k, 1)
          }
        }
      }
      if (!ctx.posterMode) work(time)
      // The scene owns the rope's phase: the hauler's hands follow it.
      if (people[PULLER]!.action === 'pull-rope') people[PULLER]!.setRopePhase((time / 1.7) % 1)
      kiteAim.set(kite.sim.p[0], kite.sim.p[1], kite.sim.p[2])
      people.forEach((p, i) => {
        p.lookAt(lookTarget(i))
        p.step(dt)
      })
      // A resting pointer: the look returns to the scene after a few seconds.
      if (pointerLook && lastMoveT >= 0 && time - lastMoveT > 4) pointerLook = null
      kite.setAnchor(holder.handWorld('right', hand))
      for (const pr of props) pr.step(dt)
    },
    frame(alpha) {
      for (const p of people) p.frame(alpha)
      for (const pr of props) pr.frame(alpha)
      updateRope()
    },
    resize(w, h) {
      const aspect = w / Math.max(1, h)
      if (closeUp) {
        fitOrtho(camera, w, h, closeUp)
        return
      }
      // Wide: the whole fair. Narrow (a phone): the group, with the props cropped at the sides.
      fitOrtho(camera, w, h, Math.max(5.6, 4.6 / aspect))
    },
    pointer(p: SlotPointer) {
      if (paused) return
      if (p.kind === 'leave') {
        pointerLook = null
        setHover(null)
        lastMoveT = -1
        return
      }
      ndc.set(p.ndc.x, p.ndc.y)
      ray.setFromCamera(ndc, camera)
      const onGround = ray.ray.intersectPlane(ground, gp)
      if (p.kind === 'move') {
        if (ctx.coarse) return
        setHover(pick(p))
        if (onGround) {
          // Pointer motion is wind for the hanging things, fading with distance.
          if (lastMoveT >= 0) {
            const dtm = Math.max(0.016, time - lastMoveT)
            const vx = (gp.x - lastGP.x) / dtm, vz = (gp.z - lastGP.z) / dtm
            for (const pr of [mobile, lantern]) {
              const d = Math.hypot(gp.x - pr.root.position.x, gp.z - pr.root.position.z)
              const k = Math.max(0, 1 - d / 2.2)
              if (k > 0) pr.wind?.(vx * k, vz * k)
            }
          }
          lastGP.copy(gp)
          lastMoveT = time
          pointerLook = (pointerLook ?? new THREE.Vector3()).copy(gp).setY(0.25)
        }
        return
      }
      const hit = pick(p)
      if (hit && 'kind' in hit) {
        hit.react(ray)
        return
      }
      if (hit) {
        personReact(people.indexOf(hit as Person))
        return
      }
      if (onGround) {
        pointerLook = (pointerLook ?? new THREE.Vector3()).copy(gp).setY(0.2)
        lastMoveT = time
        override(nearestPerson(gp.x, gp.z), 'point', { target: pointerLook.clone() }, 3.5)
      }
    },
    setPaused(p) {
      paused = p
      pendingShots.length = 0
      pointerLook = null
      setHover(null)
      for (const pe of people) pe.setPaused(p)
      for (const pr of props) pr.setPaused(p)
    },
    action(name) {
      if (paused) return null
      switch (name) {
        case 'wave': {
          const order = [0, 4, SAWYER, MAKER, PULLER]
          return personReact(order[waveTurn++ % order.length]!)
        }
        case 'clap':
          people.forEach((p, i) => {
            if (CAST[i]!.work) return
            pendingShots.push({ at: time + p.motion.reaction, who: i, a: 'clap' })
          })
          return 'The group claps.'
        case 'point':
          people.forEach((_, i) => {
            if (CAST[i]!.work || i === PULLER) return
            override(i, 'point', { target: SPOT_LOOK }, 4)
          })
          return 'Everyone points at the robot.'
        case 'look-here': {
          lookPreset = (lookPreset + 1) % presets.length
          presetUntil = time + 5
          pointerLook = null
          return `Everyone looks at ${presets[lookPreset]!.label}.`
        }
        case 'plot': return easel.react()
        case 'mobile': return mobile.react()
        case 'kite': return kite.react()
        case 'pots': return pottery.react()
        case 'lantern': return lantern.react()
        default: return null
      }
    },
    dispose() {
      for (const p of people) p.dispose()
      for (const pr of props) pr.dispose()
      // Assembly output (merged per build) is this scene's too.
      for (const g of builtGroups) g.traverse((o) => { const geo = (o as THREE.Mesh).geometry; if (geo) owned.push(geo) })
      owned.forEach(g => g.dispose())
      ownedMats.forEach(m => m.dispose())
    },
  }
}
