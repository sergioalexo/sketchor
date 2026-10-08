/**
 * PostScript paths → Sketchor entities (F-01). The interpreter keeps the
 * current path in default user space (points, y up); this module maps it to
 * millimetres and builds the same shapes the SVG importer does: all-line runs
 * become polylines, all-curve runs become cubic splines (exact — chained
 * Béziers with triple knots), a four-Bézier closed loop that is a circle
 * becomes a circle, and a filled compound path becomes a solid hatch whose
 * loops keep their exact edges.
 */
import type { CircleEntity, Entity, HatchEdge, HatchEntity, HatchLoop, PolylineEntity, SplineEntity } from "../entities";
import { newEntityId } from "../entities";
import type { Point } from "../geometry";

export type PSeg = { k: "L"; x: number; y: number } | { k: "C"; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number };

export interface SubPath {
  x0: number;
  y0: number;
  segs: PSeg[];
  closed: boolean;
}

export interface EntityStyle {
  color?: string;
  lineweight?: number;
  linetype?: string;
  layer?: string;
}

export type ToWorld = (x: number, y: number) => Point;

const EPS = 1e-6;
const d2 = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

function styled<T extends Entity>(e: T, st: EntityStyle): T {
  const r = e as Entity & EntityStyle;
  if (st.layer) r.layer = st.layer;
  if (st.color) r.color = st.color;
  if (st.lineweight !== undefined) r.lineweight = st.lineweight;
  if (st.linetype) r.linetype = st.linetype;
  return e;
}

/**
 * Whether a closed run of Béziers traces a circle: 4 curves (Illustrator's own
 * circle) or 8/12/16 (finer writers, including Sketchor's EPS export). On-curve
 * points equidistant from the centre, equal angular steps, handles the textbook
 * 4/3·tan(step/4)·r long. Returns centre and radius in world mm.
 */
function asCircle(nodes: { p: Point; c1?: Point; c2?: Point }[]): { center: Point; radius: number } | null {
  const n = nodes.length - 1;
  if (n < 4 || n > 16 || n % 4 !== 0) return null;
  if (d2(nodes[n].p, nodes[0].p) > 1e-4) return null;
  if (nodes.slice(1).some((q) => !q.c1 || !q.c2)) return null;
  const P = nodes.slice(0, n).map((q) => q.p);
  const center = { x: P.reduce((t, q) => t + q.x, 0) / n, y: P.reduce((t, q) => t + q.y, 0) / n };
  const r = P.reduce((t, q) => t + d2(q, center), 0) / n;
  if (r < 1e-6) return null;
  for (const q of P) if (Math.abs(d2(q, center) - r) > r * 1e-3) return null;
  const step = (2 * Math.PI) / n;
  let dir = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const c = P[(i + 1) % n];
    const cross = (a.x - center.x) * (c.y - center.y) - (a.y - center.y) * (c.x - center.x);
    const dot = (a.x - center.x) * (c.x - center.x) + (a.y - center.y) * (c.y - center.y);
    const ang = Math.atan2(cross, dot);
    if (dir === 0) dir = Math.sign(ang);
    if (!dir || Math.abs(ang - dir * step) > 2e-3) return null;
  }
  const k = (4 / 3) * Math.tan(step / 4) * r;
  for (let i = 1; i <= n; i++) {
    const a = P[i - 1];
    const c = P[i % n];
    const { c1, c2 } = nodes[i];
    if (Math.abs(d2(a, c1!) - k) > r * 5e-3 || Math.abs(d2(c, c2!) - k) > r * 5e-3) return null;
  }
  return { center, radius: r };
}

/** True when every segment is a curve (or a line) — `"L"`/`"C"` purity of a subpath. */
export function pureKind(sp: SubPath): "L" | "C" | null {
  if (!sp.segs.length) return null;
  const k = sp.segs[0].k;
  return sp.segs.every((s) => s.k === k) ? k : null;
}

/**
 * Entities for one subpath. `closed` forces closure (fill closes implicitly).
 * With `fill` a *pure* closed shape carries the fill colour itself; callers
 * pass undefined for compound fills (those get a hatch instead).
 */
