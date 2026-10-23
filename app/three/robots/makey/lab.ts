import * as THREE from 'three'
import { addLights, fitOrtho } from '../../core/kit'
import { rng } from '../../core/rng'
import { nextTask, type SceneContext, type SceneInstance, type SlotPointer } from '../../core/stage'
import { GRAB } from '../grab'
import type { RobotCommand } from '../types'
import { createMakey } from './makey'

/**
 * /lab/makey: Makey on the paper, hosting. A small director stands in for
 * the hero's behaviour layer (bounded commands, look targets, reactions):
 *
 * - Wanders between seeded spots like a host doing the rounds.
 * - Pointer: its head follows. When the pointer rests, it stops, turns to
 *   face it, and -- because the look target holds still -- waves hi (the
 *   greeting itself is Makey's own autoWave).
 * - Tap Makey: a big two-arm wave and a hop. Tap the ground: it walks there.
 * - Drag Makey: a gentle pull walks it along; a hard one knocks it over, and
 *   it gets up (scripted), dusts itself off and waves.
 * - Now and then (seeded) it trips by itself.
 * - Lab only: `?act=<action>&every=<s>` runs an action at 1 s and then every
 *   few seconds, for captures (`?act=tumble&every=7`).
 * - Keyboard: action('wave' | 'hop' | 'shove' | 'tumble').
 */

