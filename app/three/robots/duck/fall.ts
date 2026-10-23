import { LEG } from './ik'

/**
 * The duck falling over and getting up again.
 *
 * TOPPLE is simulated: the whole duck is one rigid body pivoting about the
 * edge of its feet on the side it is falling toward, under gravity -- an
 * inverted pendulum, phi'' = g sin(phi - phiC) / (k L), where phiC is the
 * angle at which its centre of mass passes over that edge. A push that does
 * not carry it past phiC rocks it back; one that does brings it down. A
 * grab-drag adds its own torque about the edge. It lands when any point of
 * its body (torso corners, tail, head, the tucked feet) would go below the
 * ground; it bounces with restitution and comes to rest.
 *
 * Falls are quantised to the four body-relative directions it can actually
 * land in: on its front (pitch +), back (pitch -), left or right side (roll).
 * Its legs fold up against its body as it goes over.
 *
 * GETTING UP is SCRIPTED (eased keyframes, not simulated), like the
 * balancer's kickstand: it rolls onto its belly with its feet swinging down
 * under its hips (planted at the end of the roll), pushes up from a deep
 * crouch to standing over those planted feet, and the gait takes over with
 * a small balancing stagger. Throughout, the pelvis height is held at or
 * above the lowest height that keeps every body point out of the ground, so
 * nothing ever passes through it.
 */

export const FALL = {
  g: 9.81,
  /** Height of the centre of mass above the pelvis origin, m. */
  com: 0.05,
  /** Rotational inertia factor about the edge (1 = point mass). */
  inertia: 1.35,
  /** Support edges from the pelvis's ground point: toe, heel, outer sole edge. */
  edgeFront: 0.06,
  edgeBack: 0.035,
  edgeSide: LEG.hipW + 0.021,
  restitution: 0.25,
  /** Below this landing rate (rad/s) it does not bounce: it lies. */
  restRate: 0.6,
  /** Lie still this long before getting up. */
  lie: 0.6,
  /** Scripted get-up phases, s. */
  roll: 0.7,
  rise: 0.8,
  /** Crouch at the end of the roll: pelvis height and forward lean. */
  crouchY: 0.075,
  crouchPitch: 0.35,
  /** Never rotate further than this (it is lying flat by then). */
  maxAngle: 1.62,
  /** Feet folded against the body, pelvis frame (left foot; right is mirrored). */
  tuck: { x: LEG.hipW, y: -0.088, z: -0.01 },
}

/**
 * Points of the body that must stay above the ground, pelvis frame, taken
 * from model.ts: the corners of the body shell (leaning forward by its
 * BODY_LEAN, 0.18 rad), the tail tip, the hip servos, and the neck, round
 * helmet, bill and antenna tips at the neutral neck pose.
 */
export const BODY_POINTS: [number, number, number][] = []
{
  const lean = 0.18, c = Math.cos(lean), s = Math.sin(lean)
  for (const x of [-0.054, 0.054]) {
    for (const [z, y] of [[-0.07, 0.047], [-0.058, 0.035], [0.038, 0.035], [0.05, 0.047], [0.05, 0.076], [0.028, 0.098], [-0.048, 0.098], [-0.07, 0.076]]) {
      BODY_POINTS.push([x, y! * c - z! * s, y! * s + z! * c])
    }
  }
}
BODY_POINTS.push([0, 0.086, -0.1]) // tail rail tip
BODY_POINTS.push([0.045, 0.01, 0.015], [-0.045, 0.01, 0.015], [0.045, 0.01, -0.015], [-0.045, 0.01, -0.015]) // hip servos
BODY_POINTS.push([0, 0.17, 0.05], [0, 0.21, 0.06], [0.031, 0.24, 0.05], [-0.031, 0.24, 0.05], [0.031, 0.27, 0.12], [-0.031, 0.27, 0.12], [0, 0.3, 0.07], [0, 0.23, 0.15]) // neck, helmet, bill
BODY_POINTS.push([0.024, 0.33, 0.055], [-0.024, 0.33, 0.055]) // antenna tips
/** Tucked sole corners (both feet), pelvis frame. */
export const FOOT_POINTS: [number, number, number][] = []
for (const s of [1, -1]) {
  for (const dx of [-0.021, 0.021]) {
    for (const dz of [-0.033, 0.053]) FOOT_POINTS.push([s * FALL.tuck.x + dx, FALL.tuck.y - 0.003, FALL.tuck.z + dz])
  }
}

