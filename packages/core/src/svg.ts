import type { ArcEntity, CircleEntity, Entity, ImageEntity, LineEntity, PolylineEntity } from "./entities";
import { layerOf, newEntityId, polylineSegments } from "./entities";
import type { Point } from "./geometry";
import { arcPointAt, arcSweep, bulgeToArc, dist } from "./geometry";
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
  /**
   * How solid a closed shape's `fill` is drawn (default 0.3 — the geometry
   * still reads through it). A printed sheet passes 1: the load plan picks
   * black or white labels from the fill colour, which only works on solid.
   */
  fillOpacity?: number;
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

/** A polyline's segments (straight or bulge-arc) as one SVG path `d` attribute. */
function polylinePathD(e: PolylineEntity, toSvg: (p: Point) => Point): string {
  const parts: string[] = [];
  polylineSegments(e).forEach((seg, i) => {
    const a = toSvg(seg.a);
    if (i === 0) parts.push(`M${fmt(a.x)} ${fmt(a.y)}`);
    const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
    if (!bulgeArc) {
      const b = toSvg(seg.b);
      parts.push(`L${fmt(b.x)} ${fmt(b.y)}`);
      return;
    }
    const sweep = arcSweep(bulgeArc.startAngle, bulgeArc.endAngle, bulgeArc.ccw);
    const steps = Math.min(48, Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * 96)));
    for (let s = 1; s <= steps; s++) {
      const t = bulgeArc.ccw
        ? bulgeArc.startAngle + sweep * (s / steps)
        : bulgeArc.startAngle - sweep * (s / steps);
      const p = toSvg(arcPointAt(bulgeArc.center, bulgeArc.radius, t));
      parts.push(`L${fmt(p.x)} ${fmt(p.y)}`);
    }
  });
  if (e.closed) parts.push("Z");
  return parts.join(" ");
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
  const fillOpacity = opts.fillOpacity ?? 0.3;

  const b = boundsOf(entities) ?? { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const minX = b.minX - padding;
  const minY = b.minY - padding;
  const width = Math.max(b.maxX - b.minX + padding * 2, 1e-6);
  const height = Math.max(b.maxY - b.minY + padding * 2, 1e-6);
  const toSvg = (p: Point): Point => ({ x: p.x - minX, y: minY + height - p.y });

  const byLayer = new Map<string, Entity[]>();
  for (const e of entities) {
    if (e.type === "line" && e.infinite) continue; // construction aid, not geometry
    const l = layerOf(e);
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(e);
  }

  // Per-entity overrides of the document-level stroke/fill: `color` becomes a
  // stroke, and `fill` (closed shapes only) a low-opacity fill so the geometry
  // still reads through it.
  const paint = (e: Entity): string => {
    const closed = e.type === "circle" || (e.type === "polyline" && e.closed);
    let out = "";
    if (e.color) out += ` stroke="${escapeXml(e.color)}"`;
    if (closed && "fill" in e && e.fill) out += ` fill="${escapeXml(e.fill)}" fill-opacity="${fmt(fillOpacity)}"`;
    if ("dashed" in e && e.dashed) out += ` stroke-dasharray="${fmt(strokeWidth * 4)} ${fmt(strokeWidth * 3)}"`;
    return out;
  };

  const groups: string[] = [];
  for (const [layer, ents] of byLayer) {
    const body: string[] = [];
    for (const e of ents) {
      if (e.type === "line") {
        const a = toSvg(e.a);
        const c = toSvg(e.b);
        body.push(`<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(c.x)}" y2="${fmt(c.y)}"${paint(e)}/>`);
      } else if (e.type === "circle") {
        const center = toSvg(e.center);
        body.push(`<circle cx="${fmt(center.x)}" cy="${fmt(center.y)}" r="${fmt(e.radius)}"${paint(e)}/>`);
      } else if (e.type === "point") {
        // SVG has no native point primitive — a small filled dot stands in,
        // sized off stroke width (not to world scale) like a CAD PDMODE marker.
        const p = toSvg(e.p);
        body.push(`<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(strokeWidth * 1.5)}" fill="${stroke}" stroke="none"/>`);
      } else if (e.type === "arc") {
        body.push(`<path d="${arcPathD(e, toSvg)}"${paint(e)}/>`);
      } else if (e.type === "text") {
        const p = toSvg(e.at);
        const rot = e.rotation ? ` transform="rotate(${fmt((-e.rotation * 180) / Math.PI)} ${fmt(p.x)} ${fmt(p.y)})"` : "";
        const col = e.color ? escapeXml(e.color) : stroke;
        body.push(
          `<text x="${fmt(p.x)}" y="${fmt(p.y)}" font-size="${fmt(e.height)}" fill="${col}" stroke="none"${rot}>${escapeXml(e.text)}</text>`,
        );
      } else if (e.type === "image") {
        // The un-rotated top-left corner (insert + (0, height) in world,
        // Y-up), mapped to SVG's Y-down space, plus a rotation transform
        // about the mapped insertion point — same recipe as the text case.
        const topLeft = toSvg({ x: e.insert.x, y: e.insert.y + e.height });
        const pivot = toSvg(e.insert);
        const rot = e.rotation ? ` transform="rotate(${fmt((-e.rotation * 180) / Math.PI)} ${fmt(pivot.x)} ${fmt(pivot.y)})"` : "";
        body.push(
          `<image x="${fmt(topLeft.x)}" y="${fmt(topLeft.y)}" width="${fmt(e.width)}" height="${fmt(e.height)}" ` +
            `href="${escapeXml(e.dataUrl)}" preserveAspectRatio="none"${rot}/>`,
        );
      } else {
        body.push(`<path d="${polylinePathD(e, toSvg)}"${paint(e)}/>`);
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

/** Flatness (world units, mm) Béziers are flattened to — tighter than any drawing tolerance in use. */
const CURVE_TOLERANCE = 0.01;

/**
 * Reads a path's `d` string one token at a time. A regex split can't do this
 * right: `1.5.5` is two numbers, `-.5e-3` is one, and an arc's two flags are
 * single characters that may run straight into the next number (`a1 1 0 0110 10`).
 */
class PathScanner {
  i = 0;
  constructor(private readonly s: string) {}

  private skipSeparators(): void {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i])) this.i++;
  }
  atEnd(): boolean {
    this.skipSeparators();
    return this.i >= this.s.length;
  }
  /** The next command letter, or null when a number (implicit repeat) or the end is next. */
  command(): string | null {
    this.skipSeparators();
    const c = this.s[this.i];
    if (c !== undefined && /[a-zA-Z]/.test(c)) {
      this.i++;
      return c;
    }
    return null;
  }
  /** True when a number starts here (tells "repeat the command" from junk). */
  numberAhead(): boolean {
    this.skipSeparators();
    return /^[-+]?(\d|\.\d)/.test(this.s.slice(this.i, this.i + 3));
  }
  number(): number | null {
    this.skipSeparators();
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return parseFloat(m[0]);
  }
  flag(): number | null {
    this.skipSeparators();
    const c = this.s[this.i];
    if (c !== "0" && c !== "1") return null;
    this.i++;
    return c === "1" ? 1 : 0;
  }
  /** Skips to the next command letter — recovery after a malformed command. */
  skipToCommand(): void {
    while (this.i < this.s.length && !/[a-zA-Z]/.test(this.s[this.i])) this.i++;
  }
}

/** Number of arguments per path command (an arc's two flags count as one each). */
const PATH_ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, Z: 0, C: 6, S: 4, Q: 4, T: 2, A: 7 };

