import type { Entity } from "./entities";
import type { Point } from "./geometry";
import { kindTransform } from "./kinds/registry";

/**
 * Reflection of an entity across the line through `a` and `b` (the mirror
 * tool, roadmap T-14). Every point is reflected; an arc's angles are
 * reflected too and its sweep direction flips; a polyline's bulges change
 * sign for the same reason (the same trick dxf.ts uses for a negative
 * INSERT scale). Text and images are mirrored *by position only* — the
 * glyphs stay readable and the raster isn't flipped, AutoCAD's
 * `MIRRTEXT=0` behaviour — so their insertion point moves and their own
 * rotation is left alone.
 *
 * A degenerate axis (a == b) mirrors nothing and returns the entity as is.
 */
export function mirrored<T extends Entity>(entity: T, a: Point, b: Point): T {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return entity;
  const ux = dx / Math.sqrt(len2);
  const uy = dy / Math.sqrt(len2);
  const reflect = (p: Point): Point => {
    // Component along the axis stays; the perpendicular component flips.
    const px = p.x - a.x;
    const py = p.y - a.y;
    const along = px * ux + py * uy;
    const rx = 2 * along * ux - px;
    const ry = 2 * along * uy - py;
    return { x: a.x + rx, y: a.y + ry };
  };
  const axisAngle = Math.atan2(uy, ux);
  const reflectAngle = (t: number) => 2 * axisAngle - t;

  switch (entity.type) {
    case "line":
      return { ...entity, a: reflect(entity.a), b: reflect(entity.b) };
    case "circle":
      return { ...entity, center: reflect(entity.center) };
    case "arc":
      return {
        ...entity,
        center: reflect(entity.center),
        startAngle: reflectAngle(entity.startAngle),
        endAngle: reflectAngle(entity.endAngle),
        ccw: !entity.ccw,
      };
    case "point":
      return { ...entity, p: reflect(entity.p) };
    case "polyline":
      return {
        ...entity,
        points: entity.points.map(reflect),
        ...(entity.bulges ? { bulges: entity.bulges.map((v) => -v) } : {}),
      };
    case "text":
      return { ...entity, at: reflect(entity.at) };
    case "image":
      return { ...entity, insert: reflect(entity.insert) };
    default: {
      // A kind outside the built-in seven: reflect through its affine map (unchanged if it has none).
      const c = Math.cos(2 * axisAngle);
      const sn = Math.sin(2 * axisAngle);
      const r0 = reflect({ x: 0, y: 0 });
      return (kindTransform(entity as Entity, [c, sn, sn, -c, r0.x, r0.y]) ?? entity) as T;
    }
  }
}
