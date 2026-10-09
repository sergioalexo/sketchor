import type { Constraint } from "../constraints";
import type { DimensionEntity, Entity, EntityId } from "../entities";
import type { Point } from "../geometry";
import { angular2Rays } from "./layout";
import { resolveGeometry } from "./resolve";

/**
 * D-02b: a driving dimension IS a solver constraint. There is no separate
 * constraint record — `SketchDocument.solverConstraints()` derives one from
 * every driving dimension the solver can express, so the dimension's `value`
 * is the one source of truth and editing it moves the geometry.
 *
 * What can drive: a linear dimension between two anchored points, horizontal
 * or vertical (`distance` with an axis); an aligned dimension (`distance`);
 * radial / jogged / diametric on a circle or arc (`radius`); angular between
 * two lines (`angle`). Everything else (3-point angles, arc length, ordinate)
 * stays a reference — `canDrive` says why.
 */

type Lookup = (id: EntityId) => Entity | undefined;

export const dimConstraintId = (dimId: EntityId): string => `dim:${dimId}`;

const isAxis = (angle: number): "x" | "y" | null => {
  const q = ((angle % Math.PI) + Math.PI) % Math.PI;
  if (q < 1e-6 || Math.PI - q < 1e-6) return "x";
  if (Math.abs(q - Math.PI / 2) < 1e-6) return "y";
  return null;
};

/** Why `e` cannot drive geometry, or null when it can (given the current document). */
export function cannotDrive(e: DimensionEntity, lookup: Lookup): string | null {
  switch (e.kind) {
    case "linear":
      if (!e.refs?.[0] || !e.refs[1]) return "Attach both ends of the dimension to geometry first";
      if (!isAxis(e.angle ?? 0)) return "Only horizontal and vertical linear dimensions can drive";
      return null;
    case "aligned":
      return e.refs?.[0] && e.refs[1] ? null : "Attach both ends of the dimension to geometry first";
    case "radial":
    case "diametric":
    case "jogged": {
      const t = e.target ? lookup(e.target) : undefined;
      return t && (t.type === "circle" || t.type === "arc") ? null : "Dimension a circle or arc to make it drive";
    }
    case "angular2l": {
      const a = e.targets ? lookup(e.targets[0]) : undefined;
      const b = e.targets ? lookup(e.targets[1]) : undefined;
      return a?.type === "line" && b?.type === "line" ? null : "Dimension two lines to make the angle drive";
    }
    default:
      return "This kind of dimension is reference only";
  }
}

/** The constraint a driving dimension stands for, or null when it is a reference / cannot be expressed / has no usable value. */
export function dimensionConstraint(e: DimensionEntity, lookup: Lookup): Constraint | null {
  if (!e.driving || e.value === undefined || !Number.isFinite(e.value) || e.value <= 0) return null;
  if (cannotDrive(e, lookup)) return null;
  const id = dimConstraintId(e.id);
  switch (e.kind) {
    case "linear":
      return { id, type: "distance", a: e.refs![0]!, b: e.refs![1]!, value: e.value, axis: isAxis(e.angle ?? 0)! };
    case "aligned":
      return { id, type: "distance", a: e.refs![0]!, b: e.refs![1]!, value: e.value };
    case "radial":
    case "jogged":
      return { id, type: "radius", entityId: e.target!, value: e.value };
    case "diametric":
      return { id, type: "radius", entityId: e.target!, value: e.value / 2 };
    case "angular2l": {
      const geo = resolveGeometry(e, lookup);
      const rays = angular2Rays(geo.pts);
      if (!rays) return null;
      const la = lookup(e.targets![0]);
      const lb = lookup(e.targets![1]);
      if (la?.type !== "line" || lb?.type !== "line") return null;
      const dir = (l: { a: Point; b: Point }) => ({ x: l.b.x - l.a.x, y: l.b.y - l.a.y });
      const d1 = dir(la);
      const d2 = dir(lb);
      const s1 = rays.d1.x * d1.x + rays.d1.y * d1.y >= 0 ? 1 : -1;
      const s2 = rays.d2.x * d2.x + rays.d2.y * d2.y >= 0 ? 1 : -1;
      // Orientation of the measured sector (ccw from ray 1 to ray 2 is positive) and the half-turn lost when a line is read against its ray.
      const ori = rays.d1.x * rays.d2.y - rays.d1.y * rays.d2.x >= 0 ? 1 : -1;
      return { id, type: "angle", a: e.targets![0], b: e.targets![1], value: ori * e.value + (s1 * s2 < 0 ? Math.PI : 0) };
    }
    default:
      return null;
  }
}

/** Every constraint the driving dimensions of `entities` stand for. */
export function drivingConstraints(entities: Iterable<Entity>, lookup: Lookup): Constraint[] {
  const out: Constraint[] = [];
  for (const e of entities) {
    if (e.type !== "dimension") continue;
    const c = dimensionConstraint(e, lookup);
    if (c) out.push(c);
  }
  return out;
}
