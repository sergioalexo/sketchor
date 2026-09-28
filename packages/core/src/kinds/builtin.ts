import { boundsOf } from "../dxf";
import type {
  ArcEntity,
  CircleEntity,
  Entity,
  ImageEntity,
  LineEntity,
  PointEntity,
  PolylineEntity,
  TextEntity,
} from "../entities";
import { imageCorners, polylineSegments, textCorners } from "../entities";
import type { Point } from "../geometry";
import { arcPointAt, arcSweep, bulgeToArc, dist, distToArc, distToSegment, mid } from "../geometry";
import { applyGrip, gripsOf } from "../grips";
import { pathOf } from "../intersect";
import { pointInPolygon } from "../regions";
import { flattenPolylineToPoints } from "../simplify";
import { registerKind, type Affine, type EntityKind, type KindSnap } from "./registry";

/**
 * The seven built-in kinds, registered by moving in what used to be a
 * `switch (entity.type)` in each generic consumer (hit testing lived in
 * Viewport.tsx, feature points in snapping.ts, bounds in dxf.ts). Behaviour
 * is unchanged; the point is that a new kind now plugs into the same slots.
 *
 * Importing this module registers them — `index.ts` does so for the package.
 */

/* --------------------------------- helpers --------------------------------- */

const mapPoint = (m: Affine, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/**
 * A similarity (rotation + uniform scale, optionally mirrored) read out of an
 * affine matrix, or null for anything that shears or scales unevenly — the
 * maps circles, arcs, text and images can follow without changing kind.
 */
function similarity(m: Affine): { scale: number; rotation: number; mirrored: boolean } | null {
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

/** Points along an arc so no chord strays further than `tol` from the curve. */
function sampleArc(center: Point, radius: number, start: number, end: number, ccw: boolean, tol: number, full = false): Point[] {
  const sweep = full ? Math.PI * 2 : arcSweep(start, end, ccw);
  const maxStep = radius > tol ? 2 * Math.acos(1 - Math.min(1, tol / radius)) : Math.PI / 2;
  const steps = Math.max(full ? 8 : 2, Math.ceil(sweep / Math.max(maxStep, 1e-3)));
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ccw ? start + sweep * (i / steps) : start - sweep * (i / steps);
    out.push(arcPointAt(center, radius, t));
  }
  return out;
}

const closedRun = (pts: Point[]): Point[] => [...pts, pts[0]];

/* ---------------------------------- kinds ---------------------------------- */

const lineKind: EntityKind<LineEntity> = {
  type: "line",
  tessellate: (e) => [[e.a, e.b]],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => ({ ...e, a: mapPoint(m, e.a), b: mapPoint(m, e.b) }),
  path: pathOf,
  snaps: (e): KindSnap[] => [
    { point: e.a, kind: "endpoint" },
    { point: e.b, kind: "endpoint" },
    { point: mid(e.a, e.b), kind: "midpoint" },
  ],
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as LineEntity,
  hitDistance: (e, p) => distToSegment(p, e.a, e.b),
};

const circleKind: EntityKind<CircleEntity> = {
  type: "circle",
  tessellate: (e, tol) => [sampleArc(e.center, e.radius, 0, Math.PI * 2, true, tol, true)],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const s = similarity(m);
    return s ? { ...e, center: mapPoint(m, e.center), radius: e.radius * s.scale } : null;
  },
  path: pathOf,
  snaps: (e): KindSnap[] => {
    const { center: c, radius: r } = e;
    return [
      { point: c, kind: "center" },
      { point: { x: c.x + r, y: c.y }, kind: "quadrant" },
      { point: { x: c.x - r, y: c.y }, kind: "quadrant" },
      { point: { x: c.x, y: c.y + r }, kind: "quadrant" },
      { point: { x: c.x, y: c.y - r }, kind: "quadrant" },
    ];
  },
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as CircleEntity,
  // A hatch-filled circle (e.g. a round pallet) is clickable anywhere inside it,
  // not just on its rim — matching how a solid shape behaves in every other drawing app.
  hitDistance: (e, p) => (e.fill && dist(p, e.center) <= e.radius ? 0 : Math.abs(dist(p, e.center) - e.radius)),
};

const arcKind: EntityKind<ArcEntity> = {
  type: "arc",
  tessellate: (e, tol) => [sampleArc(e.center, e.radius, e.startAngle, e.endAngle, e.ccw, tol)],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const s = similarity(m);
    if (!s) return null;
    // A mirror flips the sweep direction: x-axis reflection then rotation maps angle φ to rotation − φ.
    const map = (a: number): number => (s.mirrored ? s.rotation - a : a + s.rotation);
    return {
      ...e,
      center: mapPoint(m, e.center),
      radius: e.radius * s.scale,
      startAngle: map(e.startAngle),
      endAngle: map(e.endAngle),
      ccw: s.mirrored ? !e.ccw : e.ccw,
    };
  },
  path: pathOf,
  snaps: (e): KindSnap[] => {
    const sweep = arcSweep(e.startAngle, e.endAngle, e.ccw);
    const midAngle = e.ccw ? e.startAngle + sweep / 2 : e.startAngle - sweep / 2;
    return [
      { point: e.center, kind: "center" },
      { point: arcPointAt(e.center, e.radius, e.startAngle), kind: "endpoint" },
      { point: arcPointAt(e.center, e.radius, e.endAngle), kind: "endpoint" },
      { point: arcPointAt(e.center, e.radius, midAngle), kind: "midpoint" },
    ];
  },
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as ArcEntity,
  hitDistance: (e, p) => distToArc(p, e.center, e.radius, e.startAngle, e.endAngle, e.ccw),
};

