import * as THREE from 'three'
import { contactShadow, discGeometry, disposeGeometries, type MatKey } from '../../core/kit'
import type { SceneContext } from '../../core/stage'
import { grabForce, GRAB } from '../grab'
import type { Robot, RobotCommand, RobotOptions } from '../types'
import { DUCK_SHAPE, DuckGait, GAIT, lerpPose, newPose } from './gait'
import type { LegSolution } from './ik'
import { buildDuck, createSkeleton, poseSkeleton } from './model'
import { playBoing, playChirp, playStep, playThump } from './sound'

/**
 * The duck biped as a Robot. PROCEDURALLY ANIMATED and KINEMATIC: it is not
 * physically simulated. gait.ts plans footholds and moves the body; ik.ts
 * solves the legs; this file only owns the drawing and the interface.
 *
 * step() advances the gait at the fixed 5 ms step. frame() blends the last
 * two gait poses (pelvis pose, sole poses, look springs) by alpha and solves
 * the IK for THAT blend -- so even an interpolated frame has its stance soles
 * exactly on their footholds, rather than blending joint angles and letting
 * the feet drift between steps.
 *
 * Collisions go to the gait (gait.ts DUCK_SHAPE): the body shifts, planted
 * feet never do, and a real hit becomes recovery steps along the push.
 */

/** Neck slew rate (rad/s) that counts as a servo move worth a chirp, and the gap between chirps. */
const CHIRP_RATE = 1.6
const CHIRP_GAP = 0.3