export type FallDir = 'front' | 'back' | 'left' | 'right'
export type FallPhase = 'topple' | 'lie' | 'roll' | 'rise' | 'done'

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const ease = (t: number) => {
  const u = clamp(t, 0, 1)
  return u * u * u * (u * (u * 6 - 15) + 10)
}

/** Pelvis rotation for a fall angle: [pitch, roll] (yaw unchanged). */
function angles(dir: FallDir, phi: number): [number, number] {
  switch (dir) {
    case 'front': return [phi, 0]
    case 'back': return [-phi, 0]
    case 'left': return [0, -phi]
    default: return [0, phi]
  }
}

/** World-frame y of a pelvis-frame point after pitch then roll (yaw does not change heights). */
function rotY(pitch: number, roll: number, p: [number, number, number]) {
  // Pelvis rotation = Ry(yaw) Rx(pitch) Rz(roll); y-row of Rx(pitch) Rz(roll).
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll)
  return sp * 0 + p[0] * (cp * sr) + p[1] * (cp * cr) - p[2] * sp
}

/** Lowest pelvis height that keeps every listed point at or above the ground. */
export function clearance(pitch: number, roll: number, feet: boolean) {
  let c = 0
  for (const p of BODY_POINTS) c = Math.max(c, -rotY(pitch, roll, p))
  if (feet) for (const p of FOOT_POINTS) c = Math.max(c, -rotY(pitch, roll, p))
  return c + 0.002
}

/** Lowest a sole's centre may sit so none of its corners (tilted by pitch/roll) goes below the ground. */
function soleClear(pitch: number, roll: number) {
  let c = 0
  for (const dx of [-0.021, 0.021]) {
    for (const dz of [-0.033, 0.053]) c = Math.max(c, -rotY(pitch, roll, [dx, -0.003, dz]))
  }
  return c
}

/** A pelvis-frame vector rotated by pitch, roll and yaw into world (x, y, z). */
export function toWorld(yaw: number, pitch: number, roll: number, x: number, y: number, z: number, out: number[]) {
  // Rz(roll)
  const cr = Math.cos(roll), sr = Math.sin(roll)
  const x1 = cr * x - sr * y
  const y1 = sr * x + cr * y
  // Rx(pitch)
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  const y2 = cp * y1 - sp * z
  const z2 = sp * y1 + cp * z
  // Ry(yaw)
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  out[0] = cy * x1 + sy * z2
  out[1] = y2
  out[2] = -sy * x1 + cy * z2
  return out
}

export interface FallFoot { x: number, y: number, z: number, yaw: number, pitch: number, roll: number }

/**
 * One fall, from the push to standing again. The gait owns it while its
 * mode is 'fall' and reads the pose from it every step.
 */
