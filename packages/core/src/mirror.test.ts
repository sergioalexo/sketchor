import { describe, expect, it } from "vitest";
import type { ArcEntity, LineEntity, PolylineEntity } from "./entities";
import { arcPointAt, bulgeToArc, dist } from "./geometry";
import { mirrored } from "./mirror";

/**
 * Mirror is how symmetric parts get drawn: draw half, mirror the rest. If
 * an arc's sweep didn't flip, the mirrored half would bulge the wrong way;
 * if bulges kept their sign, a rounded outline would come back with its
 * corners inverted. Both look almost right on screen and are wrong at the
 * cutter.
 */

const yAxis: [{ x: number; y: number }, { x: number; y: number }] = [
  { x: 0, y: 0 },
  { x: 0, y: 1 },
];

describe("mirrored", () => {
  it("reflects a line across a vertical axis and keeps its identity", () => {
    const line: LineEntity = { id: "l", name: "L1", layer: "cut", color: "#f00", type: "line", a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
    const m = mirrored(line, ...yAxis);
    expect(m.a).toEqual({ x: -1, y: 2 });
    expect(m.b).toEqual({ x: -3, y: 4 });
    expect(m.id).toBe("l");
    expect(m.name).toBe("L1");
    expect(m.layer).toBe("cut");
    expect(m.color).toBe("#f00");
  });

  it("reflects across an arbitrary (diagonal) axis", () => {
    const line: LineEntity = { id: "l", type: "line", a: { x: 2, y: 0 }, b: { x: 4, y: 0 } };
    const m = mirrored(line, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(m.a.x).toBeCloseTo(0, 9);
    expect(m.a.y).toBeCloseTo(2, 9);
    expect(m.b.x).toBeCloseTo(0, 9);
    expect(m.b.y).toBeCloseTo(4, 9);
  });

  it("mirrors an arc's end points and flips its sweep so the same curve is traced", () => {
    // Quarter arc from (1,0) ccw to (0,1) about the origin, mirrored across x=0.
    const arc: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2, ccw: true };
    const m = mirrored(arc, ...yAxis);
    const start = arcPointAt(m.center, m.radius, m.startAngle);
    const end = arcPointAt(m.center, m.radius, m.endAngle);
    expect(start.x).toBeCloseTo(-1, 9);
    expect(start.y).toBeCloseTo(0, 9);
    expect(end.x).toBeCloseTo(0, 9);
    expect(end.y).toBeCloseTo(1, 9);
    expect(m.ccw).toBe(false);
  });

  it("negates polyline bulges so arc legs bulge to the mirrored side", () => {
    const pl: PolylineEntity = {
      id: "p",
      type: "polyline",
      points: [
        { x: 1, y: 0 },
        { x: 3, y: 0 },
      ],
      closed: false,
      bulges: [0.5],
    };
    const m = mirrored(pl, ...yAxis);
    expect(m.bulges).toEqual([-0.5]);
    // The mirrored arc leg passes through the mirror image of the original's midpoint.
    const orig = bulgeToArc(pl.points[0], pl.points[1], 0.5)!;
    const mir = bulgeToArc(m.points[0], m.points[1], -0.5)!;
    expect(mir.center.x).toBeCloseTo(-orig.center.x, 9);
    expect(mir.center.y).toBeCloseTo(orig.center.y, 9);
    expect(dist(mir.center, m.points[0])).toBeCloseTo(orig.radius, 9);
  });

  it("moves text by position only, keeping it readable (MIRRTEXT=0)", () => {
    const m = mirrored({ id: "t", type: "text", at: { x: 5, y: 1 }, text: "A", height: 2, rotation: 0.3 }, ...yAxis);
    expect(m.at).toEqual({ x: -5, y: 1 });
    expect(m.rotation).toBe(0.3);
  });

  it("leaves an entity untouched for a degenerate axis", () => {
    const line: LineEntity = { id: "l", type: "line", a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
    expect(mirrored(line, { x: 1, y: 1 }, { x: 1, y: 1 })).toBe(line);
  });
});
