import type { Entity } from "./entities";
import { newEntityId } from "./entities";
import type { Point } from "./geometry";

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

function line(a: Point, b: Point, layer?: string): Entity {
  return { id: newEntityId(), type: "line", a, b, ...(layer ? { layer } : {}) };
}

/** Emits a polyline through `pts` as individual line entities. */
function polyline(pts: Point[], out: Entity[], layer?: string): void {
  for (let i = 0; i + 1 < pts.length; i++) out.push(line(pts[i], pts[i + 1], layer));
}

function arcToLines(
  cx: number,
  cy: number,
  r: number,
  a0deg: number,
  a1deg: number,
  layer?: string,
): Entity[] {
  const a0 = (a0deg * Math.PI) / 180;
  let sweep = ((a1deg - a0deg) % 360 + 360) % 360;
  if (sweep === 0) sweep = 360;
  const steps = Math.min(96, Math.max(2, Math.ceil(sweep / 6)));
  const out: Entity[] = [];
  let prev: Point = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((sweep * Math.PI) / 180) * (i / steps);
    const p = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    out.push(line(prev, p, layer));
    prev = p;
  }
  return out;
}

/**
 * Approximates a polyline arc segment defined by a DXF *bulge* (the tangent
 * of a quarter of the arc's included angle) between two vertices. A zero
 * bulge means a straight segment. Getting this right is what makes rounded
 * polylines — slots, filleted rectangles — render as curves instead of
 * chords.
 */
function bulgeToPoints(a: Point, b: Point, bulge: number): Point[] {
  if (!bulge || Math.abs(bulge) < 1e-9) return [b];
  const theta = 4 * Math.atan(bulge); // signed included angle (CCW positive)
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return [b];
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
  const steps = Math.min(96, Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 30))));
  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const ang = a0 + theta * (i / steps);
    out.push({ x: cx + rad * Math.cos(ang), y: cy + rad * Math.sin(ang) });
  }
  return out;
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

/** Emits polyline segments, expanding any bulged segment into an arc. */
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
    const from: Point = { x: a.x, y: a.y };
    let prev = from;
    for (const p of bulgeToPoints(from, { x: b.x, y: b.y }, a.bulge)) {
      out.push(line(prev, p, layer));
      prev = p;
    }
  }
}

export interface DxfParseResult {
  entities: Entity[];
  warnings: string[];
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
          entities.push(
            ...arcToLines(num(raw, 10), num(raw, 20), r, num(raw, 50), num(raw, 51), layer),
          );
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
      // POLYLINE / VERTEX / SEQEND are handled in the legacy second pass below.
      default:
        if (!KNOWN_IGNORED.has(raw.type)) {
          warnings.push(`unsupported entity: ${raw.type}`);
        }
    }
  }

  // Second pass for legacy POLYLINE/VERTEX sequences.
  stitchLegacyPolylines(raws, entities);

  return { entities, warnings: dedupe(warnings) };
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
    } else {
      acc(e.center.x - e.radius, e.center.y - e.radius);
      acc(e.center.x + e.radius, e.center.y + e.radius);
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
      } else {
        body.push(
          `<circle cx="${f(sx(e.center.x))}" cy="${f(sy(e.center.y))}" r="${f(e.radius * scale)}" fill="none"/>`,
        );
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
