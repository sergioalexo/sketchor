import type { ArcEntity, CircleEntity, Entity, ImageEntity, LineEntity, PointEntity, PolylineEntity, TextEntity } from "../entities";
import { imageCorners, layerOf } from "../entities";
import { dist } from "../geometry";
import { kindTessellate } from "../kinds/registry";
import { aciToHex, hexToRgb, nearestAci } from "../aci";
import { n, pair } from "./write";

const RAD_TO_DEG = 180 / Math.PI;

/**
 * X-04: color 62 (ACI, the nearest palette match — always written, so a
 * reader that ignores true colour still gets *a* colour) plus true colour
 * 420 (exact 0xRRGGBB) when the nearest ACI isn't already an exact match,
 * so the common case (a CSS colour that happens to be one of the 256
 * palette entries) doesn't carry a redundant group. R12 can't do this — no
 * 420 — so its writer (`dxfExport.ts`) only ever has the ACI fallback.
 */
function colorGroups(e: Entity): string {
  if (!e.color) return "";
  const rgb = hexToRgb(e.color);
  if (!rgb) return ""; // a named CSS colour or similar — ACI/true-colour have no representation for it
  const aci = nearestAci(e.color);
  const trueColorInt = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  const aciIsExact = aciToHex(aci) === `#${trueColorInt.toString(16).padStart(6, "0")}`;
  // 62 and 420 are integer groups — unlike pair()'s coordinates/radii, they must NOT get n()'s ".0" suffix.
  return `62\n${aci}\n` + (aciIsExact ? "" : `420\n${trueColorInt}\n`);
}

/**
 * `5`/`330`/`100 AcDbEntity` + layer + colour — the common head every
 * AC1032 entity record opens with, before its subclass-specific groups.
 */
function entityHead(handle: string, owner: string, e: Entity): string {
  return `5\n${handle}\n330\n${owner}\n100\nAcDbEntity\n8\n${layerOf(e)}\n${colorGroups(e)}`;
}

/**
 * `1001 SKETCHOR` extended data carrying the entity's stable sketch-code
 * name (see sketchtext.ts), so a file Sketchor wrote and reopens keeps the
 * same L1/C1/... names instead of renumbering — the thing R12 export always
 * lost. Only written when the entity has a name.
 */
function nameXdata(name: string | undefined): string {
  if (!name) return "";
  return `1001\nSKETCHOR\n1000\n${name}\n`;
}

export function lineEntity2018(e: LineEntity, handle: string, owner: string): string {
  return (
    `0\nLINE\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbLine\n` +
    pair(10, e.a.x) + pair(20, e.a.y) + pair(30, 0) +
    pair(11, e.b.x) + pair(21, e.b.y) + pair(31, 0) +
    nameXdata(e.name)
  );
}

export function circleEntity2018(e: CircleEntity, handle: string, owner: string): string {
  return (
    `0\nCIRCLE\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbCircle\n` +
    pair(10, e.center.x) + pair(20, e.center.y) + pair(30, 0) +
    pair(40, e.radius) +
    nameXdata(e.name)
  );
}

export function arcEntity2018(e: ArcEntity, handle: string, owner: string): string {
  // DXF ARC always sweeps counterclockwise from code 50 to 51; a clockwise
  // arc is the same curve read the other way, so swap the endpoints.
  const startDeg = (e.ccw ? e.startAngle : e.endAngle) * RAD_TO_DEG;
  const endDeg = (e.ccw ? e.endAngle : e.startAngle) * RAD_TO_DEG;
  return (
    `0\nARC\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbCircle\n` +
    pair(10, e.center.x) + pair(20, e.center.y) + pair(30, 0) +
    pair(40, e.radius) +
    `100\nAcDbArc\n` +
    pair(50, startDeg) + pair(51, endDeg) +
    nameXdata(e.name)
  );
}

export function pointEntity2018(e: PointEntity, handle: string, owner: string): string {
  return (
    `0\nPOINT\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbPoint\n` +
    pair(10, e.p.x) + pair(20, e.p.y) + pair(30, 0) +
    nameXdata(e.name)
  );
}

