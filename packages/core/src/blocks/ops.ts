import type { Command } from "../commands";
import type { SketchDocument } from "../document";
import type { Entity, EntityId, InsertEntity } from "../entities";
import { kindTransform } from "../kinds/registry";
import { applyAffine, attributeTexts, blockWouldCycle, getBlock, insertMatrix, referencedBlocks } from "./evaluate";
import type { BlockDefinition } from "./types";
import { registerEntityRefRewriter, registerRecordRefRewriter } from "../tables";

/**
 * B-02: block commands are macros — each expands, against the document as it
 * is when applied, into plain `put-table-record` / `delete-table-record` /
 * `add-entity` / `delete-entities` commands, so one undo step reverses each
 * and the inverses come for free from the bus's `batch`.
 *
 * A plan returns null when the command must be refused (empty name, taken
 * name, missing block, cyclic body, non-explodable block...), and the bus then
 * does nothing.
 */

type DefineBlock = Extract<Command, { type: "define-block" }>;
type UpdateBlock = Extract<Command, { type: "update-block" }>;
type DeleteBlock = Extract<Command, { type: "delete-block" }>;

/** A fresh insert of `block` at `at` with unit scale. */
export function makeInsert(id: EntityId, block: string, at: { x: number; y: number }, extra: Partial<InsertEntity> = {}): InsertEntity {
  return { id, type: "insert", block, insert: { x: at.x, y: at.y }, scale: { x: 1, y: 1 }, rotation: 0, attributes: {}, ...extra };
}

/** AutoCAD's "convert to block" (`mode` convert, default), "retain", or "delete" the source objects. */
export function planDefineBlock(doc: SketchDocument, c: DefineBlock): Command[] | null {
  const name = c.name.trim();
  if (name === "" || doc.hasRecord("blocks", name)) return null;
  const sources = c.ids.map((id) => doc.get(id)).filter((e): e is Entity => !!e);
  if (sources.length === 0) return null;
  if (blockWouldCycle(doc, name, sources)) return null;
  const definition: BlockDefinition = {
    name,
    basePoint: { x: c.basePoint.x, y: c.basePoint.y },
    // Entities keep the coordinates they had; the base point is where instances anchor.
    entities: sources,
    attributeDefs: c.attributeDefs ?? [],
    explodable: c.explodable ?? true,
    scaleUniformly: c.scaleUniformly ?? false,
    ...(c.description ? { description: c.description } : {}),
  };
  const mode = c.mode ?? "convert";
  const out: Command[] = [{ type: "put-table-record", table: "blocks", record: definition }];
  if (mode !== "retain") out.push({ type: "delete-entities", ids: sources.map((e) => e.id) });
  if (mode === "convert") {
    const layer = sources.find((e) => e.layer && e.layer !== "0")?.layer;
    out.push({ type: "add-entity", entity: makeInsert(c.insertId, name, c.basePoint, layer ? { layer } : {}) });
  }
  return out;
}

/** Replaces fields of a definition (typically `entities`); refused if the new body would make the block contain itself. */
export function planUpdateBlock(doc: SketchDocument, c: UpdateBlock): Command[] | null {
  const prev = getBlock(doc, c.name);
  if (!prev) return null;
  const next: BlockDefinition = { ...prev, ...c.changes, name: prev.name };
  if (c.changes.entities && blockWouldCycle(doc, prev.name, next.entities)) return null;
  return [{ type: "put-table-record", table: "blocks", record: next }];
}

export function planRenameBlock(doc: SketchDocument, from: string, to: string): Command[] | null {
  const target = to.trim();
  if (target === "" || target === from || !doc.hasRecord("blocks", from) || doc.hasRecord("blocks", target)) return null;
  return [{ type: "rename-table-record", table: "blocks", from, to: target }];
}

/** Names of the blocks and ids of the inserts that reference `name`. */
export function blockReferrers(doc: SketchDocument, name: string): { inserts: EntityId[]; blocks: string[] } {
  const inserts = doc.all().filter((e) => e.type === "insert" && e.block === name).map((e) => e.id);
  const blocks = doc
    .records("blocks")
    .filter((r) => r.name !== name && (r as BlockDefinition).entities.some((e) => e.type === "insert" && e.block === name))
    .map((r) => r.name);
  return { inserts, blocks };
}

