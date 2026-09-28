// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { entitiesToSvgDocument, parseSvgText } from "./svg";
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity } from "./entities";
import type { Point } from "./geometry";

/**
 * Full-fidelity SVG import and export. The import half runs on the browser's
 * DOMParser, so this file needs a DOM environment (see the docblock above) —
 * the rest of the core suite stays on the plain node environment.
 *
 * Export maps world units 1:1 into the viewBox with Y flipped; import undoes
 * the flip but has no way to recover the viewBox origin, so a round-trip
 * preserves shape and size exactly and lands the drawing translated by a
 * fixed offset. Several entity types are also renderings rather than
 * records — a point becomes a dot, an arc becomes a tessellated path — and
 * those degrade on the way back. Both facts are pinned below.
 */

const line = (): LineEntity => ({ id: "l", type: "line", a: { x: 0, y: 0 }, b: { x: 100, y: 50 } });
const circle = (): CircleEntity => ({ id: "c", type: "circle", center: { x: 20, y: 30 }, radius: 12.5 });

/** Default root: 100×100 mm over a 100×100 viewBox, so 1 user unit = 1 mm and coordinates read back as written. */
const svgOf = (body: string, attrs = 'width="100mm" height="100mm" viewBox="0 0 100 100"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

const pointsOf = (e: Entity): Point[] => {
  if (e.type === "polyline") return e.points;
  if (e.type === "line") return [e.a, e.b];
  if (e.type === "point") return [e.p];
  if (e.type === "circle") return [e.center];
  if (e.type === "text") return [e.at];
  if (e.type === "image") return [e.insert];
  return [e.center];
};

const closeTo = (p: Point, x: number, y: number, digits = 6) => {
  expect(p.x).toBeCloseTo(x, digits);
  expect(p.y).toBeCloseTo(y, digits);
};

/* -------------------------------- export -------------------------------- */

describe("entitiesToSvgDocument", () => {
  it("emits a real SVG document with a 1:1 viewBox", () => {
    const text = entitiesToSvgDocument([line()]);
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    // Bounds 100x50 plus the default padding of 5 on every side.
    expect(text).toContain('width="110mm" height="60mm" viewBox="0 0 110 60"');
    expect(text).toContain('stroke-width="0.25"');
    expect(text.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("flips Y so world up becomes SVG down", () => {
    const text = entitiesToSvgDocument([line()]);
    // a=(0,0) is the *bottom* left of the drawing, so it gets the larger SVG y.
    expect(text).toContain('x1="5" y1="55" x2="105" y2="5"');
  });

  it("honours the padding option in both the size and the offset", () => {
    const text = entitiesToSvgDocument([line()], { padding: 20 });
    expect(text).toContain('width="140mm" height="90mm"');
    expect(text).toContain('x1="20" y1="70"');
  });

  it("falls back to a fixed box for an empty drawing", () => {
    const text = entitiesToSvgDocument([]);
    expect(text).toContain('width="110mm" height="110mm"');
    expect(parseSvgText(text).entities).toEqual([]);
  });

  it("groups entities by layer", () => {
    const text = entitiesToSvgDocument([
      { ...line(), layer: "walls" },
      { ...circle(), layer: "holes" },
      { ...line(), id: "l2", layer: "walls" },
    ]);
    expect([...text.matchAll(/data-layer="([^"]+)"/g)].map((m) => m[1])).toEqual(["walls", "holes"]);
    expect(text.match(/<g data-layer="walls">.*?<\/g>/s)![0].match(/<line/g)).toHaveLength(2);
  });

  it("escapes XML metacharacters in a layer name", () => {
    const text = entitiesToSvgDocument([{ ...line(), layer: 'a&b<c>"d"' }]);
    expect(text).toContain('data-layer="a&amp;b&lt;c&gt;&quot;d&quot;"');
  });

  it("writes a per-entity colour as a stroke override", () => {
    const text = entitiesToSvgDocument([{ ...line(), color: "#ff0000" }]);
    expect(text).toContain('<line x1="5" y1="55" x2="105" y2="5" stroke="#ff0000"/>');
  });

  it("fills closed shapes only", () => {
    const closed: PolylineEntity = {
      id: "p",
      type: "polyline",
      fill: "#00ff00",
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      closed: true,
    };
    expect(entitiesToSvgDocument([closed])).toContain('fill="#00ff00" fill-opacity="0.3"');
    expect(entitiesToSvgDocument([{ ...closed, closed: false }])).not.toContain("fill-opacity");
    expect(entitiesToSvgDocument([{ ...circle(), fill: "#00ff00" }])).toContain("fill-opacity");
    // An open shape's fill would paint a phantom chord, so it is ignored.
    expect(entitiesToSvgDocument([{ ...line(), fill: "#00ff00" }])).not.toContain("fill-opacity");
  });

  it("closes a closed polyline's path with Z", () => {
    const closed: PolylineEntity = {
      id: "p",
      type: "polyline",
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      closed: true,
    };
    expect(entitiesToSvgDocument([closed])).toMatch(/d="M[^"]*Z"/);
    expect(entitiesToSvgDocument([{ ...closed, closed: false }])).not.toMatch(/d="[^"]*Z"/);
  });

  it("renders a point as a dot sized off the stroke width, not the drawing scale", () => {
    const p: PointEntity = { id: "p", type: "point", p: { x: 0, y: 0 } };
    expect(entitiesToSvgDocument([p, line()], { strokeWidth: 2 })).toContain('r="3" fill="#000000" stroke="none"');
  });
});

/* -------------------------------- import -------------------------------- */

describe("parseSvgText: shapes", () => {
  it("reads a line, flipping Y", () => {
    const [e] = parseSvgText(svgOf('<line x1="1" y1="2" x2="3" y2="4"/>')).entities as LineEntity[];
    expect(e.type).toBe("line");
    closeTo(e.a, 1, -2);
    closeTo(e.b, 3, -4);
  });

  it("reads a circle and skips a zero-radius one", () => {
    const [e] = parseSvgText(svgOf('<circle cx="10" cy="20" r="5"/>')).entities as CircleEntity[];
    expect(e).toMatchObject({ type: "circle", radius: 5 });
    closeTo(e.center, 10, -20);
    expect(parseSvgText(svgOf('<circle cx="0" cy="0" r="0"/>')).entities).toEqual([]);
  });

  it("averages a non-circular ellipse's radii and says so", () => {
    const result = parseSvgText(svgOf('<ellipse cx="0" cy="0" rx="10" ry="20"/>'));
    expect((result.entities[0] as CircleEntity).radius).toBe(15);
    expect(result.warnings).toEqual(["an <ellipse> was not circular — imported as the average radius"]);
  });

  it("takes a near-circular ellipse without complaint", () => {
    const result = parseSvgText(svgOf('<ellipse cx="0" cy="0" rx="10" ry="10.1"/>'));
    expect(result.warnings).toEqual([]);
    expect(result.entities).toHaveLength(1);
  });

  it("reads a rect as a closed four-corner polyline", () => {
    const [e] = parseSvgText(svgOf('<rect x="1" y="2" width="10" height="20"/>')).entities as PolylineEntity[];
    expect(e.closed).toBe(true);
    expect(e.points).toHaveLength(4);
    closeTo(e.points[0], 1, -2);
    closeTo(e.points[2], 11, -22);
  });

  it("distinguishes polyline from polygon by the closed flag", () => {
    const open = parseSvgText(svgOf('<polyline points="0,0 10,0 10,10"/>')).entities[0] as PolylineEntity;
    const closed = parseSvgText(svgOf('<polygon points="0,0 10,0 10,10"/>')).entities[0] as PolylineEntity;
    expect(open.closed).toBe(false);
    expect(closed.closed).toBe(true);
    expect(open.points).toHaveLength(3);
  });

  it("accepts either separator in a points list and ignores a stray coordinate", () => {
    const e = parseSvgText(svgOf('<polyline points="0 0  10,0 10 10 5"/>')).entities[0] as PolylineEntity;
    expect(e.points).toHaveLength(3);
  });

  it("skips a points list too short to draw", () => {
    expect(parseSvgText(svgOf('<polyline points="0,0"/>')).entities).toEqual([]);
  });
});

describe("parseSvgText: transforms", () => {
  const at = (body: string) => pointsOf(parseSvgText(svgOf(body)).entities[0]);

  it("applies translate, scale and matrix", () => {
    closeTo(at('<line transform="translate(10,5)" x1="0" y1="0" x2="1" y2="0"/>')[0], 10, -5);
    closeTo(at('<line transform="scale(2)" x1="3" y1="4" x2="0" y2="0"/>')[0], 6, -8);
    closeTo(at('<line transform="scale(2,3)" x1="3" y1="4" x2="0" y2="0"/>')[0], 6, -12);
    closeTo(at('<line transform="matrix(1,0,0,1,5,7)" x1="0" y1="0" x2="1" y2="0"/>')[0], 5, -7);
  });

  it("applies rotate about the origin and about a given centre", () => {
    closeTo(at('<line transform="rotate(90)" x1="10" y1="0" x2="0" y2="0"/>')[0], 0, -10);
    closeTo(at('<line transform="rotate(90,10,0)" x1="10" y1="0" x2="0" y2="0"/>')[0], 10, 0);
  });

  it("composes a transform list left to right", () => {
    // translate then scale: the scale applies first, in the translated frame.
    closeTo(at('<line transform="translate(10,0) scale(2)" x1="1" y1="0" x2="0" y2="0"/>')[0], 12, 0);
  });

  it("multiplies nested group transforms", () => {
    const e = parseSvgText(
      svgOf('<g transform="translate(10,0)"><g transform="translate(0,5)"><line x1="0" y1="0" x2="1" y2="0"/></g></g>'),
    ).entities[0];
    closeTo(pointsOf(e)[0], 10, -5);
  });

  it("scales a circle's radius by the matrix", () => {
    const e = parseSvgText(svgOf('<g transform="scale(3)"><circle cx="0" cy="0" r="4"/></g>')).entities[0] as CircleEntity;
    expect(e.radius).toBeCloseTo(12, 9);
  });

  it("ignores an unparseable transform rather than dropping the shape", () => {
    closeTo(at('<line transform="skewX(30)" x1="1" y1="2" x2="0" y2="0"/>')[0], 1, -2);
  });
});

describe("parseSvgText: paths", () => {
  const path = (d: string) => parseSvgText(svgOf(`<path d="${d}"/>`));
  const first = (d: string) => path(d).entities[0] as PolylineEntity;

  it("reads absolute M/L/H/V and closes on Z", () => {
    const e = first("M0 0 L10 0 H20 V10 Z");
    expect(e.points).toEqual([
      { x: 0, y: -0 },
      { x: 10, y: -0 },
      { x: 20, y: -0 },
      { x: 20, y: -10 },
    ]);
    expect(e.closed).toBe(true);
  });

  it("reads relative commands", () => {
    const e = first("m5 5 l10 0 v10");
    closeTo(e.points[0], 5, -5);
    closeTo(e.points[1], 15, -5);
    closeTo(e.points[2], 15, -15);
  });

  it("treats extra coordinate pairs after M as an implicit lineto", () => {
    const e = first("M0 0 10 0 20 0");
    expect(e.points).toHaveLength(3);
  });

  it("splits subpaths into separate entities", () => {
    const { entities } = path("M0 0 L10 0 M50 0 L60 0");
    expect(entities).toHaveLength(2);
    closeTo(pointsOf(entities[1])[0], 50, 0);
  });

  it("keeps one whole subpath as a single polyline, not a line per segment", () => {
    expect(path("M0 0 L10 0 L10 10 L0 10").entities).toHaveLength(1);
  });

  it("flattens a cubic Bézier onto the true curve instead of dropping it", () => {
    // Quarter circle of radius 10 about (10, 0) as a cubic (k = 0.5523).
    const result = path("M0 0 C0 5.5228 4.4772 10 10 10");
    const e = result.entities[0] as PolylineEntity;
    expect(e.points.length).toBeGreaterThan(8);
    closeTo(e.points[0], 0, 0);
    closeTo(e.points[e.points.length - 1], 10, -10);
    for (const p of e.points) expect(Math.hypot(p.x - 10, p.y - 0)).toBeCloseTo(10, 1);
    expect(result.warnings).toEqual([]);
  });

  it("elevates a quadratic exactly", () => {
    const q = first("M0 0 Q5 10 10 0");
    // The parabola's apex is at t=.5: y = 5 in SVG, -5 in world.
    expect(q.points.reduce((m, p) => Math.min(m, p.y), 0)).toBeCloseTo(-5, 2);
    closeTo(q.points[q.points.length - 1], 10, 0);
  });

  it("reflects the previous control point for S after C and for T after Q", () => {
    expect(first("M0 0 C0 10 10 10 10 0 S20 -10 20 0").points).toEqual(first("M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0").points);
    expect(first("M0 0 Q5 10 10 0 T20 0").points).toEqual(first("M0 0 Q5 10 10 0 Q15 -10 20 0").points);
  });

  it("S with no preceding cubic uses the current point as its first control point", () => {
    expect(first("M0 0 S10 10 20 0").points).toEqual(first("M0 0 C0 0 10 10 20 0").points);
  });

  it("reads relative curve commands and implicitly repeated curve arguments", () => {
    const abs = first("M0 0 C0 5 5 10 10 10 C15 10 20 5 20 0").points;
    expect(first("M0 0 c0 5 5 10 10 10 c5 0 10 -5 10 -10").points).toEqual(abs);
    expect(first("M0 0 C0 5 5 10 10 10 15 10 20 5 20 0").points).toEqual(abs);
  });

  it("flattens to a tolerance in world units, so a scaled-up curve gets more points", () => {
    const d = "M0 0 C0 10 10 10 10 0";
    const small = parseSvgText(svgOf(`<path d="${d}"/>`)).entities[0] as PolylineEntity;
    const big = parseSvgText(svgOf(`<g transform="scale(100)"><path d="${d}"/></g>`)).entities[0] as PolylineEntity;
    expect(big.points.length).toBeGreaterThan(small.points.length);
  });

  it("parses compact number forms: 1.5.5 is two numbers, -.5e-3 is one", () => {
    const e = first("M1.5.5L-.5e-3-.5e-3");
    closeTo(e.points[0], 1.5, -0.5);
    closeTo(e.points[1], -0.0005, 0.0005, 9);
  });

  it("reads arc flags run together with the next number", () => {
    expect(first("M0 0a5 5 0 0110 0").points).toEqual(first("M0 0a5 5 0 0 1 10 0").points);
  });

  it("closes a curved shape with Z", () => {
    expect(first("M0 0 C0 10 10 10 10 0 Z").closed).toBe(true);
  });

  it("tessellates an elliptical arc, honouring the sweep flag", () => {
    const sweep0 = first("M0 0 A5 5 0 0 0 10 0");
    const sweep1 = first("M0 0 A5 5 0 0 1 10 0");
    closeTo(sweep0.points[0], 0, 0);
    closeTo(sweep0.points[sweep0.points.length - 1], 10, 0);
    expect(sweep0.points.length).toBeGreaterThan(10);
    // The flag picks the side of the chord; the Y flip inverts it once more,
    // so sweep 1 ends up above the chord in world coordinates.
    const apex = (e: PolylineEntity) => e.points.reduce((acc, p) => (Math.abs(p.y) > Math.abs(acc) ? p.y : acc), 0);
    expect(apex(sweep0)).toBeLessThan(0);
    expect(apex(sweep1)).toBeGreaterThan(0);
    expect(apex(sweep0)).toBeCloseTo(-apex(sweep1), 6);
  });

  it("falls back to a straight segment for a degenerate arc", () => {
    const e = first("M0 0 A0 0 0 0 1 10 0");
    expect(e.points).toHaveLength(2);
  });

  it("skips only an unknown command, keeping the rest of the path", () => {
    const result = path("M0 0 L10 0 X5 5 L20 0");
    const e = result.entities[0] as PolylineEntity;
    expect(e.points).toHaveLength(3);
    closeTo(e.points[2], 20, 0);
    expect(result.warnings.some((w) => w.includes("unknown command"))).toBe(true);
  });

  it("skips a command with missing arguments and continues with the next", () => {
    const result = path("M0 0 L10 0 C1 2 3 L20 0");
    const e = result.entities[0] as PolylineEntity;
    closeTo(e.points[e.points.length - 1], 20, 0);
    expect(result.warnings.some((w) => w.includes("missing or malformed"))).toBe(true);
  });

  it("never loops or throws on garbage path data", () => {
    for (const d of ["M", "C", "M0 0 C", "M0 0 A1 1 0 5 5 1 1", "!!!", "M0 0 L 1e", "M 1,2,3 ,,, L", "M0 0 Q1", "M0 0 C NaN NaN 1 1 1 1"]) {
      expect(() => path(d)).not.toThrow();
    }
  });

  it("terminates on stray numbers after a Z instead of looping forever", () => {
    // Z takes no arguments; without a forward-progress guard this spun until
    // the process ran out of memory.
    const result = path("M0 0 L10 0 Z 5 5 5 5");
    expect(result.entities).toHaveLength(1);
    expect((result.entities[0] as PolylineEntity).closed).toBe(true);
  });

  it("handles an empty or argument-less path without throwing", () => {
    expect(path("").entities).toEqual([]);
    expect(path("M").entities).toEqual([]);
    expect(path("Z").entities).toEqual([]);
  });
});

describe("parseSvgText: units and physical size (SV-02)", () => {
  // A 10-unit horizontal line, so its length in mm is the whole story.
  const lenOf = (attrs: string): { len: number; result: ReturnType<typeof parseSvgText> } => {
    const result = parseSvgText(svgOf('<line x1="0" y1="0" x2="10" y2="0"/>', attrs));
    const e = result.entities[0] as LineEntity;
    return { len: e.b.x - e.a.x, result };
  };

  it("scales a viewBox to the declared width/height in mm", () => {
    const { len, result } = lenOf('width="200mm" height="100mm" viewBox="0 0 100 50"');
    expect(len).toBeCloseTo(20, 9);
    expect(result.units).toMatchObject({ source: "declared", insUnits: 4 });
    expect(result.units.mmPerUserUnit).toBeCloseTo(2, 9);
  });

  it("understands cm, in, pt and pc", () => {
    expect(lenOf('width="10cm" height="10cm" viewBox="0 0 10 10"').len).toBeCloseTo(100, 9);
    expect(lenOf('width="1in" height="1in" viewBox="0 0 1 1"').len).toBeCloseTo(254, 9);
    expect(lenOf('width="72pt" height="72pt" viewBox="0 0 72 72"').len).toBeCloseTo((10 * 25.4) / 72, 9);
    expect(lenOf('width="6pc" height="6pc" viewBox="0 0 6 6"').len).toBeCloseTo((10 * 25.4) / 6, 9);
    expect(lenOf('width="2in" height="2in" viewBox="0 0 2 2"').result.units.insUnits).toBe(1);
    expect(lenOf('width="5cm" height="5cm" viewBox="0 0 5 5"').result.units.insUnits).toBe(5);
  });

  it("reads a unitless size as 96 dpi and says the size was assumed", () => {
    const { len, result } = lenOf('width="96" height="96" viewBox="0 0 96 96"');
    expect(len).toBeCloseTo(10 * (25.4 / 96), 9);
    expect(result.units.source).toBe("assumed");
    expect(lenOf('width="96px" height="96px" viewBox="0 0 96 96"').result.units.source).toBe("assumed");
  });

  it("with no viewBox a user unit is one px whatever width/height say", () => {
    const { len, result } = lenOf('width="100mm" height="100mm"');
    expect(len).toBeCloseTo(10 * (25.4 / 96), 9);
    expect(result.units.source).toBe("assumed");
  });

  it("falls back to 96 dpi for percentages, missing sizes and junk", () => {
    for (const attrs of ['width="100%" height="100%" viewBox="0 0 10 10"', 'viewBox="0 0 10 10"', "", 'width="auto" height="wide" viewBox="0 0 10 10"']) {
      const { len, result } = lenOf(attrs);
      expect(len).toBeCloseTo(10 * (25.4 / 96), 9);
      expect(result.units.source).toBe("assumed");
    }
  });

  it("derives a missing dimension from the viewBox aspect ratio", () => {
    expect(lenOf('width="50mm" viewBox="0 0 10 20"').len).toBeCloseTo(50, 9);
    expect(lenOf('height="40mm" viewBox="0 0 10 20"').len).toBeCloseTo(20, 9);
  });

  it("honours preserveAspectRatio: meet uses the smaller scale, slice the larger, none each axis", () => {
    const box = 'width="100mm" height="50mm" viewBox="0 0 10 10"'; // sx = 10, sy = 5
    expect(lenOf(`${box}`).len).toBeCloseTo(50, 9); // xMidYMid meet
    expect(lenOf(`${box} preserveAspectRatio="xMidYMid slice"`).len).toBeCloseTo(100, 9);
    expect(lenOf(`${box} preserveAspectRatio="none"`).len).toBeCloseTo(100, 9);
    const vert = parseSvgText(svgOf('<line x1="0" y1="0" x2="0" y2="10"/>', `${box} preserveAspectRatio="none"`)).entities[0] as LineEntity;
    expect(Math.abs(vert.b.y - vert.a.y)).toBeCloseTo(50, 9);
  });

  it("aligns the meet box: xMin/xMid/xMax move the content within the wider viewport", () => {
    const at = (par: string) => (parseSvgText(svgOf('<line x1="0" y1="0" x2="10" y2="0"/>', `width="100mm" height="50mm" viewBox="0 0 10 10" preserveAspectRatio="${par}"`)).entities[0] as LineEntity).a.x;
    expect(at("xMinYMid meet")).toBeCloseTo(0, 9);
    expect(at("xMidYMid meet")).toBeCloseTo(25, 9);
    expect(at("xMaxYMid meet")).toBeCloseTo(50, 9);
  });

  it("applies the viewBox origin", () => {
    const e = parseSvgText(svgOf('<line x1="100" y1="100" x2="110" y2="100"/>', 'width="10mm" height="10mm" viewBox="100 100 10 10"')).entities[0] as LineEntity;
    closeTo(e.a, 0, 0);
    closeTo(e.b, 10, 0);
  });

  it("scales circle radii and image sizes with the physical size", () => {
    const c = parseSvgText(svgOf('<circle cx="5" cy="5" r="5"/>', 'width="20mm" height="20mm" viewBox="0 0 10 10"')).entities[0] as CircleEntity;
    expect(c.radius).toBeCloseTo(10, 9);
  });
});

describe("entitiesToSvgDocument: physical size (SV-02)", () => {
  it("writes width/height in mm by default, with the viewBox in world mm", () => {
    const text = entitiesToSvgDocument([line()], { padding: 0 });
    expect(text).toContain('width="100mm" height="50mm" viewBox="0 0 100 50"');
  });

  it("writes inches when asked, leaving the viewBox in mm so 1 viewBox unit stays 1 mm", () => {
    const text = entitiesToSvgDocument([line()], { padding: 0, unit: "in" });
    expect(text).toContain(`width="${Math.round((100 / 25.4) * 1e4) / 1e4}in"`);
    expect(text).toContain('viewBox="0 0 100 50"');
  });

  it('writes bare numbers for unit "none" (inline embedding)', () => {
    expect(entitiesToSvgDocument([line()], { padding: 0, unit: "none" })).toContain('width="100" height="50"');
  });

  it("round-trips real size: a 100 mm part comes back 100 mm, in either unit", () => {
    for (const unit of ["mm", "in"] as const) {
      const back = parseSvgText(entitiesToSvgDocument([line()], { padding: 0, unit }));
      const e = back.entities.find((x) => x.type === "line") as LineEntity;
      expect(Math.abs(e.b.x - e.a.x)).toBeCloseTo(100, 3);
      expect(back.units.source).toBe("declared");
    }
  });
});

describe("parseSvgText: document structure", () => {
  it("attributes entities to the nearest data-layer", () => {
    const { entities } = parseSvgText(
      svgOf('<g data-layer="walls"><line x1="0" y1="0" x2="1" y2="0"/></g><line data-layer="holes" x1="0" y1="0" x2="1" y2="0"/><line x1="0" y1="0" x2="1" y2="0"/>'),
    );
    expect(entities.map((e) => e.layer)).toEqual(["walls", "holes", undefined]);
  });

  it("walks into unknown elements for nested drawable content", () => {
    expect(parseSvgText(svgOf('<defs><line x1="0" y1="0" x2="1" y2="0"/></defs>')).entities).toHaveLength(1);
  });

  it("reports malformed XML instead of throwing", () => {
    const result = parseSvgText("<svg><g></svg>");
    expect(result.entities).toEqual([]);
    expect(result.warnings).toEqual(["the SVG could not be parsed (malformed XML)"]);
  });

  it("gives every imported entity a distinct id", () => {
    const ids = parseSvgText(svgOf('<line x1="0" y1="0" x2="1" y2="0"/><circle cx="0" cy="0" r="1"/><rect x="0" y="0" width="1" height="1"/>')).entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });
});

/* ------------------------------ round-trip ------------------------------ */

describe("export then import", () => {
  /** Asserts every point moved by the same fixed offset — shape and size preserved, position translated. */
  function expectRigidTranslation(before: Entity[], after: Entity[]): Point {
    const originals = before.flatMap(pointsOf);
    const imported = after.flatMap(pointsOf);
    expect(imported).toHaveLength(originals.length);
    const delta = { x: imported[0].x - originals[0].x, y: imported[0].y - originals[0].y };
    imported.forEach((p, i) => closeTo(p, originals[i].x + delta.x, originals[i].y + delta.y, 6));
    return delta;
  }

  it("preserves lines exactly, up to the viewBox offset", () => {
    const before: Entity[] = [line(), { ...line(), id: "l2", a: { x: -30, y: 12 }, b: { x: 5, y: -8 } }];
    const after = parseSvgText(entitiesToSvgDocument(before)).entities;
    expect(after.every((e) => e.type === "line")).toBe(true);
    // Offset is padding - minX horizontally, and -(maxY + padding) vertically.
    expect(expectRigidTranslation(before, after)).toEqual({ x: 35, y: -55 });
  });

  it("preserves a circle's radius and a closed polyline's shape", () => {
    const poly: PolylineEntity = {
      id: "p",
      type: "polyline",
      points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 25 }],
      closed: true,
    };
    const before: Entity[] = [circle(), poly];
    const after = parseSvgText(entitiesToSvgDocument(before)).entities;
    expect((after[0] as CircleEntity).radius).toBeCloseTo(12.5, 6);
    expect((after[1] as PolylineEntity).closed).toBe(true);
    // Not 4: the explicit line back to the start plus the Z must not leave a
    // duplicate vertex behind.
    expect((after[1] as PolylineEntity).points).toHaveLength(3);
    expectRigidTranslation(before, after);
  });

  it("preserves layers", () => {
    const before: Entity[] = [{ ...line(), layer: "walls" }, { ...circle(), layer: "holes" }];
    expect(parseSvgText(entitiesToSvgDocument(before)).entities.map((e) => e.layer)).toEqual(["walls", "holes"]);
  });

  it("preserves an image's size, rotation and embedded pixel data", () => {
    const img: Entity = {
      id: "i",
      type: "image",
      insert: { x: 0, y: 0 },
      width: 40,
      height: 25,
      rotation: 0,
      dataUrl: "data:image/png;base64,AAAA",
    };
    const rotated: Entity = { ...img, id: "i2", rotation: Math.PI / 6 };
    const after = parseSvgText(entitiesToSvgDocument([img, rotated])).entities;
    expect(after.every((e) => e.type === "image")).toBe(true);
    const [back, backRotated] = after as { width: number; height: number; rotation: number; dataUrl: string }[];
    expect(back.width).toBeCloseTo(40, 6);
    expect(back.height).toBeCloseTo(25, 6);
    expect(back.rotation).toBeCloseTo(0, 6);
    expect(back.dataUrl).toBe("data:image/png;base64,AAAA");
    expect(backRotated.rotation).toBeCloseTo(Math.PI / 6, 6);
    expectRigidTranslation([img, rotated], after);
  });

  it("skips an <image> that references an external file instead of an embedded data: URI", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image x="0" y="0" width="10" height="10" href="photo.png"/></svg>`;
    const { entities, warnings } = parseSvgText(svg);
    expect(entities).toHaveLength(0);
    expect(warnings.some((w) => w.includes("external file"))).toBe(true);
  });

  it("degrades an arc to a tessellated polyline", () => {
    // SVG export is a rendering: arcs are sampled to M/L, so they come back as
    // polylines rather than arc entities. Shape survives, the record doesn't.
    const arc: ArcEntity = { id: "a", type: "arc", center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, ccw: true };
    const [back] = parseSvgText(entitiesToSvgDocument([arc])).entities;
    expect(back.type).toBe("polyline");
    const pts = (back as PolylineEntity).points;
    expect(pts.length).toBeGreaterThan(10);
    // Still a quarter circle: every sample sits on the radius.
    const centre = { x: pts[0].x - 10, y: pts[0].y };
    for (const p of pts) expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(10, 4);
  });

  it("degrades a point to a small circle", () => {
    const p: PointEntity = { id: "p", type: "point", p: { x: 0, y: 0 } };
    const [back] = parseSvgText(entitiesToSvgDocument([p, line()])).entities;
    expect(back.type).toBe("circle");
    expect((back as CircleEntity).radius).toBeCloseTo(0.375, 9); // strokeWidth * 1.5
  });

  it("degrades a bulged polyline segment to line segments", () => {
    const bulged: PolylineEntity = {
      id: "p",
      type: "polyline",
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }],
      bulges: [0.5],
      closed: false,
    };
    const [back] = parseSvgText(entitiesToSvgDocument([bulged])).entities as PolylineEntity[];
    expect(back.bulges).toBeUndefined();
    expect(back.points.length).toBeGreaterThan(2);
  });
});
