import { describe, expect, it } from "vitest";
import {
  distToEllipse,
  ellipseFromAxes,
  ellipseParamOfPoint,
  ellipseBounds,
  ellipsePointAt,
  ellipseSweep,
  isFullEllipse,
  tessellateEllipse,
  transformEllipse,
  type EllipseGeom,
} from "./ellipse";
import type { EllipseEntity } from "./entities";
import { rotated, transformed, translated } from "./entities";
import { getKind } from "./kinds/registry";
import "./kinds/builtin";
import { SketchDocument } from "./document";
import { diffToCommands, parseCode, toCode } from "./sketchtext";
import { entitiesToDxf2018 } from "./dxfw";
import { parseDxf } from "./dxf";
import { applyGrip, gripsOf } from "./grips";

const TAU = Math.PI * 2;

const ell = (over: Partial<EllipseEntity> = {}): EllipseEntity => ({
  id: "x",
  type: "ellipse",
  center: { x: 3, y: -2 },
  majorAxis: { x: 8, y: 6 },
  ratio: 0.5,
  start: 0,
  end: TAU,
  ...over,
});

const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 5);
  expect(a.y).toBeCloseTo(b.y, 5);
};

describe("ellipse geometry", () => {
  it("bounds match a dense sampling, for full and partial ellipses", () => {
    for (const e of [ell(), ell({ start: 0.4, end: 2.2 }), ell({ start: 5, end: 7.5 })]) {
      const b = ellipseBounds(e);
      const sweep = ellipseSweep(e);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i <= 20000; i++) {
        const p = ellipsePointAt(e, e.start + (sweep * i) / 20000);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      expect(b.minX).toBeCloseTo(minX, 3);
      expect(b.maxX).toBeCloseTo(maxX, 3);
      expect(b.minY).toBeCloseTo(minY, 3);
      expect(b.maxY).toBeCloseTo(maxY, 3);
      // The exact bounds contain the tessellation.
      for (const p of tessellateEllipse(e, 0.01)) {
        expect(p.x).toBeGreaterThanOrEqual(b.minX - 1e-9);
        expect(p.x).toBeLessThanOrEqual(b.maxX + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(b.minY - 1e-9);
        expect(p.y).toBeLessThanOrEqual(b.maxY + 1e-9);
      }
    }
  });

  it("tessellation stays within the tolerance of the curve and closes a full ellipse", () => {
    const e = ell({ majorAxis: { x: 100, y: 0 }, ratio: 0.3 });
    const pts = tessellateEllipse(e, 0.02);
    for (let i = 0; i + 1 < pts.length; i++) {
      const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
      expect(distToEllipse(e, m)).toBeLessThan(0.02 + 1e-6);
    }
    expect(pts[0]).toEqual(pts[pts.length - 1]);
  });

  it("distance to the curve is exact on the axes and zero on the curve", () => {
    const e = ell({ center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5 });
    expect(distToEllipse(e, { x: 12, y: 0 })).toBeCloseTo(2, 6);
    expect(distToEllipse(e, { x: 0, y: 8 })).toBeCloseTo(3, 6);
    expect(distToEllipse(e, ellipsePointAt(e, 1.1))).toBeCloseTo(0, 6);
    expect(distToEllipse(e, { x: 0, y: 0 })).toBeCloseTo(5, 6);
  });

  describe("transform", () => {
    const maps: [string, [number, number, number, number, number, number]][] = [
      ["translate", [1, 0, 0, 1, 5, -3]],
      ["rotate", [Math.cos(0.7), Math.sin(0.7), -Math.sin(0.7), Math.cos(0.7), 0, 0]],
      ["non-uniform scale", [2, 0, 0, 0.5, 1, 1]],
      ["shear", [1, 0.4, 0.3, 1, 0, 0]],
      ["mirror x", [-1, 0, 0, 1, 0, 0]],
      ["mirror + rotate + scale", [0, 2, 3, 0, 4, 4]],
    ];
    for (const [name, m] of maps) {
      for (const [label, src] of [
        ["full", ell()],
        ["arc", ell({ start: 0.5, end: 2.5 })],
      ] as [string, EllipseEntity][]) {
        it(`${name} (${label}) agrees point-wise with the source curve`, () => {
          const out = transformEllipse(src, m) as EllipseGeom;
          expect(out).not.toBeNull();
          expect(out.ratio).toBeGreaterThan(0);
          expect(out.ratio).toBeLessThanOrEqual(1);
          const sweep = ellipseSweep(src);
          const apply = (p: { x: number; y: number }) => ({
            x: m[0] * p.x + m[2] * p.y + m[4],
            y: m[1] * p.x + m[3] * p.y + m[5],
          });
          // Every image point lies on the new curve…
          for (let i = 0; i <= 24; i++) {
            const q = apply(ellipsePointAt(src, src.start + (sweep * i) / 24));
            expect(distToEllipse(out, q)).toBeLessThan(1e-6);
          }
          // …and an arc keeps its ends (a mirror reverses direction, so they may swap) and its middle.
          if (!isFullEllipse(src)) {
            const ends = [apply(ellipsePointAt(src, src.start)), apply(ellipsePointAt(src, src.start + sweep))];
            const o = [ellipsePointAt(out, out.start), ellipsePointAt(out, out.start + ellipseSweep(out))];
            const same = (a: typeof o, b: typeof o) =>
              Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y) < 1e-6 && Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y) < 1e-6;
            expect(same(o, ends) || same(o, [ends[1], ends[0]])).toBe(true);
            near(ellipsePointAt(out, out.start + ellipseSweep(out) / 2), apply(ellipsePointAt(src, src.start + sweep / 2)));
          }
        });
      }
    }

    it("returns null for a singular map", () => {
      expect(transformEllipse(ell(), [1, 0, 2, 0, 0, 0])).toBeNull();
    });

    it("the kind's transform keeps id/name/layer/colour; translate/rotate/scale helpers work", () => {
      const src = ell({ name: "E1", layer: "L", color: "#f00" });
      const out = getKind("ellipse")!.transform!(src, [1, 0, 0, 2, 0, 0]) as EllipseEntity;
      expect(out).toMatchObject({ id: "x", name: "E1", layer: "L", color: "#f00" });
      expect(translated(src, 4, 5)).toMatchObject({ center: { x: 7, y: 3 }, name: "E1" });
      const r = rotated(ell({ center: { x: 0, y: 0 }, majorAxis: { x: 4, y: 0 } }), { x: 0, y: 0 }, Math.PI / 2);
      near(r.majorAxis, { x: 0, y: 4 });
      const t = transformed(ell({ center: { x: 0, y: 0 }, majorAxis: { x: 4, y: 0 } }), { x: 0, y: 0 }, 0, 0, 0, 2);
      near(t.majorAxis, { x: 8, y: 0 });
      expect(t.ratio).toBeCloseTo(0.5, 9);
    });
  });
});

