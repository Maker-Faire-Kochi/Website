import * as THREE from 'three'
import { DT } from '../../core/clock'
import { addLights, disposeGeometries } from '../../core/kit'
import { createPerson } from '../../people/person'
import { nextTask, type SceneContext, type SceneInstance, type SlotPointer } from '../../core/stage'
import { BENCH_PARTS, seams, shadows } from './bench'
import { BENCH, DRILL, LAMP, RACK, SAW, SEAT, SOLDER, TOP, WORK, workToWorld, type V3 } from './bench-layout'
import { BSNAP, BEV, WorkbenchSim, type Job } from './bench-sim'
import {
  addElectronics, buildArm, buildButtonCap, buildChirp, buildHoles, buildLights, NAMES, PartSet, SBC_LEDS,
  type Light, type Target,
} from './build'
import { buildFillets, buildIronCable, buildLampLight, buildMeterDisplay, buildParticles, buildSolderWire, buildTerminal } from './fx'
import { addRoom, floorJoints, monitorScreen, MONITOR, pegHoles } from './room'
import { hoverLabel } from './label'
import { ARM, BUTTON, LED_COLOURS, ledCentre, SERVO_BODY, SHAFT } from './layout'
import { OperatorDriver } from './operator'
import { framingAt, newFraming, scrollShot, ShotFollower, SHOTS, type Framing } from './shots'
import { EV, LED_COUNT, SNAP, trackAngle, type Pattern } from './sim'
import { beep, benchSound, bootChime, click, servoWhirr, stopSounds } from './sound'
import { buildFeed, buildIron, buildKnob, buildQuill, buildSawArm } from './tools'

/**
 * Domains, "Electronics & IoT": a maker's electronics WORKBENCH. A long
 * butcher-block top on steel tool-chest pedestals, a slotted-beam rack with a
 * shelf of boxes, parts bins and spray cans and a rail of hand tools; on the
 * bench a soldering station and iron, a hot-air station, a magnifier lamp,
 * a multimeter, battery packs, a drill press at one end and a mitre saw at
 * the other; on the blue silicone mat in front, the work: a single-board
 * computer wired to a breadboard (LEDs, button, buzzer, servo) and a small
 * perfboard in the helping hands being soldered by the maker on the stool:
 * he lifts the iron out of its holder, brings the tip to each joint, feeds
 * solder in with his other hand while it sizzles and smokes, and puts the
 * iron back (operator.ts drives him; the people library draws him).
 *
 * WorkbenchSim (pure, fixed-step, seeded) owns every state; this file draws
 * its snapshots, interpolated between the last two steps. Hover names a part
 * (cyan, and its name for the DOM's leader line in label.ts). Taps: the board
 * boots, the button cycles the LED pattern, the servo sweeps, the buzzer
 * chirps, the breadboard runs an LED chase, the iron (or its holder, the
 * station, the board in the clips) starts a soldering session, the drill
 * press drills, the saw cuts, the meter measures, the lamp switches. Tool
 * jobs queue; they never overlap.
 *
 * The camera follows the page's scroll through SHOTS (shots.ts): the whole
 * bench, then the iron, the computer and the breadboard, eased and never cut.
 */

const BOOT_TARGETS = new Set<Target>(['board', 'soc', 'ram', 'gpio', 'usb', 'ethernet', 'hdmi', 'usbc', 'pwrLed', 'actLed'])
const SOLDER_TARGETS = new Set<Target>(['iron', 'holder', 'station', 'perfboard', 'helpingHands', 'spool'])
const CHASE_TARGETS = new Set<Target>(['breadboard', 'led0', 'led1', 'led2', 'led3', 'res0', 'res1', 'res2', 'res3', 'wires'])
const PATTERN_NAME: Record<Pattern, string> = { idle: 'idle chase', counter: 'binary counter', bounce: 'bounce' }
const JOB_NAME: Record<Job, string> = { solder: 'soldering', drill: 'drill press', saw: 'mitre saw', measure: 'measurement' }
const JOB_START: Record<Job, string> = {
  solder: 'Soldering: the iron comes out of its holder, three joints, back in the holder',
  drill: 'Drill press: the bit spins up and drills the block',
  saw: 'Mitre saw: the blade spins up and cuts the strip',
  measure: 'Multimeter: switched to continuity, it beeps',
}
/** The part a detail shot keeps highlighted. */
const MAKER_NAME = 'Maker, soldering'
const SHOT_HIGHLIGHT: Record<string, Target> = { iron: 'iron', board: 'board', breadboard: 'breadboard' }
/** On touch devices a tap shows the part's name this long. */
const TAP_LABEL = 2.5

