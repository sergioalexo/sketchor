import type { Model3D } from "./types";

/**
 * Point-to-point measuring on a tessellated model. Pure geometry, no
 * three.js, so it's unit-testable and the viewer only has to supply the
 * surface hit from its raycast.
 *
 * A raw surface hit is rarely what someone means when they measure a part:
 * they aim at a corner or an edge and the finger (or cursor) lands a few
 * pixels off, on a face. So a hit is snapped to the nearest B-rep vertex
 * (an endpoint of an extracted edge segment) within a pixel tolerance,
 * failing that to the nearest point on an edge, and only then kept as the
 * face point. Vertices win over edges even when an edge is slightly
 * closer — corners are what people measure between. The tolerance is
 * given in world units by the caller, who knows the pixel size at the
 * hit's depth, so touch can use a wider one than a mouse.
 */

export type Vec3 = [number, number, number];

export type SnapKind = "vertex" | "edge" | "face";

export interface MeasurePoint {
  point: Vec3;
  snap: SnapKind;
  part: number;
}

export interface MeasureResult3D {
  distance: number;
  /** Signed axis deltas, b − a. */
  dx: number;
  dy: number;
  dz: number;
}

/**
 * Snaps `hit` (a surface point on `part`) to that part's edges. Only the
 * hit part's edges are considered: an assembly's edge buffer is huge, but a
 * single part's is small, and an edge the ray didn't land on is never a
 * better answer than one it did.
 */
export function snapToEdges(model: Model3D, part: number, hit: Vec3, tolerance: number): MeasurePoint {
  const p = model.parts[part];
  if (!p || tolerance <= 0) return { point: hit, snap: "face", part };
  const e = model.edges;
  const tol2 = tolerance * tolerance;
  let bestVertex: Vec3 | null = null;
  let bestVertexD2 = tol2;
  let bestEdge: Vec3 | null = null;
  let bestEdgeD2 = tol2;
  const end = (p.edgeStart + p.edgeCount) * 6;
  for (let i = p.edgeStart * 6; i < end; i += 6) {
    const ax = e[i];
    const ay = e[i + 1];
    const az = e[i + 2];
    const bx = e[i + 3];
    const by = e[i + 4];
    const bz = e[i + 5];
    // Endpoints first.
    for (const [x, y, z] of [
      [ax, ay, az],
      [bx, by, bz],
    ]) {
      const d2 = sq(x - hit[0]) + sq(y - hit[1]) + sq(z - hit[2]);
      if (d2 < bestVertexD2) {
        bestVertexD2 = d2;
        bestVertex = [x, y, z];
      }
    }
    if (bestVertex) continue; // a vertex within tolerance always wins; no need to test this segment's interior
    // Closest point on the segment interior.
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const len2 = abx * abx + aby * aby + abz * abz;
    if (len2 <= 0) continue;
    let t = ((hit[0] - ax) * abx + (hit[1] - ay) * aby + (hit[2] - az) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    const cz = az + abz * t;
    const d2 = sq(cx - hit[0]) + sq(cy - hit[1]) + sq(cz - hit[2]);
    if (d2 < bestEdgeD2) {
      bestEdgeD2 = d2;
      bestEdge = [cx, cy, cz];
    }
  }
  if (bestVertex) return { point: bestVertex, snap: "vertex", part };
  if (bestEdge) return { point: bestEdge, snap: "edge", part };
  return { point: hit, snap: "face", part };
}

export function measureBetween(a: Vec3, b: Vec3): MeasureResult3D {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return { distance: Math.hypot(dx, dy, dz), dx, dy, dz };
}

function sq(v: number): number {
  return v * v;
}
