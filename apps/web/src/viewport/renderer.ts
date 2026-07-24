import type { Bounds, BoxSelectMode, ClosedRegion, Entity, EntityId, Point, SketchDocument } from "@sketchor/core";
import { dist, entityPoints, layerOf, transformed, translated } from "@sketchor/core";
import type { MeasureResult } from "../state/store";
import { gridStep, worldToScreen, type View } from "./view";
import type { Snap } from "./snapping";

/** A pending rigid transform (rotate about a pivot) previewed dashed over the real geometry. */
export interface TransformPreview {
  ids: ReadonlySet<EntityId>;
  pivot: Point;
  rotation: number;
}

export interface RenderUiState {
  selection: ReadonlySet<EntityId>;
  /** Entity being drawn right now (not yet in the document). */
  preview: Entity | null;
  snap: Snap | null;
  /** Live offset while dragging a selection. */
  moveOffset: { dx: number; dy: number } | null;
  /** Active measure-tool result overlay, if any. */
  measurement: MeasureResult | null;
  /** Names of layers to skip drawing. */
  hiddenLayers: ReadonlySet<string>;
  /** The straighten tool's chosen reference edge, highlighted distinctly. */
  referenceEdgeId: EntityId | null;
  /** The straighten tool's live preview of the rotated selection. */
  transformPreview: TransformPreview | null;
  /** World locations of current heal-diagnostics findings. */
  healMarkers: readonly Point[];
  /** World locations of current duplicate/overlap findings. */
  duplicateMarkers: readonly Point[];
  /** Dashed bbox + rotate handle shown when the selection is exactly one whole group. */
  groupHandle: { bounds: Bounds; pivot: Point } | null;
  /**
   * R2's interim connectivity hint (opt-in, off by default): entities with a
   * free endpoint render blue. NOT real constraint/DOF status — see
   * connectivity.ts. Null when the hint is turned off.
   */
  freeEndpointIds: ReadonlySet<EntityId> | null;
  /** Live window/crossing drag-select rectangle, while dragging. */
  boxSelect: { start: Point; end: Point; mode: BoxSelectMode } | null;
  /** Boundary polygons of detected closed loops (lines/arcs chained shut, or circles) — filled with a translucent tint. */
  closedRegions: readonly (readonly Point[])[];
  /** Formats a world-unit length/area for on-canvas labels, honoring the current display unit. */
  fmtLength: (worldValue: number) => string;
  fmtArea: (worldValueSquared: number) => string;
}

/** Must match GROUP_HANDLE_OFFSET_PX in Viewport.tsx, which hit-tests this same handle. */
const GROUP_HANDLE_OFFSET_PX = 26;

const COLORS = {
  bg: "#17181c",
  gridMinor: "#212329",
  gridMajor: "#2b2e36",
  axis: "#3d4250",
  entity: "#e8e9ec",
  selected: "#5b96ff",
  preview: "#5b96ff",
  snap: "#ffb02e",
  handle: "#5b96ff",
  measure: "#5ad1c5",
  measureLabelBg: "#0c2b28",
  reference: "#ff5c5c",
  connectivityHint: "#4d7ac7",
  windowSelect: "#5b96ff",
  crossingSelect: "#5adc7a",
  closedRegionFill: "rgba(180, 190, 205, 0.16)",
  duplicateMarker: "#f0b968",
};

