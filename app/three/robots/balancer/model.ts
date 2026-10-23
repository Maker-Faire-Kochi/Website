import * as THREE from 'three'
import { Assembly, beamGeometry, blockGeometry, contactShadow, discGeometry, extrude, pinGeometry, type MatKey, type Materials } from '../../core/kit'
import { GEO, legAngles } from './geometry'

/**
 * The wheel-legged balancer (Ascento-style), built from the beam kit.
 * Dimensions are shared with the simulation through geometry.ts.
 *
 * Body frame: origin on the wheel axle, +Y up the legs, +Z forward along the
 * heading, +X to the robot's left. The body group pitches about the axle;
 * inside it each leg is a SHIN (slotted dark link, from the wheel hub up to
 * the knee, with the knee servo and its red horn) and a THIGH (light link
 * from the knee up to the hip, red horn on the hip motor) -- knees pointing
 * back. setLegs() places both links for the commanded leg length with the
 * planar IK in geometry.ts and raises the pod to the hips. The pod is a
 * chamfered box of light side plates over a dark battery and the two hip
 * motors; a small pan-tilt sensor head stands on it and carries the accent.
 * The wheels are large and spoked: red tyre (drive), light rim, hub and fine
 * spokes.
 *
 * Draw calls (each rigid part = one per material + hairlines): pod 3, head
 * yaw 1, head pitch 3, shins 2 x 2, thighs 2 x 2, wheels 2 x 3, shadow 1,
 * LED 1 (blinks; hidden most of the time), selection ring 1 (only when
 * selected) -> 23 max.
 */

export interface BalancerModel {
  root: THREE.Group
  /** Axle centre: carries the wheels and the body. y = wheel radius (raised in the air). */
  axle: THREE.Group
  /** Pitches about the axle (rotation.x = th): legs, pod, head. */
  body: THREE.Group
  wheelL: THREE.Group
  wheelR: THREE.Group
  /** Pose both legs for these leg lengths (axle to hip axis) and raise the pod to the hips. */
  setLegs(lenL: number, lenR: number): void
  pod: THREE.Group
  headYaw: THREE.Group
  headPitch: THREE.Group
  shadow: THREE.Mesh
  ring: THREE.Mesh
  led: THREE.Mesh
  /** Meshes used for picking (faces only). */
  pick: THREE.Mesh[]
  dispose(): void
}

/** A kit beam (built along +X) stood up along +Y with its face toward X. */
const UPRIGHT_SIDE: [number, number, number] = [0, Math.PI / 2, Math.PI / 2]
const ALONG_X_PIN: [number, number, number] = [0, Math.PI / 2, 0]
const FACE_X: [number, number, number] = [0, Math.PI / 2, 0]

