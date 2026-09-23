import type {
  NestOptions,
  NestResult,
  Order,
  PalletOrientation,
  PalletShape,
  PlacedItem,
  TrailerProfile,
  UnplacedItem,
} from "./types";

interface FlatItem {
  palletId: string;
  orderId: string;
  orderIndex: number;
  jobNumber: string;
  city: string;
  state: string;
  color: string;
  shape: PalletShape;
  tag?: string;
  /** Whether this pallet may be turned 90° to pack tighter. */
  orientation: PalletOrientation;
  /** Pallet footprint along the length axis, mm (= width for a round pallet). */
  length: number;
  /** Pallet footprint across the width axis, mm (= diameter for a round pallet). */
  width: number;
}

interface Orientation {
  length: number;
  width: number;
  rotated: boolean;
}

/** A placement in *slot* space — the margin-inflated box, before the wall offset. */
interface SlotPlacement extends FlatItem {
  rotated: boolean;
  slotX: number;
  slotY: number;
  slotLength: number;
  slotWidth: number;
}

const EPS = 1e-6;

/** One `FlatItem` per pallet copy — `pallet.qty` expands here. Round pallets are squared off to their diameter. */
function flattenOrders(orders: Order[]): FlatItem[] {
  const flat: FlatItem[] = [];
  orders.forEach((order, orderIndex) => {
    for (const pallet of order.pallets) {
      const width = Math.max(0, pallet.width);
      const length = pallet.shape === "round" ? width : Math.max(0, pallet.length);
      const qty = Math.max(1, Math.floor(pallet.qty ?? 1));
      for (let n = 0; n < qty; n++) {
        flat.push({
          palletId: qty > 1 ? `${pallet.id}#${n}` : pallet.id,
          orderId: order.id,
          orderIndex,
          jobNumber: order.jobNumber,
          city: order.city,
          state: order.state,
          color: order.color,
          shape: pallet.shape,
          tag: pallet.tag,
          orientation: pallet.orientation ?? "auto",
          length,
          width,
        });
      }
    }
  });
  return flat;
}

/**
 * Orientations of a slot (pallet + margin) that fit across `usableWidth` — the
 * as-drawn footprint, plus the 90°-turned one for a rectangular pallet whose
 * sides differ. Inflation is symmetric, so turning the slot === turning the
 * pallet.
 *
 * A pallet with its orientation locked offers only that one way round, even
 * when turning it would pack better: the lock exists because the freight
 * can't be turned, and a nester that quietly turns it anyway is worse than
 * one that reports the pallet as unplaced.
 */
function feasibleOrientations(item: FlatItem, inflate: number, usableWidth: number): Orientation[] {
  const l = item.length + inflate;
  const w = item.width + inflate;
  const square = item.shape !== "rect" || Math.abs(item.width - item.length) <= EPS;
  const asDrawn: Orientation = { length: l, width: w, rotated: false };
  const turned: Orientation = { length: w, width: l, rotated: true };
  const opts: Orientation[] =
    square || item.orientation === "fixed"
      ? [asDrawn]
      : item.orientation === "turned"
        ? [turned]
        : [asDrawn, turned];
  return opts.filter((o) => o.width <= usableWidth + EPS && o.width > EPS && o.length > EPS);
}

// --- skyline (bottom-left) packing, "bottom" = the nose (x = 0), loaded first ---

interface SkySeg {
  y: number;
  top: number;
}

function depthAt(sky: SkySeg[], y: number): number {
  let d = 0;
  for (const s of sky) {
    if (s.y <= y + EPS) d = s.top;
    else break;
  }
  return d;
}

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

function raise(sky: SkySeg[], a: number, b: number, top: number): void {
  const restore = depthAt(sky, b);
  const kept = sky.filter((s) => s.y < a - EPS || s.y > b + EPS);
  kept.push({ y: a, top });
  kept.push({ y: b, top: restore });
  kept.sort((p, q) => p.y - q.y);
  const merged: SkySeg[] = [];
  for (const s of kept) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y - s.y) < EPS) {
      last.top = s.top;
      continue;
    }
    if (last && Math.abs(last.top - s.top) < EPS) continue;
    merged.push({ ...s });
  }
  sky.length = 0;
  sky.push(...merged);
}

/**
 * Places every pallet with a bottom-left / skyline heuristic, packing from
 * the nose toward the door. **Pallets are fed in load order** (order 0
 * first), so any pallet's slot is placed at a depth no less than the skyline
 * earlier orders already built across the same width span — an earlier drop
 * is therefore never in front of a later one over the width it occupies, and
 * the load still unloads cleanly in reverse. Bands aren't reserved per order, so a small order
 * drops into the width a bigger one left free at the same depth.
 *
 * `inflate` = 2 × pallet margin: every slot is that much bigger than its
 * pallet, which is what keeps pallets (any order) from coming within twice the
 * margin of each other.
 */
