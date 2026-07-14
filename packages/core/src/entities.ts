import type { Point } from "./geometry";

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

/** The layer an entity is drawn on, defaulting to "0" (DXF convention). */
export function layerOf(entity: Entity): string {
  return entity.layer ?? DEFAULT_LAYER;
}

export const DEFAULT_LAYER = "0";

export type Entity = LineEntity | CircleEntity;

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
  }
}
