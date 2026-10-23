import { rng, type Rng } from '../../core/rng'

/**
 * Everything that changes on the electronics bench, stepped at the stage's
 * fixed DT: the board's power and activity LEDs, the four breadboard LEDs,
 * the push button's travel, the buzzer and the hobby servo. Pure (no three,
 * no audio), seeded, so the same seed and step count give the same bench.
 *
 * Idle: the board is powered, its activity LED flickers the way a real card
 * reader does (short irregular bursts with quiet gaps between), and now and
 * then a script runs one LED chase. Boot (tap the board): the power LED drops
 * out for a reset, the activity LED bursts while the OS loads, the LEDs chase,
 * the servo sweeps 0 -> 180 -> 90 and the buzzer chirps; from then on the
 * servo pans to follow the pointer. The boot sequence itself never draws on
 * the random stream, so it is identical for every seed.
 */

export const LED_COUNT = 4

export type Pattern = 'idle' | 'counter' | 'bounce'
export const PATTERNS: Pattern[] = ['idle', 'counter', 'bounce']

/**
 * Servo motion: acceleration-limited with a speed cap, the profile a real
 * servo's controller produces. Velocity changes by at most accel * dt per
 * step, so every start and stop is eased and there is never a velocity jump.
 * Degrees and seconds.
 */
export const SERVO = { min: 0, max: 180, rest: 90, vmax: 240, accel: 900, settle: 0.05, dwell: 0.18 }
export const SWEEP = [0, 180, 90]


/** Boot timeline, seconds from the tap. */
export const BOOT = {
  /** Power LED dark while the board resets. */
  reset: 0.45,
  /** The activity LED bursts from power-on to here while the OS loads. */
  actEnd: 2.4,
  /** LED chase: start, time per LED. */
  chase: 1.2,
  chaseStep: 0.08,
  /** Servo sweep starts here. */
  sweep: 2.0,
  /** Breath between the sweep settling and the chirp. */
  chirpDelay: 0.2,
}
export const BOOT_CHASE = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0]
export const IDLE_CHASE = [0, 1, 2, 3, 2, 1, 0]
export const IDLE_CHASE_STEP = 0.09
export const COUNTER_STEP = 0.3
export const BOUNCE = [0, 1, 2, 3, 2, 1]
export const BOUNCE_STEP = 0.1

/** Buzzer chirp: two short beeps [start, length], then a visual tail. */
export const BEEPS: [number, number][] = [[0, 0.07], [0.12, 0.07]]
export const CHIRP_LEN = 0.4

/** Button: press down, hold, release (seconds); the pattern changes on the press. */
export const PRESS = { down: 0.05, hold: 0.14, up: 0.24 }

/** Sound events raised since the renderer last read them. */
export const EV = { CHIME: 1, BEEP: 2, CLICK_DOWN: 4, CLICK_UP: 8 }

/** Snapshot layout: values the renderer interpolates between two steps. */
export const SNAP = { angle: 0, press: 1, chirp: 2, power: 3, act: 4, led: 5, size: 9 }

/** LED glow ramps: fast on, a short decay off (it reads as light, not a switch). */
const LEVEL_ON = 1 / 0.02
const LEVEL_OFF = 1 / 0.08

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Pan angle for a pointer at slot NDC x, with the servo drawn at NDC x
 * `servoX`: straight ahead (90) when level with the servo, swinging
 * piecewise-linearly to 180 at the slot's left edge and 0 at its right, so the
 * whole travel is reachable wherever the servo sits in the frame. Clamped:
 * the pointer may be anywhere on the page.
 */
export function trackAngle(x: number, servoX: number) {
  if (!Number.isFinite(x)) return SERVO.rest
  const s = Number.isFinite(servoX) ? clamp(servoX, -0.9, 0.9) : 0
  const a = x < s
    ? SERVO.rest + (SERVO.max - SERVO.rest) * (s - x) / (s + 1)
    : SERVO.rest - (SERVO.rest - SERVO.min) * (x - s) / (1 - s)
  return clamp(a, SERVO.min, SERVO.max)
}

