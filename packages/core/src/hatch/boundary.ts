import type { Entity, EntityId, HatchEdge, HatchEntity, HatchLoop, HatchPaint } from "../entities";
import { dist, type Point } from "../geometry";
import { kindTessellate } from "../kinds/registry";
import { pointInPolygon } from "../regions";
import { loopFromCircle, loopFromPolyline, polygonArea } from "./loops";

/**
 * Hatch boundary detection (H-04): a planar-graph face search over the
 * tessellated drawing.
 *
 * Every entity is flattened to segments, segments are split at every crossing
 * and touch (so T-junctions and a rectangle cut by a line work — the old
 * `regions.ts` refused those), endpoints within the gap tolerance are bridged
 * (AutoCAD's HPGAPTOL), dangling spurs are pruned, and the faces of the
 * remaining graph are walked. The face holding the pick point with the
 * smallest area is the boundary; every other connected component lying inside
 * it is an island. The result is converted back to exact edges where a whole
 * entity (circle, ellipse, spline, polyline) or a straight/arc piece forms the
 * boundary, and to line edges for a partly used ellipse/spline/polyline.
 */

export interface BoundaryOptions {
  /** Endpoints this close are joined by a bridging segment. 0 = none. */
  gapTol?: number;
  /** Chord tolerance for flattening curves (world units). */
  tol?: number;
  /** Give up past this many segments (a runaway drawing). */
  maxSegments?: number;
}

export interface BoundaryResult {
  loops: HatchLoop[];
  /** Ids of the entities the loops follow (the associative sources). */
  sources: EntityId[];
}

interface Seg {
  a: Point;
  b: Point;
  ent: number;
}

interface HE {
  from: number;
  to: number;
  ent: number;
  /** Segment of the original (unsplit) entity run this piece belongs to, for coverage accounting. */
  len: number;
}

const EPS = 1e-7;

function geometryEntities(entities: readonly Entity[]): Entity[] {
  return entities.filter((e) => e.type !== "hatch" && e.type !== "text" && e.type !== "image" && e.type !== "point" && !e.construction && !(e.type === "line" && e.infinite));
}

/** Splits every segment at crossings with, and endpoint touches of, the others. */
function splitSegments(segs: Seg[]): Seg[] {
  const order = segs.map((_, i) => i).sort((i, j) => Math.min(segs[i].a.x, segs[i].b.x) - Math.min(segs[j].a.x, segs[j].b.x));
  const cuts: number[][] = segs.map(() => []);
  const minX = (s: Seg): number => Math.min(s.a.x, s.b.x);
  const maxX = (s: Seg): number => Math.max(s.a.x, s.b.x);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    const s = segs[i];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      const t = segs[j];
      if (minX(t) > maxX(s) + EPS) break;
      if (Math.min(t.a.y, t.b.y) > Math.max(s.a.y, s.b.y) + EPS || Math.max(t.a.y, t.b.y) < Math.min(s.a.y, s.b.y) - EPS) continue;
      const rx = s.b.x - s.a.x;
      const ry = s.b.y - s.a.y;
      const qx = t.b.x - t.a.x;
      const qy = t.b.y - t.a.y;
      const den = rx * qy - ry * qx;
      const lenS = Math.hypot(rx, ry);
      const lenT = Math.hypot(qx, qy);
      if (lenS < EPS || lenT < EPS) continue;
      if (Math.abs(den) > 1e-12 * lenS * lenT) {
        const wx = t.a.x - s.a.x;
        const wy = t.a.y - s.a.y;
        const u = (wx * qy - wy * qx) / den; // along s
        const v = (wx * ry - wy * rx) / den; // along t
        const eu = EPS / lenS;
        const ev = EPS / lenT;
        if (u >= -eu && u <= 1 + eu && v >= -ev && v <= 1 + ev) {
          if (u > eu && u < 1 - eu) cuts[i].push(u);
          if (v > ev && v < 1 - ev) cuts[j].push(v);
        }
      } else {
        // Parallel: only collinear overlap matters — each other's endpoints that fall inside split this one.
        const onLine = (p: Point, o: Seg): number | null => {
          const dx = o.b.x - o.a.x;
          const dy = o.b.y - o.a.y;
          const l = Math.hypot(dx, dy);
          const cross = ((p.x - o.a.x) * dy - (p.y - o.a.y) * dx) / l;
          if (Math.abs(cross) > EPS) return null;
          const k = ((p.x - o.a.x) * dx + (p.y - o.a.y) * dy) / (l * l);
          return k > EPS / l && k < 1 - EPS / l ? k : null;
        };
        for (const p of [t.a, t.b]) {
          const k = onLine(p, s);
          if (k !== null) cuts[i].push(k);
        }
        for (const p of [s.a, s.b]) {
          const k = onLine(p, t);
          if (k !== null) cuts[j].push(k);
        }
      }
    }
  }
  const out: Seg[] = [];
  segs.forEach((s, i) => {
    const ts = [0, ...cuts[i].sort((a, b) => a - b), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-12) continue;
      const at = (t: number): Point => (t === 0 ? s.a : t === 1 ? s.b : { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t });
      out.push({ a: at(ts[k]), b: at(ts[k + 1]), ent: s.ent });
    }
  });
  return out;
}

