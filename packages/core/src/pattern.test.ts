import { describe, expect, it } from "vitest";
import { SketchDocument } from "./document";
import type { Command } from "./commands";
import type { LineEntity } from "./entities";
import { patternCommands, patternCopyCount, type PatternSpec } from "./pattern";

/**
 * The array/pattern generator — the feature the first-party pattern *plugin*
 * mirrors over the public API (its output must match this exactly). These tests
 * pin the two things that matter: how many copies a spec makes, and that each
 * copy lands at the right offset, leaving the source untouched.
 */

function docWithLine(): { doc: SketchDocument; id: string } {
  const doc = new SketchDocument();
  const line: LineEntity = { id: "src", type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
  doc._put(line);
  return { doc, id: "src" };
}

const added = (cmds: Command[]): LineEntity[] =>
  cmds.map((c) => {
    expect(c.type).toBe("add-entity");
    return (c as Extract<Command, { type: "add-entity" }>).entity as LineEntity;
  });

describe("patternCommands (rectangular)", () => {
  const spec: PatternSpec = { kind: "rectangular", columns: 3, rows: 2, columnSpacing: 50, rowSpacing: 30 };

  it("makes one copy per grid cell except the original", () => {
    const { doc, id } = docWithLine();
    const cmds = patternCommands(doc, [id], spec);
    expect(cmds).toHaveLength(5); // 3×2 = 6 instances, minus the source
    expect(patternCopyCount(spec, 1)).toBe(5);
  });

  it("offsets each copy by its column/row spacing and leaves the source in place", () => {
    const { doc, id } = docWithLine();
    const lines = added(patternCommands(doc, [id], spec));
    // Iteration is column-major, skipping cell (0,0): (0,1),(1,0),(1,1),(2,0),(2,1).
    expect(lines[0].a).toEqual({ x: 0, y: 30 }); // (col 0, row 1)
    expect(lines[1].a).toEqual({ x: 50, y: 0 }); // (col 1, row 0)
    expect(lines[4].a).toEqual({ x: 100, y: 30 }); // (col 2, row 1)
    expect(lines[4].b).toEqual({ x: 110, y: 30 });
    // Copies are genuinely new entities, not the source id.
    expect(lines.every((l) => l.id !== "src")).toBe(true);
  });

  it("produces nothing for an empty selection", () => {
    const { doc } = docWithLine();
    expect(patternCommands(doc, [], spec)).toHaveLength(0);
  });
});

describe("patternCommands (circular)", () => {
  it("spreads count-1 copies around a full turn", () => {
    const { doc, id } = docWithLine();
    const spec: PatternSpec = {
      kind: "circular",
      count: 4,
      center: { x: 0, y: 0 },
      totalAngle: 2 * Math.PI,
      rotateItems: true,
    };
    expect(patternCommands(doc, [id], spec)).toHaveLength(3);
    expect(patternCopyCount(spec, 1)).toBe(3);
  });
});
