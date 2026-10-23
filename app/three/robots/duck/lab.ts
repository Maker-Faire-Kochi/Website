import * as THREE from 'three'
import { addLights, fitOrtho } from '../../core/kit'
import { rng } from '../../core/rng'
import type { SceneContext, SceneInstance, SlotPointer } from '../../core/stage'
import type { RobotCommand } from '../types'
import { createDuck } from './duck'

/**
 * /lab/duck: one duck on the paper, with a small director standing in for the
 * hero's behaviour layer. Like that layer, it only issues bounded commands
 * (speed, yaw rate), look targets and reactions; the duck's own gait decides
 * how the body gets there.
 *
 * - Wanders between seeded targets, pausing at each.
 * - Pointer move: the head tracks the pointer's point on the ground.
 * - Tap the duck: it hops. Tap the ground: it walks there.
 * - Keyboard equivalents: action('hop'), action('shoo') (backs off a few steps).
 * - posterMode: standing three-quarter, looking slightly toward the camera.
 */

/** Ground area the duck may wander or be sent to. */
const BOUNDS = { x: 0.42, z: 0.3 }
const ARRIVE = 0.03

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export default function create(ctx: SceneContext): SceneInstance {
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20)
  camera.position.set(1.9, 1.45, 2.9)
  const aim = new THREE.Vector3(0, 0.13, 0)
  camera.lookAt(aim)

  const duck = createDuck(ctx, { accent: 'accent', seed: 7, posterMode: ctx.posterMode })
  scene.add(duck.root)
  const R = rng(1207)

  // Poster: facing a little left of the camera so the side and the face both
  // read, head turned slightly toward the viewer.
  const camYaw = Math.atan2(camera.position.x, camera.position.z)
  duck.placeAt(0, 0.02, ctx.posterMode ? camYaw - 0.85 : camYaw - 1.2)
  if (ctx.posterMode) duck.lookAt(new THREE.Vector3(camera.position.x * 0.12, 0.3, camera.position.z * 0.12))

  let goal: { x: number, z: number } | null = null
  let idle = R.range(0.6, 1.4)
  let shoo = 0
  const cmd: RobotCommand = { speed: 0, yawRate: 0 }

  const ndc = new THREE.Vector2()
  const ray = new THREE.Raycaster()
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const hitPoint = new THREE.Vector3()

  function pick(p: SlotPointer) {
    ndc.set(p.ndc.x, p.ndc.y)
    ray.setFromCamera(ndc, camera)
    return ray.ray.intersectPlane(ground, hitPoint)
  }

  function wanderTarget() {
    // Seeded, bounded, and far enough away to be worth a walk.
    for (let i = 0; i < 8; i++) {
      const x = R.range(-BOUNDS.x, BOUNDS.x)
      const z = R.range(-BOUNDS.z, BOUNDS.z)
      if (Math.hypot(x - duck.position.x, z - duck.position.z) > 0.18) return { x, z }
    }
    return { x: 0, z: 0 }
  }

  function direct(dt: number) {
    cmd.speed = 0
    cmd.yawRate = 0
    if (ctx.posterMode || duck.busy) return
    if (shoo > 0) {
      shoo -= dt
      cmd.speed = -duck.maxSpeed
      return
    }
    if (!goal) {
      idle -= dt
      if (idle <= 0) goal = wanderTarget()
      return
    }
    const dx = goal.x - duck.position.x
    const dz = goal.z - duck.position.z
    const dist = Math.hypot(dx, dz)
    if (dist < ARRIVE) {
      goal = null
      idle = R.range(1.5, 4)
      return
    }
    // Turn toward the goal; only walk forward once roughly facing it, and
    // slow down on the approach so the last step is a short one.
    const err = wrap(Math.atan2(dx, dz) - duck.heading)
    cmd.yawRate = clamp(2.4 * err, -1.4, 1.4)
    const facing = Math.max(0, Math.cos(err))
    cmd.speed = Math.min(duck.maxSpeed * 0.8, dist * 0.9) * facing * facing
  }

  return {
    scene,
    camera,
    step(dt) {
      direct(dt)
      duck.step(dt, cmd)
    },
    frame(alpha) {
      duck.frame(alpha)
    },
    resize(w, h) {
      // Keep the whole wander area in view however narrow the slot (the 96px thumbnail included).
      fitOrtho(camera, w, h, Math.max(0.78, 1.05 / (w / Math.max(1, h))))
      camera.lookAt(aim)
    },
    pointer(p: SlotPointer) {
      if (ctx.posterMode) return
      if (p.kind === 'leave') {
        duck.lookAt(null)
        return
      }
      const at = pick(p)
      if (p.kind === 'move') {
        if (at) duck.lookAt(at.clone())
        return
      }
      // Tap.
      if (duck.hit(ray)) {
        duck.react('tap')
        return
      }
      if (at) {
        goal = { x: clamp(at.x, -BOUNDS.x, BOUNDS.x), z: clamp(at.z, -BOUNDS.z, BOUNDS.z) }
        shoo = 0
        duck.lookAt(at.clone())
      }
    },
    setPaused(paused) {
      duck.setPaused(paused)
      if (paused) {
        goal = null
        shoo = 0
      }
    },
    action(name) {
      if (ctx.posterMode) return null
      if (name === 'hop') {
        if (duck.busy) return null
        duck.react('tap')
        return 'The duck hops.'
      }
      if (name === 'shoo') {
        goal = null
        shoo = 1.1
        return 'The duck backs away.'
      }
      return null
    },
    dispose() {
      duck.dispose()
    },
  }
}
