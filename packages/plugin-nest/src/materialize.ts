import { newEntityId, rotated, translated, type Entity } from "@sketchor/core";
import type { Point } from "./types";

/**
 * Where one nested instance of a part sits: a rigid mirror (optional) then
 * rotation then translation, all about the world origin — callers normalize
 * a part's original geometry to its own local origin first (as
 * `plugin-nest/geometry.ts`'s `normalize()` already does for the bbox
 * engine), the same convention {@link materializeInstance} assumes.
 */
export interface InstanceTransform {
  rotationDeg: number;
  translation: Point;
  mirrored?: boolean;
}

const ORIGIN: Point = { x: 0, y: 0 };

/**
 * Applies an {@link InstanceTransform} to a part's *original* entities (not
 * its flattened polygon), so the result keeps real arcs/bulges — the point
 * of N-02. Fresh ids: a part nested onto several sheets materializes into
 * several independent entities, never sharing an id with the source or with
 * each other.
 */
export function materializeInstance(originalEntities: Entity[], transform: InstanceTransform): Entity[] {
  const rotationRad = (transform.rotationDeg * Math.PI) / 180;
  return originalEntities.map((entity) => {
    let out: Entity = transform.mirrored ? mirrorX(entity) : entity;
    out = rotated(out, ORIGIN, rotationRad);
    out = translated(out, transform.translation.x, transform.translation.y);
    return { ...out, id: newEntityId() };
  });
}

/**
 * Reflects an entity across x = 0. A reflection reverses orientation, so an
 * arc's sweep direction flips and a polyline's bulges (signed by sweep
 * direction) negate — only mirroring the points would leave the curve
 * bulging into the wrong side.
 */
function mirrorX<T extends Entity>(entity: T): T {
  switch (entity.type) {
    case "line":
      return { ...entity, a: { x: -entity.a.x, y: entity.a.y }, b: { x: -entity.b.x, y: entity.b.y } };
    case "circle":
      return { ...entity, center: { x: -entity.center.x, y: entity.center.y } };
    case "arc":
      return {
        ...entity,
        center: { x: -entity.center.x, y: entity.center.y },
        startAngle: Math.PI - entity.startAngle,
        endAngle: Math.PI - entity.endAngle,
        ccw: !entity.ccw,
      };
    case "point":
      return { ...entity, p: { x: -entity.p.x, y: entity.p.y } };
    case "polyline":
      return {
        ...entity,
        points: entity.points.map((p) => ({ x: -p.x, y: p.y })),
        bulges: entity.bulges?.map((b) => -b),
      };
    case "text":
      return { ...entity, at: { x: -entity.at.x, y: entity.at.y } };
    case "image":
      return { ...entity, insert: { x: -entity.insert.x, y: entity.insert.y } };
  }
}
