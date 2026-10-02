import type { Entity } from "../entities";
import { layerOf, transformed } from "../entities";
import { boundsOf } from "../dxf";
import { HandleAllocator } from "./handles";
import { entityDxf2018 } from "./entities";
import { n, pair } from "./write";

const ORIGIN = { x: 0, y: 0 };

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
  "continuousLtype",
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
] as const;
type HandleKey = (typeof STANDARD_HANDLES)[number];

interface Plan {
  alloc: HandleAllocator;
  h: Record<HandleKey, string>;
  layerHandles: Map<string, string>;
}

function buildPlan(layers: string[]): Plan {
  const alloc = new HandleAllocator();
  const h = {} as Record<HandleKey, string>;
  for (const key of STANDARD_HANDLES) h[key] = alloc.alloc();
  const layerHandles = new Map(layers.map((name) => [name, alloc.alloc()] as const));
  return { alloc, h, layerHandles };
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

function ltypeEntry(h: string, owner: string): string {
  return (
    symbolRecordHead("LTYPE", h, owner, "AcDbLinetypeTableRecord") +
    `2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n`
  );
}

function styleEntry(h: string, owner: string): string {
  return (
    symbolRecordHead("STYLE", h, owner, "AcDbTextStyleTableRecord") +
    `2\nStandard\n70\n0\n40\n0.0\n41\n1.0\n50\n0.0\n71\n0\n42\n2.5\n3\ntxt\n4\n\n`
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
  const metric = insUnits === 4 || insUnits === 5 || insUnits === 6;
  // $MEASUREMENT is only written when a real unit is declared. dxf.ts's own
  // parser treats $MEASUREMENT as authoritative whenever $INSUNITS is absent
  // or 0 (real-world files — notably Onshape's R14 export — only carry
  // $MEASUREMENT, see resolveUnits in dxf.ts) — so writing "$MEASUREMENT 0"
  // for insUnits=0 ("truly unspecified") would make our *own* files come
  // back misread as inches and scaled 25.4x, same bug that rule exists to
  // catch in files from other applications.
  const measurement = insUnits === 0 ? "" : `9\n$MEASUREMENT\n70\n${metric ? 1 : 0}\n`;
  return (
    `0\nSECTION\n2\nHEADER\n` +
    `9\n$ACADVER\n1\nAC1032\n` +
    `9\n$ACADMAINTVER\n70\n0\n` +
    `9\n$DWGCODEPAGE\n3\nANSI_1252\n` +
    `9\n$HANDSEED\n5\n${seed}\n` +
    measurement +
    `9\n$INSUNITS\n70\n${insUnits}\n` +
    `9\n$INSBASE\n10\n0.0\n20\n0.0\n30\n0.0\n` +
    `9\n$EXTMIN\n10\n${n(bounds.minX)}\n20\n${n(bounds.minY)}\n30\n0.0\n` +
    `9\n$EXTMAX\n10\n${n(bounds.maxX)}\n20\n${n(bounds.maxY)}\n30\n0.0\n` +
    `9\n$LTSCALE\n40\n1.0\n` +
    `9\n$CLAYER\n8\n0\n` +
    `9\n$TEXTSTYLE\n7\nStandard\n` +
    `9\n$CMLSTYLE\n2\nStandard\n` +
    `9\n$DIMSTYLE\n2\nStandard\n` +
    `0\nENDSEC\n`
  );
}

function tablesSection(plan: Plan, layers: string[]): string {
  const { h, layerHandles } = plan;
  const layerEntries = layers.map((name) => layerEntry(layerHandles.get(name)!, h.layerTable, name));
  return (
    `0\nSECTION\n2\nTABLES\n` +
    table("VPORT", h.vportTable, []) +
    table("LTYPE", h.ltypeTable, [ltypeEntry(h.continuousLtype, h.ltypeTable)]) +
    table("LAYER", h.layerTable, layerEntries) +
    table("STYLE", h.styleTable, [styleEntry(h.standardStyle, h.styleTable)]) +
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

function blocksSection(plan: Plan): string {
  const { h } = plan;
  return (
    `0\nSECTION\n2\nBLOCKS\n` +
    blockBeginEnd(h.modelSpaceBlockBegin, h.modelSpaceBlockEnd, h.modelSpaceBlockRecord, "*Model_Space") +
    blockBeginEnd(h.paperSpaceBlockBegin, h.paperSpaceBlockEnd, h.paperSpaceBlockRecord, "*Paper_Space") +
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

function objectsSection(plan: Plan): string {
  const { h } = plan;
  const root =
    `0\nDICTIONARY\n5\n${h.rootDict}\n330\n0\n100\nAcDbDictionary\n281\n1\n` +
    `3\nACAD_GROUP\n350\n${h.groupDict}\n3\nACAD_LAYOUT\n350\n${h.layoutDict}\n`;
  const groupDict = `0\nDICTIONARY\n5\n${h.groupDict}\n330\n${h.rootDict}\n100\nAcDbDictionary\n281\n1\n`;
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
    `0\nENDSEC\n`
  );
}

export interface DxfWriteOptions2018 {
  /** `$INSUNITS` code (0 unitless, 1 in, 2 ft, 4 mm, 5 cm, 6 m). Default 0. */
  insUnits?: number;
  /** Factor applied to every coordinate/radius before writing — see `entitiesToDxf`'s doc in dxfExport.ts. Default 1. */
  scale?: number;
}

/**
 * Writes entities as AC1032 ("DXF 2018"). See the module doc above for the
 * structural choices. Entity names round-trip via `SKETCHOR` XDATA; R12
 * export (`dxfExport.ts`) still drops them, since R12 predates XDATA's
 * modern use and CAM shops reading it don't want the extra data anyway.
 */
export function entitiesToDxf2018(entities: Entity[], options: DxfWriteOptions2018 = {}): string {
  const { insUnits = 0, scale = 1 } = options;
  const scaled = scale !== 1 ? entities.map((e) => transformed(e, ORIGIN, 0, 0, 0, scale)) : entities;
  const layers = [...new Set(scaled.map((e) => layerOf(e)))];
  if (layers.length === 0) layers.push("0");
  const bounds = boundsOf(scaled) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  const plan = buildPlan(layers);

  // Infinite construction lines are drawing aids, not geometry: they stay out of the file (same rule as R12).
  const exported = scaled.filter((e) => !(e.type === "line" && e.infinite));
  const entitiesText = exported
    .map((e) => entityDxf2018(e, plan.alloc.alloc(), plan.h.modelSpaceBlockRecord, () => plan.alloc.alloc()))
    .join("");

  const objects = objectsSection(plan);

  return (
    header(insUnits, bounds, plan.alloc.seed()) +
    `0\nSECTION\n2\nCLASSES\n0\nENDSEC\n` +
    tablesSection(plan, layers) +
    blocksSection(plan) +
    `0\nSECTION\n2\nENTITIES\n${entitiesText}0\nENDSEC\n` +
    objects +
    `0\nEOF\n`
  );
}

export { pair };
