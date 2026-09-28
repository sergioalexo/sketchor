import type { Bounds } from "../dxf";
import type { Entity } from "../entities";
import type { Grip } from "../grips";
import type { Point } from "../geometry";
import type { Path } from "../intersect";

/**
 * The entity-kind registry (Z-01). Every entity `type` registers one
 * `EntityKind` that answers the questions generic code asks of *any*
 * entity — how big is it, what does it look like as polylines, where can I
 * snap, what grips does it have, how far is the cursor from it, what happens
 * under an affine map.
 *
 * Only `tessellate` is required. Everything else has a derived fallback built
 * on it (see the `kind*` helpers below), so a new kind is usable — selectable,
 * snappable by nearest/intersection, exportable to SVG/PDF, bounded — the day
 * it registers, and gets exact handling wherever it supplies its own method.
 * The helpers deliberately take `Entity` (not a generic) because the entity
 * union is what documents store; a kind for a type outside the union is only
 * reachable through a cast, which is what the registry's own test does.
 *
 * This module holds *no value imports* from the rest of core (only types), so
 * `entities.ts`, `grips.ts` and friends can consult it from their fallback
 * branches without an import cycle. The built-in kinds live in `builtin.ts`.
 */

/** `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f — SVG's matrix() order. */
export type Affine = readonly [number, number, number, number, number, number];

export interface KindSnap {
  point: Point;
  kind: "endpoint" | "midpoint" | "center" | "quadrant" | "node";
}

export interface EntityKind<E extends Entity = Entity> {
  /** The entity `type` string this kind handles. */
  type: string;
  /**
   * The universal fallback: the entity as runs of points, each run an open
   * polyline (a closed shape repeats its first point at the end). `tol` is
   * the maximum chord error in world units.
   */
  tessellate(e: E, tol: number): Point[][];
  /** Exact bounds. Absent = bounds of the tessellation. */
  bounds?(e: E): Bounds | null;
  /**
   * The entity under an affine map, or `null` when this kind can't express
   * the result (a circle under non-uniform scale, until it can become an
   * ellipse) — the caller then explodes or approximates.
   */
  transform?(e: E, m: Affine): E | null;
  /** Curves for `intersect.ts`. Absent = segments of the tessellation. `null` = no stroke (text, image, point). */
  path?(e: E): Path | null;
  /** Feature points for snapping. Absent = the endpoints of each tessellated run. */
  snaps?(e: E): KindSnap[];
  grips?(e: E): Grip[];
  applyGrip?(e: E, grip: Grip, to: Point): E;
  /** Distance from `p` to the entity (0 anywhere inside a filled shape). Absent = distance to the tessellation. */
  hitDistance?(e: E, p: Point): number;
}

const kinds = new Map<string, EntityKind<never>>();

export function registerKind<E extends Entity>(kind: EntityKind<E>): void {
  kinds.set(kind.type, kind as unknown as EntityKind<never>);
}

/** Removes a kind — for tests that register a throwaway one. */
export function unregisterKind(type: string): void {
  kinds.delete(type);
}

export function getKind(type: string): EntityKind | undefined {
  return kinds.get(type) as unknown as EntityKind | undefined;
}

export function registeredKindTypes(): string[] {
  return [...kinds.keys()];
}

/** Chord tolerance for interactive work (mm); exports pass something tighter. */
export const DEFAULT_TESSELLATION_TOL = 0.05;

/* ----------------------------- derived behaviour ---------------------------- */

/** The entity as point runs. An unregistered type has no geometry, so an empty list. */
export function kindTessellate(e: Entity, tol = DEFAULT_TESSELLATION_TOL): Point[][] {
  return getKind(e.type)?.tessellate(e, tol) ?? [];
}

export function boundsOfPoints(points: Iterable<Point>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function kindBounds(e: Entity): Bounds | null {
  const kind = getKind(e.type);
  if (!kind) return null;
  if (kind.bounds) return kind.bounds(e);
  return boundsOfPoints(kind.tessellate(e, DEFAULT_TESSELLATION_TOL).flat());
}

/** Every vertex of the tessellation — the fallback for `entityPoints` (bounds, centroids, snapping anchors). */
export function kindPoints(e: Entity): Point[] {
  return kindTessellate(e).flat();
}

export function kindSnaps(e: Entity): KindSnap[] {
  const kind = getKind(e.type);
  if (!kind) return [];
  if (kind.snaps) return kind.snaps(e);
  const out: KindSnap[] = [];
  for (const run of kind.tessellate(e, DEFAULT_TESSELLATION_TOL)) {
    if (run.length === 0) continue;
    out.push({ point: run[0], kind: "endpoint" });
    if (run.length > 1) out.push({ point: run[run.length - 1], kind: "endpoint" });
  }
  return out;
}

function distToSegmentLocal(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/** Distance from `p` to the entity, `Infinity` for an unregistered type. */
export function kindHitDistance(e: Entity, p: Point): number {
  const kind = getKind(e.type);
  if (!kind) return Infinity;
  if (kind.hitDistance) return kind.hitDistance(e, p);
  let best = Infinity;
  for (const run of kind.tessellate(e, DEFAULT_TESSELLATION_TOL)) {
    if (run.length === 1) best = Math.min(best, Math.hypot(p.x - run[0].x, p.y - run[0].y));
    for (let i = 0; i + 1 < run.length; i++) best = Math.min(best, distToSegmentLocal(p, run[i], run[i + 1]));
  }
  return best;
}

/** The entity under `m`, or null if unsupported (see {@link EntityKind.transform}). */
export function kindTransform(e: Entity, m: Affine): Entity | null {
  const kind = getKind(e.type);
  return kind?.transform ? kind.transform(e, m) : null;
}

/** Translation by (dx, dy) via the kind's affine `transform`; the entity unchanged if it has none. */
export function kindTranslate(e: Entity, dx: number, dy: number): Entity {
  return kindTransform(e, [1, 0, 0, 1, dx, dy]) ?? e;
}

/**
 * Grips: the kind's own, else a single move-grip at the centre of the bounds
 * (`kind: "center"` — dragging it moves the whole entity).
 */
export function kindGrips(e: Entity): Grip[] {
  const kind = getKind(e.type);
  if (kind?.grips) return kind.grips(e);
  const b = kindBounds(e);
  return b ? [{ point: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, kind: "center", index: 0 }] : [];
}

export function kindApplyGrip(e: Entity, grip: Grip, to: Point): Entity {
  const kind = getKind(e.type);
  if (kind?.applyGrip) return kind.applyGrip(e, grip, to);
  return kindTranslate(e, to.x - grip.point.x, to.y - grip.point.y);
}

/** Curves for the intersection library: the kind's own, else the tessellation as straight segments. */
export function kindPath(e: Entity): Path | null {
  const kind = getKind(e.type);
  if (!kind) return null;
  if (kind.path) return kind.path(e);
  const runs = kind.tessellate(e, DEFAULT_TESSELLATION_TOL);
  const curves: Path["curves"] = [];
  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i++) {
      if (Math.hypot(run[i + 1].x - run[i].x, run[i + 1].y - run[i].y) > 1e-9) {
        curves.push({ kind: "segment", a: run[i], b: run[i + 1] });
      }
    }
  }
  let closed = false;
  if (runs.length === 1 && runs[0].length > 2) {
    const r = runs[0];
    closed = Math.hypot(r[0].x - r[r.length - 1].x, r[0].y - r[r.length - 1].y) < 1e-9;
  }
  return curves.length > 0 ? { curves, closed } : null;
}
