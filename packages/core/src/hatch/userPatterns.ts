import type { Command } from "../commands";
import type { SketchDocument } from "../document";
import type { PatternFamily } from "../entities";
import { registerEntityRefRewriter, type TableRecord } from "../tables";
import { parsePat, type PatternDef } from "./pat";
import { lookupPattern, registerPattern, unregisterPattern } from "./registry";

/**
 * User and document patterns (H-06). A pattern that is not in the built-in
 * library lives in the document's `hatchPatterns` table once a hatch uses it,
 * so a saved drawing (and its DXF) carries its own patterns. Imported `.pat`
 * files are registered under category "Imported"; the document's table is
 * mirrored into the registry under "Document" by `syncDocPatterns`.
 */

export const IMPORTED_CATEGORY = "Imported";
export const DOCUMENT_CATEGORY = "Document";

export interface PatternRecord extends TableRecord {
  description: string;
  families: PatternFamily[];
}

export function patternToRecord(p: PatternDef): PatternRecord {
  return { name: p.name, description: p.description, families: p.families.map((f) => ({ ...f, origin: { ...f.origin }, offset: { ...f.offset }, dashes: [...f.dashes] })) };
}

export function recordToPattern(r: TableRecord): PatternDef | null {
  const fam = (r as Partial<PatternRecord>).families;
  if (!Array.isArray(fam) || fam.length === 0) return null;
  return { name: r.name, description: typeof r.description === "string" ? r.description : "", families: fam, category: DOCUMENT_CATEGORY };
}

// An entity's pattern name refers to a `hatchPatterns` record when it is a custom one.
registerEntityRefRewriter("hatchPatterns", (entity, from, to) =>
  entity.type === "hatch" && entity.paint.kind === "pattern" && entity.paint.name === from ? { ...entity, paint: { ...entity.paint, name: to } } : null,
);

const docNames = new Set<string>();
const importedNames = new Set<string>();

/** Mirrors the document's custom patterns into the registry (replacing the previous document's). Never overrides a library or imported pattern. */
export function syncDocPatterns(doc: SketchDocument): void {
  for (const n of docNames) unregisterPattern(n);
  docNames.clear();
  for (const r of doc.records("hatchPatterns")) {
    const p = recordToPattern(r);
    if (!p || lookupPattern(p.name)) continue;
    registerPattern(p);
    docNames.add(p.name.toUpperCase());
  }
}

/** Registers imported patterns (replacing earlier imports of the same name, never a built-in). Returns the names registered. */
export function registerImported(defs: readonly PatternDef[]): string[] {
  const out: string[] = [];
  for (const d of defs) {
    const existing = lookupPattern(d.name);
    if (existing && existing.category !== IMPORTED_CATEGORY && existing.category !== DOCUMENT_CATEGORY) continue;
    registerPattern({ ...d, category: IMPORTED_CATEGORY });
    importedNames.add(d.name.toUpperCase());
    docNames.delete(d.name.toUpperCase());
    out.push(d.name);
  }
  return out;
}

export function removeImported(name: string): void {
  if (importedNames.delete(name.toUpperCase())) unregisterPattern(name);
}

export function importPatText(text: string): { names: string[]; issues: { line: number; message: string }[] } {
  const r = parsePat(text);
  return { names: registerImported(r.patterns), issues: r.issues };
}

/** True when a pattern name needs a `hatchPatterns` record to survive outside this app (not in the built-in library). */
export function isCustomPattern(name: string): boolean {
  const p = lookupPattern(name);
  return !!p && (p.category === IMPORTED_CATEGORY || p.category === DOCUMENT_CATEGORY || p.category === undefined);
}

/** Command that stores a used custom pattern in the document table, or null when it is built-in, unknown or already stored. */
export function ensurePatternRecord(doc: SketchDocument, name: string): Command | null {
  const p = lookupPattern(name);
  if (!p || !isCustomPattern(name) || doc.hasRecord("hatchPatterns", p.name)) return null;
  return { type: "put-table-record", table: "hatchPatterns", record: patternToRecord(p) };
}