describe("ellipseFromAxes / ellipseParamOfPoint", () => {
  it("a shorter second distance keeps the picked axis as the major", () => {
    const g = ellipseFromAxes({ x: 1, y: 1 }, { x: 11, y: 1 }, 4)!;
    expect(g.majorAxis).toEqual({ x: 10, y: 0 });
    expect(g.ratio).toBeCloseTo(0.4, 9);
  });

  it("a longer second distance turns the ellipse over — the new major is perpendicular", () => {
    const g = ellipseFromAxes({ x: 0, y: 0 }, { x: 10, y: 0 }, 25)!;
    near(g.majorAxis, { x: 0, y: 25 });
    expect(g.ratio).toBeCloseTo(0.4, 9);
    // Both picked half-lengths are still the curve's extents.
    const b = ellipseBounds(g);
    expect(b.maxX).toBeCloseTo(10, 9);
    expect(b.maxY).toBeCloseTo(25, 9);
  });

  it("rejects a zero axis", () => {
    expect(ellipseFromAxes({ x: 0, y: 0 }, { x: 0, y: 0 }, 3)).toBeNull();
    expect(ellipseFromAxes({ x: 0, y: 0 }, { x: 5, y: 0 }, 0)).toBeNull();
  });

  it("the parameter of a point recovers the parameter it was generated from", () => {
    const e = ell();
    for (const t of [-2.5, -0.7, 0, 0.4, 1.9, 3]) {
      const p = ellipsePointAt(e, t);
      expect(ellipseParamOfPoint(e, p)).toBeCloseTo(t, 9);
      // Any point further along the same ray gives the same parameter.
      const far = { x: e.center.x + (p.x - e.center.x) * 3, y: e.center.y + (p.y - e.center.y) * 3 };
      expect(ellipseParamOfPoint(e, far)).toBeCloseTo(t, 9);
    }
  });
});

