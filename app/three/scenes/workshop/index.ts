import * as THREE from 'three'
import { DT } from '../../core/clock'
import { addLights, contactShadow, disposeGeometries } from '../../core/kit'
import { nextTask, type SceneContext, type SceneInstance, type SlotPointer } from '../../core/stage'
import { createPerson } from '../../people/person'
import { buildBench, buildMarks } from './bench'
import { Carpenter } from './carpenter'
import { buildRoom, sawdustPositions } from './environment'
import { BOARD, CARPENTER, CHISEL, H, LEG, MIRROR, PIVOT_Y, RACK, REST, SAW, STOOL, VICE, type ToolKey } from './layout'
import { collapse, vertexColorMaterial } from './merge'
import { shavingCurve, SHAVING } from './shaving'
import { SNAP, WorkshopSim } from './sim'
import { workshopSound } from './sound'
import { buildStool } from './stool'
import { FIRST_WAIT, phaseStart, type Tool } from './timeline'
import { buildArrow, buildChisel, buildMallet, buildPlane, buildSaw, buildShaving } from './tools'

/**
 * Section 3: a carpenter at a maker's bench. A board sits in the front vice;
 * the carpenter takes up the saw, the plane and the mallet-and-chisel in turn
 * in a calm loop, each picked up from the bench top by hand and put back, and
 * a joined stool beside the bench comes apart into an exploded view now and
 * then while they step back to watch. The room (environment.ts) runs to every
 * edge of a full-bleed frame.
 *
 * Every tool pose is computed by WorkshopSim (pure, fixed-step, seeded); the
 * Carpenter (carpenter.ts) puts the person's hands on those poses every step
 * and may hold the sim's clock while they walk, settle a grip or wave. This
 * file only draws, interpolated between the last two steps.
 * Hover lights a tool, the stool or the carpenter cyan (fine pointers only), a
 * resting tool lifts a few millimetres, and the carpenter glances at the
 * pointer now and then; a tap runs that tool now, or next if another is
 * working; the stool toggles; a tap on the carpenter makes them look up and
 * wave; a tap on the bench top knocks up a little puff of dust.
 *
 * Sound (sound.ts) is driven only from here: one-shots from the sim's
 * per-step events, the rasp and swish from its per-step speeds.
 */

/**
 * Extreme points the camera keeps in frame at every aspect: bench top and
 * feet, rack top, vice handle, the floor in front where dust and shavings
 * land, the raised mallet, the stool fully exploded, the carpenter at both
 * places they stand. Fitting to these rather than to a world box keeps the
 * drawing as large as the slot (or its focus box) allows; the room beyond
 * fills the rest of a full-bleed frame.
 */
function framePoints(stoolX: number, stoolZ: number) {
  const pts: [number, number, number][] = []
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      pts.push([sx * 0.75, H, sz * 0.28], [sx * 0.75, H - 0.06, sz * 0.28])
      pts.push([sx * (LEG.x + 0.045), 0, sz * (LEG.z + 0.03)])
      const r = STOOL.seat.w / 2
      pts.push([stoolX + sx * r, STOOL.seat.top + STOOL.lift, stoolZ + sz * r])
      const f = STOOL.leg.at + STOOL.spread + STOOL.leg.w / 2
      pts.push([stoolX + sx * f, 0, stoolZ + sz * f])
    }
    pts.push([sx * (RACK.x + 0.035), RACK.high + 0.035, RACK.z])
    pts.push([VICE.x + sx * 0.135, VICE.screwY, BOARD.front + VICE.t + 0.09])
  }
  pts.push([-0.75, 0, 0.55], [0.6, 0, 0.55], [0.09, PIVOT_Y + 0.25, BOARD.z])
  // Into the world (the drawing is mirrored in x, layout.ts MIRROR) ...
  for (const p of pts) p[0] *= MIRROR
  // ... and the carpenter, already in world terms, at every place they stand:
  // feet, shoulders, head, a raised hand.
  const { plane, saw, chisel } = CARPENTER.stands
  for (const { x, z } of [plane, saw, chisel, { x: plane.x - CARPENTER.planeTravel, z: plane.z }]) {
    pts.push([x - 0.3, 0, z + 0.3], [x + 0.3, 0, z + 0.3], [x - 0.3, 1.45, z], [x, 1.85, z])
  }
  return pts
}

