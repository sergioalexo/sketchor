import type { Entity } from "./entities";
import { dist, rotatePoint, type Point } from "./geometry";
import { curveEnd, curveLength, curveStart, entityFromPath, pathOf, subCurve } from "./intersect";

/**
 * Align and lengthen (roadmap T-24, T-23), as pure geometry.
 *
 * Align maps two source points onto two target points: translate the first
 * onto the first, rotate about it so the second lies on the ray to its
 * target, and optionally scale so it lands exactly — AutoCAD's ALIGN, the
 * general form of the straighten tool.
 *
 * Lengthen changes one end of a line or arc along its own curve: by a
 * delta, to a total length, or by a percentage.
 */

export interface AlignTransform {
  pivot: Point;
  dx: number;
  dy: number;
  rotation: number;
  scale: number;
}

/**
 * The rigid (or uniformly scaled) transform taking s1→t1 and s2 toward
 * t2. Expressed as `transform-entities` fields: scale and rotate about
 * `pivot` (= s1), then translate. Null when the source points coincide.
 */
export function alignTransform(s1: Point, s2: Point, t1: Point, t2: Point, scale: boolean): AlignTransform | null {
  const ls = dist(s1, s2);
  const lt = dist(t1, t2);
  if (ls < 1e-12 || lt < 1e-12) return null;
  const rotation = Math.atan2(t2.y - t1.y, t2.x - t1.x) - Math.atan2(s2.y - s1.y, s2.x - s1.x);
  return { pivot: s1, dx: t1.x - s1.x, dy: t1.y - s1.y, rotation, scale: scale ? lt / ls : 1 };
}

/** Where `p` lands under an align transform (for previews and tests). */
export function applyAlign(t: AlignTransform, p: Point): Point {
  const scaled = { x: t.pivot.x + (p.x - t.pivot.x) * t.scale, y: t.pivot.y + (p.y - t.pivot.y) * t.scale };
  const r = rotatePoint(scaled, t.pivot, t.rotation);
  return { x: r.x + t.dx, y: r.y + t.dy };
}

export type LengthenMode = { kind: "delta"; value: number } | { kind: "total"; value: number } | { kind: "percent"; value: number };

/**
 * A line or arc with the end nearest `near` moved along its own curve so
 * the entity's length changes per `mode`. Polylines lengthen their end
 * leg. Null for closed shapes, entities without a stroke, or a result
 * that would vanish.
 */
export function lengthen(entity: Entity, mode: LengthenMode, near: Point): Entity | null {
  const path = pathOf(entity);
  if (!path || path.closed) return null;
  const total = path.curves.reduce((a, c) => a + curveLength(c), 0);
  if (total <= 0) return null;
  let target: number;
  switch (mode.kind) {
    case "delta":
      target = total + mode.value;
      break;
    case "total":
      target = mode.value;
      break;
    case "percent":
      target = (total * mode.value) / 100;
      break;
  }
  const change = target - total;
  if (target <= 1e-9 || Math.abs(change) < 1e-12) return null;
  const first = path.curves[0];
  const last = path.curves[path.curves.length - 1];
  const atEnd = dist(near, curveEnd(last)) <= dist(near, curveStart(first));
  const c = atEnd ? last : first;
  const len = curveLength(c);
  if (len + change <= 1e-9) return null; // the end leg can't absorb it
  // For an arc, a full turn is the most it can grow.
  if (c.kind === "arc" && len + change > Math.PI * 2 * c.radius - 1e-9) return null;
  const curves = [...path.curves];
  const f = (len + change) / len;
  if (atEnd) curves[curves.length - 1] = subCurve(c, 0, f);
  else curves[0] = subCurve(c, 1 - f, 1);
  return entityFromPath({ curves, closed: false }, entity, entity.id);
}
