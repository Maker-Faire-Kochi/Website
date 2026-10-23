import type { Body, Collider, ContactOther, Normal } from '../contact'

/**
 * The things the robots play with on the mat: a ball and a few light
 * blocks. Planar rigid bodies, simulated -- they go through the SAME contact
 * solver as the robots (robots/contact.ts implements Body for them too), so
 * a robot that walks or rolls into one pushes it, a kick is a real impulse,
 * and they bounce off the mat's rails.
 *
 * Pure TypeScript, no three.js, no allocation per step.
 *
 * BALL: a light plastic ball rolling without slipping. Rolling resistance
 * (a constant deceleration c_rr * g) plus a little viscous loss, so a kick
 * rolls a metre or so and stops; its spin follows its rolling (angle = s / r
 * about the axis perpendicular to its motion), carried as a quaternion so the
 * seam shows it turning. Contacts bounce it with restitution; the robots are
 * twenty times heavier, so it gives way almost entirely.
 *
 * BLOCK: a small wooden block sliding on the plywood: Coulomb friction stops
 * it within a few centimetres; an off-centre hit turns it (impulse x lever
 * arm / moment of inertia) and friction stops that too. Its footprint is a
 * square drawn as five circles (centre + corners).
 */

export const BALL = {
  r: 0.032,
  mass: 0.06,
  /** Rolling resistance (m/s^2) and viscous loss (1/s). */
  rolling: 0.22,
  drag: 0.12,
  /** Restitution against the rails and blocks; against robots. */
  eWall: 0.62,
  eRobot: 0.4,
  /** Below this speed it is at rest. */
  rest: 0.004,
  /** Popped up off the floor: gravity, and the bounce it lands with (below `settle` m/s it stays down). */
  g: 9.81,
  eFloor: 0.45,
  settle: 0.15,
}

export const BLOCK = {
  half: 0.034,
  h: 0.05,
  mass: 0.12,
  /** Sliding friction coefficient on plywood. */
  mu: 0.35,
  restitution: 0.25,
  g: 9.81,
}

/** q = q * rotation(axis, angle), axis unit. q = [x, y, z, w]. */
function rotate(q: number[], ax: number, ay: number, az: number, angle: number) {
  const h = angle / 2
  const s = Math.sin(h)
  const bx = ax * s, by = ay * s, bz = az * s, bw = Math.cos(h)
  // Pre-multiply: the ball turns about a WORLD axis.
  const x = bw * q[0]! + bx * q[3]! + by * q[2]! - bz * q[1]!
  const y = bw * q[1]! - bx * q[2]! + by * q[3]! + bz * q[0]!
  const z = bw * q[2]! + bx * q[1]! - by * q[0]! + bz * q[3]!
  const w = bw * q[3]! - bx * q[0]! - by * q[1]! - bz * q[2]!
  const l = Math.hypot(x, y, z, w)
  q[0] = x / l
  q[1] = y / l
  q[2] = z / l
  q[3] = w / l
}

export class Ball implements Body {
  readonly mass = BALL.mass
  x = 0
  z = 0
  vx = 0
  vz = 0
  /**
   * Height of its underside above the floor, m, and its vertical speed. 0 on
   * the floor; a ball squeezed where it cannot fit pops up over what holds
   * it (pop) and drops back. Its contact band rides with it.
   */
  y = 0
  vy = 0
  /** Orientation (quaternion x, y, z, w). */
  readonly q = [0, 0, 0, 1]
  readonly colliders: Collider[] = [{ x: 0, z: 0, r: BALL.r, vx: 0, vz: 0, fixed: false, y0: 0, y1: 2 * BALL.r }]
  /** Strongest impact this step (m/s) and whether it hit a robot -- for the sound. */
  impact = 0
  /**
   * Boards it cannot be pushed through (the hero's pitch; null: none). A push
   * into them stops at them and marks it `blocked` for this solve, so the
   * solver gives the whole correction to whoever pushes (contact.ts).
   */
  box: { x0: number, x1: number, z0: number, z1: number } | null = null
  blocked = false

  place(x: number, z: number) {
    this.x = x
    this.z = z
    this.vx = this.vz = 0
    this.y = this.vy = 0
    this.sync()
  }

