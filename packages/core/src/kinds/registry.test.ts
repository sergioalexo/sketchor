// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { boundsOf, entitiesToSvg } from "../dxf";
import { entitiesToDxf } from "../dxfExport";
import { entityPoints, rotated, transformed, translated, type ArcEntity, type CircleEntity, type Entity, type LineEntity, type PolylineEntity } from "../entities";
import { entityInBox } from "../boxSelect";
import { applyGrip, gripsOf } from "../grips";
import { pathOf, intersectCurves } from "../intersect";
import { outlineOf } from "../polygonSelect";
import { PdfBuilder } from "../pdf";
import { drawEntitiesToPdf } from "../entitiesPdf";
import { entitiesToSvgDocument, parseSvgText } from "../svg";
import { mirrored as mirroredAcross } from "../mirror";
import { stretchEntity } from "../stretch";
import "./builtin";
import { getKind, kindHitDistance, kindTessellate, registerKind, registeredKindTypes, unregisterKind, type Affine, type EntityKind } from "./registry";

/**
 * Z-01: every entity type is one registered `EntityKind`, and generic code
 * (bounds, selection, snapping curves, SVG/PDF/DXF export, grips) asks the
 * registry instead of switching on `type`. What breaks in a drawing if this
 * regresses: a new entity kind (ellipse, spline, insert, hatch, dimension…)
 * that "works everywhere" on day one stops being selectable or exportable,
 * and the seven built-ins drift from the code they were moved out of.
 *
 * The first half registers a throwaway kind that supplies ONLY `tessellate`
 * — the contract's whole minimum — and checks every generic consumer copes.
 * The second half pins the built-in kinds against the older per-type code
 * they replaced.
 */

/** A zigzag: 3 segments from (x, y) to (x+30, y), peaks 10 high. Defined outside the Entity union on purpose. */
const ZIG = "test-zigzag";
const zigzag = (x = 0, y = 0): Entity =>
  ({ id: "z1", type: ZIG, layer: "0", x, y }) as unknown as Entity;
const zigKind: EntityKind = {
  type: ZIG,
  tessellate: (e) => {
    const { x, y } = e as unknown as { x: number; y: number };
    return [
      [
        { x, y },
        { x: x + 10, y: y + 10 },
        { x: x + 20, y },
        { x: x + 30, y: y + 10 },
      ],
    ];
  },
};

