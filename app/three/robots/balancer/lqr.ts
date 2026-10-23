/**
 * Discrete LQR design for the balancer: exact zero-order-hold discretisation
 * of the linearised model and the discrete Riccati recursion. Pure maths, no
 * allocation worries (it runs offline -- in the tests and when the gain
 * table in dynamics.ts is regenerated -- never per frame).
 *
 * ZOH: expm([[A, B], [0, 0]] dt) by scaling and squaring with a degree-6
 * Pade approximant. LQR: P iterated until max|dP| < tol; u = -K s.
 * scripts/tune-balance.ts runs this design for the gain table and checks
 * it against an independent derivation.
 */
export type Mat = number[][]

const zeros = (n: number, m = n): Mat => Array.from({ length: n }, () => new Array(m).fill(0))
const eye = (n: number): Mat => zeros(n).map((row, i) => row.map((_, j) => (i === j ? 1 : 0)))
const mul = (a: Mat, b: Mat): Mat => a.map(row => b[0]!.map((_, j) => row.reduce((s, v, k) => s + v * b[k]![j]!, 0)))
const add = (a: Mat, b: Mat, k = 1): Mat => a.map((row, i) => row.map((v, j) => v + k * b[i]![j]!))
const scale = (a: Mat, k: number): Mat => a.map(row => row.map(v => v * k))
const T = (a: Mat): Mat => a[0]!.map((_, j) => a.map(row => row[j]!))
const norm1 = (a: Mat) => Math.max(...a[0]!.map((_, j) => a.reduce((s, row) => s + Math.abs(row[j]!), 0)))

function solve(A: Mat, B: Mat): Mat {
  const n = A.length
  const a = A.map(r => r.slice())
  const b = B.map(r => r.slice())
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!)) piv = r
    ;[a[c], a[piv]] = [a[piv]!, a[c]!]
    ;[b[c], b[piv]] = [b[piv]!, b[c]!]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = a[r]![c]! / a[c]![c]!
      for (let k = c; k < n; k++) a[r]![k]! -= f * a[c]![k]!
      for (let k = 0; k < b[0]!.length; k++) b[r]![k]! -= f * b[c]![k]!
    }
  }
  return b.map((row, i) => row.map(v => v / a[i]![i]!))
}

export function expm(A: Mat): Mat {
  const n = A.length
  const s = Math.max(0, Math.ceil(Math.log2(norm1(A) / 0.5)))
  const As = scale(A, 1 / 2 ** s)
  const q = 6
  let c = 1
  let N = eye(n)
  let D = eye(n)
  let X = eye(n)
  for (let k = 1; k <= q; k++) {
    c = c * (q - k + 1) / (k * (2 * q - k + 1))
    X = mul(As, X)
    N = add(N, X, c)
    D = add(D, X, (k % 2 ? -1 : 1) * c)
  }
  let E = solve(D, N)
  for (let i = 0; i < s; i++) E = mul(E, E)
  return E
}

/** Exact ZOH discretisation of sdot = A s + B u. */
export function discretize(A: Mat, B: number[], dt: number) {
  const aug = zeros(5)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) aug[i]![j] = A[i]![j]! * dt
    aug[i]![4] = B[i]! * dt
  }
  const E = expm(aug)
  return { Ad: E.slice(0, 4).map(r => r.slice(0, 4)), Bd: E.slice(0, 4).map(r => [r[4]!]) }
}

/** Discrete LQR gain row K (u = -K s). */
export function dlqr(Ad: Mat, Bd: Mat, q: readonly number[], R: number, tol = 1e-11) {
  const Q = zeros(4)
  q.forEach((v, i) => (Q[i]![i] = v))
  let P = Q.map(r => r.slice())
  const At = T(Ad)
  const Bt = T(Bd)
  let iters = 0
  for (; iters < 2e6; iters++) {
    const PA = mul(P, Ad)
    const PB = mul(P, Bd)
    const S = R + mul(Bt, PB)[0]![0]!
    const next = add(add(Q, mul(At, PA)), scale(mul(mul(At, PB), mul(Bt, PA)), 1 / S), -1)
    let d = 0
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) d = Math.max(d, Math.abs(next[i]![j]! - P[i]![j]!))
    P = next
    if (d < tol) break
  }
  const S = R + mul(Bt, mul(P, Bd))[0]![0]!
  const K = mul(Bt, mul(P, Ad))[0]!.map(v => v / S)
  return { K, iters }
}
