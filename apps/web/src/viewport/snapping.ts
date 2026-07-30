import type { Point, SketchDocument } from "@sketchor/core";
import { arcPointAt, arcSweep, bulgeToArc, closestPointOnSegment, dist, mid, polylineSegments } from "@sketchor/core";
import { gridStep, type View } from "./view";

export type SnapKind = "endpoint" | "midpoint" | "center" | "quadrant" | "intersection" | "on-line" | "grid";

export interface Snap {
  point: Point;
  kind: SnapKind;
}

const SNAP_PX = 10;

/** Two segments' crossing point, or null if they're parallel or don't actually cross within both spans. */
function segmentIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const rX = a2.x - a1.x;
  const rY = a2.y - a1.y;
  const sX = b2.x - b1.x;
  const sY = b2.y - b1.y;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-12) return null; // parallel/collinear — no single crossing point
  const t = ((b1.x - a1.x) * sY - (b1.y - a1.y) * sX) / denom;
  const u = ((b1.x - a1.x) * rY - (b1.y - a1.y) * rX) / denom;
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { x: a1.x + t * rX, y: a1.y + t * rY };
}

/**
 * Finds the best snap near a world-space cursor position, in priority tiers:
 * specific feature points (endpoint/center/quadrant/intersection) win over
 * the generic midpoint, which wins over a nearest-point-on-curve fallback,
 * which itself wins over the always-available grid point. Without tiering, a
 * "closest point on this line" candidate would almost always out-distance a
 * feature point sitting further along the same line, making corners and
 * centers effectively unreachable.
 */
export function findSnap(doc: SketchDocument, view: View, cursor: Point): Snap {
  const tol = SNAP_PX / view.scale;
  const entities = doc.all();

  const bestOf = (candidates: { point: Point; kind: SnapKind }[]): Snap | null => {
    let best: Snap | null = null;
    let bestDist = tol;
    for (const c of candidates) {
      const d = dist(c.point, cursor);
      if (d <= bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  };

  const featurePoints: { point: Point; kind: SnapKind }[] = [];
  const midpoints: { point: Point; kind: SnapKind }[] = [];
  const onCurve: { point: Point; kind: SnapKind }[] = [];

  for (const e of entities) {
    if (e.type === "line") {
      featurePoints.push({ point: e.a, kind: "endpoint" }, { point: e.b, kind: "endpoint" });
      midpoints.push({ point: mid(e.a, e.b), kind: "midpoint" });
      onCurve.push({ point: closestPointOnSegment(cursor, e.a, e.b), kind: "on-line" });
    } else if (e.type === "circle") {
      const { center: c, radius: r } = e;
      featurePoints.push(
        { point: c, kind: "center" },
        { point: { x: c.x + r, y: c.y }, kind: "quadrant" },
        { point: { x: c.x - r, y: c.y }, kind: "quadrant" },
        { point: { x: c.x, y: c.y + r }, kind: "quadrant" },
        { point: { x: c.x, y: c.y - r }, kind: "quadrant" },
      );
    } else if (e.type === "point") {
      featurePoints.push({ point: e.p, kind: "endpoint" });
    } else if (e.type === "arc") {
      featurePoints.push(
        { point: e.center, kind: "center" },
        { point: arcPointAt(e.center, e.radius, e.startAngle), kind: "endpoint" },
        { point: arcPointAt(e.center, e.radius, e.endAngle), kind: "endpoint" },
      );
      const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
      const midAngle = e.ccw ? e.startAngle + sweep / 2 : e.startAngle - sweep / 2;
      midpoints.push({ point: arcPointAt(e.center, e.radius, midAngle), kind: "midpoint" });
    } else {
      // Every vertex is an endpoint snap; every segment additionally offers a
      // midpoint and a nearest-point-along snap, exactly like a loose line.
      for (const p of e.points) featurePoints.push({ point: p, kind: "endpoint" });
      for (const seg of polylineSegments(e)) {
        const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
        if (bulgeArc) {
          featurePoints.push({ point: bulgeArc.center, kind: "center" });
          const sweep = arcSweep(bulgeArc.startAngle, bulgeArc.endAngle, bulgeArc.ccw);
          const midAngle = bulgeArc.ccw
            ? bulgeArc.startAngle + sweep / 2
            : bulgeArc.startAngle - sweep / 2;
          midpoints.push({ point: arcPointAt(bulgeArc.center, bulgeArc.radius, midAngle), kind: "midpoint" });
        } else {
          midpoints.push({ point: mid(seg.a, seg.b), kind: "midpoint" });
          onCurve.push({ point: closestPointOnSegment(cursor, seg.a, seg.b), kind: "on-line" });
        }
      }
    }
  }

  // Intersections between straight segments — from loose lines and from
  // polyline segments alike. Only segments whose bounding box is already near
  // the cursor are tested against each other, so this stays cheap even on
  // large drawings.
  const straight: { a: Point; b: Point }[] = [];
  for (const e of entities) {
    if (e.type === "line") straight.push({ a: e.a, b: e.b });
    else if (e.type === "polyline") {
      for (const seg of polylineSegments(e)) {
        if (Math.abs(seg.bulge) < 1e-9) straight.push({ a: seg.a, b: seg.b });
      }
    }
  }
  const nearby = straight.filter((s) => {
    const minX = Math.min(s.a.x, s.b.x) - tol;
    const maxX = Math.max(s.a.x, s.b.x) + tol;
    const minY = Math.min(s.a.y, s.b.y) - tol;
    const maxY = Math.max(s.a.y, s.b.y) + tol;
    return cursor.x >= minX && cursor.x <= maxX && cursor.y >= minY && cursor.y <= maxY;
  });
  for (let i = 0; i < nearby.length; i++) {
    for (let j = i + 1; j < nearby.length; j++) {
      const hit = segmentIntersection(nearby[i].a, nearby[i].b, nearby[j].a, nearby[j].b);
      if (hit) featurePoints.push({ point: hit, kind: "intersection" });
    }
  }

  const snap = bestOf(featurePoints) ?? bestOf(midpoints) ?? bestOf(onCurve);
  if (snap) return snap;

  const step = gridStep(view.scale);
  return {
    point: {
      x: Math.round(cursor.x / step) * step,
      y: Math.round(cursor.y / step) * step,
    },
    kind: "grid",
  };
}
