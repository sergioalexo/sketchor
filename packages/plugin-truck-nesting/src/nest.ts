import type { NestResult, Order, PalletShape, PlacedItem, TrailerProfile, UnplacedItem } from "./types";

interface FlatItem {
  palletId: string;
  orderId: string;
  orderIndex: number;
  city: string;
  color: string;
  shape: PalletShape;
  /** Footprint along the length axis, mm (= width for a round pallet). */
  length: number;
  /** Footprint across the width axis, mm (= diameter for a round pallet). */
  width: number;
}

interface Orientation {
  length: number;
  width: number;
  rotated: boolean;
}

const EPS = 1e-6;

/** One `FlatItem` per pallet (duplicate a row to get two). Round pallets are squared off to their diameter. */
function flattenOrders(orders: Order[]): FlatItem[] {
  const flat: FlatItem[] = [];
  orders.forEach((order, orderIndex) => {
    for (const pallet of order.pallets) {
      const width = Math.max(0, pallet.width);
      const length = pallet.shape === "round" ? width : Math.max(0, pallet.length);
      flat.push({
        palletId: pallet.id,
        orderId: order.id,
        orderIndex,
        city: order.city,
        color: order.color,
        shape: pallet.shape,
        length,
        width,
      });
    }
  });
  return flat;
}

/** Orientations of `item` that fit across `trailerWidth` — the as-drawn footprint, plus the 90°-turned one for a rectangle whose sides differ. */
function feasibleOrientations(item: FlatItem, trailerWidth: number): Orientation[] {
  const opts: Orientation[] = [{ length: item.length, width: item.width, rotated: false }];
  if (item.shape === "rect" && Math.abs(item.width - item.length) > EPS) {
    opts.push({ length: item.width, width: item.length, rotated: true });
  }
  return opts.filter((o) => o.width <= trailerWidth + EPS && o.width > EPS && o.length > EPS);
}

// --- skyline (bottom-left) packing, "bottom" = the door (x = 0) ---

interface SkySeg {
  /** Start of this run across the trailer width. */
  y: number;
  /** Depth from the door already occupied over [y, next.y). */
  top: number;
}

/** Skyline depth at width position `y`. */
function depthAt(sky: SkySeg[], y: number): number {
  let d = 0;
  for (const s of sky) {
    if (s.y <= y + EPS) d = s.top;
    else break;
  }
  return d;
}

/** Max skyline depth over the width span [a, b). */
function maxDepthOver(sky: SkySeg[], a: number, b: number): number {
  let m = 0;
  for (let i = 0; i < sky.length; i++) {
    const start = sky[i].y;
    const end = i + 1 < sky.length ? sky[i + 1].y : Infinity;
    if (end <= a + EPS) continue;
    if (start >= b - EPS) break;
    m = Math.max(m, sky[i].top);
  }
  return m;
}

/** Raise the skyline over [a, b) to `top`, keeping the run list normalised. */
function raise(sky: SkySeg[], a: number, b: number, top: number): void {
  const restore = depthAt(sky, b);
  const kept = sky.filter((s) => s.y < a - EPS || s.y > b + EPS);
  kept.push({ y: a, top });
  kept.push({ y: b, top: restore });
  kept.sort((p, q) => p.y - q.y);
  // Merge neighbours with the same depth; drop zero-width runs.
  const merged: SkySeg[] = [];
  for (const s of kept) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y - s.y) < EPS) {
      last.top = s.top; // later entry wins at a shared boundary
      continue;
    }
    if (last && Math.abs(last.top - s.top) < EPS) continue;
    merged.push({ ...s });
  }
  sky.length = 0;
  sky.push(...merged);
}

/**
 * Places every pallet with a bottom-left / skyline heuristic, packing toward
 * the nose from the door. **Pallets are fed in unload order** (order 0 first),
 * so any pallet is placed at a depth no less than the skyline already built by
 * earlier-unloaded pallets across the same width span — an earlier drop is
 * therefore never behind a later one over the width it occupies, and the load
 * still unloads cleanly. Because bands aren't reserved per order, a small order
 * drops into the width a bigger one left free at the same depth: two orders can
 * sit side by side in one length-slice.
 */
function packSkyline(
  items: FlatItem[],
  trailerWidth: number,
): { placed: PlacedItem[]; unplaced: FlatItem[]; usedLength: number } {
  const sky: SkySeg[] = [{ y: 0, top: 0 }];
  const placed: PlacedItem[] = [];
  const unplaced: FlatItem[] = [];
  let usedLength = 0;

  for (const it of items) {
    const opts = feasibleOrientations(it, trailerWidth);
    if (opts.length === 0) {
      unplaced.push(it);
      continue;
    }

    let best: { x: number; y: number; opt: Orientation } | null = null;
    for (const opt of opts) {
      // Candidate y positions: the start of every skyline run (bottom-left rule).
      for (const seg of sky) {
        const y = seg.y;
        if (y + opt.width > trailerWidth + EPS) continue;
        const x = maxDepthOver(sky, y, y + opt.width);
        if (!best || x < best.x - EPS || (Math.abs(x - best.x) < EPS && y < best.y - EPS)) {
          best = { x, y, opt };
        }
      }
    }

    if (!best) {
      unplaced.push(it);
      continue;
    }

    const { x, y, opt } = best;
    placed.push({
      instanceId: it.palletId,
      orderId: it.orderId,
      orderIndex: it.orderIndex,
      city: it.city,
      color: it.color,
      shape: it.shape,
      x,
      y,
      length: opt.length,
      width: opt.width,
      rotated: opt.rotated,
    });
    raise(sky, y, y + opt.width, x + opt.length);
    usedLength = Math.max(usedLength, x + opt.length);
  }

  return { placed, unplaced, usedLength };
}

/**
 * Nests every pallet across the whole trailer, feeding them in unload sequence
 * so the load stays safe to unload (see {@link packSkyline}). Within an order,
 * bigger footprints go first for a tighter pack.
 */
export function nestByOrders(trailer: TrailerProfile, orders: Order[]): NestResult {
  const items = flattenOrders(orders)
    .map((it, seq) => ({ it, seq }))
    // Primary key: unload order (never reordered across orders — the safety rule).
    // Secondary: bigger first inside an order. Tertiary: stable input order.
    .sort((a, b) => {
      if (a.it.orderIndex !== b.it.orderIndex) return a.it.orderIndex - b.it.orderIndex;
      const sa = Math.max(a.it.length, a.it.width);
      const sb = Math.max(b.it.length, b.it.width);
      if (Math.abs(sa - sb) > EPS) return sb - sa;
      return a.seq - b.seq;
    })
    .map((x) => x.it);

  const { placed, unplaced, usedLength } = packSkyline(items, trailer.width);

  const unplacedByOrder = new Map<string, { city: string; count: number }>();
  for (const u of unplaced) {
    const entry = unplacedByOrder.get(u.orderId) ?? { city: u.city, count: 0 };
    entry.count += 1;
    unplacedByOrder.set(u.orderId, entry);
  }
  const unplacedItems: UnplacedItem[] = [...unplacedByOrder].map(([orderId, { city, count }]) => ({
    orderId,
    city,
    count,
    reason: "too big for the trailer even turned",
  }));

  return { trailer, placed, unplaced: unplacedItems, usedLength };
}
