import type { DimensionEntity } from "../entities";
import type { Point } from "../geometry";
import { arrowShape } from "./arrows";
import { formatDimText } from "./format";
import type { DimStyle } from "./style";

/**
 * Pure dimension layout (D-02a): the resolved measured geometry plus a style
 * in, drawable parts out — stroked polylines, filled polygons (arrow heads)
 * and the text. Canvas, SVG, PDF and DXF all draw from this one result, so
 * the three renderings cannot drift apart (CLAUDE.md "one drawing, three
 * renderings"). Nothing here reads a document; `resolve.ts` does that.
 */

export interface DimText {
  /** Centre of the text box. */
  at: Point;
  text: string;
  height: number;
  /** Radians CCW; always upright (within ±90°). */
  rotation: number;
  /** Estimated advance width. */
  width: number;
}

export interface DimLayout {
  lines: Point[][];
  fills: Point[][];
  text: DimText | null;
  /** Measured value: mm, or radians for angular kinds; NaN if degenerate. */
  measure: number;
}

/** A circle/arc a radial-family dimension measures. */
export interface DimCircle {
  center: Point;
  radius: number;
  /** Arcs only. */
  start?: number;
  end?: number;
  ccw?: boolean;
}

/** The entity's geometry after associative references were followed. */
export interface DimGeometry {
  pts: Point[];
  circle?: DimCircle;
}

const TAU = Math.PI * 2;
const norm = (a: number): number => ((a % TAU) + TAU) % TAU;
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const crs = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
const len = (a: Point): number => Math.hypot(a.x, a.y);
const unit = (a: Point): Point => {
  const l = len(a);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};
const polar = (c: Point, r: number, a: number): Point => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
const estWidth = (text: string, h: number): number => text.length * h * 0.55;

/** Reading direction: keep text upright (angle in (-90°, 90°]). */
export function upright(a: number): number {
  let r = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  if (r > Math.PI / 2 + 1e-9) r -= Math.PI;
  else if (r <= -Math.PI / 2 + 1e-9) r += Math.PI;
  return r;
}

function arcPoints(c: Point, r: number, start: number, sweep: number): Point[] {
  const steps = Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) / (Math.PI / 90))));
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) out.push(polar(c, r, start + (sweep * i) / steps));
  return out;
}

class Builder {
  lines: Point[][] = [];
  fills: Point[][] = [];
  constructor(readonly st: DimStyle, readonly k: number) {}
  line(...pts: Point[]): void {
    if (pts.length >= 2) this.lines.push(pts);
  }
  arrow(tip: Point, dir: Point): void {
    const shape = arrowShape(this.st.arrow, tip, unit(dir), this.st.arrowSize * this.k, this.st.arrowAngle);
    this.lines.push(...shape.lines);
    this.fills.push(...shape.fills);
  }
}

/** Dimension line from A to B (direction u) with arrows, text and — when the text does not fit — outside arrows/text. Shared by linear, aligned and diametric. */
function dimensionLine(b: Builder, A: Point, B: Point, u: Point, label: string, textPos: Point | undefined, lineAngle: number): DimText {
  const st = b.st;
  const k = b.k;
  const h = st.textHeight * k;
  const arrow = st.arrowSize * k;
  const gap = st.gap * k;
  const w = estWidth(label, h);
  const L = len(sub(B, A));
  const horizontal = st.textHorizontal;
  const rho = horizontal ? 0 : upright(lineAngle);
  const up = { x: -Math.sin(rho), y: Math.cos(rho) };
  const onLine = !st.textAbove || horizontal;
  const arrowsInside = L >= 2.2 * arrow;
  // Text along the line needs w + gaps (+ arrows when it sits in the line's gap).
  const along = horizontal ? w * Math.abs(Math.cos(lineAngle)) + h * Math.abs(Math.sin(lineAngle)) : w;
  const textInside = L >= along + 2 * gap + (onLine ? 2 * arrow : 0) && arrowsInside;
  const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  let C: Point;
  if (textPos) C = textPos;
  else if (textInside) C = onLine ? M : add(M, mul(up, gap + h / 2));
  else {
    // Outside, past the far end, along the line.
    C = add(add(B, mul(u, 3 * arrow + gap + along / 2)), onLine ? { x: 0, y: 0 } : mul(up, gap + h / 2));
  }
  // Dimension line (broken around the text when it sits in the line).
  const breakIt = onLine && textInside && !textPos;
  if (breakIt) {
    const half = along / 2 + gap;
    const tc = dot(sub(C, A), u);
    const t1 = Math.max(0, Math.min(L, tc - half));
    const t2 = Math.max(0, Math.min(L, tc + half));
    if (t1 > 1e-9) b.line(A, add(A, mul(u, t1)));
    if (t2 < L - 1e-9) b.line(add(A, mul(u, t2)), B);
  } else b.line(A, B);
  if (arrowsInside) {
    b.arrow(A, u);
    b.arrow(B, mul(u, -1));
  } else {
    b.arrow(A, mul(u, -1));
    b.arrow(B, u);
    b.line(A, add(A, mul(u, -3 * arrow)));
    b.line(B, add(B, mul(u, 3 * arrow)));
  }
  return { at: C, text: label, height: h, rotation: rho, width: w };
}

