import type { Point, SketchDocument } from "@sketchor/core";
import { dist, mid } from "@sketchor/core";
import { gridStep, type View } from "./view";

export type SnapKind = "endpoint" | "midpoint" | "center" | "quadrant" | "grid";

export interface Snap {
  point: Point;
  kind: SnapKind;
}

const SNAP_PX = 10;

/** Finds the best snap near a world-space cursor position. */
export function findSnap(doc: SketchDocument, view: View, cursor: Point): Snap {
  const tol = SNAP_PX / view.scale;
  let best: Snap | null = null;
  let bestDist = tol;

  const consider = (point: Point, kind: SnapKind) => {
    const d = dist(point, cursor);
    if (d <= bestDist) {
      best = { point, kind };
      bestDist = d;
    }
  };

  for (const e of doc.all()) {
    if (e.type === "line") {
      consider(e.a, "endpoint");
      consider(e.b, "endpoint");
      consider(mid(e.a, e.b), "midpoint");
    } else {
      consider(e.center, "center");
      const { center: c, radius: r } = e;
      consider({ x: c.x + r, y: c.y }, "quadrant");
      consider({ x: c.x - r, y: c.y }, "quadrant");
      consider({ x: c.x, y: c.y + r }, "quadrant");
      consider({ x: c.x, y: c.y - r }, "quadrant");
    }
  }
  if (best) return best;

  const step = gridStep(view.scale);
  return {
    point: {
      x: Math.round(cursor.x / step) * step,
      y: Math.round(cursor.y / step) * step,
    },
    kind: "grid",
  };
}
