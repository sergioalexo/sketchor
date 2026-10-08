/**
 * Why this is worth testing: an EPS Sketchor writes goes to a vinyl cutter or a
 * DTP program. If a circle comes back 0.05 mm too big or an arc leg of a
 * polyline is dropped, nothing complains — the part is just wrong. The core
 * test is a round trip: Sketchor → EPS → Sketchor must agree within 0.001 mm,
 * including the absolute position (via `%%SketchorOrigin`).
 */
import { describe, expect, it } from "vitest";
import type { Entity } from "../entities";
import { kindTessellate } from "../kinds/registry";
import "../kinds/builtin";
import { decodeTiff } from "./tiff";
import { parseDosHeader, parseEpsHeader, splitEps } from "./dsc";
import { importEps } from "./index";
import { entitiesToEps, entitiesToEpsFile } from "./export";

let n = 0;
const id = () => `t${++n}`;
const TOL = 0.001;

const SAMPLE: Entity[] = [
  { id: id(), type: "line", a: { x: 100, y: 200 }, b: { x: 160.5, y: 230.25 } },
  { id: id(), type: "polyline", points: [{ x: 10, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 70 }, { x: 10, y: 70 }], closed: true },
  { id: id(), type: "polyline", points: [{ x: 200, y: 20 }, { x: 260, y: 20 }, { x: 260, y: 60 }], closed: false, bulges: [0.5, -0.3] },
  { id: id(), type: "circle", center: { x: 120, y: 120 }, radius: 37.5 },
  { id: id(), type: "arc", center: { x: -50, y: 40 }, radius: 25, startAngle: 0.3, endAngle: 2.4, ccw: true },
  { id: id(), type: "arc", center: { x: -50, y: -40 }, radius: 12, startAngle: 5, endAngle: 1, ccw: false },
  { id: id(), type: "ellipse", center: { x: 300, y: 100 }, majorAxis: { x: 40, y: 10 }, ratio: 0.5, start: 0, end: Math.PI * 2 },
  { id: id(), type: "ellipse", center: { x: 300, y: -100 }, majorAxis: { x: 30, y: 0 }, ratio: 0.4, start: 0.5, end: 2.5 },
  {
    id: id(),
    type: "spline",
    degree: 3,
    controlPoints: [{ x: 0, y: 150 }, { x: 20, y: 190 }, { x: 60, y: 190 }, { x: 80, y: 150 }, { x: 100, y: 110 }, { x: 140, y: 110 }, { x: 160, y: 150 }],
    knots: [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2],
  } as Entity,
];

/** All tessellated points of `es`, sampled densely. */
function samples(es: Entity[]): { x: number; y: number }[] {
  return es.filter((e) => e.type !== "text").flatMap((e) => kindTessellate(e, 0.0005).flat());
}

/** Largest distance from any sample of `a` to the polyline set of `b` (one-sided Hausdorff). */
function maxDeviation(a: Entity[], b: Entity[]): number {
  const segs: [number, number, number, number][] = [];
  for (const e of b) for (const pl of kindTessellate(e, 0.0005)) for (let i = 1; i < pl.length; i++) segs.push([pl[i - 1].x, pl[i - 1].y, pl[i].x, pl[i].y]);
  let worst = 0;
  for (const p of samples(a)) {
    let best = Infinity;
    for (const [x0, y0, x1, y1] of segs) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.y - y0) * dy) / l2));
      best = Math.min(best, Math.hypot(p.x - (x0 + t * dx), p.y - (y0 + t * dy)));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

