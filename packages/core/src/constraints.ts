import type { EntityId } from "./entities";

/**
 * The constraint model (R2 in the engineering brief) — data-model scaffold
 * for the future parametric layer. This module intentionally stops short
 * of a solver: integrating one (e.g. planegcs) and computing real
 * degrees-of-freedom from it is "the big lift" the brief calls out
 * separately. What's here is enough for constraints to be created, stored,
 * persisted, and undone; nothing yet reads them to move geometry.
 */
export type ConstraintId = string;

/** A reference to one of an entity's meaningful points. */
export interface PointRef {
  entityId: EntityId;
  point: "a" | "b" | "center";
}

export type Constraint =
  | { id: ConstraintId; type: "coincident"; a: PointRef; b: PointRef }
  | { id: ConstraintId; type: "horizontal"; entityId: EntityId }
  | { id: ConstraintId; type: "vertical"; entityId: EntityId }
  | { id: ConstraintId; type: "parallel"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "perpendicular"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "tangent"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "equal"; a: EntityId; b: EntityId }
  | { id: ConstraintId; type: "distance"; a: PointRef; b: PointRef; value: number }
  | { id: ConstraintId; type: "radius"; entityId: EntityId; value: number }
  | { id: ConstraintId; type: "angle"; a: EntityId; b: EntityId; value: number }
  | { id: ConstraintId; type: "fix"; entityId: EntityId };

let counter = 0;
export function newConstraintId(): ConstraintId {
  counter += 1;
  return `k${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Every entity id a constraint references — used to keep constraints in sync when entities are deleted. */
export function constraintEntityIds(c: Constraint): EntityId[] {
  switch (c.type) {
    case "coincident":
    case "distance":
      return [c.a.entityId, c.b.entityId];
    case "horizontal":
    case "vertical":
    case "radius":
    case "fix":
      return [c.entityId];
    case "parallel":
    case "perpendicular":
    case "tangent":
    case "equal":
    case "angle":
      return [c.a, c.b];
  }
}
