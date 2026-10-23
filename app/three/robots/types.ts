import type * as THREE from 'three'
import type { MatKey } from '../core/kit'
import type { Body, Collider, ContactOther, Normal } from './contact'

/**
 * The contract between a robot and whoever directs it (the hero's behaviour
 * layer, or a robot's own lab scene). A director only ever issues BOUNDED
 * commands; the robot's own controller or gait decides how its body gets
 * there. A director never writes a robot's position.
 *
 * Ground is the XZ plane at y = 0, +Y up, metres. Heading 0 faces +Z;
 * positive heading turns toward +X (rotation.y = heading).
 */
export interface RobotCommand {
  /** Desired forward speed, m/s. Robots clamp to their own maxSpeed (negative = reverse/back off). */
  speed: number
  /** Desired yaw rate, rad/s. Robots clamp to their own limit. */
  yawRate: number
  /**
   * Desired sideways speed, m/s, + = toward the robot's left (+X at heading
   * 0). Only a walker can do this (a duck side-steps); wheels cannot roll
   * sideways, so the balancer ignores it.
   */
  strafe?: number
  /**
   * Permission to go flat out (the 'crash' routine): the robot may use its
   * sprint speed instead of its everyday maxSpeed. Still bounded by its own
   * motors and controller.
   */
  boost?: boolean
}

export interface Robot extends Body {
  readonly kind: 'duck' | 'balancer' | 'dog' | 'makey'
  /** Add this to the scene. The robot owns its transform. */
  readonly root: THREE.Object3D
  /** Footprint radius on the ground, for separation and shy distances. */
  readonly radius: number
  readonly maxSpeed: number
  /** Current ground position (y = 0) and heading after the last step. Read-only for directors. */
  readonly position: THREE.Vector3
  readonly heading: number
  /** True while the robot is doing something it cannot be steered out of (hop, fall, righting). */
  readonly busy: boolean
  /** True from the moment it starts to topple until it has finished getting up again. */
  readonly fallen: boolean
  /** kg. Overlaps and impacts are split by it. */
  readonly mass: number
  /** Ground contact circles, refreshed after every step and every collide(). */
  readonly colliders: readonly Collider[]

  /** Teleport, for initial placement only. */
  placeAt(x: number, z: number, heading: number): void
  /** One fixed step of dt seconds (DT from core/clock). */
  step(dt: number, cmd: RobotCommand): void
  /** Interpolate visuals between the last two steps. */
  frame(alpha: number): void
  /** World point the head should track, or null for the robot's own idle glances. */
  lookAt(target: THREE.Vector3 | null): void
  /** A wave (Makey: +1 left arm, -1 right, 0 both); robots without arms leave it out. */
  wave?(side: number): void
  /**
   * Tap/keyboard reaction. 'tap': duck hops, balancer leans back from a nudge,
   * rover pans its camera and toots. 'shove': a hard push (balancer falls,
   * duck staggers). 'tumble': knocked right over -- every robot falls and
   * then rights itself by its own (scripted, labelled) recovery.
   */
  react(kind: 'tap' | 'shove' | 'tumble'): void
  /**
   * Mouse grab. `at` = the world point on the body where it was picked (see
   * hit); from then on a spring-damper pulls that point toward the dragTo()
   * target, applied as a FORCE through the robot's own physics (it tilts,
   * resists, topples if dragged too hard; released, it carries on with its
   * own velocity). null releases. Grab spring: GRAB in robots/grab.ts.
   */
  grab(at: THREE.Vector3 | null): void
  /** While grabbed: where the pointer wants the grab point (world). */
  dragTo(target: THREE.Vector3): void
  /** Cyan selection marker on/off. */
  setSelected(on: boolean): void
  /** Entering pause drops queued reactions; leaving it resumes from the current pose. */
  setPaused(paused: boolean): void
  /**
   * Contact response (see robots/contact.ts): move `depth` along `normal`
   * through the robot's own state, and take `relSpeed` (> 0) as an impact.
   * The balancer pushes its planar state and kicks its pendulum; the duck
   * shifts its pelvis and staggers. Never a teleport of the visuals.
   */
  collide(normal: Normal, depth: number, relSpeed: number, other: ContactOther, part: number): void
  /**
   * Asleep: settle, head droops, slow breathing. Waking (false) is a startle.
   * Easter egg only; the director clears it.
   */
  setSleep(on: boolean): void
  /**
   * Recolour the head's accent (null = its own). Easter egg only ('party'):
   * the one sanctioned break of colour-with-purpose. Swaps a shared material,
   * so it costs no draw calls.
   */
  setAccent(key: MatKey | null): void
  /** World position of the head as last drawn by frame() (for leader lines). Writes into `out`. */
  headPoint(out: THREE.Vector3): THREE.Vector3
  /** Pointer pick against the robot's body; on a hit, writes the world hit point into `out` if given. */
  hit(ray: THREE.Raycaster, out?: THREE.Vector3): boolean
  dispose(): void
}

export interface RobotOptions {
  /** The one accent this robot's head shell carries. */
  accent: 'red' | 'cyan' | 'accent' | 'dark'
  seed: number
  /** Deterministic still pose: no noise, no idle motion. */
  posterMode?: boolean
}
