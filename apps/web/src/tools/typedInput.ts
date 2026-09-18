import type { Point } from "@sketchor/core";
import { factorFromMm, type DisplayUnit } from "../units";

/**
 * Typed coordinate input while a tool waits for a point (roadmap T-08):
 * the AutoCAD command-line / dynamic-input grammar that every CAD user
 * has in their fingers.
 *
 *   100          a length along the current cursor direction from the last point
 *   100<45       polar: length and angle (degrees, CCW from +X) from the last point
 *   50,20        absolute coordinates
 *   @50,20       relative to the last point
 *   @100<45      relative polar (same as `100<45`)
 *
 * Numbers are in the tab's display unit unless suffixed (`4in`, `1200mm`,
 * `2'6"`, `2'`, `6"`, `1.5m`, `30cm`, `2ft`); the resolved point is in
 * world units (millimetres). Feet-and-inches accepts `2'6"`, `2'6`, `2' 6"`.
 */

export type TypedInput =
  | { kind: "length"; length: number }
  | { kind: "polar"; length: number; angleDeg: number }
  | { kind: "absolute"; x: number; y: number }
  | { kind: "relative"; dx: number; dy: number };

const UNIT_TO_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  "\"": 25.4,
  ft: 304.8,
  "'": 304.8,
};

/** Parses one number with an optional unit suffix (or feet-and-inches) into millimetres. Null if it isn't one. */
export function parseLength(text: string, unit: DisplayUnit): number | null {
  const s = text.trim().replace(/\s+/g, "");
  if (!s) return null;
  // feet + inches: 2'6" / 2'6 / 2'
  const fi = /^(-?)(\d+(?:\.\d+)?)'(?:(\d+(?:\.\d+)?)"?)?$/.exec(s);
  if (fi) {
    const sign = fi[1] === "-" ? -1 : 1;
    const feet = parseFloat(fi[2]);
    const inches = fi[3] ? parseFloat(fi[3]) : 0;
    return sign * (feet * 304.8 + inches * 25.4);
  }
  const m = /^(-?\d*\.?\d+(?:e[-+]?\d+)?)(mm|cm|m|in|ft|"|')?$/i.exec(s);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = m[2]?.toLowerCase();
  const toMm = suffix ? UNIT_TO_MM[suffix] : 1 / factorFromMm(unit);
  return value * toMm;
}

/** Parses the whole input. Null when it isn't valid (yet) — the box just stays open. */
export function parseTypedInput(text: string, unit: DisplayUnit): TypedInput | null {
  let s = text.trim();
  if (!s) return null;
  const relative = s.startsWith("@");
  if (relative) s = s.slice(1);

  const polar = s.split("<");
  if (polar.length === 2) {
    const length = parseLength(polar[0], unit);
    const angleDeg = parseFloat(polar[1]);
    if (length === null || !Number.isFinite(angleDeg)) return null;
    return { kind: "polar", length, angleDeg };
  }

  const pair = s.split(",");
  if (pair.length === 2) {
    const x = parseLength(pair[0], unit);
    const y = parseLength(pair[1], unit);
    if (x === null || y === null) return null;
    return relative ? { kind: "relative", dx: x, dy: y } : { kind: "absolute", x, y };
  }
  if (pair.length > 2) return null;

  const length = parseLength(s, unit);
  if (length === null) return null;
  return { kind: "length", length };
}

/**
 * Turns a parsed input into a world point. `last` is the tool's anchor (the
 * previous pick); `cursor` gives the direction a bare length runs along.
 * Null when the input needs an anchor there isn't one for (a bare length
 * or a relative offset with no previous point), or a direction the cursor
 * can't give (sitting exactly on the anchor).
 */
export function resolveTypedInput(input: TypedInput, last: Point | null, cursor: Point | null): Point | null {
  switch (input.kind) {
    case "absolute":
      return { x: input.x, y: input.y };
    case "relative":
      return last ? { x: last.x + input.dx, y: last.y + input.dy } : null;
    case "polar": {
      if (!last) return null;
      const a = (input.angleDeg * Math.PI) / 180;
      return { x: last.x + input.length * Math.cos(a), y: last.y + input.length * Math.sin(a) };
    }
    case "length": {
      if (!last || !cursor) return null;
      const dx = cursor.x - last.x;
      const dy = cursor.y - last.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) return null;
      return { x: last.x + (dx / len) * input.length, y: last.y + (dy / len) * input.length };
    }
  }
}

/** True for a keystroke that should open the typed-input box: the start of a number or coordinate. */
export function startsTypedInput(key: string): boolean {
  return /^[0-9@.\-]$/.test(key);
}
