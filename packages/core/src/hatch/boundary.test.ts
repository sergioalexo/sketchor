/**
 * Why this matters: clicking inside a drawing to hatch is the way hatches get
 * made. Picking the wrong region (a bigger one, or one that ignores an island),
 * failing on a T-junction, or turning a circle into 140 line edges silently
 * ruins the hatch and every export of it, so detection is pinned against the
 * cases drafters actually draw.
 */
import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import type { CircleEntity, Entity, LineEntity, PolylineEntity } from "../entities";
import { boundaryFromObjects, detectBoundary, fillToHatch } from "./boundary";
import { loopPolygon, polygonArea } from "./loops";

let n = 0;
const line = (ax: number, ay: number, bx: number, by: number): LineEntity => ({ id: `l${n++}`, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });
const circle = (x: number, y: number, r: number): CircleEntity => ({ id: `c${n++}`, type: "circle", center: { x, y }, radius: r });
const rect = (x: number, y: number, w: number, h: number): LineEntity[] => [
  line(x, y, x + w, y),
  line(x + w, y, x + w, y + h),
  line(x + w, y + h, x, y + h),
  line(x, y + h, x, y),
];
const area = (loop: { edges: never[] } | Parameters<typeof loopPolygon>[0]): number => Math.abs(polygonArea(loopPolygon(loop as Parameters<typeof loopPolygon>[0], 0.001)));

describe("detectBoundary", () => {
  it("finds the loop of four lines around the click, with exact line edges and the sources", () => {
    const es = rect(0, 0, 10, 6);
    const r = detectBoundary(es, { x: 5, y: 3 })!;
    expect(r.loops).toHaveLength(1);
    expect(r.loops[0].edges.every((e) => e.type === "line")).toBe(true);
    expect(r.loops[0].edges).toHaveLength(4);
    expect(area(r.loops[0])).toBeCloseTo(60, 6);
    expect(new Set(r.sources)).toEqual(new Set(es.map((e) => e.id)));
  });

  it("returns null outside any closed region, for an open figure and for an empty drawing", () => {
    expect(detectBoundary(rect(0, 0, 10, 6), { x: 50, y: 3 })).toBeNull();
    expect(detectBoundary([line(0, 0, 10, 0), line(10, 0, 10, 6), line(10, 6, 0, 6)], { x: 5, y: 3 })).toBeNull();
    expect(detectBoundary([], { x: 0, y: 0 })).toBeNull();
  });

  it("handles a T-junction and a crossing: a rectangle cut by a diagonal gives two triangles", () => {
    const es = [...rect(0, 0, 10, 10), line(0, 0, 10, 10)];
    const lower = detectBoundary(es, { x: 8, y: 2 })!;
    expect(area(lower.loops[0])).toBeCloseTo(50, 6);
    const upper = detectBoundary(es, { x: 2, y: 8 })!;
    expect(area(upper.loops[0])).toBeCloseTo(50, 6);
    // a line that ends on a side (T-junction) splits it too
    const t = detectBoundary([...rect(0, 0, 10, 10), line(5, 0, 5, 10)], { x: 2, y: 5 })!;
    expect(area(t.loops[0])).toBeCloseTo(50, 6);
  });

  it("picks the smallest enclosing region and reports islands (a circle inside a rectangle)", () => {
    const es: Entity[] = [...rect(0, 0, 20, 20), circle(10, 10, 4)];
    const ring = detectBoundary(es, { x: 1, y: 1 })!;
    expect(ring.loops).toHaveLength(2);
    expect(ring.loops[0].outer).toBe(true);
    // the island is the exact circle, not a chain of short lines
    expect(ring.loops[1].edges).toHaveLength(1);
    expect(ring.loops[1].edges[0]).toMatchObject({ type: "arc", center: { x: 10, y: 10 }, radius: 4 });
    expect(area(ring.loops[0]) - area(ring.loops[1])).toBeCloseTo(400 - Math.PI * 16, 0);
    const inside = detectBoundary(es, { x: 10, y: 10 })!;
    expect(inside.loops).toHaveLength(1);
    expect(inside.loops[0].edges[0]).toMatchObject({ type: "arc", radius: 4 });
  });

  it("nested rectangles: the ring between them has the inner one as an island", () => {
    const es = [...rect(0, 0, 30, 30), ...rect(5, 5, 20, 20)];
    expect(detectBoundary(es, { x: 2, y: 2 })!.loops).toHaveLength(2);
    expect(detectBoundary(es, { x: 15, y: 15 })!.loops).toHaveLength(1);
  });

  it("closes a gap up to the tolerance and not beyond it", () => {
    const es = [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0.6)];
    expect(detectBoundary(es, { x: 5, y: 5 })).toBeNull();
    expect(detectBoundary(es, { x: 5, y: 5 }, { gapTol: 0.3 })).toBeNull();
    const closed = detectBoundary(es, { x: 5, y: 5 }, { gapTol: 1 })!;
    expect(area(closed.loops[0])).toBeCloseTo(100, 6);
    expect(closed.sources).not.toContain(undefined);
  });

  it("ignores a dangling spur inside the region", () => {
    const es = [...rect(0, 0, 10, 10), line(5, 5, 8, 5), line(0, 5, 3, 5)];
    const r = detectBoundary(es, { x: 5, y: 8 })!;
    expect(area(r.loops[0])).toBeCloseTo(100, 6);
    expect(r.loops).toHaveLength(1);
  });

  it("a closed polyline with a bulge keeps its arc edge", () => {
    const pl: PolylineEntity = { id: "pl", type: "polyline", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], bulges: [0, 0.5, 0, 0], closed: true };
    const r = detectBoundary([pl], { x: 3, y: 5 })!;
    expect(r.loops[0].edges.map((e) => e.type).sort()).toEqual(["arc", "line", "line", "line"]);
    expect(r.sources).toEqual(["pl"]);
  });

  it("a circle cut by a chord: the cap is a partial arc plus a line, with the right area", () => {
    const es: Entity[] = [circle(0, 0, 10), line(-20, 6, 20, 6)];
    const cap = detectBoundary(es, { x: 0, y: 8 })!;
    const types = cap.loops[0].edges.map((e) => e.type).sort();
    expect(types).toEqual(["arc", "line"]);
    const arc = cap.loops[0].edges.find((e) => e.type === "arc")!;
    expect(arc).toMatchObject({ radius: 10, center: { x: 0, y: 0 } });
    // circular segment above y = 6: r^2 acos(d/r) - d sqrt(r^2 - d^2)
    expect(area(cap.loops[0])).toBeCloseTo(100 * Math.acos(0.6) - 6 * 8, 1);
  });

  it("ignores construction geometry, text and existing hatches when looking for a boundary", () => {
    const wall: LineEntity = { ...line(0, 0, 10, 0), construction: true };
    expect(detectBoundary([wall, line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0)], { x: 5, y: 5 })).toBeNull();
  });

  it("degenerate input does not throw: zero-length lines, duplicates and coincident overlaps", () => {
    const es = [...rect(0, 0, 10, 10), line(5, 5, 5, 5), ...rect(0, 0, 10, 10), line(0, 0, 5, 0)];
    expect(area(detectBoundary(es, { x: 5, y: 5 })!.loops[0])).toBeCloseTo(100, 6);
  });
});