/**
 * Parses an SVG path `d` attribute. M/L/H/V/Z and elliptical arcs (A) are
 * exact (arcs tessellated); C/S/Q/T Béziers, with S/T reflecting the previous
 * control point, are flattened to `CURVE_TOLERANCE` so no geometry is lost
 * (they become splines once C-02 lands). A malformed or unknown command adds
 * a warning and skips only that command, never the rest of the path.
 */
function parsePathD(d: string, m: Mat, layer: string | undefined, out: Entity[], warn: (msg: string) => void): void {
  const sc = new PathScanner(d);
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let cmd = "";
  // The previous curve's last control point, for S/T reflection (only valid
  // straight after a cubic / quadratic respectively).
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;

  // Each subpath (a run between M commands, or split by Z) becomes ONE
  // polyline entity — not one line entity per segment — so the whole shape
  // stays selectable as a single thing.
  let subpath: Point[] = [];
  let subpathClosed = false;
  const toWorld = (p: Point): Point => fromSvgPoint(applyMat(m, p.x, p.y));
  const flush = () => {
    if (subpath.length >= 2) {
      const closed = subpathClosed && dist(subpath[0], subpath[subpath.length - 1]) < 1e-9;
      // A Z repeats the start point, and most exporters (ours included) also
      // write an explicit line back to it first — so drop *every* trailing
      // duplicate, not just one, or the shape keeps a zero-length segment.
      const points = subpath.slice();
      while (closed && points.length > 1 && dist(points[0], points[points.length - 1]) < 1e-9) points.pop();
      if (points.length >= 2) {
        out.push({ id: newEntityId(), type: "polyline", ...(layer ? { layer } : {}), points, closed });
      }
    }
    subpath = [];
    subpathClosed = false;
  };
  const line = (to: Point) => {
    if (subpath.length === 0) subpath.push(toWorld(cur));
    subpath.push(toWorld(to));
    cur = to;
  };
  /** Flattens a cubic (quadratics are elevated to one) in world space and appends the points. */
  const cubic = (p1: Point, p2: Point, p3: Point) => {
    if (subpath.length === 0) subpath.push(toWorld(cur));
    flattenCubic(toWorld(cur), toWorld(p1), toWorld(p2), toWorld(p3), CURVE_TOLERANCE, subpath);
    cur = p3;
  };

  while (!sc.atEnd()) {
    const letter = sc.command();
    if (letter !== null) {
      cmd = letter;
    } else if (!cmd || cmd.toUpperCase() === "Z" || !sc.numberAhead()) {
      // A number with no command to repeat (or after Z), or stray punctuation.
      warn("a path had stray characters after a command — skipped");
      sc.skipToCommand();
      continue;
    }
    const C = cmd.toUpperCase();
    const argc = PATH_ARGS[C];
    if (argc === undefined) {
      warn(`a path used an unknown command "${cmd}" — that command was skipped`);
      sc.skipToCommand();
      cmd = "";
      continue;
    }
    const relative = cmd !== C;
    const args: number[] = [];
    for (let k = 0; k < argc; k++) {
      const v = C === "A" && (k === 3 || k === 4) ? sc.flag() : sc.number();
      if (v === null) break;
      args.push(v);
    }
    if (args.length < argc) {
      warn(`a path command "${cmd}" had missing or malformed arguments — that command was skipped`);
      sc.skipToCommand();
      cmd = "";
      continue;
    }
    const ox = relative ? cur.x : 0;
    const oy = relative ? cur.y : 0;
    const prevCubic = lastCubic;
    const prevQuad = lastQuad;
    lastCubic = null;
    lastQuad = null;
    switch (C) {
      case "M": {
        flush(); // a new subpath starts — the previous one is done
        cur = { x: ox + args[0], y: oy + args[1] };
        start = cur;
        cmd = relative ? "l" : "L"; // subsequent pairs are an implicit lineto
        break;
      }
      case "L":
        line({ x: ox + args[0], y: oy + args[1] });
        break;
      case "H":
        line({ x: ox + args[0], y: cur.y });
        break;
      case "V":
        line({ x: cur.x, y: oy + args[0] });
        break;
      case "Z":
        subpathClosed = true;
        line(start);
        break;
      case "C": {
        const p2 = { x: ox + args[2], y: oy + args[3] };
        cubic({ x: ox + args[0], y: oy + args[1] }, p2, { x: ox + args[4], y: oy + args[5] });
        lastCubic = p2;
        break;
      }
      case "S": {
        const p1 = prevCubic ? { x: 2 * cur.x - prevCubic.x, y: 2 * cur.y - prevCubic.y } : cur;
        const p2 = { x: ox + args[0], y: oy + args[1] };
        cubic(p1, p2, { x: ox + args[2], y: oy + args[3] });
        lastCubic = p2;
        break;
      }
      case "Q":
      case "T": {
        const q: Point =
          C === "Q"
            ? { x: ox + args[0], y: oy + args[1] }
            : prevQuad
              ? { x: 2 * cur.x - prevQuad.x, y: 2 * cur.y - prevQuad.y }
              : cur;
        const e = C === "Q" ? { x: ox + args[2], y: oy + args[3] } : { x: ox + args[0], y: oy + args[1] };
        // Degree elevation: a quadratic is exactly the cubic with these controls.
        const c1 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) };
        const c2 = { x: e.x + (2 / 3) * (q.x - e.x), y: e.y + (2 / 3) * (q.y - e.y) };
        cubic(c1, c2, e);
        lastQuad = q;
        break;
      }
      case "A": {
        const [rx, ry, rot, la, sw] = args;
        const to = { x: ox + args[5], y: oy + args[6] };
        const params = arcEndpointToCenter(cur, rx, ry, rot, la !== 0, sw !== 0, to);
        if (!params) {
          line(to);
          break;
        }
        const steps = Math.min(96, Math.max(2, Math.ceil((Math.abs(params.dtheta) / (2 * Math.PI)) * 96)));
        for (let s = 1; s <= steps; s++) {
          const t = params.theta1 + params.dtheta * (s / steps);
          const ex = params.rx * Math.cos(t);
          const ey = params.ry * Math.sin(t);
          const cosPhi = Math.cos(params.phi);
          const sinPhi = Math.sin(params.phi);
          line({ x: params.cx + ex * cosPhi - ey * sinPhi, y: params.cy + ex * sinPhi + ey * cosPhi });
        }
        cur = to;
        break;
      }
    }
  }
  flush();
}