describe("a kind that supplies only tessellate", () => {
  beforeAll(() => registerKind(zigKind));
  afterEach(() => registerKind(zigKind));

  it("is bounded from its tessellation", () => {
    expect(boundsOf([zigzag()])).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 10 });
    expect(boundsOf([zigzag(), { id: "l", type: "line", a: { x: -5, y: -5 }, b: { x: 1, y: 1 } }])).toMatchObject({ minX: -5, maxX: 30 });
  });

  it("contributes its vertices to entityPoints", () => {
    expect(entityPoints(zigzag())).toHaveLength(4);
  });

  it("can be window- and crossing-selected", () => {
    const e = zigzag();
    const whole = { minX: -1, minY: -1, maxX: 31, maxY: 11 };
    const across = { minX: 4, minY: -1, maxX: 6, maxY: 20 };
    const away = { minX: 100, minY: 100, maxX: 110, maxY: 110 };
    expect(entityInBox(e, whole, "window")).toBe(true);
    expect(entityInBox(e, across, "window")).toBe(false);
    expect(entityInBox(e, across, "crossing")).toBe(true);
    expect(entityInBox(e, away, "crossing")).toBe(false);
  });

  it("has a hit distance to its outline", () => {
    const e = zigzag();
    expect(kindHitDistance(e, { x: 5, y: 5 })).toBeCloseTo(0, 9);
    expect(kindHitDistance(e, { x: 5, y: 8 })).toBeCloseTo(3 / Math.SQRT2, 9);
  });

  it("gives the intersection library curves, so intersection and nearest snaps work", () => {
    const path = pathOf(zigzag())!;
    expect(path.curves).toHaveLength(3);
    expect(path.closed).toBe(false);
    const cutter = pathOf({ id: "c", type: "line", a: { x: 5, y: -10 }, b: { x: 5, y: 20 } })!;
    const hits = intersectCurves(path.curves[0], cutter.curves[0]);
    expect(hits).toHaveLength(1);
    expect(hits[0].point.x).toBeCloseTo(5, 9);
    expect(hits[0].point.y).toBeCloseTo(5, 9);
  });

  it("is a polyline outline for lasso/fence selection", () => {
    const o = outlineOf(zigzag());
    expect(o.points).toHaveLength(4);
    expect(o.closed).toBe(false);
  });

  it("gets a single move-grip, and dragging it does not throw", () => {
    const e = zigzag();
    const grips = gripsOf(e);
    expect(grips).toHaveLength(1);
    expect(grips[0].point).toEqual({ x: 15, y: 5 });
    expect(() => applyGrip(e, grips[0], { x: 20, y: 20 })).not.toThrow();
  });

  it("survives every move/rotate/mirror/stretch primitive unchanged when it has no transform", () => {
    const e = zigzag();
    expect(translated(e, 5, 5)).toBe(e);
    expect(rotated(e, { x: 0, y: 0 }, 1)).toBe(e);
    expect(transformed(e, { x: 0, y: 0 }, 1, 1, 0.5, 2)).toBe(e);
    expect(mirroredAcross(e, { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(e);
    // Stretch: untouched when the box misses it, otherwise moved whole (here: unchanged, having no transform).
    expect(stretchEntity(e, { minX: 100, minY: 100, maxX: 101, maxY: 101 }, 5, 0)).toBeNull();
    expect(stretchEntity(e, { minX: -1, minY: -1, maxX: 1, maxY: 1 }, 5, 0)).toBe(e);
  });

  it("moves when the kind supplies an affine transform", () => {
    registerKind({
      ...zigKind,
      transform: (e, m: Affine) => {
        const z = e as unknown as { x: number; y: number };
        return { ...e, x: m[0] * z.x + m[2] * z.y + m[4], y: m[1] * z.x + m[3] * z.y + m[5] } as unknown as Entity;
      },
    });
    const moved = translated(zigzag(), 7, 3) as unknown as { x: number; y: number };
    expect(moved).toMatchObject({ x: 7, y: 3 });
    const flipped = mirroredAcross(zigzag(2, 3), { x: 0, y: 0 }, { x: 1, y: 0 }) as unknown as { x: number; y: number };
    expect(flipped).toMatchObject({ x: 2, y: -3 });
    const dragged = applyGrip(zigzag(), gripsOf(zigzag())[0], { x: 25, y: 15 }) as unknown as { x: number; y: number };
    expect(dragged).toMatchObject({ x: 10, y: 10 });
  });

  it("exports to SVG as a path and to the thumbnail renderer", () => {
    const svg = entitiesToSvgDocument([zigzag(), { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 5, y: 5 } }]);
    // Padding 5: the zigzag's four points become an M + 3 L path.
    expect(svg).toMatch(/<path d="M5 15 L15 5 L25 15 L35 5"/);
    expect(entitiesToSvg([zigzag()], { size: 100 })).toContain("<path");
    expect(parseSvgText(svg).entities.length).toBeGreaterThan(0);
  });

  it("exports to PDF without throwing and draws its outline", () => {
    const pdf = new PdfBuilder();
    drawEntitiesToPdf(pdf, [zigzag()], { x: 10, y: 10, width: 200, height: 100 });
    const text = new TextDecoder("latin1").decode(pdf.bytes());
    expect(text).toMatch(/ l\b/);
  });

  it("exports to R12 DXF as a polyline of its tessellation", () => {
    const dxf = entitiesToDxf([zigzag()]);
    expect(dxf).toContain("POLYLINE");
  });

  it("stops existing once unregistered, without breaking anything", () => {
    unregisterKind(ZIG);
    expect(registeredKindTypes()).not.toContain(ZIG);
    expect(boundsOf([zigzag()])).toBeNull();
    expect(kindHitDistance(zigzag(), { x: 0, y: 0 })).toBe(Infinity);
    expect(pathOf(zigzag())).toBeNull();
    expect(gripsOf(zigzag())).toEqual([]);
    expect(kindTessellate(zigzag())).toEqual([]);
  });
});

