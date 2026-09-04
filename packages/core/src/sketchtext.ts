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
const ARC_RE = new RegExp(
  String.raw`^arc\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s*r\s+(${NUM})\s+from\s+(${NUM})\s+to\s+(${NUM})(\s+cw)?$`,
);
const POINT_RE = new RegExp(
  String.raw`^point\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)$`,
);
// Note: sketch code doesn't express per-segment bulge — a polyline with
// curved (bulged) segments round-trips through code with those segments
// straightened, same as how layers already aren't expressed in code.
const POINT_PAIR = String.raw`\(\s*${NUM}\s*,\s*${NUM}\s*\)`;
const POLYLINE_RE = new RegExp(
  String.raw`^polyline\s+(?<name>[A-Za-z_]\w*)\s+pts\s+(?<pts>(?:${POINT_PAIR}\s*)+)(?<closed>closed)?$`,
);
const POINT_PAIR_CAPTURE = new RegExp(String.raw`\(\s*(${NUM})\s*,\s*(${NUM})\s*\)`, "g");
const TEXT_RE = new RegExp(
  String.raw`^text\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s+("(?:[^"\\]|\\.)*")\s+h\s+(${NUM})(?:\s+rot\s+(${NUM}))?$`,
);
// Note: sketch code carries an image's position/size/rotation only — it has
// no way to author the actual pixel data, so a new `image` line (one that
// doesn't match an existing image by name) is a no-op rather than creating a
// broken, imageless entity. See diffToCommands.
const IMAGE_RE = new RegExp(
  String.raw`^image\s+([A-Za-z_]\w*)\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)\s+(${NUM})x(${NUM})(?:\s+rot\s+(${NUM}))?$`,
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
  const counters: Record<Entity["type"], number> = { line: 1, circle: 1, arc: 1, point: 1, polyline: 1, text: 1, image: 1 };
  for (const e of doc.all()) {
    if (names.has(e.id)) continue;
    const prefix = NAME_PREFIX[e.type];
    let i = counters[e.type];
    while (used.has(prefix + i)) i += 1;
    counters[e.type] = i + 1;
    names.set(e.id, prefix + i);
    used.add(prefix + i);
  }
  return names;
}

const NAME_PREFIX: Record<Entity["type"], string> = { line: "L", circle: "C", arc: "A", point: "P", polyline: "PL", text: "T", image: "IMG" };

/** Next free name for a newly drawn entity (used by the tools). */
export function nextEntityName(doc: SketchDocument, type: Entity["type"]): string {
  const used = new Set(assignNames(doc).values());
  const prefix = NAME_PREFIX[type];
  let i = 1;
  while (used.has(prefix + i)) i += 1;
  return prefix + i;
}

const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function toCode(doc: SketchDocument): string {
  const names = assignNames(doc);
  const out: string[] = [SKETCH_HEADER, ""];
  for (const e of doc.all()) {
    const name = names.get(e.id)!;
    if (e.type === "line") {
      out.push(
        `line ${name} from (${fmt(e.a.x)}, ${fmt(e.a.y)}) to (${fmt(e.b.x)}, ${fmt(e.b.y)})`,
      );
    } else if (e.type === "circle") {
      out.push(
        `circle ${name} at (${fmt(e.center.x)}, ${fmt(e.center.y)}) r ${fmt(e.radius)}`,
      );
    } else if (e.type === "arc") {
      out.push(
        `arc ${name} at (${fmt(e.center.x)}, ${fmt(e.center.y)}) r ${fmt(e.radius)} ` +
          `from ${fmt(toDeg(e.startAngle))} to ${fmt(toDeg(e.endAngle))}${e.ccw ? "" : " cw"}`,
      );
    } else if (e.type === "point") {
      out.push(`point ${name} at (${fmt(e.p.x)}, ${fmt(e.p.y)})`);
    } else if (e.type === "text") {
      out.push(
        `text ${name} at (${fmt(e.at.x)}, ${fmt(e.at.y)}) ${JSON.stringify(e.text)} h ${fmt(e.height)}` +
          (e.rotation ? ` rot ${fmt(toDeg(e.rotation))}` : ""),
      );
    } else if (e.type === "image") {
      out.push(
        `image ${name} at (${fmt(e.insert.x)}, ${fmt(e.insert.y)}) ${fmt(e.width)}x${fmt(e.height)}` +
          (e.rotation ? ` rot ${fmt(toDeg(e.rotation))}` : ""),
      );
    } else {
      const pts = e.points.map((p) => `(${fmt(p.x)}, ${fmt(p.y)})`).join(" ");
      out.push(`polyline ${name} pts ${pts}${e.closed ? " closed" : ""}`);
    }
  }
  return out.join("\n") + "\n";
}

