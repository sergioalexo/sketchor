import type { Point } from "./geometry";
import { arcPointAt, rotatePoint } from "./geometry";

export type EntityId = string;

export interface LineEntity {
  id: EntityId;
  type: "line";
  /** Human-readable handle used in the sketch code view (e.g. "L1"). */
  name?: string;
  /** Layer this entity belongs to; absent means the default layer "0". */
  layer?: string;
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
  center: Point;
  radius: number;
  /** Radians. The arc runs from startAngle to endAngle; both map to real points via {@link arcPointAt}. */
  startAngle: number;
  endAngle: number;
  /** Sweep direction from startAngle to endAngle: true = counterclockwise (increasing angle), false = clockwise. */
  ccw: boolean;
}

/** The layer an entity is drawn on, defaulting to "0" (DXF convention). */
export function layerOf(entity: Entity): string {
  return entity.layer ?? DEFAULT_LAYER;
}

export const DEFAULT_LAYER = "0";

export type Entity = LineEntity | CircleEntity | ArcEntity;

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
  }
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
