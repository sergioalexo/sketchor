import type { Point } from "./types";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const EPS = 1e-9;

export function bounds(poly: Point[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Shoelace area, always positive. */
export function area(poly: Point[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(a) / 2;
}

/** True if `poly` winds counter-clockwise (positive signed shoelace area). Nothing upstream guarantees a consistent winding on entity-derived polygons, so this is how a caller that needs one (e.g. before a signed offset) finds out. */
export function isCCW(poly: Point[]): boolean {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return a < 0;
}

export function translate(poly: Point[], dx: number, dy: number): Point[] {
  return poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Rotate about the origin by `deg` degrees (CCW). */
export function rotate(poly: Point[], deg: number): Point[] {
  if (deg === 0) return poly.map((p) => ({ ...p }));
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return poly.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
}

/** Moves a polygon so its bounding box's min corner sits at the origin. */
export function normalize(poly: Point[]): Point[] {
  const b = bounds(poly);
  return translate(poly, -b.minX, -b.minY);
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * `pointInPolygon`, but a point exactly on (or within `eps` of) the boundary
 * also counts. Ray-casting alone is an interior-only test — a candidate
 * placement point sitting exactly on an allowed region's edge (touching a
 * hole's wall, or a sheet-fit boundary) is the *normal*, even desirable
 * case in tight nesting, not a rounding error to reject. Use this wherever
 * "is this point somewhere I'm allowed to be" is the question; keep plain
 * `pointInPolygon` where touching a *forbidden* region should still count
 * as outside it (matching `polygonsClash`'s own "touching isn't a clash").
 */
export function pointInOrOnPolygon(p: Point, poly: Point[], eps = 1e-6): boolean {
  if (pointInPolygon(p, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (pointToSegment(p, poly[j], poly[i]) <= eps) return true;
  }
  return false;
}

function onSeg(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= p.x &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

function orient(a: Point, b: Point, c: Point): number {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  return v > EPS ? 1 : v < -EPS ? -1 : 0;
}

/** Any contact, endpoints and collinear overlap included — used for gap distances. */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(a, b, c)) return true;
  if (o2 === 0 && onSeg(a, b, d)) return true;
  if (o3 === 0 && onSeg(c, d, a)) return true;
  if (o4 === 0 && onSeg(c, d, b)) return true;
  return false;
}

/** A crossing at an interior point of *both* segments — touching edges don't count. */
export function properIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

/**
 * True when every vertex of `inner` lies inside (or exactly on) `outer` and
 * no edge of either properly crosses the other — full containment, not
 * just "some point is inside" (which a centroid-only test would wrongly
 * pass for a partial overlap of a concave shape). Boundary-inclusive: a
 * shape whose edge exactly touches its container's edge (a part placed
 * flush against a hole's wall) is still fully contained, not rejected by
 * ray-casting's usual interior-only reading of "inside".
 */
export function polygonContainsPolygon(outer: Point[], inner: Point[]): boolean {
  for (const p of inner) {
    if (!pointInOrOnPolygon(p, outer)) return false;
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

/** Vertex average — inside any convex polygon and most sane laser parts. */
export function centroid(poly: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/** Shortest distance between two segments. */
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointToSegment(a, c, d),
    pointToSegment(b, c, d),
    pointToSegment(c, a, b),
    pointToSegment(d, a, b),
  );
}

export function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * True if two polygons overlap, or (when `gap > 0`) come within `gap` of each
 * other. Edge-to-edge contact at `gap === 0` is *not* a clash, so tightly
 * abutting parts are allowed.
 */
export function polygonsClash(a: Point[], b: Point[], gap = 0): boolean {
  const ba = bounds(a);
  const bb = bounds(b);
  if (ba.maxX + gap < bb.minX || bb.maxX + gap < ba.minX) return false;
  if (ba.maxY + gap < bb.minY || bb.maxY + gap < ba.minY) return false;

  // One polygon inside (or coincident with) the other.
  if (pointInPolygon(centroid(a), b) || pointInPolygon(centroid(b), a)) return true;

  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];
      if (gap > 0 ? segmentDistance(a1, a2, b1, b2) < gap - EPS : properIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }
  return false;
}

/** True if the whole polygon lies inside [inset, w-inset] × [inset, h-inset]. */
export function insideSheet(poly: Point[], w: number, h: number, inset = 0): boolean {
  const b = bounds(poly);
  return b.minX >= inset - EPS && b.minY >= inset - EPS && b.maxX <= w - inset + EPS && b.maxY <= h - inset + EPS;
}
