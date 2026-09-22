import { describe, expect, it } from "vitest";
import type { Entity } from "./entities";
import { describeFilter, matchesFilter, selectMatching, selectSimilar, similarFilter } from "./selectFilter";

/**
 * "Select similar" is how an imported drawing gets cleaned up: grab one of
 * the 400 stray tick marks and take the rest in one gesture. The risk is
 * quiet over-reach — a filter that matches more than the user meant hands
 * a Delete key a much bigger selection than they think they have — so the
 * rules that keep it narrow (every criterion ANDed, an empty criterion
 * meaning "don't care" rather than "nothing") are pinned here.
 */

const line = (id: string, extra: Partial<Entity> = {}): Entity =>
  ({ id, type: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, ...extra }) as Entity;
const circle = (id: string, extra: Partial<Entity> = {}): Entity =>
  ({ id, type: "circle", center: { x: 0, y: 0 }, radius: 1, ...extra }) as Entity;

describe("matchesFilter", () => {
  it("matches everything when nothing is asked for", () => {
    expect(matchesFilter(line("a"), {})).toBe(true);
    expect(matchesFilter(line("a"), { types: [], layers: [] })).toBe(true);
  });

  it("ANDs the criteria", () => {
    const e = line("a", { layer: "walls", color: "#f00" });
    expect(matchesFilter(e, { types: ["line"], layers: ["walls"] })).toBe(true);
    expect(matchesFilter(e, { types: ["line"], layers: ["doors"] })).toBe(false);
    expect(matchesFilter(e, { types: ["circle"], layers: ["walls"] })).toBe(false);
  });

  it("treats an entity with no layer as the default layer", () => {
    expect(matchesFilter(line("a"), { layers: ["0"] })).toBe(true);
    expect(matchesFilter(line("a", { layer: "walls" }), { layers: ["0"] })).toBe(false);
  });

  it("distinguishes the theme default colour from an explicit one", () => {
    expect(matchesFilter(line("a"), { colors: [null] })).toBe(true);
    expect(matchesFilter(line("a"), { colors: ["#f00"] })).toBe(false);
    expect(matchesFilter(line("a", { color: "#f00" }), { colors: [null] })).toBe(false);
    expect(matchesFilter(line("a", { color: "#f00" }), { colors: [null, "#f00"] })).toBe(true);
  });

  it("filters on construction and fill as flags, not as presence", () => {
    expect(matchesFilter(line("a", { dashed: true }), { construction: true })).toBe(true);
    expect(matchesFilter(line("a"), { construction: false })).toBe(true);
    expect(matchesFilter(line("a"), { construction: true })).toBe(false);
    expect(matchesFilter(circle("c", { fill: "#eee" }), { filled: true })).toBe(true);
    expect(matchesFilter(circle("c"), { filled: true })).toBe(false);
  });
});

describe("selectSimilar", () => {
  const drawing = [
    line("l1", { layer: "walls" }),
    line("l2", { layer: "walls" }),
    line("l3", { layer: "doors" }),
    line("l4", { layer: "walls", color: "#f00" }),
    circle("c1", { layer: "walls" }),
  ];

  it("takes same type, same layer, same colour — and nothing else", () => {
    expect(selectSimilar(drawing, [drawing[0]])).toEqual(["l1", "l2"]);
  });

  it("widens per-dimension when the samples disagree, not across dimensions", () => {
    // A red wall line and a plain wall line: both colours, still only lines
    // on 'walls' — the doors line and the circle stay out.
    expect(selectSimilar(drawing, [drawing[0], drawing[3]])).toEqual(["l1", "l2", "l4"]);
    // Adding the circle widens the type, not the layer.
    expect(selectSimilar(drawing, [drawing[0], drawing[4]])).toEqual(["l1", "l2", "c1"]);
  });

  it("always includes its own samples", () => {
    for (const sample of drawing) expect(selectSimilar(drawing, [sample])).toContain(sample.id);
  });

  it("selects nothing from nothing, rather than everything", () => {
    expect(selectSimilar(drawing, [])).toEqual([]);
  });

  it("builds a filter that lists each distinct value once", () => {
    const f = similarFilter([drawing[0], drawing[1], drawing[4]]);
    expect(f.types).toEqual(["line", "circle"]);
    expect(f.layers).toEqual(["walls"]);
    expect(f.colors).toEqual([null]);
  });
});

describe("selectMatching", () => {
  it("returns ids in document order", () => {
    const entities = [circle("c1"), line("l1"), circle("c2")];
    expect(selectMatching(entities, { types: ["circle"] })).toEqual(["c1", "c2"]);
  });
});

describe("describeFilter", () => {
  it("says what it will take, for the status bar", () => {
    expect(describeFilter({})).toBe("anything");
    expect(describeFilter({ types: ["line"], layers: ["walls"] })).toBe("line · layer walls");
    expect(describeFilter({ colors: [null, "#f00"] })).toBe("colour default, #f00");
    expect(describeFilter({ construction: true })).toBe("construction");
  });
});
