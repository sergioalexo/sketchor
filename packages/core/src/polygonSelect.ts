import type { Entity, EntityId } from "./entities";
import { imageCorners, polylineSegments, textCorners } from "./entities";
import type { Point } from "./geometry";
import { arcPointAt, arcSweep, bulgeToArc } from "./geometry";
import { pointInPolygon } from "./regions";

/**
 * Selection by an arbitrary polygon or open path — the lasso and fence that
 * sit beside the rectangular box select (`boxSelect.ts`).
 *
 * A **lasso** is a closed polygon the user scribbles: like a box, dragging
 * it left-to-right takes only what is entirely inside (window), and
 * right-to-left also takes whatever it touches (crossing). A **fence** is an
 * open path that selects everything it *crosses* — the way you grab twenty
 * parallel lines in one stroke without enclosing any of them.
 *
 * Curves are compared as sampled polylines, the same approximation
 * `boxSelect.ts` makes: a lasso is a freehand gesture, and a tolerance of a
 * fraction of a degree of arc is below what the hand that drew it meant.
 */

export type PolygonSelectMode = "window" | "crossing";

/** How finely a full circle is sampled when it is tested against a lasso. */
const CIRCLE_STEPS = 64;

/**
 * The polyline stand-in for an entity: the points a lasso/fence is tested
 * against. `closed` says whether the last point joins the first, which
 * matters only for the segments walked, not for containment.
 */
export function outlineOf(entity: Entity): { points: Point[]; closed: boolean } {
  switch (entity.type) {
    case "point":
      return { points: [entity.p], closed: false };
    case "line":
      return { points: [entity.a, entity.b], closed: false };
    case "circle":
      return { points: sampleArc(entity.center, entity.radius, 0, Math.PI * 2, true, CIRCLE_STEPS), closed: true };
    case "arc":
      return {
        points: sampleArc(
          entity.center,
          entity.radius,
          entity.startAngle,
          entity.endAngle,
          entity.ccw,
          arcSteps(arcSweep(entity.startAngle, entity.endAngle, entity.ccw)),
        ),
        closed: false,
      };
    case "polyline": {
      const points: Point[] = [];
      for (const seg of polylineSegments(entity)) {
        const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
        if (!arc) {
          points.push(seg.a);
          continue;
        }
        const sweep = arcSweep(arc.startAngle, arc.endAngle, arc.ccw);
        points.push(...sampleArc(arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw, arcSteps(sweep)).slice(0, -1));
      }
      if (!entity.closed) points.push(entity.points[entity.points.length - 1]);
      return { points, closed: entity.closed };
    }
    case "text":
      return { points: textCorners(entity), closed: true };
    case "image":
      return { points: imageCorners(entity), closed: true };
  }
}

function arcSteps(sweep: number): number {
  return Math.max(4, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * CIRCLE_STEPS));
}

/** `steps + 1` points along the arc, so the last one lands exactly on the end angle. */
function sampleArc(center: Point, radius: number, start: number, end: number, ccw: boolean, steps: number): Point[] {
  const sweep = arcSweep(start, end, ccw) * (ccw ? 1 : -1);
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) out.push(arcPointAt(center, radius, start + (sweep * i) / steps));
  return out;
}

/**
 * Segment/segment intersection, **touching included**: a stroke that lands
 * exactly on a vertex has still crossed the thing. That case is not exotic
 * here — a sampled circle always has a vertex at each end of its horizontal
 * diameter, which is exactly where a horizontal fence stroke meets it.
 */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Collinear or endpoint-on-segment: check the point actually lies within
  // the other segment's extent rather than merely on its infinite line.
  if (d1 === 0 && within(c, d, a)) return true;
  if (d2 === 0 && within(c, d, b)) return true;
  if (d3 === 0 && within(a, b, c)) return true;
  if (d4 === 0 && within(a, b, d)) return true;
  return false;
}

/** Whether `p`, already known to be on the line through `a`–`b`, lies between them. */
function within(a: Point, b: Point, p: Point): boolean {
  return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

/** Walks the segments of a path, closing it when asked. */
function* segmentsOf(points: Point[], closed: boolean): Generator<[Point, Point]> {
  const n = points.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) yield [points[i], points[(i + 1) % n]];
}

/** Whether `entity` qualifies for selection inside `polygon` under `mode`. A polygon of fewer than 3 points never matches. */
export function entityInPolygon(entity: Entity, polygon: Point[], mode: PolygonSelectMode): boolean {
  if (polygon.length < 3) return false;
  const outline = outlineOf(entity);
  if (outline.points.length === 0) return false;
  const inside = outline.points.map((p) => pointInPolygon(p, polygon));
  if (mode === "window") return inside.every(Boolean);
  if (inside.some(Boolean)) return true;
  // Nothing inside: it still counts if the outline cuts across the lasso.
  for (const [a, b] of segmentsOf(outline.points, outline.closed)) {
    for (const [c, d] of segmentsOf(polygon, true)) {
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Every entity id qualifying inside `polygon` under `mode`. */
export function entitiesInPolygon(entities: Entity[], polygon: Point[], mode: PolygonSelectMode): EntityId[] {
  return entities.filter((e) => entityInPolygon(e, polygon, mode)).map((e) => e.id);
}

/** Whether the open path `fence` crosses `entity`. A point entity can't be crossed, only enclosed, so it never matches. */
export function entityCrossedByFence(entity: Entity, fence: Point[]): boolean {
  if (fence.length < 2) return false;
  const outline = outlineOf(entity);
  if (outline.points.length < 2) return false;
  for (const [a, b] of segmentsOf(outline.points, outline.closed)) {
    for (const [c, d] of segmentsOf(fence, false)) {
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Every entity id the open path `fence` crosses. */
export function entitiesCrossedByFence(entities: Entity[], fence: Point[]): EntityId[] {
  return entities.filter((e) => entityCrossedByFence(e, fence)).map((e) => e.id);
}

/**
 * Thins a freehand screen path to the points worth keeping (Ramer–Douglas–Peucker).
 * A drag emits a point per pointermove — hundreds for one lasso — and every
 * one of them is an edge each entity gets tested against.
 */
export function simplifyPath(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let at = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = true;
      stack.push([first, at], [at, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / len;
}