function fmtNum(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

export function render(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: View,
  doc: SketchDocument,
  ui: RenderUiState,
): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, width, height, view);

  if (ui.closedRegions.length > 0) drawClosedRegions(ctx, view, ui.closedRegions);

  for (const entity of doc.all()) {
    if (ui.hiddenLayers.has(layerOf(entity))) continue;
    const selected = ui.selection.has(entity.id);
    const isReference = entity.id === ui.referenceEdgeId;
    const isFreeEndpoint = !!ui.freeEndpointIds?.has(entity.id);
    const shown =
      selected && ui.moveOffset
        ? translated(entity, ui.moveOffset.dx, ui.moveOffset.dy)
        : entity;
    const color = isReference
      ? COLORS.reference
      : selected
        ? COLORS.selected
        : isFreeEndpoint
          ? COLORS.connectivityHint
          : COLORS.entity;
    drawEntity(ctx, view, shown, color, selected || isReference ? 2 : 1.5);
    if (selected) drawHandles(ctx, view, shown);
  }

  if (ui.groupHandle) drawGroupHandle(ctx, view, ui.groupHandle);

  if (ui.transformPreview) {
    const { ids, pivot, rotation } = ui.transformPreview;
    ctx.setLineDash([6, 4]);
    for (const id of ids) {
      const entity = doc.get(id);
      if (!entity) continue;
      drawEntity(ctx, view, transformed(entity, pivot, 0, 0, rotation, 1), COLORS.preview, 1.5);
    }
    ctx.setLineDash([]);
  }

  if (ui.preview) {
    ctx.setLineDash([6, 4]);
    drawEntity(ctx, view, ui.preview, COLORS.preview, 1.25);
    ctx.setLineDash([]);
  }

  if (ui.measurement) drawMeasurement(ctx, view, doc, ui.measurement, ui.fmtLength, ui.fmtArea);

  for (const p of ui.healMarkers) drawHealMarker(ctx, view, p);
  for (const p of ui.duplicateMarkers) drawHealMarker(ctx, view, p, COLORS.duplicateMarker);

  if (ui.snap) drawSnapMarker(ctx, view, ui.snap);

  if (ui.boxSelect) drawBoxSelect(ctx, view, ui.boxSelect);
}

