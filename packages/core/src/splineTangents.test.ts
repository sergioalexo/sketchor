// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import { SketchDocument } from "./document";
import type { SplineEntity } from "./entities";
import { parseDxf } from "./dxf";
import { entitiesToDxf2018 } from "./dxfw";
import { applyGrip, gripsOf } from "./grips";
import { interpolateNurbs, nurbsDomain, nurbsEval, nurbsPointAt } from "./nurbs";
import { addSplinePoint, removeSplinePoint } from "./splineEdit";
import { setSplineShowCvs, splineTransform } from "./spline";
import { diffToCommands, parseCode, toCode } from "./sketchtext";

/**
 * C-07: end-tangent handles and "Show CVs". A fit spline's start/end tangent
 * pins the direction the curve leaves its first and last fit point; the
 * handle must survive every edit and round trip (grip drag, add/remove point,
 * affine map, sketch code, DXF 2018), because a tangent that silently
 * resets on the next edit is worse than not having one.
 */

const PTS = [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: -3 }, { x: 30, y: 5 }];
const fitSpline = (over: Partial<SplineEntity> = {}): SplineEntity => {
  const fitted = interpolateNurbs(PTS, 3, { start: over.startTangent, end: over.endTangent })!;
  return { id: "s", type: "spline", name: "S1", ...fitted, fitPoints: PTS, closed: false, ...over };
};
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("interpolation with end tangents", () => {
  it("passes through every point and leaves/arrives along the handle (derivative = 3 x handle)", () => {
    const fitted = interpolateNurbs(PTS, 3, { start: { x: 0, y: 5 }, end: { x: 4, y: 0 } })!;
    const [lo, hi] = nurbsDomain(fitted);
    const a = nurbsEval(fitted, lo);
    const b = nurbsEval(fitted, hi);
    near(a.tangent.x, 0);
    near(a.tangent.y, 15);
    near(b.tangent.x, 12);
    near(b.tangent.y, 0);
    near(nurbsPointAt(fitted, hi).x, 30);
    near(nurbsPointAt(fitted, hi).y, 5);
    // A middle fit point is still on the curve: the closest sample is within a hair.
    let best = Infinity;
    for (let i = 0; i <= 2000; i++) {
      const p = nurbsPointAt(fitted, lo + ((hi - lo) * i) / 2000);
      best = Math.min(best, Math.hypot(p.x - 10, p.y - 8));
    }
    expect(best).toBeLessThan(0.05);
  });

  it("a single tangent and the two-point Hermite case both solve", () => {
    expect(interpolateNurbs(PTS, 3, { start: { x: 3, y: 3 } })).not.toBeNull();
    const h = interpolateNurbs([{ x: 0, y: 0 }, { x: 10, y: 0 }], 3, { start: { x: 0, y: 4 }, end: { x: 0, y: 4 } })!;
    const [lo, hi] = nurbsDomain(h);
    near(nurbsEval(h, lo).tangent.y, 12);
    near(nurbsPointAt(h, hi).x, 10);
  });

  it("a zero handle is ignored (free end)", () => {
    const free = interpolateNurbs(PTS, 3)!;
    const zero = interpolateNurbs(PTS, 3, { start: { x: 0, y: 0 } })!;
    expect(zero.controlPoints.length).toBe(free.controlPoints.length);
  });
});

