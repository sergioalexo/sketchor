import type { PatternFamily } from "../entities";

/**
 * The `.pat` hatch-pattern format — the de-facto standard every CAD reads:
 *
 *   *NAME, description
 *   angle, x0, y0, dx, dy [, dash, gap, ...]
 *
 * `angle` in degrees, `(x0, y0)` a point on the first line, `(dx, dy)` the
 * step to the next parallel line (dx along the line, dy perpendicular to it),
 * dashes alternate pen-down (positive) / gap (negative) with 0 = a dot.
 * Everything after `;` is a comment. The parser never throws: a malformed
 * family line is skipped and reported, and a pattern with no valid line is
 * dropped.
 */

export interface PatternDef {
  name: string;
  description: string;
  families: PatternFamily[];
  /** Library grouping (ISO, ANSI, GOST, Geometric, …); absent for an imported pattern. */
  category?: string;
  /** Sensible hatch scale for a drawing in millimetres / inches (patterns are authored in mm; an inch drawing needs 1/25.4 of that). */
  defaultScale?: { mm: number; inch: number };
}

export interface PatParseResult {
  patterns: PatternDef[];
  /** One message per skipped line, with its 1-based line number. */
  issues: { line: number; message: string }[];
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

export function parsePat(text: string): PatParseResult {
  const patterns: PatternDef[] = [];
  const issues: PatParseResult["issues"] = [];
  let cur: PatternDef | null = null;
  const flush = (line: number): void => {
    if (cur && cur.families.length === 0) issues.push({ line, message: `pattern ${cur.name} has no valid line family — dropped` });
    else if (cur) patterns.push(cur);
    cur = null;
  };
  const rows = text.split(/\r?\n/);
  rows.forEach((raw, i) => {
    const row = raw.replace(/;.*$/, "").trim();
    if (row === "") return;
    if (row.startsWith("*")) {
      flush(i + 1);
      const comma = row.indexOf(",");
      const name = (comma >= 0 ? row.slice(1, comma) : row.slice(1)).trim();
      if (name === "") {
        issues.push({ line: i + 1, message: "pattern header without a name" });
        return;
      }
      cur = { name, description: comma >= 0 ? row.slice(comma + 1).trim() : "", families: [] };
      return;
    }
    if (!cur) {
      issues.push({ line: i + 1, message: "line family before any *NAME header" });
      return;
    }
    const parts = row.split(/\s*,\s*|\s+/).filter((p) => p !== "");
    if (parts.length < 5 || parts.some((p) => !NUMBER.test(p))) {
      issues.push({ line: i + 1, message: "a line family is `angle, x0, y0, dx, dy [, dash...]` (numbers only)" });
      return;
    }
    const [angle, x0, y0, dx, dy, ...dashes] = parts.map(Number);
    if (!Number.isFinite(angle + x0 + y0 + dx + dy) || dashes.some((d) => !Number.isFinite(d))) {
      issues.push({ line: i + 1, message: "non-finite number" });
      return;
    }
    cur.families.push({ angle, origin: { x: x0, y: y0 }, offset: { x: dx, y: dy }, dashes });
  });
  flush(rows.length);
  return { patterns, issues };
}

const num = (n: number): string => String(+n.toFixed(6));

/** Serialises patterns in `.pat` form; `parsePat(writePat(x))` returns the same families. */
export function writePat(patterns: readonly PatternDef[]): string {
  const out: string[] = [];
  for (const p of patterns) {
    out.push(`*${p.name}${p.description ? `, ${p.description}` : ""}`);
    for (const f of p.families) {
      out.push([f.angle, f.origin.x, f.origin.y, f.offset.x, f.offset.y, ...f.dashes].map(num).join(", "));
    }
  }
  return out.join("\n") + "\n";
}
