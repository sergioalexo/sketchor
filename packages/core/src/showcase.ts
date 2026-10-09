import type { Command } from "./commands";
import type { Entity, EntityId } from "./entities";
import type { Point } from "./geometry";
import { interpolateNurbs } from "./nurbs";
import type { BlockDefinition } from "./blocks/types";

/**
 * The built-in showcase drawing shown on the web build's first open: a small
 * laser-cut name plate (mm) with curves (ellipse + spline), a patterned hatch,
 * a block with an attribute, dimensions and coloured layers. Built from code
 * only; ids are fixed so the drawing is deterministic.
 */
const CUT = "Cut";
const ENGRAVE = "Engrave";
const HATCH = "Hatch";
const NOTES = "Notes";
const LAYER_COLORS: Record<string, string> = { [CUT]: "#e5484d", [ENGRAVE]: "#3e8ef7", [HATCH]: "#30a46c", [NOTES]: "#f5a524" };

const W = 120;
const H = 70;

export function showcaseCommands(): Command[] {
  const p = (x: number, y: number): Point => ({ x, y });
  const id = (s: string): EntityId => `demo-${s}`;
  const cmds: Command[] = [];

  for (const name of [CUT, ENGRAVE, HATCH, NOTES]) {
    cmds.push({ type: "put-table-record", table: "layers", record: { name, visible: true } });
  }

  // Block "TAG": a ring with a cross and a PART attribute.
  const tag: BlockDefinition = {
    name: "TAG",
    basePoint: p(0, 0),
    description: "Part tag with a PART attribute",
    explodable: true,
    scaleUniformly: true,
    entities: [
      { id: "demo-tag-c", type: "circle", center: p(0, 0), radius: 6 },
      { id: "demo-tag-l1", type: "line", a: p(-6, 0), b: p(6, 0) },
      { id: "demo-tag-l2", type: "line", a: p(0, -6), b: p(0, 6) },
    ],
    attributeDefs: [{ tag: "PART", prompt: "Part number", default: "SK-000", at: p(9, -1.5), height: 3, rotation: 0 }],
  };
  cmds.push({ type: "put-table-record", table: "blocks", record: tag });

  const ents: Entity[] = [];
  const stroke = (layer: string) => ({ layer, color: LAYER_COLORS[layer] });

  ents.push({ id: id("outline"), type: "polyline", ...stroke(CUT), points: [p(0, 0), p(W, 0), p(W, H), p(0, H)], closed: true });
  const holes: Point[] = [p(8, 8), p(W - 8, 8), p(W - 8, H - 8), p(8, H - 8)];
  holes.forEach((c, i) => ents.push({ id: id(`hole${i}`), type: "circle", ...stroke(CUT), center: c, radius: 3 }));

  const ellipse = { center: p(60, 36), majorAxis: p(32, 0), ratio: 0.55 };
  ents.push({ id: id("ellipse"), type: "ellipse", ...stroke(ENGRAVE), ...ellipse, start: 0, end: Math.PI * 2 });
  ents.push({
    id: id("hatch"),
    type: "hatch",
    ...stroke(HATCH),
    loops: [{ edges: [{ type: "ellipse", ...ellipse, start: 0, end: Math.PI * 2 }], outer: true }],
    paint: { kind: "pattern", name: "ANSI31", scale: 1.5, angle: 0 },
    style: "normal",
  });

  const fit = [p(14, 18), p(32, 24), p(50, 14), p(70, 24), p(88, 14), p(106, 20)];
  const nurbs = interpolateNurbs(fit);
  if (nurbs) ents.push({ id: id("spline"), type: "spline", ...stroke(ENGRAVE), degree: nurbs.degree, controlPoints: nurbs.controlPoints, knots: nurbs.knots, fitPoints: fit, closed: false });

  ents.push({ id: id("title"), type: "text", ...stroke(NOTES), at: p(60, 58), text: "SKETCHOR DEMO", height: 6, rotation: 0, halign: "center", valign: "middle" });
  ents.push({ id: id("insert"), type: "insert", layer: NOTES, block: "TAG", insert: p(14, 36), scale: { x: 1, y: 1 }, rotation: 0, attributes: { PART: "SK-001" } });

  ents.push({ id: id("dimW"), type: "dimension", ...stroke(NOTES), kind: "linear", defPoints: [p(0, 0), p(W, 0), p(60, -10)], angle: 0, driving: false });
  ents.push({ id: id("dimH"), type: "dimension", ...stroke(NOTES), kind: "linear", defPoints: [p(0, 0), p(0, H), p(-10, 35)], angle: Math.PI / 2, driving: false });
  ents.push({ id: id("dimD"), type: "dimension", ...stroke(NOTES), kind: "diametric", defPoints: [holes[1], p(holes[1].x + 3, holes[1].y)], target: id("hole1"), driving: false });

  for (const entity of ents) cmds.push({ type: "add-entity", entity });
  return cmds;
}
