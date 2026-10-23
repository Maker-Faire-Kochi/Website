import * as THREE from 'three'
import { addLights, fitOrtho } from '../../core/kit'
import { rng } from '../../core/rng'
import { nextTask, type SceneContext, type SceneInstance, type SlotPointer } from '../../core/stage'
import { GRAB } from '../grab'
import type { RobotCommand } from '../types'
import { createDog } from './dog'

/**
 * /lab/dog: one robot dog on the paper, with a small director standing in
 * for the hero's behaviour layer. Like that layer it only issues bounded
 * commands, look targets, postures and reactions; the dog's own gait decides
 * how its body gets there.
 *
 * - Wanders between seeded targets; at some stops it sits, or bows.
 * - Pointer move: head and body turn to follow the pointer's ground point.
 * - Tap the dog: happy hop. Tap the ground: it trots there.
 * - Drag the dog: it leans and walks along with a gentle pull, goes over on
 *   its side with a hard one, and rights itself (scripted).
 * - Now and then (seeded) it trips over nothing and falls -- falls happen
 *   without the visitor too.
 * - Lab only: `?act=<action>&every=<s>` runs an action at 1 s and then every
 *   few seconds, for captures (`?act=tumble&every=7`).
 * - Keyboard: action('hop' | 'sit' | 'bow' | 'stand' | 'shove' | 'tumble').
 */

const BOUNDS = { x: 0.6, z: 0.38 }
const ARRIVE = 0.04

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export default async function create(ctx: SceneContext): Promise<SceneInstance> {
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20)
  camera.position.set(1.9, 1.45, 2.9)
  const aim = new THREE.Vector3(0, 0.15, 0)
  camera.lookAt(aim)

  await nextTask()
  const dog = createDog(ctx, { accent: 'accent', seed: 21, posterMode: ctx.posterMode })
  scene.add(dog.root)
  const R = rng(4242)

  const camYaw = Math.atan2(camera.position.x, camera.position.z)
  dog.placeAt(0, 0, ctx.posterMode ? camYaw - 1.1 : camYaw - 1.4)
  if (ctx.posterMode) dog.lookAt(new THREE.Vector3(camera.position.x * 0.15, 0.3, camera.position.z * 0.15))

  let goal: { x: number, z: number } | null = null
  let idle = R.range(0.8, 1.6)
  let tripIn = R.range(16, 28)
  let time = 0
  let pointerAt: THREE.Vector3 | null = null
  let dragging = false
  let dragH = 0.2
  const cmd: RobotCommand = { speed: 0, yawRate: 0 }
  const params = typeof location === 'undefined' ? null : new URLSearchParams(location.search)
  const demo = params?.get('act') ?? null
  const every = Number(params?.get('every') ?? 0)
  let demoAt = 1

  const ndc = new THREE.Vector2()
  const ray = new THREE.Raycaster()
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const hitPoint = new THREE.Vector3()
  const grabAt = new THREE.Vector3()
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const dragAt = new THREE.Vector3()

  function aimRay(p: SlotPointer) {
    ndc.set(p.ndc.x, p.ndc.y)
    ray.setFromCamera(ndc, camera)
  }

  function wanderTarget() {
    for (let i = 0; i < 8; i++) {
      const x = R.range(-BOUNDS.x, BOUNDS.x)
      const z = R.range(-BOUNDS.z, BOUNDS.z)
      if (Math.hypot(x - dog.position.x, z - dog.position.z) > 0.3) return { x, z }
    }
    return { x: 0, z: 0 }
  }

  function direct(dt: number) {
    cmd.speed = 0
    cmd.yawRate = 0
    if (ctx.posterMode || dog.busy || dragging) return
    // A seeded trip: no visitor needed for it to go over now and then.
    tripIn -= dt
    if (tripIn <= 0 && goal) {
      tripIn = R.range(18, 32)
      dog.react('tumble')
      return
    }
    if (!goal) {
      idle -= dt
      if (idle <= 0) {
        goal = wanderTarget()
        dog.setPosture('stand')
      }
      return
    }
    const dx = goal.x - dog.position.x
    const dz = goal.z - dog.position.z
    const dist = Math.hypot(dx, dz)
    if (dist < ARRIVE) {
      goal = null
      idle = R.range(2, 5)
      const r = R.next()
      if (r < 0.3) dog.setPosture('sit')
      else if (r < 0.45) dog.setPosture('bow')
      return
    }
    const err = wrap(Math.atan2(dx, dz) - dog.heading)
    cmd.yawRate = clamp(2.6 * err, -1.5, 1.5)
    const facing = Math.max(0, Math.cos(err))
    cmd.speed = Math.min(dog.maxSpeed * 0.8, dist * 1.2) * facing * facing
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
      dog.step(dt, cmd)
    },
    frame(alpha) {
      dog.frame(alpha)
    },
    resize(w, h) {
      fitOrtho(camera, w, h, Math.max(1.0, 1.4 / (w / Math.max(1, h))))
      camera.lookAt(aim)
    },
    pointer(p: SlotPointer) {
      if (ctx.posterMode) return
      if (p.kind === 'leave') {
        dog.lookAt(null)
        pointerAt = null
        if (dragging) {
          dog.grab(null)
          dragging = false
        }
        return
      }
      aimRay(p)
      const at = ray.ray.intersectPlane(ground, hitPoint)
      if (p.kind === 'down') {
        if (!ctx.coarse && dog.hit(ray, grabAt)) {
          dragging = true
          dragH = grabAt.y
          dog.grab(grabAt)
          goal = null
        }
        return
      }
      if (p.kind === 'up') {
        if (dragging) dog.grab(null)
        dragging = false
        return
      }
      if (p.kind === 'move') {
        if (dragging) {
          dragPlane.constant = -(dragH + GRAB.lift)
          if (ray.ray.intersectPlane(dragPlane, dragAt)) dog.dragTo(dragAt)
          return
        }
        if (at) {
          pointerAt = (pointerAt ?? new THREE.Vector3()).copy(at)
          dog.lookAt(pointerAt)
        }
        return
      }
      // Tap.
      if (dog.hit(ray)) {
        dog.react('tap')
        return
      }
      if (at) {
        goal = { x: clamp(at.x, -BOUNDS.x, BOUNDS.x), z: clamp(at.z, -BOUNDS.z, BOUNDS.z) }
        dog.lookAt(at.clone())
      }
    },
    setPaused(paused) {
      dog.setPaused(paused)
      if (paused) {
        goal = null
        dragging = false
      }
    },
    action(name) {
      if (ctx.posterMode) return null
      switch (name) {
        case 'hop':
          if (dog.busy) return null
          dog.react('tap')
          return 'The dog hops.'
        case 'sit':
        case 'bow':
        case 'stand':
          if (dog.fallen) return null
          goal = null
          idle = 4
          dog.setPosture(name)
          return name === 'sit' ? 'The dog sits.' : name === 'bow' ? 'The dog bows.' : 'The dog stands.'
        case 'shove':
          dog.react('shove')
          return 'The dog stumbles back.'
        case 'tumble':
          dog.react('tumble')
          return 'The dog falls over, then rolls back onto its feet.'
      }
      return null
    },
    dispose() {
      dog.dispose()
    },
  }
  return instance
}
