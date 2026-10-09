import type { InsertEntity } from "../entities";
import type { BlockDefinition } from "./types";

/**
 * B-10: the arithmetic behind the Properties panel for an insert. Pure so the
 * rules (a "scale uniformly" block keeps its ratio, an array never drops below
 * 1x1, a mirrored instance keeps its negative axis) are tested without a UI.
 */

/** Sets one scale axis. `lock` (or a block that scales uniformly) moves the other axis by the same factor, keeping a mirror's sign. */
export function withInsertScale(insert: InsertEntity, def: BlockDefinition | undefined, axis: "x" | "y", value: number, lock = false): InsertEntity {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return insert;
  const cur = insert.scale[axis];
  const other = axis === "x" ? "y" : "x";
  if (!(lock || def?.scaleUniformly) || Math.abs(cur) < 1e-12) return { ...insert, scale: { ...insert.scale, [axis]: value } };
  const k = value / cur;
  return { ...insert, scale: { ...insert.scale, [axis]: value, [other]: insert.scale[other] * k } as InsertEntity["scale"] };
}

/** Array size/spacing edit; a 1x1 array is dropped. Spacings are kept when only the counts change. */
export function withInsertArray(insert: InsertEntity, patch: Partial<NonNullable<InsertEntity["array"]>>): InsertEntity {
  const prev = insert.array ?? { cols: 1, rows: 1, colSpacing: 0, rowSpacing: 0 };
  const next = { ...prev, ...patch };
  next.cols = Math.max(1, Math.round(next.cols));
  next.rows = Math.max(1, Math.round(next.rows));
  const { array: _drop, ...rest } = insert;
  void _drop;
  return next.cols === 1 && next.rows === 1 ? rest : { ...rest, array: next };
}

/** True when the instance is mirrored (the two axes have opposite orientation). */
export function isMirroredInsert(insert: InsertEntity): boolean {
  return insert.scale.x * insert.scale.y < 0;
}
