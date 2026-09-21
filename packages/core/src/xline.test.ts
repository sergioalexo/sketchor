import { describe, expect, it } from "vitest";
import { CommandBus } from "./commands";
import { SketchDocument } from "./document";
import { entitiesToDxf } from "./dxfExport";
import type { LineEntity } from "./entities";
import { cutParams } from "./intersect";
import { diffToCommands, parseCode, toCode } from "./sketchtext";
import { entitiesToSvgDocument } from "./svg";

/**
 * A construction line (T-07) is a drawing aid: if it leaked into a DXF a
 * laser would cut it; if trim ignored it the whole point of it (a boundary
 * you can trim to) is lost; if a code edit dropped the flag it would turn
 * into a real, short line.
 */
describe("infinite construction lines", () => {
  const xline: LineEntity = { id: "x", type: "line", a: { x: 0, y: 5 }, b: { x: 1, y: 5 }, infinite: true };
  const real: LineEntity = { id: "r", type: "line", a: { x: 50, y: 0 }, b: { x: 50, y: 10 } };

  it("stay out of DXF and SVG exports", () => {
    expect(entitiesToDxf([xline, real])).not.toMatch(/\n5\.0*\n|LINE\n8\n0\n10\n0\n/); // no xline coordinates
    expect((entitiesToDxf([xline, real]).match(/^LINE$/gm) ?? []).length).toBe(1);
    expect((entitiesToSvgDocument([xline, real]).match(/<line /g) ?? []).length).toBe(1);
  });

  it("cut other entities along their whole length", () => {
    // The xline is only 1 unit long as stored, but it cuts a line 50 units away.
    expect(cutParams(real, [xline])).toHaveLength(1);
    expect(cutParams(real, [{ ...xline, infinite: false }])).toHaveLength(0);
  });

  it("keep the flag through a sketch-code edit", () => {
    const d = new SketchDocument();
    d._put(xline);
    const bus = new CommandBus(d);
    const code = toCode(d).replace("(1, 5)", "(2, 6)");
    bus.execute({ type: "batch", commands: diffToCommands(d, parseCode(code).entities) });
    const after = d.get("x") as LineEntity;
    expect(after.b).toEqual({ x: 2, y: 6 });
    expect(after.infinite).toBe(true);
  });
});
