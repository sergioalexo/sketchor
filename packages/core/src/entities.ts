import type { Point } from "./geometry";
import { arcPointAt, arcSweep, bulgeToArc, dist, rotatePoint } from "./geometry";

export type EntityId = string;

export interface LineEntity {
  id: EntityId;
  type: "line";
  /** Human-readable handle used in the sketch code view (e.g. "L1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  a: Point;
  b: Point;
}

export interface CircleEntity {
  id: EntityId;
  type: "circle";
  /** Human-readable handle used in the sketch code view (e.g. "C1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  center: Point;
  radius: number;
}

export interface ArcEntity {
  id: EntityId;
  type: "arc";
  /** Human-readable handle used in the sketch code view (e.g. "A1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  center: Point;
  radius: number;
  /** Radians. The arc runs from startAngle to endAngle; both map to real points via {@link arcPointAt}. */
  startAngle: number;
  endAngle: number;
  /** Sweep direction from startAngle to endAngle: true = counterclockwise (increasing angle), false = clockwise. */
  ccw: boolean;
}

export interface PointEntity {
  id: EntityId;
  type: "point";
  /** Human-readable handle used in the sketch code view (e.g. "P1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  p: Point;
}

export interface PolylineEntity {
  id: EntityId;
  type: "polyline";
  /** Human-readable handle used in the sketch code view (e.g. "PL1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour). Absent = the theme's default entity colour. */
  color?: string;
  /**
   * Hatch-fill colour for closed shapes (a `closed` polyline or a circle);
   * ignored for open shapes. Absent = no fill. Set by the Fill/Hatch tool and
   * by plugins (e.g. the load planner colours pallets by order).
   */
  fill?: string;
  /** Ordered vertices. Does not repeat the first point when `closed`. */
  points: Point[];
  /**
   * Per-segment bulge (DXF convention): `bulges[i]` is the bulge of the
   * segment from `points[i]` to `points[i+1]` (wrapping to `points[0]` for
   * the closing segment when `closed`). 0 or absent = straight segment;
   * otherwise `tan(includedAngle / 4)`, signed by sweep direction — see
   * {@link bulgeToArc}. Absent entirely means every segment is straight.
   */
  bulges?: number[];
  /** True if the last vertex connects back to the first. */
  closed: boolean;
}

/** The layer an entity is drawn on, defaulting to "0" (DXF convention). */
export function layerOf(entity: Entity): string {
  return entity.layer ?? DEFAULT_LAYER;
}

export const DEFAULT_LAYER = "0";

export type Entity = LineEntity | CircleEntity | ArcEntity | PointEntity | PolylineEntity;

/** `entity.points[i]` to `entity.points[i+1]` for every segment, wrapping once more if `closed`. Bulge defaults to 0 (straight). */
export function polylineSegments(entity: PolylineEntity): { a: Point; b: Point; bulge: number }[] {
  const n = entity.points.length;
  const segCount = entity.closed ? n : n - 1;
  const segments: { a: Point; b: Point; bulge: number }[] = [];
  for (let i = 0; i < segCount; i++) {
    segments.push({
      a: entity.points[i],
      b: entity.points[(i + 1) % n],
      bulge: entity.bulges?.[i] ?? 0,
    });
  }
  return segments;
}

let counter = 0;

export function newEntityId(): EntityId {
  counter += 1;
  return `e${Date.now().toString(36)}${counter.toString(36)}`;
}

