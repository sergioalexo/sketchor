import type { Bounds } from "./dxf";
import type { Entity } from "./entities";
import { imageCorners, translated } from "./entities";
import { arcPointAt, dist, type Point } from "./geometry";

/**
 * Stretch (roadmap T-18): the AutoCAD tool that makes "lengthen this
 * bracket by 20" a two-click job. Every defining point inside the crossing
 * box moves by the offset; points outside stay. An entity with all its
 * points inside moves whole; a circle moves with its center; a text or
 * image moves with its insertion point. An arc with one end inside keeps
 * its radius (grown only if the new chord no longer fits) and gets a new
 * center so both ends still lie on it — the other end doesn't move.
 */

function inside(p: Point, box: Bounds): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

/** The entity after stretching, or null when nothing of it was inside the box. */
export function stretchEntity(e: Entity, box: Bounds, dx: number, dy: number): Entity | null {
  const move = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  switch (e.type) {
    case "line": {
      const a = inside(e.a, box);
      const b = inside(e.b, box);
      if (!a && !b) return null;
      return { ...e, a: a ? move(e.a) : e.a, b: b ? move(e.b) : e.b };
    }
    case "polyline": {
      const flags = e.points.map((p) => inside(p, box));
      if (!flags.some(Boolean)) return null;
      return { ...e, points: e.points.map((p, i) => (flags[i] ? move(p) : p)) };
    }
    case "circle":
      return inside(e.center, box) ? translated(e, dx, dy) : null;
    case "arc": {
      const s = arcPointAt(e.center, e.radius, e.startAngle);
      const t = arcPointAt(e.center, e.radius, e.endAngle);
      const sIn = inside(s, box);
      const tIn = inside(t, box);
      if (!sIn && !tIn) return null;
      if (sIn && tIn) return translated(e, dx, dy);
      const ns = sIn ? move(s) : s;
      const nt = tIn ? move(t) : t;
      return arcThrough(e, ns, nt);
    }
    case "point":
      return inside(e.p, box) ? translated(e, dx, dy) : null;
    case "text":
      return inside(e.at, box) ? translated(e, dx, dy) : null;
    case "image":
      return imageCorners(e).some((p) => inside(p, box)) ? translated(e, dx, dy) : null;
  }
}

/** The arc with the same radius (grown to fit if needed) and sweep sense through two new end points. */
function arcThrough(e: Extract<Entity, { type: "arc" }>, s: Point, t: Point): Entity {
  const chord = dist(s, t);
  if (chord < 1e-9) return e;
  const radius = Math.max(e.radius, chord / 2);
  const mx = (s.x + t.x) / 2;
  const my = (s.y + t.y) / 2;
  const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
  const nx = -(t.y - s.y) / chord;
  const ny = (t.x - s.x) / chord;
  const c1 = { x: mx + nx * h, y: my + ny * h };
  const c2 = { x: mx - nx * h, y: my - ny * h };
  // Of the two centers, keep the one on the same side of the chord as before (nearest the old center).
  const center = dist(c1, e.center) <= dist(c2, e.center) ? c1 : c2;
  return {
    ...e,
    center,
    radius,
    startAngle: Math.atan2(s.y - center.y, s.x - center.x),
    endAngle: Math.atan2(t.y - center.y, t.x - center.x),
  };
}

/** Stretches every entity that has something inside the box; entities untouched by the box are omitted. */
export function stretchEntities(entities: Entity[], box: Bounds, dx: number, dy: number): Entity[] {
  const out: Entity[] = [];
  for (const e of entities) {
    const r = stretchEntity(e, box, dx, dy);
    if (r) out.push(r);
  }
  return out;
}
