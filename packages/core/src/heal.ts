import type { Entity, EntityId, LineEntity } from "./entities";
import { newEntityId } from "./entities";
import { layerOf } from "./entities";
import type { Point } from "./geometry";
import { closestPointOnSegment, dist, distToSegment, reduceToHalfTurn } from "./geometry";
import type { SketchDocument } from "./document";
import type { Command } from "./commands";

/**
 * Finds and fixes endpoints that should meet but don't — open ends,
 * near-misses, T-junction gaps — in the drawing's line geometry. Healed
 * junctions are exactly where coincident constraints will belong once the
 * constraint solver (R2) lands.
 */

export interface HealOptions {
  /** World-unit distance below which two endpoints (or an endpoint and a segment) are considered "close". */
  linearEps: number;
  /** Degrees within which two lines are considered collinear, for the join-instead-of-merge fix. */
  angularEpsDeg: number;
  /** Consider endpoints on different layers for merging/joining. Off by default. */
  crossLayer: boolean;
}

export const DEFAULT_HEAL_OPTIONS: HealOptions = { linearEps: 0.5, angularEpsDeg: 2, crossLayer: false };

type Which = "a" | "b";

export type HealIssue =
  | {
      id: string;
      kind: "near-coincident";
      location: Point;
      endpoints: { entityId: EntityId; which: Which }[];
      /** True when the (exactly two) lines involved are also near-collinear — a join is offered alongside merge. */
      collinear: boolean;
    }
  | { id: string; kind: "dangling"; location: Point; entityId: EntityId; which: Which }
  | {
      id: string;
      kind: "t-junction";
      location: Point;
      danglingEntityId: EntityId;
      danglingWhich: Which;
      targetEntityId: EntityId;
      projected: Point;
    };

/** Every entity id this issue touches — for display and "fix selected" wiring. */
export function issueEntityIds(issue: HealIssue): EntityId[] {
  switch (issue.kind) {
    case "near-coincident":
      return [...new Set(issue.endpoints.map((e) => e.entityId))];
    case "dangling":
      return [issue.entityId];
    case "t-junction":
      return [issue.danglingEntityId, issue.targetEntityId];
  }
}

export function issueLabel(issue: HealIssue): string {
  switch (issue.kind) {
    case "near-coincident":
      return issue.collinear ? "Near-coincident (collinear)" : "Near-coincident endpoints";
    case "dangling":
      return "Dangling end";
    case "t-junction":
      return "T-junction gap";
  }
}

/* ------------------------------ scanning ------------------------------ */

interface EndpointRef {
  entityId: EntityId;
  which: Which;
  point: Point;
  layer: string;
}

function lineEndpoints(doc: SketchDocument): EndpointRef[] {
  const out: EndpointRef[] = [];
  for (const e of doc.all()) {
    if (e.type !== "line") continue;
    out.push({ entityId: e.id, which: "a", point: e.a, layer: layerOf(e) });
    out.push({ entityId: e.id, which: "b", point: e.b, layer: layerOf(e) });
  }
  return out;
}

