import type { Point } from "./geometry";
import type { Bounds } from "./dxf";

/**
 * NURBS curves (C-02): pure functions on `{degree, controlPoints, knots,
 * weights?}`. Evaluation is de Boor's algorithm on the span's basis
 * functions; knot insertion is Boehm's, done in homogeneous coordinates so a
 * rational curve (a true circle arc, say) survives splitting exactly. Fit
 * points become control points by global interpolation (Piegl & Tiller A9.1).
 *
 * Tolerances are world units (mm), as in `intersect.ts`.
 */

export interface NurbsData {
  degree: number;
  controlPoints: Point[];
  /** `controlPoints.length + degree + 1` values, non-decreasing. */
  knots: number[];
  /** One per control point; absent = all 1 (non-rational). */
  weights?: number[];
}

const EPS = 1e-12;

/** A valid curve: degree ≥ 1, enough control points, the right knot count, non-decreasing knots, positive weights, a non-empty domain. */
export function isValidNurbs(s: NurbsData): boolean {
  const n = s.controlPoints.length;
  if (!(s.degree >= 1) || !Number.isInteger(s.degree) || n < s.degree + 1) return false;
  if (s.knots.length !== n + s.degree + 1) return false;
  for (let i = 1; i < s.knots.length; i++) if (!(s.knots[i] >= s.knots[i - 1])) return false;
  if (s.weights && (s.weights.length !== n || s.weights.some((w) => !(w > 0)))) return false;
  const [lo, hi] = nurbsDomain(s);
  return hi > lo;
}

export const nurbsDomain = (s: NurbsData): [number, number] => [s.knots[s.degree], s.knots[s.controlPoints.length]];

export function clampedUniformKnots(count: number, degree: number): number[] {
  const knots: number[] = [];
  const interior = count - degree - 1;
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 1; i <= interior; i++) knots.push(i);
  for (let i = 0; i <= degree; i++) knots.push(interior + 1);
  return knots;
}

/** Whether the curve starts at the first control point and ends at the last (end knots repeated degree + 1 times). */
export function isClamped(s: NurbsData): boolean {
  const { degree: p, knots } = s;
  const m = knots.length - 1;
  for (let i = 1; i <= p; i++) if (knots[i] !== knots[0] || knots[m - i] !== knots[m]) return false;
  return true;
}

