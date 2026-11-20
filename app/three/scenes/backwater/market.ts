// The fish market: a covered stall and an open fish table on the bank
// south-east of the people -- posts, a tarp sloped to the back, a counter, a
// rail of hung fish, tubs and a basket of the catch, and a hanging scale. A
// seller works the stall, a customer haggles with him over the hanging fish
// (a loop of beats: look, point, offer, second try, settle), and a browser
// picks over the table. Everything static except the hanging fish swaying in
// the breeze and the people, stepped at DT like the rest of the scene.
// Placement is checked by test-backwater.ts: the pocket left of the people
// where no shot's sightline to a person ever crosses a stall.
import * as THREE from 'three'
import { DT } from '../../core/clock'
import {
  Assembly, beamGeometry, blockGeometry, contactShadow, pinGeometry,
  type Materials,
} from '../../core/kit'
import { rng } from '../../core/rng'
import { createPerson, type HandTarget, type Person, type Variant } from '../../people/person'
import { FISH_INK, buildFishGeometry } from './fish'
import {
  BANK, COUNTER, MARKET_BROWSER, MARKET_BUYER, MARKET_SELLER, RAIL_IN, RAIL_Y, STALLS,
} from './layout'

const Y = BANK.top

// ── Stalls ────────────────────────────────────────────────────────────────

/** A beam between two points (the rafters under the sloped tarp). */
const beamBetween = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number) => {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az)
  const len = dir.length()
  const g = beamGeometry(r, len + r * 4)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize()))
  return { g, pos: [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2] as [number, number, number] }
}

/** Hung fish: scale, and the string length below the rail. */
const HANG_S = 0.55
const HANG_STR = 0.09

/** A hung fish: pivot at the hang point, yawed for variety, swayed in frame(). */
interface Hung { pivot: THREE.Group, phase: number }

export interface MarketParts {
  props: THREE.Group
  /** The hang points on each stall's rail, world space -- what the haggle is over. */
  hangs: THREE.Vector3[][]
  hung: Hung[]
}

