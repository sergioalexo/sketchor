// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import { parseSvgText } from "./svg";
import { boundsOf } from "./dxf";
import type { CircleEntity, Entity, LineEntity, PolylineEntity, TextEntity } from "./entities";

/**
 * SV-09: real-world-shaped SVG files (src/fixtures/svg/) and hostile input.
 *
 * The fixtures are small files written in the exact output style of each
 * tool — Inkscape's one-attribute-per-line + sodipodi/inkscape namespaces +
 * `style=""`, Illustrator's `<style>` classes + `_x20_` ids + unitless
 * viewBox, Figma's compact paths + root `fill="none"` + clip-path, a
 * LibreCAD-style mm file, and a `<symbol>`/`<use>` sheet. They are NOT byte
 * copies of exports (none of those programs run here): when a real export
 * surfaces a bug, add it beside these. Each test pins entity counts, bounds
 * in mm and the exact warning list, so a parser change that drops geometry
 * shows up as a diff here instead of as a customer's missing part.
 *
 * The second half is the repo rule for anything that parses a user file:
 * empty, truncated and malformed input must return (never throw, never
 * loop) and must never hand back a NaN/Infinity coordinate.
 */

const fixture = (name: string): string => readFileSync(join(__dirname, "fixtures", "svg", name), "utf8");
const count = (es: Entity[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of es) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
};
const geometry = (es: Entity[]): Entity[] => es.filter((e) => e.type !== "text");

describe("SVG fixtures", () => {
  it("inkscape: layers, relative curves, dashes, styles, tspan lines, display:none layer", () => {
    const r = parseSvgText(fixture("inkscape.svg"));
    expect(count(r.entities)).toEqual({ polyline: 1, spline: 1, circle: 1, text: 2 });
    expect(r.units).toMatchObject({ source: "declared", mmPerUserUnit: 1 });
    expect(r.entities.map((e) => e.layer)).toEqual(["Cut", "Cut", "Cut", "Notes", "Notes"]);
    expect(r.warnings).toEqual(["1 hidden or invisible element (display:none, visibility:hidden, or no stroke and no fill) skipped"]);

    const rect = r.entities[0] as PolylineEntity;
    expect(rect).toMatchObject({ closed: true, color: "#ff0000" });
    expect(rect.points.map((p) => [p.x, p.y])).toEqual([[20, -20], [70, -20], [70, -50], [20, -50]]);
    expect(rect.lineweight).toBeCloseTo(0.265, 3);

    const curve = r.entities[1];
    expect(curve).toMatchObject({ color: "#0000ff", linetype: "HIDDEN", lineweight: 0.5 }); // "2, 1" is closest to the 3/1.5 hidden pattern
    const circle = r.entities[2] as CircleEntity;
    expect(circle).toMatchObject({ fill: "#ffcc00", radius: 10 });
    expect(circle.center).toEqual({ x: 150, y: -40 });

    const [t1, t2] = r.entities.filter((e): e is TextEntity => e.type === "text");
    expect([t1.text, t2.text]).toEqual(["Part A", "second line"]);
    expect(t1.height).toBeCloseTo(5.64444, 5);
    expect(t2.at.y - t1.at.y).toBeCloseTo(-7.05, 6);

    const b = boundsOf(geometry(r.entities))!;
    expect([b.minX, b.maxX]).toEqual([20, 160]);
    expect(b.maxY).toBeCloseTo(-20, 6);
  });

  it("illustrator: <style> classes, decoded layer ids, unitless viewBox read at 96 dpi", () => {
    const r = parseSvgText(fixture("illustrator.svg"));
    expect(count(r.entities)).toEqual({ polyline: 1, line: 1, spline: 1, text: 1 });
    expect(r.units.source).toBe("assumed");
    expect(r.units.mmPerUserUnit).toBeCloseTo(25.4 / 96, 9);
    expect(r.entities.map((e) => e.layer)).toEqual(["Cut lines", "Cut lines", "Cut lines", "Labels"]);
    expect(r.warnings).toEqual([]);
    const poly = r.entities[0] as PolylineEntity;
    expect(poly).toMatchObject({ closed: true, color: "#231F20" });
    expect(poly.points[1].x).toBeCloseTo(100 * (25.4 / 96), 6);
    const label = r.entities[3] as TextEntity;
    expect(label.text).toBe("Label");
    expect(label.height).toBeCloseTo(12 * (25.4 / 96), 6); // .st3 { font-size: 12px } through the class list
    expect(label.at.x).toBeCloseTo(12 * (25.4 / 96), 6);
  });

  it("figma: root fill=none inherited, black stroke automatic, compact paths, clip-path reported", () => {
    const r = parseSvgText(fixture("figma.svg"));
    expect(count(r.entities)).toEqual({ polyline: 2, circle: 1, spline: 1 });
    expect(r.units.mmPerUserUnit).toBeCloseTo(25.4 / 96, 9);
    expect(r.warnings).toEqual(["1 element with clip-path, mask or filter were imported without that effect"]);
    const [card, box, dot, curve] = r.entities as [PolylineEntity, PolylineEntity, CircleEntity, Entity];
    expect(card).toMatchObject({ closed: true, fill: "#D9D9D9" });
    expect(box.closed).toBe(true);
    expect(box.color).toBeUndefined();
    expect(box.lineweight).toBeCloseTo(2 * (25.4 / 96), 2);
    expect(dot).toMatchObject({ fill: "#0D99FF", color: "#0A7ACC" });
    expect(curve.color).toBe("#F24822");
  });

  it("librecad-style mm file: lines, polyline, circle, elliptical arc, ellipse; exact bounds", () => {
    const r = parseSvgText(fixture("librecad.svg"));
    expect(count(r.entities)).toEqual({ line: 2, polyline: 2, circle: 1, ellipse: 1 });
    expect(r.warnings).toEqual([]);
    expect(r.entities.every((e) => e.color === undefined)).toBe(true); // stroke="black" is the automatic colour
    const b = boundsOf(r.entities)!;
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([10, 90, -50, -10]);
    const l = r.entities[0] as LineEntity;
    expect(Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y)).toBe(80);
  });

  it("symbols: <use> instances are placed through the symbol viewBox; the definitions draw nothing themselves", () => {
    const r = parseSvgText(fixture("symbols.svg"));
    expect(count(r.entities)).toEqual({ circle: 4, line: 6 });
    expect(r.warnings).toEqual([]);
    const centres = r.entities.filter((e): e is CircleEntity => e.type === "circle").map((c) => [c.center.x, c.center.y]);
    expect(centres).toEqual([[15, -15], [85, -15], [15, -85], [85, -85]]);
    const slot = r.entities.filter((e): e is LineEntity => e.type === "line" && e.color === "#f00");
    expect(slot).toHaveLength(2);
    expect(slot[0].a).toEqual({ x: 45, y: -48 });
  });

  it("every fixture gives every entity a unique id and only finite numbers", () => {
    for (const name of ["inkscape.svg", "illustrator.svg", "figma.svg", "librecad.svg", "symbols.svg"]) {
      const { entities } = parseSvgText(fixture(name));
      expect(new Set(entities.map((e) => e.id)).size).toBe(entities.length);
      expect(allFinite(entities)).toBe(true);
    }
  });
});

