import type { HatchEdge, HatchEntity, HatchLoop, HatchPaint, PatternFamily } from "../entities";
import { loopFromPolyline } from "./loops";
import { paintFamilies } from "./fillLines";
import { GRADIENT_NAMES, gradientColors } from "./gradient";

/**
 * DXF HATCH (H-09), as pure data: `parseDxfHatch` reads one record's group
 * pairs, `hatchDxfPairs` produces the groups to write.
 *
 * Boundary paths come in two shapes — a polyline (vertices with optional
 * bulges) or a chain of typed edges (1 line, 2 circular arc, 3 elliptic arc,
 * 4 spline). The pattern definition lines (53/43/44/45/46/79/49) are stored
 * *as applied* — rotated by the hatch angle and scaled — so reading divides the
 * angle and scale back out (a pattern Sketchor does not have still renders
 * exactly) and writing applies them. A line's offset (45, 46) is a world
 * vector there; Sketchor's families use the `.pat` convention (x along the
 * line, y perpendicular), hence the rotation by the line's own angle.
 */

export interface DxfPair {
  code: number;
  value: string;
}

export interface ParsedDxfHatch {
  loops: HatchLoop[];
  paint: HatchPaint;
  style: HatchEntity["style"];
  associative: boolean;
  sourceHandles: string[];
  transparency?: number;
}

const RAD = Math.PI / 180;
const f = (s: string): number => parseFloat(s);

class Cursor {
  i = 0;
  constructor(readonly pairs: DxfPair[], start: number) {
    this.i = start;
  }
  peek(): DxfPair | undefined {
    return this.pairs[this.i];
  }
  /** Value of the next pair when it has `code` (consuming it), else undefined. */
  take(code: number): string | undefined {
    const p = this.pairs[this.i];
    if (p && p.code === code) {
      this.i++;
      return p.value;
    }
    return undefined;
  }
  num(code: number, fallback = 0): number {
    const v = this.take(code);
    const x = v === undefined ? NaN : f(v);
    return Number.isFinite(x) ? x : fallback;
  }
}

function readEdge(c: Cursor): HatchEdge | null {
  const type = Math.round(c.num(72, -1));
  if (type === 1) {
    const a = { x: c.num(10), y: c.num(20) };
    const b = { x: c.num(11), y: c.num(21) };
    return { type: "line", a, b };
  }
  if (type === 2) {
    const center = { x: c.num(10), y: c.num(20) };
    const radius = c.num(40);
    const start = c.num(50) * RAD;
    const end = c.num(51, 360) * RAD;
    const ccw = c.num(73, 1) !== 0;
    return radius > 0 ? { type: "arc", center, radius, startAngle: start, endAngle: end, ccw } : null;
  }
  if (type === 3) {
    const center = { x: c.num(10), y: c.num(20) };
    const major = { x: c.num(11), y: c.num(21) };
    const ratio = c.num(40, 1);
    let start = c.num(50) * RAD;
    let end = c.num(51, 360) * RAD;
    if (c.num(73, 1) === 0) [start, end] = [end, start];
    if (end <= start) end += 2 * Math.PI * Math.ceil((start - end) / (2 * Math.PI) + 1e-12);
    if (Math.hypot(major.x, major.y) < 1e-12 || !(ratio > 0)) return null;
    return ratio > 1
      ? { type: "ellipse", center, majorAxis: { x: -major.y * ratio, y: major.x * ratio }, ratio: 1 / ratio, start: start - Math.PI / 2, end: end - Math.PI / 2 }
      : { type: "ellipse", center, majorAxis: major, ratio, start, end };
  }
  if (type === 4) {
    const degree = Math.round(c.num(94, 3));
    const rational = c.num(73) !== 0;
    const periodic = c.num(74) !== 0;
    const nk = Math.max(0, Math.round(c.num(95)));
    const nc = Math.max(0, Math.round(c.num(96)));
    if (nk > 100000 || nc > 100000) return null;
    const knots: number[] = [];
    for (let k = 0; k < nk; k++) knots.push(c.num(40));
    const controlPoints: { x: number; y: number }[] = [];
    const weights: number[] = [];
    for (let k = 0; k < nc; k++) {
      controlPoints.push({ x: c.num(10), y: c.num(20) });
      if (rational) weights.push(c.num(42, 1));
    }
    // Optional fit data (R2010): a count, then points and tangents. A bare 97 not followed by fit points is the path's source count.
    const p = c.peek();
    if (p && p.code === 97) {
      const n = Math.round(f(p.value));
      const next = c.pairs[c.i + 1];
      if (n === 0 && (!next || next.code !== 330)) c.i++;
      else if (n > 0 && next && next.code === 11) {
        c.i++;
        for (let k = 0; k < n; k++) {
          c.take(11);
          c.take(21);
        }
        if (c.take(12) !== undefined) c.take(22);
        if (c.take(13) !== undefined) c.take(23);
      }
    }
    if (controlPoints.length < degree + 1 || knots.length !== controlPoints.length + degree + 1) return null;
    return { type: "spline", degree, controlPoints, knots, ...(rational ? { weights } : {}), ...(periodic ? { closed: true } : {}) };
  }
  return null;
}

