import type { CircleEntity, EntityId, LineEntity, PointEntity } from "./entities";
import { dist, type Point } from "./geometry";
import type { SketchDocument } from "./document";
import type { Command } from "./commands";

/**
 * Finds redundant geometry: circles or points stacked on top of each other
 * (the "hole on hole" case — two nearly-identical circles at the same spot,
 * often from an accidental double-paste), and lines that duplicate or
 * partially overlap another line along the same infinite line. Each finding
 * keeps the first entity and offers to delete the rest.
 */

export interface DuplicateOptions {
  /** World-unit tolerance for "same center/endpoint" and "same radius". */
  tolerance: number;
}

export const DEFAULT_DUPLICATE_OPTIONS: DuplicateOptions = { tolerance: 0.5 };

export interface DuplicateIssue {
  id: string;
  kind: "duplicate-circle" | "duplicate-point" | "overlapping-lines";
  /** Every entity in the redundant group; fixing keeps entityIds[0] and deletes the rest. */
  entityIds: EntityId[];
  location: Point;
}

function centroid(points: Point[]): Point {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/** Connected components of `ids` under the symmetric relation `isPair` (transitive clustering, like union-find). */
function groupsFromPairs(ids: EntityId[], isPair: (a: EntityId, b: EntityId) => boolean): EntityId[][] {
  const adj = new Map<EntityId, Set<EntityId>>();
  for (const id of ids) adj.set(id, new Set());
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (isPair(ids[i], ids[j])) {
        adj.get(ids[i])!.add(ids[j]);
        adj.get(ids[j])!.add(ids[i]);
      }
    }
  }
  const seen = new Set<EntityId>();
  const groups: EntityId[][] = [];
  for (const id of ids) {
    if (seen.has(id) || adj.get(id)!.size === 0) continue;
    const group: EntityId[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      group.push(cur);
      for (const n of adj.get(cur)!) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function scanDuplicateCircles(circles: CircleEntity[], tol: number): DuplicateIssue[] {
  const byId = new Map(circles.map((c) => [c.id, c]));
  const groups = groupsFromPairs(circles.map((c) => c.id), (a, b) => {
    const ca = byId.get(a)!;
    const cb = byId.get(b)!;
    return dist(ca.center, cb.center) <= tol && Math.abs(ca.radius - cb.radius) <= tol;
  });
  return groups.map((ids, i) => ({
    id: `dup-circle:${i}:${ids[0]}`,
    kind: "duplicate-circle" as const,
    entityIds: ids,
    location: centroid(ids.map((id) => byId.get(id)!.center)),
  }));
}

function scanDuplicatePoints(points: PointEntity[], tol: number): DuplicateIssue[] {
  const byId = new Map(points.map((p) => [p.id, p]));
  const groups = groupsFromPairs(points.map((p) => p.id), (a, b) => dist(byId.get(a)!.p, byId.get(b)!.p) <= tol);
  return groups.map((ids, i) => ({
    id: `dup-point:${i}:${ids[0]}`,
    kind: "duplicate-point" as const,
    entityIds: ids,
    location: centroid(ids.map((id) => byId.get(id)!.p)),
  }));
}

/** True if `line2` runs along the same infinite line as `line1` and their spans overlap by more than `tol`. */
function linesOverlap(line1: LineEntity, line2: LineEntity, tol: number): boolean {
  const dx = line1.b.x - line1.a.x;
  const dy = line1.b.y - line1.a.y;
  const len1 = Math.hypot(dx, dy);
  if (len1 < 1e-9) return false;
  const ux = dx / len1;
  const uy = dy / len1;

  const perpDist = (p: Point) => Math.abs((p.x - line1.a.x) * uy - (p.y - line1.a.y) * ux);
  if (perpDist(line2.a) > tol || perpDist(line2.b) > tol) return false;

  const t = (p: Point) => (p.x - line1.a.x) * ux + (p.y - line1.a.y) * uy;
  const t2a = t(line2.a);
  const t2b = t(line2.b);
  const overlapStart = Math.max(0, Math.min(t2a, t2b));
  const overlapEnd = Math.min(len1, Math.max(t2a, t2b));
  return overlapEnd - overlapStart > tol;
}

function scanOverlappingLines(lines: LineEntity[], tol: number): DuplicateIssue[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const groups = groupsFromPairs(lines.map((l) => l.id), (a, b) => linesOverlap(byId.get(a)!, byId.get(b)!, tol));
  return groups.map((ids, i) => ({
    id: `overlap-line:${i}:${ids[0]}`,
    kind: "overlapping-lines" as const,
    entityIds: ids,
    location: centroid(ids.flatMap((id) => [byId.get(id)!.a, byId.get(id)!.b])),
  }));
}

export function scanForDuplicates(doc: SketchDocument, opts: DuplicateOptions = DEFAULT_DUPLICATE_OPTIONS): DuplicateIssue[] {
  const all = doc.all();
  const circles = all.filter((e): e is CircleEntity => e.type === "circle");
  const points = all.filter((e): e is PointEntity => e.type === "point");
  const lines = all.filter((e): e is LineEntity => e.type === "line");
  return [
    ...scanDuplicateCircles(circles, opts.tolerance),
    ...scanDuplicatePoints(points, opts.tolerance),
    ...scanOverlappingLines(lines, opts.tolerance),
  ];
}

export function duplicateIssueLabel(issue: DuplicateIssue): string {
  switch (issue.kind) {
    case "duplicate-circle":
      return "Duplicate circles";
    case "duplicate-point":
      return "Duplicate points";
    case "overlapping-lines":
      return "Overlapping lines";
  }
}

/** Deletes every entity in the group except the first, keeping one copy. */
export function fixDuplicate(issue: DuplicateIssue): Command[] {
  const [, ...redundant] = issue.entityIds;
  return redundant.length ? [{ type: "delete-entities", ids: redundant }] : [];
}

/** Commands to fix every finding, meant to be wrapped in one `batch` command for a single-step undo. */
export function fixAllDuplicates(issues: DuplicateIssue[]): Command[] {
  return issues.flatMap(fixDuplicate);
}
