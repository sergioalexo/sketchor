import type { Entity } from "./entities";
import { newEntityId, polylineSegments, transformed } from "./entities";
import type { Point } from "./geometry";
import { arcExtentPoints, arcPointAt, arcSweep, bulgeToArc, dist } from "./geometry";
import { textToStrokes } from "./font";

/**
 * Minimal ASCII DXF support: enough to import and preview typical 2D
 * drawings. Handles LINE, CIRCLE, ARC, POINT, ELLIPSE, LWPOLYLINE, legacy
 * POLYLINE/VERTEX, SPLINE, and TEXT/MTEXT. Ellipses, splines, and text are
 * tessellated into line segments so they fit the current entity model —
 * they display and export correctly, just decomposed. Entities with no
 * pure-geometry equivalent (HATCH, DIMENSION, INSERT, LEADER, ...) are
 * intentionally not imported; they're still tallied and surfaced via
 * {@link DxfImportReport}'s `skipped` list rather than silently dropped.
 *
 * The same parser feeds two consumers: the in-app DXF browser (thumbnails
 * + open) and the planned native Explorer thumbnail handler.
 */

interface Pair {
  code: number;
  value: string;
}

interface RawEntity {
  type: string;
  pairs: Pair[];
}

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1] });
  }
  return pairs;
}

/** Collects raw records from one named section (ENTITIES, BLOCKS, ...), in document order. */
function collectSectionRecords(pairs: Pair[], section: string): RawEntity[] {
  const raws: RawEntity[] = [];
  let inSection = false;
  let current: RawEntity | null = null;

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    const v = value.trim();

    if (code === 0 && v === "SECTION") {
      const name = pairs[i + 1]?.value.trim();
      inSection = name === section;
      continue;
    }
    if (code === 0 && v === "ENDSEC") {
      if (current) raws.push(current);
      current = null;
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    if (code === 0) {
      if (current) raws.push(current);
      current = { type: v.toUpperCase(), pairs: [] };
    } else if (current) {
      current.pairs.push({ code, value });
    }
  }
  if (current) raws.push(current);
  return raws;
}

/** Collects raw entities from the ENTITIES section. */
function collectRawEntities(pairs: Pair[]): RawEntity[] {
  return collectSectionRecords(pairs, "ENTITIES");
}

/** A reusable block definition from the BLOCKS section — its body plus the base point that lands on an INSERT's insertion point. */
interface BlockDef {
  base: Point;
  body: RawEntity[];
}

/**
 * Parses the BLOCKS section into named, reusable definitions. A block's
 * geometry is written in its own coordinate space; `base` (the BLOCK
 * record's code 10/20) is the origin that gets placed at each INSERT's
 * insertion point.
 */
function collectBlocks(pairs: Pair[]): Map<string, BlockDef> {
  const blocks = new Map<string, BlockDef>();
  let name: string | null = null;
  let def: BlockDef | null = null;

  for (const raw of collectSectionRecords(pairs, "BLOCKS")) {
    if (raw.type === "BLOCK") {
      name = str(raw, 2, "");
      def = { base: { x: num(raw, 10), y: num(raw, 20) }, body: [] };
      if (name) blocks.set(name, def);
    } else if (raw.type === "ENDBLK") {
      name = null;
      def = null;
    } else if (def) {
      def.body.push(raw);
    }
  }
  return blocks;
}

/**
 * Reads the HEADER section's `$INSUNITS` variable (group 70): the drawing's
 * real-world unit, per the DXF spec (0 unitless, 1 in, 2 ft, 4 mm, 5 cm,
 * 6 m, plus values for other units this app doesn't otherwise support).
 * 0 if the file doesn't specify one.
 */
function parseInsUnits(pairs: Pair[]): number {
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code === 9 && pairs[i].value.trim() === "$INSUNITS") {
      const next = pairs[i + 1];
      if (next && next.code === 70) return parseInt(next.value, 10) || 0;
    }
  }
  return 0;
}

/**
 * Millimeters per unit for the `$INSUNITS` codes this app maps to a
 * {@link DisplayUnit} (see units.ts's `DXF_UNIT_CODE`). Unspecified/unmapped
 * codes have no known factor, so callers leave coordinates untouched for
 * those rather than guessing.
 */
const MM_PER_INSUNIT: Record<number, number> = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };

const ORIGIN: Point = { x: 0, y: 0 };

