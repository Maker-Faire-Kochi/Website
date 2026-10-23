import * as THREE from 'three'
import { noiseSignal } from '../../core/signal'
import { addLights, contactShadow, disposeGeometries } from '../../core/kit'
import { nextTask, type SceneContext, type SceneInstance, type SlotPointer } from '../../core/stage'
import { soundContext } from '../../../composables/usePanelSound'
import { buildBridge, buildCarriage, buildPen, buildPlotterBase, buildSheet } from './gantry'
import { buildBench } from './bench'
import { frameCamera, makeCamera } from './frame'
import { LIFT_H, PAPER_Y, PLACES, TABLE, type Place } from './layout'
import { buildCone, buildFrame, buildKnob, buildSurround, speakerFrame } from './machine'
import { SEMIS } from './music'
import { NoiseSim, SNAP } from './sim'
import { Synth } from './synth'

/**
 * "Make Some Noise": the campaign's noise machine beside a pen plotter, both
 * standing on a low kit bench (bench.ts) with a stack of finished plots and a
 * coiled patch cable; frame.ts fits them to the stage's focus box.
 *
 * The machine is a playable synth (synth.ts, logic in music.ts). Desktop:
 * press and drag anywhere on the band to play it like a theremin (x = note on
 * a pentatonic scale, y = brightness), tap to latch it on/off, press and drag
 * a knob vertically to turn it, tap a knob to step it. Touch: a tap plays a
 * short phrase, a tapped knob steps. The cone pumps with the measured output
 * level and the plotter beside it draws a harmonograph that bends with the
 * pitch and wiggles with the level: music becomes a drawing. When a drawing
 * is finished the sheet slides off and a fresh one comes in.
 *
 * The stage only reports move / tap / leave, so "held" is tracked with
 * window pointerdown / pointerup (mouse and pen only; touch never drags here,
 * so scrolling stays the page's).
 */

type Target = 'knob1' | 'knob2' | 'cone' | 'plotter'

/** The page's one noise signal belongs to whichever instance last made sound. */
let signalOwner: object | null = null

const IGNORE = 'a, button, input, select, textarea, label, summary, [role="button"], [contenteditable], [data-scene-ignore]'
const DRAG_PX = 11
const KNOB_PX = 150
const KNOB_STEP = 0.125

const pct = (v: number) => `${Math.round(v * 100)} percent`

