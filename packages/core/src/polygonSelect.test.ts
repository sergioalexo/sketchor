import { describe, expect, it } from "vitest";
import type { Entity } from "./entities";
import {
  entitiesCrossedByFence,
  entitiesInPolygon,
  entityCrossedByFence,
  entityInPolygon,
  outlineOf,
  simplifyPath,
} from "./polygonSelect";

/**
 * Lasso and fence selection. These decide what a user's drag *took*, and a
 * wrong answer is expensive in both directions: silently including a line
 * that was outside the loop means it moves or vanishes with the rest, and
 * missing one the loop clearly enclosed means the edit has to be redone.
 * Window-vs-crossing is the rule people rely on without thinking about it —
 * enclose it fully to take it, touch it to take it — so both are pinned
 * here for every entity type, curves included.
 */

const square = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

const line = (ax: number, ay: number, bx: number, by: number): Entity => ({
  id: `l${ax},${ay},${bx},${by}`,
  type: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
});

const circle = (cx: number, cy: number, r: number): Entity => ({
  id: `c${cx},${cy},${r}`,
  type: "circle",
  center: { x: cx, y: cy },
  radius: r,
});

// A generous lasso around the origin: (0,0) to (100,100).
const lasso = square(0, 0, 100);

describe("lasso selection", () => {
  it("window takes only what is entirely inside", () => {
    expect(entityInPolygon(line(10, 10, 90, 90), lasso, "window")).toBe(true);
    expect(entityInPolygon(line(10, 10, 190, 90), lasso, "window")).toBe(false);
    expect(entityInPolygon(line(150, 10, 190, 90), lasso, "window")).toBe(false);
  });

  it("crossing also takes what it merely touches", () => {
    expect(entityInPolygon(line(10, 10, 190, 90), lasso, "crossing")).toBe(true);
    expect(entityInPolygon(line(150, 10, 190, 90), lasso, "crossing")).toBe(false);
  });

  it("catches a line that cuts clean across with neither end inside", () => {
    // Enters the left edge and leaves the right: no endpoint is inside, so
    // only the segment-crossing pass can find it.
    expect(entityInPolygon(line(-50, 50, 150, 50), lasso, "crossing")).toBe(true);
    expect(entityInPolygon(line(-50, 50, 150, 50), lasso, "window")).toBe(false);
  });

  it("treats a circle by its curve, not its bounding box", () => {
    // Centred on the lasso's corner: the box would overlap either way, but
    // only this one actually reaches inside.
    expect(entityInPolygon(circle(0, 0, 40), lasso, "crossing")).toBe(true);
    expect(entityInPolygon(circle(50, 50, 30), lasso, "window")).toBe(true);
    expect(entityInPolygon(circle(50, 50, 80), lasso, "window")).toBe(false);
    // A big circle drawn *around* the whole lasso touches nothing inside it.
    expect(entityInPolygon(circle(50, 50, 500), lasso, "crossing")).toBe(false);
  });

  it("handles concave lassos, which is the point of drawing one", () => {
    // A C-shape: the notch between the arms is outside the polygon.
    const c = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 20 },
      { x: 20, y: 20 },
      { x: 20, y: 80 },
      { x: 100, y: 80 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(entityInPolygon(line(5, 40, 15, 60), c, "window")).toBe(true);
    expect(entityInPolygon(line(50, 40, 60, 60), c, "window")).toBe(false);
    expect(entityInPolygon(line(50, 40, 60, 60), c, "crossing")).toBe(false);
  });

  it("selects points, text and images by their outline", () => {
    const point: Entity = { id: "p", type: "point", p: { x: 50, y: 50 } };
    const text: Entity = { id: "t", type: "text", at: { x: 40, y: 40 }, text: "hi", height: 10, rotation: 0 };
    expect(entityInPolygon(point, lasso, "window")).toBe(true);
    expect(entityInPolygon({ ...point, p: { x: 500, y: 50 } }, lasso, "crossing")).toBe(false);
    expect(entityInPolygon(text, lasso, "window")).toBe(true);
  });

  it("refuses a degenerate polygon rather than guessing", () => {
    expect(entityInPolygon(line(10, 10, 20, 20), [{ x: 0, y: 0 }, { x: 10, y: 0 }], "crossing")).toBe(false);
  });

  it("returns ids, in document order", () => {
    const entities = [line(10, 10, 20, 20), line(500, 500, 600, 600), circle(50, 50, 10)];
    expect(entitiesInPolygon(entities, lasso, "window")).toEqual([entities[0].id, entities[2].id]);
  });
});

