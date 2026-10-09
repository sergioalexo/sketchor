import type { SketchDocument } from "../document";
import type { Entity, EntityId } from "../entities";
import { withBlocks } from "./context";
import type { Affine } from "../kinds/registry";
import { applyAffine, flattenInserts, getBlock, insertMatrix } from "./evaluate";

/**
 * B-04 "edit in place" (AutoCAD's REFEDIT view): while a definition is being
 * edited in local coordinates, the rest of the drawing is shown faded
 * *behind* it, placed as the chosen instance sees it. That is the drawing
 * pushed through the inverse of the instance's placement, so the geometry
 * the user edits lines up with what surrounds the instance in model space.
 */

/** Inverse of an affine map; null when it is singular. */
export function invertAffine(m: Affine): Affine | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Everything in `parent` except instance `insertId`, expanded to plain
 * geometry (other instances of the edited block included, as the live
 * definition shows them) and mapped into the block's local coordinates.
 * Null when the instance is gone, is not an insert, or its placement cannot
 * be inverted.
 */
export function inPlaceBackdrop(parent: SketchDocument, insertId: EntityId, blockName: string): Entity[] | null {
  const insert = parent.get(insertId);
  const def = getBlock(parent, blockName);
  if (!insert || insert.type !== "insert" || insert.block !== blockName || !def) return null;
  const inv = invertAffine(insertMatrix(insert, def.basePoint));
  if (!inv) return null;
  const others = parent.all().filter((e) => e.id !== insertId);
  return withBlocks(parent, () => flattenInserts(parent, others)).map((e) => applyAffine(e, inv));
}