/** As LWPOLYLINE (the inverse of dxf.ts's `lwpolylineVertices`/`emitPolylineWithBulges`). */
export function polylineEntity2018(e: PolylineEntity, handle: string, owner: string): string {
  const verts = e.points
    .map((p, i) => pair(10, p.x) + pair(20, p.y) + pair(42, e.bulges?.[i] ?? 0))
    .join("");
  return (
    `0\nLWPOLYLINE\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbPolyline\n` +
    `90\n${e.points.length}\n` +
    `70\n${e.closed ? 1 : 0}\n` +
    verts +
    nameXdata(e.name)
  );
}

export function textEntity2018(e: TextEntity, handle: string, owner: string): string {
  return (
    `0\nTEXT\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbText\n` +
    pair(10, e.at.x) + pair(20, e.at.y) + pair(30, 0) +
    pair(40, e.height) +
    pair(1, e.text) +
    (e.rotation ? pair(50, (e.rotation * 180) / Math.PI) : "") +
    pair(7, "Standard") +
    `100\nAcDbText\n` +
    nameXdata(e.name)
  );
}

/**
 * DXF's IMAGE entity references an external raster file through a separate
 * IMAGEDEF object — there's no way to embed pixels inline — and a true
 * round trip needs a sidecar PNG the caller writes next to the DXF (desktop:
 * a native path; web: a second File System Access write). That plumbing is
 * X-01 follow-up (image sidecar export isn't wired into any save path yet),
 * so for now an image keeps exporting as a labelled placeholder box, same as
 * the R12 writer — position/size/rotation survive, the picture doesn't.
 */
export function imageEntity2018(e: ImageEntity, handle: string, owner: string, nextHandle: () => string): string {
  const corners = imageCorners(e);
  const verts = corners.map((p) => pair(10, p.x) + pair(20, p.y) + pair(42, 0)).join("");
  const box =
    `0\nLWPOLYLINE\n` +
    entityHead(handle, owner, e) +
    `100\nAcDbPolyline\n` +
    `90\n${corners.length}\n70\n1\n` +
    verts;
  const labelHeight = Math.min(e.width, e.height) * 0.08 || 1;
  const label =
    `0\nTEXT\n` +
    entityHead(nextHandle(), owner, e) +
    `100\nAcDbText\n` +
    pair(10, e.insert.x) + pair(20, e.insert.y) + pair(30, 0) +
    pair(40, labelHeight) +
    pair(1, `[image${e.name ? " " + e.name : ""}]`) +
    pair(7, "Standard") +
    `100\nAcDbText\n`;
  return box + label;
}

/**
 * One entity as AC1032 record(s). `nextHandle`/`owner` let a multi-record
 * entity (image) or a kind outside the built-in seven (tessellated to
 * polylines, each needing its own handle) allocate as many handles as they
 * need.
 */
export function entityDxf2018(e: Entity, handle: string, owner: string, nextHandle: () => string): string {
  switch (e.type) {
    case "line":
      return lineEntity2018(e, handle, owner);
    case "circle":
      return circleEntity2018(e, handle, owner);
    case "arc":
      return arcEntity2018(e, handle, owner);
    case "point":
      return pointEntity2018(e, handle, owner);
    case "polyline":
      return polylineEntity2018(e, handle, owner);
    case "text":
      return textEntity2018(e, handle, owner);
    case "image":
      return imageEntity2018(e, handle, owner, nextHandle);
    default:
      // A kind outside the built-in seven (kinds/registry.ts): write its
      // tessellation as polylines, same fallback as the R12 writer.
      return kindTessellate(e as Entity, 0.01)
        .filter((run) => run.length >= 2)
        .map((run, i) => {
          const closed = run.length > 2 && dist(run[0], run[run.length - 1]) < 1e-9;
          const poly: PolylineEntity = {
            id: (e as Entity).id,
            type: "polyline",
            layer: (e as Entity).layer,
            color: (e as Entity).color,
            points: closed ? run.slice(0, -1) : run,
            closed,
          };
          return polylineEntity2018(poly, i === 0 ? handle : nextHandle(), owner);
        })
        .join("");
  }
}

// Re-exported so dxfw/index.ts doesn't need a second import of these tiny helpers.
export { n, pair };
