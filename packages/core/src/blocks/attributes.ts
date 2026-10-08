import type { SketchDocument } from "../document";
import type { InsertEntity } from "../entities";
import { attributeValue, getBlock } from "./evaluate";
import type { AttributeDef } from "./types";

/**
 * B-05: attribute extraction (title blocks, parts lists). One row per insert
 * in the drawing; columns are block, handle (the insert's id), layer, x, y,
 * rotation, then one column per tag (the union over the blocks listed, in
 * first-seen order). Values are what the instance *shows* (fields expanded).
 */
export interface AttributeTable {
  headers: string[];
  rows: string[][];
}

export interface AttributeTableOptions {
  /** Only inserts of these blocks. */
  blocks?: readonly string[];
  /** Only these inserts (default: every top-level insert). */
  inserts?: readonly InsertEntity[];
}

const FIXED = ["Block", "Handle", "Layer", "X", "Y", "Rotation"];

function num(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

export function attributeTable(doc: SketchDocument, opts: AttributeTableOptions = {}): AttributeTable {
  const inserts = (opts.inserts ?? doc.all().filter((e): e is InsertEntity => e.type === "insert")).filter(
    (i) => !opts.blocks || opts.blocks.includes(i.block),
  );
  const tags: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    if (!seen.has(t)) {
      seen.add(t);
      tags.push(t);
    }
  };
  for (const i of inserts) for (const a of (getBlock(doc, i.block)?.attributeDefs ?? []) as AttributeDef[]) add(a.tag);
  const rows = inserts.map((i) => {
    const defs = new Map(((getBlock(doc, i.block)?.attributeDefs ?? []) as AttributeDef[]).map((a) => [a.tag, a]));
    return [
      i.block,
      i.id,
      i.layer ?? "0",
      num(i.insert.x),
      num(i.insert.y),
      num((i.rotation * 180) / Math.PI),
      ...tags.map((t) => {
        const d = defs.get(t);
        return d ? attributeValue(d, i) : "";
      }),
    ];
  });
  return { headers: [...FIXED, ...tags], rows };
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 CSV (CRLF line ends, quotes doubled). */
export function attributeCsv(table: AttributeTable): string {
  return [table.headers, ...table.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** A copy of `insert` with `values` merged into its attributes; an empty string removes the tag (back to the default). */
export function withAttributeValues(insert: InsertEntity, values: Record<string, string>): InsertEntity {
  const attributes = { ...insert.attributes };
  for (const [k, v] of Object.entries(values)) {
    if (v === "") delete attributes[k];
    else attributes[k] = v;
  }
  return { ...insert, attributes };
}

/** Attribute defs a user may edit on an instance (constant ones are fixed by the definition). */
export function editableAttributes(doc: SketchDocument, insert: InsertEntity): AttributeDef[] {
  return ((getBlock(doc, insert.block)?.attributeDefs ?? []) as AttributeDef[]).filter((a) => !a.flags?.constant);
}