/**
 * Wide slots put the stool beside the bench; tall ones (phones) stand it in
 * front, which narrows the composition so it draws larger. It sits on the
 * floor clear of where dust and shavings land either way.
 */
const STOOL_WIDE = { x: STOOL.x, z: STOOL.z, points: framePoints(STOOL.x, STOOL.z) }
const STOOL_TALL = { x: 1.0, z: 0.42, points: framePoints(1.0, 0.42) }

const STATUS: Record<Tool, string> = { saw: 'Sawing', plane: 'Planing', chisel: 'Chiselling' }
const TOOL_KEYS: ToolKey[] = ['saw', 'plane', 'chisel', 'mallet']
/** Hover lift of a resting tool (m) and its easing time constant (s). */
const LIFT = 0.006
const LIFT_TAU = 0.07
/** Slots smaller than this (CSS px, either side) are previews and stay silent. */
const QUIET_BELOW = 160

/**
 * The view: from in front and to the right of the bench, so the carpenter --
 * who faces along the board toward its free end -- is seen three-quarter from
 * the front, face and both arms toward us, the work between them and us.
 */
const VIEW = new THREE.Vector3(2.45 * MIRROR, 1.3, 1.6)

export default async function create(ctx: SceneContext): Promise<SceneInstance> {
  const m = ctx.materials
  // Build cost per piece (dev: window.__wsLaps), with a yield after each so no task runs long.
  const laps: [string, number][] = []
  let lapT = performance.now()
  const lap = async (name: string) => {
    laps.push([name, Math.round(performance.now() - lapT)])
    await nextTask()
    lapT = performance.now()
  }
  const scene = new THREE.Scene()
  addLights(scene)

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 40)
  const target = new THREE.Vector3(0.2, 0.62, 0.05)
  // Dev only: ?view=x,y,z looks from another direction (side and top captures for review).
  const devView = import.meta.dev && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('view')?.split(',').map(Number) : undefined
  const view = devView?.length === 3 ? new THREE.Vector3(devView[0], devView[1], devView[2]) : VIEW.clone()
  view.normalize()
  if (Math.abs(view.y) > 0.99) camera.up.set(0, 0, -1)
  camera.position.copy(target).addScaledVector(view, 12)
  camera.lookAt(target)
  camera.updateMatrixWorld()

  // ── Drawing ───────────────────────────────────────────────────────────
  // Everything but the person lives in the sim's frame inside `world`, drawn
  // mirrored in x (layout.ts MIRROR); the person stands in the scene itself.
  // Built in pieces with a yield between each, so no one task blocks input.
  const world = new THREE.Group()
  world.name = 'workshop'
  world.scale.x = MIRROR
  scene.add(world)
  // Every still and every tool shares one vertex-colour material (merge.ts).
  const vc = vertexColorMaterial()

  // The bench and the room are one still drawing: two draws. (Built in two
  // tasks: the bench alone is most of a frame's budget.)
  // collapse() takes each part relative to `world`'s mirrored matrix, so the
  // bench must be IN world first to come out in the sim's frame with the
  // board, vice and kerf where the saw and carpenter work. (Built outside it,
  // it was flipped twice: the saw cut beside the vice, over solid board.) The
  // room is scenery composed for this camera: left outside, it keeps that look.
  const bench = buildBench(m)
  world.add(bench)
  await lap('bench')
  const still = collapse([bench, buildRoom(m)], world, vc, m.line, 'still')
  world.add(still.group)
  const marks = buildMarks(m)
  world.add(marks)
  await lap('room')

  const nodes: Record<ToolKey, THREE.Group> = {
    saw: buildSaw(m),
    plane: buildPlane(m),
    chisel: buildChisel(m),
    mallet: buildMallet(m),
  }
  for (const n of Object.values(nodes)) {
    world.add(n)
    // Each tool: one mesh and its hairlines, on the tool's own node.
    n.add(collapse([...n.children], n, vc, m.line, n.name).group)
  }

  const shaving = buildShaving(m)
  world.add(shaving.node)
  const curve = new Float32Array((SHAVING.segments + 1) * 2)
  let shavingL = -1

  const arrow = buildArrow(ctx.palette.red)
  world.add(arrow)

  const stool = buildStool(m, vc)
  world.add(stool.root)
  await lap('tools+stool')

  const benchShadow = contactShadow(m, 1)
  benchShadow.scale.set(0.95, 0.42, 1)
  benchShadow.position.z = 0.04
  const stoolShadow = contactShadow(m, 0.3)
  world.add(benchShadow, stoolShadow)

  // Sawdust and chips: ONE Points object. The old sawdust on the floor fills
  // the front of its buffer once; the sim's fixed ring of live grains follows.
  const sim = new WorkshopSim(7)
  const sound = workshopSound()
  const OLD_DUST = 420
  const dustArr = new Float32Array((OLD_DUST + sim.particles.capacity) * 3)
  dustArr.set(sawdustPositions(OLD_DUST))
  const dustPos = new THREE.Float32BufferAttribute(dustArr, 3)
  dustPos.setUsage(THREE.DynamicDrawUsage)
  const dustGeo = new THREE.BufferGeometry()
  dustGeo.setAttribute('position', dustPos)
  dustGeo.setDrawRange(0, OLD_DUST)
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2)
  const dustMat = new THREE.PointsMaterial({ color: ctx.palette.woodDark, size: 2.4 * dpr, sizeAttenuation: false })
  const dust = new THREE.Points(dustGeo, dustMat)
  dust.frustumCulled = false
  world.add(dust)
  await lap('dust')

  // ── The carpenter ─────────────────────────────────────────────────────
  // A Kerala carpenter in shirt and mundu; the shirt carries the scene's one accent.
  const person = createPerson(ctx, {
    seed: CARPENTER.seed, variant: CARPENTER.variant, posterMode: ctx.posterMode, accent: true,
    colors: { skin: 'woodDark', hair: 'dark' },
  })
  scene.add(person.root)
  const carpenter = new Carpenter(person, sim, ctx.posterMode)
  {
    // Where a wave looks: toward the viewer, at head height.
    const toCam = camera.position.clone().sub(target).setY(0).normalize().multiplyScalar(3)
    carpenter.setViewer({ x: CARPENTER.stands.saw.x + toCam.x, y: 1.6, z: CARPENTER.stands.saw.z + toCam.z })
  }
  await lap('person')

  // ── Hover / tap targets ───────────────────────────────────────────────
  type Target = 'saw' | 'plane' | 'chisel' | 'stool' | 'carpenter'
  type Thing = Exclude<Target, 'carpenter'>
  const groups: Record<Thing, THREE.Object3D[]> = {
    saw: [nodes.saw],
    plane: [nodes.plane],
    chisel: [nodes.chisel, nodes.mallet],
    stool: [stool.root],
  }
  const meshes: THREE.Mesh[] = []
  const owner = new Map<THREE.Object3D, Thing>()
  const original = new Map<THREE.Mesh, THREE.Material>()
  for (const [name, list] of Object.entries(groups) as [Thing, THREE.Object3D[]][]) {
    for (const g of list) {
      g.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        meshes.push(mesh)
        owner.set(mesh, name)
        original.set(mesh, mesh.material as THREE.Material)
      })
    }
  }
  let hovered: Target | null = null
  const highlight = (t: Target | null) => {
    if (t === hovered) return
    hovered = t
    for (const mesh of meshes) mesh.material = owner.get(mesh) === t ? m.face.cyan : original.get(mesh)!
    person.setSelected(t === 'carpenter')
  }
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const head = new THREE.Vector3()
  const pick = (p: SlotPointer): Target | null => {
    ndc.set(p.ndc.x, p.ndc.y)
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObjects(meshes, false)[0]
    // The nearer of a tool and the carpenter wins (they stand in front of the bench).
    if (person.hit(ray)) {
      head.copy(person.position).setY(1.1)
      const d = head.sub(ray.ray.origin).dot(ray.ray.direction)
      if (!hit || d < hit.distance) return 'carpenter'
    }
    return hit ? owner.get(hit.object) ?? null : null
  }
  /** The pointer as a point near the carpenter's head, for a glance. */
  const glance = new THREE.Vector3()
  const glanceAt = () => {
    head.copy(person.position).setY(1.5)
    return ray.ray.closestPointToPoint(head, glance)
  }

  /** Tap on the bench top (a face looking up), not on a tool: dust puffs up there. */
  const up = new THREE.Vector3()
  const tapBench = (): boolean => {
    // Faces only (a ray against the hairlines would "hit" from far off); the
    // still drawing is bench and room, so only a face at bench-top height counts.
    const hit = ray.intersectObject(still.mesh, false)[0]
    if (!hit?.face || hit.point.y < H - 0.01) return false
    up.copy(hit.face.normal).transformDirection(hit.object.matrixWorld)
    if (up.y < 0.7) return false
    sim.requestPuff(MIRROR * hit.point.x, hit.point.y, hit.point.z)
    return true
  }

  // Hover lift: eased in fixed steps; only a tool sitting exactly on its rest lifts.
  const OWNER: Record<ToolKey, Tool> = { saw: 'saw', plane: 'plane', chisel: 'chisel', mallet: 'chisel' }
  const toolLift: Record<ToolKey, number> = { saw: 0, plane: 0, chisel: 0, mallet: 0 }
  const atRest = (k: ToolKey) => {
    const p = sim.pose[k]
    const r = REST[k]
    for (let i = 0; i < 6; i++) if (p[i] !== r[i]) return false
    return true
  }
  const stepLift = (dt: number) => {
    const e = 1 - Math.exp(-dt / LIFT_TAU)
    for (const k of TOOL_KEYS) {
      // Only a tool lying idle lifts: not one a hand is reaching for.
      const target = hovered !== null && OWNER[k] === hovered && atRest(k) && sim.timeline.current !== OWNER[k] ? LIFT : 0
      toolLift[k] += (target - toolLift[k]) * e
    }
  }

  const run = (t: Target): string => {
    if (t === 'carpenter') return carpenter.requestWave()
    if (t === 'stool') return sim.toggleStool() === 'exploding' ? 'Stool coming apart' : 'Stool going together'
    const r = sim.request(t)
    return r === 'started' ? STATUS[t] : r === 'queued' ? `${STATUS[t]} next` : 'Busy'
  }

  // ── State and interpolation ───────────────────────────────────────────
  if (ctx.posterMode) {
    // The representative frame: the carpenter mid push stroke, the stool assembled.
    const steps = Math.round((FIRST_WAIT + phaseStart('saw', 'work') + SAW.period * 2.25) / DT)
    for (let i = 0; i < steps; i++) sim.step(DT)
  }
  carpenter.step(DT)
  // Dev only, for capture: /lab/workshop?at=<tool>:<seconds into its work>[:freeze]
  // runs the whole loop (sim, carpenter, person) up to that moment.
  let frozen = false
  let waveSteps = 200
  if (import.meta.dev && typeof location !== 'undefined' && !ctx.posterMode) {
    const at = new URLSearchParams(location.search).get('at')?.split(':')
    if (at && (at[0] === 'saw' || at[0] === 'plane' || at[0] === 'chisel' || at[0] === 'wave')) {
      const tool = at[0] === 'wave' ? 'saw' : at[0]
      const until = Number(at[1] ?? 1)
      sim.request(tool)
      let waved = false
      for (let i = 0; i < 200 * 60; i++) {
        sim.step(DT, carpenter.hold(DT))
        carpenter.step(DT)
        const tl = sim.timeline
        const inWork = tl.current === tool && tl.t >= phaseStart(tool, 'work')
        if (at[0] === 'wave' && inWork && !waved && tl.t >= phaseStart(tool, 'work') + 0.5) {
          carpenter.requestWave()
          waved = true
        }
        // A wave is captured one second in; a tool `until` seconds into its work.
        if (at[0] === 'wave' ? waved && person.action === 'wave' && --waveSteps <= 0 : inWork && tl.t >= phaseStart(tool, 'work') + until) break
      }
      frozen = at[2] === 'freeze'
    }
  }
  let prev = sim.snapshot(new Float64Array(SNAP.size))
  let cur = sim.snapshot(new Float64Array(SNAP.size))
  const v = new Float64Array(SNAP.size)
  const mtx = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s3 = new THREE.Vector3()
  const p3 = new THREE.Vector3()
  const xAxis = new THREE.Vector3(1, 0, 0)
  const dir = new THREE.Vector3()

  const setMark = (i: number, x: number, top: number, w: number, depth: number, d: number) => {
    p3.set(x, top, BOARD.z)
    q.identity()
    s3.set(w, depth > 1e-4 ? depth : 1e-6, d)
    marks.setMatrixAt(i, mtx.compose(p3, q, s3))
  }
  const lift = 0.0006
  const kerfW = 0.003

  function draw(alpha: number) {
    for (let i = 0; i < SNAP.size; i++) v[i] = prev[i]! + (cur[i]! - prev[i]!) * alpha
    for (const k of TOOL_KEYS) {
      const o = SNAP[k]
      nodes[k].position.set(v[o]!, v[o + 1]! + toolLift[k], v[o + 2]!)
      nodes[k].rotation.set(v[o + 3]!, v[o + 4]!, v[o + 5]!)
    }
    // The rip shows as a line along the top edge (back to where the sloping
    // kerf bottom meets it) and a slot down the end grain.
    const D = v[SNAP.kerf]!
    const run = D / Math.tan(SAW.angle)
    setMark(0, BOARD.x1 - run / 2, BOARD.top + lift, run, D > 1e-4 ? 0.002 : 0, kerfW)
    setMark(1, BOARD.x1 + lift - 0.001, BOARD.top + lift, 0.002, D > 1e-4 ? D + lift : 0, kerfW)
    const M = v[SNAP.mortise]!
    setMark(2, CHISEL.x, BOARD.top + lift, 0.016, M > 1e-4 ? M + lift : 0, 0.007)
    marks.instanceMatrix.needsUpdate = true

    const L = cur[SNAP.shaving]!
    shaving.node.visible = L > 0.002
    if (shaving.node.visible) {
      if (L !== shavingL) {
        shavingCurve(L, curve)
        shaving.update(curve)
        shavingL = L
      }
      shaving.node.position.set(v[SNAP.shaving + 1]!, v[SNAP.shaving + 2]!, v[SNAP.shaving + 3]!)
      shaving.node.rotation.set(0, 0, v[SNAP.shaving + 4]!)
    }

    const a = cur[SNAP.arrow + 6]!
    arrow.visible = a > 0.02
    if (arrow.visible) {
      ;(arrow.material as THREE.LineBasicMaterial).opacity = a
      arrow.position.set(v[SNAP.arrow]!, v[SNAP.arrow + 1]!, v[SNAP.arrow + 2]!)
      dir.set(cur[SNAP.arrow + 3]!, cur[SNAP.arrow + 4]!, cur[SNAP.arrow + 5]!).normalize()
      arrow.quaternion.setFromUnitVectors(xAxis, dir)
    }

    stool.set(v[SNAP.stool]!)

    const P = sim.particles
    const o = OLD_DUST * 3
    for (let i = 0; i < P.count * 3; i++) dustArr[o + i] = P.prev[i]! + (P.pos[i]! - P.prev[i]!) * alpha
    dustGeo.setDrawRange(0, OLD_DUST + P.count)
    dustPos.needsUpdate = true
  }

  function fit(w: number, h: number) {
    const place = w / Math.max(1, h) < 0.9 ? STOOL_TALL : STOOL_WIDE
    stool.root.position.set(place.x, 0, place.z)
    stoolShadow.position.set(place.x, stoolShadow.position.y, place.z)
    carpenter.setStool(MIRROR * place.x, place.z)
    camera.updateMatrixWorld()
    const inv = camera.matrixWorldInverse
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const pt of place.points) {
      p3.set(...pt).applyMatrix4(inv)
      x0 = Math.min(x0, p3.x)
      x1 = Math.max(x1, p3.x)
      y0 = Math.min(y0, p3.y)
      y1 = Math.max(y1, p3.y)
    }
    const pad = 1.08
    let vw = (x1 - x0) * pad
    let vh = (y1 - y0) * pad
    const aspect = w / Math.max(1, h)
    if (vw / vh > aspect) vh = vw / aspect
    else vw = vh * aspect
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    camera.left = cx - vw / 2
    camera.right = cx + vw / 2
    camera.top = cy + vh / 2
    camera.bottom = cy - vh / 2
    camera.updateProjectionMatrix()
  }

  draw(1)
  person.frame(1)
  laps.push(['final', Math.round(performance.now() - lapT)])
  if (import.meta.dev && typeof window !== 'undefined') ((window as any).__wsLaps ??= []).push(laps)
  // Dev only: the lab's capture scripts read the sim and the carpenter.
  const devHandle = { sim, carpenter, person }
  if (import.meta.dev && typeof window !== 'undefined') ((window as any).__workshops ??= []).push(devHandle)
  let paused = false

  return {
    scene,
    camera,
    step(dt) {
      if (ctx.posterMode || frozen) return
      sim.step(dt, carpenter.hold(dt))
      const t = prev
      prev = cur
      cur = sim.snapshot(t)
      carpenter.step(dt)
      stepLift(dt)
      // Sounds for what this step made happen, at the step it happened.
      for (const e of sim.events) sound.event(e)
      sound.step(dt, sim.swish, sim.particles.landedDust, sim.particles.landedChips)
    },
    frame(alpha) {
      draw(ctx.posterMode ? 1 : alpha)
      person.frame(ctx.posterMode ? 1 : alpha)
      if (!paused && !ctx.posterMode) sound.frame(sim.rasp, sim.swish)
    },
    resize(w, h) {
      fit(w, h)
      sound.setMuted(Math.min(w, h) < QUIET_BELOW)
    },
    pointer(p) {
      if (ctx.posterMode || paused) return
      if (p.kind === 'leave') {
        carpenter.setPointer(null)
        return highlight(null)
      }
      const t = pick(p)
      if (p.kind === 'move') {
        if (!ctx.coarse) {
          highlight(t)
          carpenter.setPointer(glanceAt())
        }
        return
      }
      if (t) run(t)
      else tapBench()
    },
    setPaused(v) {
      paused = v
      carpenter.setPaused(v)
      if (!v) return
      sim.clearQueue()
      highlight(null)
      for (const k of TOOL_KEYS) toolLift[k] = 0
      sound.silence()
    },
    action(name) {
      if (ctx.posterMode) return null
      if (name === 'saw' || name === 'plane' || name === 'chisel' || name === 'stool') return run(name)
      if (name === 'wave') return carpenter.requestWave()
      if (name === 'dust') {
        sim.requestPuff(0.12, H, -0.12)
        return 'Dust puffed off the bench'
      }
      return null
    },
    dispose() {
      sound.silence()
      shaving.dispose()
      scene.remove(shaving.node)
      dustMat.dispose()
      vc.dispose()
      ;(arrow.material as THREE.Material).dispose()
      marks.dispose()
      // People share geometry across scenes: dispose the person, never its meshes.
      person.dispose()
      if (import.meta.dev && typeof window !== 'undefined') {
        const list = (window as any).__workshops as unknown[] | undefined
        const i = list ? list.indexOf(devHandle) : -1
        if (i >= 0) list!.splice(i, 1)
      }
      disposeGeometries(scene)
    },
  }
}
