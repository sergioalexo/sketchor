// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import "./kinds/builtin";
import { entitiesToSvgDocument, parseSvgText } from "./svg";
import { evaluateInsert } from "./blocks/evaluate";
import type { BlockDefinition } from "./blocks/types";
import type { Entity, InsertEntity } from "./entities";
import { boundsOf } from "./dxf";

/**
 * SV-04: a `<use>` of a `<symbol>` imports as an insert of a real block. If the
 * placement maths were wrong, instances would land elsewhere than the drawing
 * the author saw — so the property checked is "evaluated block geometry equals
 * the same file imported with the geometry expanded in place".
 */
const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svgOf = (body: string): string => `<svg ${NS} width="200mm" height="200mm" viewBox="0 0 200 200">${body}</svg>`;
const SYM = '<symbol id="mark"><line x1="0" y1="0" x2="10" y2="0"/><circle cx="5" cy="5" r="2"/></symbol>';

function evaluated(r: { entities: Entity[]; blocks: BlockDefinition[] }): Entity[] {
  const host = { getRecord: (_t: string, n: string) => r.blocks.find((b) => b.name === n), tablesRevision: 0 };
  return r.entities.flatMap((e) => (e.type === "insert" ? evaluateInsert(host, e as InsertEntity) : [e]));
}

describe("parseSvgText: <symbol>/<use> as blocks", () => {
  const body = `${SYM}<use href="#mark" x="20" y="30"/><use href="#mark" transform="translate(100 50) rotate(30) scale(2)"/><use href="#mark" transform="matrix(-1 0 0 1 150 20)"/>`;

  it("one definition, one insert per use", () => {
    const r = parseSvgText(svgOf(body), { blocks: "keep" });
    expect(r.blocks.map((b) => b.name)).toEqual(["mark"]);
    expect(r.entities.filter((e) => e.type === "insert")).toHaveLength(3);
  });

  it("evaluated placements equal the geometry expanded in place", () => {
    const kept = evaluated(parseSvgText(svgOf(body), { blocks: "keep" }));
    const flat = parseSvgText(svgOf(body)).entities;
    expect(kept.length).toBe(flat.length);
    const bk = boundsOf(kept)!;
    const bf = boundsOf(flat)!;
    for (const k of ["minX", "minY", "maxX", "maxY"] as const) expect(bk[k]).toBeCloseTo(bf[k], 6);
  });

  it("default (explode) keeps the old behaviour: no blocks", () => {
    const r = parseSvgText(svgOf(body));
    expect(r.blocks).toEqual([]);
    expect(r.entities.some((e) => e.type === "insert")).toBe(false);
  });

  it("a shear falls back to geometry", () => {
    const r = parseSvgText(svgOf(`${SYM}<use href="#mark" transform="matrix(1 0 0.36 1 0 0)"/>`), { blocks: "keep" });
    expect(r.blocks).toEqual([]);
    expect(r.entities.length).toBeGreaterThan(0);
  });

  it("a different inherited style makes a second definition", () => {
    const r = parseSvgText(svgOf(`${SYM}<use href="#mark" stroke="#f00"/><use href="#mark" stroke="#0f0"/>`), { blocks: "keep" });
    expect(r.blocks).toHaveLength(2);
  });

  it("a symbol that references itself terminates", () => {
    const r = parseSvgText(svgOf('<symbol id="s"><line x1="0" y1="0" x2="1" y2="0"/><use href="#s"/></symbol><use href="#s"/>'), { blocks: "keep" });
    expect(r.warnings.join(" ")).toMatch(/cycle/);
  });

  it("Sketchor SVG export with blocks re-imports with the same extent and one definition", () => {
    const first = parseSvgText(svgOf(body), { blocks: "keep" });
    const svg = entitiesToSvgDocument(first.entities, { blocks: first.blocks });
    const second = parseSvgText(svg, { blocks: "keep" });
    expect(second.blocks).toHaveLength(1);
    const a = boundsOf(evaluated(first))!;
    const b = boundsOf(evaluated(second))!;
    // The exported page starts at its own extent, so compare size, not absolute position (true of flat export too).
    expect(b.maxX - b.minX).toBeCloseTo(a.maxX - a.minX, 3);
    expect(b.maxY - b.minY).toBeCloseTo(a.maxY - a.minY, 3);
  });
});