/** Refuses while the block is referenced, unless `purge`, which also deletes the instances (and nested instances inside other definitions). */
export function planDeleteBlock(doc: SketchDocument, c: DeleteBlock): Command[] | null {
  if (!doc.hasRecord("blocks", c.name)) return null;
  const { inserts, blocks } = blockReferrers(doc, c.name);
  if ((inserts.length > 0 || blocks.length > 0) && !c.purge) return null;
  const out: Command[] = [];
  if (inserts.length > 0) out.push({ type: "delete-entities", ids: inserts });
  for (const b of blocks) {
    const def = getBlock(doc, b)!;
    out.push({ type: "put-table-record", table: "blocks", record: { ...def, entities: def.entities.filter((e) => !(e.type === "insert" && e.block === c.name)) } });
  }
  out.push({ type: "delete-table-record", table: "blocks", name: c.name });
  return out;
}

/**
 * One level of an instance, in world coordinates: the definition's entities
 * under each array placement. A nested insert stays an insert (re-placed), as
 * in AutoCAD, unless the composed placement can't be an insert (shear) — then
 * it is flattened. Attribute values become text.
 */
export function explodeInsert(doc: SketchDocument, insert: InsertEntity): Entity[] | null {
  const def = getBlock(doc, insert.block);
  if (!def || !def.explodable) return null;
  const arr = insert.array;
  const cols = Math.max(1, Math.round(arr?.cols ?? 1));
  const rows = Math.max(1, Math.round(arr?.rows ?? 1));
  const out: Entity[] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const m = insertMatrix(insert, def.basePoint, c * (arr?.colSpacing ?? 0), r * (arr?.rowSpacing ?? 0));
      const key = cols * rows > 1 ? `${c}.${r}` : "0";
      for (const e of def.entities) {
        let src = e;
        if ((e.layer === undefined || e.layer === "0") && insert.layer && insert.layer !== "0") src = { ...src, layer: insert.layer };
        if (src.color === "BYBLOCK") src = { ...src, color: insert.color } as Entity;
        if (src.linetype === "BYBLOCK") src = { ...src, linetype: insert.linetype } as Entity;
        const id = `${insert.id}:${key}:${e.id}`;
        if (src.type === "insert") {
          const t = kindTransform(src, m);
          if (t) {
            out.push({ ...t, id });
            continue;
          }
          // Cannot stay an insert under this map: flatten it.
          const inner = explodeNested(doc, src, m);
          out.push(...inner.map((x) => ({ ...x, id: `${id}:${x.id}` }) as Entity));
          continue;
        }
        out.push({ ...applyAffine(src, m), id });
      }
    }
  }
  out.push(...attributeTexts(doc, insert, () => `${insert.id}:attr:${out.length}`).map((t, i) => ({ ...t, id: `${insert.id}:attr:${i}` }) as Entity));
  return out;
}

function explodeNested(doc: SketchDocument, nested: InsertEntity, m: readonly [number, number, number, number, number, number]): Entity[] {
  const def = getBlock(doc, nested.block);
  if (!def) return [];
  const local = explodeInsert(doc, { ...nested, id: "n" });
  return (local ?? []).map((e) => applyAffine(e, m));
}

export function planExplode(doc: SketchDocument, id: EntityId): Command[] | null {
  const e = doc.get(id);
  if (!e || e.type !== "insert") return null;
  const parts = explodeInsert(doc, e);
  if (!parts) return null;
  return [{ type: "delete-entities", ids: [id] }, ...parts.map((entity): Command => ({ type: "add-entity", entity }))];
}

/** Names of blocks no insert in the drawing (transitively) shows — what a purge may remove. */
export function unusedBlocks(doc: SketchDocument): string[] {
  const used = referencedBlocks(doc, doc.all());
  return doc.records("blocks").map((r) => r.name).filter((n) => !used.has(n));
}

// An insert names a `blocks` record; so does an insert nested in another definition.
registerEntityRefRewriter("blocks", (entity, from, to) => (entity.type === "insert" && entity.block === from ? { ...entity, block: to } : null));
registerRecordRefRewriter("blocks", "blocks", (record, from, to) => {
  const def = record as BlockDefinition;
  if (!Array.isArray(def.entities) || !def.entities.some((e) => e.type === "insert" && e.block === from)) return null;
  return { ...def, entities: def.entities.map((e) => (e.type === "insert" && e.block === from ? { ...e, block: to } : e)) };
});

/** The first of BLOCK1, BLOCK2, ... (or `<base>N`) not already a block name. */
export function uniqueBlockName(doc: SketchDocument, base = "BLOCK"): string {
  let i = 1;
  while (doc.hasRecord("blocks", `${base}${i}`)) i += 1;
  return `${base}${i}`;
}