/**
 * Entities are always stored internally in millimeters (see units.ts), but a
 * DXF's coordinates are in whatever real-world unit its `$INSUNITS` declares
 * — so they're rescaled to mm here, once, right after parsing. Without this,
 * an inch-based file's raw numbers would be stored as if they were already
 * millimeters: 25.4x too small, and silently wrong again on export.
 */
function scaleToMm(entities: Entity[], insUnits: number): Entity[] {
  const mmPerUnit = MM_PER_INSUNIT[insUnits];
  if (!mmPerUnit || mmPerUnit === 1) return entities;
  return entities.map((e) => transformed(e, ORIGIN, 0, 0, 0, mmPerUnit));
}

function num(raw: RawEntity, code: number, fallback = 0): number {
  const p = raw.pairs.find((x) => x.code === code);
  return p ? parseFloat(p.value) : fallback;
}

/** First string value for a group code (e.g. code 8 = layer name). */
function str(raw: RawEntity, code: number, fallback = ""): string {
  const p = raw.pairs.find((x) => x.code === code);
  return p ? p.value.trim() : fallback;
}

/** Every numeric value for a repeated group code, in document order (e.g. SPLINE control points). */
function allNums(raw: RawEntity, code: number): number[] {
  return raw.pairs.filter((p) => p.code === code).map((p) => parseFloat(p.value));
}

function line(a: Point, b: Point, layer?: string): Entity {
  return { id: newEntityId(), type: "line", a, b, ...(layer ? { layer } : {}) };
}

/** Builds one polyline entity from `points`, or null if there aren't enough points to draw anything. */
function polylineEntity(points: Point[], closed: boolean, bulges: number[] | undefined, layer?: string): Entity | null {
  if (points.length < 2) return null;
  const hasBulge = bulges?.some((b) => Math.abs(b) > 1e-9);
  return {
    id: newEntityId(),
    type: "polyline",
    points,
    closed,
    ...(hasBulge ? { bulges } : {}),
    ...(layer ? { layer } : {}),
  };
}

/** Emits a tessellated point run (SPLINE, ELLIPSE, a text stroke, ...) as one polyline entity — auto-closes if the first and last points coincide. */
function polyline(pts: Point[], out: Entity[], layer?: string): void {
  if (pts.length < 2) return;
  const closed = pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-6;
  const points = closed ? pts.slice(0, -1) : pts;
  const entity = polylineEntity(points, closed, undefined, layer);
  if (entity) out.push(entity);
}

function arc(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  ccw: boolean,
  layer?: string,
): Entity {
  return {
    id: newEntityId(),
    type: "arc",
    center,
    radius,
    startAngle,
    endAngle,
    ccw,
    ...(layer ? { layer } : {}),
  };
}

/** DXF ARC (angles in degrees, always swept counterclockwise from code 50 to code 51). */
function dxfArc(cx: number, cy: number, r: number, a0deg: number, a1deg: number, layer?: string): Entity {
  return arc({ x: cx, y: cy }, r, (a0deg * Math.PI) / 180, (a1deg * Math.PI) / 180, true, layer);
}

/** DXF ELLIPSE -> polyline. Major axis is an endpoint relative to center. */
function ellipseToLines(
  cx: number,
  cy: number,
  majorX: number,
  majorY: number,
  ratio: number,
  startParam: number,
  endParam: number,
  layer?: string,
): Entity[] {
  const majorLen = Math.hypot(majorX, majorY);
  if (majorLen < 1e-9) return [];
  const minorLen = majorLen * ratio;
  const rot = Math.atan2(majorY, majorX);
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  let sweep = endParam - startParam;
  if (Math.abs(sweep) < 1e-9) sweep = 2 * Math.PI;
  const steps = Math.min(128, Math.max(8, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 96)));
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = startParam + sweep * (i / steps);
    const ex = majorLen * Math.cos(t);
    const ey = minorLen * Math.sin(t);
    pts.push({ x: cx + ex * cosR - ey * sinR, y: cy + ex * sinR + ey * cosR });
  }
  const out: Entity[] = [];
  polyline(pts, out, layer);
  return out;
}

/** A polyline vertex, carrying the bulge for the segment that follows it. */
interface Vertex {
  x: number;
  y: number;
  bulge: number;
}

/**
 * Parses LWPOLYLINE vertices in document order, keeping each vertex's
 * bulge (code 42) attached. `nums()` can't be used here because it would
 * decouple coordinates from their bulges.
 */
