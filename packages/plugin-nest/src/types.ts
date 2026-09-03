/**
 * Laser / sheet nesting — lay flat parts out on stock to minimise offcut.
 *
 * A part is a closed outline (its polygon, in mm). Nesting places `quantity`
 * copies of each part onto one or more sheets with a bottom-left-fill heuristic
 * and optional 90°/180° rotation, keeping a `spacing` gap (kerf + handling)
 * between every pair and every sheet edge. It's a heuristic, not an optimum —
 * good for a first pass a person then tidies.
 */

export interface Point {
  x: number;
  y: number;
}

export interface NestPart {
  /** The source entity id — copies carry it so the host can trace them back. */
  id: string;
  /** Closed outline in mm, world coordinates. Winding doesn't matter. */
  polygon: Point[];
  /** True to draw copies as a circle of the polygon's bounding radius (for round parts). */
  round?: boolean;
  quantity: number;
}

export interface Sheet {
  name: string;
  /** Usable stock, mm. */
  width: number;
  height: number;
}

/** How many turned orientations a part may take. */
export type RotationMode = "none" | "flip" | "quarter";

export interface NestOptions {
  /** Gap kept clear between parts and off every sheet edge, mm. Default 0. */
  spacing?: number;
  rotation?: RotationMode;
  /** Cap on sheets; parts that don't fit are reported unplaced. Default 1. */
  maxSheets?: number;
}

export interface PlacedPart {
  partId: string;
  round: boolean;
  /** Which sheet (0-based). */
  sheet: number;
  /** The part's polygon as placed — already rotated and translated into sheet space. */
  polygon: Point[];
  rotationDeg: number;
}

export interface NestResult {
  sheet: Sheet;
  sheetsUsed: number;
  placed: PlacedPart[];
  /** `partId → count` that wouldn't fit. */
  unplaced: { partId: string; count: number }[];
  /** Fraction of the used sheet area covered by parts, 0–1. */
  utilisation: number;
}