export function buildBalancerModel(mats: Materials, accent: MatKey): BalancerModel {
  const geos: THREE.BufferGeometry[] = []
  const own = <G extends THREE.BufferGeometry>(g: G) => {
    geos.push(g)
    return g
  }

  // ── Pod: chamfered side plates (a straight-edged octagon in Y-Z), panels, battery, hip motors ──
  const h0 = GEO.podBottom, h1 = GEO.podTop, z0 = GEO.podBack, z1 = GEO.podFront, ch = 0.016
  const side = new THREE.Shape()
  side.moveTo(z0 + ch, h0)
  side.lineTo(z1 - ch, h0)
  side.lineTo(z1, h0 + ch)
  side.lineTo(z1, h1 - ch)
  side.lineTo(z1 - ch, h1)
  side.lineTo(z0 + ch, h1)
  side.lineTo(z0, h1 - ch)
  side.lineTo(z0, h0 + ch)
  side.closePath()
  for (const [y, z] of [[h0 + 0.012, 0], [h1 - 0.012, 0], [0, z1 - 0.012], [0, z0 + 0.012]] as const) {
    const hole = new THREE.Path()
    hole.absarc(z, y, 0.0028, 0, Math.PI * 2, true)
    side.holes.push(hole)
  }
  // Shape X -> body Z (forward), shape Y -> body Y; extruded across X.
  const sidePlate = own(extrude(side, 0.005, 6))
  sidePlate.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)))
  const innerW = 2 * GEO.podHalfW - 0.01
  const topPanel = own(blockGeometry(innerW, 0.004, z1 - z0 - 2 * ch))
  const frontPanel = own(blockGeometry(innerW, h1 - h0 - 2 * ch, 0.004))
  const chamfer = own(blockGeometry(innerW, 0.004, ch * Math.SQRT2))
  const battery = own(blockGeometry(0.07, 0.03, 0.05))
  const hipMotor = own(pinGeometry(0.014, 0.024))
  const board = own(blockGeometry(0.05, 0.034, 0.002))
  const chip = own(blockGeometry(0.01, 0.01, 0.002))
  const cable = own(blockGeometry(0.003, 0.003, 0.05))
  const spacer = own(pinGeometry(0.0028, innerW + 0.012))
  const podAsm = new Assembly()
  for (const sx of [-1, 1]) {
    podAsm.add(sidePlate, 'light', { pos: [sx * (GEO.podHalfW - 0.0025), 0, 0] })
    podAsm.add(hipMotor, 'dark', { pos: [sx * (GEO.legX + 0.014), 0, 0], rot: ALONG_X_PIN, edges: false })
    // A cable run from each hip motor up into the pod.
    podAsm.add(cable, 'dark', { pos: [sx * (GEO.legX - 0.004), 0.016, -0.012], rot: [0.9, 0, 0], edges: false })
  }
  podAsm
    .add(topPanel, 'light', { pos: [0, h1 - 0.002, (z0 + z1) / 2] })
    .add(frontPanel, 'light', { pos: [0, (h0 + h1) / 2, z1 - 0.002] })
    .add(frontPanel, 'light', { pos: [0, (h0 + h1) / 2, z0 + 0.002] })
    .add(chamfer, 'light', { pos: [0, h1 - ch / 2, z1 - ch / 2], rot: [Math.PI / 4, 0, 0] })
    .add(chamfer, 'light', { pos: [0, h1 - ch / 2, z0 + ch / 2], rot: [-Math.PI / 4, 0, 0] })
    .add(chamfer, 'light', { pos: [0, h0 + ch / 2, z1 - ch / 2], rot: [-Math.PI / 4, 0, 0] })
    .add(chamfer, 'light', { pos: [0, h0 + ch / 2, z0 + ch / 2], rot: [Math.PI / 4, 0, 0] })
    .add(spacer, 'light', { pos: [0, h0 + 0.012, 0], rot: ALONG_X_PIN })
    .add(battery, 'dark', { pos: [0, 0.006, -0.004], edges: false })
    // The controller board on the front panel, with its IMU and driver chips.
    .add(board, 'dark', { pos: [0, (h0 + h1) / 2 + 0.004, z1 + 0.0012], edges: false })
    .add(chip, 'light', { pos: [-0.012, (h0 + h1) / 2 + 0.01, z1 + 0.0025] })
    .add(chip, 'light', { pos: [0.012, (h0 + h1) / 2 + 0.01, z1 + 0.0025] })
  const podMesh = podAsm.build(mats, 'balancer-pod')

  // Status LED on the front panel, beside the board (blinked by the wrapper).
  const led = new THREE.Mesh(own(blockGeometry(0.006, 0.006, 0.003)), mats.face.red)
  led.position.set(0.02, (h0 + h1) / 2 - 0.009, z1 + 0.0025)
  led.name = 'balancer-led'

  // ── Head: yaw servo + bracket, then a pitching sensor bar with two camera eyes ──
  const servo = own(blockGeometry(0.022, 0.02, 0.026))
  const bracketBase = own(blockGeometry(0.078, 0.003, 0.012))
  const bracketArm = own(blockGeometry(0.004, 0.016, 0.012))
  const pitchPin = own(pinGeometry(0.0025, 0.078))
  const yawMesh = new Assembly()
    .add(servo, 'dark', { pos: [0, 0.01, 0], edges: false })
    .add(bracketBase, 'dark', { pos: [0, 0.0215, 0], edges: false })
    .add(bracketArm, 'dark', { pos: [-0.037, 0.0305, 0], edges: false })
    .add(bracketArm, 'dark', { pos: [0.037, 0.0305, 0], edges: false })
    .add(pitchPin, 'dark', { pos: [0, GEO.pitchAxis, 0], rot: ALONG_X_PIN, edges: false })
    .build(mats, 'balancer-head-yaw')
  const headBeam = own(beamGeometry({ length: 0.064, width: 0.024, thickness: 0.008, holes: [0, 0.064], slots: [[0.022, 0.042]] }))
  const eyeRing = own(discGeometry(0.0075, 0.006, [{ x: 0, y: 0, r: 0.0045 }], 20))
  const lens = own(discGeometry(0.0048, 0.004, [], 20))
  const pitchMesh = new Assembly()
    .add(headBeam, accent, { pos: [-0.032, 0.006, 0.008] })
    .add(eyeRing, 'light', { pos: [-0.016, 0.007, 0.0145] })
    .add(eyeRing, 'light', { pos: [0.016, 0.007, 0.0145] })
    .add(lens, 'dark', { pos: [-0.016, 0.007, 0.0135], edges: false })
    .add(lens, 'dark', { pos: [0.016, 0.007, 0.0135], edges: false })
    .build(mats, 'balancer-head-pitch')

  // ── Legs: shin (hub -> knee) and thigh (knee -> hip), knees back ──
  const shinBeam = own(beamGeometry({ length: GEO.shin, width: 0.016, thickness: 0.006, holes: [0, GEO.shin], slots: [[0.024, 0.06]] }))
  const thighBeam = own(beamGeometry({ length: GEO.thigh, width: 0.018, thickness: 0.006, holes: [0, GEO.thigh], slots: [[0.022, 0.062]] }))
  const kneeServo = own(blockGeometry(0.02, 0.026, 0.022))
  const horn = own(discGeometry(0.009, 0.003, [], 20))
  const hubPin = own(pinGeometry(0.004, 0.03))
  const shinMesh = (sx: number) => new Assembly()
    .add(shinBeam, 'dark', { rot: UPRIGHT_SIDE, edges: false })
    .add(hubPin, 'dark', { pos: [sx * 0.012, 0, 0], rot: ALONG_X_PIN, edges: false })
    .add(kneeServo, 'dark', { pos: [-sx * 0.013, GEO.shin - 0.004, 0], edges: false })
    .add(horn, 'red', { pos: [sx * 0.0045, GEO.shin, 0], rot: FACE_X })
    .build(mats, 'balancer-shin')
  const thighMesh = (sx: number) => new Assembly()
    .add(thighBeam, 'light', { pos: [sx * 0.008, 0, 0], rot: UPRIGHT_SIDE })
    .add(horn, 'red', { pos: [sx * 0.0125, GEO.thigh, 0], rot: FACE_X })
    .build(mats, 'balancer-thigh')

  // ── Wheels: red tyre (drive), light rim, hub and spokes ──
  const R = GEO.wheelR
  const tyre = own(discGeometry(R, GEO.wheelW, [{ x: 0, y: 0, r: R - 0.009 }], 40))
  const rim = own(discGeometry(R - 0.009, GEO.wheelW * 0.6, [{ x: 0, y: 0, r: R - 0.0125 }], 40))
  const hub = own(discGeometry(0.011, GEO.wheelW * 0.9, [{ x: 0, y: 0, r: 0.004 }], 20))
  const spoke = own(blockGeometry(0.0016, R - 0.022, 0.0016))
  const wheelMesh = (name: string) => {
    const asm = new Assembly()
      .add(tyre, 'red', { rot: FACE_X })
      .add(rim, 'light', { rot: FACE_X })
      .add(hub, 'light', { rot: FACE_X })
    // Twelve spokes, crossing like a bicycle's, as fine light rods (no hairlines -- they ARE the line).
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2
      const off = (i % 2 ? 1 : -1) * 0.0025
      const mid = (0.011 + R - 0.0125) / 2
      asm.add(spoke, 'light', { pos: [off, Math.cos(a) * mid, Math.sin(a) * mid], rot: [a, 0, 0], edges: false })
    }
    return asm.build(mats, name)
  }

  // ── Rig ──
  const root = new THREE.Group()
  root.name = 'balancer'
  const axle = new THREE.Group()
  axle.position.y = GEO.wheelR
  root.add(axle)

  const wheelL = new THREE.Group()
  wheelL.position.x = GEO.wheelX
  wheelL.add(wheelMesh('balancer-wheel-l'))
  const wheelR = new THREE.Group()
  wheelR.position.x = -GEO.wheelX
  wheelR.add(wheelMesh('balancer-wheel-r'))
  const body = new THREE.Group()
  axle.add(wheelL, wheelR, body)

  const legs = [1, -1].map((sx) => {
    const shin = new THREE.Group()
    shin.position.x = sx * GEO.legX
    shin.add(shinMesh(sx))
    const thigh = new THREE.Group()
    thigh.position.y = GEO.shin
    thigh.add(thighMesh(sx))
    shin.add(thigh)
    body.add(shin)
    return { shin, thigh }
  })

  const pod = new THREE.Group()
  pod.add(podMesh, led)
  body.add(pod)
  const headYaw = new THREE.Group()
  headYaw.position.y = GEO.headBase
  headYaw.add(yawMesh)
  pod.add(headYaw)
  const headPitch = new THREE.Group()
  headPitch.position.y = GEO.pitchAxis
  headPitch.add(pitchMesh)
  headYaw.add(headPitch)

  const shadow = contactShadow(mats, 0.15)
  root.add(shadow)

  const ringGeo = own(new THREE.RingGeometry(0.135, 0.14, 48))
  ringGeo.rotateX(-Math.PI / 2)
  const ring = new THREE.Mesh(ringGeo, mats.face.cyan)
  ring.position.y = 0.001
  ring.visible = false
  root.add(ring)

  const ang: [number, number] = [0, 0]
  const setLegs = (lenL: number, lenR: number) => {
    for (let i = 0; i < 2; i++) {
      legAngles(i === 0 ? lenL : lenR, ang)
      legs[i]!.shin.rotation.x = ang[0]
      legs[i]!.thigh.rotation.x = ang[1]
    }
    pod.position.y = (lenL + lenR) / 2
  }
  setLegs(GEO.legStand, GEO.legStand)

  const pick: THREE.Mesh[] = []
  for (const g of [podMesh, yawMesh, pitchMesh, wheelL, wheelR, ...legs.map(l => l.shin)]) {
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.LineSegments).isLineSegments) pick.push(o as THREE.Mesh)
    })
  }

  return {
    root, axle, body, wheelL, wheelR, setLegs, pod, headYaw, headPitch, shadow, ring, led, pick,
    dispose() {
      root.traverse((o) => {
        if (o === ring) return
        ;(o as THREE.Mesh).geometry?.dispose()
      })
      geos.forEach(g => g.dispose())
    },
  }
}
