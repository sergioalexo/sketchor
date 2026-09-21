import { describe, expect, it } from "vitest";
import type { ArcEntity, CircleEntity, LineEntity, PolylineEntity } from "./entities";
import { polylineSegments } from "./entities";
import { bulgeToArc, distToSegment } from "./geometry";
import { offsetEntity } from "./offset";

/**
 * Offset draws the inside of a plate from its outline, the second wall of
 * a channel, the clearance around a cut-out. The classic failures: the
 * copy lands on the wrong side, an inner offset of a polyline grows loops
 * where short edges invert, corners come out open instead of meeting.
 */

const line = (ax: number, ay: number, bx: number, by: number): LineEntity => ({ id: "l", type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const rect = (w: number, h: number): PolylineEntity => ({
  id: "r",
  type: "polyline",
  points: [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ],
  closed: true,
});

describe("offsetEntity", () => {
  it("shifts a line to the clicked side", () => {
    const up = offsetEntity(line(0, 0, 10, 0), 2, { x: 5, y: 3 }) as LineEntity;
    expect(up.a).toEqual({ x: 0, y: 2 });
    expect(up.b).toEqual({ x: 10, y: 2 });
    const down = offsetEntity(line(0, 0, 10, 0), 2, { x: 5, y: -3 }) as LineEntity;
    expect(down.a.y).toBe(-2);
  });

  it("makes a circle concentric, outward or inward, and refuses to collapse it", () => {
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 5 };
    expect((offsetEntity(c, 2, { x: 9, y: 0 }) as CircleEntity).radius).toBeCloseTo(7, 9);
    expect((offsetEntity(c, 2, { x: 1, y: 0 }) as CircleEntity).radius).toBeCloseTo(3, 9);
    expect(offsetEntity(c, 6, { x: 1, y: 0 })).toBeNull();
  });

  it("offsets an arc concentrically with the same sweep", () => {
    const a: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2, ccw: true };
    const out = offsetEntity(a, 1, { x: 10, y: 10 }) as ArcEntity;
    expect(out.type).toBe("arc");
    expect(out.radius).toBeCloseTo(6, 9);
    expect(out.startAngle).toBeCloseTo(0, 9);
    expect(out.endAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  it("offsets a rectangle outward to a bigger closed rectangle with met corners", () => {
    const out = offsetEntity(rect(10, 4), 1, { x: 5, y: -3 }) as PolylineEntity;
    expect(out.type).toBe("polyline");
    expect(out.closed).toBe(true);
    expect(out.points).toHaveLength(4);
    const xs = out.points.map((p) => p.x).sort((a, b) => a - b);
    const ys = out.points.map((p) => p.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-1, 9);
    expect(xs[3]).toBeCloseTo(11, 9);
    expect(ys[0]).toBeCloseTo(-1, 9);
    expect(ys[3]).toBeCloseTo(5, 9);
  });

  it("offsets a rectangle inward to a smaller one", () => {
    const out = offsetEntity(rect(10, 4), 1, { x: 5, y: 1 }) as PolylineEntity;
    expect(out.points).toHaveLength(4);
    const xs = out.points.map((p) => p.x).sort((a, b) => a - b);
    const ys = out.points.map((p) => p.y).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(1, 9);
    expect(xs[3]).toBeCloseTo(9, 9);
    expect(ys[0]).toBeCloseTo(1, 9);
    expect(ys[3]).toBeCloseTo(3, 9);
  });

  const notched: PolylineEntity = {
    id: "n",
    type: "polyline",
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 3 },
      { x: 5, y: 3 },
      { x: 5, y: 4 },
      { x: 0, y: 4 },
    ],
    closed: true,
  };

  it("an inner offset widens a notch and stays clear of every original edge", () => {
    // A 10×4 plate with a 1-wide, 1-deep notch in the top edge, offset 1.5 inward.
    const out = offsetEntity(notched, 1.5, { x: 2, y: 2 }) as PolylineEntity;
    expect(out).not.toBeNull();
    for (const p of out.points) {
      for (const seg of polylineSegments(notched)) {
        expect(distToSegment(p, seg.a, seg.b)).toBeGreaterThanOrEqual(1.5 - 1e-6);
      }
    }
    // The notch is now 4 wide and reaches down to y = 1.5.
    expect(out.points.some((p) => Math.abs(p.x - 3.5) < 1e-9 && Math.abs(p.y - 1.5) < 1e-9)).toBe(true);
    expect(out.points.some((p) => Math.abs(p.x - 7.5) < 1e-9 && Math.abs(p.y - 1.5) < 1e-9)).toBe(true);
  });

  it("an outer offset swallows a notch narrower than the distance: the walls and the inverted bottom go", () => {
    const out = offsetEntity(notched, 1.5, { x: 5, y: -3 }) as PolylineEntity;
    expect(out).not.toBeNull();
    expect(out.closed).toBe(true);
    // A plain 13 × 7 rectangle: four corners, nothing left of the notch.
    expect(out.points).toHaveLength(4);
    const ys = out.points.map((p) => p.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-1.5, 9);
    expect(ys[3]).toBeCloseTo(5.5, 9);
  });

  it("keeps arc legs as arcs and closes the outside corner between two arcs with a round join", () => {
    // A stadium: two straight legs joined by semicircles (bulge 1).
    const stadium: PolylineEntity = {
      id: "s",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 4 },
        { x: 0, y: 4 },
      ],
      closed: true,
      bulges: [0, 1, 0, 1],
    };
    const out = offsetEntity(stadium, 1, { x: 5, y: -3 }) as PolylineEntity;
    expect(out.type).toBe("polyline");
    expect(out.closed).toBe(true);
    const arcs = polylineSegments(out).map((s) => bulgeToArc(s.a, s.b, s.bulge)).filter((a): a is NonNullable<typeof a> => !!a);
    expect(arcs).toHaveLength(2);
    for (const a of arcs) expect(a.radius).toBeCloseTo(3, 9);
    // Straight legs moved out by 1.
    const straight = polylineSegments(out).filter((s) => s.bulge === 0);
    expect(straight.some((s) => Math.abs(s.a.y + 1) < 1e-9 && Math.abs(s.b.y + 1) < 1e-9)).toBe(true);
  });

  it("returns null for entities without a stroke and for a zero distance", () => {
    expect(offsetEntity({ id: "t", type: "text", at: { x: 0, y: 0 }, text: "x", height: 1, rotation: 0 }, 1, { x: 0, y: 0 })).toBeNull();
    expect(offsetEntity(line(0, 0, 1, 0), 0, { x: 0, y: 1 })).toBeNull();
  });
});