function linearLike(e: DimensionEntity, st: DimStyle, k: number, geo: DimGeometry, aligned: boolean, label: (v: number) => string): DimLayout {
  const [p1, p2, loc] = geo.pts;
  const theta = aligned ? Math.atan2(p2.y - p1.y, p2.x - p1.x) : (e.angle ?? 0);
  const u = { x: Math.cos(theta), y: Math.sin(theta) };
  const n = { x: -u.y, y: u.x };
  const measure = Math.abs(dot(sub(p2, p1), u));
  const b = new Builder(st, k);
  const foot = (p: Point): Point => add(p, mul(n, dot(sub(loc, p), n)));
  const f1 = foot(p1);
  const f2 = foot(p2);
  for (const [p, f] of [[p1, f1], [p2, f2]] as const) {
    const d = dot(sub(loc, p), n);
    const s = d < 0 ? -1 : 1;
    const start = Math.min(Math.abs(d), st.extOffset * k);
    b.line(add(p, mul(n, s * start)), add(f, mul(n, s * st.extExtend * k)));
  }
  // Orient A→B along +u.
  const [A, B] = dot(sub(f2, f1), u) >= 0 ? [f1, f2] : [f2, f1];
  if (len(sub(B, A)) < 1e-9) return { lines: b.lines, fills: [], text: null, measure };
  const text = dimensionLine(b, A, B, u, label(measure), e.textPos, theta);
  return { lines: b.lines, fills: b.fills, text, measure };
}

/** Pulls a (start, sweep) arc from ray angles a1→a2 choosing the side that contains `through`. */
function sectorThrough(a1: number, a2: number, through: number): { start: number; sweep: number } {
  const s12 = norm(a2 - a1);
  return norm(through - a1) <= s12 ? { start: a1, sweep: s12 } : { start: a2, sweep: TAU - s12 };
}

