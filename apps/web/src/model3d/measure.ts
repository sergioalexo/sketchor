import { EDGE_ARC, EDGE_CIRCLE, EDGE_CURVE, EDGE_LINE, cross, distance, dot, norm, normalize, read3, sub } from "./topology";
import type { Model3D, Vec3 } from "./types";

/**
 * What the corner readout says about a selection — Onshape's measure box:
 * click one thing and it tells you its length, radius or area; click two
 * and it tells you the distance and, where it means something, the angle.
 *
 * Pure: the viewer hands in the model, the picked references and the
 * formatters (so the numbers land in the tab's display unit), and gets
 * back label/value rows.
 */

export type SelRef =
  | { kind: "vertex"; index: number }
  | { kind: "edge"; index: number }
  | { kind: "face"; index: number }
  | { kind: "part"; index: number };

export interface MeasureRow {
  label: string;
  value: string;
  /** Set when the figure is derived rather than exact (a tessellated curve, a non-planar face). */
  approx?: boolean;
}

export interface Formatters {
  length(worldValue: number): string;
  area(worldValueSquared: number): string;
  volume(worldValueCubed: number): string;
}

const deg = (rad: number) => `${round(((rad * 180) / Math.PI), 2)}°`;

function round(v: number, places = 3): number {
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function sameRef(a: SelRef, b: SelRef): boolean {
  return a.kind === b.kind && a.index === b.index;
}

/** Which part a reference belongs to (for the readout's title and for hiding). */
export function partOf(model: Model3D, ref: SelRef): number {
  switch (ref.kind) {
    case "part":
      return ref.index;
    case "face":
      return model.faces.part[ref.index] ?? 0;
    case "edge":
      return model.edgeTable.part[ref.index] ?? 0;
    case "vertex":
      return model.nodes.part[ref.index] ?? 0;
  }
}

export function refLabel(model: Model3D, ref: SelRef): string {
  switch (ref.kind) {
    case "part":
      return model.parts[ref.index]?.name ?? "Part";
    case "face":
      return model.faces.planar[ref.index] ? "Plane" : "Face";
    case "edge": {
      const k = model.edgeTable.kind[ref.index];
      return k === EDGE_CIRCLE ? "Circle" : k === EDGE_ARC ? "Arc" : k === EDGE_LINE ? "Line" : "Edge";
    }
    case "vertex":
      return "Vertex";
  }
}

/* -------------------------------- geometry -------------------------------- */

/** The points of an edge's polyline (one per segment plus the last end). */
export function edgePoints(model: Model3D, edge: number): Vec3[] {
  const start = model.edgeTable.segStart[edge];
  const count = model.edgeTable.segCount[edge];
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const o = (start + i) * 6;
    if (i === 0) out.push([model.edges[o], model.edges[o + 1], model.edges[o + 2]]);
    out.push([model.edges[o + 3], model.edges[o + 4], model.edges[o + 5]]);
  }
  return out;
}

export function vertexPoint(model: Model3D, index: number): Vec3 {
  return read3(model.nodes.xyz, index);
}

function pointToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < 1e-18) return distance(p, a);
  let t = dot(sub(p, a), ab) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return distance(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
}

export function pointToPolyline(p: Vec3, pts: Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, pointToSegment(p, pts[i], pts[i + 1]));
  return pts.length === 1 ? distance(p, pts[0]) : best;
}

/** Shortest distance between two line segments (exact, including parallel and touching cases). */
export function segmentToSegment(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a < 1e-18 && e < 1e-18) return distance(p1, p2);
  if (a < 1e-18) {
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e < 1e-18) {
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-18 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1: Vec3 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2: Vec3 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  return distance(c1, c2);
}

export function polylineToPolyline(a: Vec3[], b: Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      best = Math.min(best, segmentToSegment(a[i], a[i + 1], b[j], b[j + 1]));
    }
  }
  return best;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Acute angle (radians) between two directions, sign-independent — an edge has no preferred way round. */
