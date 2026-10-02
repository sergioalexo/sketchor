import { describe, expect, it } from "vitest";
import { ACI_PALETTE, aciToHex, hexToRgb, nearestAci } from "./aci";

/**
 * X-04: the ACI table is the thing every DXF reader compares an entity's
 * colour 62 against, so a wrong entry silently recolours geometry in real
 * CAD software even though it round-trips fine through Sketchor's own
 * parser. Pinned against known AutoCAD defaults, not just internal
 * consistency.
 */

describe("ACI_PALETTE", () => {
  it("has all 256 entries", () => {
    expect(ACI_PALETTE).toHaveLength(256);
  });

  it("matches the well-known AutoCAD defaults for the first 9 indices", () => {
    expect(ACI_PALETTE.slice(0, 9)).toEqual([
      "#000000", "#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ffffff", "#808080",
    ]);
  });

  it("every entry parses as a 6-digit hex colour", () => {
    for (const hex of ACI_PALETTE) expect(hexToRgb(hex)).not.toBeNull();
  });
});

describe("hexToRgb", () => {
  it("parses with or without a leading #", () => {
    expect(hexToRgb("#5b96ff")).toEqual([0x5b, 0x96, 0xff]);
    expect(hexToRgb("5b96ff")).toEqual([0x5b, 0x96, 0xff]);
  });

  it("rejects anything that isn't 6 hex digits", () => {
    expect(hexToRgb("red")).toBeNull();
    expect(hexToRgb("#fff")).toBeNull();
    expect(hexToRgb("rgba(1,2,3,0.5)")).toBeNull();
  });
});

describe("aciToHex", () => {
  it("round-trips an in-range index", () => {
    expect(aciToHex(1)).toBe("#ff0000");
    expect(aciToHex(7)).toBe("#ffffff");
  });

  it("falls back to index 7 out of range", () => {
    expect(aciToHex(999)).toBe(ACI_PALETTE[7]);
    expect(aciToHex(-1)).toBe(ACI_PALETTE[7]);
  });
});

describe("nearestAci", () => {
  it("finds an exact match", () => {
    expect(nearestAci("#ff0000")).toBe(1);
    expect(nearestAci("#00ff00")).toBe(3);
  });

  it("finds the closest palette entry for an arbitrary colour", () => {
    // Sketchor's own selection blue — not an exact ACI entry, but should land near the cyan/blue band.
    const idx = nearestAci("#5b96ff");
    expect(ACI_PALETTE[idx]).toBeDefined();
    const [r, g, b] = hexToRgb(ACI_PALETTE[idx])!;
    expect(b).toBeGreaterThan(r); // a blue-ish match, not a red or green one
  });

  it("never returns 0 (ByBlock isn't a real colour)", () => {
    for (const hex of ["#000000", "#010101", "#fefefe"]) expect(nearestAci(hex)).not.toBe(0);
  });

  it("falls back to 7 for an unparseable colour", () => {
    expect(nearestAci("cornflowerblue")).toBe(7);
  });
});