function lwpolylineVertices(raw: RawEntity): Vertex[] {
  const verts: Vertex[] = [];
  let cur: Vertex | null = null;
  for (const p of raw.pairs) {
    if (p.code === 10) {
      if (cur) verts.push(cur);
      cur = { x: parseFloat(p.value), y: 0, bulge: 0 };
    } else if (p.code === 20 && cur) {
      cur.y = parseFloat(p.value);
    } else if (p.code === 42 && cur) {
      cur.bulge = parseFloat(p.value);
    }
  }
  if (cur) verts.push(cur);
  return verts;
}

/** Builds one polyline entity from LWPOLYLINE/POLYLINE vertices, preserving each segment's bulge (curved segments stay real arcs on render/export). */
function emitPolylineWithBulges(verts: Vertex[], closed: boolean, out: Entity[], layer?: string): void {
  if (verts.length < 2) return;
  const points = verts.map((v) => ({ x: v.x, y: v.y }));
  // A vertex's bulge belongs to the segment leaving it; the last vertex's bulge only matters for the closing segment.
  const bulges = closed ? verts.map((v) => v.bulge) : verts.slice(0, -1).map((v) => v.bulge);
  const entity = polylineEntity(points, closed, bulges, layer);
  if (entity) out.push(entity);
}

/* ------------------------- SPLINE tessellation ------------------------ */

/** A standard clamped/open uniform knot vector, used when a SPLINE's own knots are missing or malformed. */
function clampedUniformKnots(count: number, degree: number): number[] {
  const numMid = Math.max(0, count + degree + 1 - 2 * (degree + 1));
  const knots: number[] = [];
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 1; i <= numMid; i++) knots.push(i / (numMid + 1));
  for (let i = 0; i <= degree; i++) knots.push(1);
  return knots;
}

/** Knot span containing `u`, via binary search (Piegl & Tiller, "The NURBS Book", A2.1). */
function findSpan(degree: number, n: number, u: number, knots: number[]): number {
  if (u >= knots[n + 1]) return n;
  if (u <= knots[degree]) return degree;
  let lo = degree;
  let hi = n + 1;
  while (u < knots[lo] || u >= knots[lo + 1]) {
    const mid = Math.floor((lo + hi) / 2);
    if (u < knots[mid]) hi = mid;
    else lo = mid;
  }
  return lo;
}

interface HomogeneousPoint {
  x: number;
  y: number;
  w: number;
}

/** Evaluates a (rational) B-spline curve at parameter `u` via de Boor's algorithm in homogeneous coordinates. */
function deBoorPoint(degree: number, knots: number[], weighted: HomogeneousPoint[], u: number): Point {
  const n = weighted.length - 1;
  const k = findSpan(degree, n, u, knots);
  const d: HomogeneousPoint[] = [];
  for (let j = 0; j <= degree; j++) d[j] = { ...weighted[k - degree + j] };
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom !== 0 ? (u - knots[i]) / denom : 0;
      d[j] = {
        x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
        y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
        w: (1 - alpha) * d[j - 1].w + alpha * d[j].w,
      };
    }
  }
  const res = d[degree];
  return res.w !== 0 ? { x: res.x / res.w, y: res.y / res.w } : { x: res.x, y: res.y };
}

/** Tessellates a DXF SPLINE (control points, degree, knots, optional weights) to a polyline. */
function splinePoints(raw: RawEntity): Point[] {
  const xs = allNums(raw, 10);
  const ys = allNums(raw, 20);
  const count = Math.min(xs.length, ys.length);
  if (count < 2) return [];
  const degree = Math.max(1, Math.min(Math.round(num(raw, 71, 3)), count - 1));
  const weights = allNums(raw, 41);
  const ctrl = Array.from({ length: count }, (_, i) => ({ x: xs[i], y: ys[i], w: weights[i] ?? 1 }));

  let knots = allNums(raw, 40);
  if (knots.length !== count + degree + 1) knots = clampedUniformKnots(count, degree);

  const lo = knots[degree];
  const hi = knots[count];
  if (!(hi > lo)) return ctrl.map((c) => ({ x: c.x, y: c.y })); // degenerate knots: fall back to the control polygon

  const weighted = ctrl.map((c) => ({ x: c.w * c.x, y: c.w * c.y, w: c.w }));
  const steps = Math.min(200, Math.max(16, count * 12));
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    pts.push(deBoorPoint(degree, knots, weighted, lo + (hi - lo) * (i / steps)));
  }
  return pts;
}