/** Deterministic burst for the boot's activity LED: a hash of the time slot, not the PRNG. */
function bootActivity(t: number) {
  const slot = Math.floor(t / 0.035)
  let h = Math.imul(slot ^ 0x9E3779B9, 0x85EBCA6B)
  h ^= h >>> 13
  h = Math.imul(h, 0xC2B2AE35)
  h ^= h >>> 16
  return ((h >>> 0) / 4294967296) > 0.35
}

/** Button travel 0..1 at time t since the press (smoothstep in, hold, smoothstep out). */
export function pressDepth(t: number) {
  const s = (x: number) => x * x * (3 - 2 * x)
  if (t < 0) return 0
  if (t < PRESS.down) return s(t / PRESS.down)
  if (t < PRESS.hold) return 1
  if (t < PRESS.up) return 1 - s((t - PRESS.hold) / (PRESS.up - PRESS.hold))
  return 0
}

export class ElectronicsSim {
  t = 0
  /** Servo angle (deg), angular velocity (deg/s) and the angle it is driving to. */
  angle = SERVO.rest
  vel = 0
  target = SERVO.rest
  /** Pan target from the pointer, or null. Only used once booted. */
  track: number | null = null
  private waypoints: number[] = []
  private dwell = 0

  /** Time into the boot sequence, or -1 when not booting. */
  bootT = -1
  booted = false
  private sweepStarted = false
  private sweepDoneT = -1

  patternIndex = 0
  private patternT = 0

  /** Time since the last button press, or -1. */
  pressT = -1
  /** Time into the buzzer chirp, or -1. */
  chirpT = -1
  buzzer = false

  power = true
  act = false
  readonly leds: boolean[] = [false, false, false, false]
  /** Visual levels 0..1: power, activity, LED 0..3. */
  readonly level = new Float64Array(2 + LED_COUNT)
  /** EV bits raised since the renderer last cleared them. */
  events = 0

  private readonly r: Rng
  private actPhase: 'gap' | 'on' | 'off' = 'gap'
  private actTimer: number
  private blinks = 0
  private chaseWait: number
  private chaseT = -1

  constructor(seed = 1) {
    this.r = rng(seed)
    this.actTimer = this.r.range(0.2, 0.8)
    this.chaseWait = this.r.range(3, 5)
    this.level[0] = 1
  }

  get pattern(): Pattern {
    return PATTERNS[this.patternIndex]!
  }

  get booting() {
    return this.bootT >= 0
  }

  get sweeping() {
    return this.waypoints.length > 0
  }

  // ── Inputs ────────────────────────────────────────────────────────────

  /** Tap the board / 'boot'. A boot already running is not restarted. */
  boot(): 'started' | 'busy' {
    if (this.booting) return 'busy'
    this.bootT = 0
    this.booted = false
    this.sweepStarted = false
    this.sweepDoneT = -1
    this.waypoints.length = 0
    this.dwell = 0
    this.chaseT = -1
    return 'started'
  }

  /** Tap the button / 'button': press travel, a click, and the next LED pattern. */
  press(): Pattern {
    this.pressT = 0
    this.patternIndex = (this.patternIndex + 1) % PATTERNS.length
    this.patternT = 0
    this.chaseT = -1
    this.events |= EV.CLICK_DOWN
    return this.pattern
  }

  /** Tap the servo / 'servo': sweep 0 -> 180 -> 90. Not while booting (the boot sweeps it). */
  sweep(): 'started' | 'busy' {
    if (this.booting) return 'busy'
    this.waypoints.length = 0
    this.waypoints.push(...SWEEP)
    this.dwell = 0
    return 'started'
  }

  /** Tap the buzzer / 'chirp'. */
  chirp(): boolean {
    if (this.chirpT >= 0) return false
    this.chirpT = 0
    return true
  }

  /** Pan target from the pointer (deg), or null to hold where it is. */
  setTrack(deg: number | null) {
    this.track = deg === null || !Number.isFinite(deg) ? null : clamp(deg, SERVO.min, SERVO.max)
  }

  /**
   * One LED chase now ('chase', and the breadboard shot's arrival). It draws
   * over whatever pattern is showing and never touches the random stream, so
   * the idle flicker and chases stay exactly as they were.
   */
  chase(): 'started' | 'busy' {
    if (this.booting || this.manualChaseT >= 0) return 'busy'
    this.manualChaseT = 0
    return 'started'
  }