export function acuteAngle(u: Vec3, v: Vec3): number {
  const c = Math.abs(dot(normalize(u), normalize(v)));
  return Math.acos(Math.min(1, Math.max(0, c)));
}

/** Direction of a straight edge (its chord, which for EDGE_LINE is the edge). */
export function edgeDirection(model: Model3D, edge: number): Vec3 {
  return sub(read3(model.edgeTable.b, edge), read3(model.edgeTable.a, edge));
}

/** Every distinct vertex position of a face's triangles (capped — a face can carry thousands). */
function faceSamplePoints(model: Model3D, face: number, cap = 600): Vec3[] {
  const start = model.faces.triStart[face];
  const count = model.faces.triCount[face];
  const step = Math.max(1, Math.floor(count / cap));
  const out: Vec3[] = [];
  for (let t = 0; t < count; t += step) {
    for (let k = 0; k < 3; k++) {
      const vi = model.indices[(start + t) * 3 + k] * 3;
      out.push([model.positions[vi], model.positions[vi + 1], model.positions[vi + 2]]);
    }
  }
  return out;
}

/** Radius a face turns out to have when circular edges bound it (a cylinder, a hole), else null. */
export function faceRadius(model: Model3D, face: number): number | null {
  const part = model.faces.part[face];
  const p = model.parts[part];
  if (!p) return null;
  let radius: number | null = null;
  for (let e = p.edgeRefStart; e < p.edgeRefStart + p.edgeRefCount; e++) {
    if (model.edgeTable.faceA[e] !== face && model.edgeTable.faceB[e] !== face) continue;
    const kind = model.edgeTable.kind[e];
    if (kind !== EDGE_CIRCLE && kind !== EDGE_ARC) continue;
    const r = model.edgeTable.radius[e];
    if (radius === null) radius = r;
    else if (Math.abs(radius - r) > Math.max(r, radius) * 1e-3) return null;
  }
  return radius;
}

/* ------------------------------ the readout ------------------------------ */

export function measureSelection(model: Model3D, refs: SelRef[], fmt: Formatters): MeasureRow[] {
  if (refs.length === 0) return [];
  if (refs.length === 1) return measureOne(model, refs[0], fmt);
  const rows = measurePair(model, refs[refs.length - 2], refs[refs.length - 1], fmt);
  // Totals make a multi-select worth something even when the pair says
  // little — except a face pair, which already reports its combined area.
  if (refs.length > 2 && refs.every((r) => r.kind === "face")) {
    const total = refs.reduce((a, r) => a + model.faces.area[r.index], 0);
    rows.push({ label: `Total area (${refs.length})`, value: fmt.area(total) });
  }
  if (refs.every((r) => r.kind === "edge")) {
    const total = refs.reduce((a, r) => a + model.edgeTable.length[r.index], 0);
    rows.push({ label: `Total length (${refs.length})`, value: fmt.length(total) });
  }
  return rows;
}