export default async function create(ctx: SceneContext): Promise<SceneInstance> {
  const m = ctx.materials
  const scene = new THREE.Scene()
  addLights(scene)

  // Front-left and a little above: the machine's face, its control cheek and the plotter all read.
  const camera = makeCamera()

  // ── Drawing ───────────────────────────────────────────────────────────
  const machine = new THREE.Group()
  scene.add(machine)
  machine.add(buildFrame(m))
  await nextTask()

  const spk = speakerFrame()
  const cone = buildCone(m)
  const surround = buildSurround(m)
  spk.add(cone, surround.mesh)
  machine.add(spk)
  const knobs = [buildKnob(m, 0), buildKnob(m, 1)]
  for (const k of knobs) machine.add(k.holder)
  await nextTask()

  const plotter = new THREE.Group()
  scene.add(plotter)
  const base = buildPlotterBase(m)
  const bridge = buildBridge(m)
  const { carriage, solenoid } = buildCarriage(m)
  const pen = buildPen(m)
  const sheets = [buildSheet(m, ctx.palette.accent), buildSheet(m, ctx.palette.accent)]
  plotter.add(base, bridge, carriage, pen, ...sheets.map(s => s.node))

  // Shadows ride in their machine's group, so a layout change moves them too.
  const machineShadow = contactShadow(m, 0.3)
  machineShadow.scale.set(1.05, 0.95, 1)
  machineShadow.position.set(-0.05, machineShadow.position.y, 0.01)
  machine.add(machineShadow)
  const plotterShadow = contactShadow(m, 0.33)
  plotterShadow.scale.set(1, 0.72, 1)
  plotter.add(plotterShadow)
  await nextTask()

  // One bench per layout (its top fits the machines' footprint); fit() shows the one in use.
  const benches = (Object.keys(PLACES) as Place[]).map(p => ({ place: p, ...buildBench(m, p, ctx.palette.accent) }))
  for (const b of benches) scene.add(b.node)

  // ── Hover / tap targets ───────────────────────────────────────────────
  const groups: Record<Target, THREE.Object3D[]> = {
    knob1: [knobs[0]!.node],
    knob2: [knobs[1]!.node],
    cone: [cone],
    plotter: [base, bridge, carriage, pen],
  }
  // The bed is a target but only the moving gantry lights up: a whole cyan
  // plotter would outshout the machine beside it.
  const quiet = new Set<THREE.Object3D>()
  base.traverse(o => quiet.add(o))
  const meshes: THREE.Mesh[] = []
  const owner = new Map<THREE.Object3D, Target>()
  const original = new Map<THREE.Mesh, THREE.Material>()
  for (const [name, list] of Object.entries(groups) as [Target, THREE.Object3D[]][]) {
    for (const g of list) {
      g.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        meshes.push(mesh)
        owner.set(mesh, name)
        if (mesh !== solenoid && !quiet.has(mesh)) original.set(mesh, mesh.material as THREE.Material)
      })
    }
  }
  // Paper is pickable (a tap on the drawing means the plotter) but never recoloured.
  for (const s of sheets) {
    meshes.push(s.paper)
    owner.set(s.paper, 'plotter')
  }
  let hovered: Target | null = null
  const highlight = (t: Target | null) => {
    if (t === hovered) return
    hovered = t
    for (const [mesh, mat] of original) mesh.material = owner.get(mesh) === t ? m.face.cyan : mat
  }
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const pick = (p: SlotPointer): Target | null => {
    ndc.set(p.ndc.x, p.ndc.y)
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObjects(meshes, false)[0]
    return hit ? owner.get(hit.object) ?? null : null
  }

  // ── Sim, sound, signal ────────────────────────────────────────────────
  const sim = new NoiseSim(11)
  const voice = sim.voice
  const synth = new Synth()
  const token = {}
  const claim = () => {
    signalOwner = token
  }
  const releaseSignal = () => {
    if (signalOwner !== token) return
    signalOwner = null
    noiseSignal.level = 0
    noiseSignal.active = false
  }

  /** Latched = a tap turned the theremin on; it plays until the next tap. */
  let latched = false
  let drag: null | { kind: 'knob', i: 0 | 1, y0: number, v0: number } | { kind: 'play' } = null
  let held = false
  let anchor: { x: number, y: number, target: Target | null } | null = null
  /** Everything that sounds stops now (leave, pause, 'stop', dispose, watchdog). */
  const stopAll = () => {
    latched = false
    drag = null
    anchor = null
    sim.silence()
    synth.stop()
    releaseSignal()
  }

  const stepKnob = (i: 0 | 1, d: number, wrap: boolean) => {
    let v = voice.knobs[i] + d
    if (wrap && v > 1 + 1e-6) v = 0
    voice.setKnob(i, v)
    return `${i === 0 ? 'Tone' : 'Echo'} ${pct(voice.knobs[i])}`
  }

  const plot = () => (sim.plot.restart() === 'started' ? 'Starting a new drawing' : 'A fresh sheet is on its way')

  // Held-pointer tracking (fine pointers only). Presses on page controls are not ours.
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || e.button !== 0) return
    if ((e.target as Element | null)?.closest?.(IGNORE)) return
    held = true
    anchor = null
  }
  const onUp = () => {
    held = false
    anchor = null
    if (drag?.kind === 'play' && !latched) voice.release()
    drag = null
  }
  const listening = !ctx.posterMode && !ctx.coarse && typeof window !== 'undefined'

  // Watchdog: the stage stops calling frame() for a slot that is off screen,
  // in a hidden tab or torn down mid-build. Sound must never outlive the
  // drawing it belongs to, so if frames stop arriving, everything stops.
  let lastNow = 0
  const watchdog = ctx.posterMode
    ? 0
    : setInterval(() => {
        if ((voice.sounding || synth.live) && performance.now() - lastNow > 300) stopAll()
      }, 250)
  if (listening) {
    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointerup', onUp, { passive: true })
    window.addEventListener('pointercancel', onUp, { passive: true })
  }

  // ── State and interpolation ───────────────────────────────────────────
  if (ctx.posterMode) {
    // The representative frame: a drawing a little over half done.
    for (let i = 0; i < 200 * 60 && !(sim.plot.phase === 'draw' && sim.plot.progress >= 0.62); i++) sim.step(1 / 200)
  }
  let prev = sim.snapshot(new Float64Array(SNAP.size))
  let cur = sim.snapshot(new Float64Array(SNAP.size))
  const v = new Float64Array(SNAP.size)
  const seen = [-1, -1]

  function draw(alpha: number) {
    for (let i = 0; i < SNAP.size; i++) v[i] = prev[i]! + (cur[i]! - prev[i]!) * alpha
    cone.position.z = v[SNAP.cone]!
    surround.set(v[SNAP.cone]!)
    // Turning a pot clockwise (seen from its face) raises it.
    knobs[0]!.node.rotation.y = -v[SNAP.knob1]!
    knobs[1]!.node.rotation.y = -v[SNAP.knob2]!

    const x = v[SNAP.penX]!
    const z = v[SNAP.penZ]!
    bridge.position.z = z
    carriage.position.set(x, 0, z)
    pen.position.set(x, PAPER_Y + v[SNAP.lift]! * LIFT_H, z)
    solenoid.material = hovered === 'plotter' ? m.face.cyan : sim.plot.solenoid ? m.face.red : m.face.mid

    const P = sim.plot
    for (const s of [0, 1]) {
      const sheet = sheets[s]!
      sheet.node.position.z = v[SNAP.sheet + s * 2]!
      sheet.setOpacity(v[SNAP.sheet + s * 2 + 1]!)
      if (s === P.cur && seen[s] !== P.sheetNo) {
        seen[s] = P.sheetNo
        sheet.reset()
      }
      sheet.sync(P.buf[s]!, P.count[s]!)
    }
  }

  function fit(w: number, h: number) {
    const place = frameCamera(camera, w, h)
    const at = PLACES[place]
    machine.position.set(at.machine[0], TABLE.h, at.machine[1])
    plotter.position.set(at.plotter[0], TABLE.h, at.plotter[1])
    for (const b of benches) b.node.visible = b.place === place
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
    },
    frame(alpha) {
      draw(ctx.posterMode ? 1 : alpha)
      if (ctx.posterMode) return
      const now = performance.now()
      const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0
      lastNow = now
      synth.update(voice, dt)
      sim.drive = synth.live ? synth.level : null
      if (signalOwner === token) {
        noiseSignal.level = synth.live ? synth.level : 0
        noiseSignal.pitch = voice.semis / SEMIS
        noiseSignal.active = synth.live && voice.sounding
      }
    },
    resize(w, h) {
      fit(w, h)
    },
    pointer(p) {
      if (ctx.posterMode) return
      if (p.kind === 'leave') {
        // A finger lifting also "leaves" (touch pointers leave on up), so on
        // touch a leave must not cut the phrase that tap just started; the
        // watchdog below still silences it if the band scrolls away.
        if (!ctx.coarse) stopAll()
        highlight(null)
        return
      }
      const x01 = (p.ndc.x + 1) / 2
      const y01 = (p.ndc.y + 1) / 2
      if (p.kind === 'move') {
        if (held && !drag) {
          if (!anchor) anchor = { x: p.x, y: p.y, target: pick(p) }
          else if (Math.hypot(p.x - anchor.x, p.y - anchor.y) > DRAG_PX) {
            const t = anchor.target
            if (t === 'knob1' || t === 'knob2') {
              const i = t === 'knob1' ? 0 : 1
              drag = { kind: 'knob', i, y0: anchor.y, v0: voice.knobs[i] }
            }
            else if (t !== 'plotter') {
              drag = { kind: 'play' }
              claim()
              voice.hold(x01, y01)
            }
          }
        }
        if (drag?.kind === 'knob') voice.setKnob(drag.i, drag.v0 + (drag.y0 - p.y) / KNOB_PX)
        if (voice.mode === 'hold') voice.move(x01, y01)
        if (!ctx.coarse) highlight(drag?.kind === 'knob' ? (drag.i === 0 ? 'knob1' : 'knob2') : pick(p))
        return
      }
      // Tap.
      const t = pick(p)
      if (t === 'knob1' || t === 'knob2') {
        stepKnob(t === 'knob1' ? 0 : 1, KNOB_STEP, true)
        return
      }
      if (t === 'plotter') {
        plot()
        return
      }
      claim()
      if (ctx.coarse) {
        voice.phrase(x01)
        return
      }
      if (latched && voice.mode === 'hold') {
        latched = false
        voice.release()
      }
      else {
        latched = true
        voice.hold(x01, y01)
      }
    },
    setPaused(paused) {
      if (!paused) return
      stopAll()
      held = false
      highlight(null)
    },
    action(name) {
      if (ctx.posterMode) return null
      switch (name) {
        case 'play': {
          if (voice.mode === 'arp') {
            stopAll()
            return 'Stopped'
          }
          claim()
          latched = false
          voice.arp()
          return soundContext() ? 'Playing a four-bar arpeggio' : 'Playing a four-bar arpeggio (sound is off)'
        }
        case 'stop': {
          const was = voice.sounding
          stopAll()
          return was ? 'Stopped' : 'Already quiet'
        }
        case 'knob1-up': return stepKnob(0, KNOB_STEP, false)
        case 'knob1-down': return stepKnob(0, -KNOB_STEP, false)
        case 'knob2-up': return stepKnob(1, KNOB_STEP, false)
        case 'knob2-down': return stepKnob(1, -KNOB_STEP, false)
        case 'plot': return plot()
        default: return null
      }
    },
    dispose() {
      clearInterval(watchdog)
      stopAll()
      if (listening) {
        window.removeEventListener('pointerdown', onDown)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      for (const s of sheets) s.dispose()
      for (const b of benches) b.dispose()
      disposeGeometries(scene)
    },
  }
}