describe("boundaryFromObjects", () => {
  it("takes the outer boundary of every closed group and nothing from open ones", () => {
    const r = boundaryFromObjects([...rect(0, 0, 10, 10), ...rect(20, 0, 5, 5), line(40, 0, 50, 0)])!;
    expect(r.loops).toHaveLength(2);
    expect(area(r.loops[0])).toBeCloseTo(100, 6);
    expect(area(r.loops[1])).toBeCloseTo(25, 6);
    expect(boundaryFromObjects([line(0, 0, 1, 0), line(1, 0, 2, 3)])).toBeNull();
  });

  it("a lone circle becomes one exact arc loop", () => {
    const r = boundaryFromObjects([circle(3, 4, 5)])!;
    expect(r.loops[0].edges).toHaveLength(1);
    expect(r.loops[0].edges[0]).toMatchObject({ type: "arc", radius: 5 });
  });
});

describe("fillToHatch", () => {
  it("turns a filled circle into a solid hatch on the same layer, and ignores unfilled shapes", () => {
    const c: CircleEntity = { ...circle(0, 0, 5), fill: "#ff0000", layer: "walls" };
    const h = fillToHatch(c, "newid")!;
    expect(h).toMatchObject({ id: "newid", type: "hatch", layer: "walls", paint: { kind: "solid", color: "#ff0000" }, style: "normal" });
    expect(fillToHatch(circle(0, 0, 5), "x")).toBeNull();
    expect(fillToHatch(line(0, 0, 1, 1), "x")).toBeNull();
  });
});
