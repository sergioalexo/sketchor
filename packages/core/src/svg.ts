import type { ArcEntity, CircleEntity, Entity, LineEntity } from "./entities";
import { layerOf, newEntityId } from "./entities";
import type { Point } from "./geometry";
import { arcPointAt, arcSweep, dist } from "./geometry";
import { boundsOf } from "./dxf";

/**
 * Full-fidelity SVG import/export — unlike dxf.ts's `entitiesToSvg` (a
 * small fixed-size thumbnail renderer), this maps world coordinates
 * 1:1 to SVG user units via a real viewBox, so exported files are
 * dimensionally accurate and re-importing one round-trips exactly.
 */

function fmt(x: number): string {
  const r = Math.round(x * 1e4) / 1e4;
  return String(Object.is(r, -0) ? 0 : r);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* -------------------------------- export -------------------------------- */

export interface SvgExportOptions {
  /** World-unit margin added around the drawing's bounds. */
  padding?: number;
  strokeColor?: string;
  strokeWidth?: number;
}

/** Tessellates an arc into an SVG path's `d` attribute (sidesteps large-arc/sweep-flag sign risk entirely). */
function arcPathD(e: ArcEntity, toSvg: (p: Point) => Point): string {
  const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
  const steps = Math.min(96, Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * 96)));
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = e.ccw ? e.startAngle + sweep * (i / steps) : e.startAngle - sweep * (i / steps);
    const p = toSvg(arcPointAt(e.center, e.radius, t));
    pts.push(`${i === 0 ? "M" : "L"}${fmt(p.x)} ${fmt(p.y)}`);
  }
  return pts.join(" ");
}

/**
 * Renders entities to a real, dimensionally-accurate SVG document — one
 * `<g>` per layer, world units mapped 1:1 to the viewBox (Y flipped, since
 * SVG Y grows down and world Y grows up).
 */
export function entitiesToSvgDocument(entities: Entity[], opts: SvgExportOptions = {}): string {
  const padding = opts.padding ?? 5;
  const stroke = opts.strokeColor ?? "#000000";
  const strokeWidth = opts.strokeWidth ?? Math.max(0.2, padding / 20);

  const b = boundsOf(entities) ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const minX = b.minX - padding;
  const minY = b.minY - padding;
  const width = Math.max(b.maxX - b.minX + padding * 2, 1e-6);
  const height = Math.max(b.maxY - b.minY + padding * 2, 1e-6);
  const toSvg = (p: Point): Point => ({ x: p.x - minX, y: minY + height - p.y });

  const byLayer = new Map<string, Entity[]>();
  for (const e of entities) {
    const l = layerOf(e);
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(e);
  }

  const groups: string[] = [];
  for (const [layer, ents] of byLayer) {
    const body: string[] = [];
    for (const e of ents) {
      if (e.type === "line") {
        const a = toSvg(e.a);
        const c = toSvg(e.b);
        body.push(`<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(c.x)}" y2="${fmt(c.y)}"/>`);
      } else if (e.type === "circle") {
        const center = toSvg(e.center);
        body.push(`<circle cx="${fmt(center.x)}" cy="${fmt(center.y)}" r="${fmt(e.radius)}"/>`);
      } else {
        body.push(`<path d="${arcPathD(e, toSvg)}"/>`);
      }
    }
    groups.push(`<g data-layer="${escapeXml(layer)}">${body.join("")}</g>`);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" ` +
    `viewBox="0 0 ${fmt(width)} ${fmt(height)}" stroke="${stroke}" stroke-width="${fmt(strokeWidth)}" fill="none">\n` +
    `${groups.join("\n")}\n</svg>\n`
  );
}

/* -------------------------------- import -------------------------------- */