/** An entity as written in code — identified by name, not by internal id. */
export type ParsedEntity =
  | { type: "line"; name: string; a: { x: number; y: number }; b: { x: number; y: number } }
  | { type: "circle"; name: string; center: { x: number; y: number }; radius: number }
  | {
      type: "arc";
      name: string;
      center: { x: number; y: number };
      radius: number;
      startAngle: number;
      endAngle: number;
      ccw: boolean;
    }
  | { type: "point"; name: string; p: { x: number; y: number } }
  | { type: "polyline"; name: string; points: { x: number; y: number }[]; closed: boolean }
  | { type: "text"; name: string; at: { x: number; y: number }; text: string; height: number; rotation: number }
  | { type: "image"; name: string; insert: { x: number; y: number }; width: number; height: number; rotation: number };

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
    } else if ((match = row.match(ARC_RE))) {
      const radius = Number(match[4]);
      if (radius <= 0) {
        errors.push({ line: lineNo, message: "arc radius must be positive" });
        continue;
      }
      parsed = {
        type: "arc",
        name: match[1],
        center: { x: Number(match[2]), y: Number(match[3]) },
        radius,
        startAngle: (Number(match[5]) * Math.PI) / 180,
        endAngle: (Number(match[6]) * Math.PI) / 180,
        ccw: !match[7],
      };
    } else if ((match = row.match(POINT_RE))) {
      parsed = { type: "point", name: match[1], p: { x: Number(match[2]), y: Number(match[3]) } };
    } else if ((match = row.match(TEXT_RE))) {
      const height = Number(match[5]);
      if (height <= 0) {
        errors.push({ line: lineNo, message: "text height must be positive" });
        continue;
      }
      let content = "";
      try {
        content = JSON.parse(match[4]) as string;
      } catch {
        errors.push({ line: lineNo, message: "text content must be a quoted string" });
        continue;
      }
      parsed = {
        type: "text",
        name: match[1],
        at: { x: Number(match[2]), y: Number(match[3]) },
        text: content,
        height,
        rotation: match[6] ? (Number(match[6]) * Math.PI) / 180 : 0,
      };
    } else if ((match = row.match(IMAGE_RE))) {
      const width = Number(match[4]);
      const height = Number(match[5]);
      if (width <= 0 || height <= 0) {
        errors.push({ line: lineNo, message: "image width/height must be positive" });
        continue;
      }
      parsed = {
        type: "image",
        name: match[1],
        insert: { x: Number(match[2]), y: Number(match[3]) },
        width,
        height,
        rotation: match[6] ? (Number(match[6]) * Math.PI) / 180 : 0,
      };
    } else if ((match = row.match(POLYLINE_RE))) {
      const points: { x: number; y: number }[] = [];
      POINT_PAIR_CAPTURE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = POINT_PAIR_CAPTURE.exec(match.groups!.pts))) {
        points.push({ x: Number(pm[1]), y: Number(pm[2]) });
      }
      if (points.length < 2) {
        errors.push({ line: lineNo, message: "polyline needs at least 2 points" });
        continue;
      }
      parsed = { type: "polyline", name: match.groups!.name, points, closed: !!match.groups!.closed };
    }

    if (!parsed) {
      const known = ["line", "circle", "arc", "point", "polyline", "text", "image"];
      errors.push({
        line: lineNo,
        message: known.includes(keyword)
          ? `could not parse ${keyword} — expected: ` +
            (keyword === "line"
              ? "line NAME from (x, y) to (x, y)"
              : keyword === "circle"
                ? "circle NAME at (x, y) r RADIUS"
                : keyword === "arc"
                  ? "arc NAME at (x, y) r RADIUS from DEG to DEG [cw]"
                  : keyword === "point"
                    ? "point NAME at (x, y)"
                    : keyword === "text"
                      ? 'text NAME at (x, y) "content" h HEIGHT [rot DEG]'
                      : keyword === "image"
                        ? "image NAME at (x, y) WIDTHxHEIGHT [rot DEG]"
                        : "polyline NAME pts (x, y) (x, y) ... [closed]")
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
  if (existing.type === "arc" && parsed.type === "arc") {
    return (
      Math.abs(existing.center.x - parsed.center.x) < EPS &&
      Math.abs(existing.center.y - parsed.center.y) < EPS &&
      Math.abs(existing.radius - parsed.radius) < EPS &&
      Math.abs(existing.startAngle - parsed.startAngle) < EPS &&
      Math.abs(existing.endAngle - parsed.endAngle) < EPS &&
      existing.ccw === parsed.ccw
    );
  }
  if (existing.type === "point" && parsed.type === "point") {
    return Math.abs(existing.p.x - parsed.p.x) < EPS && Math.abs(existing.p.y - parsed.p.y) < EPS;
  }
  if (existing.type === "polyline" && parsed.type === "polyline") {
    return (
      existing.closed === parsed.closed &&
      existing.points.length === parsed.points.length &&
      existing.points.every(
        (p, i) => Math.abs(p.x - parsed.points[i].x) < EPS && Math.abs(p.y - parsed.points[i].y) < EPS,
      )
    );
  }
  if (existing.type === "text" && parsed.type === "text") {
    return (
      existing.text === parsed.text &&
      Math.abs(existing.at.x - parsed.at.x) < EPS &&
      Math.abs(existing.at.y - parsed.at.y) < EPS &&
      Math.abs(existing.height - parsed.height) < EPS &&
      Math.abs(existing.rotation - parsed.rotation) < EPS
    );
  }
  if (existing.type === "image" && parsed.type === "image") {
    return (
      Math.abs(existing.insert.x - parsed.insert.x) < EPS &&
      Math.abs(existing.insert.y - parsed.insert.y) < EPS &&
      Math.abs(existing.width - parsed.width) < EPS &&
      Math.abs(existing.height - parsed.height) < EPS &&
      Math.abs(existing.rotation - parsed.rotation) < EPS
    );
  }
  return false;
}

/**
 * `bulges` only applies when re-emitting an existing polyline whose points
 * came back unchanged apart from being re-typed in code — sketch code itself
 * never specifies bulge. `imageDataUrl` is the same idea for an image's pixel
 * data: sketch code carries only its position/size/rotation, so updating an
 * existing image must carry its `dataUrl` forward from the entity being
 * replaced. Never called to *create* a new image (see diffToCommands).
 */
function toEntity(parsed: ParsedEntity, id: EntityId, layer?: string, bulges?: number[], imageDataUrl?: string): Entity {
  const layerProp = layer ? { layer } : {};
  switch (parsed.type) {
    case "line":
      return { id, type: "line", name: parsed.name, ...layerProp, a: parsed.a, b: parsed.b };
    case "circle":
      return {
        id,
        type: "circle",
        name: parsed.name,
        ...layerProp,
        center: parsed.center,
        radius: parsed.radius,
      };
    case "arc":
      return {
        id,
        type: "arc",
        name: parsed.name,
        ...layerProp,
        center: parsed.center,
        radius: parsed.radius,
        startAngle: parsed.startAngle,
        endAngle: parsed.endAngle,
        ccw: parsed.ccw,
      };
    case "point":
      return { id, type: "point", name: parsed.name, ...layerProp, p: parsed.p };
    case "text":
      return {
        id,
        type: "text",
        name: parsed.name,
        ...layerProp,
        at: parsed.at,
        text: parsed.text,
        height: parsed.height,
        rotation: parsed.rotation,
      };
    case "polyline":
      return {
        id,
        type: "polyline",
        name: parsed.name,
        ...layerProp,
        points: parsed.points,
        closed: parsed.closed,
        ...(bulges ? { bulges } : {}),
      };
    case "image":
      return {
        id,
        type: "image",
        name: parsed.name,
        ...layerProp,
        insert: parsed.insert,
        width: parsed.width,
        height: parsed.height,
        rotation: parsed.rotation,
        dataUrl: imageDataUrl ?? "",
      };
  }
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
        // Preserve the entity's layer (and a polyline's bulges, or an image's
        // pixel data) — sketch code doesn't express any of those.
        commands.push({
          type: "update-entity",
          entity: toEntity(
            p,
            existing.id,
            existing.layer,
            existing.type === "polyline" ? existing.bulges : undefined,
            existing.type === "image" ? existing.dataUrl : undefined,
          ),
        });
      }
    } else if (p.type !== "image") {
      // An image can't be created from sketch code — it has no way to author
      // pixel data — so a new `image` line that doesn't match an existing
      // image by name is silently ignored rather than adding a broken,
      // imageless entity. Placing an image is the Image tool's job.
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