  private manualChaseT = -1

  get chasing() {
    return this.manualChaseT >= 0
  }

  /** Pause: drop pointer targets and anything queued (a pending sweep). */
  clearInputs() {
    this.track = null
    if (!this.booting) this.waypoints.length = 0
    this.target = this.angle
  }

  // ── Step ──────────────────────────────────────────────────────────────

  step(dt: number) {
    this.t += dt
    this.patternT += dt
    this.stepActivity(dt)

    if (this.booting) this.stepBoot(dt)
    else this.stepPattern(dt)
    this.stepManualChase(dt)

    this.stepServo(dt)
    this.stepButton(dt)
    this.stepChirp(dt)

    if (this.booting && this.sweepStarted && !this.sweeping && this.vel === 0) {
      if (this.sweepDoneT < 0) this.sweepDoneT = 0
      else this.sweepDoneT += dt
      if (this.sweepDoneT >= BOOT.chirpDelay && this.chirpT < 0 && !this.chirpedInBoot) {
        this.chirp()
        this.chirpedInBoot = true
      }
      if (this.chirpedInBoot && this.chirpT < 0) {
        this.bootT = -1
        this.booted = true
        this.chirpedInBoot = false
        this.target = this.angle
      }
    }

    const tgt = [this.power, this.act, ...this.leds]
    for (let i = 0; i < tgt.length; i++) {
      const l = this.level[i]!
      this.level[i] = tgt[i] ? Math.min(1, l + LEVEL_ON * dt) : Math.max(0, l - LEVEL_OFF * dt)
    }
  }

  private chirpedInBoot = false

  /** Card-reader flicker: irregular bursts of 1-6 blinks, quiet gaps between. Always ticks the PRNG. */
  private stepActivity(dt: number) {
    this.actTimer -= dt
    if (this.actTimer <= 0) {
      if (this.actPhase === 'gap') {
        this.blinks = 1 + Math.floor(this.r.next() * 6)
        this.actPhase = 'on'
        this.actTimer = this.r.range(0.025, 0.09)
      }
      else if (this.actPhase === 'on') {
        this.blinks--
        this.actPhase = this.blinks > 0 ? 'off' : 'gap'
        this.actTimer = this.blinks > 0 ? this.r.range(0.03, 0.07) : 0.3 + -Math.log(1 - this.r.next()) * 1.1
      }
      else {
        this.actPhase = 'on'
        this.actTimer = this.r.range(0.025, 0.09)
      }
    }
    this.act = this.power && this.actPhase === 'on'
  }

  private stepBoot(dt: number) {
    const before = this.bootT
    this.bootT += dt
    const t = this.bootT
    this.power = t >= BOOT.reset
    if (before < BOOT.reset && t >= BOOT.reset) this.events |= EV.CHIME
    if (t < BOOT.reset) this.act = false
    else if (t < BOOT.actEnd) this.act = bootActivity(t - BOOT.reset)

    const k = Math.floor((t - BOOT.chase) / BOOT.chaseStep)
    const lit = t >= BOOT.chase && k < BOOT_CHASE.length ? BOOT_CHASE[k]! : -1
    for (let i = 0; i < LED_COUNT; i++) this.leds[i] = i === lit

    if (!this.sweepStarted && t >= BOOT.sweep) {
      this.sweepStarted = true
      this.waypoints.length = 0
      this.waypoints.push(...SWEEP)
      this.dwell = 0
    }
  }

  private stepPattern(dt: number) {
    this.power = true
    const p = this.pattern
    if (p === 'counter') {
      const v = Math.floor(this.patternT / COUNTER_STEP) % 16
      for (let i = 0; i < LED_COUNT; i++) this.leds[i] = ((v >> (LED_COUNT - 1 - i)) & 1) === 1
      return
    }
    if (p === 'bounce') {
      const lit = BOUNCE[Math.floor(this.patternT / BOUNCE_STEP) % BOUNCE.length]!
      for (let i = 0; i < LED_COUNT; i++) this.leds[i] = i === lit
      return
    }
    // Idle: dark, with an occasional chase.
    if (this.chaseT < 0) {
      this.chaseWait -= dt
      if (this.chaseWait <= 0) {
        this.chaseT = 0
        this.chaseWait = this.r.range(6, 11)
      }
    }
    let lit = -1
    if (this.chaseT >= 0) {
      const k = Math.floor(this.chaseT / IDLE_CHASE_STEP)
      if (k < IDLE_CHASE.length) lit = IDLE_CHASE[k]!
      else this.chaseT = -1
      if (this.chaseT >= 0) this.chaseT += dt
    }
    for (let i = 0; i < LED_COUNT; i++) this.leds[i] = i === lit
  }