function cellKey(p: Point, cell: number): string {
  return `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
}

/** Spatial hash of endpoints by grid cell (cell size = tolerance), for O(1) neighbor lookup instead of O(n^2). */
function buildHash(points: EndpointRef[], cell: number): Map<string, EndpointRef[]> {
  const map = new Map<string, EndpointRef[]>();
  for (const p of points) {
    const k = cellKey(p.point, cell);
    const bucket = map.get(k);
    if (bucket) bucket.push(p);
    else map.set(k, [p]);
  }
  return map;
}

function neighborCandidates(hash: Map<string, EndpointRef[]>, p: Point, cell: number): EndpointRef[] {
  const cx = Math.floor(p.x / cell);
  const cy = Math.floor(p.y / cell);
  const out: EndpointRef[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = hash.get(`${cx + dx},${cy + dy}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

/** Minimal union-find over endpoint keys, used to cluster near-coincident endpoints. */
class UnionFind {
  private parent = new Map<string, string>();

  key(e: EndpointRef): string {
    return `${e.entityId}.${e.which}`;
  }

  private root(k: string): string {
    let cur = this.parent.get(k) ?? k;
    while (cur !== (this.parent.get(cur) ?? cur)) cur = this.parent.get(cur)!;
    this.parent.set(k, cur);
    return cur;
  }

  union(a: EndpointRef, b: EndpointRef): void {
    const ka = this.key(a);
    const kb = this.key(b);
    if (!this.parent.has(ka)) this.parent.set(ka, ka);
    if (!this.parent.has(kb)) this.parent.set(kb, kb);
    const ra = this.root(ka);
    const rb = this.root(kb);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  has(k: string): boolean {
    return this.parent.has(k);
  }

  find(k: string): string {
    return this.root(k);
  }
}

function lineAngle(e: LineEntity): number {
  return Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
}

function nearCollinear(a: number, b: number, epsDeg: number): boolean {
  return Math.abs(reduceToHalfTurn(a - b)) <= (epsDeg * Math.PI) / 180;
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

/**
 * Scans every line endpoint for issues: near-coincident clusters (via a
 * spatial hash + union-find), dangling ends, and T-junction gaps against
 * other segments' interiors.
 */
export function scanForIssues(doc: SketchDocument, opts: HealOptions): HealIssue[] {
  const eps = Math.max(opts.linearEps, 1e-9);
  const endpoints = lineEndpoints(doc);
  const hash = buildHash(endpoints, eps);
  const uf = new UnionFind();

  for (const p of endpoints) {
    for (const q of neighborCandidates(hash, p.point, eps)) {
      if (q.entityId === p.entityId) continue; // a line's own two ends aren't a "joint"
      if (!opts.crossLayer && q.layer !== p.layer) continue;
      const d = dist(p.point, q.point);
      if (d <= 1e-9 || d > eps) continue; // exactly coincident (fine) or too far
      uf.union(p, q);
    }
  }

  const clusters = new Map<string, EndpointRef[]>();
  for (const p of endpoints) {
    const k = uf.key(p);
    if (!uf.has(k)) continue;
    const root = uf.find(k);
    const bucket = clusters.get(root);
    if (bucket) bucket.push(p);
    else clusters.set(root, [p]);
  }

  const issues: HealIssue[] = [];
  const clustered = new Set<string>();
  for (const [root, group] of clusters) {
    for (const p of group) clustered.add(uf.key(p));
    const entityIds = [...new Set(group.map((g) => g.entityId))];
    let collinear = false;
    if (entityIds.length === 2) {
      const [e1, e2] = entityIds.map((id) => doc.get(id));
      if (e1?.type === "line" && e2?.type === "line") {
        collinear = nearCollinear(lineAngle(e1), lineAngle(e2), opts.angularEpsDeg);
      }
    }
    issues.push({
      id: `nc:${root}`,
      kind: "near-coincident",
      location: centroid(group.map((g) => g.point)),
      endpoints: group.map((g) => ({ entityId: g.entityId, which: g.which })),
      collinear,
    });
  }

  // Endpoints exactly shared with another line's endpoint are already joined — not issues.
  const exactGroups = new Map<string, EndpointRef[]>();
  for (const p of endpoints) {
    const k = `${p.point.x.toFixed(6)},${p.point.y.toFixed(6)}`;
    const bucket = exactGroups.get(k);
    if (bucket) bucket.push(p);
    else exactGroups.set(k, [p]);
  }
  const hasExactPartner = (p: EndpointRef): boolean => {
    const k = `${p.point.x.toFixed(6)},${p.point.y.toFixed(6)}`;
    return exactGroups.get(k)!.some((q) => q.entityId !== p.entityId);
  };

  for (const p of endpoints) {
    const key = uf.key(p);
    if (clustered.has(key)) continue;
    if (hasExactPartner(p)) continue;

    let junction: { target: Entity; projected: Point } | null = null;
    for (const other of doc.all()) {
      if (other.type !== "line" || other.id === p.entityId) continue;
      if (!opts.crossLayer && layerOf(other) !== p.layer) continue;
      const cp = closestPointOnSegment(p.point, other.a, other.b);
      // Close to one of the segment's own ends -> that's an endpoint case, not an interior T-junction.
      if (dist(cp, other.a) <= eps || dist(cp, other.b) <= eps) continue;
      if (distToSegment(p.point, other.a, other.b) <= eps) {
        junction = { target: other, projected: cp };
        break;
      }
    }

    if (junction) {
      issues.push({
        id: `tj:${key}`,
        kind: "t-junction",
        location: p.point,
        danglingEntityId: p.entityId,
        danglingWhich: p.which,
        targetEntityId: junction.target.id,
        projected: junction.projected,
      });
    } else {
      issues.push({ id: `dn:${key}`, kind: "dangling", location: p.point, entityId: p.entityId, which: p.which });
    }
  }

  return issues;
}

/* ------------------------------- fixing -------------------------------- */

function fixMerge(doc: SketchDocument, issue: Extract<HealIssue, { kind: "near-coincident" }>): Command[] {
  const commands: Command[] = [];
  const seen = new Set<EntityId>();
  for (const ep of issue.endpoints) {
    if (seen.has(ep.entityId)) continue; // guards a degenerate cluster touching both ends of one line
    seen.add(ep.entityId);
    const entity = doc.get(ep.entityId);
    if (!entity || entity.type !== "line") continue;
    const updated: LineEntity = ep.which === "a" ? { ...entity, a: issue.location } : { ...entity, b: issue.location };
    if (dist(updated.a, updated.b) < 1e-9) {
      commands.push({ type: "delete-entities", ids: [entity.id] });
    } else {
      commands.push({ type: "update-entity", entity: updated });
    }
  }
  return commands;
}

/** Replaces two collinear, near-touching lines with a single line spanning their far ends. */
function fixJoin(doc: SketchDocument, issue: Extract<HealIssue, { kind: "near-coincident" }>): Command[] {
  const ids = [...new Set(issue.endpoints.map((e) => e.entityId))];
  if (ids.length !== 2) return fixMerge(doc, issue);
  const [id1, id2] = ids;
  const e1 = doc.get(id1);
  const e2 = doc.get(id2);
  if (!e1 || !e2 || e1.type !== "line" || e2.type !== "line") return [];
  const which1 = issue.endpoints.find((e) => e.entityId === id1)!.which;
  const which2 = issue.endpoints.find((e) => e.entityId === id2)!.which;
  const far1 = which1 === "a" ? e1.b : e1.a;
  const far2 = which2 === "a" ? e2.b : e2.a;
  return [
    { type: "delete-entities", ids: [id1, id2] },
    {
      type: "add-entity",
      entity: { id: newEntityId(), type: "line", name: e1.name, ...(e1.layer ? { layer: e1.layer } : {}), a: far1, b: far2 },
    },
  ];
}

function fixTJunction(doc: SketchDocument, issue: Extract<HealIssue, { kind: "t-junction" }>): Command[] {
  const dangling = doc.get(issue.danglingEntityId);
  const target = doc.get(issue.targetEntityId);
  if (!dangling || dangling.type !== "line" || !target || target.type !== "line") return [];

  const updatedDangling: LineEntity =
    issue.danglingWhich === "a" ? { ...dangling, a: issue.projected } : { ...dangling, b: issue.projected };
  const layerProp = target.layer ? { layer: target.layer } : {};
  return [
    { type: "update-entity", entity: updatedDangling },
    { type: "delete-entities", ids: [target.id] },
    {
      type: "add-entity",
      entity: { id: newEntityId(), type: "line", name: target.name, ...layerProp, a: target.a, b: issue.projected },
    },
    { type: "add-entity", entity: { id: newEntityId(), type: "line", ...layerProp, a: issue.projected, b: target.b } },
  ];
}

/** Commands to fix one issue. Dangling ends with nothing nearby have no automatic fix (empty array). */
export function fixIssue(doc: SketchDocument, issue: HealIssue, joinCollinear: boolean): Command[] {
  switch (issue.kind) {
    case "dangling":
      return [];
    case "t-junction":
      return fixTJunction(doc, issue);
    case "near-coincident":
      return issue.collinear && joinCollinear ? fixJoin(doc, issue) : fixMerge(doc, issue);
  }
}

/** Commands to fix every issue, meant to be wrapped in one `batch` command for a single-step undo. */
export function fixAllIssues(doc: SketchDocument, issues: HealIssue[], joinCollinear: boolean): Command[] {
  const commands: Command[] = [];
  for (const issue of issues) commands.push(...fixIssue(doc, issue, joinCollinear));
  return commands;
}
