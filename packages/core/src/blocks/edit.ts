import { SketchDocument } from "../document";
import type { TableRecord } from "../tables";
import { getBlock } from "./evaluate";
import type { BlockDefinition } from "./types";

/**
 * B-04: the block editor works on a scratch document that holds the
 * definition's own entities (local coordinates) plus a copy of every other
 * table, so nested inserts, layers and styles resolve exactly as in the
 * drawing. The edited block itself is left out of the scratch `blocks` table,
 * which makes "insert me inside myself" resolve to a marker instead of a loop.
 */
export function blockEditDocument(parent: SketchDocument, name: string): SketchDocument | null {
  const def = getBlock(parent, name);
  if (!def) return null;
  const tables: Record<string, TableRecord[]> = {};
  for (const t of parent.tableNames()) {
    tables[t] = parent.records(t).filter((r) => !(t === "blocks" && r.name === name));
  }
  return SketchDocument.fromJSON({
    version: 3,
    entities: def.entities.map((e) => ({ ...e })),
    groups: [],
    constraints: def.constraints ?? [],
    tables,
    settings: parent.settings,
  } as never);
}

/** The body a scratch document currently describes (attribute defs and the base point are owned by the edit session). */
export function blockEditChanges(scratch: SketchDocument): Pick<BlockDefinition, "entities" | "constraints"> {
  const constraints = scratch.constraints();
  return { entities: scratch.all().map((e) => ({ ...e })), constraints: constraints.length > 0 ? constraints : undefined };
}
