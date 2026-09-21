import { describe, expect, it } from "vitest";
import type { ArcEntity, CircleEntity, Entity, LineEntity, PolylineEntity } from "./entities";
import { arcPointAt, dist } from "./geometry";
import { cutParams, entityFromPath, extendTo, intersectCurves, pathOf, splitAt, trimAt } from "./intersect";

/**
 * Trim, extend, split, fillet and offset all stand on this library. A
 * missed intersection means trim leaves a stub or extend does nothing; a
 * wrong parameter means the wrong piece disappears; a botched re-assembly
 * turns an arc into a polyline or flips a bulge. Every case here is a
 * click a CAD user makes a hundred times a day.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id,
  type: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});
const circle = (id: string, cx: number, cy: number, r: number): CircleEntity => ({ id, type: "circle", center: { x: cx, y: cy }, radius: r });
const arc = (id: string, cx: number, cy: number, r: number, s: number, e: number, ccw = true): ArcEntity => ({
  id,
  type: "arc",
  center: { x: cx, y: cy },
  radius: r,
  startAngle: s,
  endAngle: e,
  ccw,
});
const rect = (id: string, w: number, h: number): PolylineEntity => ({
  id,
  type: "polyline",
  points: [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ],
  closed: true,
});

describe("intersectCurves", () => {
  it("segment × segment: a crossing, an endpoint touch, and parallel lines", () => {
    const a = pathOf(line("a", 0, 0, 10, 0))!.curves[0];
    const b = pathOf(line("b", 5, -5, 5, 5))!.curves[0];
    const hit = intersectCurves(a, b);
    expect(hit).toHaveLength(1);
    expect(hit[0].point).toEqual({ x: 5, y: 0 });
    expect(hit[0].t1).toBeCloseTo(0.5, 12);
    expect(hit[0].t2).toBeCloseTo(0.5, 12);
    // Meeting exactly at an endpoint still counts.
    const c = pathOf(line("c", 10, 0, 10, 8))!.curves[0];
    expect(intersectCurves(a, c)).toHaveLength(1);
    // Parallel: nothing.
    const d = pathOf(line("d", 0, 1, 10, 1))!.curves[0];
    expect(intersectCurves(a, d)).toHaveLength(0);
    // Off the span unless extended.
    const e = pathOf(line("e", 20, -1, 20, 1))!.curves[0];
    expect(intersectCurves(a, e)).toHaveLength(0);
    expect(intersectCurves(a, e, true, false)[0].t1).toBeCloseTo(2, 12);
  });

  it("segment × circle: two crossings, a tangency, a miss", () => {
    const c = pathOf(circle("c", 0, 0, 5))!.curves[0];
    const through = pathOf(line("l", -10, 0, 10, 0))!.curves[0];
    const hits = intersectCurves(through, c);
    expect(hits).toHaveLength(2);
    for (const h of hits) expect(dist(h.point, { x: 0, y: 0 })).toBeCloseTo(5, 9);
    const tangent = pathOf(line("t", -10, 5, 10, 5))!.curves[0];
    const th = intersectCurves(tangent, c);
    expect(th).toHaveLength(1);
    expect(th[0].point.y).toBeCloseTo(5, 6);
    expect(intersectCurves(pathOf(line("m", -10, 6, 10, 6))!.curves[0], c)).toHaveLength(0);
  });

  it("segment × arc respects the arc's sweep", () => {
    // Upper half circle: a horizontal line at y=0 meets it at both ends; at y=-3 not at all.
    const a = pathOf(arc("a", 0, 0, 5, 0, Math.PI))!.curves[0];
    expect(intersectCurves(pathOf(line("l", -10, 3, 10, 3))!.curves[0], a)).toHaveLength(2);
    expect(intersectCurves(pathOf(line("m", -10, -3, 10, -3))!.curves[0], a)).toHaveLength(0);
  });

  it("circle × circle: two points with parameters on each", () => {
    const a = pathOf(circle("a", 0, 0, 5))!.curves[0];
    const b = pathOf(circle("b", 6, 0, 5))!.curves[0];
    const hits = intersectCurves(a, b);
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.point.x).toBeCloseTo(3, 9);
      expect(Math.abs(h.point.y)).toBeCloseTo(4, 9);
      expect(dist(arcPointAt({ x: 0, y: 0 }, 5, h.t1 * 2 * Math.PI), h.point)).toBeLessThan(1e-9);
    }
    expect(intersectCurves(a, pathOf(circle("c", 20, 0, 5))!.curves[0])).toHaveLength(0);
    expect(intersectCurves(a, pathOf(circle("d", 0, 0, 5))!.curves[0])).toHaveLength(0);
  });
});

describe("cutParams", () => {
  it("sorts positions along the path and ignores the target itself", () => {
    const target = line("t", 0, 0, 10, 0);
    const cutters: Entity[] = [line("c2", 7, -1, 7, 1), line("c1", 2, -1, 2, 1), target];
    expect(cutParams(target, cutters)).toEqual([0.2, 0.7]);
  });

  it("uses u = segment index + t on a polyline", () => {
    const r = rect("r", 10, 4);
    const us = cutParams(r, [line("v", 5, -1, 5, 5)]);
    expect(us).toHaveLength(2);
    expect(us[0]).toBeCloseTo(0.5, 12); // bottom edge, half way
    expect(us[1]).toBeCloseTo(2.5, 12); // top edge (runs right→left), half way
  });
});

describe("trimAt", () => {
  it("removes the middle of a line between two cutters, leaving two lines", () => {
    const target = line("t", 0, 0, 10, 0);
    const r = trimAt(target, [line("c1", 2, -1, 2, 1), line("c2", 7, -1, 7, 1)], { x: 5, y: 0.1 })!;
    expect(r.pieces).toHaveLength(2);
    const [a, b] = r.pieces as LineEntity[];
    expect(a.type).toBe("line");
    expect([a.a.x, a.b.x]).toEqual([0, 2]);
    expect([b.a.x, b.b.x]).toEqual([7, 10]);
  });

  it("removes an end piece when there is a cutter on one side only", () => {
    const target = line("t", 0, 0, 10, 0);
    const r = trimAt(target, [line("c", 4, -1, 4, 1)], { x: 8, y: 0 })!;
    expect(r.pieces).toHaveLength(1);
    expect((r.pieces[0] as LineEntity).b.x).toBe(4);
    expect(trimAt(target, [line("far", 20, -1, 20, 1)], { x: 8, y: 0 })).toBeNull();
  });

  it("keeps the inherited layer/colour/construction on the pieces", () => {
    const target: LineEntity = { ...line("t", 0, 0, 10, 0), layer: "cut", color: "#f00", dashed: true };
    const r = trimAt(target, [line("c", 4, -1, 4, 1)], { x: 8, y: 0 })!;
    expect(r.pieces[0]).toMatchObject({ layer: "cut", color: "#f00", dashed: true });
  });

  it("trims a circle to an arc: the piece between two cuts goes, the rest is ONE arc", () => {
    const c = circle("c", 0, 0, 5);
    const r = trimAt(c, [line("l", -10, 0, 10, 0)], { x: 0, y: -5 })!; // click the bottom half
    expect(r.pieces).toHaveLength(1);
    const a = r.pieces[0] as ArcEntity;
    expect(a.type).toBe("arc");
    // What remains passes through the top and not the bottom.
    const top = arcPointAt(a.center, a.radius, Math.PI / 2);
    expect(dist(top, { x: 0, y: 5 })).toBeLessThan(1e-9);
    const angleOf = (p: { x: number; y: number }) => Math.atan2(p.y - a.center.y, p.x - a.center.x);
    const ends = [angleOf(arcPointAt(a.center, a.radius, a.startAngle)), angleOf(arcPointAt(a.center, a.radius, a.endAngle))];
    expect(ends.map((v) => Math.abs(Math.sin(v))).every((s) => s < 1e-9)).toBe(true); // ends on the x axis
    expect(trimAt(c, [], { x: 0, y: 5 })).toBeNull();
  });

  it("opens a closed rectangle: trims the clicked edge piece, remaining is one open polyline", () => {
    const r = rect("r", 10, 4);
    const res = trimAt(r, [line("v1", 3, -1, 3, 1), line("v2", 6, -1, 6, 1)], { x: 4.5, y: 0 })!;
    expect(res.pieces).toHaveLength(1);
    const p = res.pieces[0] as PolylineEntity;
    expect(p.type).toBe("polyline");
    expect(p.closed).toBe(false);
    expect(p.points[0]).toEqual({ x: 6, y: 0 });
    expect(p.points[p.points.length - 1]).toEqual({ x: 3, y: 0 });
    expect(p.points).toHaveLength(6);
  });

  it("an arc leg cut by a line stays an arc leg (bulge kept)", () => {
    const pl: PolylineEntity = {
      id: "p",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      closed: false,
      bulges: [1], // semicircle above the chord
    };
    const res = trimAt(pl, [line("v", 5, -10, 5, 10)], { x: 8, y: 4 })!;
    expect(res.pieces).toHaveLength(1);
    const a = res.pieces[0] as ArcEntity;
    expect(a.type).toBe("arc");
    expect(a.radius).toBeCloseTo(5, 9);
    expect(a.center.x).toBeCloseTo(5, 9);
  });
});

describe("splitAt / extendTo", () => {
  it("splits a line at the clicked point into two", () => {
    const parts = splitAt(line("t", 0, 0, 10, 0), { x: 4, y: 0.2 })!;
    expect(parts).toHaveLength(2);
    expect((parts[0] as LineEntity).b).toEqual({ x: 4, y: 0 });
    expect((parts[1] as LineEntity).a).toEqual({ x: 4, y: 0 });
    expect(splitAt(line("t", 0, 0, 10, 0), { x: 0, y: 0 })).toBeNull();
  });

  it("extends the nearer end of a line to the first boundary ahead", () => {
    const e = extendTo(line("t", 0, 0, 5, 0), [line("b", 8, -1, 8, 1), line("far", 12, -1, 12, 1)], { x: 5, y: 0 }) as LineEntity;
    expect(e.b).toEqual({ x: 8, y: 0 });
    expect(e.a).toEqual({ x: 0, y: 0 });
    // The other end, extending backwards.
    const s = extendTo(line("t", 0, 0, 5, 0), [line("b", -3, -1, -3, 1)], { x: 0, y: 0 }) as LineEntity;
    expect(s.a).toEqual({ x: -3, y: 0 });
    expect(extendTo(line("t", 0, 0, 5, 0), [line("b", 8, 1, 8, 3)], { x: 5, y: 0 })).toBeNull(); // boundary doesn't reach the line
  });

  it("extends an arc around its own circle", () => {
    const quarter = arc("a", 0, 0, 5, 0, Math.PI / 2);
    const e = extendTo(quarter, [line("b", -10, 0, 10, 0)], { x: 0, y: 5 }) as ArcEntity;
    expect(e.type).toBe("arc");
    const end = arcPointAt(e.center, e.radius, e.endAngle);
    expect(end.x).toBeCloseTo(-5, 9);
    expect(end.y).toBeCloseTo(0, 9);
  });
});

describe("entityFromPath", () => {
  it("round-trips a rectangle and a circle through their paths", () => {
    const r = rect("r", 10, 4);
    const back = entityFromPath(pathOf(r)!, r, "x") as PolylineEntity;
    expect(back.type).toBe("polyline");
    expect(back.closed).toBe(true);
    expect(back.points).toEqual(r.points);
    const c = circle("c", 1, 2, 3);
    expect(entityFromPath(pathOf(c)!, c, "y")).toMatchObject({ type: "circle", center: { x: 1, y: 2 }, radius: 3 });
  });
});