  /** No room on the floor: up onto `top` (an underside height, m), from where it falls back. */
  pop(top: number) {
    if (top <= this.y) return
    this.y = top
    this.vy = Math.max(this.vy, 0)
    this.sync()
  }

  /** A kick: a velocity change toward (dx, dz) (any length). */
  kick(dx: number, dz: number, speed: number) {
    const l = Math.hypot(dx, dz) || 1
    this.vx += dx / l * speed
    this.vz += dz / l * speed
    this.sync()
  }

  /**
   * A kick at the moment of foot contact: the ball leaves along (dx, dz) at
   * `speed`. The robots' feet and wheels are not modelled as strikers, so the
   * solver's push alone would send it along the contact normal at walking
   * pace; the director supplies the strike, aimed, when a kicker touches it.
   */
  strike(dx: number, dz: number, speed: number) {
    const l = Math.hypot(dx, dz) || 1
    this.vx = dx / l * speed
    this.vz = dz / l * speed
    this.sync()
  }

  /**
   * Boards round the pitch: keep the ball inside the box, bouncing off its
   * sides with the rails' restitution. Returns the impact speed (0 if none).
   */
  confine(x0: number, x1: number, z0: number, z1: number) {
    let hit = 0
    const r = BALL.r
    if (this.x < x0 + r) {
      this.x = x0 + r
      if (this.vx < 0) {
        hit = Math.max(hit, -this.vx)
        this.vx = -this.vx * BALL.eWall
      }
    }
    else if (this.x > x1 - r) {
      this.x = x1 - r
      if (this.vx > 0) {
        hit = Math.max(hit, this.vx)
        this.vx = -this.vx * BALL.eWall
      }
    }
    if (this.z < z0 + r) {
      this.z = z0 + r
      if (this.vz < 0) {
        hit = Math.max(hit, -this.vz)
        this.vz = -this.vz * BALL.eWall
      }
    }
    else if (this.z > z1 - r) {
      this.z = z1 - r
      if (this.vz > 0) {
        hit = Math.max(hit, this.vz)
        this.vz = -this.vz * BALL.eWall
      }
    }
    this.sync()
    return hit
  }

  get speed() {
    return Math.hypot(this.vx, this.vz)
  }

  step(dt: number) {
    this.impact = 0
    this.blocked = false
    if (this.y > 0 || this.vy !== 0) {
      this.vy -= BALL.g * dt
      this.y += this.vy * dt
      if (this.y <= 0) {
        this.y = 0
        this.vy = -this.vy * BALL.eFloor
        if (this.vy < BALL.settle) this.vy = 0
      }
    }
    const v = Math.hypot(this.vx, this.vz)
    if (v < BALL.rest) {
      this.vx = this.vz = 0
      this.sync()
      return
    }
    // Rolling without slip: the ball turns about the horizontal axis across its motion.
    const dist = v * dt
    rotate(this.q, this.vz / v, 0, -this.vx / v, dist / BALL.r)
    this.x += this.vx * dt
    this.z += this.vz * dt
    const k = Math.max(0, v * (1 - BALL.drag * dt) - BALL.rolling * dt) / v
    this.vx *= k
    this.vz *= k
    this.sync()
  }

  collide(n: Normal, depth: number, relSpeed: number, other: ContactOther) {
    if (depth > 0) {
      this.x += n.x * depth
      this.z += n.z * depth
      const b = this.box
      if (b) {
        const x = Math.min(Math.max(this.x, b.x0 + BALL.r), b.x1 - BALL.r), z = Math.min(Math.max(this.z, b.z0 + BALL.r), b.z1 - BALL.r)
        if (x !== this.x || z !== this.z) this.blocked = true
        this.x = x
        this.z = z
      }
    }
    if (relSpeed > 0) {
      const e = other === 'robot' ? BALL.eRobot : BALL.eWall
      this.vx += n.x * (1 + e) * relSpeed
      this.vz += n.z * (1 + e) * relSpeed
      this.impact = Math.max(this.impact, relSpeed)
    }
    this.sync()
  }

