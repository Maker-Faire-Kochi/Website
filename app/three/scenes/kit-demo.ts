import * as THREE from 'three'
import { Assembly, addLights, beamGeometry, disposeGeometries, fitOrtho, pinGeometry, type MatKey } from '../core/kit'
import type { SceneContext, SceneInstance, SlotPointer } from '../core/stage'

/**
 * Kit reference: the guidelines' straight-beam baseline (five beams make a
 * gesture; the blue one opens it up), rebuilt from the kit. It is the visual
 * check for kit.ts and the pattern every other scene follows:
 * rigid assemblies on joint nodes, state stepped at DT, interpolated in frame().
 */
export default function create(ctx: SceneContext): SceneInstance {
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.OrthographicCamera()
  camera.position.set(1.4, 1.1, 3)
  camera.lookAt(0.25, 0.32, 0)

  const L = 0.5
  const beam = beamGeometry({ length: L, width: 0.1, thickness: 0.03, slots: [[0.16, 0.34]] })
  const pin = pinGeometry(0.02, 0.06)
  const link = (mat: MatKey, name: string) => new Assembly()
    .add(beam, mat)
    .add(pin, 'light', { pos: [0, 0, 0] })
    .add(pin, 'light', { pos: [L, 0, 0] })
    .build(ctx.materials, name)

  const deg = THREE.MathUtils.degToRad
  const root = new THREE.Group()
  scene.add(root)

  const bottom = link('dark', 'bottom')
  bottom.rotation.z = deg(-8)
  bottom.position.z = -0.035
  const upright = link('dark', 'upright')
  upright.rotation.z = deg(92)
  root.add(bottom, upright)

  const j1 = new THREE.Group()
  j1.position.x = L
  j1.rotation.z = deg(-62)
  upright.add(j1)
  const upper = link('light', 'upper')
  upper.position.z = 0.035
  j1.add(upper)

  const j2 = new THREE.Group()
  j2.position.set(L, 0, 0.035)
  upper.add(j2)
  const opener = link('accent', 'opener')
  j2.add(opener)

  // Joint state, stepped at DT and interpolated per frame.
  let t = 0
  let angle = deg(-65)
  let prev = angle
  let target: number | null = null

  return {
    scene,
    camera,
    step(dt) {
      prev = angle
      t += dt
      const goal = target ?? deg(-65) + deg(28) * Math.sin(t * 0.9)
      angle += (goal - angle) * Math.min(1, dt * 6)
    },
    frame(alpha) {
      j2.rotation.z = ctx.posterMode ? deg(-65) : prev + (angle - prev) * alpha
    },
    resize(w, h) {
      fitOrtho(camera, w, h, 1.5)
    },
    pointer(p: SlotPointer) {
      target = p.kind === 'move' ? deg(-110) + (p.ndc.x + 1) * deg(45) : null
    },
    setPaused(paused) {
      if (paused) target = null
    },
    dispose() {
      disposeGeometries(scene)
      beam.dispose()
      pin.dispose()
    },
  }
}
