import { describe, expect, it } from "vitest";
import { ellipseBounds, ellipseSweep, isFullEllipse, SketchDocument, type Command, type EllipseEntity, type Point } from "@sketchor/core";
import { EllipseTool } from "./drawTools";
import type { Pick, ToolContext } from "./tool";

/**
 * The ellipse tool turns three clicks (or five, for an elliptical arc) into
 * one ellipse. What matters to a user's drawing: the picked axis ends and the
 * "other axis" distance are the ellipse's true extents, a too-long third pick
 * turns the ellipse over instead of being rejected, and a typed distance means
 * the same as clicking there.
 */

function setup() {
  const doc = new SketchDocument();
  const commands: Command[] = [];
  const ctx = {
    doc,
    execute: (c: Command) => commands.push(c),
    commit: (cs: Command[]) => commands.push(...cs),
    activeLayer: () => "0",
    redraw: () => {},
    displayUnit: () => "mm",
  } as unknown as ToolContext;
  const click = (tool: EllipseTool, p: Point) =>
    tool.pick(ctx, { point: p, world: p, snap: null, shiftKey: false, ctrlKey: false, altKey: false } as Pick);
  const added = () => commands.filter((c) => c.type === "add-entity").map((c) => (c as { entity: EllipseEntity }).entity);
  return { ctx, click, added };
}

describe("EllipseTool", () => {
  it("axis end: two axis ends and a distance make an ellipse centred between them", () => {
    const { click, added } = setup();
    const tool = new EllipseTool();
    click(tool, { x: 0, y: 0 });
    expect(tool.busy()).toBe(true);
    click(tool, { x: 20, y: 0 });
    click(tool, { x: 10, y: 4 }); // 4 from the centre (10, 0)
    const [e] = added();
    expect(e.type).toBe("ellipse");
    expect(e.center).toEqual({ x: 10, y: 0 });
    const b = ellipseBounds(e);
    expect(b.minX).toBeCloseTo(0, 9);
    expect(b.maxX).toBeCloseTo(20, 9);
    expect(b.maxY).toBeCloseTo(4, 9);
    expect(isFullEllipse(e)).toBe(true);
    expect(e.name).toBe("E1");
    expect(tool.busy()).toBe(false);
  });

  it("a third pick farther than the axis turns the ellipse over", () => {
    const { click, added } = setup();
    const tool = new EllipseTool();
    click(tool, { x: 0, y: 0 });
    click(tool, { x: 10, y: 0 });
    click(tool, { x: 5, y: 30 }); // 30 from the centre (5, 0), longer than the 5-unit axis
    const b = ellipseBounds(added()[0]);
    expect(b.maxY).toBeCloseTo(30, 9);
    expect(b.maxX).toBeCloseTo(10, 9);
    expect(added()[0].ratio).toBeCloseTo(5 / 30, 9);
  });

  it("a typed distance equals clicking that far from the centre", () => {
    const { ctx, click, added } = setup();
    const tool = new EllipseTool();
    click(tool, { x: 0, y: 0 });
    click(tool, { x: 20, y: 0 });
    expect(tool.typed(ctx, "3")).toBe(true);
    const e = added()[0];
    expect(e.ratio).toBeCloseTo(0.3, 9);
    expect(ellipseBounds(e).maxY).toBeCloseTo(3, 9);
  });

  it("typed text is not consumed before the distance step", () => {
    const { ctx, click } = setup();
    const tool = new EllipseTool();
    expect(tool.typed(ctx, "3")).toBe(false);
    click(tool, { x: 0, y: 0 });
    expect(tool.typed(ctx, "3")).toBe(false);
  });

  it("center mode: centre, one axis end, then the other distance", () => {
    const { ctx, click, added } = setup();
    const tool = new EllipseTool();
    tool.key(ctx, { key: "Tab" } as KeyboardEvent);
    expect(tool.mode).toBe("center");
    click(tool, { x: 5, y: 5 });
    click(tool, { x: 5, y: 15 }); // vertical axis, 10 long
    click(tool, { x: 9, y: 5 }); // 4 from the centre
    const e = added()[0];
    expect(e.center).toEqual({ x: 5, y: 5 });
    expect(ellipseBounds(e).maxY).toBeCloseTo(15, 9);
    expect(ellipseBounds(e).maxX).toBeCloseTo(9, 9);
  });

  it("arc mode: five clicks make an elliptical arc between the start and end directions", () => {
    const { ctx, click, added } = setup();
    const tool = new EllipseTool();
    tool.key(ctx, { key: "Tab" } as KeyboardEvent);
    tool.key(ctx, { key: "Tab" } as KeyboardEvent);
    expect(tool.mode).toBe("arc");
    click(tool, { x: 0, y: 0 });
    click(tool, { x: 10, y: 0 });
    click(tool, { x: 0, y: 5 });
    expect(added()).toHaveLength(0); // still asking for the arc's ends
    click(tool, { x: 0, y: 8 }); // start straight up → parameter π/2
    click(tool, { x: -8, y: 0 }); // end to the left → parameter π
    const e = added()[0];
    expect(isFullEllipse(e)).toBe(false);
    expect(e.start).toBeCloseTo(Math.PI / 2, 9);
    expect(ellipseSweep(e)).toBeCloseTo(Math.PI / 2, 9);
  });

  it("an end pick behind the start wraps to a counterclockwise sweep", () => {
    const { ctx, click, added } = setup();
    const tool = new EllipseTool();
    tool.key(ctx, { key: "Tab" } as KeyboardEvent);
    tool.key(ctx, { key: "Tab" } as KeyboardEvent);
    click(tool, { x: 0, y: 0 });
    click(tool, { x: 10, y: 0 });
    click(tool, { x: 0, y: 5 });
    click(tool, { x: -8, y: 0 }); // start at π
    click(tool, { x: 8, y: 0 }); // end at 0 → must sweep π..2π, not backwards
    expect(ellipseSweep(added()[0])).toBeCloseTo(Math.PI, 9);
  });

  it("Escape (cancel) drops a half-drawn ellipse; a repeated pick is ignored", () => {
    const { click, added } = setup();
    const tool = new EllipseTool();
    click(tool, { x: 0, y: 0 });
    click(tool, { x: 0, y: 0 });
    expect(tool.preview({} as ToolContext, { x: 3, y: 3 })).toHaveLength(1); // still waiting for the second end
    tool.cancel();
    expect(tool.busy()).toBe(false);
    expect(added()).toHaveLength(0);
  });

  it("previews the ellipse while the distance is being chosen", () => {
    const { click } = setup();
    const tool = new EllipseTool();
    click(tool, { x: 0, y: 0 });
    click(tool, { x: 20, y: 0 });
    const preview = tool.preview({} as ToolContext, { x: 10, y: 6 });
    expect(preview.some((e) => e.type === "ellipse")).toBe(true);
  });
});