function measureOne(model: Model3D, ref: SelRef, fmt: Formatters): MeasureRow[] {
  switch (ref.kind) {
    case "vertex": {
      const p = vertexPoint(model, ref.index);
      return [
        { label: "X", value: fmt.length(p[0]) },
        { label: "Y", value: fmt.length(p[1]) },
        { label: "Z", value: fmt.length(p[2]) },
      ];
    }
    case "edge": {
      const t = model.edgeTable;
      const kind = t.kind[ref.index];
      const rows: MeasureRow[] = [];
      if (kind === EDGE_CIRCLE || kind === EDGE_ARC) {
        rows.push({ label: "Diameter", value: fmt.length(t.radius[ref.index] * 2) });
        rows.push({ label: "Radius", value: fmt.length(t.radius[ref.index]) });
        if (kind === EDGE_ARC && t.radius[ref.index] > 0) {
          rows.push({ label: "Angle", value: deg(t.length[ref.index] / t.radius[ref.index]) });
        }
        const c = read3(t.center, ref.index);
        rows.push({ label: "Center", value: `${fmt.length(c[0])}, ${fmt.length(c[1])}, ${fmt.length(c[2])}` });
      }
      rows.push({ label: "Length", value: fmt.length(t.length[ref.index]), approx: kind === EDGE_CURVE });
      if (kind === EDGE_LINE) {
        const a = read3(t.a, ref.index);
        const b = read3(t.b, ref.index);
        rows.push({ label: "ΔX ΔY ΔZ", value: `${fmt.length(b[0] - a[0])}, ${fmt.length(b[1] - a[1])}, ${fmt.length(b[2] - a[2])}` });
      }
      return rows;
    }
    case "face": {
      const rows: MeasureRow[] = [{ label: "Area", value: fmt.area(model.faces.area[ref.index]), approx: !model.faces.planar[ref.index] }];
      rows.push({ label: "Perimeter", value: fmt.length(model.faces.perimeter[ref.index]) });
      const r = faceRadius(model, ref.index);
      if (r !== null && !model.faces.planar[ref.index]) {
        rows.push({ label: "Diameter", value: fmt.length(r * 2) });
        rows.push({ label: "Radius", value: fmt.length(r) });
      }
      if (model.faces.planar[ref.index]) {
        const n = read3(model.faces.normal, ref.index);
        rows.push({ label: "Normal", value: `${round(n[0])}, ${round(n[1])}, ${round(n[2])}` });
      }
      return rows;
    }
    case "part": {
      const p = model.parts[ref.index];
      if (!p) return [];
      const size = [0, 1, 2].map((k) => p.bounds.max[k] - p.bounds.min[k]);
      return [
        { label: "Size", value: size.map((v) => fmt.length(v)).join(" × ") },
        { label: "Surface area", value: fmt.area(p.area) },
        { label: "Volume", value: fmt.volume(p.volume), approx: true },
        { label: "Faces / edges", value: `${p.faceCount} / ${p.edgeRefCount}` },
      ];
    }
  }
}

