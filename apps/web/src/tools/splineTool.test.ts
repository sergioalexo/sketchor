import { describe, expect, it } from "vitest";
import { nurbsEval, SketchDocument, type Command, type Point, type SplineEntity } from "@sketchor/core";
import { SplineTool } from "./drawTools";
import type { Pick, ToolContext } from "./tool";

/**
 * The spline tool: clicks become either fit points (the curve passes through
 * them) or control vertices (they pull the curve), Enter finishes, C closes.
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
  const click = (tool: SplineTool, p: Point) =>
    tool.pick(ctx, { point: p, world: p, snap: null, shiftKey: false, ctrlKey: false, altKey: false } as Pick);
  const press = (tool: SplineTool, key: string) => tool.key(ctx, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent);
  const added = () => commands.filter((c) => c.type === "add-entity").map((c) => (c as { entity: SplineEntity }).entity);
  return { click, press, added };
}

const PTS: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: -3 }, { x: 30, y: 5 }];

describe("SplineTool", () => {
  it("fit mode: the curve passes through every clicked point and keeps them as fit points", () => {
    const { click, press, added } = setup();
    const tool = new SplineTool();
    PTS.forEach((p) => click(tool, p));
    expect(tool.busy()).toBe(true);
    press(tool, "Enter");
    const [e] = added();
    expect(e.type).toBe("spline");
    expect(e.name).toBe("S1");
    expect(e.fitPoints).toEqual(PTS);
    expect(e.closed).toBe(false);
    const [lo, hi] = [e.knots[e.degree], e.knots[e.knots.length - e.degree - 1]];
    const start = nurbsEval(e, lo).point;
    const end = nurbsEval(e, hi).point;
    expect(start.x).toBeCloseTo(0, 9);
    expect(end.x).toBeCloseTo(30, 9);
    expect(end.y).toBeCloseTo(5, 9);
    expect(tool.busy()).toBe(false);
  });

  it("Tab switches to control vertices: the clicks become the control polygon", () => {
    const { click, press, added } = setup();
    const tool = new SplineTool();
    press(tool, "Tab");
    PTS.forEach((p) => click(tool, p));
    press(tool, "Enter");
    const [e] = added();
    expect(e.fitPoints).toBeUndefined();
    expect(e.controlPoints).toEqual(PTS);
    expect(e.degree).toBe(3);
    expect(e.knots.length).toBe(PTS.length + e.degree + 1);
  });

  it("C closes: the geometry actually meets, not just a flag", () => {
    const { click, press, added } = setup();
    const tool = new SplineTool();
    PTS.forEach((p) => click(tool, p));
    press(tool, "c");
    const [e] = added();
    expect(e.closed).toBe(true);
    const cps = e.controlPoints;
    const hi = e.knots[e.knots.length - e.degree - 1];
    expect(nurbsEval(e, hi).point.x).toBeCloseTo(PTS[0].x, 9);
    expect(nurbsEval(e, hi).point.y).toBeCloseTo(PTS[0].y, 9);
    expect(cps.length).toBeGreaterThan(PTS.length);
  });

  it("Backspace drops the last point, a repeated click is ignored, and one point makes nothing", () => {
    const { click, press, added } = setup();
    const tool = new SplineTool();
    click(tool, PTS[0]);
    click(tool, PTS[0]);
    click(tool, PTS[1]);
    click(tool, PTS[2]);
    press(tool, "Backspace");
    press(tool, "Backspace");
    press(tool, "Enter");
    expect(added()).toHaveLength(0);
    expect(tool.busy()).toBe(false);
  });
});
