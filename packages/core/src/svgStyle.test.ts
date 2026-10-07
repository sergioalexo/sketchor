import { describe, expect, it } from "vitest";
import { isBlack, nearestLinetype, paintColor, parseDashArray, parseDeclarations, parseStyleSheet, parseUserLength, specificity } from "./svgStyle";

/**
 * The pure half of SVG styling: if the cascade order or the dash→linetype
 * match is wrong, every Inkscape/Illustrator/Figma drawing imports in the
 * wrong colour, weight or linetype with no warning.
 */
describe("svgStyle", () => {
  it("parses declarations tolerantly", () => {
    expect(parseDeclarations("Stroke: #f00 ; fill:none!important;;bogus; /* c */ stroke-width : 2")).toEqual({ stroke: "#f00", fill: "none", "stroke-width": "2" });
    expect(parseDeclarations("")).toEqual({});
  });

  it("orders selectors by specificity", () => {
    expect(specificity("path")).toBeLessThan(specificity(".a"));
    expect(specificity(".a")).toBeLessThan(specificity("g .a"));
    expect(specificity("g .a")).toBeLessThan(specificity("#x"));
    expect(specificity("path.a.b")).toBeGreaterThan(specificity(".a"));
  });

  it("parses a sheet: selector lists, comments, CDATA; skips @-rules", () => {
    const rules = parseStyleSheet("<![CDATA[ /* x */ .a, #b { stroke:red } @media print { .c { fill:blue } } @import url(x.css); path{fill:none} ]]>");
    expect(rules.map((r) => r.selector)).toEqual([".a", "#b", "path"]);
    expect(rules[2].decls).toEqual({ fill: "none" });
  });

  it("never throws or hangs on broken sheets", () => {
    for (const bad of ["", "{", "}", ".a{", ".a{stroke:red", "@media{", "@", "a{b{c{", "\u0000￿", ".a{}}}"]) {
      expect(() => parseStyleSheet(bad)).not.toThrow();
    }
  });

  it("resolves paints", () => {
    expect(paintColor("none")).toBeNull();
    expect(paintColor("url(#g1)")).toBeNull();
    expect(paintColor("currentColor", "#0f0")).toBe("#0f0");
    expect(paintColor("#abc")).toBe("#abc");
    expect(paintColor(undefined)).toBeUndefined();
    expect(isBlack("rgb(0, 0, 0)")).toBe(true);
    expect(isBlack("#000")).toBe(true);
    expect(isBlack("#010101")).toBe(false);
  });

  it("parses lengths and dash arrays", () => {
    expect(parseUserLength("2.5px")).toBe(2.5);
    expect(parseUserLength("2mm")).toBeNull();
    expect(parseDashArray("5 3 1")).toEqual([5, 3, 1, 5, 3, 1]);
    expect(parseDashArray("none")).toBeNull();
    expect(parseDashArray("0 0")).toBeNull();
    expect(parseDashArray("a,b")).toBeNull();
  });

  it("matches a dash pattern to the nearest builtin linetype", () => {
    expect(nearestLinetype([6, 3])).toBe("DASHED");
    expect(nearestLinetype([3, 1.5])).toBe("HIDDEN");
    expect(nearestLinetype([0.1, 3])).toBe("DOT");
    expect(nearestLinetype([12, 3, 3, 3])).toBe("CENTER");
    expect(nearestLinetype([7, 7, 7, 7, 7, 7, 7])).toBe("DASHED");
  });
});
