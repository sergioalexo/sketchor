import type { Command } from "../commands";
import type { SketchDocument } from "../document";
import type { Entity, EntityId, InsertEntity } from "../entities";
import { BUILTIN_LINETYPES } from "../linetypes";
import type { TableRecord } from "../tables";
import { blockWouldCycle, getBlock } from "./evaluate";
import { unusedBlocks } from "./ops";
import type { BlockDefinition } from "./types";

/**
 * B-09: drawing management — purge, replace, count. Pure; the panel only
 * shows the numbers and runs the commands these plans return.
 */

export type PurgeTable = "blocks" | "layers" | "linetypes" | "textStyles" | "dimStyles" | "hatchPatterns";
export const PURGE_TABLES: readonly PurgeTable[] = ["blocks", "layers", "linetypes", "textStyles", "dimStyles", "hatchPatterns"];

/** Every entity in the drawing and in block bodies (definitions are walked flat, not instantiated). */
function allEntities(doc: SketchDocument): Entity[] {
  const out: Entity[] = [...doc.all()];
  for (const r of doc.records("blocks")) out.push(...((r as BlockDefinition).entities ?? []));
  return out;
}

/** Names per table that nothing refers to and a purge may remove. Layer "0", built-in linetypes and the current text/dim style are never listed. */
export function purgeCandidates(doc: SketchDocument): Record<PurgeTable, string[]> {
  const ents = allEntities(doc);
  const layers = new Set(ents.map((e) => e.layer ?? "0"));
  const linetypes = new Set<string>();
  for (const e of ents) if (typeof e.linetype === "string") linetypes.add(e.linetype);
  for (const r of doc.records("layers")) if (typeof r.linetype === "string") linetypes.add(r.linetype);
  const styleKeys = new Map<string, Set<string>>([["textStyles", new Set()], ["dimStyles", new Set()]]);
  const patterns = new Set<string>();
  for (const e of ents) {
    const rec = e as unknown as Record<string, unknown>;
    for (const k of ["textStyle", "style"]) if (typeof rec[k] === "string") styleKeys.get("textStyles")!.add(rec[k] as string);
    if (typeof rec.dimStyle === "string") styleKeys.get("dimStyles")!.add(rec.dimStyle);
    const fill = rec.fill as { kind?: string; name?: string } | undefined;
    if (e.type === "hatch" && fill && fill.kind === "pattern" && fill.name) patterns.add(fill.name);
  }
  const settings = doc.settings as { currentTextStyle?: string; currentDimStyle?: string };
  for (const r of doc.records("blocks")) {
    for (const a of (r as BlockDefinition).attributeDefs ?? []) if (a.textStyle) styleKeys.get("textStyles")!.add(a.textStyle);
  }
  for (const r of doc.records("dimStyles")) {
    const ts = (r as TableRecord).textStyle;
    if (typeof ts === "string") styleKeys.get("textStyles")!.add(ts);
  }
  const pick = (table: PurgeTable, used: Set<string>, keep: (n: string) => boolean = () => false) =>
    doc.records(table).map((r) => r.name).filter((n) => !used.has(n) && !keep(n));
  return {
    blocks: unusedBlocks(doc),
    layers: pick("layers", layers, (n) => n === "0"),
    linetypes: pick("linetypes", linetypes, (n) => n.toUpperCase() in BUILTIN_LINETYPES),
    textStyles: pick("textStyles", styleKeys.get("textStyles")!, (n) => n === settings.currentTextStyle || n.toUpperCase() === "STANDARD"),
    dimStyles: pick("dimStyles", styleKeys.get("dimStyles")!, (n) => n === settings.currentDimStyle || n.toUpperCase() === "STANDARD"),
    hatchPatterns: pick("hatchPatterns", patterns),
  };
}

