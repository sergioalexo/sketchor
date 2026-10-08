import { parseColor, toHex } from "../contrast";
import type { HatchEntity } from "../entities";
import type { Point } from "../geometry";
import { hatchFill } from "./fillLines";
import { gradientSpec, type Box, type GradientSpec } from "./gradient";
import { hatchPolygons } from "./loops";

/**
 * Format-neutral description of how to paint a hatch in a vector file
 * (H-09: SVG and PDF). Both exporters consume the same `HatchArt`, so a hatch
 * looks the same in every file: the boundary polygons (even-odd), then either
 * explicit stroke segments for a pattern (already clipped to the region by the
 * fill engine, so no clip path is needed), a flat colour, or a gradient.
 */

export interface HatchArt {
  /** Boundary rings in world coordinates (fill with even-odd). */
  rings: Point[][];
  /** 0 = opaque .. 1 = invisible. */
  transparency: number;
  background?: string;
  paint:
    | { kind: "lines"; segments: Float32Array; dots: Float32Array; color?: string }
    /** A pattern too dense or unknown to stroke: its average tone as a flat tint, or just the outline. */
    | { kind: "tint"; opacity: number; color?: string }
    | { kind: "solid"; color: string }
    | { kind: "gradient"; spec: GradientSpec };
}

/** Blends a CSS colour toward white (paper) — used where a format has no transparency. */
export function blendWithWhite(color: string, amount: number): string {
  const c = parseColor(color);
  if (!c || amount <= 0) return color;
  const m = (v: number) => v + (255 - v) * Math.min(1, amount);
  return toHex({ r: m(c.r), g: m(c.g), b: m(c.b), a: 1 });
}

function ringsBox(rings: Point[][]): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const p of r) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function hatchArt(h: HatchEntity, tol = 0.005): HatchArt | null {
  const rings = hatchPolygons(h, tol);
  if (rings.length === 0) return null;
  const base = { rings, transparency: Math.min(1, Math.max(0, h.transparency ?? 0)), ...(h.backgroundColor ? { background: h.backgroundColor } : {}) };
  const p = h.paint;
  if (p.kind === "solid") return { ...base, paint: { kind: "solid", color: p.color } };
  if (p.kind === "gradient") {
    const box = ringsBox(rings);
    const spec = box ? gradientSpec(p, box) : null;
    return spec ? { ...base, paint: { kind: "gradient", spec } } : null;
  }
  const f = hatchFill(h, { tol });
  if (f.unknownPattern) return { ...base, paint: { kind: "tint", opacity: 0 } };
  if (f.truncated) return { ...base, paint: { kind: "tint", opacity: Math.min(0.8, f.inkPerArea * 0.2) } };
  return { ...base, paint: { kind: "lines", segments: f.segments, dots: f.dots } };
}
