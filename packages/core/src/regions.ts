import type { Entity, EntityId } from "./entities";
import { arcPointAt, arcSweep, dist, type Point } from "./geometry";

/**
 * Finds simple closed loops in a drawing — circles (trivially, on their
 * own) and chains of lines/arcs that connect endpoint-to-endpoint back to
 * where they started. Used both to highlight "this is a closed profile" and
 * to answer area-measurement clicks.
 *
 * Deliberately limited to *simple* loops: a vertex shared by three or more
 * edges (a T-junction, a rectangle split by a diagonal) isn't something this
 * can safely partition into sub-regions, so every edge touching it is
 * excluded from loop detection rather than guessed at. A full planar-face
 * traversal would handle that, but for verifying "did I close this profile"
 * — the actual use case — simple loops cover the vast majority of drawings.
 */

export interface ClosedRegion {
  entityIds: EntityId[];
  /** Ordered boundary polygon in world space — for fill rendering, area, and point-in-region tests. */
  points: Point[];
  area: number;
}

interface EdgeRef {
  entityId: EntityId;
  a: Point;
  b: Point;
  /** Tessellated points from a to b inclusive; a straight line is just [a, b]. */
  path: Point[];
}

function edgesOf(entities: Entity[]): EdgeRef[] {
  const edges: EdgeRef[] = [];
  for (const e of entities) {
    if (e.type === "line") {
      edges.push({ entityId: e.id, a: e.a, b: e.b, path: [e.a, e.b] });
    } else if (e.type === "arc") {
      const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
      const steps = Math.min(64, Math.max(4, Math.ceil((sweep / (2 * Math.PI)) * 64)));
      const path: Point[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = e.ccw ? e.startAngle + sweep * (i / steps) : e.startAngle - sweep * (i / steps);
        path.push(arcPointAt(e.center, e.radius, t));
      }
      edges.push({ entityId: e.id, a: path[0], b: path[path.length - 1], path });
    }
    // Circles are handled separately (always their own region); points contribute no edges.
  }
  return edges;
}

/** Clusters edge endpoints within `tolerance` into shared vertices (spatial hash + union-find, as in heal.ts). */
function clusterVertices(
  edges: EdgeRef[],
  tolerance: number,
): { vertexOf: (edgeIdx: number, which: "a" | "b") => number } {
  const cell = Math.max(tolerance, 1e-9);
  const cellKey = (p: Point) => `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
  type Ref = { key: string; point: Point };
  const refs: Ref[] = [];
  edges.forEach((e, i) => {
    refs.push({ key: `${i}.a`, point: e.a });
    refs.push({ key: `${i}.b`, point: e.b });
  });

  const hash = new Map<string, Ref[]>();
  for (const r of refs) {
    const k = cellKey(r.point);
    const bucket = hash.get(k);
    if (bucket) bucket.push(r);
    else hash.set(k, [r]);
  }

  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let cur = parent.get(k) ?? k;
    while (cur !== (parent.get(cur) ?? cur)) cur = parent.get(cur)!;
    parent.set(k, cur);
    return cur;
  };
  const union = (ka: string, kb: string) => {
    const ra = find(ka);
    const rb = find(kb);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const r of refs) if (!parent.has(r.key)) parent.set(r.key, r.key);
  for (const r of refs) {
    const cx = Math.floor(r.point.x / cell);
    const cy = Math.floor(r.point.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = hash.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const q of bucket) {
          if (q === r || dist(q.point, r.point) > tolerance) continue;
          union(r.key, q.key);
        }
      }
    }
  }

  const rootToId = new Map<string, number>();
  let nextId = 0;
  const idOf = (key: string): number => {
    const root = find(key);
    let id = rootToId.get(root);
    if (id === undefined) {
      id = nextId++;
      rootToId.set(root, id);
    }
    return id;
  };
  return { vertexOf: (edgeIdx, which) => idOf(`${edgeIdx}.${which}`) };
}

function shoelaceArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function circleRegion(id: EntityId, center: Point, radius: number): ClosedRegion {
  const steps = 64;
  const points: Point[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    points.push({ x: center.x + radius * Math.cos(t), y: center.y + radius * Math.sin(t) });
  }
  return { entityIds: [id], points, area: Math.PI * radius * radius };
}

export function findClosedRegions(entities: Entity[], tolerance = 1e-3): ClosedRegion[] {
  const regions: ClosedRegion[] = [];
  for (const e of entities) {
    if (e.type === "circle") regions.push(circleRegion(e.id, e.center, e.radius));
  }

  const edges = edgesOf(entities);
  if (edges.length === 0) return regions;

  const { vertexOf } = clusterVertices(edges, tolerance);

  const adj = new Map<number, { edgeIdx: number }[]>();
  edges.forEach((_, i) => {
    for (const which of ["a", "b"] as const) {
      const v = vertexOf(i, which);
      const list = adj.get(v);
      if (list) list.push({ edgeIdx: i });
      else adj.set(v, [{ edgeIdx: i }]);
    }
  });
  const degreeOf = (v: number): number => adj.get(v)?.length ?? 0;

  const visited = new Set<number>();
  const guard = edges.length + 1;

  for (let startEdge = 0; startEdge < edges.length; startEdge++) {
    if (visited.has(startEdge)) continue;
    const startA = vertexOf(startEdge, "a");
    const startB = vertexOf(startEdge, "b");
    if (degreeOf(startA) !== 2 || degreeOf(startB) !== 2) continue;

    const chain: { edgeIdx: number; forward: boolean }[] = [{ edgeIdx: startEdge, forward: true }];
    let curVertex = startB;
    let closed = false;
    let broken = false;

    for (let step = 0; step < guard; step++) {
      if (curVertex === startA) {
        closed = true;
        break;
      }
      if (degreeOf(curVertex) !== 2) {
        broken = true;
        break;
      }
      const lastEdgeIdx = chain[chain.length - 1].edgeIdx;
      const next = adj.get(curVertex)!.find((t) => t.edgeIdx !== lastEdgeIdx);
      if (!next || chain.some((c) => c.edgeIdx === next.edgeIdx)) {
        broken = true;
        break;
      }
      const nextA = vertexOf(next.edgeIdx, "a");
      const forward = nextA === curVertex;
      chain.push({ edgeIdx: next.edgeIdx, forward });
      curVertex = forward ? vertexOf(next.edgeIdx, "b") : nextA;
    }

    for (const c of chain) visited.add(c.edgeIdx);
    if (!closed || broken) continue;

    const points: Point[] = [];
    const entityIds: EntityId[] = [];
    chain.forEach(({ edgeIdx, forward }, i) => {
      const edge = edges[edgeIdx];
      const path = forward ? edge.path : [...edge.path].reverse();
      points.push(...(i === 0 ? path : path.slice(1)));
      entityIds.push(edge.entityId);
    });
    const area = Math.abs(shoelaceArea(points));
    if (area > 1e-9) regions.push({ entityIds, points, area });
  }

  return regions;
}

/** Standard ray-casting point-in-polygon test. */
export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** The smallest-area region containing `p` (the innermost hit, for nested closed shapes), or null. */
export function regionContainingPoint(regions: ClosedRegion[], p: Point): ClosedRegion | null {
  let best: ClosedRegion | null = null;
  for (const r of regions) {
    if (pointInPolygon(p, r.points) && (!best || r.area < best.area)) best = r;
  }
  return best;
}
