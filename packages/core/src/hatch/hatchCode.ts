import type { HatchEntity, HatchPaint } from "../entities";
import type { Point } from "../geometry";
import { loopPolygon } from "./loops";

/**
 * The `hatch` statement of sketch code (H-01):
 *
 *   hatch H1 pattern ANSI31 scale 1 angle 45 [origin (x, y)] [double] [style outer] boundary (x, y) ... | (x, y) ...
 *   hatch H2 solid #ff8800 boundary (x, y) ...
 *   hatch H3 gradient LINEAR #ff0000 #0000ff angle 0 boundary (x, y) ...
 *
 * `boundary` lists polygon loops separated by `|`. A hatch whose boundary has
 * curved edges writes `loops N` instead — code cannot express the curves, so
 * an edit of such a line keeps the existing loops (see `diffToCommands`).
 */

export interface ParsedHatch {
  type: "hatch";
  name: string;
  paint: HatchPaint;
  style: HatchEntity["style"];
  /** Polygon loops spelled out in code; absent for a `loops N` line. */
  boundary?: Point[][];
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const PAIR = new RegExp(String.raw`\(\s*(${NUM})\s*,\s*(${NUM})\s*\)`, "g");
const HEAD = /^hatch\s+([A-Za-z_]\w*)\s+(.*)$/;

const fmt = (n: number): string => {
  const r = Math.round(n * 10000) / 10000;
  return String(Object.is(r, -0) ? 0 : r);
};
const pt = (p: Point): string => `(${fmt(p.x)}, ${fmt(p.y)})`;

/** Loops whose every edge is a straight line, as vertex lists — or null when any edge is curved. */
export function lineOnlyLoops(h: HatchEntity): Point[][] | null {
  const out: Point[][] = [];
  for (const l of h.loops) {
    if (l.edges.some((e) => e.type !== "line")) return null;
    out.push(loopPolygon(l, 1e9));
  }
  return out;
}

export function hatchLine(name: string, h: HatchEntity): string {
  let s = `hatch ${name} `;
  const p = h.paint;
  if (p.kind === "pattern") {
    s += `pattern ${p.name} scale ${fmt(p.scale)} angle ${fmt(p.angle)}`;
    if (p.origin) s += ` origin ${pt(p.origin)}`;
    if (p.double) s += " double";
  } else if (p.kind === "solid") s += `solid ${p.color}`;
  else s += `gradient ${p.name} ${p.colors[0]}${p.colors[1] ? ` ${p.colors[1]}` : ""} angle ${fmt(p.angle)}`;
  if (h.style !== "normal") s += ` style ${h.style}`;
  const polys = lineOnlyLoops(h);
  return polys ? `${s} boundary ${polys.map((l) => l.map(pt).join(" ")).join(" | ")}` : `${s} loops ${h.loops.length}`;
}

/** Parses everything after the keyword; returns the reason when it cannot. */
export function parseHatchLine(row: string): ParsedHatch | string {
  const m = row.match(HEAD);
  if (!m) return "hatch NAME pattern PAT scale S angle DEG | solid #rrggbb | gradient NAME #c1 [#c2] angle DEG [origin (x, y)] [double] [style normal|outer|ignore] boundary (x, y) ... [| (x, y) ...]";
  const name = m[1];
  let rest = m[2];
  let boundary: Point[][] | undefined;
  const bIdx = rest.search(/\b(boundary|loops)\b/);
  if (bIdx >= 0) {
    const tail = rest.slice(bIdx);
    rest = rest.slice(0, bIdx);
    if (tail.startsWith("boundary")) {
      boundary = tail
        .slice(8)
        .split("|")
        .map((part) => {
          const pts: Point[] = [];
          PAIR.lastIndex = 0;
          let pm: RegExpExecArray | null;
          while ((pm = PAIR.exec(part))) pts.push({ x: Number(pm[1]), y: Number(pm[2]) });
          return pts;
        });
      if (boundary.some((l) => l.length < 3)) return "every hatch boundary loop needs at least 3 points";
    }
  }
  const words = rest.trim().split(/\s+/);
  let style: HatchEntity["style"] = "normal";
  const si = words.indexOf("style");
  if (si >= 0) {
    const v = words[si + 1];
    if (v !== "normal" && v !== "outer" && v !== "ignore") return "hatch style must be normal, outer or ignore";
    style = v;
    words.splice(si, 2);
  }
  const kind = words[0];
  let paint: HatchPaint;
  if (kind === "solid") {
    if (!words[1]) return "solid hatch needs a colour";
    paint = { kind: "solid", color: words[1] };
  } else if (kind === "gradient") {
    const ai = words.indexOf("angle");
    const colors = words.slice(2, ai >= 0 ? ai : undefined);
    if (!words[1] || colors.length < 1) return "gradient hatch needs a name and a colour";
    paint = { kind: "gradient", name: words[1], colors: [colors[0], colors[1]], angle: ai >= 0 ? Number(words[ai + 1]) : 0 };
    if (Number.isNaN(paint.angle)) return "gradient angle must be a number";
  } else if (kind === "pattern") {
    if (!words[1]) return "pattern hatch needs a pattern name";
    const rem = words.slice(2).join(" ");
    const sm = rem.match(new RegExp(String.raw`\bscale\s+(${NUM})`));
    const am = rem.match(new RegExp(String.raw`\bangle\s+(${NUM})`));
    const om = rem.match(new RegExp(String.raw`\borigin\s+\(\s*(${NUM})\s*,\s*(${NUM})\s*\)`));
    const scale = sm ? Number(sm[1]) : 1;
    if (!(scale > 0)) return "hatch scale must be positive";
    paint = {
      kind: "pattern",
      name: words[1],
      scale,
      angle: am ? Number(am[1]) : 0,
      ...(om ? { origin: { x: Number(om[1]), y: Number(om[2]) } } : {}),
      ...(/\bdouble\b/.test(rem) ? { double: true } : {}),
    };
  } else return "hatch needs 'pattern', 'solid' or 'gradient'";
  return { type: "hatch", name, paint, style, ...(boundary ? { boundary } : {}) };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4;
const pairNear = (a: Point | undefined, b: Point | undefined): boolean => (!a && !b) || (!!a && !!b && near(a.x, b.x) && near(a.y, b.y));

/** The parsed line says nothing new about `existing` (code carries 4 decimals, no pattern `def`, no association). */
export function hatchSameGeometry(existing: HatchEntity, p: ParsedHatch): boolean {
  if (existing.style !== p.style) return false;
  const a = existing.paint;
  const b = p.paint;
  if (a.kind !== b.kind) return false;
  if (a.kind === "pattern" && b.kind === "pattern") {
    if (a.name !== b.name || !near(a.scale, b.scale) || !near(a.angle, b.angle) || !!a.double !== !!b.double || !pairNear(a.origin, b.origin)) return false;
  } else if (a.kind === "solid" && b.kind === "solid") {
    if (a.color !== b.color) return false;
  } else if (a.kind === "gradient" && b.kind === "gradient") {
    if (a.name !== b.name || a.colors[0] !== b.colors[0] || a.colors[1] !== b.colors[1] || !near(a.angle, b.angle)) return false;
  }
  if (!p.boundary) return true;
  const cur = lineOnlyLoops(existing);
  return !!cur && cur.length === p.boundary.length && cur.every((l, i) => l.length === p.boundary![i].length && l.every((q, j) => pairNear(q, p.boundary![i][j])));
}