function buildMarket(m: Materials, fishGeo: THREE.BufferGeometry, fishMat: THREE.Material): MarketParts {
  const props = new THREE.Group()
  const a = new Assembly()
  const R = rng(23)
  const src: THREE.BufferGeometry[] = []   // geometries fed to the Assembly: ours to dispose
  const hung: Hung[] = []
  const hangs: THREE.Vector3[][] = [[], []]
  // Displayed fish (tubs, basket): their ink merged into one geometry.
  const inkPos: number[] = []
  const pushInk = (mat4: THREE.Matrix4) => {
    for (const [ax, ay, az, bx, by, bz] of FISH_INK) {
      inkPos.push(...new THREE.Vector3(ax, ay, az).applyMatrix4(mat4).toArray())
      inkPos.push(...new THREE.Vector3(bx, by, bz).applyMatrix4(mat4).toArray())
    }
  }
  const lay = (x: number, y: number, z: number, yaw: number, s: number) => {
    // A fish flat on its side (rolled about x), head along a seeded yaw (about world y).
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, yaw, 0, 'YXZ'))
    const mat = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s))
    const fish = new THREE.Mesh(fishGeo, fishMat)
    mat.decompose(fish.position, fish.quaternion, fish.scale)
    pushInk(mat)
    props.add(fish)
  }

  // The pivot-local ink for a hung fish (head down) plus its string.
  const hangInk = (() => {
    const y0 = -HANG_STR - 0.32 * HANG_S
    const pos: number[] = []
    for (const [ax, ay, az, bx, by, bz] of FISH_INK) {
      pos.push(ay * HANG_S, -ax * HANG_S + y0, az * HANG_S)
      pos.push(by * HANG_S, -bx * HANG_S + y0, bz * HANG_S)
    }
    pos.push(0, 0, 0, 0, -HANG_STR, 0)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    return g
  })()

  const tubWall = new THREE.CylinderGeometry(0.19, 0.16, 0.11, 12, 1, true)
  const tubFloor = new THREE.CircleGeometry(0.175, 12).rotateX(-Math.PI / 2)
  src.push(tubWall, tubFloor)

  STALLS.forEach((st, si) => {
    const { x: cx, z: cz, w, d, postF, postB, kind } = st
    const add = (geo: THREE.BufferGeometry, mat: Parameters<Assembly['add']>[1], pos: [number, number, number], rot?: [number, number, number]) => {
      src.push(geo)
      a.add(geo, mat, { pos, rot })
    }
    if (kind === 'table') {
      // The open fish table: four legs, a plank top, the catch laid out on it.
      for (const dx of [-d / 2 + 0.08, d / 2 - 0.08]) for (const dz of [-w / 2 + 0.08, w / 2 - 0.08]) {
        add(blockGeometry(0.07, 0.62, 0.07), 'woodDark', [cx + dx, Y + 0.31, cz + dz])
      }
      add(blockGeometry(d, 0.05, w), 'wood', [cx, Y + 0.66, cz])
      for (let k = 0; k < 6; k++) {
        const fx = cx + (R.next() - 0.5) * (d - 0.45), fz = cz + (R.next() - 0.5) * (w - 0.45)
        lay(fx, Y + 0.74, fz, R.next() * Math.PI * 2, 0.48 + R.next() * 0.1)
        hangs[si]!.push(new THREE.Vector3(fx, Y + 0.78, fz))
      }
      const shadow = contactShadow(m, w * 0.6)
      shadow.position.set(cx, Y + 0.001, cz)
      props.add(shadow)
      return
    }
    // The covered stall, its open front facing +x (toward the bank camera).
    const post = (dx: number, dz: number, h: number) => add(blockGeometry(0.11, h + 0.03, 0.11), 'woodDark', [cx + dx, Y + h / 2 - 0.03, cz + dz])
    post(d / 2, -w / 2, postF); post(d / 2, w / 2, postF)
    post(-d / 2, -w / 2, postB); post(-d / 2, w / 2, postB)
    // Rafters and the tarp, sloped from the taller front posts to the back.
    for (const sz of [-1, 1]) {
      const b = beamBetween(
        cx + d / 2 - 0.06, Y + postF - 0.05, cz + sz * (w / 2 - 0.06),
        cx - d / 2 + 0.06, Y + postB - 0.05, cz + sz * (w / 2 - 0.06), 0.035,
      )
      add(b.g, 'woodDark', b.pos)
    }
    const tilt = Math.atan((postF - postB) / d)
    add(blockGeometry(d + 0.4, 0.045, w + 0.5), 'mid', [cx, Y + (postF + postB) / 2 + 0.05, cz], [0, 0, tilt])
    // The counter at the open front: a plank top, a boarded front, two legs.
    const cTop = Y + COUNTER.y
    const cX = cx + d / 2 - COUNTER.in
    add(blockGeometry(COUNTER.d, 0.045, w - 0.3), 'wood', [cX, cTop, cz])
    add(blockGeometry(0.04, 0.72, w - 0.3), 'woodDark', [cX + COUNTER.d / 2 - 0.025, cTop - 0.045 - 0.36, cz])
    for (const sz of [-1, 1]) add(blockGeometry(0.36, COUNTER.y - 0.04, 0.055), 'woodDark', [cX, Y + (COUNTER.y - 0.04) / 2, cz + sz * (w / 2 - 0.24)])
    // The rail the fish hang from, just in from the front posts.
    const railX = cx + d / 2 - RAIL_IN
    add(pinGeometry(0.028, w - 0.18), 'woodDark', [railX, Y + RAIL_Y, cz])

    // Hung fish: shared geometry, one pivot each so they can sway.
    const n = 6
    for (let i = 0; i < n; i++) {
      const hz = cz - w / 2 + 0.32 + (w - 0.64) * (i / (n - 1)) + (R.next() - 0.5) * 0.06
      const pivot = new THREE.Group()
      pivot.position.set(railX, Y + RAIL_Y - 0.01, hz)
      pivot.rotation.y = (R.next() - 0.5) * 0.9
      const fish = new THREE.Mesh(fishGeo, fishMat)
      fish.scale.setScalar(HANG_S)
      fish.rotation.z = -Math.PI / 2
      fish.position.y = -HANG_STR - 0.32 * HANG_S
      pivot.add(fish, new THREE.LineSegments(hangInk, m.line))
      props.add(pivot)
      hung.push({ pivot, phase: R.next() * Math.PI * 2 })
      hangs[si]!.push(new THREE.Vector3(railX, Y + RAIL_Y - 0.42, hz))
    }

    // Tubs of fish on the counter, like the photo's bowls.
    for (const dz of [-0.52, 0.5]) {
      const tx = cX + (R.next() - 0.5) * 0.08, tz = cz + dz
      a.add(tubWall, 'water', { pos: [tx, cTop + 0.075, tz] })
      a.add(tubFloor, 'mid', { pos: [tx, cTop + 0.028, tz] })
      for (let k = 0; k < 2; k++) lay(tx + (R.next() - 0.5) * 0.14, cTop + 0.115, tz + (R.next() - 0.5) * 0.1, R.next() * Math.PI * 2, 0.42 + R.next() * 0.08)
    }
    // A crate by the back post and a shadow under it all.
    add(blockGeometry(0.36, 0.34, 0.5), 'wood', [cx - d / 2 - 0.32, Y + 0.17, cz - 0.1])
    const shadow = contactShadow(m, w * 0.72)
    shadow.position.set(cx, Y + 0.001, cz)
    props.add(shadow)
  })

  // A basket of fish beside stall 0's south side (the same weave as the fishers' basket).
  const bs = STALLS[0]!
  const bx = bs.x - 0.2, bz = bs.z - bs.w / 2 - 0.45
  const basketWall = new THREE.CylinderGeometry(0.24, 0.17, 0.28, 14, 1, true)
  const basketInner = new THREE.CylinderGeometry(0.21, 0.15, 0.28, 14, 1, true)
  basketInner.scale(-1, 1, 1)
  const basketFloor = new THREE.CircleGeometry(0.15, 14).rotateX(-Math.PI / 2)
  const basketRim = new THREE.TorusGeometry(0.235, 0.02, 5, 18).rotateX(Math.PI / 2)
  a.add(basketWall, 'wood', { pos: [bx, Y + 0.14, bz] })
  a.add(basketInner, 'woodDark', { pos: [bx, Y + 0.14, bz] })
  a.add(basketFloor, 'dark', { pos: [bx, Y + 0.017, bz] })
  a.add(basketRim, 'woodDark', { pos: [bx, Y + 0.28, bz] })
  src.push(basketWall, basketInner, basketFloor, basketRim)
  for (let k = 0; k < 3; k++) lay(bx + (R.next() - 0.5) * 0.2, Y + 0.28, bz + (R.next() - 0.5) * 0.16, R.next() * Math.PI * 2, 0.5 + R.next() * 0.1)

  // A hanging spring scale off the stall rail's near end: post, dial, strings, pan.
  const sx = bs.x + bs.d / 2 - RAIL_IN, sz = bs.z - bs.w / 2 + 0.35
  const scalePost = pinGeometry(0.012, 0.24).rotateX(Math.PI / 2)
  const panGeo = new THREE.CylinderGeometry(0.11, 0.09, 0.035, 12)
  a.add(scalePost, 'woodDark', { pos: [sx, Y + RAIL_Y - 0.12, sz] })
  const panY = Y + RAIL_Y - 0.62
  a.add(panGeo, 'metal', { pos: [sx, panY, sz] })
  src.push(scalePost, panGeo)
  const dialGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.022, 14).rotateX(Math.PI / 2)
  const dial = new THREE.Mesh(dialGeo, m.face.light)
  dial.position.set(sx, Y + RAIL_Y - 0.3, sz)
  props.add(dial)
  for (const [ex, ez] of [[0.09, 0], [-0.045, 0.078], [-0.045, -0.078]] as [number, number][]) {
    inkPos.push(sx + ex, panY + 0.03, sz + ez, sx, panY + 0.3, sz)
  }

  props.add(a.build(m))
  src.forEach(g => g.dispose())
  // All the displayed fish's ink in one draw.
  const inkGeo = new THREE.BufferGeometry()
  inkGeo.setAttribute('position', new THREE.Float32BufferAttribute(inkPos, 3))
  const ink = new THREE.LineSegments(inkGeo, m.line)
  ink.frustumCulled = false
  props.add(ink)
  return { props, hangs, hung }
}