/** True when no number anywhere inside `v` is NaN or infinite. */
function allFinite(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === "object") return Object.values(v).every(allFinite);
  return true;
}

const svg = (body: string, attrs = 'width="100mm" height="100mm" viewBox="0 0 100 100"'): string => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`;

describe("SVG malformed and hostile input (never throws, always terminates, no NaN)", () => {
  const cases: [string, string][] = [
    ["empty", ""],
    ["whitespace", "   \n\t "],
    ["not xml", "hello world"],
    ["binary junk", "\u0000\u0001￾￿\u0008"],
    ["json", '{"svg": true}'],
    ["html", "<html><body><svg><line x1='0' y1='0' x2='1' y2='1'/></svg></body></html>"],
    ["unclosed root", "<svg><g><line x1='0' y1='0' x2='1' y2='1'/>"],
    ["mismatched tags", "<svg><g></svg></g>"],
    ["no root attrs", "<svg xmlns='http://www.w3.org/2000/svg'/>"],
    ["wrong namespace", "<svg><line x1='0' y1='0' x2='1' y2='1'/></svg>"],
    ["NaN and junk numbers", svg('<line x1="abc" y1="" x2="NaN" y2="--3"/><circle cx="x" cy="y" r="z"/><rect width="-5" height="-5"/><ellipse rx="1e999" ry="1"/>')],
    ["infinite numbers", svg('<circle cx="0" cy="0" r="1e999"/><line x1="1e999" y1="0" x2="0" y2="0"/><rect x="1e400" y="0" width="1" height="1"/>')],
    ["huge numbers", svg('<circle cx="1e300" cy="1e300" r="1e300"/><line x1="-1e308" y1="0" x2="1e308" y2="0"/>')],
    ["bad viewBox", svg('<line x1="0" y1="0" x2="1" y2="1"/>', 'viewBox="0 0 0 0" width="0" height="-1"')],
    ["bad viewBox text", svg('<line x1="0" y1="0" x2="1" y2="1"/>', 'viewBox="a b c d" width="1e999mm"')],
    ["bad transforms", svg('<g transform="matrix(1 2 3)"><g transform="scale(0)"><g transform="rotate(abc)"><line x1="0" y1="0" x2="1" y2="1"/></g></g></g>')],
    ["singular matrix", svg('<g transform="matrix(0 0 0 0 0 0)"><circle r="5"/><ellipse rx="2" ry="1"/><image width="1" height="1" href="data:image/png;base64,AA=="/></g>')],
    ["path garbage", svg('<path d="M"/><path d="M 1"/><path d="L 1 2"/><path d="Z Z Z"/><path d="M 0 0 C 1"/><path d="M 0 0 A 1 1 0 2 2 5 5"/><path d="M 0 0 L nan nan"/><path d="!@#$%^&*"/>')],
    ["path with a million commands", svg(`<path d="M 0 0 ${"l 1 1 ".repeat(100000)}"/>`)],
    ["polyline garbage", svg('<polyline points="1,2,3"/><polygon points=",,,"/><polyline points=""/><polygon points="a b c d"/>')],
    ["style garbage", svg('<style>{{{ }}} @media { .a { x: y } .b {} @@ ; ] [ ::: )( </style><line x1="0" y1="0" x2="1" y2="1" style=";;:;:;;" class="a b c"/>')],
    ["unbalanced style", svg('<style>.a{stroke:red</style><line class="a" x1="0" y1="0" x2="1" y2="1"/>')],
    ["style with huge selector list", svg(`<style>${".a,".repeat(5000)}.z{stroke:red}</style><line class="z" x1="0" y1="0" x2="1" y2="1"/>`)],
    ["use cycle", svg('<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g><use href="#a"/>')],
    ["use self", svg('<use id="u" href="#u"/>')],
    ["use of missing / external / empty href", svg('<use href="#nope"/><use href=""/><use/><use href="file.svg#x"/>')],
    ["use bomb", svg(`<defs><g id="u0"><line x1="0" y1="0" x2="1" y2="0"/></g>${Array.from({ length: 30 }, (_, i) => `<g id="u${i + 1}"><use href="#u${i}"/><use href="#u${i}"/></g>`).join("")}</defs><use href="#u30"/>`)],
    ["symbol with bad viewBox", svg('<symbol id="s" viewBox="0 0 0 0"><line x1="0" y1="0" x2="1" y2="1"/></symbol><use href="#s" width="1e999" height="-4"/>')],
    ["text garbage", svg('<text x="a b c" y="d" font-size="-5">x</text><text font-size="1e999">y</text><text><tspan dy="1e999" x="NaN">z</tspan></text><text/>')],
    ["deep tspan nesting", svg(`<text x="0" y="0">${"<tspan>".repeat(500)}deep${"</tspan>".repeat(500)}</text>`)],
    ["deep group nesting", svg(`${"<g>".repeat(3000)}<line x1="0" y1="0" x2="1" y2="1"/>${"</g>".repeat(3000)}`)],
    ["very deep group nesting (beyond the walker's nesting limit)", svg(`${"<g>".repeat(6000)}<line x1="0" y1="0" x2="1" y2="1"/>${"</g>".repeat(6000)}`)],
    ["many elements", svg('<line x1="0" y1="0" x2="1" y2="1"/>'.repeat(20000))],
    ["image junk", svg('<image width="1" height="1" href="data:"/><image href="javascript:alert(1)" width="1" height="1"/><image width="0" height="0"/>')],
    ["entities", '<!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&b;&b;</text></svg>'],
    ["comments and PI only", "<?xml version='1.0'?><!-- nothing -->"],
    ["CDATA style", svg('<style><![CDATA[ line { stroke: #f00 } ]]></style><line x1="0" y1="0" x2="1" y2="1"/>')],
  ];

  it.each(cases)("%s", (_name, text) => {
    let r: ReturnType<typeof parseSvgText> | undefined;
    expect(() => {
      r = parseSvgText(text);
    }).not.toThrow();
    expect(Array.isArray(r!.entities)).toBe(true);
    expect(Array.isArray(r!.warnings)).toBe(true);
    expect(allFinite(r!.entities)).toBe(true);
    expect(allFinite(r!.units)).toBe(true);
  });

  it("a truncated file at any point still returns", () => {
    for (const name of ["inkscape.svg", "illustrator.svg", "figma.svg", "librecad.svg", "symbols.svg"]) {
      const full = fixture(name);
      for (let i = 0; i < 60; i++) {
        const cut = Math.floor((full.length * i) / 60);
        const r = parseSvgText(full.slice(0, cut));
        expect(allFinite(r.entities)).toBe(true);
      }
    }
  });

  it("a hostile file does not run away: the use bomb and the million-command path stay bounded", () => {
    expect(parseSvgText(cases.find((c) => c[0] === "use bomb")![1]).entities.length).toBeLessThan(30000);
  });

  it("groups nested past the limit are skipped with a report line", () => {
    const r = parseSvgText(cases.find((c) => c[0] === "deep group nesting")![1]);
    expect(r.warnings.some((w) => /nested deeper/.test(w))).toBe(true);
  });

  it("malformed XML is reported, not thrown", () => {
    expect(parseSvgText("<svg><g></svg>").warnings.length).toBeGreaterThan(0);
  });
});