export function translated<T extends Entity>(entity: T, dx: number, dy: number): T {
  switch (entity.type) {
    case "line":
      return {
        ...entity,
        a: { x: entity.a.x + dx, y: entity.a.y + dy },
        b: { x: entity.b.x + dx, y: entity.b.y + dy },
      };
    case "circle":
      return {
        ...entity,
        center: { x: entity.center.x + dx, y: entity.center.y + dy },
      };
    case "arc":
      return {
        ...entity,
        center: { x: entity.center.x + dx, y: entity.center.y + dy },
      };
    case "point":
      return { ...entity, p: { x: entity.p.x + dx, y: entity.p.y + dy } };
    case "polyline":
      return { ...entity, points: entity.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

/**
 * Rotates an entity rigidly about `pivot` by `angle` radians. The shared
 * primitive behind the straighten tool and group rotation — one pivot, one
 * angle, applied to every point of the entity so shapes stay congruent.
 */
export function rotated<T extends Entity>(entity: T, pivot: Point, angle: number): T {
  switch (entity.type) {
    case "line":
      return { ...entity, a: rotatePoint(entity.a, pivot, angle), b: rotatePoint(entity.b, pivot, angle) };
    case "circle":
      return { ...entity, center: rotatePoint(entity.center, pivot, angle) };
    case "arc":
      return {
        ...entity,
        center: rotatePoint(entity.center, pivot, angle),
        startAngle: entity.startAngle + angle,
        endAngle: entity.endAngle + angle,
      };
    case "point":
      return { ...entity, p: rotatePoint(entity.p, pivot, angle) };
    case "polyline":
      // Bulge is a ratio of angle, not position, so it's unaffected by rotation.
      return { ...entity, points: entity.points.map((p) => rotatePoint(p, pivot, angle)) };
  }
}

/**
 * General rigid/uniform transform about `pivot`: scale, then rotate, then
 * translate by (dx, dy). Backs the `transform-entities` command that groups
 * (move/rotate as a unit) and the straighten tool both build on.
 */
export function transformed<T extends Entity>(
  entity: T,
  pivot: Point,
  dx: number,
  dy: number,
  rotation: number,
  scale: number,
): T {
  const movePoint = (p: Point): Point => {
    const scaled = { x: pivot.x + (p.x - pivot.x) * scale, y: pivot.y + (p.y - pivot.y) * scale };
    const rotatedP = rotatePoint(scaled, pivot, rotation);
    return { x: rotatedP.x + dx, y: rotatedP.y + dy };
  };
  switch (entity.type) {
    case "line":
      return { ...entity, a: movePoint(entity.a), b: movePoint(entity.b) };
    case "circle":
      return { ...entity, center: movePoint(entity.center), radius: entity.radius * scale };
    case "arc":
      return {
        ...entity,
        center: movePoint(entity.center),
        radius: entity.radius * scale,
        startAngle: entity.startAngle + rotation,
        endAngle: entity.endAngle + rotation,
      };
    case "point":
      return { ...entity, p: movePoint(entity.p) };
    case "polyline":
      // Uniform scale changes segment length but not the angle bulge encodes, so bulges carry over unchanged.
      return { ...entity, points: entity.points.map(movePoint) };
  }
}

/** The vertex/handle points of an entity, in world space — used for bounds, snapping, and centroids. */
export function entityPoints(entity: Entity): Point[] {
  switch (entity.type) {
    case "line":
      return [entity.a, entity.b];
    case "circle":
      return [
        { x: entity.center.x + entity.radius, y: entity.center.y },
        { x: entity.center.x - entity.radius, y: entity.center.y },
        { x: entity.center.x, y: entity.center.y + entity.radius },
        { x: entity.center.x, y: entity.center.y - entity.radius },
      ];
    case "arc":
      return [
        arcPointAt(entity.center, entity.radius, entity.startAngle),
        arcPointAt(entity.center, entity.radius, entity.endAngle),
      ];
    case "point":
      return [entity.p];
    case "polyline":
      return entity.points;
  }
}

/** Total run length of a polyline, following each segment's real curve (bulged segments contribute arc length, not chord length). */
export function polylineLength(entity: PolylineEntity): number {
  let total = 0;
  for (const seg of polylineSegments(entity)) {
    const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
    total += bulgeArc
      ? bulgeArc.radius * arcSweep(bulgeArc.startAngle, bulgeArc.endAngle, bulgeArc.ccw)
      : dist(seg.a, seg.b);
  }
  return total;
}

/** Arithmetic mean of every entity's defining points — the pivot the straighten tool and group-rotate use by default. */
export function centroidOfEntities(entities: Entity[]): Point {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const e of entities) {
    for (const p of entityPoints(e)) {
      sx += p.x;
      sy += p.y;
      n += 1;
    }
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}
