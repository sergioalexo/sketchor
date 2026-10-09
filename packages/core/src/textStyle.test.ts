/**
 * D-01 text styles: a drawing's STYLE table and a TEXT's alignment/width/oblique
 * must survive DXF write -> read, sketch-code edits and style renames, otherwise
 * lettering silently loses its look when a file is saved and reopened.
 */
import { describe, expect, it } from "vitest";
import { CommandBus } from "./commands";
import { SketchDocument } from "./document";
import { entitiesToDxf2018 } from "./dxfw";
import { fontFromStyleFile, parseDxf } from "./dxf";
import { entitiesToDxf } from "./dxfExport";
import type { TextEntity } from "./entities";
import { textCorners } from "./entities";
import { diffToCommands, parseCode, toCode } from "./sketchtext";
import { STANDARD_TEXT_STYLE, resolveTextLook, textStyleOf, type TextStyle } from "./textStyle";

const text = (over: Partial<TextEntity> = {}): TextEntity => ({
  id: "t1",
  type: "text",
  name: "t1",
  at: { x: 10, y: 20 },
  text: "ABCD",
  height: 5,
  rotation: 0,
  ...over,
});

const ISO: TextStyle = { name: "ISO", font: "shx:isocp", height: 0, widthFactor: 0.8, oblique: 15, backwards: false, upsideDown: false };

describe("resolveTextLook", () => {
  it("entity overrides win, unknown style falls back to Standard", () => {
    const lookup = (n: string) => (n === "ISO" ? ISO : undefined);
    expect(resolveTextLook({ style: "ISO" }, lookup)).toMatchObject({ widthFactor: 0.8, oblique: 15, font: "shx:isocp" });
    expect(resolveTextLook({ style: "ISO", widthFactor: 2, oblique: 0 }, lookup)).toMatchObject({ widthFactor: 2, oblique: 0 });
    expect(resolveTextLook({ style: "Nope" }, lookup)).toMatchObject({ widthFactor: 1, oblique: 0 });
    expect(resolveTextLook({})).toEqual({ font: "sketchor-stroke", widthFactor: 1, oblique: 0, backwards: false, upsideDown: false });
  });
  it("textStyleOf repairs malformed records", () => {
    const s = textStyleOf({ name: "X", widthFactor: -3, height: -1, font: "" });
    expect(s).toMatchObject({ widthFactor: 1, height: 0, font: "sketchor-stroke" });
    expect(textStyleOf(undefined)).toBe(STANDARD_TEXT_STYLE);
  });
});

describe("textCorners with alignment and width factor", () => {
  it("scales the width and shifts the box for centre/middle", () => {
    const plain = textCorners(text());
    const w = plain[1].x - plain[0].x;
    const wide = textCorners(text({ widthFactor: 2 }));
    expect(wide[1].x - wide[0].x).toBeCloseTo(2 * w);
    const c = textCorners(text({ halign: "center", valign: "middle" }));
    expect(c[0].x).toBeCloseTo(10 - w / 2);
    expect(c[0].y).toBeCloseTo(20 - 2.5);
  });
});

describe("DXF round trip", () => {
  it("2018: STYLE table, group 7, 41, 51 and 72/73 come back", () => {
    const e = text({ style: "ISO", widthFactor: 0.8, oblique: 15, halign: "center", valign: "middle" });
    const dxf = entitiesToDxf2018([e], { textStyles: [ISO] });
    const back = parseDxf(dxf);
    const t = back.entities.find((x) => x.type === "text") as TextEntity;
    expect(t).toMatchObject({ style: "ISO", widthFactor: 0.8, oblique: 15, halign: "center", valign: "middle" });
    expect(t.at.x).toBeCloseTo(10);
    expect(t.at.y).toBeCloseTo(20);
    expect(back.textStyles).toHaveLength(1);
    expect(back.textStyles[0]).toMatchObject({ name: "ISO", font: "shx:isocp", widthFactor: 0.8, oblique: 15 });
  });
  it("R12 keeps width, oblique and alignment", () => {
    const t = parseDxf(entitiesToDxf([text({ widthFactor: 1.5, halign: "right" })])).entities.find((x) => x.type === "text") as TextEntity;
    expect(t.widthFactor).toBe(1.5);
    expect(t.halign).toBe("right");
  });
  it("maps font files to style fonts", () => {
    expect(fontFromStyleFile("txt.shx")).toBe("sketchor-stroke");
    expect(fontFromStyleFile("ISOCP.SHX")).toBe("shx:isocp");
    expect(fontFromStyleFile("C:\\Windows\\Fonts\\Arial.ttf")).toBe("ttf:Arial");
    expect(fontFromStyleFile("")).toBe("sketchor-stroke");
  });
  it("a bare default Standard style adds nothing", () => {
    expect(parseDxf(entitiesToDxf2018([text()])).textStyles).toEqual([]);
  });
});

describe("document integration", () => {
  it("sketch-code edit keeps style fields", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "add-entity", entity: text({ style: "ISO", halign: "center", widthFactor: 0.8, oblique: 15 }) });
    const code = toCode(doc).replace("ABCD", "WXYZ");
    for (const c of diffToCommands(doc, parseCode(code).entities)) bus.execute(c);
    expect(doc.get("t1")).toMatchObject({ text: "WXYZ", style: "ISO", halign: "center", widthFactor: 0.8, oblique: 15 });
  });
  it("renaming a text style rewrites its texts in one undo step", () => {
    const doc = new SketchDocument();
    const bus = new CommandBus(doc);
    bus.execute({ type: "put-table-record", table: "textStyles", record: ISO });
    bus.execute({ type: "add-entity", entity: text({ style: "ISO" }) });
    bus.execute({ type: "rename-table-record", table: "textStyles", from: "ISO", to: "GOST" });
    expect((doc.get("t1") as TextEntity).style).toBe("GOST");
    bus.undo();
    expect((doc.get("t1") as TextEntity).style).toBe("ISO");
  });
});
