import { parseColor, toHex } from "../contrast";
import type { HatchPaint } from "../entities";

/**
 * The nine AutoCAD gradient kinds (H-07) reduced to one description — a linear
 * or radial gradient in world coordinates with colour stops — that the canvas,
 * SVG and PDF renderers all consume, so they cannot disagree about what
 * "CYLINDER" or "HEMISPHERICAL" looks like.
 *
 *   LINEAR            c1 -> c2 along the angle
 *   CYLINDER          c1 | c2 | c1 (bright band across the middle); INV* swaps
 *   SPHERICAL         c2 at the centre fading to c1 at the corners; INV* swaps
 *   HEMISPHERICAL     as SPHERICAL with the highlight pulled toward the angle's far side
 *   CURVED            a lopsided highlight (focus pulled further, wider falloff)
 *
 * A single-colour gradient fades to a tint of that colour (AutoCAD's "tint").
 */

export const GRADIENT_NAMES = ["LINEAR", "CYLINDER", "INVCYLINDER", "SPHERICAL", "INVSPHERICAL", "HEMISPHERICAL", "INVHEMISPHERICAL", "CURVED", "INVCURVED"] as const;
export type GradientName = (typeof GRADIENT_NAMES)[number];

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GradientStop {
  t: number;
  color: string;
}

export type GradientSpec =
  | { kind: "linear"; x1: number; y1: number; x2: number; y2: number; stops: GradientStop[] }
  | { kind: "radial"; cx: number; cy: number; r: number; fx: number; fy: number; stops: GradientStop[] };

function mixWithWhite(color: string, amount: number): string {
  const c = parseColor(color);
  if (!c) return "#ffffff";
  const m = (v: number) => v + (255 - v) * amount;
  return toHex({ r: m(c.r), g: m(c.g), b: m(c.b), a: 1 });
}

/** The two end colours; a missing second colour becomes a tint of the first. */
export function gradientColors(paint: Extract<HatchPaint, { kind: "gradient" }>): [string, string] {
  return [paint.colors[0], paint.colors[1] ?? mixWithWhite(paint.colors[0], 0.85)];
}

export function isGradientName(name: string): name is GradientName {
  return (GRADIENT_NAMES as readonly string[]).includes(name.toUpperCase());
}

/** Geometry + stops for a gradient over `box`. An unknown name draws as LINEAR. Returns null for an empty box. */
export function gradientSpec(paint: Extract<HatchPaint, { kind: "gradient" }>, box: Box): GradientSpec | null {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (!(Number.isFinite(w) && Number.isFinite(h)) || (w <= 0 && h <= 0)) return null;
  const upper = paint.name.toUpperCase();
  const name: GradientName = isGradientName(upper) ? upper : "LINEAR";
  const [c1, c2] = gradientColors(paint);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const a = (paint.angle * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  // Highlight position along the axis: centred, or moved by `shift` (-1..1).
  const mid = paint.centered === false ? Math.min(0.95, Math.max(0.05, 0.5 + (paint.shift ?? 0.3) / 2)) : 0.5;
  const inv = name.startsWith("INV");
  const [lo, hi] = inv ? [c2, c1] : [c1, c2];
  const half = (Math.abs(ux) * w + Math.abs(uy) * h) / 2;
  if (name === "LINEAR") {
    return { kind: "linear", x1: cx - ux * half, y1: cy - uy * half, x2: cx + ux * half, y2: cy + uy * half, stops: [{ t: 0, color: c1 }, { t: 1, color: c2 }] };
  }
  if (name === "CYLINDER" || name === "INVCYLINDER") {
    return { kind: "linear", x1: cx - ux * half, y1: cy - uy * half, x2: cx + ux * half, y2: cy + uy * half, stops: [{ t: 0, color: lo }, { t: mid, color: hi }, { t: 1, color: lo }] };
  }
  const R = Math.hypot(w, h) / 2 || 1;
  const spherical = name === "SPHERICAL" || name === "INVSPHERICAL";
  const pull = spherical ? (paint.centered === false ? (paint.shift ?? 0.3) * 0.5 : 0) : name === "HEMISPHERICAL" || name === "INVHEMISPHERICAL" ? 0.5 : 0.7;
  // The bright end of the radial gradient is the focus; the edge colour sits at the rim.
  return {
    kind: "radial",
    cx,
    cy,
    r: spherical || pull < 0.6 ? R : R * 1.25,
    fx: cx - ux * R * pull,
    fy: cy - uy * R * pull,
    stops: [{ t: 0, color: hi }, { t: 1, color: lo }],
  };
}
