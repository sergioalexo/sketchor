import { describe, expect, it } from "vitest";
import { SketchDocument, interpolateNurbs, type Command, type Point, type SplineEntity } from "@sketchor/core";
import { SplineEditTool } from "./splineEditTool";
import type { Pick, ToolContext } from "./tool";

/**
 * Spline edit (C-07): a click on the selected curve adds a point (one undo
 * step), Shift-click removes the nearest, and typed `rebuild N` / `cv`
 * act on the selection. The selection is the tool's target, so clicking
 * a different spline retargets instead of editing the wrong one.
 */

const PTS: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: -3 }, { x: 30, y: 5 }];
const spline = (id = "s"): SplineEntity => ({ id, type: "spline", ...interpolateNurbs(PTS, 3)!, fitPoints: PTS, closed: false });

function setup(selected: string[] = ["s"]) {
  const doc = new SketchDocument();
  doc._put(spline("s"));
  const commands: Command[] = [];
  let selection = selected;
  const ctx = {
    doc,
    execute: (c: Command) => commands.push(c),
    commit: (cs: Command[]) => commands.push(...cs),
    selection: () => selection,
    setSelection: (ids: string[]) => (selection = ids),
    hitTest: (p: Point) => (Math.abs(p.x - 15) < 30 && Math.abs(p.y) < 40 ? ["s"] : []),
    redraw: () => {},
  } as unknown as ToolContext;
  const click = (tool: SplineEditTool, p: Point, shiftKey = false) =>
    tool.pick(ctx, { point: p, world: p, snap: null, shiftKey, ctrlKey: false, altKey: false } as Pick);
  return { ctx, commands, click, selection: () => selection };
}

describe("SplineEditTool", () => {
  it("a click on the selected spline adds a fit point as one update", () => {
    const { commands, click } = setup();
    click(new SplineEditTool(), { x: 15, y: 3 });
    expect(commands).toHaveLength(1);
    const e = (commands[0] as { entity: SplineEntity }).entity;
    expect(e.fitPoints).toHaveLength(5);
  });

  it("Shift-click removes the nearest fit point", () => {
    const { commands, click } = setup();
    click(new SplineEditTool(), { x: 19, y: -2 }, true);
    const e = (commands[0] as { entity: SplineEntity }).entity;
    expect(e.fitPoints).toHaveLength(3);
    expect(e.fitPoints).not.toContainEqual({ x: 20, y: -3 });
  });

  it("with nothing selected, a click on a spline selects it and does not edit", () => {
    const { commands, click, selection } = setup([]);
    click(new SplineEditTool(), { x: 15, y: 3 });
    expect(selection()).toEqual(["s"]);
    expect(commands).toEqual([]);
  });

  it("typed rebuild N rewrites the selected spline with N control points; junk is refused", () => {
    const { ctx, commands } = setup();
    const tool = new SplineEditTool();
    expect(tool.typed(ctx, "rebuild 7")).toBe(true);
    const e = (commands[0] as { entity: SplineEntity }).entity;
    expect(e.controlPoints).toHaveLength(7);
    expect(e.fitPoints).toBeUndefined();
    expect(tool.typed(ctx, "rebuild x")).toBe(false);
    expect(tool.typed(ctx, "frobnicate")).toBe(false);
  });

  it("typed cv drops the fit data; typed polyline swaps the spline for a polyline under a new id", () => {
    const { ctx, commands } = setup();
    const tool = new SplineEditTool();
    tool.typed(ctx, "cv");
    expect((commands[0] as { entity: SplineEntity }).entity.fitPoints).toBeUndefined();
    tool.typed(ctx, "polyline 0.1");
    expect(commands.some((c) => c.type === "delete-entities")).toBe(true);
    const add = commands.find((c) => c.type === "add-entity") as { entity: { type: string; id: string } };
    expect(add.entity.type).toBe("polyline");
    expect(add.entity.id).not.toBe("s");
  });
});
