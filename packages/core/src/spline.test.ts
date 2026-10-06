// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import { SketchDocument } from "./document";
import type { SplineEntity } from "./entities";
import { rotated, transformed, translated } from "./entities";
import { boundsOf, parseDxf } from "./dxf";
import { entitiesToDxf2018 } from "./dxfw";
import { applyGrip, gripsOf } from "./grips";
import { getKind, kindHitDistance } from "./kinds/registry";
import { circleNurbs, clampedUniformKnots, distToNurbs, interpolateNurbs, nurbsDomain, nurbsPointAt } from "./nurbs";
import { diffToCommands, parseCode, toCode } from "./sketchtext";
import { entitiesToSvgDocument, parseSvgText } from "./svg";

/**
 * A spline is the one entity whose data (control points, knots, weights, fit
 * points) isn't its shape, so every consumer that rebuilds an entity from
 * pieces can lose it silently. These tests pin that the data survives each
 * round trip — sketch code, DXF 2018, SVG, document JSON, affine maps — and
 * that fit-point editing really re-solves the curve.
 */

const cv = (over: Partial<SplineEntity> = {}): SplineEntity => ({
  id: "s",
  type: "spline",
  degree: 3,
  controlPoints: [
    { x: 0, y: 0 },
    { x: 10, y: 30 },
    { x: 30, y: -20 },
    { x: 50, y: 10 },
    { x: 70, y: 0 },
  ],
  knots: clampedUniformKnots(5, 3),
  closed: false,
  ...over,
});

const fitSpline = (): SplineEntity => {
  const fit = [
    { x: 0, y: 0 },
    { x: 10, y: 8 },
    { x: 25, y: 3 },
    { x: 40, y: -6 },
    { x: 55, y: 4 },
  ];
  return { id: "f", type: "spline", name: "S2", ...interpolateNurbs(fit)!, fitPoints: fit, closed: false };
};

const sample = (e: SplineEntity, n = 30) => {
  const [lo, hi] = nurbsDomain(e);
  return Array.from({ length: n + 1 }, (_, i) => nurbsPointAt(e, lo + ((hi - lo) * i) / n));
};

const sameCurve = (a: SplineEntity, b: SplineEntity, digits = 6) => {
  const pa = sample(a);
  const pb = sample(b);
  pa.forEach((p, i) => {
    expect(p.x).toBeCloseTo(pb[i].x, digits);
    expect(p.y).toBeCloseTo(pb[i].y, digits);
  });
};

const docWith = (...es: SplineEntity[]) => {
  const d = new SketchDocument();
  for (const e of es) d._put(e);
  return d;
};

