import type { ArcEntity, Entity, PolylineEntity } from "./entities";
import { polylineSegments } from "./entities";
import type { Point } from "./geometry";
import { arcPointAt, arcSweep, bulgeToArc } from "./geometry";
import { boundsOf } from "./dxf";
import type { PdfBuilder, PdfPoint } from "./pdf";

/**
 * Draws entities onto a {@link PdfBuilder} page, scaled to fit a box — the PDF
 * counterpart of `entitiesToSvgDocument`, working from the same entity list
 * that `entitiesToDxf` writes. One geometry source, three renderings: the
 * canvas, the printed sheet, and the exported file.
 */

export interface PdfDrawBox {
  /** Page coordinates in points, Y down from the top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfDrawOptions {
  /** Colour for geometry that carries no colour of its own. */
  strokeColor?: string;
  /** Stroke width in points (default 0.5). */
  strokeWidth?: number;
  /**
   * Opacity is not used — PDF transparency needs an ExtGState, and a printed
   * plan wants solid colour anyway. Filled shapes are drawn solid, which is
   * also what makes the black/white labels on them legible.
   */
  fill?: boolean;
}

export interface PdfDrawResult {
  /** Points per world unit — what the geometry was scaled by to fit the box. */
  scale: number;
}

/**
 * Fits `entities` into `box` (preserving aspect ratio, centred) and draws them.
 * Returns the scale used, so a caller can annotate the result at the same size.
 */
export function drawEntitiesToPdf(
  pdf: PdfBuilder,
  entities: readonly Entity[],
  box: PdfDrawBox,
  opts: PdfDrawOptions = {},
): PdfDrawResult {
  const stroke = opts.strokeColor ?? "#111111";
  const drawable = entities.filter((e) => !(e.type === "line" && e.infinite) && e.type !== "image");
  const b = boundsOf(drawable as Entity[]);
  if (!b) return { scale: 1 };

  const worldW = Math.max(b.maxX - b.minX, 1e-6);
  const worldH = Math.max(b.maxY - b.minY, 1e-6);
  const scale = Math.min(box.width / worldW, box.height / worldH);
  // Centre whatever slack the aspect-ratio difference leaves.
  const offsetX = box.x + (box.width - worldW * scale) / 2;
  const offsetY = box.y + (box.height - worldH * scale) / 2;
  // World Y grows up, page Y grows down.
  const at = (p: Point): PdfPoint => ({
    x: offsetX + (p.x - b.minX) * scale,
    y: offsetY + (b.maxY - p.y) * scale,
  });

  const width = opts.strokeWidth ?? 0.5;
  const paintOf = (e: Entity) => {
    const closed = e.type === "circle" || (e.type === "polyline" && e.closed);
    const fill = opts.fill !== false && closed && "fill" in e ? (e.fill as string | undefined) : undefined;
    const dash = "dashed" in e && e.dashed ? [width * 4, width * 3] : undefined;
    return { stroke: e.color ?? stroke, fill, width, dash };
  };

  /** An arc as a run of short chords — the same tessellation the SVG export uses. */
  const arcPoints = (center: Point, radius: number, startAngle: number, endAngle: number, ccw: boolean): PdfPoint[] => {
    const sweep = arcSweep(startAngle, endAngle, ccw);
    const steps = Math.min(96, Math.max(2, Math.ceil((sweep / (2 * Math.PI)) * 96)));
    const pts: PdfPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = ccw ? startAngle + sweep * (i / steps) : startAngle - sweep * (i / steps);
      pts.push(at(arcPointAt(center, radius, t)));
    }
    return pts;
  };

  const polylinePoints = (e: PolylineEntity): PdfPoint[] => {
    const pts: PdfPoint[] = [];
    polylineSegments(e).forEach((seg, i) => {
      if (i === 0) pts.push(at(seg.a));
      const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
      if (!arc) {
        pts.push(at(seg.b));
        return;
      }
      pts.push(...arcPoints(arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw).slice(1));
    });
    return pts;
  };

  for (const e of drawable) {
    const paint = paintOf(e);
    if (e.type === "line") {
      pdf.line(at(e.a), at(e.b), paint);
    } else if (e.type === "circle") {
      const c = at(e.center);
      pdf.circle(c.x, c.y, e.radius * scale, paint);
    } else if (e.type === "point") {
      const p = at(e.p);
      pdf.circle(p.x, p.y, width * 1.5, { fill: paint.stroke });
    } else if (e.type === "arc") {
      pdf.polyline(arcPoints(e.center, e.radius, (e as ArcEntity).startAngle, e.endAngle, e.ccw), paint);
    } else if (e.type === "text") {
      const p = at(e.at);
      // Entity text sits on its baseline at `at`, rotation-free on a plan
      // sheet; the height is the font size, exactly as on the canvas.
      pdf.text(p.x, p.y, e.text, { size: e.height * scale, color: e.color ?? stroke });
    } else if (e.type === "polyline") {
      pdf.polyline(polylinePoints(e), paint, e.closed);
    }
  }

  return { scale };
}
