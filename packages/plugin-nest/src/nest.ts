import { area, bounds, insideSheet, normalize, polygonsClash, rotate, translate } from "./geometry";
import type { NestOptions, NestPart, NestResult, PlacedPart, Point, RotationMode, Sheet } from "./types";

const ROTATIONS: Record<RotationMode, number[]> = {
  none: [0],
  flip: [0, 180],
  quarter: [0, 90, 180, 270],
};

/** Hard cap so a huge quantity can't hang the worker. */
const MAX_INSTANCES = 400;

interface Instance {
  partId: string;
  round: boolean;
  /** Bounding box min at the origin. */
  poly: Point[];
  area: number;
}

function expand(parts: NestPart[]): { instances: Instance[]; overflow: Map<string, number> } {
  const instances: Instance[] = [];
  const overflow = new Map<string, number>();
  for (const part of parts) {
    const poly = normalize(part.polygon);
    const a = area(poly);
    const qty = Math.max(0, Math.floor(part.quantity));
    for (let i = 0; i < qty; i++) {
      if (instances.length >= MAX_INSTANCES) {
        overflow.set(part.id, (overflow.get(part.id) ?? 0) + 1);
        continue;
      }
      instances.push({ partId: part.id, round: !!part.round, poly, area: a });
    }
  }
  return { instances, overflow };
}

/** Candidate lower-left anchor points on a sheet, given what's already placed. */
function candidates(placed: Point[][], spacing: number): { xs: number[]; ys: number[] } {
  const xs = new Set<number>([spacing]);
  const ys = new Set<number>([spacing]);
  for (const p of placed) {
    const b = bounds(p);
    xs.add(b.maxX + spacing);
    xs.add(b.minX);
    ys.add(b.maxY + spacing);
    ys.add(b.minY);
  }
  return {
    xs: [...xs].filter((v) => v >= 0).sort((a, b) => a - b),
    ys: [...ys].filter((v) => v >= 0).sort((a, b) => a - b),
  };
}

/**
 * Bottom-left-fill: biggest parts first, each dropped into the lowest-then-
 * leftmost spot on a sheet where it clears every placed part and the edges by
 * `spacing`. Falls onto a new sheet (up to `maxSheets`) when nothing fits.
 */
export function nestParts(parts: NestPart[], sheet: Sheet, opts: NestOptions = {}): NestResult {
  const spacing = Math.max(0, opts.spacing ?? 0);
  const rotations = ROTATIONS[opts.rotation ?? "none"];
  const maxSheets = Math.max(1, Math.floor(opts.maxSheets ?? 1));
  const W = Math.max(1, sheet.width);
  const H = Math.max(1, sheet.height);

  const { instances, overflow } = expand(parts);
  instances.sort((a, b) => b.area - a.area);

  const sheets: Point[][][] = [[]];
  const placed: PlacedPart[] = [];
  const unplaced = new Map<string, number>(overflow);
  let placedArea = 0;

  for (const inst of instances) {
    let done = false;

    for (let s = 0; s < sheets.length && !done; s++) {
      const spot = findSpot(inst, sheets[s], W, H, spacing, rotations);
      if (spot) {
        sheets[s].push(spot.poly);
        placed.push({ partId: inst.partId, round: inst.round, sheet: s, polygon: spot.poly, rotationDeg: spot.rot });
        placedArea += inst.area;
        done = true;
      }
    }

    if (!done && sheets.length < maxSheets) {
      const fresh: Point[][] = [];
      const spot = findSpot(inst, fresh, W, H, spacing, rotations);
      if (spot) {
        fresh.push(spot.poly);
        sheets.push(fresh);
        placed.push({ partId: inst.partId, round: inst.round, sheet: sheets.length - 1, polygon: spot.poly, rotationDeg: spot.rot });
        placedArea += inst.area;
        done = true;
      }
    }

    if (!done) unplaced.set(inst.partId, (unplaced.get(inst.partId) ?? 0) + 1);
  }

  const sheetsUsed = sheets.filter((s) => s.length > 0).length || 1;
  return {
    sheet,
    sheetsUsed,
    placed,
    unplaced: [...unplaced].map(([partId, count]) => ({ partId, count })),
    utilisation: placedArea / (sheetsUsed * W * H),
  };
}

function findSpot(
  inst: Instance,
  placed: Point[][],
  W: number,
  H: number,
  spacing: number,
  rotations: number[],
): { poly: Point[]; rot: number } | null {
  let best: { poly: Point[]; rot: number; y: number; x: number } | null = null;

  for (const rot of rotations) {
    const rp = normalize(rotate(inst.poly, rot));
    const rb = bounds(rp);
    if (rb.maxX > W - 2 * spacing + 1e-6 || rb.maxY > H - 2 * spacing + 1e-6) continue;

    const { xs, ys } = candidates(placed, spacing);
    for (const y of ys) {
      if (best && y > best.y + 1e-6) break; // can't beat the current best row
      for (const x of xs) {
        const cand = translate(rp, x, y);
        if (!insideSheet(cand, W, H, spacing)) continue;
        if (placed.some((p) => polygonsClash(cand, p, spacing))) continue;
        if (!best || y < best.y - 1e-6 || (Math.abs(y - best.y) < 1e-6 && x < best.x - 1e-6)) {
          best = { poly: cand, rot, y, x };
        }
        break; // first valid x on this row is the leftmost — move to the next row/rotation
      }
    }
  }

  return best ? { poly: best.poly, rot: best.rot } : null;
}
