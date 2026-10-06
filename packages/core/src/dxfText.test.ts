import { describe, expect, it } from "vitest";
import { decodeDxfBytes, escapeDxfText, sniffDxfHeader, unescapeDxfText } from "./dxfText";
import { parseDxf } from "./dxf";
import { entitiesToDxf, entitiesToDxf2018 } from "./index";

const header = (ver: string, cp: string) => `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\n${ver}\n9\n$DWGCODEPAGE\n3\n${cp}\n0\nENDSEC\n`;
const cp1251 = (s: string) => Uint8Array.from(s, (c) => (c.charCodeAt(0) < 0x80 ? c.charCodeAt(0) : c.charCodeAt(0) - 0x410 + 0xc0));
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...a: Uint8Array[]) => Uint8Array.from(a.flatMap((x) => [...x]));

describe("DXF text encoding", () => {
  it("sniffs version and codepage", () => {
    expect(sniffDxfHeader(ascii(header("AC1009", "ANSI_1251")))).toEqual({ version: "AC1009", codepage: "ANSI_1251" });
  });
  it("decodes an old ANSI_1251 file as Cyrillic", () => {
    const bytes = cat(ascii(header("AC1015", "ANSI_1251")), cp1251("Привет"));
    expect(decodeDxfBytes(bytes)).toContain("Привет");
  });
  it("decodes AC1021+ as UTF-8", () => {
    const bytes = new TextEncoder().encode(header("AC1032", "ANSI_1252") + "Привіт");
    expect(decodeDxfBytes(bytes)).toContain("Привіт");
  });
  it("resolves escapes", () => {
    expect(unescapeDxfText("\U+0416 %%c12 %%d")).toBe("Ж Ø12 °");
    expect(escapeDxfText("Ж-1")).toBe("\U+0416-1");
  });
  it("round-trips Cyrillic text through the R12 and AC1032 writers", () => {
    const ents = [{ id: "t", type: "text" as const, at: { x: 0, y: 0 }, text: "Кронштейн №3", height: 5, rotation: 0 }];
    for (const dxf of [entitiesToDxf(ents), entitiesToDxf2018(ents)]) {
      const back = parseDxf(dxf).entities.find((e) => e.type === "text");
      expect(back && back.type === "text" && back.text).toBe("Кронштейн №3");
    }
    expect(entitiesToDxf(ents)).not.toMatch(/[^\x00-\x7f]/);
  });
  it("round-trips a Cyrillic layer name in R12", () => {
    const ents = [{ id: "l", type: "line" as const, a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, layer: "Контур" }];
    const back = parseDxf(entitiesToDxf(ents)).entities[0];
    expect(back.layer).toBe("Контур");
  });
});

describe("X-06 units and extents header", () => {
  const line = [{ id: "a", type: "line" as const, a: { x: 0, y: 0 }, b: { x: 10, y: 5 } }];
  const infinite = [...line, { id: "x", type: "line" as const, a: { x: -1e6, y: 0 }, b: { x: 1e6, y: 0 }, infinite: true }];
  for (const [name, write] of [
    ["R12", (e: typeof line, u: number) => entitiesToDxf(e, u)],
    ["AC1032", (e: typeof line, u: number) => entitiesToDxf2018(e, { insUnits: u })],
  ] as const) {
    it(`${name}: writes unit and display vars, round-trips the unit`, () => {
      const dxf = write(line, 4);
      expect(dxf).toMatch(/\$MEASUREMENT\n70\n1\n/);
      expect(dxf).toMatch(/\$LUNITS\n70\n2\n/);
      expect(dxf).toMatch(/\$LIMMAX\n10\n10\.0\n20\n5\.0\n/);
      expect(parseDxf(dxf).insUnits).toBe(4);
      expect(write(line, 1)).toMatch(/\$MEASUREMENT\n70\n0\n/);
    });
    it(`${name}: unspecified unit writes no $MEASUREMENT (would be misread as inches)`, () => {
      expect(write(line, 0)).not.toContain("$MEASUREMENT");
    });
    it(`${name}: infinite construction lines stay out of the extents`, () => {
      expect(write(infinite, 4)).toMatch(/\$EXTMAX\n10\n10\.0\n/);
    });
  }
});
