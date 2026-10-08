import { explodeHatchEntities } from "./hatch/ops";
import type { ArcEntity, CircleEntity, Entity, ImageEntity, LineEntity, PointEntity, PolylineEntity, TextEntity } from "./entities";
import { imageCorners, layerOf, transformed } from "./entities";
import { dist } from "./geometry";
import { boundsOf } from "./dxf";
import { kindTessellate } from "./kinds/registry";
import { nearestAci } from "./aci";
import { escapeDxfText } from "./dxfText";
import { unitsAndExtentsHeader } from "./dxfw/write";
import { CONTINUOUS, builtinLinetype } from "./linetypes";

const ORIGIN = { x: 0, y: 0 };

/**
 * Writes a minimal but broadly-compatible ASCII DXF (AC1009 / R12), the
 * inverse of dxf.ts's parser. Includes a HEADER (with the drawing's
 * extents) and a TABLES/LAYER section so real CAD software — not just
 * Sketchor's own importer — opens the result with correct layers, not
 * just a raw ENTITIES dump.
 */

function n(x: number): string {
  // DXF numeric group values are conventionally written with a decimal point.
  const r = Math.round(x * 1e6) / 1e6;
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

function pair(code: number, value: string | number): string {
  return `${code}\n${typeof value === "number" ? n(value) : escapeDxfText(value)}\n`;
}

function layerTable(layers: string[]): string {
  const rows = layers
    .map((name) => `0\nLAYER\n2\n${escapeDxfText(name)}\n70\n0\n62\n7\n6\nCONTINUOUS\n`)
    .join("");
  return `0\nTABLE\n2\nLAYER\n70\n${layers.length}\n${rows}0\nENDTAB\n`;
}

/**
 * Z-04: an R12 `LTYPE` table entry. `72`/`73`/`40` are the alignment code
 * (always `65` = "A"), dash-element count and total pattern length; `49` is
 * repeated once per element (the DXF group-49 convention this module's own
 * `pattern` arrays already follow — positive dash, negative gap).
 */
function ltypeEntry(name: string): string {
  const def = builtinLinetype(name);
  const total = def.pattern.reduce((a, b) => a + Math.abs(b), 0);
  const elements = def.pattern.map((v) => `49\n${n(v)}\n`).join("");
  return (
    `0\nLTYPE\n2\n${def.name}\n70\n0\n3\n${def.description}\n72\n65\n` +
    `73\n${def.pattern.length}\n40\n${n(total)}\n${elements}`
  );
}

function ltypeTable(linetypes: readonly string[]): string {
  const names = [CONTINUOUS, ...linetypes.filter((l) => l !== CONTINUOUS)];
  const rows = names.map(ltypeEntry).join("");
  return `0\nTABLE\n2\nLTYPE\n70\n${names.length}\n${rows}0\nENDTAB\n`;
}

/**
 * X-04: color 62 (ACI) when the entity has an explicit colour, nothing
 * otherwise (BYLAYER — every layer here is written as ACI 7, see
 * `layerTable`). R12 predates true colour (group 420, AC1018+), so an
 * arbitrary CSS colour can only travel as its nearest indexed match — see
 * `dxfw/entities.ts`'s AC1032 writer for the lossless path.
 */
function colorGroup(e: Entity): string {
  // Group 62 is an integer group — unlike pair()'s coordinates/radii it must NOT get n()'s ".0" suffix.
  return e.color ? `62\n${nearestAci(e.color)}\n` : "";
}

/**
 * Z-04: linetype (group 6, by name — BYLAYER when the entity has none of
 * its own, same omit-means-inherit convention as colour) and lineweight
 * (group 370, hundredths of a millimetre — DXF's own unit for it; BYLAYER
 * the same way). Neither resolves BYLAYER against a layer's own default
 * here — this function only ever sees a flat `Entity[]`, not a document, the
 * same limitation `colorGroup` already has (see `layerTable`'s ACI-7 note).
 */
function linetypeGroups(e: Entity): string {
  const lt = e.linetype ? `6\n${e.linetype}\n` : "";
  const lw = e.lineweight !== undefined ? `370\n${Math.round(e.lineweight * 100)}\n` : "";
  return lt + lw;
}

function lineEntity(e: LineEntity): string {
  return (
    `0\nLINE\n` +
    pair(8, layerOf(e)) +
    colorGroup(e) +
    linetypeGroups(e) +
    pair(10, e.a.x) +
    pair(20, e.a.y) +
    pair(30, 0) +
    pair(11, e.b.x) +
    pair(21, e.b.y) +
    pair(31, 0)
  );
}

function circleEntity(e: CircleEntity): string {
  return (
    `0\nCIRCLE\n` +
    pair(8, layerOf(e)) +
    colorGroup(e) +
    linetypeGroups(e) +
    pair(10, e.center.x) +
    pair(20, e.center.y) +
    pair(30, 0) +
    pair(40, e.radius)
  );
}

const RAD_TO_DEG = 180 / Math.PI;

function arcEntity(e: ArcEntity): string {
  // DXF ARC always sweeps counterclockwise from code 50 to 51; a clockwise
  // arc is the same curve read the other way, so swap the endpoints.
  const startDeg = (e.ccw ? e.startAngle : e.endAngle) * RAD_TO_DEG;
  const endDeg = (e.ccw ? e.endAngle : e.startAngle) * RAD_TO_DEG;
  return (
    `0\nARC\n` +
    pair(8, layerOf(e)) +
    colorGroup(e) +
    linetypeGroups(e) +
    pair(10, e.center.x) +
    pair(20, e.center.y) +
    pair(30, 0) +
    pair(40, e.radius) +
    pair(50, startDeg) +
    pair(51, endDeg)
  );
}

function pointEntity(e: PointEntity): string {
  return `0\nPOINT\n` + pair(8, layerOf(e)) + colorGroup(e) + linetypeGroups(e) + pair(10, e.p.x) + pair(20, e.p.y) + pair(30, 0);
}

/** As LWPOLYLINE (the inverse of dxf.ts's `lwpolylineVertices`/`emitPolylineWithBulges`). */
function polylineEntity(e: PolylineEntity): string {
  const verts = e.points
    .map((p, i) => pair(10, p.x) + pair(20, p.y) + pair(30, 0) + pair(42, e.bulges?.[i] ?? 0))
    .join("");
  return (
    `0\nLWPOLYLINE\n` +
    pair(8, layerOf(e)) +
    colorGroup(e) +
    linetypeGroups(e) +
    `90\n${e.points.length}\n` +
    `70\n${e.closed ? 1 : 0}\n` +
    verts
  );
}

function textEntity(e: TextEntity): string {
  return (
    `0\nTEXT\n` +
    pair(8, layerOf(e)) +
    colorGroup(e) +
    linetypeGroups(e) +
    pair(10, e.at.x) +
    pair(20, e.at.y) +
    pair(30, 0) +
    pair(40, e.height) +
    pair(1, e.text) +
    (e.rotation ? pair(50, (e.rotation * 180) / Math.PI) : "")
  );
}

/**
 * DXF has no way to embed raster bytes inline — its real IMAGE entity
 * references an external file through a separate IMAGEDEF object (and needs
 * an AC1015+ header; this exporter writes AC1009/R12). Rather than write a
 * spec-inconsistent, likely-broken IMAGE entity, an image exports as a
 * labelled placeholder box so its position/size/rotation survive round-trip
 * even though the picture itself doesn't travel into the DXF.
 */
function imageEntity(e: ImageEntity): string {
  const corners = imageCorners(e);
  const verts = corners.map((p) => pair(10, p.x) + pair(20, p.y) + pair(30, 0) + pair(42, 0)).join("");
  const box = `0\nLWPOLYLINE\n` + pair(8, layerOf(e)) + `90\n${corners.length}\n` + `70\n1\n` + verts;
  const labelHeight = Math.min(e.width, e.height) * 0.08 || 1;
  const label =
    `0\nTEXT\n` +
    pair(8, layerOf(e)) +
    pair(10, e.insert.x) +
    pair(20, e.insert.y) +
    pair(30, 0) +
    pair(40, labelHeight) +
    pair(1, `[image${e.name ? " " + e.name : ""}]`);
  return box + label;
}

function tessellatedDxf(e: Entity): string {
  // A kind outside the built-in seven (kinds/registry.ts): R12 has no such entity, so write its tessellation as polylines.
  return kindTessellate(e as Entity, 0.01)
    .filter((run) => run.length >= 2)
    .map((run) => {
      const closed = run.length > 2 && dist(run[0], run[run.length - 1]) < 1e-9;
      return polylineEntity({
        id: (e as Entity).id,
        type: "polyline",
        layer: (e as Entity).layer,
        color: (e as Entity).color,
        linetype: (e as Entity).linetype,
        lineweight: (e as Entity).lineweight,
        points: closed ? run.slice(0, -1) : run,
        closed,
      });
    })
    .join("");
}

function entityDxf(e: Entity): string {
  switch (e.type) {
    case "line":
      return lineEntity(e);
    case "circle":
      return circleEntity(e);
    case "arc":
      return arcEntity(e);
    case "point":
      return pointEntity(e);
    case "polyline":
      return polylineEntity(e);
    case "text":
      return textEntity(e);
    case "image":
      return imageEntity(e);
    case "hatch": {
      // R12 has no HATCH: a pattern becomes its lines (H-09); a solid or gradient keeps the boundary outline below.
      if (e.paint.kind === "pattern") {
        const lines = explodeHatchEntities(e);
        if (lines) return lines.map(entityDxf).join("");
      }
      return tessellatedDxf(e);
    }
    default:
      return tessellatedDxf(e);
  }
}

/**
 * @param insUnits The HEADER's `$INSUNITS` code to write (0 unitless, 1 in,
 * 2 ft, 4 mm, 5 cm, 6 m — see dxf.ts's `MM_PER_INSUNIT`). Defaults to 0
 * (unspecified) when the caller doesn't track a real-world unit.
 * @param scale Factor applied to every coordinate/radius before writing, so
 * the file's numbers actually match the unit declared in `insUnits`.
 * Entities are always stored internally in millimeters (see units.ts), so a
 * caller writing e.g. inches passes `1 / 25.4` here — writing raw mm values
 * under an inches tag would silently produce a file 25.4x the wrong size.
 * Defaults to 1 (no rescaling, i.e. the file's numbers stay millimeters).
 */
export function entitiesToDxf(entities: Entity[], insUnits = 0, scale = 1): string {
  const scaled = scale !== 1 ? entities.map((e) => transformed(e, ORIGIN, 0, 0, 0, scale)) : entities;
  const layers = [...new Set(scaled.map((e) => layerOf(e)))];
  if (layers.length === 0) layers.push("0");
  const linetypes = [...new Set(scaled.map((e) => e.linetype).filter((l): l is string => !!l))];
  const bounds = boundsOf(scaled.filter((e) => !(e.type === "line" && e.infinite))) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  const header =
    `0\nSECTION\n2\nHEADER\n` +
    `9\n$ACADVER\n1\nAC1009\n` +
    unitsAndExtentsHeader(insUnits, bounds) +
    `0\nENDSEC\n`;

  const tables = `0\nSECTION\n2\nTABLES\n${ltypeTable(linetypes)}${layerTable(layers)}0\nENDSEC\n`;

  // Infinite construction lines are drawing aids, not geometry: they stay out of the file.
  const exported = scaled.filter((e) => !(e.type === "line" && e.infinite));
  const entitiesSection = `0\nSECTION\n2\nENTITIES\n${exported.map(entityDxf).join("")}0\nENDSEC\n`;

  return `${header}${tables}${entitiesSection}0\nEOF\n`;
}
