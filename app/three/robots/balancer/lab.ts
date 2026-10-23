import * as THREE from 'three'
import { DT } from '../../core/clock'
import { addLights, fitOrtho } from '../../core/kit'
import { rng } from '../../core/rng'
import type { SceneContext, SceneInstance, SlotPointer } from '../../core/stage'
import type { RobotCommand } from '../types'
import { createBalancer } from './balancer'

/**
 * /lab/balancer: one balancer on the paper, with a minimal director standing
 * in for the hero's behaviour layer. Like that layer it only ever issues
 * bounded commands (speed, yaw rate); the robot's own controller decides how
 * the body gets there, which is why driving off starts with a small roll back.
 *
 *   pointer move   head tracks the pointer's ground point
 *   tap robot      gentle nudge (it leans back and recovers)
 *   tap ground     drive there
 *   actions        'nudge', 'shove' (falls, then rights itself with the kickstand)
 */

const BOUNDS = { x: 0.36, z: 0.26 }
const VIEW_HEIGHT = 0.72

export default function create(ctx: SceneContext): SceneInstance {
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20)
  camera.position.set(1.4, 1.1, 3)
  camera.lookAt(0, 0.1, 0)

  const robot = createBalancer(ctx, { accent: 'accent', seed: 11, posterMode: ctx.posterMode })
  scene.add(robot.root)
  // Poster: standing, turned a little off the camera so both wheels and the head read.
  const toCamera = Math.atan2(camera.position.x, camera.position.z)
  robot.placeAt(0, 0, ctx.posterMode ? toCamera - 0.55 : 0)
  if (ctx.posterMode) robot.lookAt(camera.position.clone().setY(0.25))

  const rand = rng(29)
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const hitPoint = new THREE.Vector3()
  const goal = new THREE.Vector3()
  const cmd: RobotCommand = { speed: 0, yawRate: 0 }
  let going = false
  let idleUntil = 1.5
  let time = 0

  const pickGoal = () => {
    // Seeded wander targets, kept a robot's length from the edges of the stage.
    goal.set(rand.range(-BOUNDS.x, BOUNDS.x), 0, rand.range(-BOUNDS.z, BOUNDS.z))
    going = true
  }

  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

  const direct = () => {
    cmd.speed = 0
    cmd.yawRate = 0
    if (ctx.posterMode || robot.busy) return
    if (!going) {
      if (time >= idleUntil) pickGoal()
      return
    }
    const dx = goal.x - robot.position.x
    const dz = goal.z - robot.position.z
    const d = Math.hypot(dx, dz)
    if (d < 0.03) {
      going = false
      idleUntil = time + rand.range(2, 5)
      return
    }
    const err = wrap(Math.atan2(dx, dz) - robot.heading)
    // Turn toward the goal; only roll once roughly facing it, and slow on the
    // approach so the controller's own braking lands it near the spot.
    cmd.yawRate = THREE.MathUtils.clamp(3 * err, -1.6, 1.6)
    const facing = Math.max(0, Math.cos(err))
    cmd.speed = Math.min(0.2, 0.7 * d) * facing * facing * facing
  }

  return {
    scene,
    camera,
    step(dt) {
      time += DT
      direct()
      robot.step(dt, cmd)
    },
    frame(alpha) {
      robot.frame(alpha)
    },
    resize(w, h) {
      fitOrtho(camera, w, h, VIEW_HEIGHT)
    },
    pointer(p: SlotPointer) {
      if (p.kind === 'leave') {
        robot.lookAt(null)
        return
      }
      ray.setFromCamera(ndc.set(p.ndc.x, p.ndc.y), camera)
      if (p.kind === 'tap' && robot.hit(ray)) {
        robot.react('tap')
        return
      }
      if (!ray.ray.intersectPlane(ground, hitPoint)) return
      if (p.kind === 'move') {
        robot.lookAt(hitPoint)
      }
      else {
        goal.set(
          THREE.MathUtils.clamp(hitPoint.x, -BOUNDS.x, BOUNDS.x), 0,
          THREE.MathUtils.clamp(hitPoint.z, -BOUNDS.z, BOUNDS.z),
        )
        going = true
        robot.lookAt(goal)
      }
    },
    setPaused(paused) {
      robot.setPaused(paused)
      if (paused) robot.lookAt(null)
    },
    action(name) {
      if (name === 'nudge' || name === 'shove') {
        if (robot.busy) return 'Balancer is still getting up'
        robot.react(name === 'nudge' ? 'tap' : 'shove')
        return name === 'nudge' ? 'Balancer nudged' : 'Balancer shoved over; its kickstand will stand it back up'
      }
      return null
    },
    dispose() {
      robot.dispose()
    },
  }
}