describe("the built-in kinds", () => {
  const line: LineEntity = { id: "l", type: "line", a: { x: 1, y: 2 }, b: { x: 9, y: 5 } };
  const circle: CircleEntity = { id: "c", type: "circle", center: { x: 3, y: -4 }, radius: 7 };
  const arc: ArcEntity = { id: "a", type: "arc", center: { x: 1, y: 1 }, radius: 5, startAngle: 0.3, endAngle: 2.2, ccw: true };
  const cwArc: ArcEntity = { ...arc, id: "a2", ccw: false };
  const poly: PolylineEntity = { id: "p", type: "polyline", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }], closed: true, bulges: [0, 0.4, 0] };
  const text: Entity = { id: "t", type: "text", at: { x: 2, y: 3 }, text: "abc", height: 4, rotation: 0.3 };
  const image: Entity = { id: "i", type: "image", insert: { x: 2, y: 3 }, width: 8, height: 5, rotation: 0.4, dataUrl: "data:image/png;base64,AA==" };
  const pt: Entity = { id: "pt", type: "point", p: { x: 4, y: 4 } };
  const all: Entity[] = [line, circle, arc, cwArc, poly, text, image, pt];

  it("registers exactly the seven types", () => {
    for (const t of ["line", "circle", "arc", "point", "polyline", "text", "image"]) expect(getKind(t)).toBeDefined();
  });

  it("agrees with boundsOf: the tessellation stays inside the exact bounds and touches them", () => {
    for (const e of all) {
      const exact = boundsOf([e])!;
      const pts = kindTessellate(e, 0.01).flat();
      const tb = { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) };
      // Chord error is below the tolerance; the exact bounds may exceed the sampled ones by at most that.
      expect(tb.minX).toBeGreaterThanOrEqual(exact.minX - 1e-9);
      expect(tb.maxX).toBeLessThanOrEqual(exact.maxX + 1e-9);
      expect(exact.minX - tb.minX).toBeGreaterThan(-0.011);
      expect(tb.minX - exact.minX).toBeLessThan(0.011);
      expect(tb.maxX - exact.maxX).toBeGreaterThan(-0.011);
      expect(tb.minY - exact.minY).toBeLessThan(0.011);
      expect(exact.maxY - tb.maxY).toBeLessThan(0.011);
    }
  });

  it("closed shapes tessellate to a run that returns to its start", () => {
    for (const e of [circle, poly, text, image]) {
      const [run] = kindTessellate(e);
      expect(run[0].x).toBeCloseTo(run[run.length - 1].x, 9);
      expect(run[0].y).toBeCloseTo(run[run.length - 1].y, 9);
    }
  });

  it("transform by a similarity matches the older transformed()/rotated() code", () => {
    const pivot = { x: 2, y: -1 };
    const rot = 0.7;
    const s = 1.5;
    const [dx, dy] = [3, 4];
    const a = s * Math.cos(rot);
    const b = s * Math.sin(rot);
    const m: Affine = [a, b, -b, a, pivot.x + dx - (a * pivot.x - b * pivot.y), pivot.y + dy - (b * pivot.x + a * pivot.y)];
    for (const e of all) {
      const viaKind = getKind(e.type)!.transform!(e as never, m) as Entity;
      const viaOld = transformed(e, pivot, dx, dy, rot, s);
      // Compare through the tessellation so equivalent parameterisations (an arc's angles mod 2π) agree.
      const A = kindTessellate(viaKind, 0.01).flat();
      const B = kindTessellate(viaOld, 0.01).flat();
      expect(A.length).toBe(B.length);
      A.forEach((p, i) => {
        expect(p.x).toBeCloseTo(B[i].x, 6);
        expect(p.y).toBeCloseTo(B[i].y, 6);
      });
    }
  });

  it("transform by a mirror reflects arcs and flips bulges (mirror across the x axis)", () => {
    const m: Affine = [1, 0, 0, -1, 0, 0];
    const flipped = getKind("arc")!.transform!(arc as never, m) as ArcEntity;
    const before = kindTessellate(arc, 0.01)[0];
    const after = kindTessellate(flipped, 0.01)[0];
    expect(after.length).toBe(before.length);
    before.forEach((p, i) => {
      expect(after[i].x).toBeCloseTo(p.x, 6);
      expect(after[i].y).toBeCloseTo(-p.y, 6);
    });
    const pl = getKind("polyline")!.transform!(poly as never, m) as PolylineEntity;
    expect(pl.bulges).toEqual([-0, -0.4, -0]);
    expect(pl.points[2]).toEqual({ x: 10, y: -6 });
  });

  it("refuses maps it cannot express instead of guessing", () => {
    const nonUniform: Affine = [2, 0, 0, 1, 0, 0];
    expect(getKind("circle")!.transform!(circle as never, nonUniform)).toBeNull();
    expect(getKind("arc")!.transform!(arc as never, nonUniform)).toBeNull();
    expect(getKind("polyline")!.transform!(poly as never, nonUniform)).toBeNull(); // has a bulge arc
    expect(getKind("text")!.transform!(text as never, [1, 0, 0, -1, 0, 0])).toBeNull(); // mirrored text
    // A straight polyline and a line survive any affine map.
    expect(getKind("line")!.transform!(line as never, nonUniform)).not.toBeNull();
    expect(getKind("polyline")!.transform!({ ...poly, bulges: undefined } as never, nonUniform)).not.toBeNull();
  });

  it("hitDistance keeps the fill-anywhere-inside rule for circles and closed polylines", () => {
    const filledCircle = { ...circle, fill: "#f00" };
    expect(kindHitDistance(filledCircle, circle.center)).toBe(0);
    expect(kindHitDistance(circle, circle.center)).toBeCloseTo(7, 9);
    const straight = { ...poly, bulges: undefined };
    expect(kindHitDistance({ ...straight, fill: "#0f0" }, { x: 8, y: 2 })).toBe(0);
    expect(kindHitDistance(straight, { x: 8, y: 2 })).toBeGreaterThan(0);
    expect(kindHitDistance(line, line.a)).toBe(0);
  });

  it("snaps: a line offers its ends and midpoint, a circle its centre and four quadrants", () => {
    const lk = getKind("line")!.snaps!(line as never);
    expect(lk.map((s) => s.kind)).toEqual(["endpoint", "endpoint", "midpoint"]);
    const ck = getKind("circle")!.snaps!(circle as never);
    expect(ck.filter((s) => s.kind === "quadrant")).toHaveLength(4);
    expect(ck.filter((s) => s.kind === "center")).toHaveLength(1);
  });

  it("translated stays consistent with the kind's affine translation", () => {
    for (const e of all) {
      const viaKind = getKind(e.type)!.transform!(e as never, [1, 0, 0, 1, 5, -3]) as Entity;
      const viaOld = translated(e, 5, -3);
      expect(kindTessellate(viaKind, 0.01)).toEqual(kindTessellate(viaOld, 0.01));
    }
  });
});
