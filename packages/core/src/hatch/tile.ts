import type { PatternFamily } from "../entities";
import type { Point } from "../geometry";

/**
 * "Draw a tile" pattern designer (H-06): lines drawn inside a W x H tile that
 * repeats along both axes become `.pat` line families. For each line the tile
 * lattice (i*W, j*H) is projected on the line's normal: the smallest positive
 * step is the family's perpendicular spacing and the along-line component of
 * the lattice vector that gives it is the stagger; the lattice vector parallel
 * to the line is the dash period. A direction that is not commensurate with the
 * tile (no lattice vector runs along it) cannot repeat, so it is reported.
 */

export interface TileSegment {
  a: Point;
  b: Point;
}

const SEARCH = 24;

export function tileToFamilies(width: number, height: number, segments: readonly TileSegment[]): { families: PatternFamily[]; issues: string[] } {
  const families: PatternFamily[] = [];
  const issues: string[] = [];
  if (!(width > 0) || !(height > 0)) return { families, issues: ["tile size must be positive"] };
  const scale = Math.max(width, height);
  const eps = 1e-9 * scale;
  segments.forEach((seg, k) => {
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > eps)) {
      issues.push(`line ${k + 1} has no length`);
      return;
    }
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    let s = Infinity;
    let t = 0;
    let period = Infinity;
    for (let i = -SEARCH; i <= SEARCH; i++) {
      for (let j = -SEARCH; j <= SEARCH; j++) {
        if (i === 0 && j === 0) continue;
        const vx = i * width;
        const vy = j * height;
        const perp = nx * vx + ny * vy;
        const along = ux * vx + uy * vy;
        if (Math.abs(perp) <= eps * 100) {
          if (along > eps && along < period) period = along;
        } else if (perp > 0 && (perp < s - eps || (Math.abs(perp - s) <= eps && Math.abs(along) < Math.abs(t)))) {
          s = perp;
          t = along;
        }
      }
    }
    if (!Number.isFinite(period) || !Number.isFinite(s)) {
      issues.push(`line ${k + 1} does not repeat with the tile (its direction is not a lattice direction)`);
      return;
    }
    if (len > period + eps * 100) {
      issues.push(`line ${k + 1} is longer than its repeat (${+period.toFixed(6)}) — it is shortened`);
    }
    const drawn = Math.min(len, period);
    const tt = ((t % period) + period) % period;
    families.push({
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
      origin: { x: seg.a.x, y: seg.a.y },
      offset: { x: tt, y: s },
      dashes: drawn >= period - eps * 100 ? [] : [drawn, -(period - drawn)],
    });
  });
  return { families, issues };
}
