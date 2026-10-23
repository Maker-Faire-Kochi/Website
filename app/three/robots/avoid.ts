/**
 * Look-ahead avoidance for the hero's director: a velocity-obstacle style
 * check that runs BEFORE anything touches. Pure maths, no three.js, no
 * allocation (the director calls it for every moving robot every step).
 *
 * For each neighbour, take the velocity this robot WANTS (its steering
 * direction times its speed) relative to the neighbour's actual velocity,
 * and find the moment of closest approach within the horizon. If the two
 * would pass closer than their personal distance (footprints plus a margin),
 * the robot bends its heading away from where the neighbour will be -- more
 * the sooner and the deeper the intrusion -- and, if the neighbour is ahead,
 * slows down. Already inside personal distance (closest approach now), the
 * same rule pushes it straight away. That is what makes robots curve round
 * each other and queue politely, so contacts come from shoves, the egg
 * routines and the pointer crowding them, not from wandering.
 *
 * Agents are packed in a Float64Array, AGENT_STRIDE numbers each:
 * x, z, vx, vz, r (footprint radius).
 */

export const AGENT_STRIDE = 5

export const AVOID = {
  /** Look-ahead horizon, s. */
  horizon: 1.4,
  /** Heading bend per unit urgency. */
  gain: 2.4,
  /** Largest slow-down (fraction of speed) for a neighbour dead ahead at full urgency. */
  brake: 1,
  /** Urgency at which braking is full: 1 / brakeGain. */
  brakeGain: 2.5,
}

export interface Steer {
  /** Adjusted heading direction (unit). */
  x: number
  z: number
  /** Speed factor 0..1. */
  slow: number
}

/**
 * self: index into agents. (dirX, dirZ): wanted heading (unit); speed: wanted
 * speed. margin[j]: extra personal distance to agent j (m); `skip` is ignored
 * (the robot being trailed, say). `horizon` (s): look no further ahead than
 * this -- a robot a hand's breadth from where it is going must not brake for
 * someone standing beyond it. Writes into out.
 */
export function avoid(
  self: number, dirX: number, dirZ: number, speed: number,
  agents: Float64Array, count: number, margin: Float64Array, out: Steer, skip = -1, horizon: number = AVOID.horizon,
) {
  const o = self * AGENT_STRIDE
  const xi = agents[o]!, zi = agents[o + 1]!, ri = agents[o + 4]!
  const vdx = dirX * speed, vdz = dirZ * speed
  let sx = dirX, sz = dirZ, slow = 1
  const T = Math.max(0.05, Math.min(AVOID.horizon, horizon))
  // Two passes: first bend the heading away from everyone, then brake for
  // whoever the BENT heading still runs into. (Braking on the wanted heading
  // froze a robot for good when its way round a neighbour -- or round the
  // ball -- started inside that neighbour's personal space.)
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      const l = Math.hypot(sx, sz)
      if (l > 1e-9) {
        dirX = sx / l
        dirZ = sz / l
      }
    }
    for (let j = 0; j < count; j++) {
      if (j === self || j === skip) continue
      const q = j * AGENT_STRIDE
      const px = agents[q]! - xi, pz = agents[q + 1]! - zi
      const wx = vdx - agents[q + 2]!, wz = vdz - agents[q + 3]!
      const w2 = wx * wx + wz * wz
      let tc = w2 > 1e-10 ? (px * wx + pz * wz) / w2 : 0
      tc = tc < 0 ? 0 : tc > T ? T : tc
      const cx = px - wx * tc, cz = pz - wz * tc
      const dmin = Math.hypot(cx, cz)
      const R = ri + agents[q + 4]! + margin[j]!
      if (dmin >= R) continue
      const urgency = (1 - dmin / R) * (1 - 0.7 * tc / T)
      // Away from where the neighbour will be. Dead centre: pass it on the left.
      let ax, az
      if (dmin > 1e-6) {
        ax = -cx / dmin
        az = -cz / dmin
      }
      else {
        ax = dirZ
        az = -dirX
      }
      if (pass === 0) {
        sx += ax * urgency * AVOID.gain
        sz += az * urgency * AVOID.gain
        continue
      }
      const pd = Math.hypot(px, pz)
      const ahead = pd > 1e-6 ? (px * dirX + pz * dirZ) / pd : 1
      // Already inside personal space and still heading in: stop pressing in at once.
      if (pd < R && ahead > 0.2) slow = 0
      // Braking saturates early: well before the footprints meet, a robot heading at another has stopped.
      if (ahead > 0) slow = Math.min(slow, 1 - AVOID.brake * Math.min(1, AVOID.brakeGain * urgency) * ahead)
    }
  }
  const l = Math.hypot(sx, sz)
  if (l > 1e-9) {
    out.x = sx / l
    out.z = sz / l
  }
  else {
    out.x = dirX
    out.z = dirZ
  }
  out.slow = slow < 0 ? 0 : slow
  return out
}
