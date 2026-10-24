import * as THREE from 'three'
import { DT } from '../../core/clock'
import { addLights, disposeGeometries } from '../../core/kit'
import { nextTask, type SceneContext, type SceneInstance, type SlotPointer } from '../../core/stage'
import { buildBoom, buildGround, buildStones, boomProxies } from './cheenavala'
import { createCrew } from './crew'
import { DUR, PERIOD, THETA_DOWN, THETA_UP, thetaAt } from './cycle'
import { STROKES, TAIL, liftTimeAt, tailEnds } from './haul'
import { BASKET_SHOW, DROP_TIME, MAX_FISH, flapPose } from './catch'
import { FISH_INK, buildFishGeometry, fishBend } from './fish'
import {
  ANGLE, FOV_DEG, SHOTS, ShotFollower, WIDE_AZ, WIDE_DIR, WIDE_EL, basis as shotBasis, framingAt, newFraming,
  scrollShot, shotFramings, type Cast, type Framing,
} from './shots'
import type { Person } from '../../people/person'
import {
  BANK, BASKET, BOOM, CLUSTER_DEPTH, DECK, SCOOP, FULCRUM, HANG_LOCAL, NET, NUT_R, NUTS, PALMS, ROPES, STONES, TRUNK_TOP, WATER, YOKE_Y,
  boomToWorld, crownTilt, netCorners, netPoint, palmPoint, rotZ, type V3,
} from './layout'
import { buildPalm } from './palm'
import { BODIES, BRUSH_MAX, DROPS, LEAN_MAX, RINGS, WAVELETS, World } from './sim'
import { backwaterSound } from './sound'
import { CoconutPlayback, coconutPose, scrollCoconut } from './scroll-coconut'

/**
 * Fort Kochi backwater: a cheena vala dipping its net on a slow cycle, worked
 * by two fishers hauling on its red operating ropes, and coconut palms on the
 * bank swaying in the sea breeze, where a child flies a kite (crew.ts).
 *
 * The simulation (sim.ts) is plain numbers stepped at DT; this file only
 * builds the drawing once and, each frame, poses the rigid groups and
 * rewrites a few line buffers IN PLACE (net, water marks, ropes) -- no GPU
 * buffer is ever reallocated, only its contents and draw range. Tap a palm to drop a coconut, tap the net or boom
 * to start a dip, tap a person and they wave, tap the kite to tug it; the
 * keyboard equivalents are action('drop-nut'), action('dip'), action('wave'),
 * action('kite') and action('bonk') (the easter egg: crew.ts).
 *
 * Sound (sound.ts) is driven from here and nowhere else: one-shots from the
 * simulation's per-step events, the boom's creak from its drawn angular speed,
 * lapping while the pointer is over the water. The per-frame writers reuse
 * scratch vectors, so a running scene allocates nothing.
 */

type Target = 'boom' | number

const RSEG = 28
const NET_N = NET.grid
const SEED = 11
/** The boom's fastest swing (rad/s; the lowering's peak), for normalising the creak. */
const OMEGA_MAX = 0.34
/** A pointer crossing a crown faster than this (CSS px/s) brushes it. */
const SWEEP_SPEED = 900
/** Slots smaller than this (CSS px, either side) are previews and stay silent. */
const QUIET_BELOW = 160
/**
 * The poster's moment, in rope 0's haul phase (0 .. STROKES[0] / 2): past
 * halfway up, one hand mid-pull and the body at its furthest lean back (a
 * quarter into a stroke pair).
 */
const POSTER_HAUL = Math.floor(STROKES[0]! / 2 * 0.6) + 0.25