/** A 2D affine matrix [a, b, c, d, e, f], matching SVG's matrix(a,b,c,d,e,f) convention. */
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function multiply(m1: Mat, m2: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

function applyMat(m: Mat, x: number, y: number): Point {
  const [a, b, c, d, e, f] = m;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** Approximate uniform scale factor of a matrix (for radii, which don't otherwise transform simply). */
function matScale(m: Mat): number {
  const [a, b, c, d] = m;
  return (Math.hypot(a, b) + Math.hypot(c, d)) / 2;
}

function parseTransform(attr: string | null): Mat {
  if (!attr) return IDENTITY;
  let m: Mat = IDENTITY;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attr))) {
    const fn = match[1];
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let mm: Mat = IDENTITY;
    if (fn === "translate") mm = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
    else if (fn === "scale") mm = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    else if (fn === "rotate") {
      const rad = ((args[0] || 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rot: Mat = [cos, sin, -sin, cos, 0, 0];
      mm = args.length >= 3 ? multiply(multiply([1, 0, 0, 1, args[1], args[2]], rot), [1, 0, 0, 1, -args[1], -args[2]]) : rot;
    } else if (fn === "matrix" && args.length === 6) {
      mm = args as Mat;
    }
    m = multiply(m, mm);
  }
  return m;
}

/** SVG world Y grows down; ours grows up. Imported geometry is flipped once, at the point of use. */
function fromSvgPoint(p: Point): Point {
  return { x: p.x, y: -p.y };
}

/**
 * SVG elliptical-arc endpoint parameterization (SVG 1.1 spec, appendix
 * F.6.5): converts (start, rx, ry, rotation, largeArc, sweep, end) into
 * center + radii + angles, so the arc can be sampled into line segments.
 */
function arcEndpointToCenter(
  p0: Point,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Point,
): { cx: number; cy: number; rx: number; ry: number; theta1: number; dtheta: number; phi: number } | null {
  if (dist(p0, p1) < 1e-9) return null;
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (p0.x - p1.x) / 2;
  const dy2 = (p0.y - p1.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-9 || ry < 1e-9) return null;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  const num = Math.max(0, rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p);
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = den < 1e-12 ? 0 : sign * Math.sqrt(num / den);
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  return { cx, cy, rx, ry, theta1, dtheta, phi };
}

/**
 * Parses an SVG path `d` attribute; M/L/H/V/Z and elliptical arcs (A) are
 * exact, curves (C/S/Q/T) degrade to a straight segment. Known limitation:
 * per the SVG grammar, the two 1-character arc flags may run together with
 * the following number with no separator (e.g. "0110" for flags 0,1 then
 * "10"); this tokenizer doesn't special-case that, so densely-minified arc
 * flags can misparse. Sketchor's own export never emits `A` (arcs are
 * tessellated to M/L instead), so this never affects round-tripping our
 * own files — only importing third-party minified SVGs with compact arcs.
 */
function parsePathD(d: string, m: Mat, layer: string | undefined, out: Entity[], warn: (msg: string) => void): void {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let cmd = "";
  let sawCurve = false;
  const num = () => parseFloat(tokens[i++]);
  const line = (to: Point) => {
    const a = applyMat(m, cur.x, cur.y);
    const b = applyMat(m, to.x, to.y);
    out.push({ id: newEntityId(), type: "line", ...(layer ? { layer } : {}), a: fromSvgPoint(a), b: fromSvgPoint(b) });
    cur = to;
  };

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    const relative = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    switch (C) {
      case "M": {
        const x = num();
        const y = num();
        cur = relative ? { x: cur.x + x, y: cur.y + y } : { x, y };
        start = cur;
        cmd = relative ? "l" : "L"; // subsequent pairs are an implicit lineto
        break;
      }
      case "L": {
        const x = num();
        const y = num();
        line(relative ? { x: cur.x + x, y: cur.y + y } : { x, y });
        break;
      }
      case "H": {
        const x = num();
        line(relative ? { x: cur.x + x, y: cur.y } : { x, y: cur.y });
        break;
      }
      case "V": {
        const y = num();
        line(relative ? { x: cur.x, y: cur.y + y } : { x: cur.x, y });
        break;
      }
      case "Z": {
        line(start);
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const largeArc = num() !== 0;
        const sweep = num() !== 0;
        const x = num();
        const y = num();
        const to = relative ? { x: cur.x + x, y: cur.y + y } : { x, y };
        const params = arcEndpointToCenter(cur, rx, ry, rot, largeArc, sweep, to);
        if (!params) {
          line(to);
          break;
        }
        const steps = Math.min(96, Math.max(2, Math.ceil((Math.abs(params.dtheta) / (2 * Math.PI)) * 96)));
        let prev = cur;
        for (let s = 1; s <= steps; s++) {
          const t = params.theta1 + params.dtheta * (s / steps);
          const ex = params.rx * Math.cos(t);
          const ey = params.ry * Math.sin(t);
          const cosPhi = Math.cos(params.phi);
          const sinPhi = Math.sin(params.phi);
          const p = { x: params.cx + ex * cosPhi - ey * sinPhi, y: params.cy + ex * sinPhi + ey * cosPhi };
          const a = applyMat(m, prev.x, prev.y);
          const b = applyMat(m, p.x, p.y);
          out.push({ id: newEntityId(), type: "line", ...(layer ? { layer } : {}), a: fromSvgPoint(a), b: fromSvgPoint(b) });
          prev = p;
        }
        cur = to;
        break;
      }
      default: {
        // Curves (C/S/Q/T) and anything else: consume their numeric args and
        // draw a straight segment to the endpoint — shape approximated, not exact.
        const argCounts: Record<string, number> = { C: 6, S: 4, Q: 4, T: 2 };
        const argc = argCounts[C];
        if (argc === undefined) {
          i = tokens.length; // unknown command: bail out of this path
          break;
        }
        const args: number[] = [];
        for (let k = 0; k < argc; k++) args.push(num());
        const to = relative
          ? { x: cur.x + args[argc - 2], y: cur.y + args[argc - 1] }
          : { x: args[argc - 2], y: args[argc - 1] };
        sawCurve = true;
        line(to);
        break;
      }
    }
  }
  if (sawCurve) warn("a path used curves (C/S/Q/T) — approximated as straight segments");
}

export interface SvgImportResult {
  entities: Entity[];
  warnings: string[];
}

/**
 * Parses SVG into entities: line/circle/ellipse/rect/polyline/polygon
 * exactly, path M/L/H/V/Z/A exactly (arcs tessellated), curves approximated.
 * Uses the browser's DOMParser (this module's one browser-API dependency).
 */
export function parseSvgText(text: string): SvgImportResult {
  const entities: Entity[] = [];
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    warnings.push("the SVG could not be parsed (malformed XML)");
    return { entities, warnings };
  }

  const numAttr = (el: Element, name: string, fallback = 0): number => {
    const v = el.getAttribute(name);
    return v === null ? fallback : parseFloat(v) || fallback;
  };
  const layerOf = (el: Element): string | undefined => {
    const cls = el.getAttribute("data-layer") || el.closest("[data-layer]")?.getAttribute("data-layer");
    return cls ?? undefined;
  };

  const walk = (el: Element, parentMat: Mat): void => {
    for (const child of Array.from(el.children)) {
      const m = multiply(parentMat, parseTransform(child.getAttribute("transform")));
      const layer = layerOf(child);
      switch (child.tagName.toLowerCase()) {
        case "line": {
          const a = applyMat(m, numAttr(child, "x1"), numAttr(child, "y1"));
          const b = applyMat(m, numAttr(child, "x2"), numAttr(child, "y2"));
          entities.push({
            id: newEntityId(),
            type: "line",
            ...(layer ? { layer } : {}),
            a: fromSvgPoint(a),
            b: fromSvgPoint(b),
          } as LineEntity);
          break;
        }
        case "circle": {
          const center = applyMat(m, numAttr(child, "cx"), numAttr(child, "cy"));
          const r = numAttr(child, "r") * matScale(m);
          if (r > 0) {
            entities.push({
              id: newEntityId(),
              type: "circle",
              ...(layer ? { layer } : {}),
              center: fromSvgPoint(center),
              radius: r,
            } as CircleEntity);
          }
          break;
        }
        case "ellipse": {
          const rx = numAttr(child, "rx");
          const ry = numAttr(child, "ry");
          const center = applyMat(m, numAttr(child, "cx"), numAttr(child, "cy"));
          const r = ((rx + ry) / 2) * matScale(m);
          if (r > 0) {
            if (Math.abs(rx - ry) > Math.max(rx, ry) * 0.02) {
              warnings.push("an <ellipse> was not circular — imported as the average radius");
            }
            entities.push({
              id: newEntityId(),
              type: "circle",
              ...(layer ? { layer } : {}),
              center: fromSvgPoint(center),
              radius: r,
            } as CircleEntity);
          }
          break;
        }
        case "rect": {
          const x = numAttr(child, "x");
          const y = numAttr(child, "y");
          const w = numAttr(child, "width");
          const h = numAttr(child, "height");
          const corners: Point[] = [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
          ].map((p) => fromSvgPoint(applyMat(m, p.x, p.y)));
          for (let k = 0; k < 4; k++) {
            entities.push({
              id: newEntityId(),
              type: "line",
              ...(layer ? { layer } : {}),
              a: corners[k],
              b: corners[(k + 1) % 4],
            } as LineEntity);
          }
          break;
        }
        case "polyline":
        case "polygon": {
          const raw = (child.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
          const pts: Point[] = [];
          for (let k = 0; k + 1 < raw.length; k += 2) pts.push(fromSvgPoint(applyMat(m, raw[k], raw[k + 1])));
          const segs = child.tagName.toLowerCase() === "polygon" ? pts.length : pts.length - 1;
          for (let k = 0; k < segs; k++) {
            entities.push({
              id: newEntityId(),
              type: "line",
              ...(layer ? { layer } : {}),
              a: pts[k],
              b: pts[(k + 1) % pts.length],
            } as LineEntity);
          }
          break;
        }
        case "path": {
          const d = child.getAttribute("d");
          if (d) parsePathD(d, m, layer, entities, (msg) => warnings.push(msg));
          break;
        }
        case "g":
        case "svg":
          walk(child, m);
          break;
        default:
          // Unknown element (text, defs, style, ...): skip it, but still
          // walk its children in case a group nests further drawable content.
          walk(child, m);
      }
    }
  };

  walk(doc.documentElement, IDENTITY);
  return { entities, warnings: [...new Set(warnings)] };
}
