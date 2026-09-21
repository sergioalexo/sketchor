import type { Entity } from "./entities";
import { imageCorners } from "./entities";
import { arcPointAt, arcSweep, dist, type Point } from "./geometry";

/**
 * Grips (roadmap T-27): the handles drawn on a selected entity and what
 * dragging each one does. AutoCAD's model — an endpoint grip stretches
 * that end, a midpoint/center grip moves the whole entity, a circle's
 * quadrant grip changes the radius, an arc's end grip changes that end's
 * angle, a polyline vertex grip moves that vertex — resolved here as pure
 * "the entity with this grip at that point" functions so the viewport only
 * has to draw squares and drag one.
 */

export type GripKind = "end" | "mid" | "center" | "quadrant" | "vertex" | "insert";

export interface Grip {
  point: Point;
  kind: GripKind;
  /** Which end / vertex / quadrant this is, for `applyGrip`. */
  index: number;
}

export function gripsOf(e: Entity): Grip[] {
  switch (e.type) {
    case "line":
      return [
        { point: e.a, kind: "end", index: 0 },
        { point: e.b, kind: "end", index: 1 },
        { point: { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 }, kind: "mid", index: 0 },
      ];
    case "circle": {
      const { center: c, radius: r } = e;
      return [
        { point: c, kind: "center", index: 0 },
        { point: { x: c.x + r, y: c.y }, kind: "quadrant", index: 0 },
        { point: { x: c.x, y: c.y + r }, kind: "quadrant", index: 1 },
        { point: { x: c.x - r, y: c.y }, kind: "quadrant", index: 2 },
        { point: { x: c.x, y: c.y - r }, kind: "quadrant", index: 3 },
      ];
    }
    case "arc": {
      const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
      const midAngle = e.ccw ? e.startAngle + sweep / 2 : e.startAngle - sweep / 2;
      return [
        { point: arcPointAt(e.center, e.radius, e.startAngle), kind: "end", index: 0 },
        { point: arcPointAt(e.center, e.radius, e.endAngle), kind: "end", index: 1 },
        { point: arcPointAt(e.center, e.radius, midAngle), kind: "mid", index: 0 },
        { point: e.center, kind: "center", index: 0 },
      ];
    }
    case "polyline":
      return e.points.map((p, i) => ({ point: p, kind: "vertex" as const, index: i }));
    case "point":
      return [{ point: e.p, kind: "insert", index: 0 }];
    case "text":
      return [{ point: e.at, kind: "insert", index: 0 }];
    case "image":
      return [{ point: e.insert, kind: "insert", index: 0 }, ...imageCorners(e).slice(1, 3).map((p, i) => ({ point: p, kind: "vertex" as const, index: i + 1 }))];
  }
}

/**
 * The entity after dragging `grip` to `to`. Moves the whole entity for
 * mid/center/insert grips; stretches one end, one vertex, or the radius
 * otherwise. An image's far corners resize it about the insertion point.
 */
export function applyGrip(e: Entity, grip: Grip, to: Point): Entity {
  const dx = to.x - grip.point.x;
  const dy = to.y - grip.point.y;
  const shift = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  switch (e.type) {
    case "line":
      if (grip.kind === "mid") return { ...e, a: shift(e.a), b: shift(e.b) };
      return grip.index === 0 ? { ...e, a: to } : { ...e, b: to };
    case "circle":
      if (grip.kind === "center") return { ...e, center: to };
      return { ...e, radius: Math.max(1e-9, dist(e.center, to)) };
    case "arc": {
      if (grip.kind === "center" || grip.kind === "mid") return { ...e, center: shift(e.center) };
      const angle = Math.atan2(to.y - e.center.y, to.x - e.center.x);
      // Dragging an end changes its angle only; the radius stays (AutoCAD stretches the arc, it doesn't resize it).
      return grip.index === 0 ? { ...e, startAngle: angle } : { ...e, endAngle: angle };
    }
    case "polyline":
      return { ...e, points: e.points.map((p, i) => (i === grip.index ? to : p)) };
    case "point":
      return { ...e, p: to };
    case "text":
      return { ...e, at: to };
    case "image": {
      if (grip.kind === "insert") return { ...e, insert: to };
      // Corner grips: size along the image's own axes.
      const cos = Math.cos(e.rotation);
      const sin = Math.sin(e.rotation);
      const lx = (to.x - e.insert.x) * cos + (to.y - e.insert.y) * sin;
      const ly = -(to.x - e.insert.x) * sin + (to.y - e.insert.y) * cos;
      if (grip.index === 1) return { ...e, width: Math.max(1e-6, lx) };
      return { ...e, width: Math.max(1e-6, lx), height: Math.max(1e-6, ly) };
    }
  }
}