const pointKind: EntityKind<PointEntity> = {
  type: "point",
  tessellate: (e) => [[e.p]],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => ({ ...e, p: mapPoint(m, e.p) }),
  path: () => null,
  snaps: (e): KindSnap[] => [{ point: e.p, kind: "node" }],
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as PointEntity,
  hitDistance: (e, p) => dist(p, e.p),
};

const polylineKind: EntityKind<PolylineEntity> = {
  type: "polyline",
  tessellate: (e, tol) => {
    const pts = flattenPolylineToPoints(e, tol);
    return [e.closed && pts.length > 0 ? closedRun(pts) : pts];
  },
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const hasBulge = e.bulges?.some((b) => b !== 0) ?? false;
    const s = similarity(m);
    if (hasBulge && !s) return null; // a bulge arc under shear/uneven scale is an ellipse arc
    const flip = s?.mirrored ?? m[0] * m[3] - m[1] * m[2] < 0;
    return {
      ...e,
      points: e.points.map((p) => mapPoint(m, p)),
      ...(e.bulges ? { bulges: flip ? e.bulges.map((b) => -b) : e.bulges } : {}),
    };
  },
  path: pathOf,
  snaps: (e): KindSnap[] => {
    // Every vertex is an endpoint; every segment additionally offers a midpoint (arc segments their centre too).
    const out: KindSnap[] = e.points.map((p) => ({ point: p, kind: "endpoint" as const }));
    for (const seg of polylineSegments(e)) {
      const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
      if (arc) {
        out.push({ point: arc.center, kind: "center" });
        const sweep = arcSweep(arc.startAngle, arc.endAngle, arc.ccw);
        const midAngle = arc.ccw ? arc.startAngle + sweep / 2 : arc.startAngle - sweep / 2;
        out.push({ point: arcPointAt(arc.center, arc.radius, midAngle), kind: "midpoint" });
      } else {
        out.push({ point: mid(seg.a, seg.b), kind: "midpoint" });
      }
    }
    return out;
  },
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as PolylineEntity,
  hitDistance: (e, p) => {
    // A closed, hatch-filled polyline (e.g. a pallet) is clickable anywhere inside it,
    // not just near its outline — otherwise clicking the middle of a big filled shape selects nothing.
    if (e.closed && e.fill && pointInPolygon(p, e.points)) return 0;
    // Whichever of its segments the cursor is nearest to.
    return Math.min(
      ...polylineSegments(e).map((seg) => {
        const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
        return arc ? distToArc(p, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw) : distToSegment(p, seg.a, seg.b);
      }),
    );
  },
};

const textKind: EntityKind<TextEntity> = {
  type: "text",
  tessellate: (e) => [closedRun(textCorners(e))],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const s = similarity(m);
    if (!s || s.mirrored) return null;
    return { ...e, at: mapPoint(m, e.at), rotation: e.rotation + s.rotation, height: e.height * s.scale };
  },
  path: () => null,
  snaps: (e): KindSnap[] => [{ point: e.at, kind: "endpoint" }],
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as TextEntity,
  // Anywhere inside the label's box counts (the caller's aperture handles the rim).
  hitDistance: (e, p) => {
    const c = textCorners(e);
    return pointInPolygon(p, c) ? 0 : Math.min(...c.map((q, i) => distToSegment(p, q, c[(i + 1) % c.length])));
  },
};

const imageKind: EntityKind<ImageEntity> = {
  type: "image",
  tessellate: (e) => [closedRun(imageCorners(e))],
  bounds: (e) => boundsOf([e]),
  transform: (e, m) => {
    const s = similarity(m);
    if (!s || s.mirrored) return null;
    return {
      ...e,
      insert: mapPoint(m, e.insert),
      rotation: e.rotation + s.rotation,
      width: e.width * s.scale,
      height: e.height * s.scale,
    };
  },
  path: () => null,
  snaps: (e): KindSnap[] => imageCorners(e).map((p) => ({ point: p, kind: "endpoint" as const })),
  grips: gripsOf,
  applyGrip: (e, g, to) => applyGrip(e, g, to) as ImageEntity,
  hitDistance: (e, p) => (pointInPolygon(p, imageCorners(e)) ? 0 : Infinity),
};

for (const kind of [lineKind, circleKind, arcKind, pointKind, polylineKind, textKind, imageKind] as EntityKind<never>[]) {
  registerKind(kind as unknown as EntityKind<Entity>);
}