export function createDuck(ctx: SceneContext, opts: RobotOptions): Robot {
  const poster = Boolean(opts.posterMode || ctx.posterMode)
  const gait = new DuckGait(opts.seed, !!opts.posterMode)
  const sk = createSkeleton()
  const parts = buildDuck(ctx.materials, opts.accent, sk)
  const accentMesh = sk.head.getObjectByName(`head:${opts.accent}`) as THREE.Mesh | undefined

  const shadow = contactShadow(ctx.materials, 0.13)
  // Selection is the only cyan: a thin ring on the ground around the robot.
  const marker = new THREE.Mesh(
    discGeometry(0.16, 0.002, [{ x: 0, y: 0, r: 0.148 }], 48).rotateX(-Math.PI / 2),
    ctx.materials.face.cyan,
  )
  marker.position.y = 0.001
  marker.visible = false
  sk.root.add(shadow, marker)

  const pose = newPose()
  const sols: [LegSolution, LegSolution] = [0, 1].map(() => ({
    hipYaw: 0, hipRoll: 0, hipPitch: 0, knee: 0, anklePitch: 0, ankleRoll: 0, dist: 0, clamped: false, limited: false,
  })) as [LegSolution, LegSolution]
  const position = new THREE.Vector3()
  const grab = { on: false, ox: 0, oy: 0, oz: 0, tx: 0, ty: 0, tz: 0 }
  const force = { x: 0, y: 0, z: 0 }
  const IDLE: RobotCommand = { speed: 0, yawRate: 0 }
  const sync = () => position.set(gait.bx, 0, gait.bz)

  // Sound bookkeeping: what changed since the last step.
  const stance = [gait.stanceId[0], gait.stanceId[1]]
  let airborne = false
  let chirpAt = -Infinity
  let neckRate = 0
  let time = 0

  const sounds = (dt: number) => {
    if (poster) return
    time += dt
    const hopping = gait.mode === 'hop' && !gait.planted[0] && !gait.planted[1]
    if (hopping && !airborne) playBoing()
    let landed = 0
    for (let i = 0; i < 2; i++) {
      if (gait.stanceId[i] !== stance[i]) {
        stance[i] = gait.stanceId[i]!
        landed++
      }
    }
    // A hop lands both feet at once: one louder tap. A step: a soft one.
    if (landed) playStep(airborne ? 1 : 0.4)
    airborne = hopping
    const rate = Math.hypot(gait.cur.neckYaw - gait.prev.neckYaw, gait.cur.neckPitch - gait.prev.neckPitch) / dt
    if (rate > CHIRP_RATE && neckRate <= CHIRP_RATE && time - chirpAt > CHIRP_GAP) {
      chirpAt = time
      playChirp(gait.cur.neckPitch > gait.prev.neckPitch)
    }
    neckRate = rate
  }

  function frame(alpha: number) {
    lerpPose(gait.prev, gait.cur, alpha, pose)
    poseSkeleton(sk, pose, sols)
    // The shadow sits under the body and shrinks while the feet are off the ground.
    const fa = pose.feet[0], fb = pose.feet[1]
    const air = Math.min(fa.y, fb.y)
    shadow.position.set((fa.x + fb.x + 2 * pose.x) / 4, 0.0005, (fa.z + fb.z + 2 * pose.z) / 4)
    shadow.scale.setScalar(1 - 0.35 * Math.min(1, air / 0.04))
    marker.position.x = pose.x
    marker.position.z = pose.z
    // Status LED: a slow blink, quick while it is busy (fallen, staggering, hopping).
    parts.led.visible = poster || (time % (gait.busy ? 0.4 : 1.4)) < 0.12
  }

  sync()
  frame(1)

  return {
    kind: 'duck',
    root: sk.root,
    radius: 0.12,
    maxSpeed: GAIT.maxSpeed,
    mass: DUCK_SHAPE.mass,
    colliders: gait.colliders,
    position,
    get heading() {
      return gait.yaw
    },
    get busy() {
      return gait.busy || grab.on
    },
    get fallen() {
      return gait.fallen
    },
    placeAt(x, z, heading) {
      gait.placeAt(x, z, heading)
      sync()
      frame(1)
    },
    step(dt: number, cmd: RobotCommand) {
      if (grab.on) {
        // The pull, at the picked point carried with the pelvis, as a force the gait answers.
        const px = gait.cur.x + grab.ox, py = Math.max(0.02, gait.cur.y + grab.oy), pz = gait.cur.z + grab.oz
        grabForce(px, py, pz, gait.vx, 0, gait.vz, grab.tx, grab.ty, grab.tz, force)
        gait.ext.x = force.x
        gait.ext.y = force.y
        gait.ext.z = force.z
        gait.ext.h = py
      }
      gait.step(dt, grab.on ? IDLE : cmd)
      gait.ext.x = gait.ext.y = gait.ext.z = 0
      sync()
      sounds(dt)
      if (!poster && gait.fall.landed) playThump(Math.min(1, gait.fall.landRate / 6))
    },
    grab(at) {
      if (!at) {
        grab.on = false
        return
      }
      grab.ox = at.x - gait.cur.x
      grab.oy = at.y - gait.cur.y
      grab.oz = at.z - gait.cur.z
      grab.tx = at.x
      grab.ty = at.y
      grab.tz = at.z
      grab.on = true
    },
    dragTo(t) {
      grab.tx = t.x
      grab.ty = Math.max(t.y, GRAB.lift)
      grab.tz = t.z
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
    setSleep(on) {
      gait.setSleep(on)
    },
    setAccent(key: MatKey | null) {
      if (accentMesh) accentMesh.material = ctx.materials.face[key ?? opts.accent]
    },
    setSelected(on) {
      marker.visible = on
    },
    setPaused(paused) {
      gait.setPaused(paused)
      if (paused) grab.on = false
    },
    headPoint(out) {
      sk.head.updateWorldMatrix(true, false)
      return out.setFromMatrixPosition(sk.head.matrixWorld)
    },
    hit(ray, out) {
      const hits = ray.intersectObjects(parts.meshes, false)
      if (!hits.length) return false
      out?.copy(hits[0]!.point)
      return true
    },
    dispose() {
      sk.root.removeFromParent()
      disposeGeometries(sk.root)
      parts.dispose()
    },
  }
}
