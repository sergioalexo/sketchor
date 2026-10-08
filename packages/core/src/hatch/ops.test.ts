/**
 * Why this matters: explode and recreate-boundary replace geometry the user
 * sees; a wrong inverse or a lost layer/colour is silent damage. These pin that
 * the result is one undo step, keeps the layer, stays grouped, refuses runaway
 * patterns, and that the exploded lines cover the same ink as the hatch drew.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { HatchEntity } from "../entities";
import "../kinds/builtin";
import { hatchFill } from "./fillLines";
import "./library";
import { loopFromCircle, loopFromPoints } from "./loops";
import { drawOrderOf, explodeHatchCommands, hatchBoundaryEntities, recreateBoundaryCommands, setHatchDrawOrder } from "./ops";

const square = loopFromPoints([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }]);
const hatch = (over: Partial<HatchEntity> = {}): HatchEntity => ({
  id: "h",
  type: "hatch",
  name: "H1",
  layer: "walls",
  color: "#0f0",
  loops: [square],
  paint: { kind: "pattern", name: "ANSI31", scale: 1, angle: 0 },
  style: "normal",
  ...over,
});

describe("hatch boundary", () => {
  it("one entity per edge, on the hatch layer, a full circle becomes a circle", () => {
    const ents = hatchBoundaryEntities(hatch({ loops: [square, loopFromCircle({ x: 10, y: 10 }, 3)] }));
    expect(ents.map((e) => e.type)).toEqual(["line", "line", "line", "line", "circle"]);
    expect(ents.every((e) => e.layer === "walls")).toBe(true);
    expect(new Set(ents.map((e) => e.id)).size).toBe(5);
  });

  it("recreate adds entities and keeps the hatch; one undo removes them", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: hatch() });
    const r = recreateBoundaryCommands(hatch());
    bus.execute({ type: "batch", commands: r.commands });
    expect(doc.all().length).toBe(5);
    bus.undo();
    expect(doc.all().map((e) => e.id)).toEqual(["h"]);
  });
});

describe("explode", () => {
  it("replaces the pattern by grouped lines carrying the ink of the fill, undoable", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    const h = hatch();
    bus.execute({ type: "add-entity", entity: h });
    const f = hatchFill(h);
    const ink = (() => {
      let t = 0;
      for (let i = 0; i < f.segments.length; i += 4) t += Math.hypot(f.segments[i + 2] - f.segments[i], f.segments[i + 3] - f.segments[i + 1]);
      return t;
    })();
    const cmds = explodeHatchCommands(h)!;
    bus.execute({ type: "batch", commands: cmds });
    expect(doc.get("h")).toBeUndefined();
    const lines = doc.all().filter((e) => e.type === "line");
    expect(lines.length).toBe(f.segments.length / 4);
    const total = lines.reduce((s, e) => (e.type === "line" ? s + Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) : s), 0);
    expect(total).toBeCloseTo(ink, 6);
    expect(lines.every((e) => e.layer === "walls" && e.color === "#0f0")).toBe(true);
    expect(doc.groups().length).toBe(1);
    bus.undo();
    expect(doc.all().map((e) => e.id)).toEqual(["h"]);
    expect(doc.groups().length).toBe(0);
  });

  it("a solid hatch explodes to its boundary; a runaway or unknown pattern is refused", () => {
    const solid = explodeHatchCommands(hatch({ paint: { kind: "solid", color: "#f00" } }))!;
    expect(solid.filter((c) => c.type === "add-entity").length).toBe(4);
    const dense = hatch({ paint: { kind: "pattern", name: "ANSI31", scale: 0.00001, angle: 0 } });
    expect(explodeHatchCommands(dense)).toBeNull();
    expect(explodeHatchCommands(hatch({ paint: { kind: "pattern", name: "NOPE", scale: 1, angle: 0 } }))).toBeNull();
  });
});

describe("draw order", () => {
  it("-1 sends behind, 0 clears the field", () => {
    const back = setHatchDrawOrder(hatch(), -1);
    expect(drawOrderOf(back)).toBe(-1);
    expect("drawOrder" in setHatchDrawOrder(back, 0)).toBe(false);
  });
});