/** The hanging fish sway a little in the same breeze that sways the palms. */
const SWAY_A = 0.05
const SWAY_W = 0.9

// ── The people and the haggle ─────────────────────────────────────────────

interface Spot { x: number, z: number, variant: Variant, seed: number }
const SPOTS: Spot[] = [
  { ...MARKET_SELLER, variant: 'mundu', seed: 41 },
  { ...MARKET_BUYER, variant: 'kurta', seed: 43 },
  { ...MARKET_BROWSER, variant: 'headscarf', seed: 47 },
]
/** What each one faces: the buyer, the seller, the fish table. */
const FACES: [number, number][] = [
  [MARKET_BUYER.x, MARKET_BUYER.z],
  [MARKET_SELLER.x, MARKET_SELLER.z],
  [STALLS[1]!.x, STALLS[1]!.z],
]

// The haggle's beats: browse the fish, point one out, the seller counters with
// an open palm, the customer tries another, then settle -- and round again
// over a different fish.
const BEAT = { browse: 3.4, point: 1.7, ask: 2.5, again: 1.9, settle: 2.8 }
type Beat = keyof typeof BEAT
const BEATS: Beat[] = ['browse', 'point', 'ask', 'again', 'settle']

export interface Market {
  root: THREE.Group
  people: Person[]
  step(dt: number): void
  frame(alpha: number): void
  dispose(): void
}

