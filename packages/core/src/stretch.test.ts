import { describe, expect, it } from "vitest";
import type { ArcEntity, CircleEntity, LineEntity, PolylineEntity } from "./entities";
import { arcPointAt, dist } from "./geometry";
import { stretchEntities, stretchEntity } from "./stretch";

/**
 * Stretch moves only what the crossing box catches. Move the wrong end
 * and the bracket gets shorter instead of longer; move a whole line that
 * was only half inside and the joint it shared tears open.
 */

const box = { minX: 8, minY: -5, maxX: 15, maxY: 5 };

describe("stretchEntity", () => {
  it("moves the line end inside the box and leaves the other", () => {
    const l: LineEntity = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    const r = stretchEntity(l, box, 20, 0) as LineEntity;
    expect(r.a).toEqual({ x: 0, y: 0 });
    expect(r.b).toEqual({ x: 30, y: 0 });
    expect(stretchEntity({ ...l, b: { x: 5, y: 0 } }, box, 20, 0)).toBeNull();
  });

  it("moves only the polyline vertices inside; a bracket outline gets longer, not moved", () => {
    const bracket: PolylineEntity = {
      id: "p",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 3 },
        { x: 0, y: 3 },
      ],
      closed: true,
    };
    const r = stretchEntity(bracket, box, 20, 0) as PolylineEntity;
    expect(r.points).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 3 },
      { x: 0, y: 3 },
    ]);
  });

  it("a circle moves whole with its center; an arc with one end inside keeps its radius", () => {
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 10, y: 0 }, radius: 2 };
    expect((stretchEntity(c, box, 5, 5) as CircleEntity).center).toEqual({ x: 15, y: 5 });
    // Quarter arc from (10,0) round to (0,10) about the origin, r=10; move the (10,0) end to (12,0).
    const a: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, ccw: true };
    const r = stretchEntity(a, box, 2, 0) as ArcEntity;
    expect(r.radius).toBeCloseTo(10, 9);
    expect(dist(arcPointAt(r.center, r.radius, r.startAngle), { x: 12, y: 0 })).toBeLessThan(1e-9);
    expect(dist(arcPointAt(r.center, r.radius, r.endAngle), { x: 0, y: 10 })).toBeLessThan(1e-9);
  });

  it("stretchEntities returns only the touched entities", () => {
    const far: LineEntity = { id: "f", type: "line", a: { x: 100, y: 100 }, b: { x: 110, y: 100 } };
    const near: LineEntity = { id: "n", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    expect(stretchEntities([far, near], box, 1, 0).map((e) => e.id)).toEqual(["n"]);
  });
});
