/**
 * Why this matters: a custom hatch pattern must travel with the drawing (the
 * `hatchPatterns` table) and must never shadow a built-in; the tile designer
 * must produce families whose ink density equals the drawn lines' — otherwise a
 * pattern a user "drew" fills with something else.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "../commands";
import { SketchDocument } from "../document";
import type { HatchEntity } from "../entities";
import "../kinds/builtin";
import { hatchFill } from "./fillLines";
import { loopFromPoints } from "./loops";
import { writePat } from "./pat";
import "./library";
import { lookupPattern } from "./registry";
import { tileToFamilies } from "./tile";
import { ensurePatternRecord, importPatText, removeImported, syncDocPatterns } from "./userPatterns";

describe("imported and document patterns", () => {
  it("imports a multi-pattern .pat, reports bad lines and never overrides a built-in", () => {
    const r = importPatText("*MYHATCH, mine\n45, 0,0, 0,3\n*ANSI31, fake\n0,0,0,0,1\n*BAD\nnonsense\n");
    expect(r.names).toEqual(["MYHATCH"]);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(lookupPattern("myhatch")?.category).toBe("Imported");
    expect(lookupPattern("ANSI31")?.description).not.toBe("fake");
    removeImported("MYHATCH");
    expect(lookupPattern("MYHATCH")).toBeUndefined();
  });

  it("stores a used custom pattern in the table, syncs it back, and undoes", () => {
    importPatText("*CUSTOM1, c\n30, 0,0, 0,2\n");
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    expect(ensurePatternRecord(doc, "ANSI31")).toBeNull();
    const cmd = ensurePatternRecord(doc, "custom1")!;
    bus.execute(cmd);
    expect(doc.hasRecord("hatchPatterns", "CUSTOM1")).toBe(true);
    expect(ensurePatternRecord(doc, "CUSTOM1")).toBeNull();
    removeImported("CUSTOM1");
    expect(lookupPattern("CUSTOM1")).toBeUndefined();
    syncDocPatterns(doc);
    expect(lookupPattern("CUSTOM1")?.category).toBe("Document");
    const fresh = new SketchDocument();
    syncDocPatterns(fresh);
    expect(lookupPattern("CUSTOM1")).toBeUndefined();
    bus.undo();
    expect(doc.hasRecord("hatchPatterns", "CUSTOM1")).toBe(false);
  });

  it("renaming the record renames the hatches that use it", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "put-table-record", table: "hatchPatterns", record: { name: "P", description: "", families: [{ angle: 0, origin: { x: 0, y: 0 }, offset: { x: 0, y: 1 }, dashes: [] }] } });
    const h: HatchEntity = { id: "h", type: "hatch", loops: [], paint: { kind: "pattern", name: "P", scale: 1, angle: 0 }, style: "normal" };
    bus.execute({ type: "add-entity", entity: h });
    bus.execute({ type: "rename-table-record", table: "hatchPatterns", from: "P", to: "Q" });
    expect((doc.get("h") as HatchEntity).paint).toMatchObject({ name: "Q" });
  });
});

describe("tile designer", () => {
  const ink = (families: ReturnType<typeof tileToFamilies>["families"], w: number, h: number, tiles: number): number => {
    const name = "TILE_T";
    const hatch: HatchEntity = {
      id: "t",
      type: "hatch",
      loops: [loopFromPoints([{ x: 0, y: 0 }, { x: w * tiles, y: 0 }, { x: w * tiles, y: h * tiles }, { x: 0, y: h * tiles }])],
      paint: { kind: "pattern", name, scale: 1, angle: 0, def: families },
      style: "normal",
    };
    const f = hatchFill(hatch);
    let total = 0;
    for (let i = 0; i < f.segments.length; i += 4) total += Math.hypot(f.segments[i + 2] - f.segments[i], f.segments[i + 3] - f.segments[i + 1]);
    return total / (w * h * tiles * tiles);
  };

  it("a horizontal and a vertical bar make a grid with the drawn ink density", () => {
    const { families, issues } = tileToFamilies(10, 5, [
      { a: { x: 0, y: 0 }, b: { x: 6, y: 0 } },
      { a: { x: 0, y: 0 }, b: { x: 0, y: 5 } },
    ]);
    expect(issues).toEqual([]);
    expect(families[0].offset).toEqual({ x: 0, y: 5 });
    expect(families[0].dashes).toEqual([6, -4]);
    expect(ink(families, 10, 5, 6)).toBeCloseTo((6 + 5) / 50, 1);
  });

  it("a diagonal across a square tile repeats at the lattice spacing", () => {
    const { families, issues } = tileToFamilies(4, 4, [{ a: { x: 0, y: 0 }, b: { x: 4, y: 4 } }]);
    expect(issues).toEqual([]);
    expect(families[0].offset.y).toBeCloseTo(4 / Math.SQRT2, 6);
    expect(ink(families, 4, 4, 6)).toBeCloseTo(Math.hypot(4, 4) / 16, 1);
  });

  it("reports a direction that cannot repeat and degenerate input", () => {
    expect(tileToFamilies(10, 10, [{ a: { x: 0, y: 0 }, b: { x: 1, y: Math.PI } }]).issues.length).toBe(1);
    expect(tileToFamilies(0, 10, []).issues.length).toBe(1);
    expect(tileToFamilies(10, 10, [{ a: { x: 1, y: 1 }, b: { x: 1, y: 1 } }]).families).toEqual([]);
  });

  it("round-trips through .pat text", () => {
    const { families } = tileToFamilies(10, 5, [{ a: { x: 0, y: 0 }, b: { x: 6, y: 0 } }]);
    const text = writePat([{ name: "T", description: "", families }]);
    expect(importPatText(text).names).toEqual(["T"]);
    expect(lookupPattern("T")?.families[0].dashes).toEqual([6, -4]);
    removeImported("T");
  });
});
