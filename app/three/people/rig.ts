import type { Dims } from './body'
import { B, BONE_COUNT, PARENT, clavicleRoot, restOffsets } from './motion'

/**
 * Skin weights. Most of a person is still rigid (weight 1 on one bone), but
 * the surface near a joint is shared between the two bones that meet there,
 * so a shoulder, an elbow, a knee or the waist bends as one continuous
 * surface instead of two rigid tubes pivoting through each other. Long
 * garments (mundu, skirt, kurta tail, apron) are one surface weighted between
 * the hips and both legs, so the cloth follows the stance -- over the lap when
 * seated, hanging from the knees -- with no tiers and no seam.
 *
 * Weights are a function of a vertex's position in the bind pose: every
 * bone's rest rotation is identity, so "above the elbow" is simply local y.
 * It is all still ONE SkinnedMesh per colour role: blending costs nothing at
 * draw time.
 */

export type V3 = [number, number, number]
/** Up to four [bone, weight] pairs. */
export type Influence = [number, number][]

/** Each bone's rest position relative to the person's root (translations only: rest rotations are identity). */
export function restPositions(d: Dims): V3[] {
  const off = restOffsets(d)
  const out: V3[] = []
  for (let i = 0; i < BONE_COUNT; i++) {
    const o = off[i]!
    const p = PARENT[i]!
    const base: V3 = p < 0 ? [0, 0, 0] : out[p]!
    out.push([base[0] + o[0], base[1] + o[1], base[2] + o[2]])
  }
  return out
}

/** A joint's blend zone: half-height r along the bone; `lateral` limits the parent side to a radius round the child's axis. */
interface Joint { child: number, parent: number, r: number, both: boolean, lateral?: number, up?: boolean }

function jointsFor(d: Dims): Joint[] {
  const H = d.H
  return [
    // The spine and the head grow UP from their joints; the limbs hang down from theirs.
    { child: B.spine, parent: B.pelvis, r: 0.035 * H, both: true, up: true },
    // The collar and the top of the shirt follow the neck when the head bows; the shoulders do not.
    { child: B.head, parent: B.spine, r: 0.012 * H, both: true, lateral: 0.05 * H, up: true },
    // The top of the arm is shared with its clavicle (which carries the shoulder up with it).
    { child: B.uaL, parent: B.clL, r: 0.03 * H, both: false },
    { child: B.uaR, parent: B.clR, r: 0.03 * H, both: false },
    { child: B.faL, parent: B.uaL, r: 0.024 * H, both: true },
    { child: B.faR, parent: B.uaR, r: 0.024 * H, both: true },
    { child: B.handL, parent: B.faL, r: 0.01 * H, both: true },
    { child: B.handR, parent: B.faR, r: 0.01 * H, both: true },
    { child: B.fiL, parent: B.handL, r: 0.006 * H, both: true },
    { child: B.fiR, parent: B.handR, r: 0.006 * H, both: true },
    { child: B.thL, parent: B.pelvis, r: 0.035 * H, both: false },
    { child: B.thR, parent: B.pelvis, r: 0.035 * H, both: false },
    { child: B.shL, parent: B.thL, r: 0.03 * H, both: true },
    { child: B.shR, parent: B.thR, r: 0.03 * H, both: true },
  ]
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export class Rig {
  readonly rest: V3[]
  private readonly joints: Joint[]
  private readonly off: V3[]
  constructor(readonly d: Dims) {
    this.rest = restPositions(d)
    this.joints = jointsFor(d)
    this.off = restOffsets(d) as V3[]
  }

  /** Weights of a point given in a bone's own frame (bind pose). */
  joint(bone: number, p: V3): Influence {
    const w = new Map<number, number>([[bone, 1]])
    for (const j of this.joints) {
      const dir = j.up ? -1 : 1
      if (j.child === bone) {
        // On the parent's side of the joint the surface goes with the parent.
        const f = sstep(-j.r, j.r, dir * p[1])
        const own = w.get(bone)!
        w.set(j.parent, (w.get(j.parent) ?? 0) + own * f)
        w.set(bone, own * (1 - f))
      }
      else if (j.both && j.parent === bone) {
        // Below the child's joint the parent's surface goes with the child.
        const o = this.off[j.child]!
        let f = 1 - sstep(-j.r, j.r, dir * (p[1] - o[1]))
        if (j.lateral) f *= 1 - sstep(j.lateral, j.lateral * 1.6, Math.hypot(p[0] - o[0], p[2] - o[2]))
        const own = w.get(bone)!
        w.set(j.child, (w.get(j.child) ?? 0) + own * f)
        w.set(bone, own * (1 - f))
      }
    }
    if (bone === B.spine) {
      // The shoulder (trapezius, deltoid's top, the cloth over them) rides the clavicle,
      // so a shrugged shoulder rises as one surface with the raised arm.
      const H = this.d.H
      const side: 1 | -1 = p[0] >= 0 ? 1 : -1
      const c0 = clavicleRoot(this.d, side)
      const s0: V3 = [side * this.d.shoulderX, this.d.shoulderY, 0]
      const near = 1 - sstep(0.035 * H, 0.085 * H, Math.hypot(p[0] - s0[0], p[1] - s0[1], p[2] - s0[2]))
      const out = sstep(Math.abs(c0[0]) + 0.004 * H, Math.abs(c0[0]) + 0.04 * H, Math.abs(p[0]))
      const f = near * out
      if (f > 1e-4) {
        const own = w.get(B.spine) ?? 0
        w.set(side === 1 ? B.clL : B.clR, (w.get(side === 1 ? B.clL : B.clR) ?? 0) + own * f)
        w.set(B.spine, own * (1 - f))
      }
    }
    return top4(w)
  }

  /**
   * A garment hanging from the hips, point in the pelvis frame: hips above the
   * hip joints, then the thighs (each side by how far it is to that side),
   * then the shins below the knees.
   */
  legs(p: V3): Influence {
    const d = this.d
    const t1 = sstep(0.0, -0.4 * d.L1, p[1])
    const t2 = sstep(-0.82 * d.L1, -1.12 * d.L1, p[1])
    const sL = sstep(-0.9, 0.9, p[0] / d.hipW)
    // Cloth out past the sides of the thighs hangs from the hips rather than riding on
    // them: seated, it falls down beside the lap instead of standing out as a stiff sheet.
    const side = sstep(d.hipW + 0.03 * d.H, d.hipW + 0.075 * d.H, Math.abs(p[0]))
    const w = new Map<number, number>()
    const put = (b: number, x: number) => { if (x > 1e-4) w.set(b, (w.get(b) ?? 0) + x) }
    // The waistband goes with the waist: a seated pelvis rolls back under the torso and a
    // band riding on it would dip into the shirt above it.
    const band = sstep(d.waistY - 0.025 * d.H, d.waistY + 0.005 * d.H, p[1])
    put(B.spine, (1 - t1) * band)
    put(B.pelvis, (1 - t1) * (1 - band) + t1 * (1 - t2) * side)
    put(B.thL, t1 * (1 - t2) * sL * (1 - side))
    put(B.thR, t1 * (1 - t2) * (1 - sL) * (1 - side))
    put(B.shL, t1 * t2 * sL)
    put(B.shR, t1 * t2 * (1 - sL))
    return top4(w)
  }
}

function top4(w: Map<number, number>): Influence {
  const list = [...w.entries()].filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4)
  const s = list.reduce((a, [, x]) => a + x, 0) || 1
  return list.map(([b, x]) => [b, x / s])
}
