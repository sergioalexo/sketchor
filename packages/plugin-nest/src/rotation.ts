import { bounds, rotate } from "./geometry";
import type { Point } from "./types";

/**
 * Per-part rotation freedom (N-11): `locked` never turns the part, `quarter`
 * tries the four right angles, `any` sweeps a step grid (default 15°, down
 * to 1°) plus the part's own minimum-bounding-box angle — the one angle a
 * step grid can easily miss but that often packs a part tightest. `mirror`
 * doubles every candidate with a flipped copy.
 */
export interface PartRotationSpec {
  mode: "locked" | "quarter" | "any";
  /** "any" only. Default 15, floored at 1. */
  stepDeg?: number;
  mirror?: boolean;
}

const DEFAULT_STEP_DEG = 15;
const MIN_STEP_DEG = 1;

/** The rotation (degrees) that minimizes the polygon's axis-aligned bounding box, tried at every edge's own angle — not a full convex-hull rotating-calipers pass, but the same idea, simpler, and it never misses an edge that would matter. */
export function minimumBoundingBoxAngle(polygon: Point[]): number {
  let bestDeg = 0;
  let bestArea = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 1e-9) continue;
    const edgeDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const candidateDeg = ((-edgeDeg % 360) + 360) % 360;
    const box = bounds(rotate(polygon, candidateDeg));
    const boxArea = (box.maxX - box.minX) * (box.maxY - box.minY);
    if (boxArea < bestArea) {
      bestArea = boxArea;
      bestDeg = candidateDeg;
    }
  }
  return bestDeg;
}

/** Every (rotation, mirror) combination a part's rotation spec allows. */
export function rotationCandidates(spec: PartRotationSpec, polygon: Point[]): { deg: number; mirrored: boolean }[] {
  const degrees: number[] = [];
  if (spec.mode === "locked") {
    degrees.push(0);
  } else if (spec.mode === "quarter") {
    degrees.push(0, 90, 180, 270);
  } else {
    const step = Math.max(MIN_STEP_DEG, spec.stepDeg ?? DEFAULT_STEP_DEG);
    for (let d = 0; d < 360; d += step) degrees.push(d);
    const bboxDeg = minimumBoundingBoxAngle(polygon);
    if (!degrees.some((d) => Math.abs(d - bboxDeg) < 1e-6)) degrees.push(bboxDeg);
  }
  const mirrors = spec.mirror ? [false, true] : [false];
  const out: { deg: number; mirrored: boolean }[] = [];
  for (const deg of degrees) for (const mirrored of mirrors) out.push({ deg, mirrored });
  return out;
}
