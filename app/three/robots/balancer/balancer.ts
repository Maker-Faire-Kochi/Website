import * as THREE from 'three'
import { DT } from '../../core/clock'
import type { MatKey } from '../../core/kit'
import { rng } from '../../core/rng'
import type { SceneContext } from '../../core/stage'
import { grabForce, GRAB } from '../grab'
import type { Robot, RobotCommand, RobotOptions } from '../types'
import { BalancerSim, CONTACT_SHAPE, HEAD, HeadSpring, IMPULSE_FALL, LIMITS } from './dynamics'
import { GEO } from './geometry'
import { buildBalancerModel } from './model'
import { BalancerVoice } from './sound'

/**
 * The wheel-legged balancer: the simulation in dynamics.ts bound to the kit
 * model in model.ts.
 *
 * Every step advances the sim and the head springs once; frame() only
 * interpolates between the last two steps, so what you see is exactly what
 * was simulated, at any refresh rate. Wheels turn by their own integrated
 * arc (angle = s / r); legs are posed from the simulated leg length.
 *
 * Reactions: 'tap' is a small JUMP (simulated: crouch, fast extension,
 * ballistic flight, sprung landing). 'shove' is 1.2 x the pitch impulse that
 * topples it, so it falls (simulated) and rights itself with its legs
 * (SCRIPTED -- dynamics.ts 'righting'). 'tumble' is a harder version.
 *
 * Grab: a spring-damper (robots/grab.ts) between the picked point (held at
 * its height up the body) and the pointer target, applied as a FORCE in the
 * sim -- it tilts, its LQR fights, dragged hard it falls; released, it keeps
 * whatever motion it had.
 *
 * Idle posture: now and then it crouches or stands tall (seeded); asleep it
 * crouches low.
 */

const SHOVE = 1.2 * IMPULSE_FALL
const TUMBLE = 1.7 * IMPULSE_FALL
/** Waking from the easter-egg sleep: a small jolt backward. */
const STARTLE = 0.25 * IMPULSE_FALL
/** Motor whine is refreshed every this many steps (50 ms). */
const WHINE_EVERY = 10
/** LED: on for `on` s every `period` s (faster while busy). */
const LED = { period: 1.6, on: 0.12, busyPeriod: 0.4 }

// Snapshot layout for interpolation.
const X = 0, Z = 1, PSI = 2, TH = 3, SL = 4, SR = 5, LEG = 6, YAW = 7, PITCH = 8, YW = 9

export type Balancer = Robot & { readonly sim: BalancerSim }

