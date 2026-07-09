import type { Point } from "@sketchor/core";

/**
 * Screen mapping: sx = wx * scale + ox ; sy = -wy * scale + oy
 * (world Y grows upward, CAD convention)
 */
export interface View {
  scale: number;
  ox: number;
  oy: number;
}

export function worldToScreen(view: View, p: Point): Point {
  return { x: p.x * view.scale + view.ox, y: -p.y * view.scale + view.oy };
}

export function screenToWorld(view: View, p: Point): Point {
  return { x: (p.x - view.ox) / view.scale, y: (view.oy - p.y) / view.scale };
}

export function zoomAt(view: View, screen: Point, factor: number): View {
  const scale = Math.min(1000, Math.max(0.001, view.scale * factor));
  const f = scale / view.scale;
  return {
    scale,
    ox: screen.x - (screen.x - view.ox) * f,
    oy: screen.y - (screen.y - view.oy) * f,
  };
}

/** Smallest 1/2/5*10^n grid step that is at least minPx on screen. */
export function gridStep(scale: number, minPx = 24): number {
  const raw = minPx / scale;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (mag * m >= raw) return mag * m;
  }
  return mag * 10;
}
