import { describe, expect, it } from "vitest";
import { parseLength, parseTypedInput, resolveTypedInput } from "./typedInput";

/**
 * Typed input is how precise geometry gets drawn: "100<45" has to land
 * exactly where a CAD user expects, in the unit they think in. A unit
 * slip here silently draws a part 25.4× the wrong size, and a wrong
 * relative/absolute reading puts it somewhere else entirely.
 */

describe("parseLength", () => {
  it("reads the display unit when there is no suffix", () => {
    expect(parseLength("100", "mm")).toBe(100);
    expect(parseLength("4", "in")).toBeCloseTo(101.6, 9);
    expect(parseLength("1.5", "m")).toBeCloseTo(1500, 9);
  });

  it("honours an explicit suffix over the display unit", () => {
    expect(parseLength("4in", "mm")).toBeCloseTo(101.6, 9);
    expect(parseLength("1200mm", "in")).toBe(1200);
    expect(parseLength("2ft", "mm")).toBeCloseTo(609.6, 9);
    expect(parseLength("30cm", "in")).toBe(300);
  });

  it("reads feet and inches", () => {
    expect(parseLength(`2'6"`, "mm")).toBeCloseTo(762, 9);
    expect(parseLength(`2'6`, "mm")).toBeCloseTo(762, 9);
    expect(parseLength(`2'`, "mm")).toBeCloseTo(609.6, 9);
    expect(parseLength(`6"`, "mm")).toBeCloseTo(152.4, 9);
    expect(parseLength(`-1'`, "mm")).toBeCloseTo(-304.8, 9);
  });

  it("rejects what isn't a number", () => {
    expect(parseLength("", "mm")).toBeNull();
    expect(parseLength("abc", "mm")).toBeNull();
    expect(parseLength("10px", "mm")).toBeNull();
    expect(parseLength("1,000", "mm")).toBeNull();
  });
});

describe("parseTypedInput", () => {
  it("classifies each form of the grammar", () => {
    expect(parseTypedInput("100", "mm")).toEqual({ kind: "length", length: 100 });
    expect(parseTypedInput("100<45", "mm")).toEqual({ kind: "polar", length: 100, angleDeg: 45 });
    expect(parseTypedInput("@100<45", "mm")).toEqual({ kind: "polar", length: 100, angleDeg: 45 });
    expect(parseTypedInput("50,20", "mm")).toEqual({ kind: "absolute", x: 50, y: 20 });
    expect(parseTypedInput("@50,-20", "mm")).toEqual({ kind: "relative", dx: 50, dy: -20 });
    expect(parseTypedInput(" @ 50 , 20 ".replace(/ /g, ""), "mm")).toEqual({ kind: "relative", dx: 50, dy: 20 });
  });

  it("converts each component with the unit", () => {
    const abs = parseTypedInput("2,3", "in");
    expect(abs?.kind).toBe("absolute");
    if (abs?.kind === "absolute") {
      // 1/25.4 isn't exact in binary; a nanometre is more than precise enough.
      expect(abs.x).toBeCloseTo(50.8, 6);
      expect(abs.y).toBeCloseTo(76.2, 6);
    }
    expect(parseTypedInput("1in,10mm", "mm")).toEqual({ kind: "absolute", x: 25.4, y: 10 });
  });

  it("returns null for incomplete input rather than guessing", () => {
    expect(parseTypedInput("", "mm")).toBeNull();
    expect(parseTypedInput("@", "mm")).toBeNull();
    expect(parseTypedInput("100<", "mm")).toBeNull();
    expect(parseTypedInput("50,", "mm")).toBeNull();
    expect(parseTypedInput("1,2,3", "mm")).toBeNull();
  });
});

describe("resolveTypedInput", () => {
  const last = { x: 10, y: 10 };
  it("absolute ignores the anchor; relative and polar add to it", () => {
    expect(resolveTypedInput({ kind: "absolute", x: 5, y: 6 }, null, null)).toEqual({ x: 5, y: 6 });
    expect(resolveTypedInput({ kind: "relative", dx: 5, dy: -4 }, last, null)).toEqual({ x: 15, y: 6 });
    const p = resolveTypedInput({ kind: "polar", length: 10, angleDeg: 90 }, last, null)!;
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(20, 9);
  });

  it("a bare length runs from the anchor toward the cursor", () => {
    const p = resolveTypedInput({ kind: "length", length: 50 }, last, { x: 13, y: 14 })!;
    expect(p.x).toBeCloseTo(40, 9);
    expect(p.y).toBeCloseTo(50, 9);
  });

  it("refuses anchored forms without an anchor, and a length with the cursor on the anchor", () => {
    expect(resolveTypedInput({ kind: "relative", dx: 1, dy: 1 }, null, null)).toBeNull();
    expect(resolveTypedInput({ kind: "polar", length: 1, angleDeg: 0 }, null, null)).toBeNull();
    expect(resolveTypedInput({ kind: "length", length: 1 }, last, null)).toBeNull();
    expect(resolveTypedInput({ kind: "length", length: 1 }, last, last)).toBeNull();
  });
});