describe("spline kind", () => {
  it("affine maps move the curve exactly (control points mapped, weights and knots kept)", () => {
    const e = cv({ name: "S1", layer: "L", color: "#0f0" });
    const m: [number, number, number, number, number, number] = [0.5, 0.2, -0.3, 1.5, 7, -4];
    const out = getKind("spline")!.transform!(e, m) as SplineEntity;
    expect(out).toMatchObject({ id: "s", name: "S1", layer: "L", color: "#0f0", degree: 3 });
    expect(out.knots).toEqual(e.knots);
    sample(e).forEach((p, i) => {
      const q = sample(out)[i];
      expect(q.x).toBeCloseTo(m[0] * p.x + m[2] * p.y + m[4], 9);
      expect(q.y).toBeCloseTo(m[1] * p.x + m[3] * p.y + m[5], 9);
    });
    expect(getKind("spline")!.transform!(e, [1, 0, 2, 0, 0, 0])).toBeNull();
  });

  it("translate / rotate / scale helpers keep a rational spline exactly rational", () => {
    const c = circleNurbs({ x: 0, y: 0 }, 3);
    const e: SplineEntity = { id: "c", type: "spline", ...c, closed: true };
    const moved = transformed(e, { x: 0, y: 0 }, 5, 6, Math.PI / 3, 2);
    for (const p of sample(moved, 100)) expect(Math.hypot(p.x - 5, p.y - 6)).toBeCloseTo(6, 9);
    expect(translated(e, 1, 1).weights).toEqual(e.weights);
    expect(rotated(e, { x: 0, y: 0 }, 1).knots).toEqual(e.knots);
  });

  it("bounds, hit test and snaps", () => {
    const e = cv();
    const b = boundsOf([e])!;
    for (const p of sample(e, 400)) {
      expect(p.y).toBeGreaterThanOrEqual(b.minY - 1e-6);
      expect(p.y).toBeLessThanOrEqual(b.maxY + 1e-6);
    }
    expect(kindHitDistance(e, nurbsPointAt(e, 1.2))).toBeLessThan(1e-6);
    expect(kindHitDistance(e, { x: 35, y: 200 })).toBeGreaterThan(100);
    const snaps = getKind("spline")!.snaps!(fitSpline());
    expect(snaps.filter((s) => s.kind === "endpoint")).toHaveLength(2);
    expect(snaps.filter((s) => s.kind === "node")).toHaveLength(5);
  });

  it("control-point grips move one control point and drop nothing else", () => {
    const e = cv();
    const grips = gripsOf(e);
    expect(grips).toHaveLength(5);
    const moved = applyGrip(e, grips[2], { x: 30, y: 40 }) as SplineEntity;
    expect(moved.controlPoints[2]).toEqual({ x: 30, y: 40 });
    expect(moved.controlPoints[1]).toEqual(e.controlPoints[1]);
    expect(moved.knots).toEqual(e.knots);
  });

  it("fit-point grips re-solve the curve: it passes through the moved point and the others", () => {
    const e = fitSpline();
    const grips = gripsOf(e);
    expect(grips).toHaveLength(5);
    expect(grips[0].point).toEqual({ x: 0, y: 0 });
    const moved = applyGrip(e, grips[2], { x: 25, y: 20 }) as SplineEntity;
    expect(moved.fitPoints![2]).toEqual({ x: 25, y: 20 });
    for (const p of moved.fitPoints!) expect(distToNurbs(moved, p)).toBeLessThan(1e-6);
    expect(moved.controlPoints.length).toBe(e.controlPoints.length);
  });

  it("dragging one fit point onto its neighbour is ignored instead of corrupting the curve", () => {
    const e: SplineEntity = (() => {
      const fit = [{ x: 0, y: 0 }, { x: 10, y: 5 }];
      return { id: "t", type: "spline", ...interpolateNurbs(fit)!, fitPoints: fit, closed: false };
    })();
    const out = applyGrip(e, gripsOf(e)[1], { x: 0, y: 0 }) as SplineEntity;
    expect(out).toBe(e);
  });
});

