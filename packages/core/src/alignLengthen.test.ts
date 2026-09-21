import { describe, expect, it } from "vitest";
import { alignTransform, applyAlign, lengthen } from "./alignLengthen";
import type { ArcEntity, LineEntity, PolylineEntity } from "./entities";
import { transformed } from "./entities";
import { arcPointAt, arcSweep, dist } from "./geometry";

/**
 * Align is how an imported part gets set onto a reference edge with one
 * command; lengthen is how a stub gets its exact length. Both hand
 * numbers straight to the cutter, so the mapped points must land exactly
 * and the untouched end must not move.
 */

describe("alignTransform", () => {
  it("maps both source points onto the targets when scaling, and the first plus direction when not", () => {
    const s1 = { x: 0, y: 0 };
    const s2 = { x: 10, y: 0 };
    const t1 = { x: 100, y: 50 };
    const t2 = { x: 100, y: 70 };
    const scaled = alignTransform(s1, s2, t1, t2, true)!;
    expect(applyAlign(scaled, s1)).toEqual(t1);
    const p2 = applyAlign(scaled, s2);
    expect(p2.x).toBeCloseTo(100, 9);
    expect(p2.y).toBeCloseTo(70, 9);
    const rigid = alignTransform(s1, s2, t1, t2, false)!;
    const q2 = applyAlign(rigid, s2);
    expect(q2.x).toBeCloseTo(100, 9);
    expect(q2.y).toBeCloseTo(60, 9); // same length 10, along the target direction
    // The same fields drive `transformed` (the transform-entities command).
    const line: LineEntity = { id: "l", type: "line", a: s1, b: s2 };
    const moved = transformed(line, rigid.pivot, rigid.dx, rigid.dy, rigid.rotation, rigid.scale);
    expect(moved.b.x).toBeCloseTo(100, 9);
    expect(moved.b.y).toBeCloseTo(60, 9);
    expect(alignTransform(s1, s1, t1, t2, false)).toBeNull();
  });
});

describe("lengthen", () => {
  const line: LineEntity = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };

  it("moves only the end nearer the click, by delta, to a total, or by percent", () => {
    const d = lengthen(line, { kind: "delta", value: 5 }, { x: 10, y: 0 }) as LineEntity;
    expect(d.a).toEqual({ x: 0, y: 0 });
    expect(d.b.x).toBeCloseTo(15, 9);
    const t = lengthen(line, { kind: "total", value: 4 }, { x: 0, y: 0 }) as LineEntity;
    expect(t.b).toEqual({ x: 10, y: 0 });
    expect(t.a.x).toBeCloseTo(6, 9);
    const p = lengthen(line, { kind: "percent", value: 200 }, { x: 10, y: 0 }) as LineEntity;
    expect(p.b.x).toBeCloseTo(20, 9);
  });

  it("lengthens an arc around its circle, keeping radius and center", () => {
    const arc: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, ccw: true };
    const r = lengthen(arc, { kind: "delta", value: 10 * (Math.PI / 2) }, { x: 0, y: 10 }) as ArcEntity;
    expect(r.type).toBe("arc");
    expect(r.radius).toBeCloseTo(10, 9);
    expect(arcSweep(r.startAngle, r.endAngle, r.ccw)).toBeCloseTo(Math.PI, 9);
    expect(dist(arcPointAt(r.center, r.radius, r.startAngle), { x: 10, y: 0 })).toBeLessThan(1e-9);
  });

  it("refuses to shrink an entity away, or lengthen a closed shape", () => {
    expect(lengthen(line, { kind: "delta", value: -10 }, { x: 10, y: 0 })).toBeNull();
    const closed: PolylineEntity = { id: "p", type: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true };
    expect(lengthen(closed, { kind: "delta", value: 1 }, { x: 0, y: 0 })).toBeNull();
  });
});
