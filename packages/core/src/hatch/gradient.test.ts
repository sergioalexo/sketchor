/**
 * Why this matters: canvas, SVG and PDF all draw gradients from one spec; if a
 * kind's geometry or stop order is wrong here, the hatch looks different on
 * screen and in the printed file. Also pins the single-colour tint and the
 * degenerate-box / unknown-name fallbacks.
 */
import { describe, expect, it } from "vitest";
import type { HatchPaint } from "../entities";
import { GRADIENT_NAMES, gradientColors, gradientSpec } from "./gradient";

type G = Extract<HatchPaint, { kind: "gradient" }>;
const g = (name: string, over: Partial<G> = {}): G => ({ kind: "gradient", name, colors: ["#000000", "#ffffff"], angle: 0, ...over });
const box = { minX: 0, minY: 0, maxX: 10, maxY: 4 };

describe("gradientSpec", () => {
  it("LINEAR runs c1 to c2 across the box along the angle", () => {
    const s = gradientSpec(g("LINEAR"), box)!;
    expect(s).toMatchObject({ kind: "linear", x1: 0, x2: 10, y1: 2, y2: 2 });
    expect(s.stops.map((x) => x.color)).toEqual(["#000000", "#ffffff"]);
    const v = gradientSpec(g("LINEAR", { angle: 90 }), box)!;
    expect(v).toMatchObject({ kind: "linear", x1: 5, x2: 5 });
    expect((v as { y2: number }).y2 - (v as { y1: number }).y1).toBeCloseTo(4, 9);
  });

  it("CYLINDER brightens the middle and INVCYLINDER darkens it", () => {
    expect(gradientSpec(g("CYLINDER"), box)!.stops.map((x) => x.color)).toEqual(["#000000", "#ffffff", "#000000"]);
    expect(gradientSpec(g("INVCYLINDER"), box)!.stops.map((x) => x.color)).toEqual(["#ffffff", "#000000", "#ffffff"]);
    expect(gradientSpec(g("CYLINDER", { centered: false, shift: 0.4 }), box)!.stops[1].t).toBeCloseTo(0.7, 9);
  });

  it("radial kinds put c2 at the focus and c1 at the rim; INV swaps; hemispherical pulls the focus off-centre", () => {
    const sph = gradientSpec(g("SPHERICAL"), box)! as Extract<ReturnType<typeof gradientSpec>, { kind: "radial" }>;
    expect(sph.kind).toBe("radial");
    expect(sph.stops.map((x) => x.color)).toEqual(["#ffffff", "#000000"]);
    expect([sph.fx, sph.fy]).toEqual([sph.cx, sph.cy]);
    expect(gradientSpec(g("INVSPHERICAL"), box)!.stops.map((x) => x.color)).toEqual(["#000000", "#ffffff"]);
    const hemi = gradientSpec(g("HEMISPHERICAL"), box)! as typeof sph;
    expect(hemi.fx).toBeLessThan(hemi.cx);
    const curved = gradientSpec(g("CURVED"), box)! as typeof sph;
    expect(curved.cx - curved.fx).toBeGreaterThan(hemi.cx - hemi.fx);
  });

  it("every named kind yields a spec; unknown names draw as linear; empty boxes yield none", () => {
    for (const n of GRADIENT_NAMES) expect(gradientSpec(g(n), box)).not.toBeNull();
    expect(gradientSpec(g("MYSTERY"), box)!.kind).toBe("linear");
    expect(gradientSpec(g("LINEAR"), { minX: 1, minY: 1, maxX: 1, maxY: 1 })).toBeNull();
    expect(gradientSpec(g("LINEAR"), { minX: NaN, minY: 0, maxX: 1, maxY: 1 })).toBeNull();
  });

  it("a single colour fades to a tint of itself", () => {
    const [a, b] = gradientColors(g("LINEAR", { colors: ["#2f6fdb"] }));
    expect(a).toBe("#2f6fdb");
    expect(b).not.toBe("#ffffff");
    expect(parseInt(b.slice(1, 3), 16)).toBeGreaterThan(0xd0);
  });
});
