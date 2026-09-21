import { arcFrom3Points } from "./arcs";
import type { Entity } from "./entities";
import { dist, rotatePoint, type Point } from "./geometry";
import { intersectCurves, pathOf, type Curve } from "./intersect";

/**
 * Constructions behind the draw-tool variants (roadmap T-02, T-04, T-05,
 * T-06): the extra ways to specify a circle, a rectangle placed by its
 * center or by three points, a regular polygon, and a slot. All return
 * plain geometry (no ids, names or layers) for the tool to wrap, and null
 * for degenerate picks so a tool just keeps waiting.
 */

export interface CircleParams {
  center: Point;
  radius: number;
}

/** Circle with the two points as ends of a diameter. */
export function circleFrom2Points(a: Point, b: Point): CircleParams | null {
  const d = dist(a, b);
  if (d < 1e-9) return null;
  return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, radius: d / 2 };
}

/** Circle through three points (null when collinear). */
export function circleFrom3Points(a: Point, b: Point, c: Point): CircleParams | null {
  const arc = arcFrom3Points(a, b, c);
  return arc ? { center: arc.center, radius: arc.radius } : null;
}

/**
 * Circle of `radius` tangent to two entities (AutoCAD's Tan-Tan-Radius):
 * of the up to four candidates — one per side of each entity — the one
 * whose center is nearest the two pick points, which is how the user says
 * which side. Null when no candidate exists (radius too small to bridge).
 */
export function circleTangentToTwo(e1: Entity, e2: Entity, radius: number, near1: Point, near2: Point): CircleParams | null {
  if (radius <= 0) return null;
  const c1 = offsetCandidates(e1, radius);
  const c2 = offsetCandidates(e2, radius);
  let best: { center: Point; score: number } | null = null;
  for (const a of c1) {
    for (const b of c2) {
      for (const hit of intersectCurves(a, b, true, true)) {
        const score = dist(hit.point, near1) + dist(hit.point, near2);
        if (!best || score < best.score) best = { center: hit.point, score };
      }
    }
  }
  return best ? { center: best.center, radius } : null;
}

/** The loci of centers of circles of `r` tangent to an entity's first curve: two parallel lines, or two concentric circles. */
function offsetCandidates(e: Entity, r: number): Curve[] {
  const path = pathOf(e);
  if (!path) return [];
  const c = path.curves[0];
  if (c.kind === "segment") {
    const l = dist(c.a, c.b) || 1;
    const nx = (-(c.b.y - c.a.y) / l) * r;
    const ny = ((c.b.x - c.a.x) / l) * r;
    return [
      { kind: "segment", a: { x: c.a.x + nx, y: c.a.y + ny }, b: { x: c.b.x + nx, y: c.b.y + ny } },
      { kind: "segment", a: { x: c.a.x - nx, y: c.a.y - ny }, b: { x: c.b.x - nx, y: c.b.y - ny } },
    ];
  }
  const out: Curve[] = [{ kind: "arc", center: c.center, radius: c.radius + r, startAngle: 0, endAngle: Math.PI * 2, ccw: true, full: true }];
  if (c.radius - r > 1e-9) out.push({ kind: "arc", center: c.center, radius: c.radius - r, startAngle: 0, endAngle: Math.PI * 2, ccw: true, full: true });
  return out;
}

/** Axis-aligned rectangle about `center` reaching `corner`, as four corners counterclockwise. */
export function rectFromCenter(center: Point, corner: Point): Point[] | null {
  const hw = Math.abs(corner.x - center.x);
  const hh = Math.abs(corner.y - center.y);
  if (hw < 1e-9 || hh < 1e-9) return null;
  return [
    { x: center.x - hw, y: center.y - hh },
    { x: center.x + hw, y: center.y - hh },
    { x: center.x + hw, y: center.y + hh },
    { x: center.x - hw, y: center.y + hh },
  ];
}

/**
 * Rotated rectangle from three points: `a`→`b` is one edge, `c` fixes the
 * width on whichever side it lies. Null when a == b or c is on the line.
 */
