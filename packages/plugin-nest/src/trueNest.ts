import { area, bounds, insideSheet, normalize, pointInPolygon, polygonsClash, rotate, translate, type Bounds } from "./geometry";
import { NfpCache, nfpKey } from "./nfp";
import { rotationCandidates, type PartRotationSpec } from "./rotation";
import { shrinkLastSheet, type StockRow } from "./stock";
import type { Point } from "./types";

/**
 * True-shape (no-fit-polygon) nesting (N-10) — places parts by their real
 * outline instead of `nest.ts`'s bounding box, with per-part rotation
 * (N-11) and a multi-sheet stock inventory (N-13). A separate engine
 * alongside `nestParts()`, which stays exactly as it is; this one consumes
 * `partExtraction.ts`'s richer parts and doesn't touch the old bbox path.
 */

export interface TrueNestPart {
  id: string;
  name: string;
  /** Closed outline, world-scale mm. */
  outer: Point[];
  /** Carried through untouched — unused for placement until N-12 (part-in-hole filling). */
  holes: Point[][];
  quantity: number;
  rotation: PartRotationSpec;
}

/** Which sheet corner placement gravitates toward. Default "bottom-left". */
export type Gravity = "bottom-left" | "bottom-right" | "top-left" | "top-right";

export interface TrueNestOptions {
  /** Gap kept clear between parts, mm. Default 0. */
  spacing?: number;
  /** Gap kept clear from every sheet edge, mm. Default 0. */
  edgeMargin?: number;
  gravity?: Gravity;
}

export interface TrueNestPlacement {
  partId: string;
  /** Which sheet (0-based). */
  sheet: number;
  rotationDeg: number;
  mirrored: boolean;
  /** Where the rotated part's own bbox-min corner lands in sheet space. */
  translation: Point;
}

export interface TrueNestSheet {
  /** Which `stock` row this sheet was opened from. */
  stockIndex: number;
  width: number;
  height: number;
}

export interface TrueNestResult {
  sheets: TrueNestSheet[];
  placed: TrueNestPlacement[];
  /** `partId → count` that wouldn't fit anywhere in the stock. */
  unplaced: { partId: string; count: number }[];
  utilisation: number;
}

interface SheetItem {
  /** NFP cache key for this instance's own (part, rotation, mirror). */
  key: string;
  /** Rotated + bbox-normalized outline. */
  local: Point[];
  translation: Point;
  placedPolygon: Point[];
}

/** A part's outline rotated (and mirrored) then bbox-normalized to the origin — the frame NFPs are cached and placed in. */
export function localFrame(outer: Point[], deg: number, mirrored: boolean): Point[] {
  const mirroredPoly = mirrored ? outer.map((p) => ({ x: -p.x, y: p.y })) : outer;
  return normalize(rotate(mirroredPoly, deg));
}

/** Sorts candidates toward the chosen corner first — the only thing "gravity direction" changes; the feasible region itself is unaffected. */
function gravityComparator(gravity: Gravity): (a: Point, b: Point) => number {
  const ySign = gravity.startsWith("top") ? -1 : 1;
  const xSign = gravity.endsWith("right") ? -1 : 1;
  return (a, b) => ySign * (a.y - b.y) || xSign * (a.x - b.x);
}

/**
 * The rigid transform (rotate/mirror about the origin, then translate) that
 * carries a part's *original, un-normalized* outline to where a placement
 * put it. `TrueNestPlacement.translation` positions the placement search's
 * local frame — the rotated outline re-normalized so its own bbox-min sits
 * at the origin — not the original polygon directly, so materializing a
 * placement onto real (un-flattened) source entities needs this adjustment:
 * `translation` minus the rotated original's own bbox-min. Feed the result
 * straight into `materializeInstance` (`materialize.ts`)'s `InstanceTransform`.
 */
export function placementTransform(
  outer: Point[],
  placement: { rotationDeg: number; mirrored: boolean; translation: Point },
): { rotationDeg: number; mirrored: boolean; translation: Point } {
  const mirroredPoly = placement.mirrored ? outer.map((p) => ({ x: -p.x, y: p.y })) : outer;
  const box = bounds(rotate(mirroredPoly, placement.rotationDeg));
  return {
    rotationDeg: placement.rotationDeg,
    mirrored: placement.mirrored,
    translation: { x: placement.translation.x - box.minX, y: placement.translation.y - box.minY },
  };
}