describe("spline persistence", () => {
  it("sketch code round-trips a fit spline (same id on edit, colour kept)", () => {
    const f = { ...fitSpline(), color: "#f00" };
    const doc = docWith(f);
    const code = toCode(doc);
    expect(code).toContain("spline S2 degree 3 fit (0, 0) (10, 8)");
    const { entities, errors } = parseCode(code);
    expect(errors).toEqual([]);
    expect(diffToCommands(doc, entities)).toEqual([]);
    const edited = parseCode(code.replace("(25, 3)", "(25, 9)")).entities;
    const [cmd] = diffToCommands(doc, edited);
    expect(cmd).toMatchObject({ type: "update-entity", entity: { id: "f", color: "#f00", fitPoints: expect.any(Array) } });
    const updated = (cmd as { entity: SplineEntity }).entity;
    expect(distToNurbs(updated, { x: 25, y: 9 })).toBeLessThan(1e-6);
  });

  it("sketch code round-trips control points, custom knots and weights", () => {
    const c = circleNurbs({ x: 3, y: 4 }, 5);
    const e: SplineEntity = { id: "c", type: "spline", name: "S1", ...c, closed: true };
    const doc = docWith(e);
    const code = toCode(doc);
    expect(code).toContain(" knots ");
    expect(code).toContain(" weights ");
    const back = parseCode(code);
    expect(back.errors).toEqual([]);
    const rebuilt = diffToCommands(new SketchDocument(), back.entities)[0] as { entity: SplineEntity };
    expect(rebuilt.entity.closed).toBe(true);
    sameCurve(rebuilt.entity, e, 4);
  });

  it("a plain uniform cv spline writes no knots, and re-reads the same", () => {
    const e = cv({ name: "S1" });
    const code = toCode(docWith(e));
    expect(code).not.toContain("knots");
    const rebuilt = diffToCommands(new SketchDocument(), parseCode(code).entities)[0] as { entity: SplineEntity };
    sameCurve(rebuilt.entity, e);
  });

  it("explains bad spline lines", () => {
    const msg = (line: string) => parseCode(line).errors[0]?.message ?? "";
    expect(msg("spline S1 degree 3 cv (0, 0) (1, 1)")).toMatch(/at least 4/);
    expect(msg("spline S1 degree 3 fit (0, 0)")).toMatch(/two distinct/);
    expect(msg("spline S1 degree 0 fit (0, 0) (1, 1)")).toMatch(/degree/);
    expect(msg("spline S1 degree 2 cv (0, 0) (1, 1) (2, 0) knots 0 0 0 1 0.5 1")).toMatch(/not valid/);
    expect(msg("spline S1 degree 3 fit (0, 0) (1, 1) knots 0 1")).toMatch(/derived/);
    expect(msg("spline S1 degree 2 cv (0, 0) (1, 1) (2, 0) bogus")).toMatch(/unexpected/);
  });

  it("DXF 2018 writes a SPLINE that reads back as the same curve, with fit points and weights", () => {
    const src = [cv({ id: "a" }), fitSpline(), { id: "c", type: "spline", ...circleNurbs({ x: 0, y: 0 }, 4), closed: true } as SplineEntity];
    const text = entitiesToDxf2018(src);
    expect(text).toContain("AcDbSpline");
    const back = parseDxf(text).entities.filter((e) => e.type === "spline") as SplineEntity[];
    expect(back).toHaveLength(3);
    src.forEach((s, i) => {
      sameCurve(back[i], s, 6);
      expect(back[i].degree).toBe(s.degree);
      expect(back[i].closed).toBe(s.closed);
    });
    expect(back[1].fitPoints).toHaveLength(5);
    expect(back[2].weights).toHaveLength(9);
  });

  it("document JSON carries every spline field", () => {
    const f = fitSpline();
    const again = SketchDocument.fromJSON(docWith(f).toJSON()).get("f") as SplineEntity;
    expect(again).toMatchObject({ degree: 3, closed: false });
    expect(again.fitPoints).toEqual(f.fitPoints);
    expect(again.knots).toEqual(f.knots);
  });

  it("SVG export writes exact cubic Béziers for a cubic, and the curve re-imports in the same place", () => {
    const e = cv();
    const svg = entitiesToSvgDocument([e]);
    expect(svg).toMatch(/ C[\d.\- ]+ C/); // two Bézier pieces for 5 CVs
    const [back] = parseSvgText(svg).entities;
    const b0 = boundsOf([e])!;
    const b1 = boundsOf([back])!;
    expect(b1.maxX - b1.minX).toBeCloseTo(b0.maxX - b0.minX, 2);
    expect(b1.maxY - b1.minY).toBeCloseTo(b0.maxY - b0.minY, 2);
  });

  it("a rational spline exports as a tessellated path (no wrong Béziers)", () => {
    const svg = entitiesToSvgDocument([{ id: "c", type: "spline", ...circleNurbs({ x: 0, y: 0 }, 4), closed: true } as SplineEntity]);
    expect(svg).not.toMatch(/[CQ][\d.-]/);
    expect(svg).toContain(" Z");
  });
});