export function createBalancer(ctx: SceneContext, opts: RobotOptions): Balancer {
  const poster = Boolean(opts.posterMode || ctx.posterMode)
  const model = buildBalancerModel(ctx.materials, opts.accent)
  const sim = new BalancerSim({ seed: opts.seed, noise: !poster, disturbance: !poster })
  const head = new HeadSpring()
  const rand = rng(opts.seed * 7919 + 13)
  const voice = new BalancerVoice()
  // The head's accent mesh: whichever mesh wears the accent material.
  let accentMesh: THREE.Mesh | undefined
  model.root.traverse((o) => {
    if (!accentMesh && (o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === ctx.materials.face[opts.accent]) accentMesh = o as THREE.Mesh
  })

  const prev = new Float64Array(10)
  const cur = new Float64Array(10)
  const position = new THREE.Vector3()
  const goal: [number, number] = [0, 0]
  let target: THREE.Vector3 | null = null
  let queued: 'tap' | 'shove' | 'tumble' | null = null
  let glance = { yaw: 0, pitch: 0.12, until: 0 }
  let posture: { leg: number, until: number } = { leg: GEO.legStand, until: 2 }
  let time = 0
  let asleep = false
  let lastMode = sim.mode
  let lastContact = false
  let lastAir = false
  // Grab: the picked point's height up the body and its lateral/forward offset (body frame).
  const grab = { on: false, h: 0, tx: 0, ty: 0, tz: 0 }
  const force = { x: 0, y: 0, z: 0 }

  const snapshot = (out: Float64Array) => {
    out[X] = sim.X
    out[Z] = sim.Z
    out[PSI] = sim.psi
    out[TH] = sim.th
    out[SL] = sim.sL
    out[SR] = sim.sR
    out[LEG] = sim.L
    out[YAW] = head.yaw
    out[PITCH] = head.pitch
    out[YW] = sim.yw
  }

  /** Eye height above the axle along the body. */
  const eyeUp = () => sim.L + GEO.eyeUp

  /**
   * Head angles that point the eyes at the target, in the head's own frame:
   * the target is carried into the pitched body frame first, so the head
   * holds its gaze while the body sways under it. Writes [yaw, pitch] into out.
   */
  const aim = (t: THREE.Vector3, out: [number, number]) => {
    const dx = t.x - sim.X
    const dz = t.z - sim.Z
    const c = Math.cos(sim.psi)
    const s = Math.sin(sim.psi)
    const lx = dx * c - dz * s
    const lz = dx * s + dz * c
    const ly = t.y - sim.yw
    const ct = Math.cos(sim.th)
    const st = Math.sin(sim.th)
    const by = ly * ct + lz * st - (eyeUp() - 0.006)
    const bz = -ly * st + lz * ct
    out[0] = Math.atan2(lx, bz)
    out[1] = Math.atan2(-by, Math.hypot(lx, bz))
    return out
  }

  const headGoal = (out: [number, number]) => {
    // Fallen or righting: the head is sprung back to centre.
    if (sim.mode !== 'balancing') {
      out[0] = 0
      out[1] = 0
      return out
    }
    if (asleep) {
      out[0] = 0
      out[1] = HEAD.pitchLimit * (0.8 + 0.2 * Math.sin(Math.PI * 2 * time / 3.6))
      return out
    }
    if (target) return aim(target, out)
    if (poster) {
      out[0] = 0
      out[1] = 0.12
      return out
    }
    if (time >= glance.until) {
      glance = {
        yaw: rand.range(-1.1, 1.1),
        pitch: rand.range(-0.15, 0.32),
        until: time + rand.range(1.2, 3.6),
      }
    }
    out[0] = glance.yaw
    out[1] = glance.pitch
    return out
  }

  /** Idle posture: mostly standing, sometimes a crouch or a stretch tall; asleep, a low crouch. */
  const postureStep = () => {
    if (poster) return
    if (asleep) {
      sim.setLeg(GEO.legCrouch - 0.01)
      return
    }
    if (time >= posture.until) {
      const r = rand.next()
      posture = { leg: r < 0.6 ? GEO.legStand : r < 0.8 ? GEO.legTall : GEO.legCrouch + 0.01, until: time + rand.range(2.5, 6) }
    }
    sim.setLeg(posture.leg)
  }

  /** Voices follow the simulated events: landing on the pod, the legs pushing it up, jumps, the motor. */
  const sounds = () => {
    if (poster) return
    if (sim.contact && !lastContact && sim.mode === 'fallen') voice.thud(Math.min(1, Math.abs(sim.thd) / 4 + 0.4))
    if (sim.mode === 'righting' && lastMode !== 'righting') voice.ratchet(6, 0.4)
    if (lastAir && !sim.air) voice.thud(0.25)
    lastContact = sim.contact
    lastMode = sim.mode
    lastAir = sim.air
    if (sim.steps % WHINE_EVERY === 0) {
      const v = sim.mode === 'balancing' && !sim.air ? Math.abs(sim.xd) + Math.abs(sim.omega) * sim.p.w / 2 : 0
      voice.whine(v)
    }
  }

  /** The grab point in world space and its velocity (from the sim's state). */
  const grabPoint = () => {
    const fx = Math.sin(sim.psi), fz = Math.cos(sim.psi)
    const h = grab.h
    const st = Math.sin(sim.th), ct = Math.cos(sim.th)
    const along = sim.xd + h * ct * sim.thd
    return {
      x: sim.X + fx * h * st, y: sim.yw + h * ct, z: sim.Z + fz * h * st,
      vx: fx * along + sim.skidX, vy: sim.ywd - h * st * sim.thd, vz: fz * along + sim.skidZ,
    }
  }

  const robot: Balancer = {
    kind: 'balancer',
    root: model.root,
    radius: 0.11,
    maxSpeed: LIMITS.maxSpeed,
    mass: CONTACT_SHAPE.mass,
    colliders: sim.colliders,
    position,
    sim,
    get heading() {
      return sim.psi
    },
    get busy() {
      return sim.busy || grab.on
    },
    get fallen() {
      return sim.fallen
    },

    placeAt(x, z, heading) {
      sim.place(x, z, heading)
      position.set(x, 0, z)
      snapshot(prev)
      snapshot(cur)
      robot.frame(1)
    },

    step(_dt: number, cmd: RobotCommand) {
      // The sim always advances exactly DT (core/clock), which is what the stage passes.
      prev.set(cur)
      if (queued && !sim.busy) {
        if (queued === 'tap') sim.jump()
        else sim.impulse(-(queued === 'shove' ? SHOVE : TUMBLE))
      }
      queued = null
      postureStep()
      if (grab.on) {
        const g = grabPoint()
        grabForce(g.x, g.y, g.z, g.vx, g.vy, g.vz, grab.tx, grab.ty, grab.tz, force)
        sim.extX = force.x
        sim.extY = force.y
        sim.extZ = force.z
        sim.extH = grab.h
      }
      sim.step(grab.on ? { speed: 0, yawRate: 0 } : cmd)
      sim.extX = sim.extY = sim.extZ = 0
      time += DT
      const g = headGoal(goal)
      head.step(g[0], g[1], DT)
      position.set(sim.X, 0, sim.Z)
      snapshot(cur)
      sounds()
    },

    collide(normal, depth, relSpeed, other, part) {
      sim.collide(normal, depth, relSpeed, other, part)
      // The interpolation target follows the pushed state; prev stays, so the push is drawn smoothly.
      position.set(sim.X, 0, sim.Z)
      snapshot(cur)
    },

    frame(alpha) {
      const a = Math.min(1, Math.max(0, alpha))
      const lerp = (i: number) => prev[i]! + (cur[i]! - prev[i]!) * a
      model.root.position.set(lerp(X), 0, lerp(Z))
      model.root.rotation.y = lerp(PSI)
      model.axle.position.y = lerp(YW)
      model.body.rotation.x = lerp(TH)
      const leg = lerp(LEG)
      model.setLegs(leg, leg)
      model.wheelL.rotation.x = lerp(SL) / GEO.wheelR
      model.wheelR.rotation.x = lerp(SR) / GEO.wheelR
      if (poster) {
        // A poster is one deterministic frame: aim the head outright, no spring.
        if (target) aim(target, goal)
        else {
          goal[0] = 0
          goal[1] = 0.12
        }
        model.headYaw.rotation.y = THREE.MathUtils.clamp(goal[0], -HEAD.yawLimit, HEAD.yawLimit)
        model.headPitch.rotation.x = THREE.MathUtils.clamp(goal[1], -HEAD.pitchLimit, HEAD.pitchLimit)
      }
      else {
        model.headYaw.rotation.y = lerp(YAW)
        model.headPitch.rotation.x = lerp(PITCH)
      }
      // Status LED: a slow blink, quick while it is busy (falling, righting, jumping).
      const period = sim.busy ? LED.busyPeriod : LED.period
      model.led.visible = poster || (time % period) < LED.on
      // The contact shadow sits under the COM, stretches as the body lies down, fades in the air.
      const th = lerp(TH)
      const s = Math.sin(th)
      model.shadow.position.z = (leg * 0.8) * s
      const air = Math.min(1, Math.max(0, (lerp(YW) - GEO.wheelR) / 0.06))
      model.shadow.scale.set(1 - 0.3 * air, 1 + 1.2 * Math.abs(s), 1)
      model.shadow.position.y = 0.0005
    },

    lookAt(t) {
      target = t ? (target ?? new THREE.Vector3()).copy(t) : null
    },

    react(kind) {
      if (sim.busy) return
      queued = kind
    },

    grab(at) {
      if (!at) {
        grab.on = false
        return
      }
      // Height of the picked point up the body (projected onto the body axis).
      const fx = Math.sin(sim.psi), fz = Math.cos(sim.psi)
      const dx = at.x - sim.X, dz = at.z - sim.Z
      const along = dx * fx + dz * fz
      const up = at.y - sim.yw
      const h = along * Math.sin(sim.th) + up * Math.cos(sim.th)
      grab.h = THREE.MathUtils.clamp(h, 0, sim.L + GEO.eyeUp)
      const g = grabPoint()
      grab.tx = g.x
      grab.ty = g.y
      grab.tz = g.z
      grab.on = true
    },

    dragTo(t) {
      grab.tx = t.x
      grab.ty = Math.max(t.y, GRAB.lift)
      grab.tz = t.z
    },

    setSleep(on) {
      if (asleep && !on && !sim.busy && !poster) sim.impulse(-STARTLE)
      asleep = on
    },

    setAccent(key: MatKey | null) {
      if (accentMesh) accentMesh.material = ctx.materials.face[key ?? opts.accent]
    },

    setSelected(on) {
      model.ring.visible = on
    },

    setPaused(paused) {
      if (!paused) return
      queued = null
      grab.on = false
      sim.clearQueue()
      voice.stop()
    },

    headPoint(out) {
      model.headPitch.updateWorldMatrix(true, false)
      return out.setFromMatrixPosition(model.headPitch.matrixWorld)
    },

    hit(ray, out) {
      model.root.updateWorldMatrix(true, true)
      const hits = ray.intersectObjects(model.pick, false)
      if (hits.length) {
        out?.copy(hits[0]!.point)
        return true
      }
      // Thin legs: also accept rays passing close to the body's axis.
      const a = new THREE.Vector3(0, 0, 0).applyMatrix4(model.body.matrixWorld)
      const b = new THREE.Vector3(0, sim.L + GEO.eyeUp, 0).applyMatrix4(model.body.matrixWorld)
      const on = new THREE.Vector3()
      if (ray.ray.distanceSqToSegment(a, b, undefined, on) < 0.04 * 0.04) {
        out?.copy(on)
        return true
      }
      return false
    },

    dispose() {
      voice.stop()
      model.root.removeFromParent()
      model.dispose()
    },
  }

  snapshot(prev)
  snapshot(cur)
  robot.frame(1)
  return robot
}
