import * as THREE from 'three'
import { contactShadow, discGeometry, type MatKey } from '../../core/kit'
import type { SceneContext } from '../../core/stage'
import type { Robot, RobotCommand, RobotOptions } from '../types'
import { MAKEY_SHAPE, MAKEY_STEP, MakeyGait, NQ, lerpPose, newPose, poseJoints } from './gait'
import { buildMakey, createSkeleton, poseSkeleton } from './model'
import { playBoing, playHi, playStep, playThud } from './sound'

/**
 * Makey as a Robot. PROCEDURALLY ANIMATED and KINEMATIC (gait.ts plans the
 * steps, ik.ts solves the legs); falls and get-ups are SCRIPTED. This file
 * owns the drawing and the interface.
 *
 * Makey's body is always red (it is the mascot); `opts.accent` colours the
 * antenna tips, and setAccent() recolours them.
 *
 * Extras beyond Robot: wave(side) (+1 left arm, -1 right, 0 both),
 * `waving`, `autoWave` (on by default: it greets whatever it is looking at
 * once that holds still nearby -- the pointer, another robot's head).
 */

export type MakeyRobot = Omit<Robot, 'kind'> & {
  readonly kind: 'makey'
  readonly gait: MakeyGait
  readonly waving: boolean
  autoWave: boolean
  wave(side: number): void
}

export function createMakey(ctx: SceneContext, opts: RobotOptions): MakeyRobot {
  const poster = Boolean(opts.posterMode || ctx.posterMode)
  const gait = new MakeyGait(opts.seed, poster)
  const sk = createSkeleton()
  const accent: MatKey = opts.accent === 'red' ? 'dark' : opts.accent
  const parts = buildMakey(ctx.materials, accent, sk)

  const shadow = contactShadow(ctx.materials, 0.15)
  const ringGeo = discGeometry(0.16, 0.002, [{ x: 0, y: 0, r: 0.148 }], 48).rotateX(-Math.PI / 2)
  const marker = new THREE.Mesh(ringGeo, ctx.materials.face.cyan)
  marker.position.y = 0.001
  marker.visible = false
  sk.root.add(shadow, marker)

  const pose = newPose()
  const q = new Array(NQ).fill(0)
  const position = new THREE.Vector3()
  const sync = () => position.set(gait.cur.x, 0, gait.cur.z)
  const ev = { touch: gait.touchdowns, thud: gait.thuds, hop: gait.hops, wave: gait.waves }

  const sounds = () => {
    if (poster) return
    if (gait.touchdowns !== ev.touch) playStep(gait.mode === 'hop' ? 1 : 0.45)
    if (gait.thuds !== ev.thud) playThud()
    if (gait.hops !== ev.hop) playBoing()
    else if (gait.waves !== ev.wave) playHi()
    ev.touch = gait.touchdowns
    ev.thud = gait.thuds
    ev.hop = gait.hops
    ev.wave = gait.waves
  }

  function frame(alpha: number) {
    lerpPose(gait.prev, gait.cur, Math.min(1, Math.max(0, alpha)), pose)
    poseJoints(pose, q)
    poseSkeleton(sk, pose, q)
    parts.rig.update()
    parts.setGlow(pose.glow)
    const lying = Math.min(1, Math.abs(Math.sin(pose.pitch)))
    const fx = Math.sin(pose.yaw), fz = Math.cos(pose.yaw)
    // Lying down, the shadow stretches out under the body along its length.
    const off = 0.09 * Math.sin(pose.pitch)
    shadow.position.set(pose.x + fx * off, 0.0005, pose.z + fz * off)
    shadow.rotation.z = pose.yaw
    shadow.scale.set(1, 1 + 0.9 * lying, 1)
    marker.position.set(pose.x, 0.001, pose.z)
  }

  sync()
  frame(1)

  const robot: MakeyRobot = {
    kind: 'makey',
    gait,
    root: sk.root,
    radius: 0.1,
    maxSpeed: MAKEY_STEP.maxSpeed,
    mass: MAKEY_SHAPE.mass,
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
    get waving() {
      return gait.waving
    },
    get autoWave() {
      return gait.autoWave
    },
    set autoWave(on: boolean) {
      gait.autoWave = on
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
    wave(side) {
      gait.wave(side)
    },
    grab(at) {
      gait.grab(at)
    },
    dragTo(target) {
      gait.dragTo(target)
    },
    setSleep(on) {
      gait.setSleep(on)
    },
    setAccent(key: MatKey | null) {
      if (parts.tips) parts.tips.material = ctx.materials.face[key ?? accent]
    },
    setSelected(on) {
      marker.visible = on
    },
    setPaused(paused) {
      gait.setPaused(paused)
    },
    headPoint(out) {
      sk.neck.updateWorldMatrix(true, false)
      return out.set(0, 0.05, 0.02).applyMatrix4(sk.neck.matrixWorld)
    },
    hit(ray, out) {
      sk.root.updateWorldMatrix(true, true)
      const hits = ray.intersectObjects([...parts.meshes, ...parts.rig.meshes], false)
      if (!hits.length) return false
      out?.copy(hits[0]!.point)
      return true
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
