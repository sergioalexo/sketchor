import { foreignClassText, foreignEntityText, type ForeignRecord } from "../foreign";
import { explodeDimensions } from "../dimensions/explode";
import { activeDimHost, styleOnlyHost } from "../dimensions/context";
import { STANDARD_TEXT_STYLE, type TextStyle } from "../textStyle";
import type { Entity } from "../entities";
import { layerOf } from "../entities";
import type { BlockDefinition } from "../blocks/types";
import { scaleBlockDefinition, scaleEntityKeepingInserts } from "../dxf";
import { blockDefinitions2018, insertEntity2018, planBlockHandles, type BlockHandles } from "./blocks";
import { boundsOf } from "../dxf";
import { CONTINUOUS, builtinLinetype } from "../linetypes";
import { HandleAllocator } from "./handles";
import { entityDxf2018 } from "./entities";
import { n, pair, unitsAndExtentsHeader } from "./write";
import type { Group } from "../groups";
import type { Constraint } from "../constraints";
import type { TableRecord } from "../tables";
import { SKETCHOR_DICT_KEY, encodeDocData, type BlockExtras, type SketchorDocData } from "../sketchorData";

/**
 * X-01: a modern DXF writer (AC1032 — "DXF 2018"), alongside the R12 writer
 * in `dxfExport.ts`. R12 is still what CAM/laser shops want (flat geometry,
 * no handles); AC1032 is what the rest of the CAD world expects to open
 * without a "recovery" prompt — handles on every record, owner pointers,
 * subclass markers, and the TABLES/BLOCKS/OBJECTS skeleton AutoCAD and
 * every DXF library (ODA, ezdxf, LibreCAD) assume exists.
 *
 * Structural choices, and why:
 * - VPORT/VIEW/UCS tables are written with zero entries — legal DXF (a
 *   reader without an active viewport just uses its own default), and every
 *   byte of a VPORT record's layout is detail no consumer here needs.
 * - LAYOUT objects are the minimal pair every AC1032 file needs (Model +
 *   one paper layout) so `$ACTIVELAYOUT`-aware readers don't choke; no
 *   PLOTSETTINGS/viewport entity is written since Sketchor has no paper
 *   space geometry yet (that's L-01..L-09).
 * - Every entity carries `SKETCHOR` XDATA with its sketch-code name (see
 *   sketchtext.ts) under a registered APPID, so round-tripping through this
 *   writer — unlike R12 — keeps L1/C1/... names instead of renumbering.
 */

const STANDARD_HANDLES = [
  "vportTable",
  "ltypeTable",
  "layerTable",
  "styleTable",
  "viewTable",
  "ucsTable",
  "appidTable",
  "dimstyleTable",
  "blockRecordTable",
  "standardStyle",
  "acadAppid",
  "sketchorAppid",
  "standardDimstyle",
  "modelSpaceBlockRecord",
  "paperSpaceBlockRecord",
  "modelSpaceBlockBegin",
  "modelSpaceBlockEnd",
  "paperSpaceBlockBegin",
  "paperSpaceBlockEnd",
  "rootDict",
  "groupDict",
  "layoutDict",
  "modelLayout",
  "layout1Layout",
  "sketchorXrecord",
] as const;
type HandleKey = (typeof STANDARD_HANDLES)[number];

interface Plan {
  alloc: HandleAllocator;
  h: Record<HandleKey, string>;
  layerHandles: Map<string, string>;
  linetypeHandles: Map<string, string>;
  blocks: Map<string, BlockHandles>;
}

function buildPlan(layers: string[], linetypes: readonly string[], blockDefs: readonly BlockDefinition[]): Plan {
  const alloc = new HandleAllocator();
  const h = {} as Record<HandleKey, string>;
  for (const key of STANDARD_HANDLES) h[key] = alloc.alloc();
  const layerHandles = new Map(layers.map((name) => [name, alloc.alloc()] as const));
  const ltypeNames = [CONTINUOUS, ...linetypes.filter((l) => l !== CONTINUOUS)];
  const linetypeHandles = new Map(ltypeNames.map((name) => [name, alloc.alloc()] as const));
  const blocks = planBlockHandles(blockDefs, () => alloc.alloc());
  return { alloc, h, layerHandles, linetypeHandles, blocks };
}

