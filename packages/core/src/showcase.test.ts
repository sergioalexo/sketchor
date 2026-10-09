import { describe, expect, it } from "vitest";
import { CommandBus, SketchDocument, showcaseCommands, entitiesToDxf } from "./index";

describe("showcase drawing", () => {
  it("applies cleanly and shows the advertised features", () => {
    const doc = new SketchDocument();
    new CommandBus(doc).execute({ type: "batch", commands: showcaseCommands() });
    const types = new Set<string>(doc.all().map((e) => e.type));
    for (const t of ["ellipse", "spline", "hatch", "insert", "dimension", "text", "polyline", "circle"]) expect(types.has(t)).toBe(true);
    expect(doc.records("layers").length).toBeGreaterThanOrEqual(4);
    expect(doc.records("blocks").length).toBe(1);
  });
  it("exports to DXF", () => {
    const doc = new SketchDocument();
    new CommandBus(doc).execute({ type: "batch", commands: showcaseCommands() });
    expect(entitiesToDxf(doc.all(), 4, 1, doc.records("blocks") as never).length).toBeGreaterThan(500);
  });
});
