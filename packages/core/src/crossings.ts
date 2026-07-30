import type { EntityId, LineEntity } from "./entities";
import type { Point } from "./geometry";
import type { SketchDocument } from "./document";

/**
 * Finds lines that cross each other mid-span — two edges that intersect at a
 * point that isn't a shared endpoint, e.g. a diagonal cutting across a
 * rectangle, or two overlooked strokes crossing. Read-only: unlike
 * duplicates.ts's findings, a genuine crossing has no unambiguous "extra"
 * copy to delete, so this only reports locations for review — nothing here
 * is wired to an auto-fix.
 */

export interface CrossingIssue {
  id: string;
  /** Always the two crossing lines, in no particular order. */
  entityIds: [EntityId, EntityId];
  location: Point;
}

/** Two segments' crossing point, or null if parallel/collinear or they don't actually cross within both spans. */
function segmentIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const rX = a2.x - a1.x;
  const rY = a2.y - a1.y;
  const sX = b2.x - b1.x;
  const sY = b2.y - b1.y;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b1.x - a1.x) * sY - (b1.y - a1.y) * sX) / denom;
  const u = ((b1.x - a1.x) * rY - (b1.y - a1.y) * rX) / denom;
  // Excludes the endpoints themselves (t/u in [0,1] but near 0 or 1) — two
  // lines meeting at a shared corner is normal connectivity, not a crossing.
  const eps = 1e-6;
  if (t < eps || t > 1 - eps || u < eps || u > 1 - eps) return null;
  return { x: a1.x + t * rX, y: a1.y + t * rY };
}

export function scanForCrossings(doc: SketchDocument): CrossingIssue[] {
  const lines = doc.all().filter((e): e is LineEntity => e.type === "line");
  const issues: CrossingIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      const hit = segmentIntersection(a.a, a.b, b.a, b.b);
      if (hit) issues.push({ id: `crossing:${a.id}:${b.id}`, entityIds: [a.id, b.id], location: hit });
    }
  }
  return issues;
}