function table(name: string, handle: string, entries: string[], extraHeader = ""): string {
  return (
    `0\nTABLE\n2\n${name}\n5\n${handle}\n330\n0\n100\nAcDbSymbolTable\n${extraHeader}70\n${entries.length}\n` +
    entries.join("") +
    `0\nENDTAB\n`
  );
}

function symbolRecordHead(type: string, handle: string, owner: string, subclass: string): string {
  return `0\n${type}\n5\n${handle}\n330\n${owner}\n100\nAcDbSymbolTableRecord\n100\n${subclass}\n`;
}

/** Z-04: an AC1032 `LTYPE` table entry for `name` — the same pattern data as R12's `ltypeEntry` (dxfExport.ts), just with a handle/owner/subclass marker instead of R12's bare groups. */
function ltypeEntry(h: string, owner: string, name: string): string {
  const def = builtinLinetype(name);
  const total = def.pattern.reduce((a, b) => a + Math.abs(b), 0);
  const elements = def.pattern.map((v) => pair(49, v)).join("");
  return (
    symbolRecordHead("LTYPE", h, owner, "AcDbLinetypeTableRecord") +
    `2\n${def.name}\n70\n0\n3\n${def.description}\n72\n65\n73\n${def.pattern.length}\n40\n${n(total)}\n${elements}`
  );
}

function styleEntry(h: string, owner: string, s: TextStyle = STANDARD_TEXT_STYLE): string {
  const file = s.font.startsWith("shx:") ? `${s.font.slice(4)}.shx` : s.font.startsWith("ttf:") ? `${s.font.slice(4)}.ttf` : "txt";
  const flags = (s.backwards ? 2 : 0) | (s.upsideDown ? 4 : 0);
  return (
    symbolRecordHead("STYLE", h, owner, "AcDbTextStyleTableRecord") +
    `2\n${s.name}\n70\n0\n` + pair(40, s.height) + pair(41, s.widthFactor) + pair(50, s.oblique) + `71\n${flags}\n` + pair(42, 2.5) + `3\n${file}\n4\n\n`
  );
}

function appidEntry(h: string, owner: string, name: string): string {
  return symbolRecordHead("APPID", h, owner, "AcDbRegAppTableRecord") + `2\n${name}\n70\n0\n`;
}

function dimstyleEntry(h: string, owner: string): string {
  // DIMSTYLE table entries are the one DXF record that uses group 105 for
  // its handle instead of 5 — a documented quirk, not a typo.
  return (
    `0\nDIMSTYLE\n105\n${h}\n330\n${owner}\n100\nAcDbSymbolTableRecord\n100\nAcDbDimStyleTableRecord\n` +
    `2\nStandard\n70\n0\n`
  );
}

function layerEntry(h: string, owner: string, name: string): string {
  return (
    symbolRecordHead("LAYER", h, owner, "AcDbLayerTableRecord") +
    `2\n${name}\n70\n0\n62\n7\n6\nContinuous\n`
  );
}

function blockRecordEntry(h: string, owner: string, name: string): string {
  return symbolRecordHead("BLOCK_RECORD", h, owner, "AcDbBlockTableRecord") + `2\n${name}\n`;
}

function header(insUnits: number, bounds: { minX: number; minY: number; maxX: number; maxY: number }, seed: string): string {
  return (
    `0\nSECTION\n2\nHEADER\n` +
    `9\n$ACADVER\n1\nAC1032\n` +
    `9\n$ACADMAINTVER\n70\n0\n` +
    `9\n$DWGCODEPAGE\n3\nANSI_1252\n` +
    `9\n$HANDSEED\n5\n${seed}\n` +
    unitsAndExtentsHeader(insUnits, bounds) +
    `9\n$LTSCALE\n40\n1.0\n` +
    `9\n$CLAYER\n8\n0\n` +
    `9\n$TEXTSTYLE\n7\nStandard\n` +
    `9\n$CMLSTYLE\n2\nStandard\n` +
    `9\n$DIMSTYLE\n2\nStandard\n` +
    `0\nENDSEC\n`
  );
}

