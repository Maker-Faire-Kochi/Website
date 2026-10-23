import * as THREE from 'three'
import { EVENT_END, EVENT_START } from '../../../composables/useCountdown'
import { addLights, contactShadow, disposeGeometries } from '../../core/kit'
import { nextTask, type SceneContext, type SceneInstance, type SlotPointer } from '../../core/stage'
import { buildFrame, buildTrain, type Target } from './build'
import { DISPLAY_FONT, FlapBank, buildAtlas, displayFontReady } from './flaps'
import { MOTION, PIVOT, SHAFTS, outerR, shaftAngle, type ShaftId } from './gears'
import { gearText, hoverLabel } from './label'
import {
  AXLE_Y, BEAM, CASE, CRANK, FLAP, FLAP_Z, FOLIOT, LAYER, PLATE_X,
  board, display, plateToWorld, viewAngles,
} from './layout'
import { wheelPositions, wheels } from './odometer'
import { CRANK_PERIOD, EV, MachineSim, SNAP } from './sim'
import { Whirr, ratchet, tick } from './sound'

/**
 * The When chapter's machine: a hand-cranked gear train on a slotted side
 * frame drives a yellow split-flap counter that shows the real countdown to
 * the faire, DD HH MM SS. An anchor escapement lets the train through once a
 * second, and the seconds flap falls -- hinged at the card's middle, the old
 * figure's top half folding down over its bottom half to uncover the new one.
 *
 * Drag the red crank round its shaft to wind the counter ahead -- the train
 * spins, the flaps race -- and let go: it unwinds back to the true time. It
 * can never be wound back past now (a ratchet), and at rest it can never show
 * anything but the true time. Hover a gear: it lights cyan and the label
 * (label.ts) gives its tooth count and ratio.
 *
 * All motion is MachineSim (pure, fixed-step); this file only draws its
 * snapshots, interpolated between the last two steps.
 */

const CROSS = 'a, button, input, select, textarea, label, summary, [role="button"], [contenteditable], [data-scene-ignore]'

/** The When section's campaign blue, as sRGB bytes, and the darker blue of the room's horizon. */
const FIELD = '#2B19D9'
const HORIZON = '#2112A8'
const YELLOW = '#FFE86C'