export class DuckFall {
  phase: FallPhase = 'done'
  dir: FallDir = 'back'
  phi = 0
  phid = 0
  t = 0
  /** Pelvis pose (world). */
  x = 0
  y = 0
  z = 0
  yaw = 0
  pitch = 0
  roll = 0
  readonly feet: [FallFoot, FallFoot] = [
    { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
    { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
  ]
  /** Set true for one step when the body hits the ground (for sound). */
  landed = false
  landRate = 0

  // Pivot (world, on the ground) and the pelvis offset from it in the fall's local frame.
  private px = 0
  private pz = 0
  private ox = 0
  private oz = 0
  private h0 = 0
  private phiC = 0
  private L = 0
  private feet0: [FallFoot, FallFoot] = [
    { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
    { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 },
  ]
  private lie0 = { x: 0, y: 0, z: 0, pitch: 0, roll: 0 }
  private rest = 0
  private tmp = [0, 0, 0]

  /**
   * Start a fall. (dx, dz): world direction of the push; speed: how hard
   * (m/s at the pelvis). Pelvis pose and the planted feet at this moment.
   */
  start(dx: number, dz: number, speed: number, pelvis: { x: number, y: number, z: number, yaw: number }, feet: readonly { x: number, y: number, z: number, yaw: number }[]) {
    const fx = Math.sin(pelvis.yaw), fz = Math.cos(pelvis.yaw)
    const along = dx * fx + dz * fz
    const left = dx * fz - dz * fx
    this.dir = Math.abs(along) >= Math.abs(left) ? (along >= 0 ? 'front' : 'back') : (left >= 0 ? 'left' : 'right')
    const e = this.dir === 'front' ? FALL.edgeFront : this.dir === 'back' ? FALL.edgeBack : FALL.edgeSide
    // Pivot on the ground at the support edge, in the body's yaw frame (x left, z forward).
    const lx = this.dir === 'left' ? e : this.dir === 'right' ? -e : 0
    const lz = this.dir === 'front' ? e : this.dir === 'back' ? -e : 0
    this.yaw = pelvis.yaw
    this.px = pelvis.x + lx * fz + lz * fx
    this.pz = pelvis.z - lx * fx + lz * fz
    this.ox = -lx
    this.oz = -lz
    this.h0 = pelvis.y
    const hc = pelvis.y + FALL.com
    this.phiC = Math.atan2(e, hc)
    this.L = Math.hypot(e, hc)
    // At least enough spin to carry the centre of mass over the edge: the push decided it falls.
    const need = Math.sqrt(2 * FALL.g * (this.L - hc) / (FALL.inertia * this.L)) / this.L * 1.15
    this.phi = 0
    this.phid = Math.max(speed / this.L, need)
    this.phase = 'topple'
    this.t = 0
    this.rest = 0
    this.leanT = 0
    for (let i = 0; i < 2; i++) Object.assign(this.feet0[i]!, feet[i], { pitch: 0, roll: 0 })
    this.pose()
  }

  /**
   * Falling into another robot: the contact stops the rotation (a small
   * bounce off it). Leaning on it long enough, it settles there as if it had
   * landed, and gets up from that pose.
   */
  blocked(dt: number) {
    if (this.phase !== 'topple') return
    if (this.phid > 0) this.phid = -FALL.restitution * this.phid
    this.leanT += dt
    if (this.leanT > 0.5) {
      this.phid = 0
      this.landed = true
      this.landRate = 0.5
      this.settle()
    }
  }

  private leanT = 0

  private settle() {
    this.phase = 'lie'
    this.t = 0
    this.lie0.x = this.x
    this.lie0.y = this.y
    this.lie0.z = this.z
    this.lie0.pitch = this.pitch
    this.lie0.roll = this.roll
  }

  /** Move the whole fallen body (a collision while it lies). */
  shift(dx: number, dz: number) {
    this.px += dx
    this.pz += dz
    this.x += dx
    this.z += dz
    this.lie0.x += dx
    this.lie0.z += dz
    for (const f of this.feet) {
      f.x += dx
      f.z += dz
    }
    for (const f of this.feet0) {
      f.x += dx
      f.z += dz
    }
  }

  /**
   * One step. torque: extra torque about the edge from a drag (N m, positive
   * = toward the fall), divided here by the duck's inertia. Returns true
   * when it is standing again (the gait takes over).
   */
  step(dt: number, torque = 0, mass = 1.3) {
    this.t += dt
    this.landed = false
    switch (this.phase) {
      case 'topple': {
        const I = FALL.inertia * mass * this.L * this.L
        this.phid += (FALL.g * Math.sin(this.phi - this.phiC) / (FALL.inertia * this.L) + torque / I) * dt
        this.phi += this.phid * dt
        if (this.phi < 0) {
          // Rocked back onto its feet: it did not go over after all.
          this.phi = 0
          this.phid = 0
          this.phase = 'done'
          return true
        }
        this.pose()
        // Ground contact: the rigid rotation would put some body point below the ground.
        const [p, r] = angles(this.dir, this.phi)
        const rotYc = this.rotatedY()
        if ((rotYc < clearance(p, r, true) && this.phid > 0) || this.phi > FALL.maxAngle) {
          this.landed = true
          this.landRate = this.phid
          this.phid = this.phid < FALL.restRate ? 0 : -FALL.restitution * this.phid
          if (this.phid === 0) this.settle()
        }
        return false
      }
      case 'lie': {
        if (this.t >= FALL.lie) {
          this.phase = 'roll'
          this.t = 0
          for (let i = 0; i < 2; i++) Object.assign(this.feet0[i]!, this.feet[i])
        }
        return false
      }
      case 'roll': {
        // SCRIPTED: first it rolls upright (onto its belly) with its legs still
        // folded against it, the feet swinging down under the hips; then it
        // tips forward into a crouch over them. Two separate rotations, so the
        // legs only ever fold and unfold -- the joints are never wrenched.
        const u = this.t / FALL.roll
        const kA = ease(u / 0.6)
        const kB = ease((u - 0.6) / 0.4)
        this.pitch = this.lie0.pitch * (1 - kA) + FALL.crouchPitch * kB
        this.roll = this.lie0.roll * (1 - kA)
        this.x = this.lie0.x
        this.z = this.lie0.z
        let y = Math.max(this.lie0.y + (FALL.crouchY - this.lie0.y) * ease(u), clearance(this.pitch, this.roll, false))
        const cp = Math.cos(FALL.crouchPitch), sp = Math.sin(FALL.crouchPitch)
        // Two passes: place the feet in the body frame, then lift the body if a sole would dig in.
        for (let pass = 0; pass < 2; pass++) {
        this.y = y
        for (let i = 0; i < 2; i++) {
          const side = i === 0 ? 1 : -1
          const f = this.feet[i]!
          // Body-frame foot: tucked -> under the hips (upright) -> under the crouch.
          let lx = side * FALL.tuck.x, ly = FALL.tuck.y + (-FALL.crouchY - FALL.tuck.y) * kA, lz = FALL.tuck.z * (1 - kA)
          if (kB > 0) {
            ly = -FALL.crouchY + (-FALL.crouchY * cp + FALL.crouchY) * kB
            lz = FALL.crouchY * sp * kB
          }
          lx = side * (FALL.tuck.x + (LEG.hipW - FALL.tuck.x) * kA)
          toWorld(this.yaw, this.pitch, this.roll, lx, ly, lz, this.tmp)
          f.x = this.x + this.tmp[0]!
          f.z = this.z + this.tmp[2]!
          f.yaw = this.yaw
          // Soles ride with the body while it rolls, then stay flat as it tips into the crouch.
          f.pitch = kB > 0 ? 0 : this.pitch
          f.roll = this.roll
          f.y = this.y + this.tmp[1]!
          y = Math.max(y, this.y + soleClear(f.pitch, f.roll) - f.y)
        }
        }
        if (this.t >= FALL.roll) {
          this.phase = 'rise'
          this.t = 0
          for (const f of this.feet) {
            f.y = 0
            f.pitch = 0
            f.roll = 0
          }
        }
        return false
      }
      case 'rise': {
        // SCRIPTED: push up from the crouch over the planted feet.
        const k = ease(this.t / FALL.rise)
        this.pitch = FALL.crouchPitch * (1 - k)
        this.roll = 0
        this.y = FALL.crouchY + (this.h0 - FALL.crouchY) * k
        if (this.t >= FALL.rise) {
          this.phase = 'done'
          return true
        }
        return false
      }
      default:
        return true
    }
  }

  /** Pelvis height the rigid rotation about the edge alone would give. */
  private rotatedY() {
    const [p, r] = angles(this.dir, this.phi)
    toWorld(0, p, r, this.ox, this.h0, this.oz, this.tmp)
    return this.tmp[1]!
  }

  /** Pose while toppling or lying: rigid rotation about the edge, lifted clear of the ground. */
  private pose() {
    const [p, r] = angles(this.dir, this.phi)
    this.pitch = p
    this.roll = r
    // Pelvis = pivot + R(phi) * offset, in the yaw frame, then into world.
    toWorld(this.yaw, p, r, this.ox, this.h0, this.oz, this.tmp)
    this.x = this.px + this.tmp[0]!
    this.z = this.pz + this.tmp[2]!
    this.y = Math.max(this.tmp[1]!, clearance(p, r, true))
    // Legs fold against the body over the first part of the fall.
    const w = ease(this.phi / 0.5)
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1
      toWorld(this.yaw, p, r, side * FALL.tuck.x, FALL.tuck.y, FALL.tuck.z, this.tmp)
      const f = this.feet[i]!, f0 = this.feet0[i]!
      f.x = f0.x + (this.x + this.tmp[0]! - f0.x) * w
      f.z = f0.z + (this.z + this.tmp[2]! - f0.z) * w
      f.yaw = this.yaw
      f.pitch = p * w
      f.roll = r * w
      f.y = Math.max(soleClear(f.pitch, f.roll), f0.y + (this.y + this.tmp[1]! - f0.y) * w)
    }
  }
}
