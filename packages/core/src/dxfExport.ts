import type { ArcEntity, CircleEntity, Entity, LineEntity } from "./entities";
import { layerOf } from "./entities";
import { boundsOf } from "./dxf";

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

function entityDxf(e: Entity): string {
  switch (e.type) {
    case "line":
      return lineEntity(e);
    case "circle":
      return circleEntity(e);
    case "arc":
      return arcEntity(e);
  }
}

export function entitiesToDxf(entities: Entity[]): string {
  const layers = [...new Set(entities.map((e) => layerOf(e)))];
  if (layers.length === 0) layers.push("0");
  const bounds = boundsOf(entities) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  const header =
    `0\nSECTION\n2\nHEADER\n` +
    `9\n$ACADVER\n1\nAC1009\n` +
    `9\n$INSBASE\n10\n0.0\n20\n0.0\n30\n0.0\n` +
    `9\n$EXTMIN\n10\n${n(bounds.minX)}\n20\n${n(bounds.minY)}\n30\n0.0\n` +
    `9\n$EXTMAX\n10\n${n(bounds.maxX)}\n20\n${n(bounds.maxY)}\n30\n0.0\n` +
    `0\nENDSEC\n`;

  const tables = `0\nSECTION\n2\nTABLES\n${layerTable(layers)}0\nENDSEC\n`;

  const entitiesSection = `0\nSECTION\n2\nENTITIES\n${entities.map(entityDxf).join("")}0\nENDSEC\n`;

  return `${header}${tables}${entitiesSection}0\nEOF\n`;
}