function packSkyline(
  items: FlatItem[],
  usableWidth: number,
  inflate: number,
): { placed: SlotPlacement[]; unplaced: FlatItem[]; usedLength: number } {
  const sky: SkySeg[] = [{ y: 0, top: 0 }];
  const placed: SlotPlacement[] = [];
  const unplaced: FlatItem[] = [];
  let usedLength = 0;

  for (const it of items) {
    const opts = feasibleOrientations(it, inflate, usableWidth);
    if (opts.length === 0) {
      unplaced.push(it);
      continue;
    }

    let best: { x: number; y: number; opt: Orientation } | null = null;
    for (const opt of opts) {
      for (const seg of sky) {
        const y = seg.y;
        if (y + opt.width > usableWidth + EPS) continue;
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
      ...it,
      rotated: opt.rotated,
      slotX: x,
      slotY: y,
      slotLength: opt.length,
      slotWidth: opt.width,
    });
    raise(sky, y, y + opt.width, x + opt.length);
    usedLength = Math.max(usedLength, x + opt.length);
  }

  return { placed, unplaced, usedLength };
}

/**
 * Nests every pallet across the whole trailer, feeding them in load sequence
 * so the load comes off safely in reverse. Within an order, bigger footprints
 * go first for a tighter pack. `wallMargin` (on the trailer) is kept free
 * along every wall; `opts.palletMargin` is kept free around every pallet.
 */
export function nestByOrders(trailer: TrailerProfile, orders: Order[], opts: NestOptions = {}): NestResult {
  const wall = Math.max(0, trailer.wallMargin ?? 0);
  const pm = Math.max(0, opts.palletMargin ?? 0);
  const usableWidth = Math.max(1, trailer.width - 2 * wall);

  const items = flattenOrders(orders)
    .map((it, seq) => ({ it, seq }))
    .sort((a, b) => {
      if (a.it.orderIndex !== b.it.orderIndex) return a.it.orderIndex - b.it.orderIndex;
      const sa = Math.max(a.it.length, a.it.width);
      const sb = Math.max(b.it.length, b.it.width);
      if (Math.abs(sa - sb) > EPS) return sb - sa;
      return a.seq - b.seq;
    })
    .map((x) => x.it);

  const { placed, unplaced, usedLength } = packSkyline(items, usableWidth, 2 * pm);

  const placedItems: PlacedItem[] = placed.map((p) => ({
    instanceId: p.palletId,
    orderId: p.orderId,
    orderIndex: p.orderIndex,
    jobNumber: p.jobNumber,
    city: p.city,
    state: p.state,
    color: p.color,
    shape: p.shape,
    tag: p.tag,
    orientation: p.orientation,
    // Slot in trailer coordinates (offset past the wall clearance).
    slotX: wall + p.slotX,
    slotY: wall + p.slotY,
    slotLength: p.slotLength,
    slotWidth: p.slotWidth,
    // The pallet itself, inset by the pallet margin inside its slot.
    x: wall + p.slotX + pm,
    y: wall + p.slotY + pm,
    length: p.slotLength - 2 * pm,
    width: p.slotWidth - 2 * pm,
    rotated: p.rotated,
  }));

  // Two quite different failures read the same on a plan unless they are
  // named apart: a pallet that genuinely doesn't fit, and one that would fit
  // if its orientation weren't locked.
  const unplacedByOrder = new Map<string, { city: string; count: number; locked: number }>();
  for (const u of unplaced) {
    const entry = unplacedByOrder.get(u.orderId) ?? { city: u.city, count: 0, locked: 0 };
    entry.count += 1;
    const wouldFitTurned =
      u.orientation !== "auto" && Math.min(u.width, u.length) + 2 * pm <= usableWidth + EPS;
    if (wouldFitTurned) entry.locked += 1;
    unplacedByOrder.set(u.orderId, entry);
  }
  const unplacedItems: UnplacedItem[] = [...unplacedByOrder].map(([orderId, { city, count, locked }]) => ({
    orderId,
    city,
    count,
    reason:
      locked === count
        ? "orientation locked — would fit the other way round"
        : locked > 0
          ? `${locked} locked the wrong way, the rest too big for the trailer`
          : "too big for the trailer even turned",
  }));

  return {
    trailer,
    placed: placedItems,
    unplaced: unplacedItems,
    // Nose-to-furthest-edge plus the door clearance, so it compares to trailer.length.
    usedLength: placed.length > 0 ? usedLength + 2 * wall : 0,
  };
}
