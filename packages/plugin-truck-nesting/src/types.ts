/**
 * Truck Load Planner — a first-party plugin built over the public plugin API
 * (`docs/plugin-architecture.md` §4). It produces a 2D nesting diagram, nothing
 * more: no weights, no axle model.
 *
 * The rule that shapes the whole problem: **you load one order at a time, and
 * what goes in first comes off last.** Pallets belong to an *order* (a city
 * drop); the user drags the orders into load sequence, and nesting bands them
 * in that order — the first drop loaded against the nose, each later drop
 * nearer the door — so the load is safe to unload in reverse by construction.
 * Everything else is ordinary 2D rectangle packing (see nest.ts).
 */

export type PalletShape = "rect" | "round";

/**
 * Whether the nester may turn a pallet 90°.
 *
 * `auto` lets it choose whichever way packs tighter. The other two lock it:
 * `fixed` keeps the footprint as entered (width across the trailer), and
 * `turned` always lays it the other way. Locking matters for real freight —
 * a pallet that has to come off the forks a particular way, or racking that
 * only loads from one side, can't be turned to save an inch.
 */
export type PalletOrientation = "auto" | "fixed" | "turned";

export interface Pallet {
  id: string;
  /** Optional name — usually the pallet-size preset it came from. */
  name?: string;
  /**
   * Footprint across the trailer's width axis, mm, before any 90° turn.
   * For a round pallet this is the diameter (and `length` is ignored).
   */
  width: number;
  /** Footprint along the trailer's length axis, mm. Ignored when `shape` is "round". */
  length: number;
  shape: PalletShape;
  /** How many of this pallet to load (each nested independently). Default 1. */
  qty?: number;
  /** A short note drawn on the pallet for whoever loads it ("FRAGILE", "THIS WAY UP"). */
  tag?: string;
  /** Whether the nester may turn this pallet 90°. Default `auto`. */
  orientation?: PalletOrientation;
}

export interface Order {
  id: string;
  /** Job / PO number or other free-text order identifier. */
  jobNumber: string;
  /** The drop's destination city — shown on the plan and in the load list. */
  city: string;
  /** The drop's destination state (US two-letter abbreviation, or free text). */
  state: string;
  /** Auto-assigned hatch colour (any CSS colour). */
  color: string;
  pallets: Pallet[];
}

/** The trailer's usable floor. Nose (loaded first) at x = 0, door at x = length. */
export interface TrailerProfile {
  name: string;
  /** Nose (x = 0) to door, mm. */
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

/** How the layout should annotate the drawn plan. */
export interface LayoutOptions {
  /** Add a W×L (or Ø) dimension to every pallet. Default false. */
  dimensions?: boolean;
  /** Millimetres per display unit, for formatting dimension labels. Default 1 (mm). */
  perMm?: number;
  /** Display-unit suffix for labels ("mm", "in", …). Default "mm". */
  unitLabel?: string;
}

/** One packed pallet — the unit the renderer draws and the summary lists. */
export interface PlacedItem {
  /** `${palletId}` — stable across a re-nest as long as the order/pallet list doesn't change. */
  instanceId: string;
  orderId: string;
  /** Position of this pallet's order in the load sequence (0 = loaded first, at the nose). */
  orderIndex: number;
  jobNumber: string;
  city: string;
  state: string;
  color: string;
  shape: PalletShape;
  /** The pallet's tag, carried through so layout can label it. */
  tag?: string;
  /** The orientation lock this pallet was nested under, for the print and the summary. */
  orientation: PalletOrientation;
  /** Nose-relative: x = 0 at the nose, increasing toward the door. */
  x: number;
  y: number;
  /** Footprint as actually placed (length/width swapped from the catalogue if a rect was turned). */
  length: number;
  width: number;
  rotated: boolean;
  /** The margin-inflated footprint this pallet reserved (nose-relative). Equals the pallet box when no margins are set. */
  slotX: number;
  slotY: number;
  slotLength: number;
  slotWidth: number;
}

/** An order's pallets that couldn't be placed — too big for the trailer, locked the wrong way, or it filled up. */
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
  /** Trailer length actually used, nose to the furthest pallet's door-facing edge. */
  usedLength: number;
}

export type ValidationLevel = "info" | "warn" | "error";

export interface ValidationFinding {
  level: ValidationLevel;
  message: string;
}
