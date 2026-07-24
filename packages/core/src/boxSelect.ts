import type { Bounds } from "./dxf";
import { boundsOf } from "./dxf";
import type { Entity, EntityId } from "./entities";
import type { Point } from "./geometry";
import { dist } from "./geometry";

/**
 * Drag-select semantics matching every mainstream CAD app: a window
 * selection (dragged left-to-right) picks only entities entirely inside the
 * box; a crossing selection (dragged right-to-left) also picks anything the
 * box merely touches. The direction itself is decided by the caller (screen
 * x of the drag) — this module only answers "does this entity qualify?"
 * for a given box and mode.
 */
export type BoxSelectMode = "window" | "crossing";

function pointInBounds(p: Point, box: Bounds): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

function boundsWithin(inner: Bounds, box: Bounds): boolean {
  return inner.minX >= box.minX && inner.maxX <= box.maxX && inner.minY >= box.minY && inner.maxY <= box.maxY;
}

/** Standard orientation-based segment/segment intersection test. */
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function boxCorners(box: Bounds): [Point, Point, Point, Point] {
  return [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
}

function segmentCrossesBox(a: Point, b: Point, box: Bounds): boolean {
  if (pointInBounds(a, box) || pointInBounds(b, box)) return true;
  const corners = boxCorners(box);
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

/** True if a circle of `radius` about `center` passes through (touches or crosses) the box's area. */
function circleCrossesBox(center: Point, radius: number, box: Bounds): boolean {
  const clampedX = Math.max(box.minX, Math.min(center.x, box.maxX));
  const clampedY = Math.max(box.minY, Math.min(center.y, box.maxY));
  const minDist = dist(center, { x: clampedX, y: clampedY });
  const maxDist = Math.max(...boxCorners(box).map((c) => dist(center, c)));
  return minDist <= radius && radius <= maxDist;
}

/** Whether `entity` qualifies for selection under `box`/`mode`. Entities with degenerate/empty bounds never qualify. */
export function entityInBox(entity: Entity, box: Bounds, mode: BoxSelectMode): boolean {
  const eb = boundsOf([entity]);
  if (!eb) return false;

  if (mode === "window") return boundsWithin(eb, box);

  // Crossing: fully inside also counts, plus anything the box actually touches.
  if (boundsWithin(eb, box)) return true;
  switch (entity.type) {
    case "point":
      return pointInBounds(entity.p, box);
    case "line":
      return segmentCrossesBox(entity.a, entity.b, box);
    case "circle":
      return circleCrossesBox(entity.center, entity.radius, box);
    case "arc":
      // Approximated as its full circle — simpler and a reasonable, slightly
      // generous match for how crossing-select behaves on curved entities.
      return circleCrossesBox(entity.center, entity.radius, box);
  }
}

/** Every entity id in `entities` that qualifies for selection under `box`/`mode`. */
export function entitiesInBox(entities: Entity[], box: Bounds, mode: BoxSelectMode): EntityId[] {
  return entities.filter((e) => entityInBox(e, box, mode)).map((e) => e.id);
}
