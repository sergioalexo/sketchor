// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import { entitiesToSvgDocument, parseSvgText } from "./svg";
import type { CircleEntity, Entity, LineEntity } from "./entities";

/**
 * SV-03: an imported drawing keeps its stroke colour, fill, dashes and
 * weights. Without it every Inkscape/Figma file lands monochrome and solid,
 * and `display:none` helper geometry lands as real, cuttable lines.
 */

const svgOf = (body: string, attrs = 'width="100mm" height="100mm" viewBox="0 0 100 100"'): string => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const one = (body: string, attrs?: string): Entity => parseSvgText(svgOf(body, attrs)).entities[0];
const L = '<line x1="0" y1="0" x2="10" y2="0"';

describe("parseSvgText: styles (SV-03)", () => {
  it("reads presentation attributes: stroke → colour, stroke-width → lineweight in mm", () => {
    const e = one(`${L} stroke="#ff0000" stroke-width="2"/>`);
    expect(e.color).toBe("#ff0000");
    expect((e as LineEntity).lineweight).toBe(2); // 1 user unit = 1 mm in svgOf
  });

  it("scales stroke-width by the viewport (a 96-dpi file reads in mm)", () => {
    const e = one(`${L} stroke="red" stroke-width="96"/>`, 'viewBox="0 0 100 100"');
    expect((e as LineEntity).lineweight).toBeCloseTo(25.4, 2);
  });

  it("black stroke is the automatic colour, not a literal one", () => {
    expect(one(`${L} stroke="#000"/>`).color).toBeUndefined();
  });

  it("style= beats a <style> rule beats an attribute; specificity beats source order", () => {
    const sheet = "<style>.a{stroke:#00f} #x{stroke:#0f0} line{stroke:#aaa}</style>";
    expect(one(`${sheet}${L} class="a" stroke="red"/>`).color).toBe("#00f");
    expect(one(`${sheet}${L} id="x" class="a"/>`).color).toBe("#0f0");
    expect(one(`${sheet}${L} id="x" style="stroke:#123456"/>`).color).toBe("#123456");
    expect(one(`${sheet}${L}/>`).color).toBe("#aaa");
  });

  it("supports descendant selectors and CDATA sheets", () => {
    const { entities } = parseSvgText(svgOf(`<style><![CDATA[ g.cut line { stroke: #f00 } ]]></style><g class="cut">${L}/></g>${L}/>`));
    expect(entities.map((e) => e.color)).toEqual(["#f00", undefined]);
  });

  it("ignores @media blocks and selectors the engine cannot parse", () => {
    const e = one(`<style>@media print{line{stroke:red}} :::bad{stroke:blue} line{stroke:#0a0}</style>${L}/>`);
    expect(e.color).toBe("#0a0");
  });

  it("inherits stroke and dashes through <g>, with the child overriding", () => {
    const { entities } = parseSvgText(svgOf(`<g stroke="#f00" stroke-dasharray="6 3"><line x1="0" y1="0" x2="1" y2="0"/><line x1="0" y1="0" x2="1" y2="0" stroke="#0f0"/></g>`));
    expect(entities.map((e) => e.color)).toEqual(["#f00", "#0f0"]);
    expect(entities.map((e) => (e as LineEntity).linetype)).toEqual(["DASHED", "DASHED"]);
  });

  it("fill goes on closed shapes only; a fill-only shape's outline takes the fill colour", () => {
    const { entities } = parseSvgText(
      svgOf('<rect x="0" y="0" width="5" height="5" fill="#336699" stroke="none"/><polyline points="0,0 5,5 9,0" fill="#336699" stroke="#111"/><circle cx="5" cy="5" r="2" style="fill:#abcdef;stroke:#111"/>'),
    );
    expect(entities[0]).toMatchObject({ fill: "#336699", color: "#336699" });
    expect(entities[1].type).toBe("polyline");
    expect((entities[1] as { fill?: string }).fill).toBeUndefined();
    expect(entities[2]).toMatchObject({ fill: "#abcdef", color: "#111" });
  });

  it("url(#gradient) fills are not colours", () => {
    expect((one('<circle cx="5" cy="5" r="2" fill="url(#g)" stroke="#111"/>') as CircleEntity).fill).toBeUndefined();
  });

  it("skips display:none, visibility:hidden and no-stroke-no-fill, with one report line", () => {
    const r = parseSvgText(
      svgOf(`<g style="display:none">${L}/></g><g visibility="hidden">${L}/><line x1="0" y1="0" x2="1" y2="0" visibility="visible"/></g><line x1="0" y1="0" x2="1" y2="0" stroke="none" fill="none"/>${L}/>`),
    );
    expect(r.entities).toHaveLength(2);
    expect(r.warnings.some((w) => /3 hidden or invisible elements/.test(w))).toBe(true);
  });

  it("styles path-derived entities too", () => {
    const e = one('<path d="M0 0 C 5 5 10 5 15 0" stroke="#f0f"/>');
    expect(e.type).toBe("spline");
    expect(e.color).toBe("#f0f");
  });

  it("round-trips Sketchor's own export without gaining colours", () => {
    const l: LineEntity = { id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 100, y: 50 } };
    const c: CircleEntity = { id: "c", type: "circle", center: { x: 20, y: 30 }, radius: 12.5 };
    const back = parseSvgText(entitiesToSvgDocument([l, c], { padding: 0 }));
    expect(back.entities.every((e) => e.color === undefined)).toBe(true);
  });
});