/** Strips MTEXT's inline formatting codes (`\P`, `{\C1;...}`, font/height overrides) down to plain text. */
function cleanMtext(s: string): string {
  return s
    .replace(/\\P/g, " ")
    .replace(/\\~/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/\\\\/g, "\\");
}

export interface DxfImportReport {
  /** Entity types that produced geometry, with how many raw records of that type were found. */
  parsed: { type: string; count: number }[];
  /** Entity types found in the file but not imported (e.g. HATCH, DIMENSION). */
  skipped: { type: string; count: number }[];
}

export interface DxfParseResult {
  entities: Entity[];
  warnings: string[];
  report: DxfImportReport;
  /** The HEADER section's `$INSUNITS` code (0 if unspecified) — see {@link parseInsUnits}. */
  insUnits: number;
}

/**
 * Places a block's entity into world space for one INSERT:
 * `world = insertion + Rz(rotation) · S(sx, sy) · (blockPoint − base)`.
 * Always assigns a fresh id, so the same definition can be stamped many times.
 *
 * Non-uniform scaling of a circle/arc is really an ellipse, which the entity
 * model can't express — those fall back to the geometric-mean radius and warn.
 * A negative scale on one axis mirrors, which flips an arc's sweep direction.
 */
function placeEntity(
  entity: Entity,
  base: Point,
  insertion: Point,
  sx: number,
  sy: number,
  rotation: number,
  warn: (msg: string) => void,
): Entity {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const map = (p: Point): Point => {
    const x = (p.x - base.x) * sx;
    const y = (p.y - base.y) * sy;
    return { x: insertion.x + x * cos - y * sin, y: insertion.y + x * sin + y * cos };
  };
  const mirrored = sx * sy < 0;
  const radiusScale = Math.sqrt(Math.abs(sx * sy));
  const id = newEntityId();

  switch (entity.type) {
    case "line":
      return { ...entity, id, a: map(entity.a), b: map(entity.b) };
    case "point":
      return { ...entity, id, p: map(entity.p) };
    case "polyline":
      // Bulge is a signed ratio of the included angle: mirroring reverses the
      // sweep, so each bulge flips sign; scaling leaves the angle unchanged.
      return {
        ...entity,
        id,
        points: entity.points.map(map),
        ...(entity.bulges ? { bulges: mirrored ? entity.bulges.map((b) => -b) : entity.bulges } : {}),
      };
    case "circle": {
      if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9) {
        warn("a block was inserted with non-uniform scale — its circles/arcs are approximated as circular");
      }
      return { ...entity, id, center: map(entity.center), radius: entity.radius * radiusScale };
    }
    case "arc": {
      if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9) {
        warn("a block was inserted with non-uniform scale — its circles/arcs are approximated as circular");
      }
      // Re-derive the endpoints through the same map, so rotation and any
      // mirroring land correctly without special-casing each reflection axis.
      const center = map(entity.center);
      const startPt = map(arcPointAt(entity.center, entity.radius, entity.startAngle));
      const endPt = map(arcPointAt(entity.center, entity.radius, entity.endAngle));
      return {
        ...entity,
        id,
        center,
        radius: entity.radius * radiusScale,
        startAngle: Math.atan2(startPt.y - center.y, startPt.x - center.x),
        endAngle: Math.atan2(endPt.y - center.y, endPt.x - center.x),
        ccw: mirrored ? !entity.ccw : entity.ccw,
      };
    }
  }
}

/** Nested INSERTs are legal; this caps how deep instantiation will follow them. */
const MAX_BLOCK_DEPTH = 8;

interface ConvertContext {
  blocks: Map<string, BlockDef>;
  warnings: string[];
  depth: number;
  /** Block names currently being instantiated, to break self-referential definitions. */
  stack: ReadonlySet<string>;
  /**
   * The layer of the INSERT that's instantiating these records, if any.
   * Entities drawn on layer "0" inside a block inherit the INSERT's layer —
   * standard DXF behavior, and what makes block geometry respect the layer
   * it was placed on.
   */
  insertLayer?: string;
}

/**
 * Converts a run of raw DXF records into entities. Used for the ENTITIES
 * section and, recursively, for each block body an INSERT instantiates.
 */
