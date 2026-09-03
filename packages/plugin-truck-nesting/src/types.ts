/**
 * Truck Load Planner — a first-party plugin built over the public plugin API
 * (`docs/plugin-architecture.md` §4). It produces a 2D nesting diagram, nothing
 * more: no weights, no axle model.
 *
 * The rule that shapes the whole problem: **you unload one order at a time,
 * front of the trailer last.** Pallets belong to an *order* (a city drop); the
 * user drags the orders into unload sequence, and nesting bands them in that
 * order — the first drop against the door, each later drop deeper — so the
 * sequence is safe to unload by construction. Everything else is ordinary 2D
 * rectangle packing (see nest.ts).
 */

export type PalletShape = "rect" | "round";

export interface Pallet {
  id: string;
  /**
   * Footprint across the trailer's width axis, mm, before any 90° turn.
   * For a round pallet this is the diameter (and `length` is ignored).
   */
  width: number;
  /** Footprint along the trailer's length axis, mm. Ignored when `shape` is "round". */
  length: number;
  shape: PalletShape;
}

export interface Order {
  id: string;
  /** The drop's destination — shown on the plan and in the unload list. */
  city: string;
  /** Auto-assigned hatch colour (any CSS colour). */
  color: string;
  pallets: Pallet[];
}

/** The trailer's usable floor. Door at x = 0, nose at x = length. */
export interface TrailerProfile {
  name: string;
  /** Door (x = 0) to nose, mm. */
  length: number;
  /** Across the trailer, mm. */
  width: number;
  /** Optional clearance kept free along every wall, mm. Default 0. */
  wallMargin?: number;
}

/** Extra options for {@link nestByOrders}. */
export interface NestOptions {
  /** Gap kept clear around every pallet, mm — no two pallets come within twice this. Default 0. */
  palletMargin?: number;
}

/** One packed pallet — the unit the renderer draws and the summary lists. */
export interface PlacedItem {
  /** `${palletId}` — stable across a re-nest as long as the order/pallet list doesn't change. */
  instanceId: string;
  orderId: string;
  /** Position of this pallet's order in the unload sequence (0 = first off, at the door). */
  orderIndex: number;
  city: string;
  color: string;
  shape: PalletShape;
  /** Door-relative: x = 0 at the door, increasing toward the nose. */
  x: number;
  y: number;
  /** Footprint as actually placed (length/width swapped from the catalogue if a rect was turned). */
  length: number;
  width: number;
  rotated: boolean;
  /** The margin-inflated footprint this pallet reserved (door-relative). Equals the pallet box when no margins are set. */
  slotX: number;
  slotY: number;
  slotLength: number;
  slotWidth: number;
}

/** An order's pallets that couldn't be placed — too big for the trailer, or it filled up. */
export interface UnplacedItem {
  orderId: string;
  city: string;
  count: number;
  reason: string;
}

export interface NestResult {
  trailer: TrailerProfile;
  placed: PlacedItem[];
  unplaced: UnplacedItem[];
  /** Trailer length actually used, door to the furthest pallet's nose-facing edge. */
  usedLength: number;
}

export type ValidationLevel = "info" | "warn" | "error";

export interface ValidationFinding {
  level: ValidationLevel;
  message: string;
}
