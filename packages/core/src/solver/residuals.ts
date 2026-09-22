import type { Constraint, ConstraintId } from "../constraints";
import { centerOf, directionOf, pointOf, radiusOf, type SketchModel } from "./model";
import {
  add,
  atan2Num,
  cross,
  distanceNum,
  div,
  dot,
  konst,
  length,
  mul,
  sub,
  vsub,
  type Num,
  type Vec,
} from "./num";

/**
 * Constraints as equations the solver drives to zero.
 *
 * Every row is written so that **zero means satisfied and the units are
 * length or radians** — a distance residual is "how far off in mm", an
 * angular one "how far off in radians". Mixing scales (an unnormalised
 * cross product is mm², and grows with the size of the drawing) is what
 * makes a least-squares solver favour whichever constraint happens to be
 * on the biggest geometry, so parallel/perpendicular divide through by the
 * lengths and become a sine or a cosine of the misalignment.
 */

export interface Row {
  /** Which constraint produced this equation — for reporting conflicts. */
  constraint: ConstraintId;
  residual: Num;
}

/** sin of the angle between two vectors: zero when parallel, scale-free. */
function sinBetween(u: Vec, v: Vec): Num {
  const denom = mul(length(u), length(v));
  return div(cross(u, v), denom.v < 1e-12 ? konst(1e-12) : denom);
}

/** cos of the angle between two vectors: zero when perpendicular, scale-free. */
function cosBetween(u: Vec, v: Vec): Num {
  const denom = mul(length(u), length(v));
  return div(dot(u, v), denom.v < 1e-12 ? konst(1e-12) : denom);
}

/** The signed distance from a point to the infinite line through `a` with direction `d`. */
function pointToLine(p: Vec, a: Vec, d: Vec): Num {
  const len = length(d);
  return div(cross(d, vsub(p, a)), len.v < 1e-12 ? konst(1e-12) : len);
}

/**
 * The equations one constraint contributes, or `[]` when it references
 * geometry the solver can't move (a constraint on a text label, or on an
 * entity that has since been deleted). A constraint that produces no rows
 * also counts for nothing in the degrees-of-freedom tally, which is the
 * honest answer — it isn't constraining anything.
 */
export function rowsFor(model: SketchModel, c: Constraint): Row[] {
  const row = (residual: Num): Row => ({ constraint: c.id, residual });
  switch (c.type) {
    case "coincident": {
      const a = pointOf(model, c.a);
      const b = pointOf(model, c.b);
      if (!a || !b) return [];
      return [row(sub(a.x, b.x)), row(sub(a.y, b.y))];
    }
    case "horizontal": {
      const d = directionOf(model, c.entityId);
      return d ? [row(d.y)] : [];
    }
    case "vertical": {
      const d = directionOf(model, c.entityId);
      return d ? [row(d.x)] : [];
    }
    case "parallel": {
      const u = directionOf(model, c.a);
      const v = directionOf(model, c.b);
      return u && v ? [row(sinBetween(u, v))] : [];
    }
    case "perpendicular": {
      const u = directionOf(model, c.a);
      const v = directionOf(model, c.b);
      return u && v ? [row(cosBetween(u, v))] : [];
    }
    case "angle": {
      const u = directionOf(model, c.a);
      const v = directionOf(model, c.b);
      if (!u || !v) return [];
      // atan2 of the cross over the dot is the signed angle between them.
      // The difference is then shifted by whole turns to the nearest
      // equivalent angle: the shift is a constant, so it costs no
      // derivative, and it stops a residual of 2π−ε driving the solver the
      // long way round.
      const between = atan2Num(cross(u, v), dot(u, v));
      const diff = sub(between, konst(c.value));
      return [row(sub(diff, konst(Math.round(diff.v / (Math.PI * 2)) * Math.PI * 2)))];
    }
    case "distance": {
      const a = pointOf(model, c.a);
      const b = pointOf(model, c.b);
      if (!a || !b) return [];
      return [row(sub(distanceNum(a, b), konst(c.value)))];
    }
    case "radius": {
      const r = radiusOf(model, c.entityId);
      return r ? [row(sub(r, konst(c.value)))] : [];
    }
    case "equal": {
      const ra = radiusOf(model, c.a);
      const rb = radiusOf(model, c.b);
      if (ra && rb) return [row(sub(ra, rb))];
      const da = directionOf(model, c.a);
      const db = directionOf(model, c.b);
      if (da && db) return [row(sub(length(da), length(db)))];
      return [];
    }
    case "tangent": {
      const ca = centerOf(model, c.a);
      const ra = radiusOf(model, c.a);
      const cb = centerOf(model, c.b);
      const rb = radiusOf(model, c.b);
      if (ca && ra && cb && rb) {
        // Two circles: keep whichever tangency they are nearer to now —
        // outside (centres apart by r₁+r₂) or inside (by |r₁−r₂|).
        const between = distanceNum(ca, cb);
        const outside = Math.abs(between.v - (ra.v + rb.v));
        const inside = Math.abs(between.v - Math.abs(ra.v - rb.v));
        if (outside <= inside) return [row(sub(between, add(ra, rb)))];
        return [row(sub(between, ra.v >= rb.v ? sub(ra, rb) : sub(rb, ra)))];
      }
      // A line and a circle: the centre sits exactly a radius off the line.
      const circleId = ca && ra ? c.a : cb && rb ? c.b : null;
      const lineId = circleId === c.a ? c.b : c.a;
      const center = circleId === c.a ? ca : cb;
      const radius = circleId === c.a ? ra : rb;
      const d = directionOf(model, lineId);
      const at = pointOf(model, { entityId: lineId, point: "a" });
      if (!center || !radius || !d || !at) return [];
      const signed = pointToLine(center, at, d);
      // Signed, so the circle stays on the side it is on rather than
      // flipping through the line to reach the nearest solution.
      return [row(signed.v >= 0 ? sub(signed, radius) : add(signed, radius))];
    }
    case "fix":
      // Handled by freezing the entity's parameters (see model.ts), which
      // removes degrees of freedom instead of adding equations.
      return [];
  }
}

/** Every equation for a whole sketch, in constraint order. */
export function allRows(model: SketchModel, constraints: readonly Constraint[]): Row[] {
  const rows: Row[] = [];
  for (const c of constraints) rows.push(...rowsFor(model, c));
  return rows;
}