  /** Kinetic energy (translation + rolling), J. */
  get energy() {
    const v2 = this.vx * this.vx + this.vz * this.vz
    // A thin-shelled ball: I = 2/3 m r^2, rolling adds 1/3 of the translational energy.
    return 0.5 * this.mass * v2 * (1 + 2 / 3)
  }

  private sync() {
    const c = this.colliders[0]!
    c.x = this.x
    c.z = this.z
    c.vx = this.vx
    c.vz = this.vz
    c.y0 = this.y
    c.y1 = this.y + 2 * BALL.r
  }
}

/** Corner circles sit this far out along each diagonal axis; the centre circle fills the edges. */
const CORNER = BLOCK.half * 0.56
const CORNER_R = BLOCK.half * 0.47
const CENTRE_R = BLOCK.half * 0.98

export class Block implements Body {
  readonly mass = BLOCK.mass
  /** Moment of inertia about the vertical axis (a square of side 2 half). */
  private readonly I = BLOCK.mass * (2 * (2 * BLOCK.half) ** 2) / 12
  x = 0
  z = 0
  yaw = 0
  vx = 0
  vz = 0
  w = 0
  readonly colliders: Collider[] = [0, 1, 2, 3, 4].map(k => ({
    x: 0, z: 0, r: k === 0 ? CENTRE_R : CORNER_R, vx: 0, vz: 0, fixed: false, y0: 0, y1: BLOCK.h,
  }))
  impact = 0
  /** Sliding this step (for the scrape voice). */
  get sliding() {
    return Math.hypot(this.vx, this.vz)
  }

  place(x: number, z: number, yaw: number) {
    this.x = x
    this.z = z
    this.yaw = yaw
    this.vx = this.vz = this.w = 0
    this.sync()
  }

  push(dx: number, dz: number, speed: number) {
    const l = Math.hypot(dx, dz) || 1
    this.vx += dx / l * speed
    this.vz += dz / l * speed
    this.sync()
  }

  step(dt: number) {
    this.impact = 0
    this.x += this.vx * dt
    this.z += this.vz * dt
    this.yaw += this.w * dt
    // Coulomb friction on the plywood: a constant deceleration until it stops, sliding and turning.
    const decel = BLOCK.mu * BLOCK.g * dt
    const v = Math.hypot(this.vx, this.vz)
    if (v > 0) {
      const k = Math.max(0, v - decel) / v
      this.vx *= k
      this.vz *= k
    }
    const wd = decel / (BLOCK.half * 0.6)
    this.w = Math.abs(this.w) <= wd ? 0 : this.w - Math.sign(this.w) * wd
    this.sync()
  }

  collide(n: Normal, depth: number, relSpeed: number, _other: ContactOther, part: number) {
    if (depth > 0) {
      this.x += n.x * depth
      this.z += n.z * depth
    }
    if (relSpeed > 0) {
      const dv = (1 + BLOCK.restitution) * relSpeed
      this.vx += n.x * dv
      this.vz += n.z * dv
      // The same impulse about the centre turns it: tau = r x J (vertical component).
      const c = this.colliders[part]!
      const rx = c.x - this.x, rz = c.z - this.z
      this.w += (rz * n.x - rx * n.z) * this.mass * dv / this.I * 0.5
      this.impact = Math.max(this.impact, relSpeed)
    }
    this.sync()
  }

  get energy() {
    return 0.5 * this.mass * (this.vx * this.vx + this.vz * this.vz) + 0.5 * this.I * this.w * this.w
  }

  private sync() {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw)
    for (let k = 0; k < 5; k++) {
      const col = this.colliders[k]!
      const lx = k === 0 ? 0 : (k === 1 || k === 4 ? 1 : -1) * CORNER
      const lz = k === 0 ? 0 : (k <= 2 ? 1 : -1) * CORNER
      const ox = lx * c + lz * s
      const oz = -lx * s + lz * c
      col.x = this.x + ox
      col.z = this.z + oz
      // Point velocity: v + w x r (about +Y): (w * rz, -w * rx).
      col.vx = this.vx + this.w * oz
      col.vz = this.vz - this.w * ox
    }
  }
}
