import type { Entity, HatchEdge, HatchEntity, HatchLoop, PolylineEntity } from "../entities";
import { pointInPolygon } from "../regions";
import { polylineSegments } from "../entities";
import { bulgeToArc, dist, type Point } from "../geometry";
import type { Bounds } from "../dxf";
import { kindBounds, kindTessellate, kindTransform, type Affine } from "../kinds/registry";

/**
 * Hatch boundary geometry: loops of exact edges (line / arc / ellipse /
 * spline) and their tessellation into the polygons the fill engine works on.
 * An edge is the geometry of the matching entity kind, so tessellation and
 * affine maps reuse the registry instead of repeating curve maths.
 */

const TAU = Math.PI * 2;

/** The edge as a throwaway entity, so the kind registry can tessellate / transform it. */
export function edgeEntity(edge: HatchEdge): Entity {
  if (edge.type === "spline") return { id: "_", closed: false, ...edge } as Entity;
  return { id: "_", ...edge } as Entity;
}

function edgeFromEntity(e: Entity, like: HatchEdge): HatchEdge {
  const { id: _id, ...rest } = e as Entity & { id: string };
  void _id;
  const out = rest as unknown as HatchEdge;
  if (like.type === "spline" && !like.closed && "closed" in out) delete (out as { closed?: boolean }).closed;
  return out;
}

/** One edge as a run of points from its start to its end. */
export function edgeRun(edge: HatchEdge, tol: number): Point[] {
  return kindTessellate(edgeEntity(edge), tol)[0] ?? [];
}

/** A loop as a closed polygon (the first point is not repeated). Edges are joined by proximity, so each may run either way. */
export function loopPolygon(loop: HatchLoop, tol = 0.01): Point[] {
  const out: Point[] = [];
  const runs = loop.edges.map((e) => edgeRun(e, tol)).filter((r) => r.length > 0);
  runs.forEach((raw, i) => {
    let run = raw;
    if (i === 0 && runs.length > 1) {
      // The first edge may be stored backwards: it should END where the next one starts.
      const n = runs[1];
      const end = (p: Point): number => Math.min(dist(p, n[0]), dist(p, n[n.length - 1]));
      if (end(run[0]) < end(run[run.length - 1])) run = [...run].reverse();
    }
    if (out.length > 0) {
      const last = out[out.length - 1];
      if (dist(last, run[0]) > dist(last, run[run.length - 1])) run = [...run].reverse();
      out.push(...run.slice(dist(last, run[0]) < 1e-6 ? 1 : 0));
    } else out.push(...run);
  });
  while (out.length > 1 && dist(out[0], out[out.length - 1]) < 1e-9) out.pop();
  return out;
}

/** Every loop of a hatch as a polygon, skipping degenerate ones. */
export function hatchPolygons(h: HatchEntity, tol = 0.01): Point[][] {
  return h.loops.map((l) => loopPolygon(l, tol)).filter((p) => p.length >= 3);
}

/** Exact bounds of every boundary edge (a circle's extremes, not its sampled points). */
export function hatchBounds(h: HatchEntity): Bounds | null {
  let out: Bounds | null = null;
  for (const l of h.loops) {
    for (const edge of l.edges) {
      const b = kindBounds(edgeEntity(edge));
      if (!b) continue;
      out = out
        ? { minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY), maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY) }
        : b;
    }
  }
  return out;
}

export function transformLoop(loop: HatchLoop, m: Affine): HatchLoop | null {
  const edges: HatchEdge[] = [];
  for (const edge of loop.edges) {
    const t = kindTransform(edgeEntity(edge), m);
    if (!t) return null;
    edges.push(edgeFromEntity(t, edge));
  }
  return { ...loop, edges };
}

/** A closed polyline (with bulges) as a loop of line and arc edges. */
export function loopFromPolyline(e: Pick<PolylineEntity, "points" | "bulges" | "closed">): HatchLoop {
  const edges: HatchEdge[] = [];
  const segs = polylineSegments({ ...e, closed: true } as PolylineEntity);
  for (const seg of segs) {
    if (dist(seg.a, seg.b) < 1e-12) continue;
    const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
    edges.push(arc ? { type: "arc", ...arc } : { type: "line", a: seg.a, b: seg.b });
  }
  return { edges };
}

/** Plain polygon as a loop of line edges. */
export function loopFromPoints(points: Point[]): HatchLoop {
  const edges: HatchEdge[] = points.map((a, i) => ({ type: "line", a, b: points[(i + 1) % points.length] }));
  return { edges };
}

/** A circle as a one-edge loop (a full arc). */
export function loopFromCircle(center: Point, radius: number): HatchLoop {
  return { edges: [{ type: "arc", center, radius, startAngle: 0, endAngle: TAU, ccw: true }] };
}

/** Signed shoelace area of a polygon (positive = counter-clockwise). */
export function polygonArea(p: Point[]): number {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += p[j].x * p[i].y - p[i].x * p[j].y;
  return s / 2;
}

/** Whether the island style paints a point lying inside `count` nested loops (normal = odd, outer = only the outermost ring, ignore = any). */
export function paintedAtDepth(style: HatchEntity["style"], count: number): boolean {
  return style === "normal" ? count % 2 === 1 : style === "outer" ? count === 1 : count >= 1;
}

/**
 * The loops to fill with the even-odd rule so the island style comes out right:
 * `normal` all of them, `outer` the outermost ring and its first islands, `ignore` only the outermost loops.
 */
export function paintedPolygons(h: HatchEntity, tol = 0.05): Point[][] {
  const polys = hatchPolygons(h, tol);
  if (h.style === "normal") return polys;
  const depth = polys.map((poly, i) => {
    const samples = [poly[0], poly[Math.floor(poly.length / 3)], poly[Math.floor((2 * poly.length) / 3)]];
    const counts = samples.map((s) => polys.reduce((n, other, j) => (j !== i && pointInPolygon(s, other) ? n + 1 : n), 0)).sort((a, b) => a - b);
    return counts[1];
  });
  return polys.filter((_, i) => (h.style === "outer" ? depth[i] <= 1 : depth[i] === 0));
}

/** Whether `p` lies in the painted area of the hatch (honouring the island style). */
export function hatchContains(h: HatchEntity, p: Point): boolean {
  let count = 0;
  for (const poly of hatchPolygons(h, 0.05)) if (pointInPolygon(p, poly)) count++;
  return paintedAtDepth(h.style, count);
}
