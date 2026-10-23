import * as THREE from 'three'
import { PLACES, benchBox, subjectBoxes, type Box, type Place } from './layout'

/**
 * The camera and its framing, pure (three's maths only) so the tests can run
 * it at any screen size.
 *
 * The scene is given the FOCUS box (see fit() in core/stage.ts); the framing
 * makes the two machines span FILL of its width wherever the height allows,
 * keeps the whole bench (legs and props included) inside it, and picks the
 * layout (side by side, or staggered) that draws the machines larger.
 */

/** Front-left and a little above, low enough that the bench reads as furniture. */
export const VIEW = new THREE.Vector3(-1.25, 1.12, 3).normalize()
export const TARGET = new THREE.Vector3(0, 0.4, 0.1)
const DIST = 8

/** The machines' share of the focus box width, when the width sets the scale. */
export const FILL = 0.8
/** Shares the whole bench may take of the box (it may be a little wider than the machines). */
const BENCH_W = 0.96
const BENCH_H = 0.92

export function makeCamera() {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 30)
  camera.position.copy(TARGET).addScaledVector(VIEW, DIST)
  camera.lookAt(TARGET)
  camera.updateMatrixWorld()
  return camera
}

const p3 = new THREE.Vector3()

/** Camera-space bounds of boxes' corners. */
function bounds(boxes: Box[], inv: THREE.Matrix4) {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }
  for (const box of boxes) {
    for (const x of [box.x0, box.x1]) {
      for (const y of [box.y0, box.y1]) {
        for (const z of [box.z0, box.z1]) {
          p3.set(x, y, z).applyMatrix4(inv)
          b.x0 = Math.min(b.x0, p3.x)
          b.x1 = Math.max(b.x1, p3.x)
          b.y0 = Math.min(b.y0, p3.y)
          b.y1 = Math.max(b.y1, p3.y)
        }
      }
    }
  }
  return b
}

/** The view (camera-space width, height, centre) that frames `place` in a w x h box. */
export function framing(place: Place, w: number, h: number, inv: THREE.Matrix4) {
  const subject = subjectBoxes(place)
  const s = bounds(subject, inv)
  const all = bounds([...subject, benchBox(place)], inv)
  const aspect = w / Math.max(1, h)
  const vw = Math.max((s.x1 - s.x0) / FILL, (all.x1 - all.x0) / BENCH_W, ((all.y1 - all.y0) / BENCH_H) * aspect)
  return { place, vw, vh: vw / aspect, cx: (all.x0 + all.x1) / 2, cy: (all.y0 + all.y1) / 2 }
}

/** Frames the camera for a w x h focus box; returns the layout to stand the machines in. */
export function frameCamera(camera: THREE.OrthographicCamera, w: number, h: number): Place {
  camera.updateMatrixWorld()
  const inv = camera.matrixWorldInverse
  let best = framing('tall', w, h, inv)
  for (const p of Object.keys(PLACES) as Place[]) {
    const f = framing(p, w, h, inv)
    if (f.vw < best.vw - 1e-9) best = f
  }
  camera.left = best.cx - best.vw / 2
  camera.right = best.cx + best.vw / 2
  camera.top = best.cy + best.vh / 2
  camera.bottom = best.cy - best.vh / 2
  camera.updateProjectionMatrix()
  return best.place
}
