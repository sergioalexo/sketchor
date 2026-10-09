import { describe, expect, it } from "vitest";
import { binaryDxfToText, isBinaryDxf } from "./dxfBinary";
import { decodeDxfBytes } from "./dxfText";
import { parseDxf } from "./dxf";

/**
 * X-11: a binary DXF used to be refused with a warning. These tests build
 * binary files by hand (typed values per group code) and check the result
 * parses to the same geometry as the ASCII form, plus that truncated or
 * garbage input terminates without throwing.
 */

type G = [number, string | number];

function encode(groups: G[]): Uint8Array {
  const parts: number[] = [];
  const sentinel = "AutoCAD Binary DXF\r\n\x1a\0";
  for (const ch of sentinel) parts.push(ch.charCodeAt(0));
  const f64 = (v: number) => Array.from(new Uint8Array(new Float64Array([v]).buffer));
  const i16 = (v: number) => Array.from(new Uint8Array(new Int16Array([v]).buffer));
  const i32 = (v: number) => Array.from(new Uint8Array(new Int32Array([v]).buffer));
  for (const [code, v] of groups) {
    if (code >= 255) parts.push(255, code & 0xff, code >> 8);
    else parts.push(code);
    if (typeof v === "string") {
      parts.push(...new TextEncoder().encode(v), 0);
    } else if ((code >= 10 && code <= 59) || (code >= 210 && code <= 239)) {
      parts.push(...f64(v));
    } else if (code >= 90 && code <= 99) {
      parts.push(...i32(v));
    } else {
      parts.push(...i16(v));
    }
  }
  return new Uint8Array(parts);
}

const FILE: G[] = [
  [0, "SECTION"], [2, "HEADER"], [9, "$INSUNITS"], [70, 4], [0, "ENDSEC"],
  [0, "SECTION"], [2, "ENTITIES"],
  [0, "LINE"], [8, "Walls"], [10, 1.5], [20, 2.25], [30, 0], [11, 10], [21, 20], [31, 0],
  [0, "CIRCLE"], [8, "Дірки"], [10, 5], [20, 5], [30, 0], [40, 2.5],
  [0, "ENDSEC"], [0, "EOF"],
];

describe("binary DXF", () => {
  const bytes = encode(FILE);

  it("is recognised by its sentinel", () => {
    expect(isBinaryDxf(bytes)).toBe(true);
    expect(isBinaryDxf(new TextEncoder().encode("0\nSECTION\n"))).toBe(false);
  });

  it("reads back to the same geometry, layers (UTF-8) and units as ASCII", () => {
    const r = parseDxf(decodeDxfBytes(bytes));
    expect(r.warnings.join(" ")).not.toContain("binary");
    expect(r.insUnits).toBe(4);
    expect(r.entities).toHaveLength(2);
    const line = r.entities.find((e) => e.type === "line");
    expect(line && line.type === "line" && line.a).toEqual({ x: 1.5, y: 2.25 });
    const circle = r.entities.find((e) => e.type === "circle");
    expect(circle && circle.type === "circle" && circle.radius).toBe(2.5);
    expect(circle?.layer).toBe("Дірки");
  });

  it("parseDxf also recovers a binary file handed over as one-char-per-byte text", () => {
    const asText = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    expect(parseDxf(asText).entities).toHaveLength(2);
  });

  it("handles extended (255-prefixed) group codes and 310 chunks", () => {
    const b = new Uint8Array([
      ...encode([]),
      255, 0xe8, 0x03, ...new TextEncoder().encode("APP"), 0, // 1000 string
      255, 0x36, 0x01, 3, 0xde, 0xad, 0xbe, // 310 chunk
    ]);
    expect(binaryDxfToText(b)).toBe("1000\nAPP\n310\nDEADBE\n");
  });

  it("truncated and garbage input terminate without throwing", () => {
    expect(() => binaryDxfToText(bytes.subarray(0, bytes.length - 5))).not.toThrow();
    expect(() => binaryDxfToText(bytes.subarray(0, 40))).not.toThrow();
    const junk = new Uint8Array(500).map((_, i) => (i * 37) & 0xff);
    junk.set(bytes.subarray(0, 22));
    expect(() => parseDxf(decodeDxfBytes(junk))).not.toThrow();
    expect(binaryDxfToText(bytes.subarray(0, 22))).toBe("\n");
  });
});
