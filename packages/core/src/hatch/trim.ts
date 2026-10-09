import type { Entity, HatchEntity } from "../entities";
import { newEntityId } from "../entities";
import type { Point } from "../geometry";
import { pointInPolygon } from "../regions";
import { boundaryRegions } from "./boundary";
import { hatchContains } from "./loops";
import { hatchBoundaryEntities } from "./ops";

/**
 * H-08 "trim hatch with the trim tool": the cutters divide the hatch into
 * pieces, the piece under the click goes, the others stay as hatches of their
 * own (same pattern, scale, angle and origin, so the strokes line up with
 * what was there). Pure; the tool commits `delete original + add pieces`.
 */

/** Points strictly inside a simple polygon: the middle of every scan-line interval at a handful of heights (an island can swallow some of them). */
export function interiorPoints(poly: readonly Point[]): Point[] {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const out: Point[] = [];
  if (!(maxY > minY)) return out;
  for (const f of [0.5, 0.37, 0.63, 0.25, 0.75, 0.13, 0.87]) {
    const y = minY + (maxY - minY) * f;
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-9) out.push({ x: (xs[i] + xs[i + 1]) / 2, y });
  }
  return out;
}

/**
 * The hatches left after cutting `h` with `cutters` and removing the piece at `near`; null when nothing
 * would change (the click is outside the hatch, no cutter crosses it, or the drawing is too large to analyse).
 * An empty array means the whole hatch was the piece under the click.
 */
export function trimHatch(h: HatchEntity, cutters: readonly Entity[], near: Point): HatchEntity[] | null {
  if (!hatchContains(h, near)) return null;
  const regions = boundaryRegions([...hatchBoundaryEntities(h), ...cutters.filter((c) => c.id !== h.id)]);
  if (!regions) return null;
  const inside = regions.filter((r) => {
    return interiorPoints(r.polygon).some((p) => hatchContains(h, p));
  });
  if (inside.length < 2) return null;
  // The piece under the click is the smallest region holding it.
  let hit = -1;
  inside.forEach((r, i) => {
    if (pointInPolygon(near, r.polygon) && (hit < 0 || r.area < inside[hit].area)) hit = i;
  });
  if (hit < 0) return null;
  return inside
    .filter((_, i) => i !== hit)
    .map((r) => {
      const { sources: _s, associative: _a, ...rest } = h as HatchEntity & { sources?: unknown; associative?: unknown };
      void _s;
      void _a;
      const { name: _n, ...noName } = rest as HatchEntity;
      void _n;
      return { ...noName, id: newEntityId(), loops: r.result.loops } as HatchEntity;
    });
}