export default async function create(ctx: SceneContext): Promise<SceneInstance> {
  const m = ctx.materials
  const scene = new THREE.Scene()
  addLights(scene)

  // A perspective camera, placed by the scroll shots (shots.ts): low and
  // three-quarter on to the cheena vala in every one.
  const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 400)
  // The camera's direction (toward it); applyFraming keeps it current.
  const look = new THREE.Vector3(-1, 1.5, 0)
  const toCam = new THREE.Vector3(...WIDE_DIR).normalize()
  camera.position.copy(look).addScaledVector(toCam, 20)
  camera.lookAt(look)
  camera.updateMatrixWorld()

  const sim = new World(SEED)
  const sound = backwaterSound()
  const own: { dispose(): void }[] = []
  // Dev lab only: /lab/backwater?seek=<s> starts the simulation s seconds in,
  // so mid-cycle frames can be checked deterministically; &act=<name> runs a
  // keyboard action on the first step (e.g. act=bonk).
  let devAct: string | null = null
  if (import.meta.dev && !ctx.posterMode && typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search)
    const seek = Number(q.get('seek'))
    for (let i = 0; i < Math.min(seek, 60) / DT; i++) sim.step(DT)
    devAct = q.get('act')
  }
  // The poster is a still from the haul: run the simulation (deterministic, a
  // fixed number of steps from the seed) to that moment, in chunks.
  if (ctx.posterMode) {
    const until = liftTimeAt(0, POSTER_HAUL, thetaAt, DUR.lower + DUR.soak, DUR.lift)
    const steps = Math.round((((until - sim.cycle.t) % PERIOD) + PERIOD) % PERIOD / DT)
    for (let i = 0; i < steps; i++) {
      sim.step(DT)
      if (i % 600 === 599) await nextTask()
    }
  }

  // ── Static ground, boom, counterweight ────────────────────────────────
  // Built in pieces with a yield between each, so no one task blocks input.
  scene.add(buildGround(m))
  await nextTask()

  const pivot = new THREE.Group()
  pivot.position.set(...FULCRUM)
  pivot.rotation.y = Math.PI
  const tilt = new THREE.Group()
  pivot.add(tilt)
  const boom = buildBoom(m)
  tilt.add(boom)
  scene.add(pivot)
  const boomLines = boom.getObjectByName('boom:lines') as THREE.LineSegments

  const cluster = buildStones(m)
  scene.add(cluster)
  await nextTask()

  // ── Palms: one built, cloned (geometry shared) ─────────────────────────
  const parts = buildPalm(m)
  parts.geos.forEach(g => g.dispose())
  const palms = PALMS.map((spec, i) => {
    const root = new THREE.Group()
    root.position.set(...spec.base)
    root.rotation.y = spec.yaw
    root.scale.setScalar(spec.scale)
    const lean = new THREE.Group()
    lean.rotation.z = spec.lean
    const bend = new THREE.Group()
    const crownBase = new THREE.Group()
    crownBase.position.set(...TRUNK_TOP)
    crownBase.rotation.z = crownTilt(spec)
    const sway = new THREE.Group()
    const trunk = parts.trunk.clone()
    const crown = parts.crown.clone()
    // Vary the crowns a little without new geometry: each is turned differently.
    crown.rotation.y = i * 1.9
    root.add(lean)
    lean.add(bend)
    bend.add(trunk, crownBase)
    crownBase.add(sway)
    sway.add(crown)
    scene.add(root)
    const lines = [trunk, crown].map(g => g.children.find(c => (c as THREE.LineSegments).isLineSegments) as THREE.LineSegments)
    return { root, bend, sway, lines }
  })

  // ── Coconuts: one instanced mesh for every nut, plus an ink back-face hull for its outline ──
  const NUT_COUNT = PALMS.length * NUTS.length + BODIES
  const nutGeo = new THREE.IcosahedronGeometry(NUT_R, 1)
  nutGeo.scale(1, 0.9, 1)
  const hullGeo = nutGeo.clone().scale(1.13, 1.13, 1.13)
  const hullMat = new THREE.MeshBasicMaterial({ color: ctx.palette.ink, side: THREE.BackSide })
  own.push(hullMat)
  const nuts = new THREE.InstancedMesh(nutGeo, m.face.woodDark, NUT_COUNT)
  nuts.name = 'coconuts'
  nuts.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const hull = new THREE.InstancedMesh(hullGeo, hullMat, NUT_COUNT)
  hull.instanceMatrix = nuts.instanceMatrix
  nuts.frustumCulled = hull.frustumCulled = false
  scene.add(nuts, hull)

  // ── Dynamic line buffers, written in place every frame ─────────────────
  const lineBuffer = (segments: number, mat: THREE.Material, rgba = false) => {
    const g = new THREE.BufferGeometry()
    const pos = new THREE.BufferAttribute(new Float32Array(segments * 6), 3).setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('position', pos)
    let col: THREE.BufferAttribute | null = null
    if (rgba) {
      col = new THREE.BufferAttribute(new Float32Array(segments * 8), 4).setUsage(THREE.DynamicDrawUsage)
      g.setAttribute('color', col)
    }
    const seg = new THREE.LineSegments(g, mat)
    seg.frustumCulled = false
    scene.add(seg)
    return { seg, g, pos, col, arr: pos.array as Float32Array, carr: col?.array as Float32Array | undefined }
  }

  const netBuf = lineBuffer((NET_N + 1) * NET_N * 2, m.line)
  // One more line pass carries everything else that moves: the water marks
  // (faded), and in full ink the counterweight's hang ropes, the scoop net's
  // pole edges, hoop and bag, and every fish's outline. One draw call.
  const HOOP_SEG = 12
  const FISH_N = MAX_FISH + BASKET_SHOW
  const FISH_SEGS = FISH_INK.length
  const OVERLAY_SEGS = 1 + STONES.length + 2 + HOOP_SEG + 4 + FISH_N * FISH_SEGS
  const waterMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })
  own.push(waterMat)
  const WATER_SEGS = RINGS * RSEG + WAVELETS * 2 + DROPS
  const waterBuf = lineBuffer(WATER_SEGS + OVERLAY_SEGS, waterMat, true)
  const ink = new THREE.Color(ctx.palette.ink)

  // Operating ropes: red (the drive input), drawn as thin ribbons facing the
  // camera. Each is three straight runs: boom end to its block, the tail from
  // the block through the fisher's hands, and the hauled part down to the deck.
  const redMat = new THREE.MeshBasicMaterial({ color: ctx.palette.red, side: THREE.DoubleSide })
  own.push(redMat)
  const redGeo = new THREE.BufferGeometry()
  const RUNS = ROPES.length * 3
  const redPos = new THREE.BufferAttribute(new Float32Array(RUNS * 12), 3).setUsage(THREE.DynamicDrawUsage)
  redGeo.setAttribute('position', redPos)
  redGeo.setIndex(Array.from({ length: RUNS }, (_, i) => [0, 1, 2, 2, 1, 3].map(k => k + i * 4)).flat())
  const tails = ROPES.map((_, i) => tailEnds(i))
  /** Where a rope's tail lies when nobody holds it: from the block down to the deck beside the post. */
  const slack = ROPES.map((r, i) => new THREE.Vector3(r.to[0] + TAIL[i]![0] * 0.3, DECK.top + 0.01, r.to[2] + TAIL[i]![1] * 0.3))
  const red = new THREE.Mesh(redGeo, redMat)
  red.frustumCulled = false
  scene.add(red)

  const cyanLine = new THREE.LineBasicMaterial({ color: ctx.palette.cyan })
  own.push(cyanLine)
  await nextTask()

  // ── People: the fishers on the jetty, the bank, the kite ──────────────
  const crew = await createCrew(ctx, sim, nextTask)
  const storyNut = !ctx.posterMode && scrollCoconut.enabled ? [crew.bonkPalm, 0] as const : null
  sim.storyNut = storyNut
  const storyStart: V3 = storyNut ? [...sim.nutWorld(storyNut[0], storyNut[1])] : [0, 0, 0]
  const storyEnd: V3 = [storyStart[0] + 0.7, BANK.top + NUT_R * 0.9, storyStart[2] + 1]
  const coconutPlayback = new CoconutPlayback()
  scene.add(crew.deck, crew.bank, crew.kite.root)

  // ── Hit proxies (invisible boxes: raycast cheaply, never drawn) ─────────
  const bp = boomProxies()
  own.push(bp.mat)
  const proxies: THREE.Mesh[] = []
  for (const p of bp.meshes) {
    p.userData.target = 'boom'
    tilt.add(p)
    proxies.push(p)
  }
  palms.forEach((p, i) => {
    const crownBox = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.8, 4.6), bp.mat)
    crownBox.position.y = -0.1
    const trunkLen = Math.hypot(TRUNK_TOP[0], TRUNK_TOP[1])
    const trunkBox = new THREE.Mesh(new THREE.BoxGeometry(0.9, trunkLen, 0.9), bp.mat)
    trunkBox.position.set(TRUNK_TOP[0] / 2, TRUNK_TOP[1] / 2, 0)
    trunkBox.rotation.z = Math.atan2(-TRUNK_TOP[0], TRUNK_TOP[1])
    p.sway.add(crownBox)
    p.bend.add(trunkBox)
    crownBox.userData.crown = true
    for (const b of [crownBox, trunkBox]) {
      b.visible = false
      b.userData.target = i
      proxies.push(b)
    }
  })

  const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z]

  // ── Shots: the scroll-driven camera (shots.ts) ─────────────────────────
  // The cast for the detail shots, read once from where the people stand.
  const figure = (p: Person, y: number) => ({ x: p.position.x, y, z: p.position.z, h: p.dims.H })
  const cast: Cast = {
    fishers: crew.fishers.map(p => figure(p, DECK.top)),
    bank: crew.bankPeople.map(p => figure(p, BANK.top)),
    kite: crew.fitPoints.map(v3),
  }
  const follower = new ShotFollower()
  if (import.meta.dev && !ctx.posterMode && typeof location !== 'undefined') {
    const q = Number(new URLSearchParams(location.search).get('shot'))
    if (q) scrollShot.progress = q
  }
  follower.jump(ctx.posterMode ? 0 : scrollShot.progress)
  let sPrev = follower.s
  let sCur = follower.s
  const frames = SHOTS.map(() => newFraming())
  const fr = newFraming()
  let aspect = 1
  const tgt = new THREE.Vector3()

  function applyFraming(f: Framing) {
    const b = shotBasis(f.az, f.el)
    toCam.set(b.dir[0], b.dir[1], b.dir[2])
    tgt.set(f.target[0], f.target[1], f.target[2])
    camera.position.copy(tgt).addScaledVector(toCam, f.dist)
    camera.up.set(0, 1, 0)
    camera.lookAt(tgt)
    camera.fov = FOV_DEG
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
  }

  /** The camera for smoothed progress s (the shot framings hold still; only scrolling moves the camera). */
  function frameShot(s: number) {
    if (s === lastS) return
    lastS = s
    applyFraming(framingAt(s, frames, fr))
  }
  let lastS = NaN

  function fit(w: number, h: number) {
    aspect = w / Math.max(1, h)
    // The wide shot holds the whole cheena vala at any shape; the people get their own shots.
    shotFramings(cast, aspect, frames)
    lastS = NaN
    frameShot(sCur)
  }

  // ── Pointer ───────────────────────────────────────────────────────────
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  let hover: Target | null = null
  // Sideways on screen in the wide view: the direction a passing hand pushes a crown.
  const camRight = new THREE.Vector3(...shotBasis(WIDE_AZ, WIDE_EL).right)
  /** Whether the last pick() hit a crown (not a trunk): only crowns rustle when swept. */
  let hitCrown = false

  /** A person (index) or the kite (-2) under the pointer, else -1; sets the ray for pick(). */
  function pickCrew(p: SlotPointer) {
    ndc.set(p.ndc.x, p.ndc.y)
    ray.setFromCamera(ndc, camera)
    return crew.pick(ray)
  }

  /** Boom/net or a palm under the ray set by pickCrew(). */
  function pick(): Target | null {
    const hit = ray.intersectObjects(proxies, false)[0]
    hitCrown = !!hit?.object.userData.crown
    return hit ? hit.object.userData.target as Target : null
  }

  // The open water (not the bank, not the boom or palms in front of it) under
  // the ray of the last pick(): hovering it brings up the lapping.
  const surface = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const hitV = new THREE.Vector3()
  function overWater() {
    if (!ray.ray.intersectPlane(surface, hitV)) return false
    return hitV.x >= WATER.x0 && hitV.x < BANK.x0 && hitV.z >= WATER.z0 && hitV.z <= WATER.z1
  }

  function setHover(t: Target | null) {
    if (t === hover) return
    hover = t
    boomLines.material = netBuf.seg.material = t === 'boom' ? cyanLine : m.line
    palms.forEach((p, i) => p.lines.forEach((l) => { l.material = t === i ? cyanLine : m.line }))
  }

  const tmpV = new THREE.Vector3()
  const crownCentres = PALMS.map(spec => new THREE.Vector3(...palmPoint(spec, [0, 0], [0, 0], [0, 0, 0])))
  /**
   * The crown nearest the pointer sways away from it, as if from a passing
   * hand: full strength (LEAN_MAX, eased in by the sim) close to the crown,
   * fading out by ~0.45 of the view's height away.
   */
  function leanAway(p: SlotPointer) {
    const aspect = camera.aspect
    let best = -1
    let bestD = 0.45
    let dx = 0
    for (let i = 0; i < PALMS.length; i++) {
      tmpV.copy(crownCentres[i]!).project(camera)
      const d = Math.hypot((p.ndc.x - tmpV.x) * aspect, p.ndc.y - tmpV.y)
      if (d < bestD) {
        bestD = d
        best = i
        dx = (p.ndc.x - tmpV.x) * aspect
      }
    }
    if (best < 0) return sim.setLean(-1, 0, 0)
    const u = Math.min(1, Math.max(0, (bestD - 0.15) / 0.3))
    const amt = -Math.sign(dx) * Math.min(1, Math.abs(dx) / 0.06) * (1 - u * u * (3 - 2 * u)) * LEAN_MAX
    sim.setLean(best, camRight.x * amt, camRight.z * amt)
  }

  /** Shake a palm (tap or key): a flick of its crown and the fronds' rustle. */
  function shake(palm: number, dir: number, strength: number) {
    const k = dir * BRUSH_MAX * strength
    sim.requestBrush(palm, camRight.x * k, camRight.z * k)
    sound.rustle(strength)
  }

  // Pointer speed across a crown, for the sweep rustle.
  let lastX = 0
  let lastY = 0
  let lastT = -1
  const brushedAt = PALMS.map(() => -1)
  function sweep(p: SlotPointer, t: Target | null) {
    const now = performance.now()
    const dts = (now - lastT) / 1000
    if (lastT >= 0 && dts > 0 && dts < 0.1 && typeof t === 'number' && hitCrown && now - brushedAt[t]! > 250) {
      const v = Math.hypot(p.x - lastX, p.y - lastY) / dts
      if (v > SWEEP_SPEED) {
        brushedAt[t] = now
        shake(t, p.x >= lastX ? 1 : -1, 0.4 + 0.6 * Math.min(1, v / 2500))
      }
    }
    lastX = p.x
    lastY = p.y
    lastT = now
  }

  // ── Per-frame writers ─────────────────────────────────────────────────
  // Scratch for the per-frame writers: nothing below allocates.
  const corners: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const hangW: V3 = [0, 0, 0]
  const tmp3: V3 = [0, 0, 0]
  const sway2: [number, number] = [0, 0]
  const bend2: [number, number] = [0, 0]
  let o = 0
  function put3(a: Float32Array, p: V3) {
    a[o++] = p[0]
    a[o++] = p[1]
    a[o++] = p[2]
  }

  const grid: V3[] = Array.from({ length: (NET_N + 1) ** 2 }, () => [0, 0, 0] as V3)
  function writeNet(th: number, sag: number) {
    const c = netCorners(th, corners)
    for (let i = 0; i <= NET_N; i++) {
      for (let j = 0; j <= NET_N; j++) netPoint(c, i / NET_N, j / NET_N, sag, grid[i * (NET_N + 1) + j]!)
    }
    const a = netBuf.arr
    o = 0
    for (let i = 0; i <= NET_N; i++) {
      for (let j = 0; j < NET_N; j++) {
        put3(a, grid[i * (NET_N + 1) + j]!)
        put3(a, grid[i * (NET_N + 1) + j + 1]!)
        put3(a, grid[j * (NET_N + 1) + i]!)
        put3(a, grid[(j + 1) * (NET_N + 1) + i]!)
      }
    }
    netBuf.pos.needsUpdate = true
  }

  const ropeA = new THREE.Vector3()
  const ropeB = new THREE.Vector3()
  /** A point of the hanging cluster's ropes: (x, y) in the hang frame, swung by phi (into the overlay lines). */
  function putRope(x: number, y: number, phi: number) {
    tmp3[0] = x
    tmp3[1] = y
    tmp3[2] = 0
    const r = rotZ(tmp3, phi, tmp3)
    put(hangW[0] + r[0], hangW[1] + r[1], hangW[2] + r[2], 1)
  }
  /** Both edges of a ribbon end at p. */
  function putRibbon(a: Float32Array, p: THREE.Vector3, side: THREE.Vector3) {
    a[o++] = p.x + side.x
    a[o++] = p.y + side.y
    a[o++] = p.z + side.z
    a[o++] = p.x - side.x
    a[o++] = p.y - side.y
    a[o++] = p.z - side.z
  }
  const ribbonTo = new THREE.Vector3()
  const sHoop = new THREE.Vector3()
  const sButt = new THREE.Vector3()
  const sDir = new THREE.Vector3()
  const sSide = new THREE.Vector3()
  const sU = new THREE.Vector3()
  const sV = new THREE.Vector3()
  const sP = new THREE.Vector3()
  const putV = (v: THREE.Vector3) => put(v.x, v.y, v.z, 1)

  // ── Small solid parts in one instanced box mesh (colour per instance):
  // the scoop's pole and the segments of its hoop, and the fish's tail fins.
  const boxGeo = new THREE.BoxGeometry(1, 1, 1)
  const propMat = m.face.light.clone()
  propMat.color.set('#ffffff')
  own.push(propMat)
  const PROP_POLE = 0
  const PROP_HOOP = 1
  const PROP_N = PROP_HOOP + HOOP_SEG
  const props = new THREE.InstancedMesh(boxGeo, propMat, PROP_N)
  props.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  props.frustumCulled = false
  const cWood = new THREE.Color(ctx.palette.woodDark)
  for (let i = 0; i < PROP_N; i++) props.setColorAt(i, cWood)
  scene.add(props)
  const pM = new THREE.Matrix4()
  const pQ = new THREE.Quaternion()
  const pS = new THREE.Vector3()
  const pX = new THREE.Vector3(1, 0, 0)

  /** The scoop net, interpolated between steps: a solid pole, a hoop of short pieces, a bag of lines. */
  function writeScoop() {
    const sc = crew.scoop
    sHoop.lerpVectors(sc.prevHoop, sc.hoop, frameAlpha)
    sButt.lerpVectors(sc.prevButt, sc.butt, frameAlpha)
    sDir.subVectors(sHoop, sButt).normalize()
    // Pole: butt to the hoop's rim, 4.5 cm thick, with its two edges inked.
    const tip = sP.copy(sHoop).addScaledVector(sDir, -SCOOP.hoopR)
    pQ.setFromUnitVectors(pX, sDir)
    pS.set(tip.distanceTo(sButt), 0.045, 0.045)
    props.setMatrixAt(PROP_POLE, pM.compose(fPos.addVectors(tip, sButt).multiplyScalar(0.5), pQ, pS))
    sSide.crossVectors(sDir, ribbonTo.subVectors(camera.position, sButt)).normalize().multiplyScalar(0.0225)
    for (const k of [1, -1]) {
      putV(fPos.copy(sButt).addScaledVector(sSide, k))
      putV(fPos.copy(tip).addScaledVector(sSide, k))
    }
    // The hoop: a ring square to the pole's vertical plane, at its end.
    sU.copy(sDir).setY(0).normalize()
    sV.set(-sU.z, 0, sU.x)
    const seg = 2 * Math.PI * SCOOP.hoopR / HOOP_SEG * 1.08
    for (let i = 0; i < HOOP_SEG; i++) {
      const a0 = i / HOOP_SEG * Math.PI * 2
      const a1 = (i + 1) / HOOP_SEG * Math.PI * 2
      const p0 = fPos.copy(sHoop).addScaledVector(sU, Math.cos(a0) * SCOOP.hoopR).addScaledVector(sV, Math.sin(a0) * SCOOP.hoopR)
      const p1 = sP.copy(sHoop).addScaledVector(sU, Math.cos(a1) * SCOOP.hoopR).addScaledVector(sV, Math.sin(a1) * SCOOP.hoopR)
      putV(p0)
      putV(p1)
      const d = tmpV.subVectors(p1, p0).normalize()
      pQ.setFromUnitVectors(pX, d)
      pS.set(seg, 0.028, 0.028)
      props.setMatrixAt(PROP_HOOP + i, pM.compose(p0.add(p1).multiplyScalar(0.5), pQ, pS))
    }
    // The bag: four lines from the rim to its bottom.
    for (let i = 0; i < 4; i++) {
      const an = i / 4 * Math.PI * 2 + 0.4
      putV(fPos.copy(sHoop).addScaledVector(sU, Math.cos(an) * SCOOP.hoopR).addScaledVector(sV, Math.sin(an) * SCOOP.hoopR))
      putV(fPos.copy(sHoop).setY(sHoop.y - 0.24))
    }
  }

  // ── Fish: silver-white bodies with dark backs (vertex colours), their
  // tails in the box mesh above, their outlines in the overlay lines ──
  const fishGeo = buildFishGeometry()
  const fishMat = m.face.light.clone()
  fishMat.color.set('#ffffff')
  fishMat.vertexColors = true
  fishMat.side = THREE.DoubleSide
  own.push(fishMat)
  const fishMesh = new THREE.InstancedMesh(fishGeo, fishMat, FISH_N)
  // Every instance gets its tail-bend weight from the start (the shader is built with it).
  for (let i = 0; i < FISH_N; i++) fishMesh.setMorphAt(i, { morphTargetInfluences: [0] } as unknown as THREE.Mesh)
  fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  fishMesh.frustumCulled = false
  scene.add(fishMesh)
  const fPos = new THREE.Vector3()
  const fQ = new THREE.Quaternion()
  const fQ2 = new THREE.Quaternion()
  const fS = new THREE.Vector3()
  const fAx = new THREE.Vector3()
  const fN = new THREE.Vector3()
  const fBk = new THREE.Vector3()
  const fUp = new THREE.Vector3(0, 1, 0)
  const fX = new THREE.Vector3(1, 0, 0)
  const fBasis = new THREE.Matrix4()
  const netDir = shotBasis(ANGLE.net.az, ANGLE.net.el).dir
  const netRight = new THREE.Vector3(...shotBasis(ANGLE.net.az, ANGLE.net.el).right)
  const fE = new THREE.Euler()
  const fM = new THREE.Matrix4()
  const flap3: [number, number, number] = [0, 0, 0]
  const fc: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const fp: V3 = [0, 0, 0]
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  /**
   * Fish lie on their sides: in the net's belly (only while it is up out of
   * the water), in the scoop's bag, or heaped in the basket. A flap is a quick
   * hop and twist of the body.
   */
  const ol = new THREE.Vector3()
  /** Per instance: how far the tail is bent (the geometry's one morph target, -1..1). */
  const bendOf = { morphTargetInfluences: [0] } as unknown as THREE.Mesh
  /** One fish: its instance (bent by the flick) and its ink outline, bent the same way. */
  function putFish(n: number, flick: number, ink = true) {
    fishMesh.setMatrixAt(n, fM)
    const k = flick / 0.9
    bendOf.morphTargetInfluences![0] = k
    fishMesh.setMorphAt(n, bendOf)
    // Ink only where nothing lies on top of it (a fish deeper in the heap has none).
    if (!ink) {
      for (let i = 0; i < FISH_SEGS * 2; i++) put(0, -50, 0, 0)
      return
    }
    for (const [x0, y0, z0, x1, y1, z1] of FISH_INK) {
      putV(ol.set(x0, y0, z0 + fishBend(x0) * k).applyMatrix4(fM))
      putV(ol.set(x1, y1, z1 + fishBend(x1) * k).applyMatrix4(fM))
    }
  }
  /**
   * The heap in the basket, two layers, as seen from the fishers' shot: per
   * place, along (its camera's right) and across (toward its camera) from the
   * basket's middle, depth below the rim, turn from lying along the view,
   * which way the head points, how far the tail is raised (a tail resting on
   * the rim), and the layer. Six fish at most; the top layer's two outer fish
   * hang their tails over the rim.
   */
  const HEAP: [number, number, number, number, 1 | -1, number, 0 | 1][] = [
    [0.0, -0.055, -0.065, 0.15, 1, 0, 0],
    [0.0, 0.05, -0.065, -0.1, -1, 0, 0],
    [0.0, 0.0, -0.05, 1.2, 1, 0, 0],
    [-0.075, -0.04, -0.022, 0.1, 1, 0.3, 1],
    [0.085, 0.04, -0.022, -0.25, -1, 0.4, 1],
    [0.0, 0.0, 0.0, 0.95, 1, 0, 1],
  ]
  /** A basket fish's length (m): a little smaller than the net's, so six fit. */
  const HEAP_LEN = 0.26
  const fishersB = shotBasis(ANGLE.fishers.az, ANGLE.fishers.el)
  const heapR = new THREE.Vector3(...fishersB.right).setY(0).normalize()
  const heapC = new THREE.Vector3(fishersB.dir[0], 0, fishersB.dir[2]).normalize()
  const dropEnd = new THREE.Matrix4()
  const dPos = new THREE.Vector3()
  const dQ = new THREE.Quaternion()
  const dS = new THREE.Vector3()
  /** How a tipped fish leaves the scoop: nose down, flank to the camera. */
  const dropStartQ = new THREE.Quaternion()
  {
    const a = new THREE.Vector3(0, -1, 0).addScaledVector(heapR, 0.4).normalize()
    const nrm = heapC.clone().addScaledVector(a, -heapC.dot(a)).normalize()
    dropStartQ.setFromRotationMatrix(new THREE.Matrix4().makeBasis(a, new THREE.Vector3().crossVectors(nrm, a), nrm))
  }
  /** The matrix of the fish in heap place k. */
  function heapPose(k: number, out: THREE.Matrix4) {
    const [al, ac, dy, yaw, head, tail] = HEAP[k]!
    fPos.set(BASKET.x, DECK.top + BASKET.h + dy, BASKET.z).addScaledVector(heapR, al).addScaledVector(heapC, ac)
    // Along the view (turned by yaw), head as given; the tail end raised by `tail`.
    fAx.copy(heapR).applyAxisAngle(fUp, yaw).multiplyScalar(head * Math.cos(tail))
    fAx.y = -Math.sin(tail)
    fAx.normalize()
    // Flank up, rolled a little toward the camera; back up.
    fN.copy(heapC).multiplyScalar(0.5).add(fUp)
    fN.addScaledVector(fAx, -fN.dot(fAx)).normalize()
    fBk.crossVectors(fN, fAx)
    if (fBk.y < 0) {
      fN.negate()
      fBk.negate()
    }
    fBasis.makeBasis(fAx, fBk, fN)
    fQ.setFromRotationMatrix(fBasis)
    fS.set(HEAP_LEN, HEAP_LEN, HEAP_LEN)
    return out.compose(fPos, fQ, fS)
  }
  function hideFish(n: number) {
    fishMesh.setMatrixAt(n, hidden)
    // Keep the line count fixed: degenerate segments at the origin draw nothing.
    for (let i = 0; i < FISH_SEGS * 2; i++) put(0, -50, 0, 0)
  }
  /**
   * Fish lie on their sides: in the net's belly (only while it is up out of
   * the water), in the scoop's bag, or heaped in the basket. A flap is a hop,
   * a twist of the body and a flick of the tail.
   */
  function writeFish(th: number, sag: number) {
    const fc4 = netCorners(th, fc)
    let n = 0
    for (const f of crew.catch.fish) {
      if (f.where === 'off' || (f.where === 'net' && !crew.netShown)) {
        hideFish(n++)
        continue
      }
      if (f.where === 'drop') {
        // Tipped from the scoop: falling (accelerating) from its mouth into the
        // basket's, turning onto its place on the heap, the tail thrashing.
        const u = Math.min(1, f.fall / DROP_TIME)
        heapPose(f.slot, dropEnd)
        dropEnd.decompose(dPos, dQ, dS)
        fPos.fromArray(f.drop).lerp(dPos, u * u)
        fQ.copy(dropStartQ).slerp(dQ, Math.min(1, u * 1.4))
        fM.compose(fPos, fQ, dS)
        putFish(n++, Math.sin(u * Math.PI * 3) * 0.6)
        continue
      }
      flapPose(f.flap, flap3)
      if (f.where === 'net') {
        const q = netPoint(fc4, f.u, f.v, sag, fp)
        fPos.set(q[0], q[1] + 0.035 + flap3[0], q[2])
      }
      else {
        fPos.copy(sHoop)
        fPos.y -= 0.14 - flap3[0]
      }
      // On its side, the flank rolled up toward the net shot's camera (fish
      // in a sagging net or a bag lie every which way): from the low camera a
      // fish lying flat is a sliver; tilted up, it shows its whole outline.
      // And lying more across the view than along it (within 35 deg), head
      // left or right, so none is seen end on.
      const across = 0.61 * Math.sin(f.yaw)
      const head = Math.cos(f.yaw) < 0 ? -1 : 1
      fAx.copy(netRight).applyAxisAngle(fUp, across).multiplyScalar(head)
      fN.set(netDir[0], 0, netDir[2]).normalize().multiplyScalar(0.9).add(fUp)
      fN.addScaledVector(fAx, -fN.dot(fAx)).normalize()
      fBk.crossVectors(fN, fAx)
      // Back up, belly down, whichever way the head points: then it shows its other flank.
      if (fBk.y < 0) {
        fN.negate()
        fBk.negate()
      }
      fBasis.makeBasis(fAx, fBk, fN)
      fQ.setFromRotationMatrix(fBasis).multiply(fQ2.setFromAxisAngle(fX, flap3[1]))
      fS.set(f.len, f.len, f.len)
      fM.compose(fPos, fQ, fS)
      putFish(n++, flap3[2])
    }
    // The heap in the basket, growing with the count (the fish still dropping in are drawn above).
    const shown = Math.min(BASKET_SHOW, crew.catch.settled)
    for (let k = 0; k < BASKET_SHOW; k++) {
      if (k >= shown) {
        hideFish(n++)
        continue
      }
      heapPose(k, fM)
      putFish(n++, 0, shown <= 3 || HEAP[k]![6] === 1)
    }
    fishMesh.instanceMatrix.needsUpdate = true
    if (fishMesh.morphTexture) fishMesh.morphTexture.needsUpdate = true
    props.instanceMatrix.needsUpdate = true
  }
  let frameAlpha = 1

  /** Hang ropes, scoop, fish: appended to the overlay lines after the water marks. */
  function writeOverlay(th: number, phi: number, sag: number) {
    boomToWorld(HANG_LOCAL, th, hangW)
    putRope(0, 0, phi)
    putRope(0, YOKE_Y, phi)
    for (const s of STONES) {
      putRope(s.x, YOKE_Y, phi)
      putRope(s.x, YOKE_Y - s.len, phi)
    }
    writeScoop()
    writeFish(th, sag)
    waterBuf.g.setDrawRange(0, o / 3)
    waterBuf.pos.needsUpdate = true
    waterBuf.col!.needsUpdate = true
  }

  function writeRopes(th: number, phi: number) {
    const ra = redPos.array as Float32Array
    const w = 0.03
    o = 0
    const run = (a: THREE.Vector3, b: THREE.Vector3, width: number) => {
      // Facing the camera (a perspective one: toward where it stands, from the run).
      const side = tmpV.subVectors(b, a).cross(ribbonTo.subVectors(camera.position, a)).normalize().multiplyScalar(width)
      putRibbon(ra, a, side)
      putRibbon(ra, b, side)
    }
    ROPES.forEach((rope, i) => {
      const f = boomToWorld(rope.from, th, tmp3)
      const t = tails[i]!
      run(ropeA.set(f[0], f[1], f[2]), ropeB.set(rope.to[0], rope.to[1], rope.to[2]), w)
      if (crew.ropeHeld[i]) {
        // Through the hands, then down to the deck beside him (clear of his legs).
        run(ropeA.copy(ropeB), ropeB.set(t.e[0], t.e[1], t.e[2]), w * 0.8)
        run(ropeA.copy(ropeB), ropeB.set(t.c[0], t.c[1], t.c[2]), w * 0.8)
      }
      else {
        // Let go: the tail drops from the block to the deck.
        run(ropeA.copy(ropeB), ropeB.copy(slack[i]!), w * 0.8)
        run(ropeA.copy(ropeB), ropeB, w * 0.8)
      }
    })
    redPos.needsUpdate = true
  }

  const ringCos = Array.from({ length: RSEG + 1 }, (_, k) => Math.cos(k / RSEG * Math.PI * 2))
  const ringSin = Array.from({ length: RSEG + 1 }, (_, k) => Math.sin(k / RSEG * Math.PI * 2))
  let co = 0
  function put(x: number, y: number, z: number, alpha: number) {
    const a = waterBuf.arr
    const c = waterBuf.carr!
    a[o++] = x
    a[o++] = y
    a[o++] = z
    c[co++] = ink.r
    c[co++] = ink.g
    c[co++] = ink.b
    c[co++] = alpha
  }
  function writeWater() {
    o = 0
    co = 0
    const Y = 0.004
    for (const w of sim.wavelets) {
      const al = 0.5 * Math.sin(Math.PI * w.age / w.life)
      const h = w.len / 2
      put(w.x - h, Y, w.z, al)
      put(w.x, Y, w.z - 0.05, al)
      put(w.x, Y, w.z - 0.05, al)
      put(w.x + h, Y, w.z, al)
    }
    for (const g of sim.rings) {
      if (!g.on) continue
      const tau = g.age / g.life
      const r = g.r0 + (g.R - g.r0) * (1 - (1 - tau) ** 2)
      const al = g.a0 * (1 - tau) ** 1.5
      for (let k = 0; k < RSEG; k++) {
        put(g.x + ringCos[k]! * r, Y, g.z + ringSin[k]! * r, al)
        put(g.x + ringCos[k + 1]! * r, Y, g.z + ringSin[k + 1]! * r, al)
      }
    }
    for (const d of sim.drops) {
      if (!d.on) continue
      const k = 0.035
      put(d.x, d.y, d.z, 0.75)
      put(d.x - d.vx * k, d.y - Math.min(d.vy * k, -0.05), d.z - d.vz * k, 0.75)
    }
  }

  const mtx = new THREE.Matrix4()
  const qt = new THREE.Quaternion()
  const sc = new THREE.Vector3()
  const ps = new THREE.Vector3()
  function writeNuts(alpha: number) {
    let n = 0
    for (let i = 0; i < PALMS.length; i++) {
      const slots = sim.palms[i]!.nuts
      for (let k = 0; k < slots.length; k++) {
        const nut = slots[k]!
        let s = nut.state === 'on' ? 1 : nut.state === 'grow' ? nut.grow * nut.grow * (3 - 2 * nut.grow) : 0
        const w = sim.nutWorld(i, k, alpha, tmp3)
        ps.set(w[0], w[1], w[2])
        qt.identity()
        if (storyNut?.[0] === i && storyNut[1] === k) {
          coconutPose(storyStart, storyEnd, coconutPlayback.progress, tmp3)
          ps.fromArray(tmp3)
          const turn = coconutPlayback.progress * 6
          qt.set(0, 0, Math.sin(turn), Math.cos(turn))
          s = 1
        }
        sc.setScalar(Math.max(s, 1e-4))
        nuts.setMatrixAt(n++, mtx.compose(ps, qt, sc))
      }
    }
    for (const b of sim.bodies) {
      const on = b.mode !== 'off'
      ps.set(b.px + (b.x - b.px) * alpha, b.py + (b.y - b.py) * alpha, b.pz + (b.z - b.pz) * alpha)
      qt.set(b.q[0], b.q[1], b.q[2], b.q[3])
      sc.setScalar(on ? Math.max(b.scale, 1e-4) : 1e-4)
      nuts.setMatrixAt(n++, mtx.compose(ps, qt, sc))
    }
    nuts.instanceMatrix.needsUpdate = true
  }

  let paused = false
  let dropTurn = 0
  let hoverWater = false

  // Dev only: lets the lab's capture scripts read the simulation and the catch.
  if (import.meta.dev && typeof window !== 'undefined') {
    const list = ((window as any).__backwaters ??= []) as unknown[]
    list.push({ sim, crew, scrollShot, follower, scrollCoconut, coconutPlayback, storyNut, nuts })
  }

  const inst: SceneInstance = {
    scene,
    camera,
    step(dt) {
      if (ctx.posterMode) return
      if (devAct) {
        inst.action!(devAct)
        devAct = null
      }
      sim.step(dt)
      // People after the simulation: their hands go where the rope is now.
      crew.step(dt)
      sPrev = sCur
      follower.step(dt, scrollShot.progress)
      sCur = follower.s
      if (storyNut) coconutPlayback.step(dt, scrollCoconut.progress, sCur >= 2.9)
      // Sounds for what this step made happen, at the step it happened.
      for (const e of sim.events) sound.event(e)
    },
    frame(alpha) {
      const a = ctx.posterMode ? 1 : alpha
      const th = sim.prevTheta + (sim.theta - sim.prevTheta) * a
      tilt.rotation.z = th
      const h = boomToWorld(HANG_LOCAL, th, hangW)
      const phi = sim.prevPhi + (sim.phi - sim.prevPhi) * a
      cluster.position.set(h[0], h[1], h[2])
      cluster.rotation.z = phi
      for (let i = 0; i < palms.length; i++) {
        const p = palms[i]!
        const st = sim.palms[i]!
        const s = sim.swayOf(st, a, sway2)
        const b = sim.bendOf(st, a, bend2)
        p.sway.rotation.set(s[0], 0, s[1])
        p.bend.rotation.set(b[0], 0, b[1])
      }
      frameShot(sPrev + (sCur - sPrev) * a)
      frameAlpha = a
      writeNet(th, sim.prevSag + (sim.sag - sim.prevSag) * a)
      writeRopes(th, phi)
      writeWater()
      writeOverlay(th, phi, sim.prevSag + (sim.sag - sim.prevSag) * a)
      writeNuts(a)
      crew.frame(a)
      if (!paused && !ctx.posterMode) sound.frame(Math.abs(sim.theta - sim.prevTheta) / DT / OMEGA_MAX, hoverWater)
    },
    resize(w, h) {
      fit(w, h)
      sound.setMuted(Math.min(w, h) < QUIET_BELOW)
    },
    pointer(p) {
      if (paused || ctx.posterMode) return
      if (p.kind === 'leave') {
        setHover(null)
        crew.setHover(-1)
        sim.setLean(-1, 0, 0)
        hoverWater = false
        lastT = -1
        sound.leave()
        return
      }
      // People and the kite stand in front of the boom and palms: they pick first.
      const who = pickCrew(p)
      const t = who === -1 ? pick() : null
      if (p.kind === 'tap') {
        if (who !== -1) crew.tap(who)
        else if (t === 'boom') {
          if (!sim.holdCycle) sim.requestDip()
        }
        else if (t !== null) {
          // The crew decides whether this one is the easter egg (aimed at the kite kid).
          crew.dropNut(t)
          shake(t, 1, 0.8)
        }
        return
      }
      if (ctx.coarse) return
      crew.setHover(who)
      setHover(t)
      leanAway(p)
      sweep(p, t)
      hoverWater = who === -1 && t === null && overWater()
    },
    setPaused(v) {
      paused = v
      crew.setPaused(v)
      if (v) {
        sim.clearInputs()
        setHover(null)
        crew.setHover(-1)
        hoverWater = false
        lastT = -1
        sound.silence()
      }
    },
    action(name) {
      if (name === 'dip') {
        switch (sim.phase) {
          case 'rest':
            if (sim.holdCycle) return 'Wait: the fisher is landing the catch'
            sim.requestDip()
            return 'Net lowered'
          case 'lower': return 'Net is already going down'
          case 'soak': return 'Net is in the water'
          default: return 'Net is coming up'
        }
      }
      if (name === 'drop-nut') {
        for (let k = 0; k < PALMS.length; k++) {
          const i = (dropTurn + k) % PALMS.length
          if (sim.hasNut(i) && sim.hasFreeBody()) {
            dropTurn = i + 1
            crew.dropNut(i)
            shake(i, 1, 0.8)
            return 'Coconut dropped'
          }
        }
        return 'No ripe coconuts yet'
      }
      if (paused) return null
      if (name === 'wave') return crew.wave()
      if (name === 'kite') return crew.tugKite()
      if (name === 'bonk') {
        // Easter egg on demand: a coconut from the child's palm, aimed at the child.
        if (crew.childState !== 'flying') return 'The child is busy just now.'
        if (!crew.dropNut(crew.bonkPalm, 2)) return 'No ripe coconuts on that palm yet'
        shake(crew.bonkPalm, 1, 0.8)
        return 'A coconut falls toward the child with the kite.'
      }
      return null
    },
    dispose() {
      sound.silence()
      // People share geometry between scenes: they dispose their own, first,
      // so the sweep below never reaches it.
      crew.dispose()
      disposeGeometries(scene)
      nutGeo.dispose()
      fishGeo.dispose()
      boxGeo.dispose()
      hullGeo.dispose()
      own.forEach(x => x.dispose())
    },
  }
  return inst
}
