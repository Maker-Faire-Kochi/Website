import * as THREE from 'three'
import { contactShadow, discGeometry, type MatKey } from '../../core/kit'
import type { SceneContext } from '../../core/stage'
import type { Robot, RobotCommand, RobotOptions } from '../types'
import { DOG_SHAPE, DOG_STEP, DogGait, lerpPose, newPose, poseJoints, type Posture } from './gait'
import { buildDog, createSkeleton, poseSkeleton } from './model'
import { playPaw, playThud, playYip } from './sound'

/**
 * The robot dog as a Robot. PROCEDURALLY ANIMATED and KINEMATIC: gait.ts
 * plans the trot and the postures, ik.ts solves the legs; falls and the
 * self-righting roll are SCRIPTED (script.ts). This file owns the drawing
 * and the interface.
 *
 * step() advances the gait at the fixed 5 ms step. frame() blends the last
 * two gait poses (body pose and FOOT positions) by alpha and solves the IK
 * for that blend, so even an interpolated frame has its planted feet exactly
 * on their footholds.
 *
 * Extras beyond Robot (for a director that knows it has a dog):
 * setPosture('sit' | 'bow' | 'lie' | 'stand'), and `gait` for diagnostics.
 */

export type DogRobot = Omit<Robot, 'kind'> & {
  readonly kind: 'dog'
  readonly gait: DogGait
  readonly posture: Posture
  setPosture(p: Posture): void
}

export function createDog(ctx: SceneContext, opts: RobotOptions): DogRobot {
  const poster = Boolean(opts.posterMode || ctx.posterMode)
  const gait = new DogGait(opts.seed, poster)
  const sk = createSkeleton()
  const parts = buildDog(ctx.materials, opts.accent, sk)

  const shadow = contactShadow(ctx.materials, 0.24)
  shadow.scale.set(0.75, 1.25, 1)
  const ringGeo = discGeometry(0.26, 0.002, [{ x: 0, y: 0, r: 0.245 }], 56).rotateX(-Math.PI / 2)
  const marker = new THREE.Mesh(ringGeo, ctx.materials.face.cyan)
  marker.position.y = 0.001
  marker.visible = false
  sk.root.add(shadow, marker)

  const pose = newPose()
  const q = new Array(12).fill(0)
  const position = new THREE.Vector3()
  const sync = () => position.set(gait.cur.x, 0, gait.cur.z)
  const ev = { touch: gait.touchdowns, thud: gait.thuds, hop: gait.hops }

  const sounds = () => {
    if (poster) return
    if (gait.touchdowns !== ev.touch) playPaw(Math.min(1, Math.abs(gait.stepper.v) / 0.3))
    if (gait.thuds !== ev.thud) playThud(gait.script.tag === 'belly' ? 0.6 : 1)
    if (gait.hops !== ev.hop) playYip()
    ev.touch = gait.touchdowns
    ev.thud = gait.thuds
    ev.hop = gait.hops
  }

  function frame(alpha: number) {
    lerpPose(gait.prev, gait.cur, Math.min(1, Math.max(0, alpha)), pose)
    poseJoints(pose, q)
    poseSkeleton(sk, pose, q)
    parts.rig.update()
    // The shadow lies under the body, turned with it, wider when it lies on its side.
    const side = Math.abs(Math.sin(pose.roll))
    shadow.position.set(pose.x, 0.0005, pose.z)
    shadow.rotation.z = pose.yaw
    shadow.scale.set(0.75 + 0.5 * side, 1.25, 1)
    marker.position.set(pose.x, 0.001, pose.z)
  }

  sync()
  frame(1)
  const hitPoint = new THREE.Vector3()

  const robot: DogRobot = {
    kind: 'dog',
    gait,
    root: sk.root,
    radius: 0.17,
    maxSpeed: DOG_STEP.maxSpeed,
    mass: DOG_SHAPE.mass,
    colliders: gait.colliders,
    position,
    get heading() {
      return gait.heading
    },
    get busy() {
      return gait.busy
    },
    get fallen() {
      return gait.fallen
    },
    get posture() {
      return gait.posture
    },
    placeAt(x, z, heading) {
      gait.placeAt(x, z, heading)
      sync()
      frame(1)
    },
    step(dt: number, cmd: RobotCommand) {
      gait.step(dt, cmd)
      sync()
      sounds()
    },
    collide(normal, depth, relSpeed, other, part) {
      gait.collide(normal, depth, relSpeed, other, part)
      sync()
    },
    frame,
    lookAt(target) {
      gait.lookAt(target)
    },
    react(kind) {
      gait.react(kind)
    },
    grab(at) {
      gait.grab(at)
    },
    dragTo(target) {
      gait.dragTo(target)
    },
    setPosture(p) {
      gait.setPosture(p)
    },
    setSleep(on) {
      gait.setSleep(on)
    },
    setAccent(key: MatKey | null) {
      if (parts.headShell) parts.headShell.material = ctx.materials.face[key ?? opts.accent]
    },
    setSelected(on) {
      marker.visible = on
    },
    setPaused(paused) {
      gait.setPaused(paused)
    },
    headPoint(out) {
      sk.head.updateWorldMatrix(true, false)
      return out.set(0, 0.02, 0.03).applyMatrix4(sk.head.matrixWorld)
    },
    hit(ray, out) {
      sk.root.updateWorldMatrix(true, true)
      const hits = ray.intersectObjects([...parts.meshes, ...parts.rig.meshes], false)
      if (hits.length) {
        out?.copy(hits[0]!.point)
        return true
      }
      // Thin legs: also accept a ray passing close to the trunk's axis.
      const a = hitPoint.set(0, 0, -0.17).applyMatrix4(sk.body.matrixWorld)
      const b = new THREE.Vector3(0, 0, 0.2).applyMatrix4(sk.body.matrixWorld)
      if (ray.ray.distanceSqToSegment(a, b, undefined, out) < 0.06 * 0.06) return true
      return false
    },
    dispose() {
      sk.root.removeFromParent()
      parts.dispose()
      shadow.geometry.dispose()
      ringGeo.dispose()
    },
  }
  return robot
}