export function subpathToEntities(sp: SubPath, tf: ToWorld, st: EntityStyle, closed: boolean, fill?: string): Entity[] {
  const out: Entity[] = [];
  const start = tf(sp.x0, sp.y0);
  type Node = { p: Point; c1?: Point; c2?: Point };
  const nodes: Node[] = [{ p: start }];
  for (const s of sp.segs) {
    if (s.k === "L") {
      const p = tf(s.x, s.y);
      if (d2(p, nodes[nodes.length - 1].p) < EPS) continue;
      nodes.push({ p });
    } else nodes.push({ p: tf(s.x3, s.y3), c1: tf(s.x1, s.y1), c2: tf(s.x2, s.y2) });
  }
  if (nodes.length < 2) return out;
  const endsAtStart = d2(nodes[nodes.length - 1].p, start) < EPS;
  if (closed) {
    // an explicit line back to the start is just the closing segment
    const last = nodes[nodes.length - 1];
    if (endsAtStart && !last.c1 && nodes.length > 2) nodes.pop();
    else if (!endsAtStart) nodes.push({ p: start });
  }
  if (closed) {
    const circ = asCircle(nodes);
    if (circ) {
      const c: CircleEntity = { id: newEntityId(), type: "circle", center: circ.center, radius: circ.radius };
      if (fill) c.fill = fill;
      out.push(styled(c, st));
      return out;
    }
  }
  const allLine = nodes.slice(1).every((n) => !n.c1);
  const allCurve = nodes.slice(1).every((n) => !!n.c1);
  const wasClosed = closed;
  const emitPoly = (pts: Point[], isClosed: boolean) => {
    if (pts.length < 2) return;
    const e: PolylineEntity = { id: newEntityId(), type: "polyline", points: pts, closed: isClosed };
    if (isClosed && fill) e.fill = fill;
    out.push(styled(e, st));
  };
  const emitSpline = (pts: Point[], isClosed: boolean) => {
    const n = (pts.length - 1) / 3;
    if (n < 1 || pts.every((p) => d2(p, pts[0]) < EPS)) return;
    const knots = [0, 0, 0, 0];
    for (let k = 1; k < n; k++) knots.push(k, k, k);
    knots.push(n, n, n, n);
    const e: SplineEntity = { id: newEntityId(), type: "spline", degree: 3, controlPoints: pts, knots, closed: isClosed };
    if (isClosed && fill) e.fill = fill;
    out.push(styled(e, st));
  };
  if (allLine) {
    const pts = nodes.map((n) => n.p);
    // closed polylines don't repeat the start
    if (wasClosed && pts.length > 2 && d2(pts[0], pts[pts.length - 1]) < EPS) pts.pop();
    emitPoly(pts, wasClosed && pts.length >= 3);
    return out;
  }
  if (allCurve) {
    const pts: Point[] = [nodes[0].p];
    for (const n of nodes.slice(1)) pts.push(n.c1!, n.c2!, n.p);
    emitSpline(pts, wasClosed && d2(pts[0], pts[pts.length - 1]) < EPS);
    return out;
  }
  // Mixed: emit maximal runs in order, each exact.
  let run: Point[] = [nodes[0].p];
  let kind: "L" | "C" = nodes[1].c1 ? "C" : "L";
  const flush = () => {
    if (kind === "L") emitPoly(run, false);
    else emitSpline(run, false);
  };
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    const k = n.c1 ? "C" : "L";
    if (k !== kind) {
      const last = run[run.length - 1];
      flush();
      run = [last];
      kind = k;
    }
    if (k === "C") run.push(n.c1!, n.c2!, n.p);
    else run.push(n.p);
  }
  flush();
  return out;
}

/** One solid hatch for a (possibly compound) filled path; holes follow from the even-odd island style. */
export function subpathsToHatch(sps: SubPath[], tf: ToWorld, color: string, layer?: string): HatchEntity | null {
  const loops: HatchLoop[] = [];
  for (const sp of sps) {
    const edges: HatchEdge[] = [];
    let cur = tf(sp.x0, sp.y0);
    const start = cur;
    for (const s of sp.segs) {
      if (s.k === "L") {
        const p = tf(s.x, s.y);
        if (d2(p, cur) >= EPS) edges.push({ type: "line", a: cur, b: p });
        cur = p;
      } else {
        const p = tf(s.x3, s.y3);
        edges.push({ type: "spline", degree: 3, controlPoints: [cur, tf(s.x1, s.y1), tf(s.x2, s.y2), p], knots: [0, 0, 0, 0, 1, 1, 1, 1] });
        cur = p;
      }
    }
    if (d2(cur, start) >= EPS) edges.push({ type: "line", a: cur, b: start });
    if (edges.length >= 2 || (edges.length === 1 && edges[0].type === "spline")) loops.push({ edges });
  }
  if (!loops.length) return null;
  const h: HatchEntity = { id: newEntityId(), type: "hatch", loops, paint: { kind: "solid", color }, style: "normal" };
  if (layer) h.layer = layer;
  return h;
}

/** A cheap geometry signature, to recognise "fill this path, then stroke the same path". */
export function pathSignature(sps: SubPath[]): string {
  const f = (v: number) => Math.round(v * 100);
  const parts: string[] = [];
  for (const sp of sps) {
    let s = `${f(sp.x0)},${f(sp.y0)}`;
    for (const g of sp.segs) s += g.k === "L" ? `L${f(g.x)},${f(g.y)}` : `C${f(g.x3)},${f(g.y3)}`;
    parts.push(s);
  }
  return parts.join("|");
}