describe("ellipse kind", () => {
  it("snaps: centre and the four axis ends of a full ellipse; endpoints + midpoint of an arc", () => {
    const kind = getKind("ellipse")!;
    const full = kind.snaps!(ell({ center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 } }));
    expect(full.filter((s) => s.kind === "quadrant")).toHaveLength(4);
    expect(full.some((s) => s.kind === "center")).toBe(true);
    const arc = kind.snaps!(ell({ center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 }, start: 0, end: Math.PI / 2 }));
    expect(arc.filter((s) => s.kind === "quadrant")).toHaveLength(2); // the axis ends at parameters 0 and π/2 only
    expect(arc.filter((s) => s.kind === "endpoint")).toHaveLength(2);
    expect(arc.some((s) => s.kind === "midpoint")).toBe(true);
  });

  it("grips: centre moves, major end stretches, minor end changes the ratio, arc ends re-angle", () => {
    const e = ell({ center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5 });
    const grips = gripsOf(e);
    expect(grips).toHaveLength(5);
    const major = grips.find((g) => g.kind === "quadrant" && g.index === 0)!;
    const stretched = applyGrip(e, major, { x: 20, y: 0 }) as EllipseEntity;
    expect(stretched.majorAxis.x).toBeCloseTo(20, 9);
    expect(stretched.ratio).toBe(0.5);
    const minor = grips.find((g) => g.kind === "quadrant" && g.index === 1)!;
    expect((applyGrip(e, minor, { x: 0, y: 8 }) as EllipseEntity).ratio).toBeCloseTo(0.8, 9);
    expect((applyGrip(e, minor, { x: 0, y: 99 }) as EllipseEntity).ratio).toBe(1);
    expect((applyGrip(e, grips[0], { x: 5, y: 5 }) as EllipseEntity).center).toEqual({ x: 5, y: 5 });

    const arc = ell({ center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 }, ratio: 0.5, start: 0, end: Math.PI });
    const ag = gripsOf(arc);
    expect(ag).toHaveLength(7);
    const endGrip = ag.find((g) => g.kind === "end" && g.index === 1)!;
    // Drag the end towards the top of the minor axis: parameter π/2.
    expect(ellipseSweep(applyGrip(arc, endGrip, { x: 0, y: 40 }) as EllipseEntity)).toBeCloseTo(Math.PI / 2, 6);
    const startGrip = ag.find((g) => g.kind === "end" && g.index === 0)!;
    const moved = applyGrip(arc, startGrip, { x: 0, y: 40 }) as EllipseEntity;
    expect(ellipseSweep(moved)).toBeCloseTo(Math.PI / 2, 6);
    expect(moved.end).toBeCloseTo(Math.PI, 6);
  });

  it("hit distance: a filled full ellipse is solid inside", () => {
    const kind = getKind("ellipse")!;
    const e = ell({ center: { x: 0, y: 0 }, majorAxis: { x: 10, y: 0 }, fill: "#abc" });
    expect(kind.hitDistance!(e, { x: 0, y: 0 })).toBe(0);
    expect(kind.hitDistance!({ ...e, fill: undefined }, { x: 0, y: 0 })).toBeCloseTo(5, 6);
  });
});

describe("ellipse persistence", () => {
  const docWith = (...entities: EllipseEntity[]) => {
    const doc = new SketchDocument();
    for (const e of entities) doc._put(e);
    return doc;
  };

  it("sketch code round-trips a full ellipse and an arc, keeping id and colour on edit", () => {
    const doc = docWith(ell({ id: "a", name: "E1", color: "#f00" }), ell({ id: "b", name: "E2", start: 0.5, end: 2 }));
    const code = toCode(doc);
    expect(code).toContain("ellipse E1 at (3, -2) major (8, 6) ratio 0.5\n");
    expect(code).toMatch(/ellipse E2 .* from 28\.6479 to 114\.5916/);
    const { entities, errors } = parseCode(code);
    expect(errors).toEqual([]);
    expect(entities).toHaveLength(2);
    // The arc's angles are printed to 4 decimals of a degree, so only the full ellipse is exactly stable.
    expect(diffToCommands(docWith(ell({ id: "a", name: "E1" })), parseCode("ellipse E1 at (3, -2) major (8, 6) ratio 0.5").entities)).toEqual([]);
    const cmds = diffToCommands(doc, parseCode(code.replace("ratio 0.5\n", "ratio 0.25\n")).entities);
    const update = cmds.find((c) => c.type === "update-entity");
    expect(update).toMatchObject({ entity: { id: "a", ratio: 0.25, color: "#f00" } });
  });

  it("rejects a bad ratio or a zero major axis with a clear message", () => {
    expect(parseCode("ellipse E1 at (0, 0) major (10, 0) ratio 2").errors[0].message).toMatch(/ratio/);
    expect(parseCode("ellipse E1 at (0, 0) major (0, 0) ratio 0.5").errors[0].message).toMatch(/major axis/);
  });

  it("DXF 2018 writes a real ELLIPSE that reads back identically", () => {
    const src = [ell({ id: "a", majorAxis: { x: 7, y: -2 }, ratio: 0.35 }), ell({ id: "b", start: 0.4, end: 2.9 })];
    const text = entitiesToDxf2018(src);
    expect(text).toContain("AcDbEllipse");
    const back = parseDxf(text).entities.filter((e) => e.type === "ellipse") as EllipseEntity[];
    expect(back).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(back[i].ratio).toBeCloseTo(src[i].ratio, 9);
      near(back[i].center, src[i].center);
      near(back[i].majorAxis, src[i].majorAxis);
      expect(back[i].start).toBeCloseTo(src[i].start, 9);
      expect(ellipseSweep(back[i])).toBeCloseTo(ellipseSweep(src[i]), 9);
    }
  });

  it("a document JSON round trip carries the ellipse as-is", () => {
    const again = SketchDocument.fromJSON(docWith(ell({ id: "a" })).toJSON());
    expect(again.get("a")).toMatchObject({ type: "ellipse", ratio: 0.5, majorAxis: { x: 8, y: 6 } });
  });
});
