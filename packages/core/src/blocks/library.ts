import type { Command } from "../commands";
import type { SketchDocument } from "../document";
import type { Entity, InsertEntity } from "../entities";
import { evaluateInsert, getBlock, referencedBlocks } from "./evaluate";
import { makeInsert } from "./ops";
import type { BlockDefinition } from "./types";

/**
 * B-06: the block library. An entry is a definition plus the definitions of
 * every block it nests (so it can be dropped into a drawing that has none of
 * them). Pure here; the app keeps entries in local storage and reads files.
 */
export interface LibraryEntry {
  def: BlockDefinition;
  deps: BlockDefinition[];
}

/** How many top-level inserts of each block the drawing holds. */
export function instanceCounts(doc: SketchDocument): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of doc.all()) if (e.type === "insert") counts.set(e.block, (counts.get(e.block) ?? 0) + 1);
  return counts;
}

/** Definition `name` and the blocks it needs, copied out of the drawing; null when it does not exist. */
export function libraryEntry(doc: SketchDocument, name: string): LibraryEntry | null {
  const def = getBlock(doc, name);
  if (!def) return null;
  const needed = referencedBlocks(doc, def.entities);
  needed.delete(name);
  const deps = [...needed].map((n) => getBlock(doc, n)).filter((d): d is BlockDefinition => !!d);
  return { def: structuredClone(def), deps: structuredClone(deps) };
}

/** A definition from loose geometry (a drawing file inserted as a block): anchored at the file's origin. */
export function blockFromEntities(name: string, entities: readonly Entity[], description?: string): BlockDefinition {
  return {
    name,
    basePoint: { x: 0, y: 0 },
    entities: entities.map((e) => ({ ...e })),
    attributeDefs: [],
    explodable: true,
    scaleUniformly: false,
    ...(description ? { description } : {}),
  };
}

/** A block name safe for the table: letters, digits, `_ - $ .`; spaces become `_`; empty becomes BLOCK. */
export function sanitizeBlockName(raw: string): string {
  const s = raw.trim().replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/\s+/g, "_").replace(/[^\w$.\-]/g, "");
  return s === "" ? "BLOCK" : s;
}

/**
 * Commands that bring a library entry into `doc`: missing nested blocks and
 * the block itself are added; with `redefine` an existing block of that name
 * takes the entry's body (every instance updates). Without it an existing
 * block is left alone, so inserting the same part twice never clobbers local
 * edits. Returns [] when there is nothing to do.
 */
export function planLibraryImport(doc: SketchDocument, entry: LibraryEntry, redefine = false): Command[] {
  const out: Command[] = [];
  for (const d of entry.deps) if (!doc.hasRecord("blocks", d.name)) out.push({ type: "put-table-record", table: "blocks", record: d });
  const { name } = entry.def;
  if (!doc.hasRecord("blocks", name)) out.push({ type: "put-table-record", table: "blocks", record: entry.def });
  else if (redefine) {
    const { name: _n, ...changes } = entry.def;
    out.push({ type: "update-block", name, changes });
  }
  return out;
}

/** The world-space geometry of one unscaled instance of `name` at its base point — what a thumbnail draws. */
export function blockPreviewEntities(doc: SketchDocument, name: string): Entity[] {
  const def = getBlock(doc, name);
  if (!def) return [];
  const probe: InsertEntity = makeInsert("preview", name, def.basePoint);
  return evaluateInsert(doc, probe);
}