describe("EPS export", () => {
  const text = entitiesToEps(SAMPLE, { title: "t" });

  it("writes a DSC-conformant header with a tight bounding box", () => {
    expect(text.startsWith("%!PS-Adobe-3.0 EPSF-3.0\n")).toBe(true);
    const h = parseEpsHeader(Uint8Array.from(text, (c) => c.charCodeAt(0)));
    expect(h.bbox![0]).toBe(0);
    expect(h.bbox![1]).toBe(0);
    expect(h.hiResBbox![2]).toBeGreaterThan(300);
    expect(h.languageLevel).toBe(2);
    expect(h.sketchorOrigin).not.toBeNull();
    expect(text.endsWith("%%EOF\n")).toBe(true);
  });

  it("round-trips Sketchor → EPS → Sketchor within 0.001 mm, absolute position included", () => {
    const r = importEps(Uint8Array.from(text, (c) => c.charCodeAt(0)));
    expect(r.warnings).toEqual([]);
    expect(maxDeviation(SAMPLE, r.entities)).toBeLessThan(TOL);
    expect(maxDeviation(r.entities, SAMPLE)).toBeLessThan(TOL);
  });

  it("brings back circles and straight/closed shapes as the same kinds, with exact numbers", () => {
    const r = importEps(Uint8Array.from(text, (c) => c.charCodeAt(0)));
    const c = r.entities.find((e) => e.type === "circle");
    expect(c && c.type === "circle").toBe(true);
    if (c && c.type === "circle") {
      expect(Math.abs(c.center.x - 120)).toBeLessThan(TOL);
      expect(Math.abs(c.center.y - 120)).toBeLessThan(TOL);
      expect(Math.abs(c.radius - 37.5)).toBeLessThan(TOL);
    }
    const rect = r.entities.find((e) => e.type === "polyline" && e.closed && e.points.length === 4);
    expect(rect).toBeDefined();
  });

  it("writes colour, lineweight, dash and fill", () => {
    const t = entitiesToEps([
      { id: id(), type: "circle", center: { x: 0, y: 0 }, radius: 5, color: "#ff0000", fill: "#00ff00", lineweight: 0.5, linetype: "DASHED" },
    ]);
    expect(t).toMatch(/1 0 0 rg/);
    expect(t).toMatch(/0 1 0 rg F/);
    expect(t).toMatch(/setdash/);
    const r = importEps(Uint8Array.from(t, (c) => c.charCodeAt(0)));
    const c = r.entities[0];
    expect(c.type).toBe("circle");
    if (c.type === "circle") {
      expect(c.fill).toBe("#00ff00");
      expect(c.color).toBe("#ff0000");
      expect(Math.abs((c.lineweight ?? 0) - 0.5)).toBeLessThan(1e-3);
    }
  });

  it("writes text and survives escapes", () => {
    const t = entitiesToEps([{ id: id(), type: "text", at: { x: 5, y: 5 }, text: "a (b) \\ c", height: 4, rotation: 0 }]);
    expect(t).toContain("(a \\(b\\) \\\\ c) show");
    const r = importEps(Uint8Array.from(t, (c) => c.charCodeAt(0)));
    const tx = r.entities.find((e) => e.type === "text");
    expect(tx && tx.type === "text" && tx.text).toBe("a (b) \\ c");
  });

  it("handles empty input without throwing", () => {
    const t = entitiesToEps([]);
    expect(t).toContain("%%BoundingBox:");
    // nothing to draw: at most the bounding-box placeholder (a construction rectangle)
    expect(importEps(Uint8Array.from(t, (c) => c.charCodeAt(0))).entities.every((e) => e.type === "polyline" && e.construction)).toBe(true);
  });
});

describe("EPS export with TIFF preview (DOS binary header)", () => {
  it("is off by default and plain text then", () => {
    const b = entitiesToEpsFile(SAMPLE);
    expect(b[0]).toBe(0x25); // '%'
  });

  it("prepends the DOS header with a decodable TIFF preview, and still imports", () => {
    const b = entitiesToEpsFile(SAMPLE, { tiffPreview: true, previewSize: 128 });
    const dos = parseDosHeader(b)!;
    expect(dos.psOffset).toBe(30);
    expect(dos.tiffLength).toBeGreaterThan(0);
    const parts = splitEps(b);
    const img = decodeTiff(parts.tiff!)!;
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(128);
    // some ink was drawn, on a white page
    let dark = 0;
    for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i] < 128) dark++;
    expect(dark).toBeGreaterThan(50);
    expect(Array.from(img.rgba.slice(0, 4))).toEqual([255, 255, 255, 255]);
    const r = importEps(b);
    expect(maxDeviation(SAMPLE, r.entities)).toBeLessThan(TOL);
  });
});
