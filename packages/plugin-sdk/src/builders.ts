import { newEntityId } from "@sketchor/core";
import type {
  ArcEntity,
  CircleEntity,
  Command,
  Entity,
  EntityId,
  LineEntity,
  Point,
  PointEntity,
  PolylineEntity,
} from "@sketchor/core";

/**
 * Convenience builders so plugin authors write `line(a, b)` / `add(line(a, b))`
 * instead of hand-assembling entity records and raw command objects. Entity
 * ids are minted here via the core id generator; the resulting values are plain
 * data, safe to send over the RPC transport to `document.apply`.
 */

export interface EntityOptions {
  /** Human-readable handle shown in the sketch-code view. */
  name?: string;
  /** Layer name; omit for the default layer "0". */
  layer?: string;
  /** Stroke colour (any CSS colour); omit for the theme default. */
  color?: string;
  /** Hatch-fill colour for closed shapes; omit for no fill. */
  fill?: string;
}

function base(opts?: EntityOptions): { id: EntityId; name?: string; layer?: string; color?: string; fill?: string } {
  return {
    id: newEntityId(),
    ...(opts?.name !== undefined ? { name: opts.name } : {}),
    ...(opts?.layer !== undefined ? { layer: opts.layer } : {}),
    ...(opts?.color !== undefined ? { color: opts.color } : {}),
    ...(opts?.fill !== undefined ? { fill: opts.fill } : {}),
  };
}

export function line(a: Point, b: Point, opts?: EntityOptions): LineEntity {
  return { ...base(opts), type: "line", a, b };
}

export function circle(center: Point, radius: number, opts?: EntityOptions): CircleEntity {
  return { ...base(opts), type: "circle", center, radius };
}

export function arc(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  ccw = true,
  opts?: EntityOptions,
): ArcEntity {
  return { ...base(opts), type: "arc", center, radius, startAngle, endAngle, ccw };
}

export function point(p: Point, opts?: EntityOptions): PointEntity {
  return { ...base(opts), type: "point", p };
}

export function polyline(
  points: Point[],
  closed = false,
  opts?: EntityOptions & { bulges?: number[] },
): PolylineEntity {
  return {
    ...base(opts),
    type: "polyline",
    points,
    closed,
    ...(opts?.bulges ? { bulges: opts.bulges } : {}),
  };
}

/** Command builders mirroring the core `Command` union. */
export const cmd = {
  add: (entity: Entity): Command => ({ type: "add-entity", entity }),
  update: (entity: Entity): Command => ({ type: "update-entity", entity }),
  delete: (ids: EntityId[]): Command => ({ type: "delete-entities", ids }),
  move: (ids: EntityId[], dx: number, dy: number): Command => ({ type: "move-entities", ids, dx, dy }),
  batch: (commands: Command[]): Command => ({ type: "batch", commands }),
} as const;

/** Shorthand: the add-entity command for a freshly built entity. */
export const add = (entity: Entity): Command => cmd.add(entity);
