/// <reference path="./clipper-lib.d.ts" />
import ClipperLib, { type IntPoint, type Paths } from "clipper-lib";
import type { Point } from "./types";

/**
 * Robust polygon offset (N-03), via `clipper-lib` — the pure-JS Clipper1
 * port SVGnest/Deepnest themselves use for offsetting (the plan's own
 * algorithmic reference for N-10), rather than stretching `@sketchor/core`'s
 * `offset.ts` (built for per-curve offsetting with re-join heuristics that
 * are explicitly "the 95% case", not robust polygon-boolean cleanup at
 * nesting scale). `clipper2-js` (the originally planned dependency) turned
 * out to have a real bug in its offset engine — it mangles even a plain
 * square — so this uses the older but battle-tested Clipper1 port instead.
 *
 * Clipper works in integers for numerical robustness; mm are scaled up
 * before calling and back down after, rather than exposing that detail to
 * callers.
 */

const SCALE = 1000; // mm -> integer units (micron resolution)

function toIntPoints(points: Point[]): IntPoint[] {
  return points.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
}

function fromIntPoints(path: IntPoint[]): Point[] {
  return path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));
}

export type OffsetJoinType = "miter" | "round" | "square";

const JOIN_TYPES: Record<OffsetJoinType, number> = {
  miter: ClipperLib.JoinType.jtMiter,
  round: ClipperLib.JoinType.jtRound,
  square: ClipperLib.JoinType.jtSquare,
};

/**
 * Offsets a closed polygon outward (`delta > 0`) or inward (`delta < 0`) by
 * `delta` mm. May return more than one loop (offsetting a dumbbell shape
 * inward enough to sever its neck) or none at all (insetting past a shape's
 * narrowest point) — always check the result isn't empty.
 */
export function offsetPolygon(points: Point[], delta: number, joinType: OffsetJoinType = "miter"): Point[][] {
  const offset = new ClipperLib.ClipperOffset();
  offset.AddPath(toIntPoints(points), JOIN_TYPES[joinType], ClipperLib.EndType.etClosedPolygon);
  const solution: Paths = [];
  offset.Execute(solution, delta * SCALE);
  return solution.map(fromIntPoints);
}
