import type { Entity, EntityId } from "./entities";
import { newEntityId, transformed, translated } from "./entities";
import { rotatePoint, type Point } from "./geometry";
import type { Command } from "./commands";
import type { SketchDocument } from "./document";

/**
 * Patterns (arrays): repeat a selection in a grid or around a circle. Every
 * copy is a genuinely new entity produced through `add-entity` commands, so a
 * pattern is one undoable step and the copies are independently editable
 * afterwards — there's no live "array object" linking them back to the source.
 *
 * The source entities are left untouched and are not counted as a copy: a
 * 3x2 rectangular pattern yields 6 total (5 new), matching how CAD tools
 * count array instances.
 */

export interface RectangularPattern {
  kind: "rectangular";
  /** Total instances across, including the original column. Minimum 1. */
  columns: number;
  /** Total instances down, including the original row. Minimum 1. */
  rows: number;
  /** Centre-to-centre spacing; negative values array left/down. */
  columnSpacing: number;
  rowSpacing: number;
}

export interface CircularPattern {
  kind: "circular";
  /** Total instances including the original. Minimum 1. */
  count: number;
  center: Point;
  /** Total sweep in radians the instances are spread over (2π for a full circle). */
  totalAngle: number;
  /** Whether each copy is rotated to follow the circle, or kept at its original orientation. */
  rotateItems: boolean;
}

export type PatternSpec = RectangularPattern | CircularPattern;

/** How many new entities a spec would create for `sourceCount` selected entities. */
export function patternCopyCount(spec: PatternSpec, sourceCount: number): number {
  const instances =
    spec.kind === "rectangular"
      ? Math.max(1, Math.floor(spec.columns)) * Math.max(1, Math.floor(spec.rows))
      : Math.max(1, Math.floor(spec.count));
  return (instances - 1) * sourceCount;
}

/**
 * The commands that lay out `ids` according to `spec`. Empty when the pattern
 * would produce nothing (no selection, or a single instance).
 */
export function patternCommands(doc: SketchDocument, ids: EntityId[], spec: PatternSpec): Command[] {
  const sources = ids.map((id) => doc.get(id)).filter((e): e is Entity => !!e);
  if (sources.length === 0) return [];

  const copies: Entity[] = [];
  const stamp = (place: (e: Entity) => Entity) => {
    for (const source of sources) copies.push({ ...place(source), id: newEntityId(), name: undefined });
  };

  if (spec.kind === "rectangular") {
    const cols = Math.max(1, Math.floor(spec.columns));
    const rows = Math.max(1, Math.floor(spec.rows));
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (c === 0 && r === 0) continue; // the originals stay as they are
        stamp((e) => translated(e, c * spec.columnSpacing, r * spec.rowSpacing));
      }
    }
  } else {
    const count = Math.max(1, Math.floor(spec.count));
    // A sweep that closes on itself shouldn't stack a duplicate on the
    // original, so a full turn divides by `count` rather than `count - 1`.
    const full = Math.abs(Math.abs(spec.totalAngle) - 2 * Math.PI) < 1e-9;
    const step = spec.totalAngle / (full ? count : Math.max(1, count - 1));

    for (let i = 1; i < count; i++) {
      const angle = step * i;
      stamp((e) => {
        if (spec.rotateItems) return transformed(e, spec.center, 0, 0, angle, 1);
        // Orientation preserved: carry the entity along the arc by translating
        // it, using how far its own anchor point travels under the rotation.
        const anchor = centerOf(e);
        const moved = rotateAbout(anchor, spec.center, angle);
        return translated(e, moved.x - anchor.x, moved.y - anchor.y);
      });
    }
  }

  return copies.map((entity) => ({ type: "add-entity", entity }) as Command);
}

const rotateAbout = (p: Point, pivot: Point, angle: number): Point => rotatePoint(p, pivot, angle);

/** An entity's own anchor point — what travels along the arc when copies keep their orientation. */
function centerOf(entity: Entity): Point {
  switch (entity.type) {
    case "circle":
    case "arc":
      return entity.center;
    case "point":
      return entity.p;
    case "line":
      return { x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 };
    case "polyline": {
      let sx = 0;
      let sy = 0;
      for (const p of entity.points) {
        sx += p.x;
        sy += p.y;
      }
      const n = Math.max(1, entity.points.length);
      return { x: sx / n, y: sy / n };
    }
    case "text":
      return entity.at;
  }
}
