import assert from 'node:assert/strict'
import { CoconutPlayback, coconutPose } from '../app/three/scenes/backwater/scroll-coconut'
import { World } from '../app/three/scenes/backwater/sim'
import type { V3 } from '../app/three/scenes/backwater/layout'

const start: V3 = [10, 7, -2]
const end: V3 = [10.7, 0.8, -1]
const pos: V3 = [0, 0, 0]
assert.deepEqual(coconutPose(start, end, 0, pos), start)
assert.deepEqual(coconutPose(start, end, 0.12, pos), start)
const path = Array.from({ length: 1001 }, (_, k) => [...coconutPose(start, end, k / 1000, pos)])
for (let k = 1000; k >= 0; k--) {
  assert.deepEqual(coconutPose(start, end, k / 1000, pos), path[k], 'the trajectory is deterministic')
  assert.ok(pos.every(Number.isFinite))
  assert.ok(pos[1] >= end[1] - 1e-9, 'coconut never sinks below the bank')
  if (k > 0) assert.ok(Math.hypot(...pos.map((v, i) => v - path[k - 1]![i]!)) < 0.03, 'continuous fall and bounce')
}
assert.ok(Math.abs(coconutPose(start, end, 0.68, pos)[1] - end[1]) < 1e-9)
const sim = new World(11)
sim.storyNut = [0, 0]
for (let i = 0; i < 12; i++) { sim.requestDrop(0); sim.step(0.005) }
assert.equal(sim.palms[0]!.nuts[0]!.state, 'on', 'ambient drops cannot take the scroll-controlled coconut')
const playback = new CoconutPlayback()
playback.step(0.005, 0.5, false)
assert.equal(playback.started, false, 'waits for the bank camera to be visible')
playback.step(0.005, 0.5, true)
assert.equal(playback.started, true)
const begun = playback.progress
for (let n = 0; n < 400; n++) {
  const before = playback.progress
  playback.step(0.005, 0, false)
  assert.ok(playback.progress >= before, 'backward scroll never rewinds the coconut')
}
assert.ok(begun > 0.12)
assert.equal(playback.progress, 1, 'finishes normally even if scrolling stops or reverses')
console.log('Scroll coconut: triggers in view, finishes normally, never rewinds, stays grounded')