describe("fence selection", () => {
  // Three vertical lines; a horizontal fence stroke across the first two.
  const rungs = [line(10, 0, 10, 100), line(20, 0, 20, 100), line(30, 0, 30, 100)];
  const fence = [
    { x: 5, y: 50 },
    { x: 25, y: 50 },
  ];

  it("takes what the stroke crosses and nothing else", () => {
    expect(entitiesCrossedByFence(rungs, fence)).toEqual([rungs[0].id, rungs[1].id]);
  });

  it("ignores enclosure — a fence has to actually cut across", () => {
    const around = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    // The path surrounds nothing it doesn't touch: a line well inside the
    // corner it forms is not crossed by it.
    expect(entityCrossedByFence(line(40, 40, 50, 50), around)).toBe(false);
  });

  it("can't cross a point entity, only enclose it", () => {
    const point: Entity = { id: "p", type: "point", p: { x: 15, y: 50 } };
    expect(entityCrossedByFence(point, fence)).toBe(false);
  });

  it("crosses curves too", () => {
    // The stroke meets this one exactly at the sampled vertex on its
    // horizontal diameter — the touching case, which still counts.
    expect(entityCrossedByFence(circle(10, 50, 3), fence)).toBe(true);
    expect(entityCrossedByFence(circle(24, 50, 3), fence)).toBe(true);
    // Fence entirely inside the circle: it never reaches the curve.
    expect(entityCrossedByFence(circle(15, 50, 300), fence)).toBe(false);
  });

  it("needs two points to be a stroke at all", () => {
    expect(entityCrossedByFence(rungs[0], [{ x: 5, y: 50 }])).toBe(false);
  });
});

describe("outlineOf", () => {
  it("walks a bulged polyline as a curve, not as chords", () => {
    const pill: Entity = {
      id: "pl",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      bulges: [1, 1],
      closed: true,
    };
    const out = outlineOf(pill);
    expect(out.closed).toBe(true);
    // Two half-circle legs, sampled: far more points than the two vertices,
    // and they bow away from the straight chord between them.
    expect(out.points.length).toBeGreaterThan(20);
    expect(Math.max(...out.points.map((p) => Math.abs(p.y)))).toBeCloseTo(50, 1);
  });

  it("keeps an open polyline's last point", () => {
    const open: Entity = {
      id: "pl2",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      closed: false,
    };
    const out = outlineOf(open);
    expect(out.closed).toBe(false);
    expect(out.points).toEqual(open.type === "polyline" ? open.points : []);
  });
});

describe("simplifyPath", () => {
  it("drops the points that sit on the line between their neighbours", () => {
    const straight = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplifyPath(straight, 0.5)).toEqual([{ x: 0, y: 0 }, { x: 49, y: 0 }]);
  });

  it("keeps the corners that make the shape", () => {
    const l = [...Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0 })), ...Array.from({ length: 20 }, (_, i) => ({ x: 19, y: i }))];
    const out = simplifyPath(l, 0.5);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ x: 19, y: 0 });
  });

  it("leaves a path too short to thin alone", () => {
    expect(simplifyPath([{ x: 0, y: 0 }, { x: 1, y: 1 }], 10)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it("never drops the ends, however loose the tolerance", () => {
    const wobble = Array.from({ length: 30 }, (_, i) => ({ x: i, y: Math.sin(i) }));
    const out = simplifyPath(wobble, 1000);
    expect(out).toEqual([wobble[0], wobble[29]]);
  });
});
