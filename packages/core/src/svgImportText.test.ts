// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import { entitiesToSvgDocument, parseSvgText } from "./svg";
import type { CircleEntity, Entity, LineEntity, TextEntity } from "./entities";
import { parseFontSize } from "./svgStyle";

/**
 * SV-04: text, layers and `<use>`. Without them an Inkscape file loses every
 * label, lands on one layer, and a drawing built from reused symbols comes
 * back as nothing (or, before this, as the symbol's definition in the wrong place).
 */

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svgOf = (body: string, attrs = 'width="100mm" height="100mm" viewBox="0 0 100 100"', pre = ""): string => `${pre}<svg ${NS} ${attrs}>${body}</svg>`;
const texts = (body: string, attrs?: string): TextEntity[] => parseSvgText(svgOf(body, attrs)).entities.filter((e): e is TextEntity => e.type === "text");

describe("parseSvgText: text", () => {
  it("reads position, size and string (Y flipped, baseline-left)", () => {
    const [t] = texts('<text x="10" y="20" font-size="5">Hello</text>');
    expect(t).toMatchObject({ text: "Hello", height: 5, rotation: 0 });
    expect(t.at).toEqual({ x: 10, y: -20 });
  });

  it("font size: inherits through <g>, units convert, default is 16 px", () => {
    expect(texts('<g font-size="2mm"><text x="0" y="0">a</text></g>')[0].height).toBeCloseTo((2 * 96) / 25.4, 6);
    expect(texts('<text x="0" y="0">a</text>')[0].height).toBe(16);
    expect(parseFontSize("12pt")).toBeCloseTo(16, 6);
    expect(parseFontSize("bogus")).toBeNull();
  });

  it("scales font size by the viewport (a 96-dpi file reads in mm)", () => {
    expect(texts('<text x="0" y="0" font-size="96">a</text>', 'viewBox="0 0 100 100"')[0].height).toBeCloseTo(25.4, 4);
  });

  it("rotation comes from the transform", () => {
    const [t] = texts('<text transform="rotate(90 10 10)" x="10" y="10" font-size="4">up</text>');
    expect(t.rotation).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("each tspan with its own x/y/dy is a line; inline tspans join", () => {
    const r = texts('<text x="5" y="10" font-size="4"><tspan x="5" y="10">one</tspan><tspan x="5" dy="6">two</tspan></text><text x="0" y="50" font-size="4">a <tspan>b</tspan> c</text>');
    expect(r.map((t) => t.text)).toEqual(["one", "two", "a b c"]);
    expect(r[1].at.y).toBeCloseTo(-16, 6);
  });

  it("text-anchor middle/end shifts the start by the estimated width", () => {
    const [start] = texts('<text x="50" y="0" font-size="10">abcd</text>');
    const [mid] = texts('<text x="50" y="0" font-size="10" text-anchor="middle">abcd</text>');
    const [end] = texts('<text x="50" y="0" font-size="10" text-anchor="end">abcd</text>');
    expect(start.at.x - mid.at.x).toBeCloseTo(11, 6); // 4 glyphs * 10 * 0.55 / 2
    expect(start.at.x - end.at.x).toBeCloseTo(22, 6);
  });

  it("fill sets the colour (black stays automatic); empty and hidden text is dropped", () => {
    const r = texts('<text x="0" y="0" fill="#f00">r</text><text x="0" y="0" fill="#000">k</text><text x="0" y="0">   </text><text x="0" y="0" display="none">h</text>');
    expect(r.map((t) => [t.text, t.color])).toEqual([
      ["r", "#f00"],
      ["k", undefined],
    ]);
  });

  it("round-trips Sketchor's own text export", () => {
    const t: TextEntity = { id: "t", type: "text", at: { x: 10, y: 20 }, text: "Part 7", height: 4, rotation: 0.5 };
    const back = parseSvgText(entitiesToSvgDocument([t], { padding: 0 })).entities[0] as TextEntity;
    expect(back.text).toBe("Part 7");
    expect(back.height).toBeCloseTo(4, 3);
    expect(back.rotation).toBeCloseTo(0.5, 3);
  });
});

describe("parseSvgText: layers", () => {
  it("an Inkscape layer group names its entities' layer (label, else id); nearest layer wins", () => {
    const { entities } = parseSvgText(
      svgOf(
        `<g inkscape:groupmode="layer" inkscape:label="Cut" id="layer1"><line x1="0" y1="0" x2="1" y2="0"/></g>` +
          `<g inkscape:groupmode="layer" id="layer2"><line x1="0" y1="0" x2="1" y2="0"/><g inkscape:groupmode="layer" inkscape:label="Sub"><line x1="0" y1="0" x2="1" y2="0"/></g></g>` +
          `<g id="plain"><line x1="0" y1="0" x2="1" y2="0"/></g>`,
      ),
    );
    expect(entities.map((e) => e.layer)).toEqual(["Cut", "layer2", "Sub", undefined]);
  });

  it("an Illustrator top-level <g id> is a layer (decoded), but only in an Illustrator file", () => {
    const body = '<g id="Cut_x20_lines"><line x1="0" y1="0" x2="1" y2="0"/></g>';
    expect(parseSvgText(svgOf(body, undefined, "<!-- Generator: Adobe Illustrator 27.0 -->")).entities[0].layer).toBe("Cut lines");
    expect(parseSvgText(svgOf(body)).entities[0].layer).toBeUndefined();
  });

  it("text lands on its layer too", () => {
    const t = parseSvgText(svgOf('<g inkscape:groupmode="layer" inkscape:label="Notes"><text x="0" y="0">n</text></g>')).entities[0];
    expect(t.layer).toBe("Notes");
  });
});

describe("parseSvgText: <use>", () => {
  const DEFS = '<defs><circle id="hole" cx="0" cy="0" r="2"/><g id="pair"><line x1="0" y1="0" x2="5" y2="0"/><circle cx="5" cy="0" r="1"/></g></defs>';
  const centers = (es: Entity[]): [number, number][] => es.filter((e): e is CircleEntity => e.type === "circle").map((c) => [c.center.x, -c.center.y]);

  it("expands each instance at its x/y and transform", () => {
    const { entities } = parseSvgText(svgOf(`${DEFS}<use href="#hole" x="10" y="10"/><use xlink:href="#hole" transform="translate(30 40)"/>`));
    expect(centers(entities)).toEqual([
      [10, 10],
      [30, 40],
    ]);
  });

  it("expands a referenced group and inherits the use's style", () => {
    const { entities } = parseSvgText(svgOf(`${DEFS}<use href="#pair" x="10" y="10" stroke="#0a0"/>`));
    expect(entities).toHaveLength(2);
    expect(entities.every((e) => e.color === "#0a0")).toBe(true);
    expect((entities[0] as LineEntity).a).toEqual({ x: 10, y: -10 });
  });

  it("a <symbol> is placed through its viewBox and the use's width/height", () => {
    const { entities } = parseSvgText(svgOf('<symbol id="s" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="0"/></symbol><use href="#s" x="20" y="20" width="40" height="40"/>'));
    const l = entities[0] as LineEntity;
    expect(l.b.x - l.a.x).toBeCloseTo(40, 6);
    expect(l.a).toEqual({ x: 20, y: -20 });
  });

  it("the layer of a used shape is the layer of the <use>, not of the <defs>", () => {
    const { entities } = parseSvgText(svgOf(`<g inkscape:groupmode="layer" inkscape:label="Defs">${DEFS}</g><g inkscape:groupmode="layer" inkscape:label="Holes"><use href="#hole"/></g>`));
    expect(entities.map((e) => e.layer)).toEqual(["Holes"]);
  });

  it("terminates on a self-referencing use and reports missing targets", () => {
    const r = parseSvgText(svgOf('<g id="a"><line x1="0" y1="0" x2="1" y2="0"/><use href="#a"/></g><use href="#a"/><use href="#nope"/><use href="http://x/y.svg#z"/>'));
    expect(r.entities.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => /cycle/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /missing or external/.test(w))).toBe(true);
  });

  it("caps an exponential <use> chain instead of hanging", () => {
    let defs = '<g id="u0"><line x1="0" y1="0" x2="1" y2="0"/></g>';
    for (let i = 1; i <= 20; i++) defs += `<g id="u${i}"><use href="#u${i - 1}"/><use href="#u${i - 1}"/></g>`;
    const r = parseSvgText(svgOf(`<defs>${defs}</defs><use href="#u20"/>`));
    expect(r.entities.length).toBeLessThan(25000);
    expect(r.warnings.some((w) => /too many/.test(w))).toBe(true);
  });

  it("reports clip-path / mask / filter as ignored", () => {
    const r = parseSvgText(svgOf('<line x1="0" y1="0" x2="1" y2="0" clip-path="url(#c)"/>'));
    expect(r.entities).toHaveLength(1);
    expect(r.warnings.some((w) => /clip-path, mask or filter/.test(w))).toBe(true);
  });
});
