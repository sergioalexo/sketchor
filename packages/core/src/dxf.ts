import type { Entity } from "./entities";
import { newEntityId } from "./entities";
import type { Point } from "./geometry";
import { arcExtentPoints, arcPointAt, arcSweep } from "./geometry";
import { textToStrokes } from "./font";

/**
 * Minimal ASCII DXF support: enough to import and preview typical 2D
 * drawings. Handles LINE, CIRCLE, ARC, LWPOLYLINE and legacy
 * POLYLINE/VERTEX. Arcs and polylines are approximated with line
 * segments so they fit the current line/circle entity model; arcs may
 * become a first-class entity later without changing this API.
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

/** Collects raw entities from the ENTITIES section (and any BLOCK bodies). */
function collectRawEntities(pairs: Pair[]): RawEntity[] {
  const raws: RawEntity[] = [];
  let inEntities = false;
  let current: RawEntity | null = null;

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    const v = value.trim();

    if (code === 0 && v === "SECTION") {
      const name = pairs[i + 1]?.value.trim();
      inEntities = name === "ENTITIES";
      continue;
    }
    if (code === 0 && v === "ENDSEC") {
      if (current) raws.push(current);
      current = null;
      inEntities = false;
      continue;
    }
    if (!inEntities) continue;

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

/** Emits a polyline through `pts` as individual line entities. */
function polyline(pts: Point[], out: Entity[], layer?: string): void {
  for (let i = 0; i + 1 < pts.length; i++) out.push(line(pts[i], pts[i + 1], layer));
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

/**
 * A polyline segment defined by a DXF *bulge* (the tangent of a quarter of
 * the arc's included angle) between two vertices — a zero bulge is a
 * straight segment, a nonzero one a real first-class arc between a and b.
 */
function bulgeToEntity(a: Point, b: Point, bulge: number, layer?: string): Entity {
  if (!bulge || Math.abs(bulge) < 1e-9) return line(a, b, layer);
  const theta = 4 * Math.atan(bulge); // signed included angle (CCW positive)
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return line(a, b, layer);
  const r = chord / (2 * Math.sin(theta / 2)); // signed radius
  const m = r * Math.cos(theta / 2); // midpoint -> center distance
  const midx = (a.x + b.x) / 2;
  const midy = (a.y + b.y) / 2;
  const nx = -dy / chord; // left normal of the chord
  const ny = dx / chord;
  const cx = midx + nx * m;
  const cy = midy + ny * m;
  const rad = Math.abs(r);
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  const a1 = Math.atan2(b.y - cy, b.x - cx);
  return arc({ x: cx, y: cy }, rad, a0, a1, theta >= 0, layer);
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

/** Emits polyline segments, turning any bulged segment into a first-class arc. */
function emitPolylineWithBulges(
  verts: Vertex[],
  closed: boolean,
  out: Entity[],
  layer?: string,
): void {
  const segs = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    out.push(bulgeToEntity({ x: a.x, y: a.y }, { x: b.x, y: b.y }, a.bulge, layer));
  }
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
}

export function parseDxf(text: string): DxfParseResult {
  const warnings: string[] = [];
  const entities: Entity[] = [];
  const raws = collectRawEntities(tokenize(text));

  for (const raw of raws) {
    const layer = str(raw, 8, "0") || "0";
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
      // POLYLINE / VERTEX / SEQEND are handled in the legacy second pass below.
      default:
        if (!KNOWN_IGNORED.has(raw.type)) {
          warnings.push(`unsupported entity: ${raw.type}`);
        }
    }
  }

  // Second pass for legacy POLYLINE/VERTEX sequences.
  stitchLegacyPolylines(raws, entities);

  return { entities, warnings: dedupe(warnings), report: buildImportReport(raws) };
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
]);

/** Tallies raw DXF entity types into parsed/skipped buckets for the import report. */
function buildImportReport(raws: RawEntity[]): DxfImportReport {
  const counts = new Map<string, number>();
  for (const raw of raws) {
    // VERTEX/SEQEND are sub-records of a POLYLINE, not distinct entities to report.
    if (raw.type === "VERTEX" || raw.type === "SEQEND") continue;
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

const KNOWN_IGNORED = new Set(["SEQEND", "POLYLINE", "VERTEX"]);

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

function stitchLegacyPolylines(raws: RawEntity[], entities: Entity[]): void {
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
      layer = str(raw, 8, "0") || "0";
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
    } else {
      for (const p of arcExtentPoints(e.center, e.radius, e.startAngle, e.endAngle, e.ccw)) {
        acc(p.x, p.y);
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
      } else {
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