class Graph {
  pts: Point[] = [];
  private grid = new Map<string, number[]>();
  edges: { u: number; v: number; ent: number; len: number }[] = [];
  private seen = new Set<string>();

  node(p: Point): number {
    const cx = Math.round(p.x / 1e-5);
    const cy = Math.round(p.y / 1e-5);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of this.grid.get(`${cx + dx},${cy + dy}`) ?? []) if (dist(this.pts[id], p) < 2e-5) return id;
      }
    }
    const id = this.pts.length;
    this.pts.push(p);
    const key = `${cx},${cy}`;
    const list = this.grid.get(key);
    if (list) list.push(id);
    else this.grid.set(key, [id]);
    return id;
  }

  add(a: Point, b: Point, ent: number): void {
    const u = this.node(a);
    const v = this.node(b);
    if (u === v) return;
    const key = u < v ? `${u}:${v}` : `${v}:${u}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.edges.push({ u, v, ent, len: dist(a, b) });
  }
}

interface Face {
  hes: HE[];
  area: number;
  poly: Point[];
  comp: number;
}

/** The planar graph of a set of entities, with its faces walked. */
interface Planar {
  graph: Graph;
  faces: Face[];
  comp: number[];
  /** Total flattened length per entity index, to tell a whole entity from a piece. */
  entLen: number[];
}

function build(ents: Entity[], opts: BoundaryOptions): Planar | null {
  const tol = opts.tol ?? 0.01;
  const raw: Seg[] = [];
  ents.forEach((e, ent) => {
    for (const run of kindTessellate(e, tol)) {
      for (let i = 0; i + 1 < run.length; i++) if (dist(run[i], run[i + 1]) > EPS) raw.push({ a: run[i], b: run[i + 1], ent });
    }
  });
  if (raw.length === 0 || raw.length > (opts.maxSegments ?? 60_000)) return null;
  const entLen = ents.map(() => 0);
  for (const s of raw) entLen[s.ent] += dist(s.a, s.b);
  const g = new Graph();
  for (const s of splitSegments(raw)) g.add(s.a, s.b, s.ent);

  const degree = (): number[] => {
    const d = g.pts.map(() => 0);
    for (const e of g.edges) {
      d[e.u]++;
      d[e.v]++;
    }
    return d;
  };

  // Bridge small gaps between dangling endpoints (HPGAPTOL).
  const gap = opts.gapTol ?? 0;
  if (gap > 0) {
    const d = degree();
    const dangling = d.map((n, i) => (n === 1 ? i : -1)).filter((i) => i >= 0);
    const used = new Set<number>();
    for (const i of dangling) {
      if (used.has(i)) continue;
      let best = -1;
      let bestD = gap;
      for (let j = 0; j < g.pts.length; j++) {
        if (j === i || d[j] === 0) continue;
        const dd = dist(g.pts[i], g.pts[j]);
        if (dd <= bestD && !g.edges.some((e) => (e.u === i && e.v === j) || (e.u === j && e.v === i))) {
          best = j;
          bestD = dd;
        }
      }
      if (best >= 0) {
        g.add(g.pts[i], g.pts[best], -1);
        used.add(i);
        if (d[best] === 1) used.add(best);
      }
    }
  }

  // Prune spurs: an edge into a degree-1 node bounds no face.
  for (;;) {
    const d = degree();
    const before = g.edges.length;
    g.edges = g.edges.filter((e) => d[e.u] > 1 && d[e.v] > 1);
    if (g.edges.length === before) break;
  }
  if (g.edges.length === 0) return null;

  // Half-edges sorted by angle around each node.
  const out: HE[][] = g.pts.map(() => []);
  for (const e of g.edges) {
    out[e.u].push({ from: e.u, to: e.v, ent: e.ent, len: e.len });
    out[e.v].push({ from: e.v, to: e.u, ent: e.ent, len: e.len });
  }
  const angle = (h: HE): number => Math.atan2(g.pts[h.to].y - g.pts[h.from].y, g.pts[h.to].x - g.pts[h.from].x);
  for (const list of out) list.sort((a, b) => angle(a) - angle(b));
  const indexOf = new Map<HE, number>();
  for (const list of out) list.forEach((h, i) => indexOf.set(h, i));
  const twinOf = (h: HE): HE => out[h.to].find((t) => t.to === h.from)!;

  // Connected components.
  const parent = g.pts.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of g.edges) parent[find(e.u)] = find(e.v);
  const comp = g.pts.map((_, i) => find(i));

  const visited = new Set<HE>();
  const faces: Face[] = [];
  for (const list of out) {
    for (const start of list) {
      if (visited.has(start)) continue;
      const hes: HE[] = [];
      let h = start;
      for (let guard = 0; guard < 1_000_000; guard++) {
        visited.add(h);
        hes.push(h);
        const tw = twinOf(h);
        const lst = out[tw.from];
        const i = indexOf.get(tw)!;
        h = lst[(i - 1 + lst.length) % lst.length];
        if (h === start) break;
      }
      const poly = hes.map((x) => g.pts[x.from]);
      faces.push({ hes, area: polygonArea(poly), poly, comp: comp[start.from] });
    }
  }
  return { graph: g, faces, comp, entLen };
}

const angleOf = (c: Point, p: Point): number => Math.atan2(p.y - c.y, p.x - c.x);

/** A run of consecutive half-edges from one entity (or a bridge) as exact edges where possible. */
function runToEdges(ents: Entity[], run: HE[], pts: Point[], whole: boolean): HatchEdge[] {
  const first = pts[run[0].from];
  const last = pts[run[run.length - 1].to];
  const e = run[0].ent >= 0 ? ents[run[0].ent] : null;
  if (!e) return run.map((h) => ({ type: "line" as const, a: pts[h.from], b: pts[h.to] }));
  if (whole) {
    switch (e.type) {
      case "line":
        return [{ type: "line", a: e.a, b: e.b }];
      case "circle":
        return loopFromCircle(e.center, e.radius).edges;
      case "arc":
        return [{ type: "arc", center: e.center, radius: e.radius, startAngle: e.startAngle, endAngle: e.endAngle, ccw: e.ccw }];
      case "ellipse":
        return [{ type: "ellipse", center: e.center, majorAxis: e.majorAxis, ratio: e.ratio, start: e.start, end: e.end }];
      case "spline":
        return [{ type: "spline", degree: e.degree, controlPoints: e.controlPoints, knots: e.knots, ...(e.weights ? { weights: e.weights } : {}), closed: e.closed }];
      case "polyline":
        return loopFromPolyline(e).edges;
      default:
        break;
    }
  }
  if (e.type === "line") return [{ type: "line", a: first, b: last }];
  if (e.type === "arc" || e.type === "circle") {
    const second = pts[run[0].to];
    const cross = (first.x - e.center.x) * (second.y - e.center.y) - (first.y - e.center.y) * (second.x - e.center.x);
    // A full circle walked from a cut point back to itself has first == last: a full turn.
    return [{ type: "arc", center: e.center, radius: e.radius, startAngle: angleOf(e.center, first), endAngle: angleOf(e.center, last), ccw: cross > 0 }];
  }
  return run.map((h) => ({ type: "line" as const, a: pts[h.from], b: pts[h.to] }));
}

function faceToLoop(ents: Entity[], pl: Planar, hes: HE[]): { loop: HatchLoop; sources: Set<number> } {
  const pts = pl.graph.pts;
  // Start at a boundary between entities so a closed entity is not cut in two.
  let rot = 0;
  for (let i = 0; i < hes.length; i++) {
    if (hes[i].ent !== hes[(i + hes.length - 1) % hes.length].ent) {
      rot = i;
      break;
    }
  }
  const seq = [...hes.slice(rot), ...hes.slice(0, rot)];
  const edges: HatchEdge[] = [];
  const sources = new Set<number>();
  for (let i = 0; i < seq.length; ) {
    let j = i;
    let len = 0;
    while (j < seq.length && seq[j].ent === seq[i].ent) len += seq[j++].len;
    const run = seq.slice(i, j);
    const ent = run[0].ent;
    if (ent >= 0) sources.add(ent);
    const whole = ent >= 0 && Math.abs(len - pl.entLen[ent]) <= 1e-6 * Math.max(1, pl.entLen[ent]);
    edges.push(...runToEdges(ents, run, pts, whole));
    i = j;
  }
  return { loop: { edges, derived: true }, sources };
}

function toResult(ents: Entity[], pl: Planar, picks: { hes: HE[] }[]): BoundaryResult {
  const loops: HatchLoop[] = [];
  const src = new Set<number>();
  picks.forEach((p, i) => {
    const { loop, sources } = faceToLoop(ents, pl, p.hes);
    loops.push({ ...loop, outer: i === 0 });
    sources.forEach((s) => src.add(s));
  });
  return { loops, sources: [...src].map((i) => ents[i].id) };
}

/** The outer boundary of a connected component, as the walk with the most negative area. */
function outerWalk(pl: Planar, comp: number): Face | null {
  let best: Face | null = null;
  for (const f of pl.faces) if (f.comp === comp && f.area < 0 && (!best || f.area < best.area)) best = f;
  return best;
}

/**
 * The boundary for a click at `p`: the smallest closed region around it plus
 * the islands inside it, or null when `p` is not enclosed (or the drawing is
 * too large to analyse).
 */
export function detectBoundary(entities: readonly Entity[], p: Point, opts: BoundaryOptions = {}): BoundaryResult | null {
  const ents = geometryEntities(entities);
  const pl = build(ents, opts);
  if (!pl) return null;
  let face: Face | null = null;
  for (const f of pl.faces) {
    if (f.area <= 1e-12 || f.poly.length < 3) continue;
    if (!pointInPolygon(p, f.poly)) continue;
    if (!face || f.area < face.area) face = f;
  }
  if (!face) return null;
  const picks: { hes: HE[] }[] = [face];
  const seen = new Set<number>([face.comp]);
  for (const f of pl.faces) {
    if (f.area >= 0 || seen.has(f.comp)) continue;
    // A component entirely inside the chosen face: an island (test one vertex).
    if (pointInPolygon(pl.graph.pts[f.hes[0].from], face.poly)) {
      const walk = outerWalk(pl, f.comp);
      if (walk) {
        picks.push(walk);
        seen.add(f.comp);
      }
    }
  }
  return toResult(ents, pl, picks);
}

/** The boundary made of the given entities themselves ("select objects"): the outer boundary of every closed group. */
export function boundaryFromObjects(entities: readonly Entity[], opts: BoundaryOptions = {}): BoundaryResult | null {
  const ents = geometryEntities(entities);
  const pl = build(ents, opts);
  if (!pl) return null;
  const comps = new Set<number>();
  const picks: { hes: HE[] }[] = [];
  for (const f of pl.faces) {
    if (comps.has(f.comp)) continue;
    const walk = outerWalk(pl, f.comp);
    if (walk) {
      comps.add(f.comp);
      picks.push(walk);
    }
  }
  if (picks.length === 0) return null;
  // Largest first so loop 0 is the outermost.
  picks.sort((a, b) => Math.abs((b as Face).area) - Math.abs((a as Face).area));
  return toResult(ents, pl, picks);
}

/** A legacy colour fill (`fill` on a closed shape) as an equivalent solid hatch, or null. */
export function fillToHatch(e: Entity, id: EntityId): HatchEntity | null {
  if (!("fill" in e) || !e.fill) return null;
  const res = boundaryFromObjects([e]);
  if (!res) return null;
  return {
    id,
    type: "hatch",
    ...(e.layer ? { layer: e.layer } : {}),
    loops: res.loops,
    paint: { kind: "solid", color: e.fill },
    style: "normal",
  };
}

export type { HatchPaint };