export async function createMarket(ctx: { materials: Materials, posterMode?: boolean }, yieldTask?: () => Promise<void>, fishGeo?: THREE.BufferGeometry): Promise<Market> {
  const m = ctx.materials
  const root = new THREE.Group()
  const fishMat = m.face.light.clone()
  fishMat.color.set('#ffffff')
  fishMat.vertexColors = true
  fishMat.side = THREE.DoubleSide
  const parts = buildMarket(m, fishGeo ?? buildFishGeometry(), fishMat)
  root.add(parts.props)
  await yieldTask?.()

  // People stand in a bank-space group like the rest of the bank crew, so the
  // world targets they look at and reach for only drop the bank's height.
  const bankG = new THREE.Group()
  bankG.position.y = Y
  root.add(bankG)
  const poster = !!ctx.posterMode
  const people = SPOTS.map((s, i) => {
    const p = createPerson(ctx, { seed: s.seed, variant: s.variant, posterMode: poster })
    const f = FACES[i]!
    p.placeAt(s.x, s.z, Math.atan2(f[0] - s.x, f[1] - s.z))
    bankG.add(p.root)
    return p
  })
  const [seller, buyer, browser] = people as [Person, Person, Person]
  await yieldTask?.()

  // Look targets in bank space (the group sits at BANK.top).
  const sellerHead = new THREE.Vector3(MARKET_SELLER.x, 1.52, MARKET_SELLER.z)
  const buyerHead = new THREE.Vector3(MARKET_BUYER.x, 1.52, MARKET_BUYER.z)
  const hangs = parts.hangs.map(row => row.map(v => new THREE.Vector3(v.x, v.y - Y, v.z)))
  const tableTop = new THREE.Vector3(STALLS[1]!.x, 0.72, STALLS[1]!.z)
  // The seller's counter-offer: an open palm held out over the counter.
  const offer: HandTarget = {
    position: new THREE.Vector3(MARKET_SELLER.x + 0.55, 1.0, MARKET_SELLER.z + 0.05),
    elbow: new THREE.Vector3(0.5, -1, 0.4).normalize(),
    kind: 'flat',
  }

  const R = rng(53)
  let beat: Beat = 'browse'
  let beatT = 0
  let fishI = 0
  let time = 0
  function enter(b: Beat) {
    beat = b
    beatT = 0
    switch (b) {
      case 'browse': {
        fishI = Math.floor(R.next() * hangs[0]!.length)
        buyer.play('idle')
        buyer.setLean(0)
        buyer.lookAt(hangs[0]![fishI]!, { priority: 'target' })
        seller.lookAt(buyerHead, { priority: 'target' })
        break
      }
      case 'point': {
        buyer.play('point', { target: hangs[0]![fishI]!, hand: fishI % 2 ? 'left' : 'right' })
        break
      }
      case 'ask': {
        buyer.play('idle')
        buyer.lookAt(sellerHead, { priority: 'target' })
        seller.setHandTarget('right', offer)
        break
      }
      case 'again': {
        let j = Math.floor(R.next() * hangs[0]!.length)
        if (j === fishI) j = (j + 1) % hangs[0]!.length
        fishI = j
        buyer.play('point', { target: hangs[0]![j]!, hand: j % 2 ? 'left' : 'right' })
        seller.lookAt(hangs[0]![j]!, { priority: 'target' })
        break
      }
      case 'settle': {
        seller.setHandTarget('right', null)
        seller.lookAt(buyerHead, { priority: 'target' })
        buyer.play('idle')
        // A coin toss of a deal: a nod toward the seller, or a look away.
        if (R.next() < 0.5) {
          buyer.lookAt(sellerHead, { priority: 'target' })
          buyer.setLean(0.09)
        }
        else {
          buyer.lookAt(hangs[0]![(fishI + 2) % hangs[0]!.length]!, { priority: 'target' })
          buyer.setLean(-0.07)
        }
        break
      }
    }
  }

  // The browser's own slower loop at stall 1: watch, point one out, rest.
  const RB = rng(59)
  const B_BEAT = { look: 2.6, point: 1.8, rest: 5.5 }
  let bBeat: 'look' | 'point' | 'rest' = 'look'
  let bT = 0
  let bFish = 0
  function enterB(b: 'look' | 'point' | 'rest') {
    bBeat = b
    bT = 0
    if (b === 'look') {
      bFish = Math.floor(RB.next() * hangs[1]!.length)
      browser.play('watch')
      browser.lookAt(hangs[1]![bFish]!, { priority: 'target' })
    }
    else if (b === 'point') browser.play('point', { target: hangs[1]![bFish]!, hand: bFish % 2 ? 'left' : 'right' })
    else {
      browser.play('watch')
      browser.lookAt(tableTop, { priority: 'target' })
    }
  }

  enter('browse')
  enterB('look')
  const inst: Market = {
    root,
    people,
    step(dt) {
      time += dt
      beatT += dt
      if (beatT >= BEAT[beat]) enter(BEATS[(BEATS.indexOf(beat) + 1) % BEATS.length]!)
      bT += dt
      if (bT >= B_BEAT[bBeat]) enterB(bBeat === 'look' ? 'point' : bBeat === 'point' ? 'rest' : 'look')
      for (const p of people) p.step(dt)
    },
    frame(a) {
      for (const p of people) p.frame(a)
      for (const h of parts.hung) h.pivot.rotation.x = SWAY_A * Math.sin(SWAY_W * time + h.phase)
    },
    dispose() {
      for (const p of people) p.dispose()
      fishMat.dispose()
    },
  }
  // A few settle steps so the first frame (and the poster) has live poses.
  for (let i = 0; i < 30; i++) inst.step(DT)
  return inst
}