function convertRecords(raws: RawEntity[], ctx: ConvertContext): Entity[] {
  const entities: Entity[] = [];
  const warnings = ctx.warnings;

  for (const raw of raws) {
    const rawLayer = str(raw, 8, "0") || "0";
    const layer = rawLayer === "0" && ctx.insertLayer ? ctx.insertLayer : rawLayer;
    switch (raw.type) {
      case "LINE":
        entities.push(
          line(
            { x: num(raw, 10), y: num(raw, 20) },
            { x: num(raw, 11), y: num(raw, 21) },
            layer,
          ),
        );
        break;
      case "CIRCLE": {
        const r = num(raw, 40);
        if (r > 0) {
          entities.push({
            id: newEntityId(),
            type: "circle",
            layer,
            center: { x: num(raw, 10), y: num(raw, 20) },
            radius: r,
          });
        }
        break;
      }
      case "ARC": {
        const r = num(raw, 40);
        if (r > 0) {
          entities.push(dxfArc(num(raw, 10), num(raw, 20), r, num(raw, 50), num(raw, 51), layer));
        }
        break;
      }
      case "POINT": {
        entities.push({ id: newEntityId(), type: "point", layer, p: { x: num(raw, 10), y: num(raw, 20) } });
        break;
      }
      case "ELLIPSE": {
        entities.push(
          ...ellipseToLines(
            num(raw, 10),
            num(raw, 20),
            num(raw, 11),
            num(raw, 21),
            num(raw, 40, 1),
            num(raw, 41, 0),
            num(raw, 42, 2 * Math.PI),
            layer,
          ),
        );
        break;
      }
      case "LWPOLYLINE": {
        const verts = lwpolylineVertices(raw);
        const closed = (num(raw, 70) & 1) === 1;
        emitPolylineWithBulges(verts, closed, entities, layer);
        break;
      }
      case "SPLINE": {
        polyline(splinePoints(raw), entities, layer);
        break;
      }
      case "TEXT":
      case "MTEXT": {
        const insertion = { x: num(raw, 10), y: num(raw, 20) };
        const height = num(raw, 40, 2.5) || 2.5;
        const rotation = (num(raw, 50, 0) * Math.PI) / 180;
        const raw1 = str(raw, 1, "");
        const content =
          raw.type === "MTEXT"
            ? cleanMtext(raw.pairs.filter((p) => p.code === 3).map((p) => p.value).join("") + raw1)
            : raw1;
        for (const stroke of textToStrokes(content, insertion, height, rotation)) {
          polyline(stroke, entities, layer);
        }
        break;
      }
      case "INSERT": {
        const name = str(raw, 2, "");
        const block = ctx.blocks.get(name);
        if (!block) {
          warnings.push(`a block reference points at a missing block definition ('${name}')`);
          break;
        }
        if (ctx.stack.has(name)) {
          warnings.push(`block '${name}' inserts itself — skipped to avoid infinite nesting`);
          break;
        }
        if (ctx.depth >= MAX_BLOCK_DEPTH) {
          warnings.push(`blocks nested deeper than ${MAX_BLOCK_DEPTH} levels were not expanded`);
          break;
        }

        const insertion = { x: num(raw, 10), y: num(raw, 20) };
        const sx = num(raw, 41, 1) || 1;
        const sy = num(raw, 42, 1) || 1;
        const rotation = (num(raw, 50, 0) * Math.PI) / 180;
        // A single INSERT can stamp a rectangular array of copies.
        const cols = Math.max(1, Math.round(num(raw, 70, 1)) || 1);
        const rows = Math.max(1, Math.round(num(raw, 71, 1)) || 1);
        const colSpacing = num(raw, 44, 0);
        const rowSpacing = num(raw, 45, 0);

        // Convert the body once, then stamp transformed copies (fresh ids each).
        const body = convertRecords(block.body, {
          ...ctx,
          depth: ctx.depth + 1,
          stack: new Set([...ctx.stack, name]),
          insertLayer: layer,
        });
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < rows; r++) {
            // Array offsets are along the INSERT's own rotated axes.
            const ox = c * colSpacing;
            const oy = r * rowSpacing;
            const at = {
              x: insertion.x + ox * cos - oy * sin,
              y: insertion.y + ox * sin + oy * cos,
            };
            for (const e of body) {
              entities.push(placeEntity(e, block.base, at, sx, sy, rotation, (m) => warnings.push(m)));
            }
          }
        }
        break;
      }
      // POLYLINE / VERTEX / SEQEND are handled in the legacy second pass below.
      default:
        if (!KNOWN_IGNORED.has(raw.type)) {
          warnings.push(`unsupported entity: ${raw.type}`);
        }
    }
  }

  // Second pass for legacy POLYLINE/VERTEX sequences.
  stitchLegacyPolylines(raws, entities, ctx.insertLayer);

  return entities;
}