function measurePair(model: Model3D, a: SelRef, b: SelRef, fmt: Formatters): MeasureRow[] {
  const kinds = [a.kind, b.kind].sort().join("+");
  const rows: MeasureRow[] = [];

  const pointOf = (r: SelRef): Vec3 | null => (r.kind === "vertex" ? vertexPoint(model, r.index) : null);

  if (kinds === "vertex+vertex") {
    const p = pointOf(a)!;
    const q = pointOf(b)!;
    rows.push({ label: "Distance", value: fmt.length(distance(p, q)) });
    rows.push({ label: "ΔX ΔY ΔZ", value: `${fmt.length(q[0] - p[0])}, ${fmt.length(q[1] - p[1])}, ${fmt.length(q[2] - p[2])}` });
    return rows;
  }

  if (kinds === "edge+vertex") {
    const v = (a.kind === "vertex" ? a : b) as Extract<SelRef, { kind: "vertex" }>;
    const e = (a.kind === "edge" ? a : b) as Extract<SelRef, { kind: "edge" }>;
    const p = vertexPoint(model, v.index);
    rows.push({ label: "Distance", value: fmt.length(pointToPolyline(p, edgePoints(model, e.index))), approx: model.edgeTable.kind[e.index] === EDGE_CURVE });
    return rows;
  }

  if (kinds === "face+vertex") {
    const v = (a.kind === "vertex" ? a : b) as Extract<SelRef, { kind: "vertex" }>;
    const f = (a.kind === "face" ? a : b) as Extract<SelRef, { kind: "face" }>;
    const p = vertexPoint(model, v.index);
    rows.push(faceDistanceRow(model, f.index, [p], fmt));
    return rows;
  }

  if (kinds === "edge+edge") {
    const ea = a as Extract<SelRef, { kind: "edge" }>;
    const eb = b as Extract<SelRef, { kind: "edge" }>;
    const ka = model.edgeTable.kind[ea.index];
    const kb = model.edgeTable.kind[eb.index];
    const pa = edgePoints(model, ea.index);
    const pb = edgePoints(model, eb.index);
    if (ka === EDGE_LINE && kb === EDGE_LINE) {
      const angle = acuteAngle(edgeDirection(model, ea.index), edgeDirection(model, eb.index));
      rows.push({ label: "Angle", value: deg(angle) });
    }
    if ((ka === EDGE_CIRCLE || ka === EDGE_ARC) && (kb === EDGE_CIRCLE || kb === EDGE_ARC)) {
      const ca = read3(model.edgeTable.center, ea.index);
      const cb = read3(model.edgeTable.center, eb.index);
      rows.push({ label: "Centre distance", value: fmt.length(distance(ca, cb)) });
    }
    rows.push({ label: "Distance", value: fmt.length(polylineToPolyline(pa, pb)), approx: ka === EDGE_CURVE || kb === EDGE_CURVE });
    return rows;
  }

  if (kinds === "edge+face") {
    const e = (a.kind === "edge" ? a : b) as Extract<SelRef, { kind: "edge" }>;
    const f = (a.kind === "face" ? a : b) as Extract<SelRef, { kind: "face" }>;
    if (model.faces.planar[f.index] && model.edgeTable.kind[e.index] === EDGE_LINE) {
      const n = read3(model.faces.normal, f.index);
      const angle = Math.PI / 2 - acuteAngle(edgeDirection(model, e.index), n);
      rows.push({ label: "Angle", value: deg(Math.abs(angle)) });
    }
    rows.push(faceDistanceRow(model, f.index, edgePoints(model, e.index), fmt));
    return rows;
  }

  if (kinds === "face+face") {
    const fa = a as Extract<SelRef, { kind: "face" }>;
    const fb = b as Extract<SelRef, { kind: "face" }>;
    const planar = model.faces.planar[fa.index] && model.faces.planar[fb.index];
    if (planar) {
      const na = read3(model.faces.normal, fa.index);
      const nb = read3(model.faces.normal, fb.index);
      const angle = acuteAngle(na, nb);
      const parallel = norm(cross(normalize(na), normalize(nb))) < 1e-3;
      if (parallel) {
        const ca = read3(model.faces.centroid, fa.index);
        const cb = read3(model.faces.centroid, fb.index);
        rows.push({ label: "Distance", value: fmt.length(Math.abs(dot(sub(cb, ca), normalize(na)))) });
      } else {
        rows.push({ label: "Angle", value: deg(angle) });
      }
    } else {
      rows.push(faceDistanceRow(model, fb.index, faceSamplePoints(model, fa.index), fmt));
    }
    rows.push({ label: "Total area", value: fmt.area(model.faces.area[fa.index] + model.faces.area[fb.index]) });
    return rows;
  }

  // Anything involving a whole part: report both, nothing clever.
  return [
    { label: refLabel(model, a), value: summary(model, a, fmt) },
    { label: refLabel(model, b), value: summary(model, b, fmt) },
  ];
}

/** Distance from a set of points to a face: exact to the plane of a planar face, nearest-sample otherwise. */
function faceDistanceRow(model: Model3D, face: number, points: Vec3[], fmt: Formatters): MeasureRow {
  if (model.faces.planar[face]) {
    const n = normalize(read3(model.faces.normal, face));
    const c = read3(model.faces.centroid, face);
    let best = Infinity;
    for (const p of points) best = Math.min(best, Math.abs(dot(sub(p, c), n)));
    return { label: "Distance to plane", value: fmt.length(best) };
  }
  const samples = faceSamplePoints(model, face);
  let best = Infinity;
  for (const p of points) for (const q of samples) best = Math.min(best, distance(p, q));
  return { label: "Distance", value: fmt.length(best), approx: true };
}

function summary(model: Model3D, ref: SelRef, fmt: Formatters): string {
  switch (ref.kind) {
    case "vertex": {
      const p = vertexPoint(model, ref.index);
      return `${fmt.length(p[0])}, ${fmt.length(p[1])}, ${fmt.length(p[2])}`;
    }
    case "edge":
      return fmt.length(model.edgeTable.length[ref.index]);
    case "face":
      return fmt.area(model.faces.area[ref.index]);
    case "part":
      return model.parts[ref.index]?.name ?? "";
  }
}