/** Dimension arc about V at radius R over [start, start+sweep], with ext lines from the given radii along each end ray. */
function arcDimension(b: Builder, V: Point, start: number, sweep: number, R: number, extFrom: [number, number], label: string, textPos: Point | undefined): DimText {
  const st = b.st;
  const k = b.k;
  const h = st.textHeight * k;
  const arrow = st.arrowSize * k;
  const gap = st.gap * k;
  const w = estWidth(label, h);
  const ends = [start, start + sweep];
  ends.forEach((ang, i) => {
    const r0 = extFrom[i];
    const s = R >= r0 ? 1 : -1;
    if (Math.abs(R - r0) > st.extOffset * k) b.line(polar(V, r0 + s * st.extOffset * k, ang), polar(V, R + s * st.extExtend * k, ang));
  });
  const arcLen = R * sweep;
  const inside = arcLen >= 2.2 * arrow;
  const mid = start + sweep / 2;
  const horizontal = st.textHorizontal;
  const tangent = mid + Math.PI / 2;
  const rho = horizontal ? 0 : upright(tangent);
  const up = { x: -Math.sin(rho), y: Math.cos(rho) };
  const onLine = !st.textAbove || horizontal;
  const textFits = arcLen >= w + 2 * gap + (onLine ? 2 * arrow : 0) && inside;
  let C: Point;
  if (textPos) C = textPos;
  else if (textFits) C = onLine ? polar(V, R, mid) : add(polar(V, R, mid), mul(up, gap + h / 2));
  else C = add(polar(V, R + gap + h / 2 + arrow, mid), { x: 0, y: 0 });
  if (onLine && textFits && !textPos) {
    const half = (w / 2 + gap) / R;
    if (sweep / 2 - half > 1e-6) {
      b.line(...arcPoints(V, R, start, sweep / 2 - half));
      b.line(...arcPoints(V, R, mid + half, sweep / 2 - half));
    }
  } else b.line(...arcPoints(V, R, start, sweep));
  const t0 = { x: -Math.sin(start), y: Math.cos(start) };
  const t1 = { x: Math.sin(start + sweep), y: -Math.cos(start + sweep) };
  if (inside) {
    b.arrow(polar(V, R, start), t0);
    b.arrow(polar(V, R, start + sweep), t1);
  } else {
    b.arrow(polar(V, R, start), mul(t0, -1));
    b.arrow(polar(V, R, start + sweep), mul(t1, -1));
  }
  return { at: C, text: label, height: h, rotation: rho, width: w };
}

function angular3(e: DimensionEntity, st: DimStyle, k: number, V: Point, P1: Point, P2: Point, AP: Point, label: (v: number) => string): DimLayout {
  const a1 = Math.atan2(P1.y - V.y, P1.x - V.x);
  const a2 = Math.atan2(P2.y - V.y, P2.x - V.x);
  const aa = Math.atan2(AP.y - V.y, AP.x - V.x);
  const R = Math.max(len(sub(AP, V)), 1e-6);
  const { start, sweep } = sectorThrough(a1, a2, aa);
  const b = new Builder(st, k);
  const r1 = len(sub(P1, V));
  const r2 = len(sub(P2, V));
  // The point nearest the start ray gets the first ext line.
  const startIsA1 = Math.abs(norm(a1 - start)) < 1e-9 || Math.abs(norm(a1 - start) - TAU) < 1e-9;
  const extFrom: [number, number] = startIsA1 ? [r1, r2] : [r2, r1];
  const text = arcDimension(b, V, start, sweep, R, extFrom, label(sweep), e.textPos);
  return { lines: b.lines, fills: b.fills, text, measure: sweep };
}

function lineIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = crs(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const t = crs(sub(c, a), s) / den;
  return add(a, mul(r, t));
}

/** The vertex and the two rays bounding the sector (< 180 degrees) of an angular2l dimension that holds its arc point; null for parallel lines. */
export function angular2Rays(pts: Point[]): { V: Point; d1: Point; d2: Point } | null {
  const [a, b2, c, d, AP] = pts;
  const V = lineIntersection(a, b2, c, d);
  if (!V) return null;
  const u1 = unit(sub(b2, a));
  const u2 = unit(sub(d, c));
  const P = sub(AP, V);
  // Find the ray pair whose sector (< 180°) holds the arc point.
  let d1 = u1;
  let d2 = u2;
  outer: for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      const r1 = mul(u1, s1);
      const r2 = mul(u2, s2);
      const c12 = crs(r1, r2);
      if (Math.abs(c12) < 1e-12) continue;
      if (crs(r1, P) * c12 >= 0 && crs(P, r2) * c12 >= 0) {
        d1 = r1;
        d2 = r2;
        break outer;
      }
    }
  }
  return { V, d1, d2 };
}

function angular2(e: DimensionEntity, st: DimStyle, k: number, pts: Point[], label: (v: number) => string): DimLayout {
  const [a, b2, c, d, AP] = pts;
  const rays = angular2Rays(pts);
  if (!rays) return { lines: [], fills: [], text: null, measure: NaN };
  const { V, d1, d2 } = rays;
  // Ext lines start at the line end furthest along each ray.
  const far = (p: Point, q: Point, dir: Point): Point => {
    const tp = dot(sub(p, V), dir);
    const tq = dot(sub(q, V), dir);
    const best = tp >= tq ? p : q;
    return dot(sub(best, V), dir) > 0 ? best : V;
  };
  const P1 = far(a, b2, d1);
  const P2 = far(c, d, d2);
  return angular3(e, st, k, V, add(V, mul(d1, Math.max(len(sub(P1, V)), 1e-6))), add(V, mul(d2, Math.max(len(sub(P2, V)), 1e-6))), AP, label);
}