describe("tangent grips", () => {
  it("a fit spline offers two tangent handles; dragging one stores the vector and bends the end", () => {
    const e = fitSpline();
    const tangents = gripsOf(e).filter((g) => g.kind === "tangent");
    expect(tangents.map((g) => g.index)).toEqual([0, 1]);
    const moved = applyGrip(e, tangents[0], { x: 0, y: 6 }) as SplineEntity;
    expect(moved.startTangent).toEqual({ x: 0, y: 6 });
    const [lo] = nurbsDomain(moved);
    near(nurbsEval(moved, lo).tangent.y, 18);
    expect(moved.fitPoints).toEqual(PTS);
    const endMoved = applyGrip(e, tangents[1], { x: 26, y: 5 }) as SplineEntity;
    expect(endMoved.endTangent).toEqual({ x: 4, y: 0 });
  });

  it("a spline with no fit points, and a closed one, have no tangent handles", () => {
    const cvOnly = { ...fitSpline(), fitPoints: undefined } as SplineEntity;
    expect(gripsOf(cvOnly).some((g) => g.kind === "tangent")).toBe(false);
    expect(gripsOf(fitSpline({ closed: true })).some((g) => g.kind === "tangent")).toBe(false);
  });

  it("adding or removing a fit point keeps the tangents", () => {
    const e = fitSpline({ startTangent: { x: 0, y: 5 }, endTangent: { x: 4, y: 0 } });
    const added = addSplinePoint(e, { x: 15, y: 3 })!;
    expect(added.startTangent).toEqual({ x: 0, y: 5 });
    expect(added.fitPoints!.length).toBe(5);
    const removed = removeSplinePoint(added, 2)!;
    expect(removed.endTangent).toEqual({ x: 4, y: 0 });
    const [lo] = nurbsDomain(removed);
    near(nurbsEval(removed, lo).tangent.y, 15);
  });

  it("the affine map turns the handles as vectors (translation does not move them)", () => {
    const e = fitSpline({ startTangent: { x: 0, y: 5 } });
    const moved = splineTransform(e, [1, 0, 0, 1, 100, 50])!;
    expect(moved.startTangent).toEqual({ x: 0, y: 5 });
    const turned = splineTransform(e, [0, 1, -1, 0, 0, 0])!; // 90 degrees ccw
    near(turned.startTangent!.x, -5);
    near(turned.startTangent!.y, 0);
  });
});

describe("Show CVs", () => {
  it("adds control-vertex grips to a fit spline; dragging one converts it to a control-point spline", () => {
    const e = fitSpline();
    try {
      setSplineShowCvs(true);
      const cvs = gripsOf(e).filter((g) => g.kind === "cv");
      expect(cvs).toHaveLength(e.controlPoints.length);
      const out = applyGrip(e, cvs[1], { x: 11, y: 30 }) as SplineEntity;
      expect(out.fitPoints).toBeUndefined();
      expect(out.controlPoints[1]).toEqual({ x: 11, y: 30 });
    } finally {
      setSplineShowCvs(false);
    }
    expect(gripsOf(e).some((g) => g.kind === "cv")).toBe(false);
  });
});

describe("round trips", () => {
  it("sketch code carries the tangents and an edit keeps them", () => {
    const doc = new SketchDocument();
    const e = fitSpline({ startTangent: { x: 0, y: 5 }, endTangent: { x: 4, y: 0 } });
    doc._put(e);
    const code = toCode(doc);
    expect(code).toMatch(/start \(0, 5\)/);
    const { entities, errors } = parseCode(code);
    expect(errors).toEqual([]);
    const spline = entities[0];
    if (spline.type !== "spline") throw new Error();
    expect(spline.data.startTangent).toEqual({ x: 0, y: 5 });
    expect(spline.data.endTangent).toEqual({ x: 4, y: 0 });
    expect(diffToCommands(doc, entities)).toEqual([]); // unchanged code is a no-op
    const edited = parseCode(code.replace("start (0, 5)", "start (0, 9)")).entities;
    expect(diffToCommands(doc, edited).length).toBeGreaterThan(0);
  });

  it("DXF 2018 writes group 12/13 and reads them back as handles of the same direction", () => {
    const e = fitSpline({ startTangent: { x: 0, y: 5 }, endTangent: { x: 4, y: 0 } });
    const text = entitiesToDxf2018([e]);
    const back = parseDxf(text).entities.find((x) => x.type === "spline") as SplineEntity;
    expect(back.startTangent!.x / back.startTangent!.y).toBeCloseTo(0, 6);
    expect(back.startTangent!.y).toBeGreaterThan(0);
    expect(back.endTangent!.y).toBeCloseTo(0, 6);
    expect(back.endTangent!.x).toBeGreaterThan(0);
  });
});