function tablesSection(plan: Plan, layers: string[], blockDefs: readonly BlockDefinition[], textStyles: readonly TextStyle[] = []): string {
  const { h, layerHandles, linetypeHandles } = plan;
  const layerEntries = layers.map((name) => layerEntry(layerHandles.get(name)!, h.layerTable, name));
  const ltypeEntries = [...linetypeHandles].map(([name, handle]) => ltypeEntry(handle, h.ltypeTable, name));
  return (
    `0\nSECTION\n2\nTABLES\n` +
    table("VPORT", h.vportTable, []) +
    table("LTYPE", h.ltypeTable, ltypeEntries) +
    table("LAYER", h.layerTable, layerEntries) +
    table("STYLE", h.styleTable, [
      styleEntry(h.standardStyle, h.styleTable, textStyles.find((s) => s.name === "Standard")),
      ...textStyles.filter((s) => s.name !== "Standard").map((s) => styleEntry(plan.alloc.alloc(), h.styleTable, s)),
    ]) +
    table("VIEW", h.viewTable, []) +
    table("UCS", h.ucsTable, []) +
    table("APPID", h.appidTable, [
      appidEntry(h.acadAppid, h.appidTable, "ACAD"),
      appidEntry(h.sketchorAppid, h.appidTable, "SKETCHOR"),
    ]) +
    table("DIMSTYLE", h.dimstyleTable, [dimstyleEntry(h.standardDimstyle, h.dimstyleTable)], `100\nAcDbDimStyleTable\n71\n1\n`) +
    table("BLOCK_RECORD", h.blockRecordTable, [
      blockRecordEntry(h.modelSpaceBlockRecord, h.blockRecordTable, "*Model_Space"),
      blockRecordEntry(h.paperSpaceBlockRecord, h.blockRecordTable, "*Paper_Space"),
      ...blockDefs.map((d) => blockRecordEntry(plan.blocks.get(d.name)!.record, h.blockRecordTable, d.name)),
    ]) +
    `0\nENDSEC\n`
  );
}

function blockBeginEnd(beginH: string, endH: string, recordH: string, name: string): string {
  return (
    `0\nBLOCK\n5\n${beginH}\n330\n${recordH}\n100\nAcDbEntity\n8\n0\n100\nAcDbBlockBegin\n` +
    `2\n${name}\n70\n0\n10\n0.0\n20\n0.0\n30\n0.0\n3\n${name}\n1\n\n` +
    `0\nENDBLK\n5\n${endH}\n330\n${recordH}\n100\nAcDbEntity\n8\n0\n100\nAcDbBlockEnd\n`
  );
}

function blocksSection(plan: Plan, userBlocks: string): string {
  const { h } = plan;
  return (
    `0\nSECTION\n2\nBLOCKS\n` +
    blockBeginEnd(h.modelSpaceBlockBegin, h.modelSpaceBlockEnd, h.modelSpaceBlockRecord, "*Model_Space") +
    blockBeginEnd(h.paperSpaceBlockBegin, h.paperSpaceBlockEnd, h.paperSpaceBlockRecord, "*Paper_Space") +
    userBlocks +
    `0\nENDSEC\n`
  );
}

function layoutObject(h: string, ownerDict: string, name: string, blockRecord: string, tabOrder: number): string {
  return (
    `0\nLAYOUT\n5\n${h}\n330\n${ownerDict}\n100\nAcDbPlotSettings\n` +
    `1\n\n100\nAcDbLayout\n1\n${name}\n70\n1\n71\n${tabOrder}\n` +
    `12\n0.0\n22\n0.0\n32\n0.0\n14\n0.0\n24\n0.0\n34\n0.0\n15\n0.0\n25\n0.0\n35\n0.0\n330\n${blockRecord}\n`
  );
}

