/**
 * X-12: DXF fidelity scorecard. For each drawing in a small corpus:
 *   1. write it with the AC1032 writer (and R12 where it applies),
 *   2. run ezdxf's auditor over the file (tools/dxf-audit/audit.py),
 *   3. re-open it with Sketchor's own parser and diff what came back
 *      (entity signatures: type, name, layer, colour, linetype, lineweight,
 *      construction, fill; plus groups / constraints / params / blocks),
 * and print a markdown table for docs/dxf-fidelity-scorecard.md. LibreCAD /
 * ODA columns stay manual (see the doc) — neither is automatable here.
 *
 * Run: npm run dxf:scorecard   (needs Python + `pip install ezdxf` for the audit column)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entitiesToDxf, entitiesToDxf2018, parseDxf } from "../../packages/core/src/index";
import type { BlockDefinition, Entity, Group, Constraint, HatchEntity } from "../../packages/core/src/index";

const OUT = join(process.cwd(), "tools", "dxf-audit", "out");
mkdirSync(OUT, { recursive: true });

const P = (x: number, y: number) => ({ x, y });
const base = { layer: "0" };
let n = 0;
const id = () => `s${++n}`;

const line = (a: [number, number], b: [number, number], extra: object = {}): Entity => ({ id: id(), type: "line", ...base, a: P(...a), b: P(...b), ...extra }) as Entity;
const circle = (c: [number, number], r: number, extra: object = {}): Entity => ({ id: id(), type: "circle", ...base, center: P(...c), radius: r, ...extra }) as Entity;
const square = (x: number, y: number, s: number) =>
  ({ type: "polyline" as const, closed: true, points: [P(x, y), P(x + s, y), P(x + s, y + s), P(x, y + s)] });
const rectLoop = (x: number, y: number, w: number, h: number) => ({
  outer: true,
  edges: [
    { type: "line" as const, a: P(x, y), b: P(x + w, y) },
    { type: "line" as const, a: P(x + w, y), b: P(x + w, y + h) },
    { type: "line" as const, a: P(x + w, y + h), b: P(x, y + h) },
    { type: "line" as const, a: P(x, y + h), b: P(x, y) },
  ],
});
const hatch = (paint: HatchEntity["paint"], extra: object = {}): Entity =>
  ({ id: id(), type: "hatch", ...base, loops: [rectLoop(0, 0, 40, 30)], paint, style: "normal", ...extra }) as unknown as Entity;

interface Drawing {
  name: string;
  what: string;
  entities: Entity[];
  blocks?: BlockDefinition[];
  groups?: Group[];
  constraints?: Constraint[];
  params?: { name: string; [k: string]: unknown }[];
  insUnits?: number;
  r12?: boolean;
}

function corpus(): Drawing[] {
  const l1 = line([0, 0], [100, 0], { name: "L1" });
  const l2 = line([0, 10], [100, 10]);
  const c1 = circle([50, 50], 20, { name: "C1" });
  const wheel: BlockDefinition = {
    name: "WHEEL",
    basePoint: P(0, 0),
    entities: [circle([0, 0], 10), line([-10, 0], [10, 0]), line([0, -10], [0, 10])],
    attributeDefs: [{ tag: "TAG", at: P(0, 12), height: 3, rotation: 0, default: "A" }],
    explodable: true,
    scaleUniformly: false,
  };
  const cart: BlockDefinition = {
    name: "CART",
    basePoint: P(0, 0),
    entities: [
      { id: id(), type: "insert", ...base, block: "WHEEL", insert: P(5, 0), scale: P(1, 1), rotation: 0, attributes: {} } as unknown as Entity,
      line([0, 10], [60, 10]),
    ],
    attributeDefs: [],
    explodable: false,
    scaleUniformly: true,
  };
  const ins = (block: string, at: [number, number], rot = 0, attrs: Record<string, string> = {}): Entity =>
    ({ id: id(), type: "insert", ...base, block, insert: P(...at), scale: P(1, 1), rotation: rot, attributes: attrs }) as unknown as Entity;
  return [
    { name: "01-lines-circles", what: "lines, circles, names, layers", entities: [l1, l2, c1, circle([10, 10], 2, { layer: "holes" })] },
    {
      name: "02-curves",
      what: "arc, ellipse, spline, bulged polyline",
      entities: [
        { id: id(), type: "arc", ...base, center: P(0, 0), radius: 10, startAngle: 0, endAngle: Math.PI, ccw: true } as Entity,
        { id: id(), type: "ellipse", ...base, center: P(30, 0), majorAxis: P(15, 0), ratio: 0.5, start: 0, end: Math.PI * 2 } as Entity,
        { id: id(), type: "spline", ...base, degree: 3, controlPoints: [P(0, 20), P(10, 40), P(30, 0), P(40, 30)], knots: [0, 0, 0, 0, 1, 1, 1, 1] } as unknown as Entity,
        { id: id(), type: "polyline", ...base, points: [P(0, 50), P(20, 50), P(20, 70)], bulges: [0.5, 0, 0], closed: false } as unknown as Entity,
      ],
    },
    {
      name: "03-cyrillic-text",
      what: "Ukrainian text and layer names",
      entities: [{ id: id(), type: "text", layer: "Написи", at: P(0, 0), text: "Привіт, світе — Ґанок", height: 5, rotation: 0 } as Entity],
    },
    {
      name: "04-style",
      what: "true colours, linetypes, lineweights, construction",
      entities: [
        line([0, 0], [50, 0], { color: "#12ab34" }),
        line([0, 5], [50, 5], { linetype: "DASHED", lineweight: 0.5 }),
        line([0, 10], [50, 10], { linetype: "CENTER", color: "#ff0000" }),
        line([0, 15], [50, 15], { construction: true }),
        circle([25, 30], 5, { fill: "#336699" }),
      ],
    },
    {
      name: "05-blocks",
      what: "nested block, attributes, array insert",
      entities: [ins("WHEEL", [0, 0], 0, { TAG: "Z" }), ins("CART", [50, 0], Math.PI / 6)],
      blocks: [wheel, cart],
    },
    {
      name: "06-hatches",
      what: "solid, pattern, gradient hatches",
      entities: [
        hatch({ kind: "solid", color: "#ffaa00" }),
        { ...hatch({ kind: "pattern", name: "ANSI31", scale: 1, angle: 0 }), loops: [rectLoop(50, 0, 40, 30)] } as Entity,
        { ...hatch({ kind: "gradient", name: "LINEAR", colors: ["#ff0000", "#0000ff"], angle: 0 }), loops: [rectLoop(100, 0, 40, 30)] } as Entity,
      ],
    },
    {
      name: "07-groups-constraints",
      what: "nested groups, constraints, params (SKETCHOR record)",
      entities: [l1, l2, c1],
      groups: [
        { id: "gi", name: "Inner", members: [l1.id, l2.id], parent: "go" },
        { id: "go", name: "Outer", members: ["gi", c1.id] },
      ],
      constraints: [{ id: "k1", type: "parallel", a: l1.id, b: l2.id }],
      params: [{ name: "w", value: 100 }],
    },
    { name: "08-inches", what: "inch drawing (INSUNITS 1)", entities: [circle([1, 1], 0.5), line([0, 0], [4, 0])], insUnits: 1 },
    { name: "09-many-layers", what: "200 layers", entities: Array.from({ length: 200 }, (_, i) => line([0, i], [10, i], { layer: `L${i}` })) },
    { name: "10-r12-flat", what: "R12 flat geometry", entities: [l1, c1], r12: true },
    { name: "11-points-polys", what: "point, closed polyline, open polyline", entities: [{ id: id(), type: "point", ...base, p: P(1, 1) } as Entity, { id: id(), ...square(0, 0, 10), ...base } as Entity] },
  ];
}

const sig = (e: Entity): string => {
  const x = e as unknown as Record<string, unknown>;
  return [e.type, x.name ?? "", x.layer ?? "0", e.type === "hatch" ? "" : (x.color ?? ""), x.linetype ?? "", x.lineweight ?? "", x.construction ? "c" : "", e.type !== "hatch" ? (x.fill ?? "") : ""].join("|");
};

function auditAll(files: string[]): Map<string, { errors: string[]; fixes: string[] }> {
  const res = new Map<string, { errors: string[]; fixes: string[] }>();
  const r = spawnSync("python", ["tools/dxf-audit/audit.py", ...files], { encoding: "utf8" });
  if (r.error || /not installed/.test(r.stderr)) return res;
  for (const l of r.stdout.split("\n")) {
    if (!l.trim().startsWith("{")) continue;
    const j = JSON.parse(l) as { file: string; errors: string[]; fixes: string[] };
    res.set(j.file, j);
  }
  return res;
}

const rows: { d: Drawing; file: string; diff: string[]; bytes: number }[] = [];
for (const d of corpus()) {
  const unitsTo = d.insUnits ?? 4;
  const text = d.r12
    ? entitiesToDxf(d.entities, unitsTo, 1, d.blocks)
    : entitiesToDxf2018(d.entities, { insUnits: unitsTo, blocks: d.blocks, groups: d.groups, constraints: d.constraints, params: d.params });
  const file = join(OUT, `${d.name}.dxf`);
  writeFileSync(file, text);
  const back = parseDxf(text);
  const diff: string[] = [];
  const want = d.entities.map(sig).sort();
  const got = back.entities.map(sig).sort();
  if (d.r12) {
    // R12 has no names / XDATA: compare geometry type counts only.
    const count = (es: Entity[]) => es.map((e) => e.type).sort().join(",");
    if (count(d.entities) !== count(back.entities)) diff.push(`entity types ${count(d.entities)} -> ${count(back.entities)}`);
  } else if (want.join("\n") !== got.join("\n")) {
    const missing = want.filter((s) => !got.includes(s));
    const extra = got.filter((s) => !want.includes(s));
    if (missing.length) diff.push(`lost: ${missing.slice(0, 3).join("; ")}`);
    if (extra.length) diff.push(`changed to: ${extra.slice(0, 3).join("; ")}`);
  }
  if (d.groups && JSON.stringify(back.groups) !== JSON.stringify(d.groups)) diff.push("groups differ");
  if (d.constraints && JSON.stringify(back.constraints) !== JSON.stringify(d.constraints)) diff.push("constraints differ");
  if (d.params && JSON.stringify(back.params) !== JSON.stringify(d.params)) diff.push("params differ");
  if (d.blocks && back.blocks.map((b) => b.name).sort().join() !== d.blocks.map((b) => b.name).sort().join()) diff.push("block names differ");
  if (d.blocks) {
    for (const b of d.blocks) {
      const o = back.blocks.find((x) => x.name === b.name);
      if (o && (o.entities.length !== b.entities.length || o.attributeDefs.length !== b.attributeDefs.length || o.explodable !== b.explodable)) diff.push(`block ${b.name} body differs`);
    }
  }
  if (back.insUnits !== unitsTo) diff.push(`units ${unitsTo} -> ${back.insUnits}`);
  rows.push({ d, file, diff, bytes: text.length });
}

const audits = auditAll(rows.map((r) => r.file));
const lines = ["| Drawing | What | ezdxf audit | Sketchor re-import | LibreCAD | ODA |", "|---|---|---|---|---|---|"];
let bad = 0;
for (const r of rows) {
  const a = audits.get(r.file);
  const au = a ? (a.errors.length === 0 ? `0 errors${a.fixes.length ? `, ${a.fixes.length} fixes` : ""}` : `**${a.errors.length} errors**`) : "n/a (no ezdxf)";
  if (a && a.errors.length) bad++;
  if (r.diff.length) bad++;
  lines.push(`| ${r.d.name} | ${r.d.what} | ${au} | ${r.diff.length ? "**" + r.diff.join("; ") + "**" : "identical"} | manual | manual |`);
}
console.log(lines.join("\n"));
console.log(`\n${rows.length} drawings, ${bad} with problems`);
process.exit(bad ? 1 : 0);
