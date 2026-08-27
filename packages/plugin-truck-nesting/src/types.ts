/**
 * The reference plugin (roadmap "Plugins, hatches, and a loaded truck",
 * v0.11): trailer nesting with unload-order grouping. The rule that
 * defines the whole problem — stated precisely in the roadmap — is this:
 *
 *   Loading is last-in-first-out through one door. An item for stop k
 *   must not be blocked, along the path to the door, by any item for a
 *   stop later than k.
 *
 * Everything else is ordinary 2D rectangle packing. See nest.ts for how
 * that rule becomes a two-phase solve.
 */

/** The trailer's usable floor, door at x=0. */
export interface TrailerProfile {
  name: string;
  /** Along the direction of travel, door (x=0) to nose (x=length), millimetres. */
  length: number;
  /** Across the trailer, millimetres. */
  width: number;
  /** Legal gross payload, kg — used only for the coarse front/rear split warning in validate.ts, not a real axle calculation. */
  maxWeightKg?: number;
}

/**
 * One line of the item catalogue: a pallet/crate type, how many of it, and
 * which unload stop it belongs to. `qty` copies are nested independently —
 * each becomes its own placed item and its own group in the document.
 */
export interface PalletItem {
  id: string;
  label: string;
  /** Footprint along the trailer's length axis before any rotation, millimetres. */
  length: number;
  /** Footprint across the trailer's width axis before any rotation, millimetres. */
  width: number;
  weightKg: number;
  qty: number;
  /** Unload stop, 1 = first off the truck. Determines the zone this item's copies are packed into. */
  stop: number;
  /** Whether a copy may be turned 90° to fit a shelf better. Pallets are 0°/90° only — see the roadmap's note on why free rotation isn't offered. */
  rotatable: boolean;
}

/** One packed instance of a `PalletItem` — the unit the renderer draws and the manifest lists. */
export interface PlacedItem {
  /** `${item.id}#${index}` — stable across a re-nest as long as qty/order doesn't change, so the host can diff groups if it wants to later. */
  instanceId: string;
  itemId: string;
  label: string;
  stop: number;
  weightKg: number;
  /** Door-relative: x=0 at the door, increasing toward the nose. */
  x: number;
  y: number;
  /** Footprint as actually placed (length/width swapped from the catalogue entry if rotated). */
  length: number;
  width: number;
  rotated: boolean;
}

/** A catalogue line that couldn't be placed at all — too wide for the trailer even alone, or the trailer is full. */
export interface UnplacedItem {
  itemId: string;
  label: string;
  count: number;
  reason: string;
}

export interface NestResult {
  trailer: TrailerProfile;
  placed: PlacedItem[];
  unplaced: UnplacedItem[];
  /** Length of trailer actually used, door to the furthest item's nose-facing edge. */
  usedLength: number;
}

export type ValidationLevel = "info" | "warn" | "error";

export interface ValidationFinding {
  level: ValidationLevel;
  message: string;
}