/**
 * Three-quarter elevated views (azimuth from the front toward +x, elevation),
 * radians. Wide bands look along the bench almost square-on; narrower slots
 * (a 4:3 phone band) swing to a steeper diagonal so the bench stacks up the
 * frame and draws larger.
 */
const VIEW_WIDE = { az: -0.92, el: 0.46 }
const VIEW_NARROW = { az: -0.95, el: 0.5 }

/** The span of the bench the whole-bench framing must hold (x, metres). */
const FRAME_X = [-1.1, 1.25] as const
/** The operator's look (people library seed): a man in a shirt. */
const OPERATOR_SEED = 5
/** Where the seated maker is, for framing: [x0, y0, z0, x1, y1, z1]. */
const OPERATOR_BOX = [SEAT.x - 0.3, 0, SEAT.z - 0.45, SEAT.x + 0.3, SEAT.top + 0.9, SEAT.z + 0.25]

export default async function create(ctx: SceneContext): Promise<SceneInstance> {
  const m = ctx.materials
  const scene = new THREE.Scene()
  addLights(scene)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60)

  // ── Static drawing: the bench, its tools and the electronics, one merge ─
  const set = new PartSet()
  for (let i = 0; i < BENCH_PARTS.length; i++) {
    BENCH_PARTS[i]!(set)
    if (i % 4 === 3) await nextTask()
  }
  addRoom(set)
  set.setFrame(new THREE.Matrix4().compose(new THREE.Vector3(WORK.x, WORK.y, WORK.z), new THREE.Quaternion(), new THREE.Vector3(WORK.scale, WORK.scale, WORK.scale)))
  addElectronics(set)
  set.setFrame(null)
  await nextTask()
  const bench = await set.buildAsync(m, 'bench', nextTask)
  scene.add(bench.group, seams(m.lineFaint, floorJoints()), shadows(m.shadow), pegHoles(m.face.dark))
  await nextTask()

  // ── The work node: the electronics' moving parts, in their decimetres ──
  const work = new THREE.Group()
  work.name = 'work'
  work.position.set(WORK.x, WORK.y, WORK.z)
  work.scale.setScalar(WORK.scale)
  const holes = buildHoles(m)
  const cap = buildButtonCap(m)
  const arm = buildArm(m)
  work.add(holes, cap.node, arm.node)
  const tipLight: Light = { pos: [0, 0, 0], colour: ctx.palette.red, dot: 0.02, glow: 0.3, lift: 0.03 }
  const lights: Light[] = [
    { pos: SBC_LEDS[0]!, colour: '#FF3B2F', dot: 0.007, glow: 0.1, lift: 0.004 },
    { pos: SBC_LEDS[1]!, colour: '#2FCB5A', dot: 0.007, glow: 0.1, lift: 0.004 },
    ...LED_COLOURS.map((colour, k) => ({ pos: ledCentre(k), colour, dot: 0.011, glow: 0.2, lift: 0.022 })),
    tipLight,
  ]
  const glow = buildLights(lights, camera)
  const chirp = buildChirp(ctx.palette.ink, camera)
  work.add(glow.dots, glow.glows, chirp.lines)
  scene.add(work)
  await nextTask()

  // ── Tools that move, and the living details ───────────────────────────
  const iron = buildIron(m)
  const quill = buildQuill(m)
  const feed = buildFeed(m)
  const sawArm = buildSawArm(m)
  const knob = buildKnob(m)
  scene.add(iron.node, quill.node, feed.node, sawArm.node, knob.node)
  const fillets = buildFillets(m)
  const sim = new WorkbenchSim(11)
  const particles = buildParticles(sim.smoke.length, sim.dust.length, ctx.palette.woodDark)
  const lamp = buildLampLight()
  const display = buildMeterDisplay(ctx.palette.ink)
  const cable = buildIronCable(m)
  const wire = buildSolderWire(m)
  const terminal = buildTerminal(monitorScreen(), MONITOR.w, MONITOR.h)
  scene.add(terminal.mesh)
  scene.add(fillets.mesh, particles.points, lamp.mesh, display.mesh, cable.mesh, wire.line)
  const sound = benchSound()
  await nextTask()

  // ── OPERATOR: the maker on the stool (people library) ────────────────
  // He sits in the knee well facing the bench; OperatorDriver puts his right
  // hand on the iron's grip through the whole soldering timeline, his left on
  // the solder wire, leans him in over each joint and keeps his eyes on it.
  const person = createPerson(ctx, { seed: OPERATOR_SEED, variant: 'shirt', posterMode: ctx.posterMode, colors: { skin: 'woodDark', hair: 'dark', top: 'light', bottom: 'dark' } })
  person.placeAt(SEAT.x, SEAT.z, SEAT.heading)
  person.setStance('sit', { seatHeight: SEAT.top, instant: true })
  scene.add(person.root)
  const driver = new OperatorDriver(person)
  /** Where he looks when he looks up at the visitor: toward the camera, from his eyes. */
  const viewer: V3 = [0, 0, 0]
  const setViewer = (az: number, el: number) => {
    viewer[0] = SEAT.x + Math.sin(az) * Math.cos(el) * 3
    viewer[1] = SEAT.top + 0.75 + Math.sin(el) * 3
    viewer[2] = SEAT.z + Math.cos(az) * Math.cos(el) * 3
  }
  setViewer(VIEW_WIDE.az, VIEW_WIDE.el)
  await nextTask()

  // ── Hover / tap targets ───────────────────────────────────────────────
  const picks = [...bench.picks, ...cap.picks, ...arm.picks, ...iron.picks, ...quill.picks, ...feed.picks, ...sawArm.picks, ...knob.picks]
  const byTarget = new Map<Target, THREE.Mesh[]>()
  for (const p of picks) {
    const t = p.userData.target as Target
    byTarget.set(t, [...(byTarget.get(t) ?? []), p])
  }
  scene.updateMatrixWorld(true)
  // Leader anchor: the top centre of the part's static overlay, so a label
  // never rides on moving geometry; the iron's follows the iron.
  const anchors = new Map<Target, THREE.Vector3>()
  const box = new THREE.Box3()
  for (const [t, list] of byTarget) {
    const mesh = list.find(p => bench.picks.includes(p)) ?? list[0]!
    box.setFromObject(mesh, true)
    anchors.set(t, new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2))
  }
  anchors.set('servo', new THREE.Vector3(...workToWorld(SHAFT[0], SERVO_BODY.h + 0.02, SHAFT[1])))
  const wirePos = byTarget.get('wires')![0]!.geometry.getAttribute('position')
  let topI = 0
  for (let i = 1; i < wirePos.count; i++) if (wirePos.getY(i) > wirePos.getY(topI)) topI = i
  anchors.set('wires', new THREE.Vector3(wirePos.getX(topI), wirePos.getY(topI), wirePos.getZ(topI)))
  const ironAnchor = new THREE.Vector3()

  let hovered: Target | null = null
  let held: Target | null = null
  let labelHold = 0
  const lit = new Set<Target>()
  /** Cyan on the hovered part and on the part a detail shot is showing. */
  function relight() {
    const want = new Set<Target>()
    if (hovered) want.add(hovered)
    if (held) want.add(held)
    for (const t of lit) if (!want.has(t)) for (const p of byTarget.get(t) ?? []) p.visible = false
    for (const t of want) if (!lit.has(t)) for (const p of byTarget.get(t) ?? []) p.visible = true
    lit.clear()
    want.forEach(t => lit.add(t))
  }
  let makerHover = false
  const highlight = (t: Target | 'maker' | null) => {
    const m = t === 'maker'
    if (m !== makerHover) {
      makerHover = m
      person.setSelected(m)
    }
    const part = m ? null : t
    if (part === hovered && (m || !makerHover)) {
      hoverLabel.visible = !!t
      hoverLabel.text = m ? MAKER_NAME : part ? NAMES[part] : ''
      return
    }
    hovered = part
    relight()
    hoverLabel.visible = !!t
    hoverLabel.text = m ? MAKER_NAME : part ? NAMES[part] : ''
  }
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  /** 'maker' is the person: he sits in front of everything near him, so a ray that meets him names nothing behind. */
  const pick = (p: SlotPointer): Target | 'maker' | null => {
    ndc.set(p.ndc.x, p.ndc.y)
    ray.setFromCamera(ndc, camera)
    if (person.hit(ray)) return 'maker'
    const hit = ray.intersectObjects(picks, false)[0]
    return hit ? (hit.object.userData.target as Target) : null
  }

  // ── Simulation ────────────────────────────────────────────────────────
  if (ctx.posterMode) {
    // The representative frame: booted, the counter showing 0101, the servo
    // panned a little left, and the iron on the second joint of a session
    // with the solder fed in and smoke rising.
    const e = sim.elec
    e.boot()
    for (let i = 0; i < 20 / DT && e.booting; i++) e.step(DT)
    e.press()
    e.setTrack(128)
    sim.request('solder')
    const target = 0.55 + 0.45 + 0.95 + 0.32 + 1.7 + 0.3 + 0.5 + 0.32 + 1.05
    for (let i = 0; i < Math.round(target / DT); i++) sim.step(DT)
    sim.takeEvents()
    e.takeEvents()
  }
  if (ctx.posterMode) {
    // Settle him into the poster pose: hands on the iron and the wire, leaning in.
    for (let i = 0; i < 400; i++) {
      driver.drive(sim, viewer)
      person.step(DT)
    }
  }
  let prev = sim.elec.snapshot(new Float64Array(SNAP.size))
  let cur = sim.elec.snapshot(new Float64Array(SNAP.size))
  let bprev = sim.snapshot(new Float64Array(BSNAP.size))
  let bcur = sim.snapshot(new Float64Array(BSNAP.size))
  const v = new Float64Array(SNAP.size)
  const b = new Float64Array(BSNAP.size)
  const levels = new Float64Array(2 + LED_COUNT + 1)
  const shaftPt = new THREE.Vector3(...workToWorld(SHAFT[0], ARM.y, SHAFT[1]))
  const p3 = new THREE.Vector3()
  const capY = cap.node.position.y
  const tipV: V3 = [0, 0, 0]
  const axV: V3 = [0, 0, 0]
  const solderTip: V3 = [0, 0, 0]
  const pinch: V3 = [0, 0, 0]
  let w = ctx.width
  let h = ctx.height

  // ── Shots: scroll-driven camera ───────────────────────────────────────
  const follower = new ShotFollower()
  follower.jump(scrollShot.progress)
  let sPrev = follower.s
  let sCur = follower.s
  const benchFraming = newFraming()
  const fr = newFraming()

  const run = (job: Job) => {
    const was = sim.running
    const r = sim.request(job)
    if (r === 'started') return JOB_START[job]
    if (r === 'queued') return `${JOB_START[job].split(':')[0]} queued after the ${JOB_NAME[was ?? sim.queue[0]!]}`
    return sim.running === job ? `Already ${job === 'solder' ? 'soldering' : `running the ${JOB_NAME[job]}`}` : `${JOB_START[job].split(':')[0]} is already queued`
  }
  const status = {
    boot: () => (sim.elec.boot() === 'started' ? 'Booting: power, activity, LED chase, servo sweep, chirp' : 'Already booting'),
    button: () => `Button pressed: LED pattern ${PATTERN_NAME[sim.elec.press()]}`,
    servo: () => (sim.elec.sweep() === 'started' ? 'Servo sweeping 0, 180, 90 degrees' : 'Busy booting'),
    chirp: () => (sim.elec.chirp() ? 'Buzzer chirps' : 'Buzzer already chirping'),
    chase: () => (sim.elec.chase() === 'started' ? 'LED chase across the breadboard' : 'The LEDs are busy'),
    solder: () => run('solder'),
    drill: () => run('drill'),
    saw: () => run('saw'),
    measure: () => run('measure'),
    lamp: () => (sim.toggleLamp() ? 'Lamp on' : 'Lamp off'),
    wave: () => {
      const r = sim.wave()
      return r === 'now' ? 'The maker looks up and waves' : r === 'after' ? 'The maker looks up; he will wave once the iron is back in its holder' : 'The maker is already waving'
    },
  }
  type ActionName = keyof typeof status
  const ARRIVAL: Record<string, ActionName> = { iron: 'solder', board: 'boot', breadboard: 'chase' }

  const lerpAngle = (a: number, c: number, t: number) => {
    let d = c - a
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    return a + d * t
  }

  /** What the computer's terminal shows: its boot log while booting, then the running script's state. */
  const BOOT_LOG: [number, string][] = [
    [0, '[ 0.00] reset'], [0.45, '[ 0.45] power good, booting'], [0.9, '[ 0.90] mmc0: card ready'],
    [1.2, '[ 1.20] gpio: 4 LEDs, 1 button'], [2.0, '[ 2.00] servo: sweep 0-180-90'], [3.6, '[ 3.60] buzzer: ok'],
  ]
  function terminalText() {
    const e = sim.elec
    if (e.booting) {
      terminal.show(BOOT_LOG.filter(([t]) => e.bootT >= t).map(([, l]) => l), false)
      return
    }
    terminal.show([
      'maker@bench:~ $ python3 bench.py',
      `pattern  ${e.pattern}`,
      `servo    ${Math.round(e.angle / 5) * 5} deg`,
      `5V rail  ${sim.reading.toFixed(2)} V`,
      'maker@bench:~ $ ',
    ], Math.floor(sim.t * 1.6) % 2 === 0)
  }

  function draw(alpha: number) {
    for (let i = 0; i < SNAP.size; i++) v[i] = prev[i]! + (cur[i]! - prev[i]!) * alpha
    for (let i = 0; i < BSNAP.size; i++) b[i] = bprev[i]! + (bcur[i]! - bprev[i]!) * alpha
    b[BSNAP.drillAngle] = lerpAngle(bprev[BSNAP.drillAngle]!, bcur[BSNAP.drillAngle]!, alpha)
    b[BSNAP.blade] = lerpAngle(bprev[BSNAP.blade]!, bcur[BSNAP.blade]!, alpha)

    // Camera first: everything camera-facing below reads it.
    const s = sPrev + (sCur - sPrev) * alpha
    applyFraming(framingAt(s, benchFraming, fr))

    // Electronics.
    arm.node.rotation.y = (-v[SNAP.angle]! * Math.PI) / 180
    cap.node.position.y = capY - v[SNAP.press]! * BUTTON.travel
    levels[0] = v[SNAP.power]!
    levels[1] = v[SNAP.act]!
    for (let i = 0; i < LED_COUNT; i++) levels[2 + i] = v[SNAP.led + i]!

    // The iron, its lead, its hot tip.
    for (let i = 0; i < 3; i++) {
      tipV[i] = b[BSNAP.tip + i]!
      axV[i] = b[BSNAP.axis + i]!
    }
    iron.pose(tipV, axV)
    cable.update(tipV, axV)
    tipLight.pos[0] = (tipV[0] - WORK.x) / WORK.scale
    tipLight.pos[1] = (tipV[1] - WORK.y) / WORK.scale
    tipLight.pos[2] = (tipV[2] - WORK.z) / WORK.scale
    levels[2 + LED_COUNT] = b[BSNAP.tipGlow]!
    glow.update(levels)
    chirp.set(v[SNAP.chirp]!)

    // Solder wire through the left hand's pinch.
    for (let i = 0; i < 3; i++) {
      solderTip[i] = b[BSNAP.solderTip + i]!
      pinch[i] = solderTip[i]! - b[BSNAP.solderDir + i]! * SOLDER.stick
    }
    wire.update(pinch, solderTip)
    fillets.update(b.subarray(BSNAP.fillet))

    // Drill press, saw, meter, lamp, smoke.
    quill.node.position.y = DRILL.nose - b[BSNAP.drill]! * DRILL.travel
    quill.node.rotation.y = b[BSNAP.drillAngle]!
    feed.node.rotation.x = (b[BSNAP.drill]! * DRILL.travel) / DRILL.pinion
    sawArm.node.rotation.x = -(SAW.up + (SAW.down - SAW.up) * b[BSNAP.saw]!)
    sawArm.bladeNode.rotation.x = b[BSNAP.blade]!
    knob.turn.rotation.z = -0.9 * b[BSNAP.knob]!
    lamp.set(b[BSNAP.lamp]!)
    if (sim.meterMode === 'ohm') display.show('0.4', 'Ω')
    else display.show(sim.reading.toFixed(2), 'V')
    particles.update(sim.smoke, sim.dust)
    terminalText()

    if (makerHover) {
      p3.set(person.position.x, SEAT.top + 0.85, person.position.z).project(camera)
      hoverLabel.x = ((p3.x + 1) / 2) * w
      hoverLabel.y = ((1 - p3.y) / 2) * h
    }
    else if (hovered) {
      const a = hovered === 'iron' ? iron.node.localToWorld(ironAnchor.set(0.12, 0.02, 0)) : anchors.get(hovered)!
      p3.copy(a).project(camera)
      hoverLabel.x = ((p3.x + 1) / 2) * w
      hoverLabel.y = ((1 - p3.y) / 2) * h
    }
  }

  // ── Framing ───────────────────────────────────────────────────────────
  // Every vertex of the static bench (sampled), the saw's raised arm, the
  // lamp head, the shelf's load and the seated operator's envelope.
  // (Boxes, not the merged mesh: the room's floor and walls run far past the
  // subject on purpose and must not be fitted.)
  const framePts: number[] = []
  const boxPts = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) framePts.push(x, y, z)
  }
  // The working middle of the bench, floor to shelf: the maker, the mat and
  // the tools he reaches. The bench's ends, the corner and the room run on
  // past the frame (the drill press and saw stay in view on wide screens).
  boxPts(FRAME_X[0], 0, BENCH.z0, FRAME_X[1], TOP, BENCH.z1)
  boxPts(FRAME_X[0], RACK.shelfY, RACK.shelfZ0, FRAME_X[1], RACK.shelfY + 0.2, RACK.shelfZ1)
  const raised = SAW.pivot[1] + Math.sin(SAW.up) * SAW.reach + SAW.bladeR + 0.06
  framePts.push(SAW.x, raised, SAW.pivot[2] + Math.cos(SAW.up) * SAW.reach)
  framePts.push(LAMP.head[0], LAMP.head[1] + 0.03, LAMP.head[2])
  for (const x of [OPERATOR_BOX[0]!, OPERATOR_BOX[3]!]) {
    for (const y of [OPERATOR_BOX[1]!, OPERATOR_BOX[4]!]) {
      for (const z of [OPERATOR_BOX[2]!, OPERATOR_BOX[5]!]) framePts.push(x, y, z)
    }
  }

  const dirOf = (az: number, el: number, out: THREE.Vector3) => out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
  const d3 = new THREE.Vector3()
  const t3 = new THREE.Vector3()

  function applyFraming(f: Framing) {
    t3.set(f.target[0], f.target[1], f.target[2])
    camera.position.copy(t3).addScaledVector(dirOf(f.az, f.el, d3), 20)
    camera.up.set(0, 1, 0)
    camera.lookAt(t3)
    camera.updateMatrixWorld()
    const aspect = w / Math.max(1, h)
    camera.top = f.viewH / 2
    camera.bottom = -f.viewH / 2
    camera.left = (-f.viewH * aspect) / 2
    camera.right = (f.viewH * aspect) / 2
    camera.updateProjectionMatrix()
    chirp.orient()
  }

  /** The whole-bench framing for this slot: centre the bench in the view and fit it with a little air. */
  function fitBench(width: number, height: number) {
    const aspect = width / Math.max(1, height)
    const view = aspect < 1.7 ? VIEW_NARROW : VIEW_WIDE
    camera.position.copy(dirOf(view.az, view.el, d3)).multiplyScalar(20)
    camera.up.set(0, 1, 0)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    const inv = camera.matrixWorldInverse
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 0; i < framePts.length; i += 3) {
      p3.set(framePts[i]!, framePts[i + 1]!, framePts[i + 2]!).applyMatrix4(inv)
      x0 = Math.min(x0, p3.x)
      x1 = Math.max(x1, p3.x)
      y0 = Math.min(y0, p3.y)
      y1 = Math.max(y1, p3.y)
    }
    const pad = 1.05
    const vh = Math.max((y1 - y0) * pad, ((x1 - x0) * pad) / aspect)
    // The view-space centre back to a world point on the plane through the origin.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
    const c = right.multiplyScalar((x0 + x1) / 2).addScaledVector(up, (y0 + y1) / 2)
    benchFraming.target[0] = c.x
    benchFraming.target[1] = c.y
    benchFraming.target[2] = c.z
    benchFraming.viewH = vh
    benchFraming.az = view.az
    benchFraming.el = view.el
  }

  function fit(width: number, height: number) {
    w = width
    h = height
    fitBench(width, height)
    setViewer(benchFraming.az, benchFraming.el)
    applyFraming(framingAt(sCur, benchFraming, fr))
  }

  fit(w, h)
  draw(1)
  // Dev only: lets the lab's screenshot scripts drive the shots and read the sim.
  if (import.meta.dev && typeof window !== 'undefined') {
    const list = ((window as any).__benches ??= []) as unknown[]
    list.push({ sim, scrollShot, follower, scene, camera, person, size: () => [w, h] })
  }

  return {
    scene,
    camera,
    step(dt) {
      if (ctx.posterMode) return
      sim.step(dt)
      let t = prev
      prev = cur
      cur = sim.elec.snapshot(t)
      t = bprev
      bprev = bcur
      bcur = sim.snapshot(t)

      sPrev = sCur
      const arrived = follower.step(dt, scrollShot.progress)
      sCur = follower.s
      if (arrived > 0) {
        const act = ARRIVAL[SHOTS[arrived]!.id]
        if (act) status[act]()
      }
      // The detail shot's part stays lit while the camera is on (or nearly on) it.
      const near = follower.nearest
      const hl = Math.abs(follower.s - near) < 0.35 ? SHOT_HIGHLIGHT[SHOTS[near]!.id] ?? null : null
      if (hl !== held) {
        held = hl
        relight()
      }

      driver.drive(sim, viewer)
      person.step(dt)

      if (labelHold > 0) {
        labelHold -= dt
        if (labelHold <= 0) highlight(null)
      }
    },
    frame(alpha) {
      const a = ctx.posterMode ? 1 : alpha
      draw(a)
      person.frame(a)
      if (ctx.posterMode) return
      const ev = sim.elec.takeEvents()
      if (ev & EV.CHIME) bootChime()
      if (ev & EV.BEEP) beep()
      if (ev & EV.CLICK_DOWN) click(true)
      if (ev & EV.CLICK_UP) click(false)
      const be = sim.takeEvents()
      if (be & BEV.CUT) sound.cut()
      if (be & BEV.METER) sound.meterBeep()
      if (be & BEV.IRON_OUT) sound.tick(true)
      if (be & BEV.IRON_HOME) sound.tick(false)
      if (be & BEV.LAMP) click(sim.lampOn)
      servoWhirr(Math.abs(sim.elec.vel))
      sound.update(sim.session.contact ? 1 : 0, sim.drillSpin, sim.sawSpin)
    },
    resize(width, height) {
      fit(width, height)
    },
    pointer(p) {
      if (ctx.posterMode) return
      if (p.kind === 'leave') {
        // The servo keeps its last target. (A touch tap is followed by a
        // leave in the same frame, so clearing here would cancel the tap.)
        if (!labelHold) highlight(null)
        return
      }
      const t = pick(p)
      p3.copy(shaftPt).project(camera)
      const servoX = p3.x
      if (p.kind === 'move') {
        if (ctx.coarse) return
        highlight(t)
        sim.elec.setTrack(trackAngle(p.ndc.x, servoX))
        return
      }
      if (ctx.coarse && t) {
        highlight(null)
        highlight(t)
        labelHold = TAP_LABEL
      }
      if (t === 'maker') status.wave()
      else if (t && BOOT_TARGETS.has(t)) status.boot()
      else if (t === 'button') status.button()
      else if (t === 'servo') status.servo()
      else if (t === 'buzzer') status.chirp()
      else if (t && CHASE_TARGETS.has(t)) status.chase()
      else if (t && SOLDER_TARGETS.has(t)) status.solder()
      else if (t === 'drillPress') status.drill()
      else if (t === 'mitreSaw') status.saw()
      else if (t === 'multimeter') status.measure()
      else if (t === 'lamp') status.lamp()
      else sim.elec.setTrack(trackAngle(p.ndc.x, servoX))
    },
    setPaused(paused) {
      person.setPaused(paused)
      if (!paused) return
      sim.clearInputs()
      sim.takeEvents()
      sim.elec.takeEvents()
      labelHold = 0
      highlight(null)
      stopSounds()
      sound.stop()
    },
    action(name) {
      if (ctx.posterMode) return null
      if (name in status) return status[name as ActionName]()
      return null
    },
    dispose() {
      stopSounds()
      sound.stop()
      highlight(null)
      held = null
      relight()
      // People share geometry across the page: never through disposeGeometries.
      scene.remove(person.root)
      person.dispose()
      glow.dispose()
      chirp.dispose()
      holes.dispose()
      fillets.dispose()
      particles.dispose()
      lamp.dispose()
      terminal.dispose()
      display.dispose()
      cable.dispose()
      wire.dispose()
      disposeGeometries(scene)
    },
  }
}
