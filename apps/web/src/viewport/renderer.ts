import type { Entity, EntityId, Point, SketchDocument } from "@sketchor/core";
import { dist, translated } from "@sketchor/core";
import { gridStep, worldToScreen, type View } from "./view";
import type { Snap } from "./snapping";

export interface RenderUiState {
  selection: ReadonlySet<EntityId>;
  /** Entity being drawn right now (not yet in the document). */
  preview: Entity | null;
  snap: Snap | null;
  /** Live offset while dragging a selection. */
  moveOffset: { dx: number; dy: number } | null;
  /** Active distance measurement overlay, if any. */
  measurement: { a: Point; b: Point } | null;
}

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

  for (const entity of doc.all()) {
    const selected = ui.selection.has(entity.id);
    const shown =
      selected && ui.moveOffset
        ? translated(entity, ui.moveOffset.dx, ui.moveOffset.dy)
        : entity;
    drawEntity(ctx, view, shown, selected ? COLORS.selected : COLORS.entity, selected ? 2 : 1.5);
    if (selected) drawHandles(ctx, view, shown);
  }

  if (ui.preview) {
    ctx.setLineDash([6, 4]);
    drawEntity(ctx, view, ui.preview, COLORS.preview, 1.25);
    ctx.setLineDash([]);
  }

  if (ui.measurement) drawMeasurement(ctx, view, ui.measurement);

  if (ui.snap) drawSnapMarker(ctx, view, ui.snap);
}

function drawMeasurement(
  ctx: CanvasRenderingContext2D,
  view: View,
  m: { a: Point; b: Point },
): void {
  const a = worldToScreen(view, m.a);
  const b = worldToScreen(view, m.b);

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

  const d = dist(m.a, m.b);
  if (d < 1e-9) return;

  // World Y grows upward, so negate dy for a screen-consistent angle.
  const angle = (Math.atan2(m.b.y - m.a.y, m.b.x - m.a.x) * 180) / Math.PI;
  const label = `${fmtNum(d)}  ${fmtNum(angle)}°`;

  ctx.font = "12px 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const padX = 7;
  const w = ctx.measureText(label).width + padX * 2;
  const h = 20;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2 - 14;

  ctx.fillStyle = COLORS.measureLabelBg;
  ctx.strokeStyle = COLORS.measure;
  ctx.lineWidth = 1;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 5);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = COLORS.measure;
  ctx.fillText(label, cx, cy);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
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
  } else {
    const c = worldToScreen(view, entity.center);
    ctx.arc(c.x, c.y, entity.radius * view.scale, 0, Math.PI * 2);
  }
  ctx.stroke();
}

function drawHandles(ctx: CanvasRenderingContext2D, view: View, entity: Entity): void {
  const points: Point[] =
    entity.type === "line" ? [entity.a, entity.b] : [entity.center];
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