export function nestTrueShape(parts: TrueNestPart[], stock: StockRow[], opts: TrueNestOptions = {}): TrueNestResult {
  const spacing = opts.spacing ?? 0;
  const margin = opts.edgeMargin ?? 0;
  const compareCandidates = gravityComparator(opts.gravity ?? "bottom-left");

  const instances: { part: TrueNestPart; area: number }[] = [];
  for (const part of parts) {
    const partArea = area(part.outer);
    for (let i = 0; i < part.quantity; i++) instances.push({ part, area: partArea });
  }
  instances.sort((a, b) => b.area - a.area);

  const stockUsed: number[] = stock.map(() => 0);
  const sheets: TrueNestSheet[] = [];
  const sheetItems: SheetItem[][] = [];
  const placed: TrueNestPlacement[] = [];
  const unplacedCounts = new Map<string, number>();
  const nfpCache = new NfpCache();
  let placedArea = 0;

  const addUnplaced = (partId: string) => unplacedCounts.set(partId, (unplacedCounts.get(partId) ?? 0) + 1);

  /** Tries every rotation candidate on one already-open sheet; returns the first accepted placement, or null. */
  function tryPlaceOnSheet(sheetIdx: number, part: TrueNestPart): { deg: number; mirrored: boolean; translation: Point; local: Point[] } | null {
    const sheet = sheets[sheetIdx];
    const placedHere = sheetItems[sheetIdx];

    for (const { deg, mirrored } of rotationCandidates(part.rotation, part.outer)) {
      const local = localFrame(part.outer, deg, mirrored);
      const box = bounds(local);
      const w = box.maxX - box.minX;
      const h = box.maxY - box.minY;
      const minX = margin;
      const minY = margin;
      const maxX = sheet.width - margin - w;
      const maxY = sheet.height - margin - h;
      if (maxX < minX - 1e-9 || maxY < minY - 1e-9) continue; // this rotation can't fit this sheet at all

      const orbitingKey = nfpKey(part.id, deg, mirrored);
      const candidates: Point[] = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ];
      const forbidden: Point[][] = [];
      for (const other of placedHere) {
        for (const loop of nfpCache.get(other.key, other.local, orbitingKey, local)) {
          const translated = loop.map((p) => ({ x: p.x + other.translation.x, y: p.y + other.translation.y }));
          forbidden.push(translated);
          candidates.push(...translated);
        }
      }

      const valid = candidates.filter((p) => {
        if (p.x < minX - 1e-6 || p.x > maxX + 1e-6 || p.y < minY - 1e-6 || p.y > maxY + 1e-6) return false;
        return !forbidden.some((loop) => loop.length >= 3 && pointInPolygon(p, loop));
      });
      valid.sort(compareCandidates);

      for (const candidate of valid) {
        const placedPolygon = translate(local, candidate.x, candidate.y);
        // Safety net: NFP placement should already guarantee this, but never
        // emit an overlap even if a concave-shape edge case slips through.
        if (placedHere.some((other) => polygonsClash(placedPolygon, other.placedPolygon, spacing))) continue;
        if (!insideSheet(placedPolygon, sheet.width, sheet.height, margin)) continue;
        return { deg, mirrored, translation: candidate, local };
      }
    }
    return null;
  }

  function commitPlacement(sheetIdx: number, part: TrueNestPart, result: { deg: number; mirrored: boolean; translation: Point; local: Point[] }): void {
    sheetItems[sheetIdx].push({
      key: nfpKey(part.id, result.deg, result.mirrored),
      local: result.local,
      translation: result.translation,
      placedPolygon: translate(result.local, result.translation.x, result.translation.y),
    });
    placed.push({ partId: part.id, sheet: sheetIdx, rotationDeg: result.deg, mirrored: result.mirrored, translation: result.translation });
  }

  for (const instance of instances) {
    const part = instance.part;
    let placedOnExisting = false;
    for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) {
      const result = tryPlaceOnSheet(sheetIdx, part);
      if (result) {
        commitPlacement(sheetIdx, part, result);
        placedArea += instance.area;
        placedOnExisting = true;
        break;
      }
    }
    if (placedOnExisting) continue;

    // Try opening a fresh sheet from stock — not just the first row with
    // room, but every row in order, since a part might not fit the first
    // available size but would fit a later, larger one.
    let opened = false;
    for (let i = 0; i < stock.length; i++) {
      const row = stock[i];
      if (row.qty !== null && stockUsed[i] >= row.qty) continue;
      const sheetIdx = sheets.length;
      sheets.push({ stockIndex: i, width: row.size.width, height: row.size.height });
      sheetItems.push([]);
      const result = tryPlaceOnSheet(sheetIdx, part);
      if (result) {
        commitPlacement(sheetIdx, part, result);
        placedArea += instance.area;
        stockUsed[i] += 1;
        opened = true;
        break;
      }
      sheets.pop();
      sheetItems.pop();
    }
    if (!opened) addUnplaced(part.id);
  }

  // Post-pass (N-13): the last sheet often only needed a fraction of the
  // stock size it was opened from — swap it for the smallest size that
  // still fits everything actually placed on it.
  if (sheets.length > 0) {
    const lastIdx = sheets.length - 1;
    const lastItems = sheetItems[lastIdx];
    if (lastItems.length > 0) {
      const lastBounds: Bounds = bounds(lastItems.flatMap((item) => item.placedPolygon));
      const smaller = shrinkLastSheet(stock, stockUsed, sheets[lastIdx].stockIndex, lastBounds, margin);
      if (smaller !== null && smaller !== sheets[lastIdx].stockIndex) {
        stockUsed[sheets[lastIdx].stockIndex] -= 1;
        stockUsed[smaller] += 1;
        sheets[lastIdx] = { stockIndex: smaller, width: stock[smaller].size.width, height: stock[smaller].size.height };
      }
    }
  }

  const totalSheetArea = sheets.reduce((sum, s) => sum + s.width * s.height, 0);
  const unplaced = Array.from(unplacedCounts, ([partId, count]) => ({ partId, count }));

  return {
    sheets,
    placed,
    unplaced,
    utilisation: totalSheetArea > 0 ? placedArea / totalSheetArea : 0,
  };
}
