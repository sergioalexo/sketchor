import { describe, expect, it } from "vitest";
import { linearDimension } from "./dimension";
import { SketchDocument } from "./document";
import { rotated, textCorners, textWidth, translated, type TextEntity } from "./entities";
import { entitiesToDxf } from "./dxfExport";
import { parseDxf } from "./dxf";
import { entitiesToSvgDocument } from "./svg";
import { parseCode, toCode } from "./sketchtext";

const sample: TextEntity = {
  id: "t1",
  type: "text",
  name: "T1",
  at: { x: 10, y: 20 },
  text: "LOAD 3",
  height: 5,
  rotation: 0,
};

describe("text entity", () => {
  it("translates and rotates its insertion point", () => {
    expect(translated(sample, 5, -3).at).toEqual({ x: 15, y: 17 });
    const r = rotated(sample, { x: 0, y: 0 }, Math.PI / 2);
    expect(r.rotation).toBeCloseTo(Math.PI / 2);
    expect(r.at.x).toBeCloseTo(-20);
    expect(r.at.y).toBeCloseTo(10);
  });

  it("has a bounding box that grows with the string", () => {
    expect(textWidth("AB", 5)).toBeLessThan(textWidth("ABCD", 5));
    expect(textCorners(sample)).toHaveLength(4);
  });

  it("round-trips through sketch code", () => {
    const doc = new SketchDocument();
    doc._put(sample);
    const code = toCode(doc);
    expect(code).toMatch(/text T1 at \(10, 20\) "LOAD 3" h 5/);
    const back = parseCode(code);
    expect(back.errors).toHaveLength(0);
    expect(back.entities[0]).toMatchObject({ type: "text", text: "LOAD 3", height: 5 });
  });

  it("exports to DXF TEXT and reads back", () => {
    const dxf = entitiesToDxf([sample]);
    expect(dxf).toContain("\nTEXT\n");
    const back = parseDxf(dxf).entities.find((e) => e.type === "text");
    expect(back).toMatchObject({ type: "text", text: "LOAD 3" });
  });

  it("exports to an SVG <text> element", () => {
    expect(entitiesToSvgDocument([sample])).toContain("<text");
  });
});

describe("dashed", () => {
  it("emits stroke-dasharray in SVG", () => {
    const svg = entitiesToSvgDocument([
      { id: "l", type: "line", dashed: true, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
    ]);
    expect(svg).toContain("stroke-dasharray");
  });
});

describe("linearDimension", () => {
  it("returns the extension + dimension + tick lines and a label near the midpoint", () => {
    const d = linearDimension({ x: 0, y: 0 }, { x: 100, y: 0 }, { offset: 20, textHeight: 4, label: "100" });
    expect(d.lines.length).toBeGreaterThanOrEqual(4);
    expect(d.text.text).toBe("100");
    expect(d.text.at.x).toBeGreaterThan(20);
    expect(d.text.at.x).toBeLessThan(80);
    expect(d.text.at.y).toBeGreaterThan(0); // pushed to the offset side
  });
});