export function parseDxf(text: string): DxfParseResult {
  const warnings: string[] = [];
  const allPairs = tokenize(text);
  const insUnits = parseInsUnits(allPairs);
  const raws = collectRawEntities(allPairs);
  const blocks = collectBlocks(allPairs);

  const entities = scaleToMm(convertRecords(raws, { blocks, warnings, depth: 0, stack: new Set() }), insUnits);

  return { entities, warnings: dedupe(warnings), report: buildImportReport(raws), insUnits };
}

const SUPPORTED_TYPES = new Set([
  "LINE",
  "CIRCLE",
  "ARC",
  "ELLIPSE",
  "LWPOLYLINE",
  "SPLINE",
  "TEXT",
  "MTEXT",
  "POLYLINE",
  "POINT",
  "INSERT",
]);

/** Tallies raw DXF entity types into parsed/skipped buckets for the import report. */
function buildImportReport(raws: RawEntity[]): DxfImportReport {
  const counts = new Map<string, number>();
  for (const raw of raws) {
    // Records that aren't drawable geometry in the first place (POLYLINE's own
    // VERTEX/SEQEND sub-records, paper-space VIEWPORTs) aren't losses, so they
    // don't belong in either bucket.
    if (raw.type === "POLYLINE" ? false : KNOWN_IGNORED.has(raw.type)) continue;
    counts.set(raw.type, (counts.get(raw.type) ?? 0) + 1);
  }
  const parsed: { type: string; count: number }[] = [];
  const skipped: { type: string; count: number }[] = [];
  for (const [type, count] of counts) {
    (SUPPORTED_TYPES.has(type) ? parsed : skipped).push({ type, count });
  }
  parsed.sort((a, b) => a.type.localeCompare(b.type));
  skipped.sort((a, b) => b.count - a.count);
  return { parsed, skipped };
}

/**
 * Records that carry no drawable geometry, so they're skipped without a
 * warning. POLYLINE/VERTEX/SEQEND are handled by the legacy second pass;
 * VIEWPORT and paper-space layout records describe *how* a drawing is
 * presented on a sheet, not what it contains.
 */
const KNOWN_IGNORED = new Set(["SEQEND", "POLYLINE", "VERTEX", "VIEWPORT"]);

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

function stitchLegacyPolylines(raws: RawEntity[], entities: Entity[], insertLayer?: string): void {
  let verts: Vertex[] | null = null;
  let closed = false;
  let layer = "0";
  const flush = () => {
    if (verts && verts.length > 1) {
      emitPolylineWithBulges(verts, closed && verts.length > 2, entities, layer);
    }
    verts = null;
    closed = false;
  };
  for (const raw of raws) {
    if (raw.type === "POLYLINE") {
      flush();
      verts = [];
      closed = (num(raw, 70) & 1) === 1;
      const own = str(raw, 8, "0") || "0";
      layer = own === "0" && insertLayer ? insertLayer : own;
    } else if (raw.type === "VERTEX" && verts) {
      verts.push({ x: num(raw, 10), y: num(raw, 20), bulge: num(raw, 42) });
    } else if (raw.type === "SEQEND") {
      flush();
    }
  }
  flush();
}