function readLoop(c: Cursor, warn: string[]): HatchLoop | null {
  const flags = Math.round(c.num(92, 0));
  const loop: HatchLoop = { edges: [] };
  if (flags & 2) {
    const hasBulge = c.num(72) !== 0;
    c.take(73);
    const n = Math.round(c.num(93));
    if (n < 0 || n > 1e6) return null;
    const points: { x: number; y: number }[] = [];
    const bulges: number[] = [];
    for (let k = 0; k < n; k++) {
      points.push({ x: c.num(10), y: c.num(20) });
      bulges.push(hasBulge ? c.num(42) : 0);
    }
    if (points.length >= 2) loop.edges = loopFromPolyline({ points, bulges: bulges.some((b) => b !== 0) ? bulges : undefined, closed: true }).edges;
  } else {
    const n = Math.round(c.num(93));
    if (n < 0 || n > 1e6) return null;
    for (let k = 0; k < n; k++) {
      const e = readEdge(c);
      if (e) loop.edges.push(e);
      else warn.push("a hatch boundary edge could not be read");
    }
  }
  if (flags & 1 || flags & 16) loop.outer = true;
  if (flags & 4) loop.derived = true;
  return loop.edges.length > 0 ? loop : null;
}

function colorOfInt(v: number): string {
  return `#${(v & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** Reads one HATCH record. Null when it has no usable boundary. */
export function parseDxfHatch(pairs: DxfPair[], warnings: string[] = []): ParsedDxfHatch | null {
  const find = (code: number, from = 0): number => {
    for (let i = from; i < pairs.length; i++) if (pairs[i].code === code) return i;
    return -1;
  };
  const at91 = find(91);
  if (at91 < 0) return null;
  const head = pairs.slice(0, at91);
  const headVal = (code: number): string | undefined => head.find((p) => p.code === code)?.value;
  const name = (headVal(2) ?? "").trim();
  const solidFlag = Math.round(f(headVal(70) ?? "0")) === 1;
  const associative = Math.round(f(headVal(71) ?? "0")) === 1;

  const c = new Cursor(pairs, at91);
  const nPaths = Math.round(c.num(91));
  if (!(nPaths >= 0 && nPaths <= 100000)) return null;
  const loops: HatchLoop[] = [];
  const sourceHandles: string[] = [];
  for (let k = 0; k < nPaths; k++) {
    if (c.peek()?.code !== 92) break;
    const loop = readLoop(c, warnings);
    if (loop) loops.push(loop);
    const ns = c.take(97);
    if (ns !== undefined) for (let s = 0; s < Math.round(f(ns)); s++) {
      const h = c.take(330);
      if (h !== undefined) sourceHandles.push(h.trim());
    }
  }
  if (loops.length === 0) return null;

  // The rest of the record: style, pattern data, then (R2004+) gradient data.
  const rest = pairs.slice(c.i);
  const val = (code: number): string | undefined => rest.find((p) => p.code === code)?.value;
  const styleCode = Math.round(f(val(75) ?? "0"));
  const style: HatchEntity["style"] = styleCode === 1 ? "outer" : styleCode === 2 ? "ignore" : "normal";
  const transRaw = headVal(440);
  let transparency: number | undefined;
  if (transRaw !== undefined) {
    const v = Math.round(f(transRaw));
    if (v >>> 24 === 2) transparency = Math.min(1, Math.max(0, 1 - (v & 0xff) / 255));
  }

  let paint: HatchPaint;
  if (val(450) !== undefined && Math.round(f(val(450)!)) === 1) {
    const colors = rest.filter((p) => p.code === 421).map((p) => colorOfInt(Math.round(f(p.value))));
    const single = Math.round(f(val(452) ?? "0")) === 1;
    const gname = (val(470) ?? "LINEAR").trim().toUpperCase();
    const shift = f(val(461) ?? "0");
    paint = {
      kind: "gradient",
      name: (GRADIENT_NAMES as readonly string[]).includes(gname) ? gname : "LINEAR",
      colors: single || colors.length < 2 ? [colors[0] ?? "#808080"] : [colors[0], colors[1]],
      angle: (f(val(460) ?? "0") * 180) / Math.PI,
      ...(Number.isFinite(shift) && Math.abs(shift) > 1e-9 ? { centered: false, shift } : {}),
    };
  } else if (solidFlag) {
    paint = { kind: "solid", color: "" };
  } else {
    const angle = f(val(52) ?? "0") || 0;
    let scale = f(val(41) ?? "1");
    if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) scale = 1;
    scale = Math.abs(scale);
    paint = { kind: "pattern", name: name || "USER", scale, angle };
    // Pattern definition lines, in application order.
    const at78 = rest.findIndex((p) => p.code === 78);
    if (at78 >= 0) {
      const pc = new Cursor(rest, at78);
      const nl = Math.round(pc.num(78));
      const fams: PatternFamily[] = [];
      const ra = angle * RAD;
      for (let k = 0; k < nl && k < 10000; k++) {
        if (pc.peek()?.code !== 53) break;
        const aw = pc.num(53);
        const bx = pc.num(43);
        const by = pc.num(44);
        const ox = pc.num(45);
        const oy = pc.num(46);
        const nd = Math.round(pc.num(79));
        const dashes: number[] = [];
        for (let d = 0; d < nd; d++) dashes.push(pc.num(49) / scale);
        const aR = aw * RAD;
        fams.push({
          angle: aw - angle,
          origin: { x: (bx * Math.cos(-ra) - by * Math.sin(-ra)) / scale, y: (bx * Math.sin(-ra) + by * Math.cos(-ra)) / scale },
          offset: { x: (ox * Math.cos(-aR) - oy * Math.sin(-aR)) / scale, y: (ox * Math.sin(-aR) + oy * Math.cos(-aR)) / scale },
          dashes,
        });
      }
      if (fams.length > 0) paint.def = fams;
    }
  }
  return { loops, paint, style, associative: associative && sourceHandles.length > 0, sourceHandles, ...(transparency !== undefined && transparency > 0 ? { transparency } : {}) };
}

/* --------------------------------- writing -------------------------------- */

/** `i` = integer group, `f` = float group (written with a decimal point), `s` = string. */
export type OutPair = [code: number, value: number | string, kind: "i" | "f" | "s"];

function colorInt(color: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  return m ? parseInt(m[1], 16) : 0x808080;
}

function loopPairs(loop: HatchLoop, index: number): OutPair[] {
  const out: OutPair[] = [[92, (index === 0 || loop.outer ? 1 | 16 : 0) | (loop.derived ? 4 : 0), "i"], [93, loop.edges.length, "i"]];
  for (const e of loop.edges) {
    switch (e.type) {
      case "line":
        out.push([72, 1, "i"], [10, e.a.x, "f"], [20, e.a.y, "f"], [11, e.b.x, "f"], [21, e.b.y, "f"]);
        break;
      case "arc":
        out.push([72, 2, "i"], [10, e.center.x, "f"], [20, e.center.y, "f"], [40, e.radius, "f"], [50, (e.startAngle * 180) / Math.PI, "f"], [51, (e.endAngle * 180) / Math.PI, "f"], [73, e.ccw ? 1 : 0, "i"]);
        break;
      case "ellipse":
        out.push([72, 3, "i"], [10, e.center.x, "f"], [20, e.center.y, "f"], [11, e.majorAxis.x, "f"], [21, e.majorAxis.y, "f"], [40, e.ratio, "f"], [50, (e.start * 180) / Math.PI, "f"], [51, (e.end * 180) / Math.PI, "f"], [73, 1, "i"]);
        break;
      case "spline": {
        const rational = !!e.weights && e.weights.length === e.controlPoints.length;
        out.push([72, 4, "i"], [94, e.degree, "i"], [73, rational ? 1 : 0, "i"], [74, 0, "i"], [95, e.knots.length, "i"], [96, e.controlPoints.length, "i"]);
        for (const k of e.knots) out.push([40, k, "f"]);
        e.controlPoints.forEach((p, i) => {
          out.push([10, p.x, "f"], [20, p.y, "f"]);
          if (rational) out.push([42, e.weights![i], "f"]);
        });
        out.push([97, 0, "i"]);
        break;
      }
    }
  }
  out.push([97, 0, "i"]);
  return out;
}

/** The HATCH-specific groups (everything after `100 AcDbHatch`'s entity head), and the transparency group (440) to put in the entity head. */
export function hatchDxfPairs(h: HatchEntity): { head: OutPair[]; body: OutPair[] } {
  const p = h.paint;
  const head: OutPair[] = [];
  if (h.transparency && h.transparency > 0) head.push([440, 0x02000000 | Math.round((1 - Math.min(1, h.transparency)) * 255), "i"]);
  const solid = p.kind !== "pattern";
  const body: OutPair[] = [
    [10, 0, "f"], [20, 0, "f"], [30, 0, "f"],
    [210, 0, "f"], [220, 0, "f"], [230, 1, "f"],
    [2, solid ? "SOLID" : p.name, "s"],
    [70, solid ? 1 : 0, "i"],
    [71, 0, "i"],
    [91, h.loops.length, "i"],
  ];
  h.loops.forEach((l, i) => body.push(...loopPairs(l, i)));
  body.push([75, h.style === "outer" ? 1 : h.style === "ignore" ? 2 : 0, "i"], [76, 1, "i"]);
  if (p.kind === "pattern") {
    body.push([52, p.angle, "f"], [41, p.scale, "f"], [77, 0, "i"]);
    const fams = paintFamilies(p) ?? [];
    body.push([78, fams.length, "i"]);
    const ra = p.angle * RAD;
    for (const fam of fams) {
      const a = (fam.angle + p.angle) * RAD;
      const ox = (fam.origin.x * Math.cos(ra) - fam.origin.y * Math.sin(ra)) * p.scale + (p.origin?.x ?? 0);
      const oy = (fam.origin.x * Math.sin(ra) + fam.origin.y * Math.cos(ra)) * p.scale + (p.origin?.y ?? 0);
      const dx = fam.offset.x * p.scale;
      const dy = fam.offset.y * p.scale;
      body.push(
        [53, fam.angle + p.angle, "f"],
        [43, ox, "f"], [44, oy, "f"],
        [45, dx * Math.cos(a) - dy * Math.sin(a), "f"], [46, dx * Math.sin(a) + dy * Math.cos(a), "f"],
        [79, fam.dashes.length, "i"],
      );
      for (const d of fam.dashes) body.push([49, d * p.scale, "f"]);
    }
  }
  body.push([47, 1, "f"], [98, 0, "i"]);
  if (p.kind === "gradient") {
    const [c1, c2] = gradientColors(p);
    const single = p.colors[1] === undefined;
    body.push(
      [450, 1, "i"], [451, 0, "i"], [460, (p.angle * Math.PI) / 180, "f"], [461, p.centered === false ? (p.shift ?? 0.3) : 0, "f"],
      [452, single ? 1 : 0, "i"], [462, 1, "f"], [453, 2, "i"],
      [463, 0, "f"], [63, 5, "i"], [421, colorInt(c1), "i"],
      [463, 1, "f"], [63, 2, "i"], [421, colorInt(c2), "i"],
      [470, p.name.toUpperCase(), "s"],
    );
  }
  return { head, body };
}
