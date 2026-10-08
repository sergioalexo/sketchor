// @vitest-environment jsdom
/**
 * Why this matters: the exported SVG/PDF is what gets printed and sent to a
 * customer. A hatch that exports as an unfilled outline, loses its island, or
 * draws a gradient the wrong way round is invisible until it is on paper. These
 * check the file structure (strokes inside the region, an even-odd path with the
 * island, real gradient elements / PDF shading) and that the PDF stays valid.
 */
import { describe, expect, it } from "vitest";
import type { HatchEntity } from "../entities";
import "../kinds/builtin";
import { PdfBuilder } from "../pdf";
import { drawEntitiesToPdf } from "../entitiesPdf";
import { entitiesToSvgDocument, parseSvgText } from "../svg";
import { hatchFill } from "./fillLines";
import "./library";
import { loopFromCircle, loopFromPoints } from "./loops";
import { blendWithWhite, hatchArt } from "./render";

const sq = loopFromPoints([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]);
const hatch = (over: Partial<HatchEntity> = {}): HatchEntity => ({
  id: "h",
  type: "hatch",
  layer: "walls",
  loops: [sq, loopFromCircle({ x: 20, y: 20 }, 8)],
  paint: { kind: "pattern", name: "ANSI31", scale: 1, angle: 0 },
  style: "normal",
  ...over,
});

describe("hatch art", () => {
  it("a pattern has the engine's strokes; solid and gradient have rings; unknown/dense patterns degrade", () => {
    const a = hatchArt(hatch())!;
    expect(a.rings).toHaveLength(2);
    expect(a.paint.kind === "lines" && a.paint.segments.length).toBe(hatchFill(hatch()).segments.length);
    expect(hatchArt(hatch({ paint: { kind: "solid", color: "#f00" } }))!.paint.kind).toBe("solid");
    expect(hatchArt(hatch({ paint: { kind: "gradient", name: "SPHERICAL", colors: ["#000", "#fff"], angle: 0 } }))!.paint.kind).toBe("gradient");
    expect(hatchArt(hatch({ paint: { kind: "pattern", name: "NOPE", scale: 1, angle: 0 } }))!.paint.kind).toBe("tint");
    expect(hatchArt(hatch({ paint: { kind: "pattern", name: "ANSI31", scale: 0.00001, angle: 0 } }))!.paint.kind).toBe("tint");
    expect(hatchArt(hatch({ loops: [] }))).toBeNull();
  });

  it("blends toward white", () => {
    expect(blendWithWhite("#000000", 0.5)).toBe("#808080");
    expect(blendWithWhite("#123456", 0)).toBe("#123456");
  });
});

describe("hatch in SVG", () => {
  it("a pattern exports as stroke segments, not an outline; every stroke is inside the region", () => {
    const svg = entitiesToSvgDocument([hatch()]);
    expect(svg).toContain("<path");
    const d = /<path d="(M[^"]*L[^"]*)" stroke=/.exec(svg)![1];
    const nums = [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(nums.length / 2).toBeCloseTo(hatchFill(hatch()).segments.length / 4, 0);
    // bounds 0..40 plus padding 5: nothing outside
    for (const [x, y] of nums) {
      expect(x).toBeGreaterThanOrEqual(5 - 1e-3);
      expect(x).toBeLessThanOrEqual(45 + 1e-3);
      expect(y).toBeGreaterThanOrEqual(5 - 1e-3);
      expect(y).toBeLessThanOrEqual(45 + 1e-3);
    }
  });

  it("solid is an even-odd path with both rings; transparency becomes opacity", () => {
    const svg = entitiesToSvgDocument([hatch({ paint: { kind: "solid", color: "#336699" }, transparency: 0.25 })]);
    expect(svg).toContain('fill="#336699"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('opacity="0.75"');
    expect((/d="([^"]*)" fill="#336699"/.exec(svg)![1].match(/Z/g) ?? []).length).toBe(2);
  });

  it("a gradient is a real gradient element with its stops, referenced by the fill", () => {
    const lin = entitiesToSvgDocument([hatch({ paint: { kind: "gradient", name: "CYLINDER", colors: ["#ff0000", "#0000ff"], angle: 0 } })]);
    expect(lin).toContain("<defs><linearGradient");
    expect((lin.match(/<stop /g) ?? []).length).toBe(3);
    expect(lin).toMatch(/fill="url\(#hatchgrad1\)"/);
    const rad = entitiesToSvgDocument([hatch({ paint: { kind: "gradient", name: "SPHERICAL", colors: ["#ff0000"], angle: 0 } })]);
    expect(rad).toContain("<radialGradient");
  });

  it("is well-formed XML and re-imports without throwing", () => {
    const svg = entitiesToSvgDocument([hatch(), hatch({ id: "h2", paint: { kind: "gradient", name: "LINEAR", colors: ["#000"], angle: 45 } })]);
    expect(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("parsererror").length).toBe(0);
    expect(() => parseSvgText(svg)).not.toThrow();
  });
});

describe("hatch in PDF", () => {
  const render = (h: HatchEntity): string => {
    const pdf = new PdfBuilder();
    drawEntitiesToPdf(pdf, [h], { x: 20, y: 20, width: 400, height: 400 });
    return new TextDecoder("latin1").decode(pdf.bytes());
  };

  it("pattern lines are one stroked path, solid is an even-odd fill", () => {
    const text = render(hatch());
    expect((text.match(/ l/g) ?? []).length).toBeGreaterThanOrEqual(hatchFill(hatch()).segments.length / 4);
    expect(render(hatch({ paint: { kind: "solid", color: "#336699" } }))).toContain("f*");
  });

  it("a gradient becomes a shading with a clip, and the xref still points at the objects", () => {
    const text = render(hatch({ paint: { kind: "gradient", name: "CYLINDER", colors: ["#ff0000", "#0000ff"], angle: 0 } }));
    expect(text).toContain("/Shading <<");
    expect(text).toContain("/ShadingType 2");
    expect(text).toContain("W* n");
    expect(text).toMatch(/\/Sh1 sh/);
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...text.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(render(hatch({ paint: { kind: "gradient", name: "SPHERICAL", colors: ["#ff0000"], angle: 0 } }))).toContain("/ShadingType 3");
  });
});
