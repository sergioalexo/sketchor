import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity, TextEntity } from "./entities";
import { layerOf, transformed } from "./entities";
import { boundsOf } from "./dxf";

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
  return `${code}\n${typeof value === "number" ? n(value) : value}\n`;
}

function layerTable(layers: string[]): string {
  const rows = layers
    .map((name) => `0\nLAYER\n2\n${name}\n70\n0\n62\n7\n6\nCONTINUOUS\n`)
    .join("");
  return `0\nTABLE\n2\nLAYER\n70\n${layers.length}\n${rows}0\nENDTAB\n`;
}

function lineEntity(e: LineEntity): string {
  return (
    `0\nLINE\n` +
    pair(8, layerOf(e)) +
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
    pair(10, e.center.x) +
    pair(20, e.center.y) +
    pair(30, 0) +
    pair(40, e.radius) +
    pair(50, startDeg) +
    pair(51, endDeg)
  );
}

function pointEntity(e: PointEntity): string {
  return `0\nPOINT\n` + pair(8, layerOf(e)) + pair(10, e.p.x) + pair(20, e.p.y) + pair(30, 0);
}

/** As LWPOLYLINE (the inverse of dxf.ts's `lwpolylineVertices`/`emitPolylineWithBulges`). */
function polylineEntity(e: PolylineEntity): string {
  const verts = e.points
    .map((p, i) => pair(10, p.x) + pair(20, p.y) + pair(30, 0) + pair(42, e.bulges?.[i] ?? 0))
    .join("");
  return (
    `0\nLWPOLYLINE\n` +
    pair(8, layerOf(e)) +
    `90\n${e.points.length}\n` +
    `70\n${e.closed ? 1 : 0}\n` +
    verts
  );
}

function textEntity(e: TextEntity): string {
  return (
    `0\nTEXT\n` +
    pair(8, layerOf(e)) +
    pair(10, e.at.x) +
    pair(20, e.at.y) +
    pair(30, 0) +
    pair(40, e.height) +
    pair(1, e.text) +
    (e.rotation ? pair(50, (e.rotation * 180) / Math.PI) : "")
  );
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
  }
}

/**
 * @param insUnits The HEADER's `$INSUNITS` code to write (0 unitless, 1 in,
 * 2 ft, 4 mm, 5 cm, 6 m — see dxf.ts's `parseInsUnits`). Defaults to 0
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
  const bounds = boundsOf(scaled) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  const header =
    `0\nSECTION\n2\nHEADER\n` +
    `9\n$ACADVER\n1\nAC1009\n` +
    `9\n$INSUNITS\n70\n${insUnits}\n` +
    `9\n$INSBASE\n10\n0.0\n20\n0.0\n30\n0.0\n` +
    `9\n$EXTMIN\n10\n${n(bounds.minX)}\n20\n${n(bounds.minY)}\n30\n0.0\n` +
    `9\n$EXTMAX\n10\n${n(bounds.maxX)}\n20\n${n(bounds.maxY)}\n30\n0.0\n` +
    `0\nENDSEC\n`;

  const tables = `0\nSECTION\n2\nTABLES\n${layerTable(layers)}0\nENDSEC\n`;

  const entitiesSection = `0\nSECTION\n2\nENTITIES\n${scaled.map(entityDxf).join("")}0\nENDSEC\n`;

  return `${header}${tables}${entitiesSection}0\nEOF\n`;
}
