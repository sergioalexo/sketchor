import type { Point } from "../geometry";
import type { Affine } from "./registry";

export const mapPoint = (m: Affine, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/**
 * A similarity (rotation + uniform scale, optionally mirrored) read out of an
 * affine matrix, or null for anything that shears or scales unevenly — the
 * maps circles, arcs, text and images can follow without changing kind.
 */
export function similarity(m: Affine): { scale: number; rotation: number; mirrored: boolean } | null {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (sx < 1e-12) return null;
  const tol = 1e-9 * Math.max(sx, sy);
  if (Math.abs(sx - sy) > tol) return null;
  const det = a * d - b * c;
  if (det > 0 ? Math.abs(c + b) > tol || Math.abs(d - a) > tol : Math.abs(c - b) > tol || Math.abs(d + a) > tol) return null;
  return { scale: sx, rotation: Math.atan2(b, a), mirrored: det < 0 };
}