/* ---------------- bounds + headless SVG rendering ---------------- */

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(entities: Entity[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const e of entities) {
    if (e.type === "line") {
      acc(e.a.x, e.a.y);
      acc(e.b.x, e.b.y);
    } else if (e.type === "circle") {
      acc(e.center.x - e.radius, e.center.y - e.radius);
      acc(e.center.x + e.radius, e.center.y + e.radius);
    } else if (e.type === "point") {
      acc(e.p.x, e.p.y);
    } else if (e.type === "arc") {
      for (const p of arcExtentPoints(e.center, e.radius, e.startAngle, e.endAngle, e.ccw)) {
        acc(p.x, p.y);
      }
    } else {
      for (const seg of polylineSegments(e)) {
        acc(seg.a.x, seg.a.y);
        acc(seg.b.x, seg.b.y);
        const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
        if (bulgeArc) {
          for (const p of arcExtentPoints(bulgeArc.center, bulgeArc.radius, bulgeArc.startAngle, bulgeArc.endAngle, bulgeArc.ccw)) {
            acc(p.x, p.y);
          }
        }
      }
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export interface ThumbnailOptions {
  size?: number;
  stroke?: string;
  background?: string;
  padding?: number;
}

/**
 * Renders entities to a standalone SVG string that fits a `size` box.
 * Pure string output — safe under strict CSP and runnable in Node, so the
 * same code produces browser thumbnails and (later) Explorer bitmaps.
 */
export function entitiesToSvg(entities: Entity[], opts: ThumbnailOptions = {}): string {
  const size = opts.size ?? 128;
  const stroke = opts.stroke ?? "#dfe1e5";
  const background = opts.background ?? "#1e1f22";
  const pad = opts.padding ?? Math.round(size * 0.08);

  const b = boundsOf(entities);
  const body: string[] = [];

  if (b) {
    const w = Math.max(b.maxX - b.minX, 1e-6);
    const h = Math.max(b.maxY - b.minY, 1e-6);
    const scale = Math.min((size - pad * 2) / w, (size - pad * 2) / h);
    const drawW = w * scale;
    const drawH = h * scale;
    const offX = (size - drawW) / 2;
    const offY = (size - drawH) / 2;
    // World Y up -> SVG Y down.
    const sx = (x: number) => offX + (x - b.minX) * scale;
    const sy = (y: number) => offY + (b.maxY - y) * scale;
    const f = (n: number) => Math.round(n * 100) / 100;

    for (const e of entities) {
      if (e.type === "line") {
        body.push(
          `<line x1="${f(sx(e.a.x))}" y1="${f(sy(e.a.y))}" x2="${f(sx(e.b.x))}" y2="${f(sy(e.b.y))}"/>`,
        );
      } else if (e.type === "circle") {
        body.push(
          `<circle cx="${f(sx(e.center.x))}" cy="${f(sy(e.center.y))}" r="${f(e.radius * scale)}" fill="none"/>`,
        );
      } else if (e.type === "point") {
        body.push(`<circle cx="${f(sx(e.p.x))}" cy="${f(sy(e.p.y))}" r="1.5" fill="${stroke}"/>`);
      } else if (e.type === "arc") {
        // Tessellated for display only — the document keeps the arc as one entity.
        const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
        const steps = Math.min(64, Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * 64)));
        const d: string[] = [];
        for (let i = 0; i <= steps; i++) {
          const t = e.ccw
            ? e.startAngle + sweep * (i / steps)
            : e.startAngle - sweep * (i / steps);
          const p = arcPointAt(e.center, e.radius, t);
          d.push(`${i === 0 ? "M" : "L"}${f(sx(p.x))} ${f(sy(p.y))}`);
        }
        body.push(`<path d="${d.join(" ")}" fill="none"/>`);
      } else {
        // Tessellated for display only — the document keeps each segment's true geometry (line or bulge-arc).
        const d: string[] = [];
        polylineSegments(e).forEach((seg, i) => {
          if (i === 0) d.push(`M${f(sx(seg.a.x))} ${f(sy(seg.a.y))}`);
          const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
          if (!bulgeArc) {
            d.push(`L${f(sx(seg.b.x))} ${f(sy(seg.b.y))}`);
            return;
          }
          const sweep = arcSweep(bulgeArc.startAngle, bulgeArc.endAngle, bulgeArc.ccw);
          const steps = Math.min(32, Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * 64)));
          for (let s = 1; s <= steps; s++) {
            const t = bulgeArc.ccw
              ? bulgeArc.startAngle + sweep * (s / steps)
              : bulgeArc.startAngle - sweep * (s / steps);
            const p = arcPointAt(bulgeArc.center, bulgeArc.radius, t);
            d.push(`L${f(sx(p.x))} ${f(sy(p.y))}`);
          }
        });
        if (e.closed) d.push("Z");
        body.push(`<path d="${d.join(" ")}" fill="none"/>`);
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${background}"/>` +
    `<g stroke="${stroke}" stroke-width="1" fill="none" stroke-linecap="round">${body.join("")}</g>` +
    `</svg>`
  );
}

/** Convenience: DXF text straight to a thumbnail SVG string. */
export function dxfToSvg(text: string, opts: ThumbnailOptions = {}): string {
  return entitiesToSvg(parseDxf(text).entities, opts);
}
