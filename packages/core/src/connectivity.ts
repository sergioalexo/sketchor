import type { EntityId } from "./entities";
import { arcPointAt, dist, type Point } from "./geometry";
import type { SketchDocument } from "./document";

/**
 * The R2 "interim option": before a real constraint solver exists, there is
 * no such thing as degrees-of-freedom, so genuine under-defined/fully-
 * defined status can't be computed. This is a cheap geometric substitute —
 * "has a free (unshared) endpoint" — explicitly a connectivity hint, not
 * constraint status. It will disagree with a real solver and is not meant
 * to replace R2's actual DOF-based coloring once planegcs lands.
 *
 * Pairs with R4: a healed drawing (no more open endpoints) reads as fully
 * connected under this same heuristic.
 */
export function freeEndpointEntityIds(doc: SketchDocument, tolerance = 1e-6): Set<EntityId> {
  const points: { entityId: EntityId; point: Point }[] = [];
  for (const e of doc.all()) {
    if (e.type === "line") {
      points.push({ entityId: e.id, point: e.a }, { entityId: e.id, point: e.b });
    } else if (e.type === "arc") {
      points.push(
        { entityId: e.id, point: arcPointAt(e.center, e.radius, e.startAngle) },
        { entityId: e.id, point: arcPointAt(e.center, e.radius, e.endAngle) },
      );
    }
    // Circles have no endpoints; they're never flagged by this heuristic.
  }

  const free = new Set<EntityId>();
  for (const p of points) {
    if (free.has(p.entityId)) continue;
    const hasPartner = points.some((q) => q.entityId !== p.entityId && dist(p.point, q.point) < tolerance);
    if (!hasPartner) free.add(p.entityId);
  }
  return free;
}