function findSpan(s: NurbsData, u: number): number {
  const n = s.controlPoints.length - 1;
  const p = s.degree;
  const k = s.knots;
  if (u >= k[n + 1]) return n;
  if (u <= k[p]) return p;
  let lo = p;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < k[mid] || u >= k[mid + 1]) {
    if (u < k[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** The `p + 1` non-zero basis functions of degree `p` at `u` in `span` (Piegl & Tiller A2.2). */
function basisFuns(knots: number[], span: number, u: number, p: number): number[] {
  const N = new Array<number>(p + 1).fill(0);
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom === 0 ? 0 : N[r] / denom;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

const weightOf = (s: NurbsData, i: number): number => s.weights?.[i] ?? 1;

/** Point and first derivative at `u` (clamped into the domain). */
export function nurbsEval(s: NurbsData, uIn: number): { point: Point; tangent: Point } {
  const p = s.degree;
  const [lo, hi] = nurbsDomain(s);
  const u = Math.min(hi, Math.max(lo, uIn));
  const span = findSpan(s, u);
  const N = basisFuns(s.knots, span, u, p);
  // Derivatives of the degree-p basis from the degree p-1 basis on the same span.
  const M = p >= 1 ? basisFuns(s.knots, span, u, p - 1) : [1];
  let ax = 0;
  let ay = 0;
  let w = 0;
  let dax = 0;
  let day = 0;
  let dw = 0;
  for (let j = 0; j <= p; j++) {
    const i = span - p + j;
    const wi = weightOf(s, i);
    const c = s.controlPoints[i];
    const b = N[j] * wi;
    ax += b * c.x;
    ay += b * c.y;
    w += b;
    // N'_{i,p} = p (N_{i,p-1}/(u_{i+p}-u_i) - N_{i+1,p-1}/(u_{i+p+1}-u_{i+1})); M[j-1] = N_{i,p-1}, M[j] = N_{i+1,p-1}.
    const a = j >= 1 ? M[j - 1] / (s.knots[i + p] - s.knots[i] || Infinity) : 0;
    const d = j <= p - 1 ? M[j] / (s.knots[i + p + 1] - s.knots[i + 1] || Infinity) : 0;
    const dN = p * (a - d);
    dax += dN * wi * c.x;
    day += dN * wi * c.y;
    dw += dN * wi;
  }
  const point = { x: ax / w, y: ay / w };
  return { point, tangent: { x: (dax - dw * point.x) / w, y: (day - dw * point.y) / w } };
}

export const nurbsPointAt = (s: NurbsData, u: number): Point => nurbsEval(s, u).point;

/* ------------------------------ knot insertion ----------------------------- */

function multiplicity(knots: number[], u: number): number {
  let m = 0;
  for (const k of knots) if (k === u) m++;
  return m;
}

/** Inserts `u` once (Boehm), in homogeneous coordinates so weights stay exact. `u` must be strictly inside the domain. */
export function insertKnot(s: NurbsData, u: number): NurbsData {
  const p = s.degree;
  const n = s.controlPoints.length;
  const span = findSpan(s, u);
  const hom = s.controlPoints.map((c, i) => ({ x: c.x * weightOf(s, i), y: c.y * weightOf(s, i), w: weightOf(s, i) }));
  const out: { x: number; y: number; w: number }[] = [];
  for (let i = 0; i <= n; i++) {
    if (i <= span - p) out.push(hom[i]);
    else if (i > span) out.push(hom[i - 1]);
    else {
      const d = s.knots[i + p] - s.knots[i];
      const a = d === 0 ? 0 : (u - s.knots[i]) / d;
      out.push({
        x: a * hom[i].x + (1 - a) * hom[i - 1].x,
        y: a * hom[i].y + (1 - a) * hom[i - 1].y,
        w: a * hom[i].w + (1 - a) * hom[i - 1].w,
      });
    }
  }
  const knots = [...s.knots.slice(0, span + 1), u, ...s.knots.slice(span + 1)];
  const rational = s.weights !== undefined || out.some((h) => Math.abs(h.w - 1) > 1e-12);
  return {
    degree: p,
    controlPoints: out.map((h) => ({ x: h.x / h.w, y: h.y / h.w })),
    knots,
    ...(rational ? { weights: out.map((h) => h.w) } : {}),
  };
}

/**
 * Splits at `u` into two clamped curves that together trace the original
 * exactly. Null when `u` is not strictly inside the domain or the curve is
 * not clamped (an unclamped end has no control point on the curve to split at).
 */
export function splitNurbs(s: NurbsData, u: number): [NurbsData, NurbsData] | null {
  const [lo, hi] = nurbsDomain(s);
  if (!(u > lo + EPS && u < hi - EPS) || !isClamped(s)) return null;
  let c = s;
  for (let m = multiplicity(c.knots, u); m < s.degree; m++) c = insertKnot(c, u);
  const p = s.degree;
  const k = c.knots.lastIndexOf(u);
  const first = c.knots.indexOf(u);
  const split = (cps: Point[], ws: number[] | undefined, knots: number[]): NurbsData => ({
    degree: p,
    controlPoints: cps,
    knots,
    ...(ws ? { weights: ws } : {}),
  });
  const cut = k - p; // control point on the curve at u
  const leftKnots = [...c.knots.slice(0, k + 1)];
  while (leftKnots.length < cut + 1 + p + 1) leftKnots.push(u);
  const left = split(c.controlPoints.slice(0, cut + 1), c.weights?.slice(0, cut + 1), leftKnots);
  const rightKnots = [u, ...c.knots.slice(first)];
  const right = split(c.controlPoints.slice(cut), c.weights?.slice(cut), rightKnots);
  return [left, right];
}

/** Bézier pieces (each `degree + 1` control points) of a clamped curve, or null if it is not clamped. */
export function bezierPieces(s: NurbsData): { points: Point[]; weights?: number[] }[] | null {
  if (!isClamped(s)) return null;
  const [lo, hi] = nurbsDomain(s);
  const interior = [...new Set(s.knots.filter((k) => k > lo + EPS && k < hi - EPS))];
  let c = s;
  for (const u of interior) for (let m = multiplicity(c.knots, u); m < s.degree; m++) c = insertKnot(c, u);
  const p = s.degree;
  const pieces: { points: Point[]; weights?: number[] }[] = [];
  for (let i = 0; i + p < c.controlPoints.length; i += p) {
    pieces.push({
      points: c.controlPoints.slice(i, i + p + 1),
      ...(c.weights ? { weights: c.weights.slice(i, i + p + 1) } : {}),
    });
  }
  return pieces;
}

/* ------------------------------ tessellation ------------------------------- */

const distToChord = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Points along the curve so no chord strays further than `tol` from it (checked at three interior parameters per chord). */
export function tessellateNurbs(s: NurbsData, tol: number): Point[] {
  const [lo, hi] = nurbsDomain(s);
  const breaks = [...new Set(s.knots.filter((k) => k >= lo && k <= hi))];
  const out: Point[] = [nurbsPointAt(s, lo)];
  const rec = (u0: number, p0: Point, u1: number, p1: Point, depth: number): void => {
    let ok = depth >= 16;
    let mid: { u: number; p: Point } | null = null;
    if (!ok) {
      ok = true;
      for (const f of [0.5, 0.25, 0.75]) {
        const u = u0 + (u1 - u0) * f;
        const p = nurbsPointAt(s, u);
        if (f === 0.5) mid = { u, p };
        if (distToChord(p, p0, p1) > tol) ok = false;
      }
    }
    if (ok || !mid) {
      out.push(p1);
      return;
    }
    rec(u0, p0, mid.u, mid.p, depth + 1);
    rec(mid.u, mid.p, u1, p1, depth + 1);
  };
  for (let b = 0; b + 1 < breaks.length; b++) {
    // A few seeds per span so a wavy span is not judged by its end points alone.
    const seeds = 4;
    let prevU = breaks[b];
    let prevP = out[out.length - 1];
    for (let i = 1; i <= seeds; i++) {
      const u = breaks[b] + ((breaks[b + 1] - breaks[b]) * i) / seeds;
      const pt = i === seeds ? nurbsPointAt(s, breaks[b + 1]) : nurbsPointAt(s, u);
      rec(prevU, prevP, u, pt, 0);
      prevU = u;
      prevP = pt;
    }
  }
  return out;
}

export function nurbsBounds(s: NurbsData): Bounds {
  const hull = s.controlPoints;
  let size = 0;
  for (const c of hull) size = Math.max(size, Math.abs(c.x), Math.abs(c.y));
  const pts = tessellateNurbs(s, Math.max(1e-7, size * 1e-6));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/* ------------------------------ closest point ------------------------------ */

export function closestNurbsParam(s: NurbsData, q: Point): number {
  const [lo, hi] = nurbsDomain(s);
  const N = Math.max(32, s.controlPoints.length * 8);
  const d2 = (u: number): number => {
    const p = nurbsPointAt(s, u);
    return (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
  };
  let best = lo;
  let bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const u = lo + ((hi - lo) * i) / N;
    const d = d2(u);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  // Golden-section inside the bracket around the best sample.
  let a = Math.max(lo, best - (hi - lo) / N);
  let b = Math.min(hi, best + (hi - lo) / N);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  for (let i = 0; i < 60; i++) {
    if (d2(c) < d2(d)) b = d;
    else a = c;
    c = b - g * (b - a);
    d = a + g * (b - a);
  }
  const u = (a + b) / 2;
  return d2(u) <= bestD ? u : best;
}

export function distToNurbs(s: NurbsData, q: Point): number {
  const p = nurbsPointAt(s, closestNurbsParam(s, q));
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/* ------------------------- fit points → control points --------------------- */

function solveDense(A: number[][], B: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...B[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k < M[r].length; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row.slice(n).map((v) => v / row[i]));
}

/**
 * The clamped cubic (lower degree for few points) B-spline passing through
 * `points`: chord-length parameters, averaged knots, free end conditions.
 * Consecutive duplicates are dropped. Null for fewer than two distinct points
 * or a singular system.
 */
export function interpolateNurbs(points: Point[], maxDegree = 3): NurbsData | null {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 1e-9);
  const n = pts.length;
  if (n < 2) return null;
  const p = Math.min(maxDegree, n - 1);
  const chord = [0];
  for (let i = 1; i < n; i++) chord.push(chord[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = chord[n - 1];
  const t = chord.map((c) => c / total);
  const knots: number[] = new Array(p + 1).fill(0);
  for (let j = 1; j <= n - p - 1; j++) {
    let sum = 0;
    for (let i = j; i < j + p; i++) sum += t[i];
    knots.push(sum / p);
  }
  for (let i = 0; i <= p; i++) knots.push(1);
  const base: NurbsData = { degree: p, controlPoints: pts, knots };
  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n).fill(0);
    const span = findSpan(base, t[i]);
    const N = basisFuns(knots, span, Math.min(t[i], 1), p);
    for (let j = 0; j <= p; j++) row[span - p + j] = N[j];
    A.push(row);
  }
  const sol = solveDense(
    A,
    pts.map((q) => [q.x, q.y]),
  );
  if (!sol) return null;
  return { degree: p, controlPoints: sol.map(([x, y]) => ({ x, y })), knots };
}

/** A circle-arc-free convenience: the unit-test circle as a rational quadratic NURBS (four 90° arcs). */
export function circleNurbs(center: Point, r: number): NurbsData {
  const w = Math.SQRT1_2;
  const c = center;
  const pts = [
    { x: c.x + r, y: c.y },
    { x: c.x + r, y: c.y + r },
    { x: c.x, y: c.y + r },
    { x: c.x - r, y: c.y + r },
    { x: c.x - r, y: c.y },
    { x: c.x - r, y: c.y - r },
    { x: c.x, y: c.y - r },
    { x: c.x + r, y: c.y - r },
    { x: c.x + r, y: c.y },
  ];
  return {
    degree: 2,
    controlPoints: pts,
    knots: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
    weights: [1, w, 1, w, 1, w, 1, w, 1],
  };
}
