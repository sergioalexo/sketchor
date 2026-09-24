import { joinEntities, type Entity } from "@sketchor/core";
import { area as polygonArea, pointInPolygon, properIntersect } from "./geometry";
import { DEFAULT_CHORD_TOLERANCE, flattenCircle, flattenClosedPolyline } from "./flatten";
import type { Point } from "./types";

/**
 * Part extraction with holes (N-01): turns a selection into parts a nester
 * can place, instead of the flat "closed polyline or circle only" filter
 * `nestPlugin.ts`'s `toPart()` used. A closed shape found directly inside
 * another becomes that part's hole; a shape found inside *that* hole is a
 * new, independent part (what N-12 will later try to place inside the
 * hole) rather than a "hole of a hole".
 */

export interface ExtractedPart {
  /** Synthetic, stable for a given call — not a document entity id. */
  id: string;
  name: string;
  /** Closed outline, chord-tolerance flattened, world coordinates. */
  outer: Point[];
  /** Same, one per hole. */
  holes: Point[][];
  /** Every original entity id (outer + holes) this part was built from. */
  sourceIds: string[];
}

interface Region {
  points: Point[];
  area: number;
  entityIds: string[];
  name?: string;
}

export function extractParts(
  entities: Entity[],
  selectedIds: ReadonlySet<string>,
  opts: { chordTolerance?: number } = {},
): ExtractedPart[] {
  const chordTol = opts.chordTolerance ?? DEFAULT_CHORD_TOLERANCE;
  const selected = entities.filter((e) => selectedIds.has(e.id));
  const regions = gatherRegions(selected, chordTol);
  if (regions.length === 0) return [];

  const parents = findParents(regions);
  const children = new Map<number, number[]>();
  parents.forEach((parent, i) => {
    if (parent === null) return;
    const list = children.get(parent);
    if (list) list.push(i);
    else children.set(parent, [i]);
  });

  const parts: ExtractedPart[] = [];
  let counter = 0;

  const buildPart = (outerIdx: number): void => {
    const outerRegion = regions[outerIdx];
    const sourceIds = [...outerRegion.entityIds];
    const holes: Point[][] = [];
    for (const holeIdx of children.get(outerIdx) ?? []) {
      const holeRegion = regions[holeIdx];
      holes.push(holeRegion.points);
      sourceIds.push(...holeRegion.entityIds);
      for (const nestedPartIdx of children.get(holeIdx) ?? []) buildPart(nestedPartIdx);
    }
    counter += 1;
    parts.push({
      id: `part-${counter}`,
      name: outerRegion.name ?? `Part ${counter}`,
      outer: outerRegion.points,
      holes,
      sourceIds,
    });
  };

  parents.forEach((parent, i) => {
    if (parent === null) buildPart(i);
  });

  return parts;
}

/** Every closed loop in the selection: already-closed circles/polylines, plus open chains that close via `joinEntities`. */
function gatherRegions(entities: Entity[], chordTol: number): Region[] {
  const regions: Region[] = [];
  for (const e of entities) {
    if (e.type === "circle") {
      const points = flattenCircle(e.center, e.radius, chordTol);
      regions.push({ points, area: polygonArea(points), entityIds: [e.id], name: e.name });
    } else if (e.type === "polyline" && e.closed) {
      const points = flattenClosedPolyline(e, chordTol);
      regions.push({ points, area: polygonArea(points), entityIds: [e.id], name: e.name });
    }
  }
  for (const chain of joinEntities(entities)) {
    if (!chain.polyline.closed) continue; // an open chain isn't a part/hole boundary
    const points = flattenClosedPolyline(chain.polyline, chordTol);
    regions.push({ points, area: polygonArea(points), entityIds: chain.replaced });
  }
  return regions.filter((r) => r.points.length >= 3 && r.area > 1e-9);
}

/** Each region's immediate container — the smallest-area region that fully encloses it, or null at the top level. */
function findParents(regions: Region[]): (number | null)[] {
  return regions.map((region, i) => {
    let best: number | null = null;
    let bestArea = Infinity;
    regions.forEach((candidate, j) => {
      if (j === i || candidate.area <= region.area) return; // a container is strictly bigger
      if (candidate.area < bestArea && polygonContains(candidate.points, region.points)) {
        best = j;
        bestArea = candidate.area;
      }
    });
    return best;
  });
}

/** True when every vertex of `inner` lies inside `outer` and no edge of either crosses the other. */
function polygonContains(outer: Point[], inner: Point[]): boolean {
  for (const p of inner) {
    if (!pointInPolygon(p, outer)) return false;
  }
  for (let i = 0; i < outer.length; i++) {
    const a1 = outer[i];
    const a2 = outer[(i + 1) % outer.length];
    for (let j = 0; j < inner.length; j++) {
      const b1 = inner[j];
      const b2 = inner[(j + 1) % inner.length];
      if (properIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}