export function rectFrom3Points(a: Point, b: Point, c: Point): Point[] | null {
  const l = dist(a, b);
  if (l < 1e-9) return null;
  const ux = (b.x - a.x) / l;
  const uy = (b.y - a.y) / l;
  // Signed distance of c from the edge line, along the left normal.
  const w = -(c.x - a.x) * uy + (c.y - a.y) * ux;
  if (Math.abs(w) < 1e-9) return null;
  const nx = -uy * w;
  const ny = ux * w;
  return [a, b, { x: b.x + nx, y: b.y + ny }, { x: a.x + nx, y: a.y + ny }];
}

/**
 * Regular polygon of `sides` about `center`. `inscribed`: `point` is a
 * vertex (on the circumscribed circle); otherwise `point` is the midpoint
 * of an edge (the polygon is circumscribed about the circle through it) —
 * the two AutoCAD modes, which is what bolt-pattern vs across-flats needs.
 */
export function regularPolygon(center: Point, point: Point, sides: number, inscribed: boolean): Point[] | null {
  const n = Math.round(sides);
  const d = dist(center, point);
  if (n < 3 || n > 1024 || d < 1e-9) return null;
  const step = (Math.PI * 2) / n;
  const angle0 = Math.atan2(point.y - center.y, point.x - center.x);
  const radius = inscribed ? d : d / Math.cos(step / 2);
  const start = inscribed ? angle0 : angle0 - step / 2;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + step * i;
    out.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return out;
}

/** The polygon `a`→`b` is one edge of (counterclockwise from that edge). */
export function regularPolygonByEdge(a: Point, b: Point, sides: number): Point[] | null {
  const n = Math.round(sides);
  const l = dist(a, b);
  if (n < 3 || n > 1024 || l < 1e-9) return null;
  const step = (Math.PI * 2) / n;
  const out: Point[] = [a, b];
  let cur = b;
  let dir = Math.atan2(b.y - a.y, b.x - a.x);
  for (let i = 2; i < n; i++) {
    dir += step;
    cur = { x: cur.x + l * Math.cos(dir), y: cur.y + l * Math.sin(dir) };
    out.push(cur);
  }
  return out;
}

export interface SlotParams {
  points: Point[];
  bulges: number[];
}

/**
 * A straight slot: the stadium of `width` around the segment `a`→`b`, as a
 * closed polyline of two straight legs and two semicircular legs (bulge
 * 1). Null when the centres coincide or the width is not positive.
 */
export function straightSlot(a: Point, b: Point, width: number): SlotParams | null {
  const l = dist(a, b);
  if (l < 1e-9 || width <= 0) return null;
  const r = width / 2;
  const nx = (-(b.y - a.y) / l) * r;
  const ny = ((b.x - a.x) / l) * r;
  return {
    points: [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ],
    // Leg 0 straight (a+→b+), leg 1 the semicircle around b, leg 2 straight back, leg 3 the semicircle around a.
    // Travelling a+→b+ then round b: that turn is clockwise when +n is the left normal, so the bulge is negative.
    bulges: [0, -1, 0, -1],
  };
}

/**
 * An arc slot: `width` around the arc of `radius` about `center` from
 * `startAngle` to `endAngle` (ccw). Four legs: outer arc, end cap, inner
 * arc (back), start cap.
 */
export function arcSlot(center: Point, radius: number, startAngle: number, endAngle: number, width: number): SlotParams | null {
  const r = width / 2;
  if (radius - r <= 1e-9 || width <= 0) return null;
  let sweep = endAngle - startAngle;
  sweep = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (sweep < 1e-9) return null;
  const outer = radius + r;
  const inner = radius - r;
  const at = (rad: number, ang: number) => ({ x: center.x + rad * Math.cos(ang), y: center.y + rad * Math.sin(ang) });
  return {
    points: [at(outer, startAngle), at(outer, endAngle), at(inner, endAngle), at(inner, startAngle)],
    // Outer arc runs ccw (positive bulge for its sweep). Each cap continues
    // that turn — from the outer point round the arc's end to the inner
    // point — so it is ccw too (+1); the inner arc runs back, cw.
    bulges: [Math.tan(sweep / 4), 1, -Math.tan(sweep / 4), 1],
  };
}

/** Rotates a polygon's points about a pivot — a helper the rectangle tool's typed W×H mode uses. */
export function rotatedPoints(points: Point[], pivot: Point, angle: number): Point[] {
  return points.map((p) => rotatePoint(p, pivot, angle));
}
