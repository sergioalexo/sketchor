/// <reference path="./clipper-lib.d.ts" />
import ClipperLib, { type IntPoint } from "clipper-lib";
import type { Point } from "./types";

/**
 * No-fit polygons (N-10): the locus of positions an "orbiting" part's
 * reference point can take while touching, but not overlapping, a
 * "stationary" part — the core primitive true-shape nesting places parts
 * with. `p` is on the NFP boundary exactly when translating the orbiting
 * part by `p` makes some point of it coincide with some point of the
 * stationary part: `p = a - b` for `a` in the stationary part, `b` in the
 * orbiting part — i.e. the outer NFP is the Minkowski **sum** of the
 * stationary part and the *negated* orbiting part, `A ⊕ (−B)`.
 *
 * Computed via `clipper-lib`'s `MinkowskiSum` (already trusted for
 * offsetting since N-03) rather than a hand-rolled orbital/marching
 * algorithm — verified directly against the textbook case (two unit squares
 * give the doubled square) before anything was built on top of it.
 */

const SCALE = 1000; // mm -> integer units, matching polygonOps.ts

function toIntPoints(points: Point[]): IntPoint[] {
  return points.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
}

function fromIntPoints(path: IntPoint[]): Point[] {
  return path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));
}

function negate(path: IntPoint[]): IntPoint[] {
  return path.map((p) => ({ X: -p.X, Y: -p.Y }));
}

/** `MinkowskiSum`/`Orientation` expect a CCW-wound "positive" polygon; nothing upstream guarantees that. */
function ccw(path: IntPoint[]): IntPoint[] {
  return ClipperLib.Clipper.Orientation(path) ? path : [...path].reverse();
}

/**
 * The outer no-fit polygon of `orbiting` around `stationary`: every loop the
 * orbiting part's reference point must stay outside of (not overlapping,
 * touching is fine) to avoid the two parts overlapping. Usually one loop;
 * a concave `stationary`/`orbiting` pair can produce more than one — treat
 * a point inside *any* returned loop as forbidden.
 */
export function outerNfp(stationary: Point[], orbiting: Point[]): Point[][] {
  const a = ccw(toIntPoints(stationary));
  const b = ccw(toIntPoints(orbiting));
  const solution = ClipperLib.Clipper.MinkowskiSum(negate(b), a, true);
  return solution.map(fromIntPoints);
}

/** Memoizes {@link outerNfp} by the (part, rotation, mirror) pair on each side — the NFP shape doesn't depend on where the stationary part ended up on the sheet. */
export class NfpCache {
  private readonly cache = new Map<string, Point[][]>();

  get(
    stationaryKey: string,
    stationary: Point[],
    orbitingKey: string,
    orbiting: Point[],
  ): Point[][] {
    const key = `${stationaryKey}|${orbitingKey}`;
    let nfp = this.cache.get(key);
    if (!nfp) {
      nfp = outerNfp(stationary, orbiting);
      this.cache.set(key, nfp);
    }
    return nfp;
  }
}

/** A stable NFP-cache key for a (part, rotation, mirror) combination. */
export function nfpKey(partId: string, rotationDeg: number, mirrored: boolean): string {
  return `${partId}:${rotationDeg}:${mirrored ? 1 : 0}`;
}