/** Window selection (blue, solid, filled) vs crossing selection (green, dashed) — the standard CAD convention. */
function drawBoxSelect(
  ctx: CanvasRenderingContext2D,
  view: View,
  box: { start: Point; end: Point; mode: BoxSelectMode },
): void {
  const a = worldToScreen(view, box.start);
  const b = worldToScreen(view, box.end);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  const color = box.mode === "window" ? COLORS.windowSelect : COLORS.crossingSelect;

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.1;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(box.mode === "window" ? [] : [5, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.setLineDash([]);
}

function drawClosedRegions(ctx: CanvasRenderingContext2D, view: View, regions: readonly (readonly Point[])[]): void {
  ctx.fillStyle = COLORS.closedRegionFill;
  for (const polygon of regions) {
    if (polygon.length < 3) continue;
    ctx.beginPath();
    const p0 = worldToScreen(view, polygon[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < polygon.length; i++) {
      const p = worldToScreen(view, polygon[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
  }
}

function drawGroupHandle(
  ctx: CanvasRenderingContext2D,
  view: View,
  gh: { bounds: Bounds; pivot: Point },
): void {
  const bb = gh.bounds;
  const topLeft = worldToScreen(view, { x: bb.minX, y: bb.maxY });
  const bottomRight = worldToScreen(view, { x: bb.maxX, y: bb.minY });

  ctx.strokeStyle = COLORS.selected;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx.setLineDash([]);

  const topCenter = worldToScreen(view, { x: (bb.minX + bb.maxX) / 2, y: bb.maxY });
  const handle = { x: topCenter.x, y: topCenter.y - GROUP_HANDLE_OFFSET_PX };

  ctx.beginPath();
  ctx.moveTo(topCenter.x, topCenter.y);
  ctx.lineTo(handle.x, handle.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(handle.x, handle.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.selected;
  ctx.fill();
  ctx.strokeStyle = COLORS.bg;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawHealMarker(ctx: CanvasRenderingContext2D, view: View, p: Point, color: string = COLORS.reference): void {
  const s = worldToScreen(view, p);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
  ctx.moveTo(s.x - 4, s.y - 4);
  ctx.lineTo(s.x + 4, s.y + 4);
  ctx.moveTo(s.x + 4, s.y - 4);
  ctx.lineTo(s.x - 4, s.y + 4);
  ctx.stroke();
}

function drawMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  doc: SketchDocument,
  m: MeasureResult,
  fmtLength: (n: number) => string,
  fmtArea: (n: number) => string,
): void {
  switch (m.kind) {
    case "distance":
      drawDistanceMeasurement(ctx, view, m.a, m.b, fmtLength);
      break;
    case "length":
      drawLengthMeasurement(ctx, view, doc, m, fmtLength);
      break;
    case "radius":
      drawRadiusMeasurement(ctx, view, m, fmtLength);
      break;
    case "area":
      drawAreaMeasurement(ctx, view, m.region, fmtArea);
      break;
  }
}

/** A small rounded pill, one or more lines of text, centered at a screen point. */
function drawLabel(ctx: CanvasRenderingContext2D, cx: number, cy: number, lines: string[]): void {
  ctx.font = "12px 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const padX = 7;
  const lineH = 15;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const h = lineH * lines.length + 6;

  ctx.fillStyle = COLORS.measureLabelBg;
  ctx.strokeStyle = COLORS.measure;
  ctx.lineWidth = 1;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 5);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = COLORS.measure;
  const top = cy - h / 2 + lineH / 2 + 3;
  lines.forEach((line, i) => ctx.fillText(line, cx, top + i * lineH));
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function drawDistanceMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  wa: Point,
  wb: Point,
  fmtLength: (n: number) => string,
): void {
  const a = worldToScreen(view, wa);
  const b = worldToScreen(view, wb);

  ctx.strokeStyle = COLORS.measure;
  ctx.fillStyle = COLORS.measure;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const p of [a, b]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const d = dist(wa, wb);
  if (d < 1e-9) return;

  // World Y grows upward, so negate dy for a screen-consistent angle.
  const angle = (Math.atan2(wb.y - wa.y, wb.x - wa.x) * 180) / Math.PI;
  const dx = Math.abs(wb.x - wa.x);
  const dy = Math.abs(wb.y - wa.y);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2 - 18;
  drawLabel(ctx, cx, cy, [`${fmtLength(d)}  ${fmtNum(angle)}°`, `Δx ${fmtLength(dx)}  Δy ${fmtLength(dy)}`]);
}

function drawLengthMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  doc: SketchDocument,
  m: Extract<MeasureResult, { kind: "length" }>,
  fmtLength: (n: number) => string,
): void {
  let lastMid: Point | null = null;
  ctx.strokeStyle = COLORS.measure;
  ctx.lineWidth = 3;
  for (const id of m.ids) {
    const entity = doc.get(id);
    if (!entity || entity.type !== "line") continue;
    const a = worldToScreen(view, entity.a);
    const b = worldToScreen(view, entity.b);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  if (!lastMid) return;
  const label =
    m.ids.length > 1 ? `Total ${fmtLength(m.total)}  (${m.ids.length} lines)` : `Length ${fmtLength(m.total)}`;
  drawLabel(ctx, lastMid.x, lastMid.y - 14, [label]);
}

function drawRadiusMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  m: Extract<MeasureResult, { kind: "radius" }>,
  fmtLength: (n: number) => string,
): void {
  const c = worldToScreen(view, m.center);
  const edge = worldToScreen(view, { x: m.center.x + m.radius, y: m.center.y });

  ctx.strokeStyle = COLORS.measure;
  ctx.fillStyle = COLORS.measure;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(edge.x, edge.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
  ctx.fill();

  drawLabel(ctx, (c.x + edge.x) / 2, (c.y + edge.y) / 2 - 14, [`R ${fmtLength(m.radius)}   Ø ${fmtLength(m.radius * 2)}`]);
}

function drawAreaMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  region: ClosedRegion,
  fmtArea: (n: number) => string,
): void {
  if (region.points.length < 3) return;
  ctx.fillStyle = COLORS.measure;
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  const p0 = worldToScreen(view, region.points[0]);
  ctx.moveTo(p0.x, p0.y);
  let cx = p0.x;
  let cy = p0.y;
  for (let i = 1; i < region.points.length; i++) {
    const p = worldToScreen(view, region.points[i]);
    ctx.lineTo(p.x, p.y);
    cx += p.x;
    cy += p.y;
  }
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  cx /= region.points.length;
  cy /= region.points.length;
  drawLabel(ctx, cx, cy, [`Area ${fmtArea(region.area)}`]);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: View,
): void {
  const step = gridStep(view.scale);
  const left = -view.ox / view.scale;
  const right = (width - view.ox) / view.scale;
  const bottom = (view.oy - height) / view.scale;
  const top = view.oy / view.scale;

  const startX = Math.floor(left / step) * step;
  const startY = Math.floor(bottom / step) * step;

  ctx.lineWidth = 1;
  for (let wx = startX, i = Math.round(startX / step); wx <= right; wx += step, i++) {
    const sx = Math.round(wx * view.scale + view.ox) + 0.5;
    ctx.strokeStyle = wx === 0 ? COLORS.axis : i % 5 === 0 ? COLORS.gridMajor : COLORS.gridMinor;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
    ctx.stroke();
  }
  for (let wy = startY, i = Math.round(startY / step); wy <= top; wy += step, i++) {
    const sy = Math.round(-wy * view.scale + view.oy) + 0.5;
    ctx.strokeStyle = wy === 0 ? COLORS.axis : i % 5 === 0 ? COLORS.gridMajor : COLORS.gridMinor;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
    ctx.stroke();
  }
}

function drawEntity(
  ctx: CanvasRenderingContext2D,
  view: View,
  entity: Entity,
  color: string,
  lineWidth: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  if (entity.type === "line") {
    const a = worldToScreen(view, entity.a);
    const b = worldToScreen(view, entity.b);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  } else if (entity.type === "circle") {
    const c = worldToScreen(view, entity.center);
    ctx.arc(c.x, c.y, entity.radius * view.scale, 0, Math.PI * 2);
  } else if (entity.type === "point") {
    // Fixed screen size regardless of zoom, like a CAD PDMODE marker.
    const p = worldToScreen(view, entity.p);
    ctx.moveTo(p.x - 5, p.y);
    ctx.lineTo(p.x + 5, p.y);
    ctx.moveTo(p.x, p.y - 5);
    ctx.lineTo(p.x, p.y + 5);
  } else {
    // World angles increase CCW in a Y-up plane; screen Y is flipped, so
    // angles negate and the sweep direction flips (canvas's own
    // "counterclockwise" flag already matches our ccw once negated).
    const c = worldToScreen(view, entity.center);
    ctx.arc(c.x, c.y, entity.radius * view.scale, -entity.startAngle, -entity.endAngle, entity.ccw);
  }
  ctx.stroke();
}

function drawHandles(ctx: CanvasRenderingContext2D, view: View, entity: Entity): void {
  const points: Point[] = entity.type === "circle" ? [entity.center] : entityPoints(entity);
  ctx.fillStyle = COLORS.handle;
  for (const p of points) {
    const s = worldToScreen(view, p);
    ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
  }
}

function drawSnapMarker(ctx: CanvasRenderingContext2D, view: View, snap: Snap): void {
  const s = worldToScreen(view, snap.point);
  ctx.strokeStyle = COLORS.snap;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  switch (snap.kind) {
    case "endpoint":
    case "quadrant":
      ctx.rect(s.x - 5, s.y - 5, 10, 10);
      break;
    case "midpoint":
      ctx.moveTo(s.x, s.y - 6);
      ctx.lineTo(s.x + 6, s.y + 5);
      ctx.lineTo(s.x - 6, s.y + 5);
      ctx.closePath();
      break;
    case "center":
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      break;
    case "grid":
      ctx.moveTo(s.x - 4, s.y);
      ctx.lineTo(s.x + 4, s.y);
      ctx.moveTo(s.x, s.y - 4);
      ctx.lineTo(s.x, s.y + 4);
      break;
  }
  ctx.stroke();
}
