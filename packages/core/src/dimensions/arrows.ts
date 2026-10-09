import type { Point } from "../geometry";
import type { ArrowKind } from "./style";

/**
 * Arrow heads as geometry. `tip` is the point the arrow touches (an extension
 * line, a circle), `dir` the unit vector from the tip along the arrow's body.
 * Filled shapes go to `fills`, outlines and strokes to `lines`.
 */
export interface ArrowShape {
  lines: Point[][];
  fills: Point[][];
}

export function arrowShape(kind: ArrowKind, tip: Point, dir: Point, size: number, angleDeg: number): ArrowShape {
  if (kind === "none" || size <= 0) return { lines: [], fills: [] };
  const n = { x: -dir.y, y: dir.x };
  const at = (along: number, side: number): Point => ({ x: tip.x + dir.x * along + n.x * side, y: tip.y + dir.y * along + n.y * side });
  const half = Math.tan((Math.max(1, Math.min(120, angleDeg)) * Math.PI) / 360) * size;
  switch (kind) {
    case "closed":
      return { lines: [], fills: [[tip, at(size, half), at(size, -half), tip]] };
    case "closedBlank":
      return { lines: [[tip, at(size, half), at(size, -half), tip]], fills: [] };
    case "open":
      return { lines: [[at(size, half), tip, at(size, -half)]], fills: [] };
    case "tick": {
      // Architectural tick: a stroke through the tip, 45 degrees to the line.
      const s = Math.SQRT1_2 * size * 0.5;
      const a = { x: tip.x + (dir.x + n.x) * s, y: tip.y + (dir.y + n.y) * s };
      const b = { x: tip.x - (dir.x + n.x) * s, y: tip.y - (dir.y + n.y) * s };
      return { lines: [[a, b]], fills: [] };
    }
    case "dot":
    case "dotSmall": {
      const r = kind === "dot" ? size / 2 : size / 4;
      const ring: Point[] = [];
      for (let i = 0; i <= 16; i++) {
        const t = (i / 16) * Math.PI * 2;
        ring.push({ x: tip.x + Math.cos(t) * r, y: tip.y + Math.sin(t) * r });
      }
      return { lines: [], fills: [ring] };
    }
  }
}
