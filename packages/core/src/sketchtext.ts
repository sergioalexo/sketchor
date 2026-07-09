import type { Entity, EntityId } from "./entities";
import { newEntityId } from "./entities";
import type { SketchDocument } from "./document";
import type { Command } from "./commands";

/**
 * Sketch code: a human-readable, line-oriented text form of the document.
 *
 *   sketch v1
 *
 *   line L1 from (0, 0) to (100, 0)
 *   circle C1 at (50, 25) r 20
 *
 * The same text is the manipulation surface for AI agents: they edit the
 * code, `parseCode` + `diffToCommands` turn the edit into ordinary
 * undoable commands. The grammar reserves `param`, `constraint` and `dim`
 * for the upcoming parametric layer:
 *
 *   param width = 40
 *   constraint tangent L1 C1
 *   dim L1 length = width
 */

export const SKETCH_HEADER = "sketch v1";

const RESERVED = ["param", "constraint", "dim"];

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const LINE_RE = new RegExp(
  String.raw`^line\s+([A-Za-z_]\w*)\s+from\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s*to\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)$`,
);
const CIRCLE_RE = new RegExp(
  String.raw`^circle\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s*r\s+(${NUM})$`,
);

function fmt(n: number): string {
  const rounded = Math.round(n * 10000) / 10000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Stable display names for every entity. Explicit `entity.name` wins;
 * unnamed entities get L1/C1... in insertion order, skipping taken names.
 */
export function assignNames(doc: SketchDocument): Map<EntityId, string> {
  const names = new Map<EntityId, string>();
  const used = new Set<string>();
  for (const e of doc.all()) {
    if (e.name) {
      names.set(e.id, e.name);
      used.add(e.name);
    }
  }
  const counters: Record<Entity["type"], number> = { line: 1, circle: 1 };
  for (const e of doc.all()) {
    if (names.has(e.id)) continue;
    const prefix = e.type === "line" ? "L" : "C";
    let i = counters[e.type];
    while (used.has(prefix + i)) i += 1;
    counters[e.type] = i + 1;
    names.set(e.id, prefix + i);
    used.add(prefix + i);
  }
  return names;
}

/** Next free name for a newly drawn entity (used by the tools). */
export function nextEntityName(doc: SketchDocument, type: Entity["type"]): string {
  const used = new Set(assignNames(doc).values());
  const prefix = type === "line" ? "L" : "C";
  let i = 1;
  while (used.has(prefix + i)) i += 1;
  return prefix + i;
}

export function toCode(doc: SketchDocument): string {
  const names = assignNames(doc);
  const out: string[] = [SKETCH_HEADER, ""];
  for (const e of doc.all()) {
    const name = names.get(e.id)!;
    if (e.type === "line") {
      out.push(
        `line ${name} from (${fmt(e.a.x)}, ${fmt(e.a.y)}) to (${fmt(e.b.x)}, ${fmt(e.b.y)})`,
      );
    } else {
      out.push(
        `circle ${name} at (${fmt(e.center.x)}, ${fmt(e.center.y)}) r ${fmt(e.radius)}`,
      );
    }
  }
  return out.join("\n") + "\n";
}

/** An entity as written in code — identified by name, not by internal id. */
export type ParsedEntity =
  | { type: "line"; name: string; a: { x: number; y: number }; b: { x: number; y: number } }
  | { type: "circle"; name: string; center: { x: number; y: number }; radius: number };

export interface ParseIssue {
  line: number;
  message: string;
}

export function parseCode(text: string): { entities: ParsedEntity[]; errors: ParseIssue[] } {
  const entities: ParsedEntity[] = [];
  const errors: ParseIssue[] = [];
  const seenNames = new Set<string>();

  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const lineNo = i + 1;
    const row = rows[i].trim();
    if (row === "" || row.startsWith("#") || row === SKETCH_HEADER) continue;

    const keyword = row.split(/\s+/, 1)[0].toLowerCase();
    if (RESERVED.includes(keyword)) {
      errors.push({
        line: lineNo,
        message: `'${keyword}' is reserved for the parametric layer and not supported yet`,
      });
      continue;
    }

    let parsed: ParsedEntity | null = null;
    let match = row.match(LINE_RE);
    if (match) {
      parsed = {
        type: "line",
        name: match[1],
        a: { x: Number(match[2]), y: Number(match[3]) },
        b: { x: Number(match[4]), y: Number(match[5]) },
      };
    } else if ((match = row.match(CIRCLE_RE))) {
      const radius = Number(match[4]);
      if (radius <= 0) {
        errors.push({ line: lineNo, message: "circle radius must be positive" });
        continue;
      }
      parsed = {
        type: "circle",
        name: match[1],
        center: { x: Number(match[2]), y: Number(match[3]) },
        radius,
      };
    }

    if (!parsed) {
      errors.push({
        line: lineNo,
        message:
          keyword === "line" || keyword === "circle"
            ? `could not parse ${keyword} — expected: ` +
              (keyword === "line"
                ? "line NAME from (x, y) to (x, y)"
                : "circle NAME at (x, y) r RADIUS")
            : `unknown statement '${keyword}'`,
      });
      continue;
    }

    if (seenNames.has(parsed.name)) {
      errors.push({ line: lineNo, message: `duplicate name '${parsed.name}'` });
      continue;
    }
    seenNames.add(parsed.name);
    entities.push(parsed);
  }
  return { entities, errors };
}

const EPS = 1e-9;

function sameGeometry(existing: Entity, parsed: ParsedEntity): boolean {
  if (existing.type !== parsed.type) return false;
  if (existing.type === "line" && parsed.type === "line") {
    return (
      Math.abs(existing.a.x - parsed.a.x) < EPS &&
      Math.abs(existing.a.y - parsed.a.y) < EPS &&
      Math.abs(existing.b.x - parsed.b.x) < EPS &&
      Math.abs(existing.b.y - parsed.b.y) < EPS
    );
  }
  if (existing.type === "circle" && parsed.type === "circle") {
    return (
      Math.abs(existing.center.x - parsed.center.x) < EPS &&
      Math.abs(existing.center.y - parsed.center.y) < EPS &&
      Math.abs(existing.radius - parsed.radius) < EPS
    );
  }
  return false;
}

function toEntity(parsed: ParsedEntity, id: EntityId): Entity {
  return parsed.type === "line"
    ? { id, type: "line", name: parsed.name, a: parsed.a, b: parsed.b }
    : { id, type: "circle", name: parsed.name, center: parsed.center, radius: parsed.radius };
}

/**
 * Computes the commands that transform the document into the parsed code.
 * Entities are matched by display name; unmatched names are added,
 * missing ones deleted, changed ones updated in place (same id).
 */
export function diffToCommands(doc: SketchDocument, parsed: ParsedEntity[]): Command[] {
  const names = assignNames(doc);
  const byName = new Map<string, Entity>();
  for (const e of doc.all()) byName.set(names.get(e.id)!, e);

  const commands: Command[] = [];
  const keep = new Set<string>();

  for (const p of parsed) {
    const existing = byName.get(p.name);
    if (existing) {
      keep.add(p.name);
      if (!sameGeometry(existing, p) || existing.name !== p.name) {
        commands.push({ type: "update-entity", entity: toEntity(p, existing.id) });
      }
    } else {
      commands.push({ type: "add-entity", entity: toEntity(p, newEntityId()) });
    }
  }

  const removed = [...byName.entries()]
    .filter(([name]) => !keep.has(name))
    .map(([, e]) => e.id);
  if (removed.length > 0) {
    commands.push({ type: "delete-entities", ids: removed });
  }
  return commands;
}
