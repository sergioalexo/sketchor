import type { NestResult, PalletItem, PlacedItem, TrailerProfile, UnplacedItem } from "./types";

interface FlatItem {
  itemId: string;
  label: string;
  length: number;
  width: number;
  weightKg: number;
  rotatable: boolean;
  stop: number;
  instanceIndex: number;
}

interface Orientation {
  length: number;
  width: number;
  rotated: boolean;
}

interface BandPlacement {
  itemId: string;
  label: string;
  weightKg: number;
  length: number;
  width: number;
  rotated: boolean;
  instanceIndex: number;
  /** Position within the band, measured from the band's door-facing edge. */
  xLocal: number;
  y: number;
}

const EPS = 1e-6;

function flattenItems(items: PalletItem[]): FlatItem[] {
  const flat: FlatItem[] = [];
  for (const item of items) {
    const qty = Math.max(0, Math.floor(item.qty));
    for (let i = 0; i < qty; i++) {
      flat.push({
        itemId: item.id,
        label: item.label,
        length: item.length,
        width: item.width,
        weightKg: item.weightKg,
        rotatable: item.rotatable,
        stop: item.stop,
        instanceIndex: i,
      });
    }
  }
  return flat;
}

/** Orientations of `item` that actually fit across `trailerWidth` — just the as-drawn footprint, plus the 90°-turned one if rotation is allowed and it's actually different. */
function feasibleOrientations(item: FlatItem, trailerWidth: number): Orientation[] {
  const opts: Orientation[] = [{ length: item.length, width: item.width, rotated: false }];
  if (item.rotatable && item.width !== item.length) {
    opts.push({ length: item.width, width: item.length, rotated: true });
  }
  return opts.filter((o) => o.width <= trailerWidth + EPS);
}

/**
 * Packs one stop's items into rows across `trailerWidth` using a
 * best-fit-decreasing shelf (skyline) heuristic: items are placed largest
 * first, onto whichever open shelf wastes the least width, opening a new
 * shelf only when none fits. This is the "fall back to a skyline / bottom-
 * left-fill heuristic for mixed and odd shapes" case from the roadmap —
 * good enough for a v1 reference plugin. Exact row-pattern enumeration for
 * uniform pallet sizes (the roadmap's "most real layouts collapse to a
 * handful of row patterns") is a worthwhile follow-up, not done here.
 */
export function packBand(
  items: FlatItem[],
  trailerWidth: number,
): { placed: BandPlacement[]; depth: number; unplaced: FlatItem[] } {
  const unplaced: FlatItem[] = [];
  const sortable = items.filter((it) => {
    if (feasibleOrientations(it, trailerWidth).length === 0) {
      unplaced.push(it);
      return false;
    }
    return true;
  });

  // Largest footprint first — the standard decreasing order for shelf packing.
  sortable.sort((a, b) => Math.max(b.length, b.width) - Math.max(a.length, a.width));

  const shelves: { depth: number; usedWidth: number; xStart: number }[] = [];
  const placed: BandPlacement[] = [];
  let depth = 0;

  for (const it of sortable) {
    const opts = feasibleOrientations(it, trailerWidth);
    let bestShelfIndex = -1;
    let bestOpt: Orientation | null = null;
    let bestLeftover = Infinity;

    shelves.forEach((shelf, shelfIndex) => {
      for (const opt of opts) {
        if (opt.length <= shelf.depth + EPS && opt.width <= trailerWidth - shelf.usedWidth + EPS) {
          const leftover = trailerWidth - shelf.usedWidth - opt.width;
          if (leftover < bestLeftover) {
            bestLeftover = leftover;
            bestShelfIndex = shelfIndex;
            bestOpt = opt;
          }
        }
      }
    });

    if (bestShelfIndex >= 0 && bestOpt) {
      const shelf = shelves[bestShelfIndex];
      const opt: Orientation = bestOpt;
      placed.push({
        itemId: it.itemId,
        label: it.label,
        weightKg: it.weightKg,
        length: opt.length,
        width: opt.width,
        rotated: opt.rotated,
        instanceIndex: it.instanceIndex,
        xLocal: shelf.xStart,
        y: shelf.usedWidth,
      });
      shelf.usedWidth += opt.width;
    } else {
      // New shelf, sized to whichever feasible orientation is shallowest — packs tighter than defaulting to the as-drawn footprint.
      const opt = opts.reduce((a, b) => (a.length <= b.length ? a : b));
      const shelf = { depth: opt.length, usedWidth: opt.width, xStart: depth };
      shelves.push(shelf);
      placed.push({
        itemId: it.itemId,
        label: it.label,
        weightKg: it.weightKg,
        length: opt.length,
        width: opt.width,
        rotated: opt.rotated,
        instanceIndex: it.instanceIndex,
        xLocal: shelf.xStart,
        y: 0,
      });
      depth += shelf.depth;
    }
  }

  return { placed, depth, unplaced };
}

/**
 * Phase 1 (zone allocation) + phase 2 (per-band packing) from the roadmap:
 * stops are banded along the trailer's length in reverse order — the
 * last-unloaded stop sits deepest (toward the nose), the first-unloaded
 * stop sits at the door — so the LIFO unload rule holds by construction
 * rather than needing a separate solve.
 */
export function nestTruck(trailer: TrailerProfile, items: PalletItem[]): NestResult {
  const flat = flattenItems(items);
  const byStop = new Map<number, FlatItem[]>();
  for (const f of flat) {
    const arr = byStop.get(f.stop);
    if (arr) arr.push(f);
    else byStop.set(f.stop, [f]);
  }
  const stopsDescending = [...byStop.keys()].sort((a, b) => b - a);

  const placed: PlacedItem[] = [];
  const unplacedByItem = new Map<string, { label: string; count: number }>();
  let noseCursor = trailer.length;

  for (const stop of stopsDescending) {
    const bandItems = byStop.get(stop)!;
    const { placed: bandPlaced, depth, unplaced } = packBand(bandItems, trailer.width);
    const bandDoorX = noseCursor - depth;

    for (const p of bandPlaced) {
      placed.push({
        instanceId: `${p.itemId}#${p.instanceIndex}`,
        itemId: p.itemId,
        label: p.label,
        stop,
        weightKg: p.weightKg,
        x: bandDoorX + p.xLocal,
        y: p.y,
        length: p.length,
        width: p.width,
        rotated: p.rotated,
      });
    }
    for (const u of unplaced) {
      const entry = unplacedByItem.get(u.itemId) ?? { label: u.label, count: 0 };
      entry.count += 1;
      unplacedByItem.set(u.itemId, entry);
    }
    noseCursor = bandDoorX;
  }

  // Bands were stacked back from the nose, so any leftover trailer length
  // ended up as a gap at the door — the opposite of "the first drop sits
  // at the door" from the roadmap. Flush the whole load against the door
  // instead, leaving the gap (if any) at the nose end where it doesn't
  // affect the unload order. Skipped when the load overflows (`noseCursor`
  // negative) so the negative coordinates keep showing the shortfall.
  const doorShift = Math.max(0, noseCursor);
  if (doorShift > 0) {
    for (const p of placed) p.x -= doorShift;
  }

  const unplaced: UnplacedItem[] = [...unplacedByItem].map(([itemId, { label, count }]) => ({
    itemId,
    label,
    count,
    reason: "wider than the trailer even rotated",
  }));

  return { trailer, placed, unplaced, usedLength: trailer.length - noseCursor };
}