/** X-05: one DXF GROUP object per Sketchor group (nested groups list their flattened entities, since DXF groups cannot nest). Names are made unique, as the ACAD_GROUP dictionary requires. */
function groupObjects(plan: Plan, groups: readonly Group[], flat: (g: Group) => string[], handleOf: Map<string, string>, groupHandles: Map<string, string>): { dict: string; objects: string } {
  const used = new Set<string>();
  let dict = "";
  let objects = "";
  for (const g of groups) {
    const members = flat(g).map((id) => handleOf.get(id)).filter((x): x is string => !!x);
    if (members.length === 0) continue;
    const base = (g.name || "Group").replace(/[<>/\\":;?*|,=`\r\n]/g, "_");
    let name = base;
    for (let i = 2; used.has(name.toUpperCase()); i++) name = `${base} (${i})`;
    used.add(name.toUpperCase());
    const h = groupHandles.get(g.id)!;
    dict += `3\n${name}\n350\n${h}\n`;
    objects +=
      `0\nGROUP\n5\n${h}\n330\n${plan.h.groupDict}\n100\nAcDbGroup\n300\n\n70\n0\n71\n1\n` +
      members.map((m) => `340\n${m}\n`).join("");
  }
  return { dict, objects };
}

function objectsSection(plan: Plan, groupsPart: { dict: string; objects: string }, data: SketchorDocData | null): string {
  const { h } = plan;
  const root =
    `0\nDICTIONARY\n5\n${h.rootDict}\n330\n0\n100\nAcDbDictionary\n281\n1\n` +
    `3\nACAD_GROUP\n350\n${h.groupDict}\n3\nACAD_LAYOUT\n350\n${h.layoutDict}\n` +
    (data ? `3\n${SKETCHOR_DICT_KEY}\n350\n${h.sketchorXrecord}\n` : "");
  const xrecord = data
    ? `0\nXRECORD\n5\n${h.sketchorXrecord}\n330\n${h.rootDict}\n100\nAcDbXrecord\n280\n1\n` + encodeDocData(data).map((c) => `1\n${c}\n`).join("")
    : "";
  const groupDict = `0\nDICTIONARY\n5\n${h.groupDict}\n330\n${h.rootDict}\n100\nAcDbDictionary\n281\n1\n` + groupsPart.dict;
  const layoutDict =
    `0\nDICTIONARY\n5\n${h.layoutDict}\n330\n${h.rootDict}\n100\nAcDbDictionary\n281\n1\n` +
    `3\nModel\n350\n${h.modelLayout}\n3\nLayout1\n350\n${h.layout1Layout}\n`;
  return (
    `0\nSECTION\n2\nOBJECTS\n` +
    root +
    groupDict +
    layoutDict +
    layoutObject(h.modelLayout, h.layoutDict, "Model", h.modelSpaceBlockRecord, 0) +
    layoutObject(h.layout1Layout, h.layoutDict, "Layout1", h.paperSpaceBlockRecord, 1) +
    groupsPart.objects +
    xrecord +
    `0\nENDSEC\n`
  );
}

export interface DxfWriteOptions2018 {
  /** `$INSUNITS` code (0 unitless, 1 in, 2 ft, 4 mm, 5 cm, 6 m). Default 0. */
  insUnits?: number;
  /** Factor applied to every coordinate/radius before writing — see `entitiesToDxf`'s doc in dxfExport.ts. Default 1. */
  scale?: number;
  /** B-08: the drawing's block definitions (mm, like the entities). Inserts naming one are written as INSERTs; without them (or for an unknown name) inserts are the caller's to flatten. */
  blocks?: readonly BlockDefinition[];
  /** D-01: the drawing's `textStyles` records, written as STYLE table entries (TEXT group 7 names them). */
  textStyles?: readonly TextStyle[];
  /** X-09: unmodelled entities from an imported DXF, written back unchanged (new handles). Only those read in the output unit are written. */
  foreign?: readonly ForeignRecord[];
  /** X-05/X-08: the drawing's groups (written as DXF GROUP objects and, exactly, in the SKETCHOR record), constraints and `params` table. Not scaled: constraint values stay in mm. */
  groups?: readonly Group[];
  constraints?: readonly Constraint[];
  params?: readonly TableRecord[];
}

/**
 * Writes entities as AC1032 ("DXF 2018"). See the module doc above for the
 * structural choices. Entity names round-trip via `SKETCHOR` XDATA; R12
 * export (`dxfExport.ts`) still drops them, since R12 predates XDATA's
 * modern use and CAM shops reading it don't want the extra data anyway.
 */
export function entitiesToDxf2018(entitiesIn: Entity[], options: DxfWriteOptions2018 = {}): string {
  const { insUnits = 0, scale = 1 } = options;
  // D-02a: dimensions are written as their parts until D-10 adds real DIMENSION records.
  const entities = explodeDimensions(entitiesIn);
  const blockHost = styleOnlyHost(activeDimHost());
  const blockDefs = (options.blocks ?? [])
    .map((d) => (d.entities.some((e) => e.type === "dimension") ? { ...d, entities: explodeDimensions(d.entities, blockHost) } : d))
    .map((d) => (scale !== 1 ? scaleBlockDefinition(d, scale) : d));
  const defByName = new Map(blockDefs.map((d) => [d.name, d]));
  const scaled = scale !== 1 ? entities.map((e) => scaleEntityKeepingInserts(e, scale)) : entities;
  const everyEntity = [...scaled, ...blockDefs.flatMap((d) => d.entities)];
  const foreign = (options.foreign ?? []).filter((f) => f.units === insUnits || f.units === 0 || insUnits === 0);
  const layers = [...new Set([...everyEntity.map((e) => layerOf(e)), ...foreign.map((f) => f.layer)])];
  if (layers.length === 0) layers.push("0");
  const linetypes = [...new Set(everyEntity.map((e) => e.linetype).filter((l): l is string => !!l))];
  const bounds = boundsOf(scaled.filter((e) => !(e.type === "line" && e.infinite))) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  const plan = buildPlan(layers, linetypes, blockDefs);
  const next = () => plan.alloc.alloc();
  const handleOf = new Map<string, string>();
  const groups = options.groups ?? [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const flat = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (gid: string) => {
      if (seen.has(gid)) return;
      seen.add(gid);
      for (const m of byId.get(gid)?.members ?? []) {
        if (byId.has(m)) walk(m);
        else out.push(m);
      }
    };
    walk(id);
    return out;
  };
  // Group handles are fixed before the entities are written: AutoCAD wants every member to name its groups as persistent reactors.
  const groupHandles = new Map(groups.map((g) => [g.id, next()] as const));
  const reactorsOf = new Map<string, string[]>();
  for (const g of groups) for (const m of new Set(flat(g.id))) reactorsOf.set(m, [...(reactorsOf.get(m) ?? []), groupHandles.get(g.id)!]);
  const write = (e: Entity, owner: string): string => {
    const h = next();
    handleOf.set(e.id, h);
    let text: string;
    if (e.type === "insert") {
      const def = defByName.get(e.block);
      text = def ? insertEntity2018(e, def, h, owner, next) : ""; // an insert of an unknown block draws nothing
    } else {
      text = entityDxf2018(e, h, owner, next);
    }
    const reactors = reactorsOf.get(e.id);
    return reactors && text ? text.replace(`5\n${h}\n`, `5\n${h}\n102\n{ACAD_REACTORS\n${reactors.map((r) => `330\n${r}\n`).join("")}102\n}\n`) : text;
  };
  const userBlocks = blockDefinitions2018(blockDefs, plan.blocks, next, write);

  // Infinite construction lines are drawing aids, not geometry: they stay out of the file (same rule as R12).
  const exported = scaled.filter((e) => !(e.type === "line" && e.infinite));
  const entitiesText = exported.map((e) => write(e, plan.h.modelSpaceBlockRecord)).join("") + foreign.map((f) => foreignEntityText(f, next(), plan.h.modelSpaceBlockRecord)).join("");

  const groupsPart = groupObjects(plan, groups, (g) => flat(g.id), handleOf, groupHandles);
  const blockExtras: Record<string, BlockExtras> = {};
  for (const d of options.blocks ?? []) {
    const x: BlockExtras = {};
    if (d.explodable === false) x.explodable = false;
    if (d.scaleUniformly) x.scaleUniformly = true;
    if (d.description) x.description = d.description;
    if (d.units !== undefined) x.units = d.units;
    if (d.dynamic !== undefined) x.dynamic = d.dynamic;
    if (d.constraints?.length) x.constraints = [...d.constraints];
    if (Object.keys(x).length) blockExtras[d.name] = x;
  }
  const docData: SketchorDocData = { v: 1 };
  if (groups.length) docData.groups = [...groups];
  if (options.constraints?.length) docData.constraints = [...options.constraints];
  if (options.params?.length) docData.params = [...options.params];
  if (Object.keys(blockExtras).length) docData.blocks = blockExtras;
  const objects = objectsSection(plan, groupsPart, Object.keys(docData).length > 1 ? docData : null);

  return (
    header(insUnits, bounds, plan.alloc.seed()) +
    `0\nSECTION\n2\nCLASSES\n${foreign.map(foreignClassText).join("")}0\nENDSEC\n` +
    tablesSection(plan, layers, blockDefs, options.textStyles) +
    blocksSection(plan, userBlocks) +
    `0\nSECTION\n2\nENTITIES\n${entitiesText}0\nENDSEC\n` +
    objects +
    `0\nEOF\n`
  );
}

export { pair };
