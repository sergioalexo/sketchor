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

/** All values for a repeated group code, in order (e.g. polyline X coords). */
function nums(raw: RawEntity, code: number): number[] {
  return raw.pairs.filter((x) => x.code === code).map((x) => parseFloat(x.value));
}

function line(a: Point, b: Point): Entity {
  return { id: newEntityId(), type: "line", a, b };
}

function arcToLines(cx: number, cy: number, r: number, a0deg: number, a1deg: number): Entity[] {
  const a0 = (a0deg * Math.PI) / 180;
  let sweep = ((a1deg - a0deg) % 360 + 360) % 360;
  if (sweep === 0) sweep = 360;
  const steps = Math.min(64, Math.max(2, Math.ceil(sweep / 6)));
  const out: Entity[] = [];
  let prev: Point = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((sweep * Math.PI) / 180) * (i / steps);
    const p = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    out.push(line(prev, p));
    prev = p;
  }
  return out;
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
    switch (raw.type) {
      case "LINE":
        entities.push(
          line(
            { x: num(raw, 10), y: num(raw, 20) },
            { x: num(raw, 11), y: num(raw, 21) },
          ),
        );
        break;
      case "CIRCLE": {
        const r = num(raw, 40);
        if (r > 0) {
          entities.push({
            id: newEntityId(),
            type: "circle",
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
            ...arcToLines(num(raw, 10), num(raw, 20), r, num(raw, 50), num(raw, 51)),
          );
        }
        break;
      }
      case "LWPOLYLINE": {
        const xs = nums(raw, 10);
        const ys = nums(raw, 20);
        const closed = (num(raw, 70) & 1) === 1;
        const verts: Point[] = [];
        for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
          verts.push({ x: xs[i], y: ys[i] });
        }
        for (let i = 0; i + 1 < verts.length; i++) entities.push(line(verts[i], verts[i + 1]));
        if (closed && verts.length > 2) entities.push(line(verts[verts.length - 1], verts[0]));
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
  let verts: Point[] | null = null;
  let closed = false;
  const flush = () => {
    if (verts && verts.length > 1) {
      for (let i = 0; i + 1 < verts.length; i++) entities.push(line(verts[i], verts[i + 1]));
      if (closed && verts.length > 2) entities.push(line(verts[verts.length - 1], verts[0]));
    }
    verts = null;
    closed = false;
  };
  for (const raw of raws) {
    if (raw.type === "POLYLINE") {
      flush();
      verts = [];
      closed = (num(raw, 70) & 1) === 1;
    } else if (raw.type === "VERTEX" && verts) {
      verts.push({ x: num(raw, 10), y: num(raw, 20) });
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
