import type { Point } from "./geometry";

export type EntityId = string;

export interface LineEntity {
  id: EntityId;
  type: "line";
  /** Human-readable handle used in the sketch code view (e.g. "L1"). */
  name?: string;
  a: Point;
  b: Point;
}

export interface CircleEntity {
  id: EntityId;
  type: "circle";
  /** Human-readable handle used in the sketch code view (e.g. "C1"). */
  name?: string;
  center: Point;
  radius: number;
}

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