/**
 * Appends the flattened cubic (excluding its start point, which the caller
 * already has) to `pts`. Recursive de Casteljau subdivision until both
 * control points lie within `tol` of the chord; depth-capped so a NaN or
 * enormous curve can't recurse forever.
 */
function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, tol: number, pts: Point[], depth = 0): void {
  const chord = dist(p0, p3);
  const off = (p: Point): number =>
    chord < 1e-12 ? dist(p, p0) : Math.abs((p3.x - p0.x) * (p0.y - p.y) - (p0.x - p.x) * (p3.y - p0.y)) / chord;
  if (depth >= 16 || (off(p1) <= tol && off(p2) <= tol)) {
    pts.push(p3);
    return;
  }
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const m = mid(p012, p123);
  flattenCubic(p0, p01, p012, m, tol, pts, depth + 1);
  flattenCubic(m, p123, p23, p3, tol, pts, depth + 1);
}

export interface SvgImportResult {
  entities: Entity[];
  warnings: string[];
}

/**
 * Parses SVG into entities: line/circle/ellipse/rect/polyline/polygon
 * exactly, paths incl. Béziers (arcs and curves flattened).
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
          entities.push({
            id: newEntityId(),
            type: "polyline",
            ...(layer ? { layer } : {}),
            points: corners,
            closed: true,
          });
          break;
        }
        case "image": {
          const x = numAttr(child, "x");
          const y = numAttr(child, "y");
          const w = numAttr(child, "width");
          const h = numAttr(child, "height");
          const href = child.getAttribute("href") ?? child.getAttributeNS("http://www.w3.org/1999/xlink", "href");
          if (w > 0 && h > 0 && href) {
            if (!href.startsWith("data:")) {
              warnings.push("an <image> referencing an external file (not an embedded data: URI) was skipped");
              break;
            }
            const [ma, mb, mc, md] = m;
            const colScaleA = Math.hypot(ma, mb);
            const colScaleC = Math.hypot(mc, md);
            const orthogonalAndUniform =
              Math.abs(ma * mc + mb * md) < 1e-6 * (colScaleA * colScaleC || 1) &&
              Math.abs(colScaleA - colScaleC) < 1e-6 * (colScaleA || 1);
            if (!orthogonalAndUniform) {
              warnings.push("an <image> had a skewed or non-uniform transform — imported as a plain rotated rectangle");
            }
            entities.push({
              id: newEntityId(),
              type: "image",
              ...(layer ? { layer } : {}),
              // The un-rotated bottom-left corner in world (Y-up) is (x, y + h)
              // in SVG (Y-down) space — same recipe as export, run backwards.
              insert: fromSvgPoint(applyMat(m, x, y + h)),
              width: w * matScale(m),
              height: h * matScale(m),
              rotation: -Math.atan2(mb, ma),
              dataUrl: href,
            } as ImageEntity);
          }
          break;
        }
        case "polyline":
        case "polygon": {
          const raw = (child.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
          const pts: Point[] = [];
          for (let k = 0; k + 1 < raw.length; k += 2) pts.push(fromSvgPoint(applyMat(m, raw[k], raw[k + 1])));
          if (pts.length >= 2) {
            entities.push({
              id: newEntityId(),
              type: "polyline",
              ...(layer ? { layer } : {}),
              points: pts,
              closed: child.tagName.toLowerCase() === "polygon",
            });
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