function radialText(b: Builder, C: Point, r: number, phi: number, label: string, textPos: Point | undefined, prefixDia: boolean): DimText {
  void prefixDia;
  const st = b.st;
  const k = b.k;
  const h = st.textHeight * k;
  const arrow = st.arrowSize * k;
  const gap = st.gap * k;
  const w = estWidth(label, h);
  const rad = { x: Math.cos(phi), y: Math.sin(phi) };
  const T = add(C, mul(rad, r));
  const fits = !textPos && w + 2 * gap + 2 * arrow < r;
  if (fits) {
    const horizontal = st.textHorizontal;
    const rho = horizontal ? 0 : upright(phi);
    const up = { x: -Math.sin(rho), y: Math.cos(rho) };
    const onLine = !st.textAbove || horizontal;
    const M = add(C, mul(rad, r / 2));
    const Ct = onLine ? M : add(M, mul(up, gap + h / 2));
    if (onLine) {
      const half = (horizontal ? w * Math.abs(rad.x) + h * Math.abs(rad.y) : w) / 2 + gap;
      b.line(C, add(M, mul(rad, -half)));
      b.line(add(M, mul(rad, half)), T);
    } else b.line(C, T);
    b.arrow(T, mul(rad, -1));
    return { at: Ct, text: label, height: h, rotation: rho, width: w };
  }
  // Text outside: arrow on the circle, short leader, horizontal landing.
  b.arrow(T, mul(rad, -1));
  if (textPos) {
    const hx = textPos.x >= T.x ? -1 : 1;
    const Q = { x: textPos.x + hx * (w / 2 + gap), y: textPos.y };
    b.line(T, Q);
    return { at: textPos, text: label, height: h, rotation: 0, width: w };
  }
  const elbow = add(T, mul(rad, 1.5 * arrow));
  const hx = rad.x >= 0 ? 1 : -1;
  b.line(add(T, mul(rad, -arrow)), elbow, add(elbow, { x: hx * (arrow + w + 2 * gap), y: 0 }));
  return { at: { x: elbow.x + hx * (arrow + gap + w / 2), y: elbow.y + gap + h / 2 }, text: label, height: h, rotation: 0, width: w };
}

