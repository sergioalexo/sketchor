import type { Point } from "./geometry";

export type EntityId = string;

/**
 * The one entity shape a plugin can draw with, v1. Mirrors
 * `@sketchor/core`'s `PolylineEntity` field-for-field, so a value built
 * here is a real `add-entity` command's entity once it crosses into the
 * host — no translation, just structural typing. Trimmed to `polyline`
 * only because that's every shape a v1 plugin actually needs (rectangles,
 * outlines); grow this union the day a plugin needs a line, circle, or
 * arc, mirroring the new variant from core the same way.
 */
export interface PolylineEntity {
  id: EntityId;
  type: "polyline";
  name?: string;
  layer?: string;
  points: Point[];
  bulges?: number[];
  closed: boolean;
}

export type Entity = PolylineEntity;