const BOUNDS = { x: 0.55, z: 0.35 }
const ARRIVE = 0.03
const REST = 0.45

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export default async function create(ctx: SceneContext): Promise<SceneInstance> {
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20)
  camera.position.set(1.9, 1.45, 2.9)
  const aim = new THREE.Vector3(0, 0.16, 0)
  camera.lookAt(aim)

  await nextTask()
  const makey = createMakey(ctx, { accent: 'accent', seed: 31, posterMode: ctx.posterMode })
  scene.add(makey.root)
  const R = rng(5150)

  const camYaw = Math.atan2(camera.position.x, camera.position.z)
  makey.placeAt(0, 0, ctx.posterMode ? camYaw - 0.35 : camYaw - 1.2)
  if (ctx.posterMode) {
    makey.lookAt(new THREE.Vector3(camera.position.x * 0.2, 0.35, camera.position.z * 0.2))
    makey.gait.autoWave = false
    makey.wave(1)
  }

  let goal: { x: number, z: number } | null = null
  let idle = R.range(0.8, 1.6)
  let tripIn = R.range(20, 34)
  let pointerAt: THREE.Vector3 | null = null
  let still = 0
  let dragging = false
  let dragH = 0.15
  const cmd: RobotCommand = { speed: 0, yawRate: 0 }
  const params = typeof location === 'undefined' ? null : new URLSearchParams(location.search)
  const demo = params?.get('act') ?? null
  const every = Number(params?.get('every') ?? 0)
  let demoAt = 1
  let time = 0

  const ndc = new THREE.Vector2()
  const ray = new THREE.Raycaster()
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const hitPoint = new THREE.Vector3()
  const grabAt = new THREE.Vector3()
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const dragAt = new THREE.Vector3()
  const lookPt = new THREE.Vector3()

  function wanderTarget() {
    for (let i = 0; i < 8; i++) {
      const x = R.range(-BOUNDS.x, BOUNDS.x)
      const z = R.range(-BOUNDS.z, BOUNDS.z)
      if (Math.hypot(x - makey.position.x, z - makey.position.z) > 0.22) return { x, z }
    }
    return { x: 0, z: 0 }
  }

  function direct(dt: number) {
    cmd.speed = 0
    cmd.yawRate = 0
    if (ctx.posterMode || makey.busy || dragging) return
    tripIn -= dt
    if (tripIn <= 0 && goal) {
      tripIn = R.range(22, 36)
      makey.react('tumble')
      return
    }
    // The pointer resting near it: stop and face it (the wave is Makey's own).
    if (pointerAt) still += dt
    if (pointerAt && still > REST && Math.hypot(pointerAt.x - makey.position.x, pointerAt.z - makey.position.z) < 1.3) {
      goal = null
      idle = 2
      const err = wrap(Math.atan2(pointerAt.x - makey.position.x, pointerAt.z - makey.position.z) - makey.heading)
      if (Math.abs(err) > 0.25) cmd.yawRate = clamp(2.2 * err, -1.2, 1.2)
      return
    }
    if (!goal) {
      idle -= dt
      if (idle <= 0) goal = wanderTarget()
      return
    }
    const dx = goal.x - makey.position.x
    const dz = goal.z - makey.position.z
    const dist = Math.hypot(dx, dz)
    if (dist < ARRIVE) {
      goal = null
      idle = R.range(1.5, 4)
      return
    }
    const err = wrap(Math.atan2(dx, dz) - makey.heading)
    cmd.yawRate = clamp(2.4 * err, -1.3, 1.3)
    const facing = Math.max(0, Math.cos(err))
    cmd.speed = Math.min(makey.maxSpeed * 0.85, dist * 1.0) * facing * facing
  }

  const instance: SceneInstance = {
    scene,
    camera,
    step(dt) {
      time += dt
      if (demo && time >= demoAt) {
        demoAt = every > 0 ? demoAt + every : Infinity
        instance.action!(demo)
      }
      direct(dt)
      makey.step(dt, cmd)
    },
    frame(alpha) {
      makey.frame(alpha)
    },
    resize(w, h) {
      fitOrtho(camera, w, h, Math.max(0.85, 1.25 / (w / Math.max(1, h))))
      camera.lookAt(aim)
    },
    pointer(p: SlotPointer) {
      if (ctx.posterMode) return
      if (p.kind === 'leave') {
        makey.lookAt(null)
        pointerAt = null
        if (dragging) makey.grab(null)
        dragging = false
        return
      }
      ndc.set(p.ndc.x, p.ndc.y)
      ray.setFromCamera(ndc, camera)
      const at = ray.ray.intersectPlane(ground, hitPoint)
      if (p.kind === 'down') {
        if (!ctx.coarse && makey.hit(ray, grabAt)) {
          dragging = true
          dragH = grabAt.y
          makey.grab(grabAt)
          goal = null
        }
        return
      }
      if (p.kind === 'up') {
        if (dragging) makey.grab(null)
        dragging = false
        return
      }
      if (p.kind === 'move') {
        if (dragging) {
          dragPlane.constant = -(dragH + GRAB.lift)
          if (ray.ray.intersectPlane(dragPlane, dragAt)) makey.dragTo(dragAt)
          return
        }
        if (at) {
          if (!pointerAt || pointerAt.distanceTo(at) > 0.02) still = 0
          pointerAt = (pointerAt ?? new THREE.Vector3()).copy(at)
          // Look at a point a little above the ground under the pointer: about where a visitor's hand is.
          makey.lookAt(lookPt.copy(at).setY(0.12))
        }
        return
      }
      if (makey.hit(ray)) {
        makey.react('tap')
        return
      }
      if (at) {
        goal = { x: clamp(at.x, -BOUNDS.x, BOUNDS.x), z: clamp(at.z, -BOUNDS.z, BOUNDS.z) }
        pointerAt = null
        makey.lookAt(lookPt.copy(at).setY(0.05))
      }
    },
    setPaused(paused) {
      makey.setPaused(paused)
      if (paused) {
        goal = null
        dragging = false
        pointerAt = null
      }
    },
    action(name) {
      if (ctx.posterMode) return null
      switch (name) {
        case 'wave':
          if (makey.fallen) return null
          makey.wave(1)
          return 'Makey waves hi.'
        case 'hop':
          if (makey.busy) return null
          makey.react('tap')
          return 'Makey waves with both arms and hops.'
        case 'shove':
          makey.react('shove')
          return 'Makey stumbles back.'
        case 'tumble':
          makey.react('tumble')
          return 'Makey falls over, gets up, dusts off and waves.'
      }
      return null
    },
    dispose() {
      makey.dispose()
    },
  }
  return instance
}