/** Lays out a dimension. `geo.pts` are the defPoints after associative references were followed. */
export function layoutDimension(e: DimensionEntity, st: DimStyle, geo: DimGeometry): DimLayout {
  const k = e.scale && e.scale > 0 ? e.scale : 1;
  const text = (v: number) => formatDimText(e, st, v);
  const empty: DimLayout = { lines: [], fills: [], text: null, measure: NaN };
  const pts = geo.pts;
  const need = (n: number) => pts.length >= n && pts.slice(0, n).every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  switch (e.kind) {
    case "linear":
    case "aligned":
      return need(3) ? linearLike(e, st, k, geo, e.kind === "aligned", text) : empty;
    case "angular3p":
      return need(4) ? angular3(e, st, k, pts[0], pts[1], pts[2], pts[3], text) : empty;
    case "angular2l":
      return need(5) ? angular2(e, st, k, pts, text) : empty;
    case "radial":
    case "diametric":
    case "jogged": {
      const c = geo.circle ?? (need(2) ? { center: pts[0], radius: len(sub(pts[1], pts[0])) } : null);
      if (!c || !(c.radius > 0)) return empty;
      const ref = need(2) ? sub(pts[1], c.center) : { x: 1, y: 0 };
      const phi = len(ref) < 1e-12 ? 0 : Math.atan2(ref.y, ref.x);
      const b = new Builder(st, k);
      if (e.kind === "diametric") {
        const rad = { x: Math.cos(phi), y: Math.sin(phi) };
        const A = add(c.center, mul(rad, -c.radius));
        const B = add(c.center, mul(rad, c.radius));
        const t = dimensionLine(b, A, B, rad, text(2 * c.radius), e.textPos, phi);
        return { lines: b.lines, fills: b.fills, text: t, measure: 2 * c.radius };
      }
      if (e.kind === "jogged") {
        const J = pts[2] ?? c.center;
        const rad = { x: Math.cos(phi), y: Math.sin(phi) };
        const T = add(c.center, mul(rad, c.radius));
        const v = unit(sub(T, J));
        const nrm = { x: -v.y, y: v.x };
        const jl = 2 * st.arrowSize * k;
        const M = { x: (J.x + T.x) / 2, y: (J.y + T.y) / 2 };
        const Pa = add(M, mul(v, -jl / 2));
        const Pb = add(M, mul(v, jl / 2));
        b.line(J, Pa, add(Pa, add(mul(v, jl / 3), mul(nrm, jl / 2))), sub(Pb, add(mul(v, jl / 3), mul(nrm, jl / 2))), Pb, T);
        b.arrow(T, mul(v, -1));
        const h = st.textHeight * k;
        const label = text(c.radius);
        const w = estWidth(label, h);
        const rho = st.textHorizontal ? 0 : upright(Math.atan2(v.y, v.x));
        const up = { x: -Math.sin(rho), y: Math.cos(rho) };
        const at = e.textPos ?? add(add(J, mul(v, -(w / 2 + st.gap * k))), mul(up, 0));
        return { lines: b.lines, fills: b.fills, text: { at, text: label, height: h, rotation: rho, width: w }, measure: c.radius };
      }
      const t = radialText(b, c.center, c.radius, phi, text(c.radius), e.textPos, false);
      return { lines: b.lines, fills: b.fills, text: t, measure: c.radius };
    }
    case "arclength": {
      if (!need(4)) return empty;
      const [C, S, E, AP] = pts;
      const rArc = geo.circle?.radius ?? len(sub(S, C));
      const aS = Math.atan2(S.y - C.y, S.x - C.x);
      const aE = Math.atan2(E.y - C.y, E.x - C.x);
      const aP = Math.atan2(AP.y - C.y, AP.x - C.x);
      let start: number;
      let sweep: number;
      if (geo.circle && geo.circle.start !== undefined && geo.circle.end !== undefined) {
        // A real arc: keep its own direction.
        const ccw = geo.circle.ccw !== false;
        start = ccw ? geo.circle.start : geo.circle.end;
        sweep = norm(ccw ? geo.circle.end - geo.circle.start : geo.circle.start - geo.circle.end);
        if (sweep < 1e-12) sweep = TAU;
      } else ({ start, sweep } = sectorThrough(aS, aE, aP));
      const R = Math.max(len(sub(AP, C)), 1e-6);
      const b = new Builder(st, k);
      const t = arcDimension(b, C, start, sweep, R, [rArc, rArc], text(rArc * sweep), e.textPos);
      return { lines: b.lines, fills: b.fills, text: t, measure: rArc * sweep };
    }
    case "ordinate": {
      if (!need(3)) return empty;
      const [O, F, L] = pts;
      const axis = e.axis ?? "x";
      const value = axis === "x" ? F.x - O.x : F.y - O.y;
      const b = new Builder(st, k);
      const h = st.textHeight * k;
      const label = text(Math.abs(value));
      const w = estWidth(label, h);
      if (axis === "x") {
        const my = (F.y + L.y) / 2;
        b.line(F, { x: F.x, y: my }, { x: L.x, y: my }, L);
      } else {
        const mx = (F.x + L.x) / 2;
        b.line(F, { x: mx, y: F.y }, { x: mx, y: L.y }, L);
      }
      const at = e.textPos ?? (axis === "x" ? { x: L.x, y: L.y + (L.y >= F.y ? 1 : -1) * (h / 2 + st.gap * k) } : { x: L.x + (L.x >= F.x ? 1 : -1) * (w / 2 + st.gap * k), y: L.y });
      return { lines: b.lines, fills: [], text: { at, text: label, height: h, rotation: 0, width: w }, measure: Math.abs(value) };
    }
  }
}
