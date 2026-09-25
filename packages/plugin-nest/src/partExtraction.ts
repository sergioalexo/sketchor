import { curveEnd, curveStart, dist, joinEntities, pathOf, type Entity } from "@sketchor/core";
import { area as polygonArea, polygonContainsPolygon } from "./geometry";
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
  /** Just the outer boundary's own entity ids — a subset of `sourceIds` (N-31: routes outer-profile cuts to their own DXF layer, separate from holes). */
  outerSourceIds: string[];
  /** Same, one array per hole, index-aligned with `holes`. */
  holeSourceIds: string[][];
}

/**
 * NF-03: a run of selected lines/arcs/open-polylines that chained together
 * but never closed into a loop — the shape a user meant as a part boundary,
 * minus one connection. `gap` is the distance between the two free ends
 * (0 for a lone entity with no partner at all, which still counts — it just
 * never found anything else to connect to within tolerance).
 */
export interface OpenChainInfo {
  entityIds: string[];
  start: Point;
  end: Point;
  gap: number;
}

export interface ExtractResult {
  parts: ExtractedPart[];
  openChains: OpenChainInfo[];
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
  opts: { chordTolerance?: number; joinTolerance?: number } = {},
): ExtractedPart[] {
  return extractPartsWithDiagnostics(entities, selectedIds, opts).parts;
}

/**
 * Same as {@link extractParts}, plus `openChains` — every selected boundary
 * candidate that didn't make it into a part because it never closed. Used by
 * `nestPlugin.ts`'s "Add selection" to say *why* nothing (or fewer than
 * expected) came out, instead of a flat "select closed shapes".
 */
export function extractPartsWithDiagnostics(
  entities: Entity[],
  selectedIds: ReadonlySet<string>,
  opts: { chordTolerance?: number; joinTolerance?: number } = {},
): ExtractResult {
  const chordTol = opts.chordTolerance ?? DEFAULT_CHORD_TOLERANCE;
  const selected = entities.filter((e) => selectedIds.has(e.id));
  const { regions, openChains } = gatherRegions(selected, chordTol, opts.joinTolerance);
  if (regions.length === 0) return { parts: [], openChains };

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
    const outerSourceIds = [...outerRegion.entityIds];
    const sourceIds = [...outerSourceIds];
    const holes: Point[][] = [];
    const holeSourceIds: string[][] = [];
    for (const holeIdx of children.get(outerIdx) ?? []) {
      const holeRegion = regions[holeIdx];
      holes.push(holeRegion.points);
      holeSourceIds.push([...holeRegion.entityIds]);
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
      outerSourceIds,
      holeSourceIds,
    });
  };

  parents.forEach((parent, i) => {
    if (parent === null) buildPart(i);
  });

  return { parts, openChains };
}

/** Every closed loop in the selection (already-closed circles/polylines, plus open chains that close via `joinEntities`), plus every candidate boundary that stayed open (NF-03). */
function gatherRegions(entities: Entity[], chordTol: number, joinTolerance?: number): { regions: Region[]; openChains: OpenChainInfo[] } {
  const regions: Region[] = [];
  const closedIds = new Set<string>();
  for (const e of entities) {
    if (e.type === "circle") {
      const points = flattenCircle(e.center, e.radius, chordTol);
      regions.push({ points, area: polygonArea(points), entityIds: [e.id], name: e.name });
      closedIds.add(e.id);
    } else if (e.type === "polyline" && e.closed) {
      const points = flattenClosedPolyline(e, chordTol);
      regions.push({ points, area: polygonArea(points), entityIds: [e.id], name: e.name });
      closedIds.add(e.id);
    }
  }

  const openChains: OpenChainInfo[] = [];
  const chainedIds = new Set<string>();
  for (const chain of joinEntities(entities, joinTolerance)) {
    chain.replaced.forEach((id) => chainedIds.add(id));
    if (!chain.polyline.closed) {
      // An open chain isn't a part/hole boundary, but it's exactly the
      // "almost closed" case NF-03 exists to name — a real gap between its
      // two free ends, at a specific, reportable location.
      const pts = chain.polyline.points;
      if (pts.length >= 2) {
        openChains.push({ entityIds: chain.replaced, start: pts[0], end: pts[pts.length - 1], gap: dist(pts[0], pts[pts.length - 1]) });
      }
      continue;
    }
    const points = flattenClosedPolyline(chain.polyline, chordTol);
    regions.push({ points, area: polygonArea(points), entityIds: chain.replaced });
  }

  // joinEntities only reports chains of 2+ pieces — a selected line/arc/open
  // polyline that never found anything to connect to at all (no partner
  // within tolerance, not just "not closed yet") would otherwise disappear
  // from the diagnostics entirely.
  for (const e of entities) {
    if (closedIds.has(e.id) || chainedIds.has(e.id)) continue;
    if (e.type !== "line" && e.type !== "arc" && !(e.type === "polyline" && !e.closed)) continue;
    const path = pathOf(e);
    if (!path || path.curves.length === 0) continue;
    const start = curveStart(path.curves[0]);
    const end = curveEnd(path.curves[path.curves.length - 1]);
    openChains.push({ entityIds: [e.id], start, end, gap: dist(start, end) });
  }

  return { regions: regions.filter((r) => r.points.length >= 3 && r.area > 1e-9), openChains };
}

/** Each region's immediate container — the smallest-area region that fully encloses it, or null at the top level. */
function findParents(regions: Region[]): (number | null)[] {
  return regions.map((region, i) => {
    let best: number | null = null;
    let bestArea = Infinity;
    regions.forEach((candidate, j) => {
      if (j === i || candidate.area <= region.area) return; // a container is strictly bigger
      if (candidate.area < bestArea && polygonContainsPolygon(candidate.points, region.points)) {
        best = j;
        bestArea = candidate.area;
      }
    });
    return best;
  });
}