/** One `delete-table-record` per candidate of the chosen tables (all by default); null when there is nothing to purge. */
export function planPurge(doc: SketchDocument, tables: readonly PurgeTable[] = PURGE_TABLES): Command[] | null {
  const cands = purgeCandidates(doc);
  const out: Command[] = [];
  for (const t of tables) for (const name of cands[t]) out.push({ type: "delete-table-record", table: t, name });
  return out.length > 0 ? out : null;
}

/** Ids of the top-level inserts of `block`. */
export function instancesOf(doc: SketchDocument, block: string): EntityId[] {
  return doc.all().filter((e) => e.type === "insert" && e.block === block).map((e) => e.id);
}

/**
 * "Replace block A with B": every top-level insert of `from` (or only `ids`) now names `to`,
 * keeping its placement and attribute values; with no `ids` the instances nested in other
 * definitions switch too. Refuses a missing block, the same name, or a nesting cycle.
 */
export function planReplaceBlock(doc: SketchDocument, from: string, to: string, ids?: EntityId[]): Command[] | null {
  if (from === to || !doc.hasRecord("blocks", from) || !doc.hasRecord("blocks", to)) return null;
  const out: Command[] = [];
  const only = ids ? new Set(ids) : null;
  for (const e of doc.all()) {
    if (e.type !== "insert" || e.block !== from || (only && !only.has(e.id))) continue;
    out.push({ type: "update-entity", entity: { ...e, block: to } });
  }
  if (!only) {
    for (const r of doc.records("blocks")) {
      const def = r as BlockDefinition;
      if (def.name === from || !def.entities.some((e) => e.type === "insert" && e.block === from)) continue;
      const entities = def.entities.map((e) => (e.type === "insert" && e.block === from ? { ...e, block: to } : e));
      if (blockWouldCycle(doc, def.name, entities)) return null;
      out.push({ type: "put-table-record", table: "blocks", record: { ...def, entities } });
    }
  }
  return out.length > 0 ? out : null;
}

export interface BlockCountRow {
  block: string;
  /** Array cells of the top-level inserts. */
  placed: number;
  /** Including the copies nested inside placed blocks. */
  total: number;
}

function cells(i: InsertEntity): number {
  return Math.max(1, Math.round(i.array?.cols ?? 1)) * Math.max(1, Math.round(i.array?.rows ?? 1));
}

/** BCOUNT: how many of each block the drawing really contains, array cells and nesting included. Sorted by name. */
export function blockCountTable(doc: SketchDocument): BlockCountRow[] {
  const placed = new Map<string, number>();
  const total = new Map<string, number>();
  const walk = (list: readonly Entity[], mult: number, depth: number, top: boolean): void => {
    for (const e of list) {
      if (e.type !== "insert") continue;
      const n = mult * cells(e);
      total.set(e.block, (total.get(e.block) ?? 0) + n);
      if (top) placed.set(e.block, (placed.get(e.block) ?? 0) + cells(e));
      const def = getBlock(doc, e.block);
      if (def && depth < 8) walk(def.entities, n, depth + 1, false);
    }
  };
  walk(doc.all(), 1, 0, true);
  return [...total.keys()].sort().map((block) => ({ block, placed: placed.get(block) ?? 0, total: total.get(block) ?? 0 }));
}

export function blockCountCsv(rows: readonly BlockCountRow[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ["Block,Placed,Total", ...rows.map((r) => `${cell(r.block)},${r.placed},${r.total}`)].join("\r\n") + "\r\n";
}

export interface BlockTreeNode {
  block: string;
  count: number;
  children: BlockTreeNode[];
}

/** The nested-block tree under `name` (cycles and depth cut at 8). */
export function blockTree(doc: SketchDocument, name: string, depth = 0, seen: readonly string[] = []): BlockTreeNode[] {
  const def = getBlock(doc, name);
  if (!def || depth >= 8 || seen.includes(name)) return [];
  const counts = new Map<string, number>();
  for (const e of def.entities) if (e.type === "insert") counts.set(e.block, (counts.get(e.block) ?? 0) + cells(e));
  return [...counts].map(([block, count]) => ({ block, count, children: blockTree(doc, block, depth + 1, [...seen, name]) }));
}