  private stepManualChase(dt: number) {
    if (this.manualChaseT < 0) return
    if (this.booting) {
      this.manualChaseT = -1
      return
    }
    const k = Math.floor(this.manualChaseT / IDLE_CHASE_STEP)
    if (k >= BOOT_CHASE.length) {
      this.manualChaseT = -1
      return
    }
    const lit = BOOT_CHASE[k]!
    for (let i = 0; i < LED_COUNT; i++) this.leds[i] = i === lit
    this.manualChaseT += dt
  }

  private stepServo(dt: number) {
    if (this.waypoints.length) {
      this.target = this.waypoints[0]!
    }
    else if (this.booted && !this.booting && this.track !== null) {
      this.target = this.track
    }

    const A = SERVO.accel
    const v0 = this.vel
    const e = this.target - this.angle
    // Fastest speed from which the servo can still stop at the target.
    const vd = Math.sign(e) * Math.min(SERVO.vmax, Math.sqrt(2 * A * Math.abs(e)))
    this.vel += clamp(vd - this.vel, -A * dt, A * dt)
    this.angle += this.vel * dt
    // Settle onto the target only when stopping from the speed it entered
    // this step with is itself within one step's braking: no velocity jump.
    if (Math.abs(this.target - this.angle) < SERVO.settle && Math.abs(v0) <= A * dt) {
      this.angle = this.target
      this.vel = 0
    }
    // The last step of an approach can overrun the end stop by a hair; the
    // position is held in range and the velocity is left to brake normally.
    this.angle = clamp(this.angle, SERVO.min, SERVO.max)

    if (this.waypoints.length && this.angle === this.target && this.vel === 0) {
      this.dwell += dt
      if (this.dwell >= SERVO.dwell) {
        this.waypoints.shift()
        this.dwell = 0
      }
    }
  }

  private stepButton(dt: number) {
    if (this.pressT < 0) return
    const before = this.pressT
    this.pressT += dt
    if (before < PRESS.hold && this.pressT >= PRESS.hold) this.events |= EV.CLICK_UP
    if (this.pressT >= PRESS.up) this.pressT = -1
  }

  private stepChirp(dt: number) {
    if (this.chirpT < 0) {
      this.buzzer = false
      return
    }
    const before = this.chirpT
    this.chirpT += dt
    const t = this.chirpT
    this.buzzer = false
    for (const [s, len] of BEEPS) {
      if ((before === 0 ? before <= s : before < s) && t >= s) this.events |= EV.BEEP
      if (t >= s && t < s + len) this.buzzer = true
    }
    if (t >= CHIRP_LEN) {
      this.chirpT = -1
      this.buzzer = false
    }
  }

  /** Visual chirp level: 1 while a beep sounds, fading through the tail. */
  chirpLevel() {
    if (this.chirpT < 0) return 0
    if (this.buzzer) return 1
    const last = BEEPS[BEEPS.length - 1]!
    const end = last[0] + last[1]
    if (this.chirpT < end) return 0.6
    return Math.max(0, 1 - (this.chirpT - end) / (CHIRP_LEN - end))
  }

  snapshot(out: Float64Array) {
    out[SNAP.angle] = this.angle
    out[SNAP.press] = pressDepth(this.pressT)
    out[SNAP.chirp] = this.chirpLevel()
    out[SNAP.power] = this.level[0]!
    out[SNAP.act] = this.level[1]!
    for (let i = 0; i < LED_COUNT; i++) out[SNAP.led + i] = this.level[2 + i]!
    return out
  }

  /** Read and clear the sound events. */
  takeEvents() {
    const e = this.events
    this.events = 0
    return e
  }
}
