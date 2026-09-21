import { describe, expect, it } from "vitest";
import type { ArcEntity, CircleEntity, ImageEntity, LineEntity, PolylineEntity } from "./entities";
import { arcPointAt, dist } from "./geometry";
import { applyGrip, gripsOf } from "./grips";

/**
 * Grips are the fastest way to fix a drawing — drag a corner onto where it
 * should be. A grip that moves the wrong end, or resizes a circle when the
 * user meant to move it, is a silent edit to the wrong geometry.
 */

describe("grips", () => {
  it("a line's end grips stretch that end and the midpoint grip moves the whole line", () => {
    const l: LineEntity = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    const g = gripsOf(l);
    expect(g.map((x) => x.kind)).toEqual(["end", "end", "mid"]);
    const stretched = applyGrip(l, g[1], { x: 10, y: 5 }) as LineEntity;
    expect(stretched.a).toEqual({ x: 0, y: 0 });
    expect(stretched.b).toEqual({ x: 10, y: 5 });
    const moved = applyGrip(l, g[2], { x: 5, y: 3 }) as LineEntity;
    expect(moved.a).toEqual({ x: 0, y: 3 });
    expect(moved.b).toEqual({ x: 10, y: 3 });
  });

  it("a circle's quadrant grip sets the radius, its center grip moves it", () => {
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 5 };
    const g = gripsOf(c);
    expect((applyGrip(c, g[1], { x: 8, y: 0 }) as CircleEntity).radius).toBeCloseTo(8, 9);
    expect((applyGrip(c, g[0], { x: 2, y: 2 }) as CircleEntity).center).toEqual({ x: 2, y: 2 });
  });

  it("an arc's end grip changes that end's angle only; the midpoint grip moves the arc", () => {
    const a: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2, ccw: true };
    const g = gripsOf(a);
    const endGrip = g.find((x) => x.kind === "end" && x.index === 1)!;
    const r = applyGrip(a, endGrip, { x: -20, y: 0 }) as ArcEntity;
    expect(r.radius).toBe(5);
    expect(r.endAngle).toBeCloseTo(Math.PI, 9);
    expect(dist(arcPointAt(r.center, r.radius, r.endAngle), { x: -5, y: 0 })).toBeLessThan(1e-9);
    const midGrip = g.find((x) => x.kind === "mid")!;
    const m = applyGrip(a, midGrip, { x: midGrip.point.x + 3, y: midGrip.point.y }) as ArcEntity;
    expect(m.center).toEqual({ x: 3, y: 0 });
  });

  it("a polyline vertex grip moves that vertex alone", () => {
    const p: PolylineEntity = { id: "p", type: "polyline", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true };
    const g = gripsOf(p);
    expect(g).toHaveLength(3);
    const r = applyGrip(p, g[1], { x: 12, y: -1 }) as PolylineEntity;
    expect(r.points[1]).toEqual({ x: 12, y: -1 });
    expect(r.points[0]).toEqual({ x: 0, y: 0 });
  });

  it("an image's far corner resizes it along its own axes, the insert grip moves it", () => {
    const img: ImageEntity = { id: "i", type: "image", insert: { x: 0, y: 0 }, width: 10, height: 5, rotation: 0, dataUrl: "data:," };
    const g = gripsOf(img);
    const r = applyGrip(img, g[2], { x: 20, y: 8 }) as ImageEntity;
    expect(r.width).toBeCloseTo(20, 9);
    expect(r.height).toBeCloseTo(8, 9);
    expect((applyGrip(img, g[0], { x: 1, y: 1 }) as ImageEntity).insert).toEqual({ x: 1, y: 1 });
  });
});