export default async function create(ctx: SceneContext): Promise<SceneInstance> {
  const m = ctx.materials
  const scene = new THREE.Scene()
  addLights(scene)

  // Days left decide whether the counter needs a hundreds-of-days unit.
  const daysLeft = Math.floor((EVENT_START.getTime() - Date.now()) / 86400000)
  const list = wheels(daysLeft >= 100 ? 3 : 2)

  // The figures are set in the page's display face. Wait a moment for it;
  // if it is not in yet, draw with the stand-in and redraw when it lands.
  const fontLoad = typeof document !== 'undefined' && document.fonts
    ? document.fonts.load(DISPLAY_FONT).catch(() => [])
    : Promise.resolve([])
  await Promise.race([fontLoad, new Promise(resolve => setTimeout(resolve, 1200))])
  const atlas = buildAtlas()
  let disposed = false
  if (!displayFontReady()) fontLoad.then(() => !disposed && displayFontReady() && atlas.redraw())

  const shared = new Map<string, THREE.BufferGeometry>()
  // The campaign yellow, lit like every other face (the case must read as a
  // box). The kit's lights render a front face at about 0.8 of its colour
  // (linear), so the colour is lifted to match: the case's FRONT is exactly
  // the page's #FFE86C, its lid lighter and its side darker.
  const yellow = new THREE.MeshLambertMaterial({ color: new THREE.Color(YELLOW).multiplyScalar(1.25), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
  scene.add(await buildFrame(m, list, yellow))
  await nextTask()

  const train = await buildTrain(m, shared)
  scene.add(train.plate)
  await nextTask()

  const flaps = new FlapBank(list, atlas.material, m.line)
  scene.add(flaps.mesh, flaps.lines)

  const B = board(list)
  const shadow = contactShadow(m, 1)
  shadow.scale.set((B.x1 - B.x0) * 0.62, (B.z1 - B.z0) * 0.62, 1)
  shadow.position.set((B.x0 + B.x1) / 2, -B.t + 0.0005, (B.z0 + B.z1) / 2)
  scene.add(shadow)

  // ── Room ──────────────────────────────────────────────────────────────
  // The stage is full-bleed and the When section is the campaign blue, so
  // the machine stands in a blue room that runs past every screen edge. The
  // blue is a clip-space quad filling the slot, drawn first with no depth,
  // whose shader writes the sRGB bytes straight out (no lighting, colour
  // conversion or tone mapping) -- exactly the CSS blue, as the hero does its
  // yellow. NOT scene.background: that would leave the renderer's clear
  // colour blue for every other slot. Floor and wall are the same blue; one
  // darker-blue line where they meet makes them a room.
  const raw = parseInt(FIELD.slice(1), 16)
  const fieldMat = new THREE.ShaderMaterial({
    uniforms: { field: { value: new THREE.Vector3((raw >> 16 & 255) / 255, (raw >> 8 & 255) / 255, (raw & 255) / 255) } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.999, 1.0); }',
    fragmentShader: 'uniform vec3 field; void main() { gl_FragColor = vec4(field, 1.0); }',
    depthTest: false,
    depthWrite: false,
  })
  const field = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fieldMat)
  field.frustumCulled = false
  field.renderOrder = -10
  scene.add(field)
  const ROOM = { back: B.z0 - 0.45, half: 40 }
  const floorY = -B.t
  const horizonMat = new THREE.LineBasicMaterial({ color: HORIZON, toneMapped: false })
  const horizon = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-ROOM.half, floorY, ROOM.back),
    new THREE.Vector3(ROOM.half, floorY, ROOM.back),
  ]), horizonMat)
  horizon.frustumCulled = false
  scene.add(horizon)

  // ── Camera ────────────────────────────────────────────────────────────
  // Orthographic three-quarter view from the front right: the cards nearly
  // square-on, the side frame's gears turned enough to read as wheels. The
  // angle follows the frame's shape (viewAngles in layout.ts).
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80)

  /**
   * Extreme points kept in frame: the base board, the case, a flap at the
   * full reach of its fall, the side frame's gears and escapement, and the
   * crank grip anywhere on its sweep (the clock turns it once a minute, so
   * every angle is drawn sooner or later).
   */
  const pts: THREE.Vector3[] = []
  const P = (x: number, y: number, z: number) => pts.push(new THREE.Vector3(x, y, z))
  for (const x of [B.x0, B.x1]) for (const y of [-B.t, 0]) for (const z of [B.z0, B.z1]) P(x, y, z)
  const D = display(list)
  for (const x of D.caseX) for (const y of [D.caseY[0], D.caseY[1] + 0.07]) for (const z of [CASE.back, CASE.front]) P(x, y, z)
  for (const gb of D.groups) for (const x of [gb.x0, gb.x1]) P(x, gb.hinge, FLAP_Z + FLAP.half + FLAP.split / 2)
  const rA = outerR(36)
  const plateTop = Math.max(SHAFTS.X.y + rA, PIVOT.y + FOLIOT.weightR)
  for (const lx of [SHAFTS.X.x - rA, SHAFTS.K.x + rA]) {
    for (const ly of [0, plateTop]) for (const lz of [-3 * BEAM.t, LAYER[2]! + 0.02]) P(...plateToWorld(lx, ly, lz))
  }
  for (const s of [1, -1]) P(...plateToWorld(PIVOT.x + s * (FOLIOT.half + FOLIOT.weightR), PIVOT.y, FOLIOT.z + 0.03))
  for (let k = 0; k < 16; k++) {
    const a = k * Math.PI / 8
    const r = CRANK.arm + 0.013
    P(...plateToWorld(SHAFTS.K.x + r * Math.cos(a), SHAFTS.K.y + r * Math.sin(a), CRANK.z + 0.007 + CRANK.grip))
  }
  /** The display's centre: what a wide stage centres on. */
  const rowCentre = new THREE.Vector3((D.caseX[0] + D.caseX[1]) / 2, (D.caseY[0] + D.caseY[1]) / 2, CASE.front)

  function view(aspect: number) {
    const { az, el } = viewAngles(aspect)
    const c = new THREE.Vector3((B.x0 + B.x1) / 2, AXLE_Y, (B.z0 + B.z1) / 2)
    camera.position.copy(c).add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(30))
    camera.lookAt(c)
    camera.updateMatrixWorld()
  }

  let W = ctx.width
  let H = ctx.height
  const p3 = new THREE.Vector3()
  /**
   * Fit every extreme point with a small margin. Where the stage has width
   * to spare, the card row goes to the centre and the train takes the room
   * on its right; otherwise the row moves only as far off centre as it must
   * for the train to stay in frame.
   */
  function fit(w: number, h: number) {
    W = w
    H = h
    const aspect = w / Math.max(1, h)
    view(aspect)
    const inv = camera.matrixWorldInverse
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const pt of pts) {
      p3.copy(pt).applyMatrix4(inv)
      x0 = Math.min(x0, p3.x)
      x1 = Math.max(x1, p3.x)
      y0 = Math.min(y0, p3.y)
      y1 = Math.max(y1, p3.y)
    }
    const pad = 0.02 * Math.max(x1 - x0, y1 - y0)
    x0 -= pad
    x1 += pad
    y0 -= pad
    y1 += pad
    let vw = x1 - x0
    let vh = y1 - y0
    if (vw / vh > aspect) vh = vw / aspect
    else vw = vh * aspect
    const rc = p3.copy(rowCentre).applyMatrix4(inv).x
    const cx = Math.min(x0 + vw / 2, Math.max(x1 - vw / 2, rc))
    const cy = (y0 + y1) / 2
    camera.left = cx - vw / 2
    camera.right = cx + vw / 2
    camera.top = cy + vh / 2
    camera.bottom = cy - vh / 2
    camera.updateProjectionMatrix()
  }
  fit(W, H)

  // ── State ─────────────────────────────────────────────────────────────
  const sim = new MachineSim({ startMs: EVENT_START.getTime(), endMs: EVENT_END.getTime(), now: () => Date.now() })
  let prev = sim.snapshot(new Float64Array(SNAP.size))
  let cur = sim.snapshot(new Float64Array(SNAP.size))
  const v = new Float64Array(SNAP.size)
  const pos = new Float64Array(list.length)
  const whirr = new Whirr()
  let paused = false

  // Poster: a fixed still pose -- the counter on zeros (any real reading
  // would be stale by the time a poster is seen) with the seconds flap caught
  // on its way down, so a still says "split-flap" at a glance; the train turned
  // so the red crank stands up and back, clear of its wheel's silhouette.
  const POSTER = new Float64Array(SNAP.size)
  POSTER[SNAP.g] = ((((110 * Math.PI / 180 - MOTION.K.phase) / (2 * Math.PI)) * MOTION.K.period) % MOTION.K.period + MOTION.K.period) % MOTION.K.period
  POSTER[SNAP.count] = 0.7

  // The nameplate reads OPENS ... / OPEN NOW / THANK YOU with the event's phase.
  let platePhase = 'upcoming'

  function draw(alpha: number) {
    const s = ctx.posterMode ? POSTER : v
    if (!ctx.posterMode) for (let i = 0; i < SNAP.size; i++) v[i] = prev[i]! + (cur[i]! - prev[i]!) * alpha
    const g = s[SNAP.g]!
    for (const id of ['O', 'M', 'K', 'X'] as ShaftId[]) train.shafts[id].rotation.z = shaftAngle(id, g)
    train.anchor.rotation.z = s[SNAP.swing]!
    wheelPositions(s[SNAP.count]!, list, pos)
    flaps.set(pos)
    const phase = ctx.posterMode ? 'upcoming' : sim.phase()
    if (phase !== platePhase) {
      platePhase = phase
      flaps.setPlate(phase)
    }
    if (hovered) placeLabel(hovered)
  }

  // ── Hover, drag ───────────────────────────────────────────────────────
  const meshes = [...train.targets.keys()]
  const original = new Map<THREE.Mesh, THREE.Material>(meshes.map(mesh => [mesh, mesh.material as THREE.Material]))
  let hovered: Target | null = null
  let dragging = false
  let shownFor = 0
  const paint = () => {
    for (const mesh of meshes) {
      const t = train.targets.get(mesh)!
      // Red is the force being applied: the crank stays red while it is held.
      if (t === 'crank' && dragging) mesh.material = original.get(mesh)!
      else mesh.material = t === hovered ? m.face.cyan : original.get(mesh)!
    }
  }
  const world = new THREE.Vector3()
  function placeLabel(t: Target) {
    const c = train.centre[t]
    world.set(...c)
    train.plate.localToWorld(world)
    world.project(camera)
    hoverLabel.x = (world.x + 1) / 2 * W
    hoverLabel.y = (1 - world.y) / 2 * H
  }
  const highlight = (t: Target | null) => {
    if (t === hovered) return
    hovered = t
    paint()
    hoverLabel.visible = Boolean(t)
    hoverLabel.text = t ? gearText(t) : ''
    if (t) placeLabel(t)
  }

  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const pick = (p: SlotPointer): Target | null => {
    ndc.set(p.ndc.x, p.ndc.y)
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObjects(meshes, false)[0]
    return hit ? train.targets.get(hit.object as THREE.Mesh) ?? null : null
  }
  // The crank's plane of rotation, for turning a pointer position into a crank angle.
  const crankPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -(PLATE_X + CRANK.z))
  const hitP = new THREE.Vector3()
  const crankAngle = (p: SlotPointer): number | null => {
    ndc.set(p.ndc.x, p.ndc.y)
    ray.setFromCamera(ndc, camera)
    if (!ray.ray.intersectPlane(crankPlane, hitP)) return null
    return Math.atan2(hitP.y - SHAFTS.K.y, -hitP.z - SHAFTS.K.x)
  }
  let lastAngle: number | null = null
  let lastMove: SlotPointer | null = null

  const startDrag = () => {
    dragging = true
    sim.beginDrag()
    lastAngle = lastMove ? crankAngle(lastMove) : null
    highlight(null)
    paint()
  }
  const endDrag = () => {
    if (!dragging) return
    dragging = false
    lastAngle = null
    sim.endDrag()
    paint()
  }

  // The stage forwards move / tap / leave only; a drag needs the button state,
  // so it comes from the window (released anywhere, even outside the slot).
  const onDown = (e: PointerEvent) => {
    if (paused || ctx.coarse || e.pointerType === 'touch') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as Element | null)?.closest?.(CROSS)) return
    // Gear A is on the crank shaft: grabbing it winds the crank too (a bigger target).
    if (hovered === 'crank' || hovered === 'A') startDrag()
  }
  const onUp = () => endDrag()
  if (!ctx.posterMode && typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointerup', onUp, { passive: true })
    window.addEventListener('pointercancel', onUp, { passive: true })
  }

  const runCrank = (): string | null => {
    if (sim.phase() === 'ended') return 'The faire is over; the counter is at rest'
    if (!sim.crank()) return null
    return 'Cranking three turns: the counter runs three minutes ahead, then returns'
  }

  draw(1)

  return {
    scene,
    camera,
    step(dt) {
      if (ctx.posterMode) return
      sim.step(dt)
      const t = prev
      prev = cur
      cur = sim.snapshot(t)
      if (sim.jumped) prev.set(cur)
      const ev = sim.takeEvents()
      if (ev & EV.TICK) tick(Math.floor(sim.rem()) % 2 !== 0)
      if (ev & EV.RELEASE) ratchet(true)
      if (ev & EV.RATCHET) ratchet(false)
      if (shownFor > 0) {
        shownFor -= dt
        if (shownFor <= 0) highlight(null)
      }
    },
    frame(alpha) {
      draw(ctx.posterMode ? 1 : alpha)
      if (!paused && !ctx.posterMode) {
        if (sim.mode !== 'idle') whirr.set(sim.speed / CRANK_PERIOD)
        else whirr.stop()
      }
    },
    resize(w, h) {
      fit(w, h)
      if (hovered) placeLabel(hovered)
    },
    pointer(p) {
      if (ctx.posterMode) return
      if (p.kind === 'leave') {
        endDrag()
        lastMove = null
        if (!shownFor) highlight(null)
        return
      }
      if (p.kind === 'move') {
        lastMove = p
        if (dragging) {
          const a = crankAngle(p)
          if (a !== null && lastAngle !== null) {
            let d = a - lastAngle
            d = Math.atan2(Math.sin(d), Math.cos(d))
            sim.dragBy(d)
          }
          lastAngle = a
          return
        }
        if (!ctx.coarse) highlight(pick(p))
        return
      }
      // Tap: the crank runs its three scripted turns; a gear shows its label
      // for a moment (touch has no hover).
      const t = pick(p)
      if (t === 'crank') runCrank()
      else if (t && ctx.coarse) {
        highlight(null)
        highlight(t)
        shownFor = 2.5
      }
    },
    setPaused(next) {
      paused = next
      if (!next) return
      dragging = false
      lastAngle = null
      sim.stop()
      whirr.stop()
      shownFor = 0
      highlight(null)
      // Show the true time at once: no roll is drawn while paused.
      prev = sim.snapshot(prev)
      cur = sim.snapshot(cur)
    },
    action(name) {
      if (ctx.posterMode) return null
      if (name === 'crank') return runCrank()
      if (name === 'reset') return sim.reset() ? 'Unwinding to the true time' : 'Showing the true time'
      return null
    },
    dispose() {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', onDown)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      whirr.stop()
      hoverLabel.visible = false
      disposed = true
      atlas.dispose()
      yellow.dispose()
      fieldMat.dispose()
      horizonMat.dispose()
      flaps.dispose()
      disposeGeometries(scene)
    },
  }
}
