import type { HatchEntity, HatchPaint, PatternFamily } from "../entities";
import type { Point } from "../geometry";
import { hatchPolygons, paintedAtDepth } from "./loops";
import { lookupPattern } from "./registry";

/**
 * The hatch fill engine (H-02): the strokes a pattern hatch is made of.
 *
 * For each line family the infinite set of parallel lines is clipped to the
 * boundary loops (tessellated to {@link FILL_TOL}), the crossings are combined
 * under the island style, and the dash pattern is laid along each line with a
 * phase anchored to the family's origin — so a dash never restarts where an
 * island interrupts the line, and neighbouring hatches with the same origin
 * line up. Pure and exact in world units (the scale is the paint's, so an
 * annotative scale only changes `paint.scale`).
 */

/** Chord tolerance (world units) used to flatten curved boundary edges. */
export const FILL_TOL = 0.005;
/** More segments than this and the pattern is summarised by its tone instead (a LibreCAD pain point: the UI hangs). */
export const MAX_SEGMENTS = 200_000;

export interface HatchFill {
  /** x0, y0, x1, y1 per stroke, world units. */
  segments: Float32Array;
  /** x, y per dot (a zero-length dash). */
  dots: Float32Array;
  /** World length of ink per unit area, summed over families — the pattern's average tone. */
  inkPerArea: number;
  /** Smallest line-to-line spacing among the families (world units), for deciding when a pattern is sub-pixel. */
  minSpacing: number;
  /** True when the density guard stopped generation: `segments` is empty and only `inkPerArea` is meaningful. */
  truncated: boolean;
  /** The pattern name could not be resolved and the paint carries no definition. */
  unknownPattern: boolean;
}

const EMPTY: HatchFill = { segments: new Float32Array(0), dots: new Float32Array(0), inkPerArea: 0, minSpacing: Infinity, truncated: false, unknownPattern: false };

const RAD = Math.PI / 180;

/** The families a pattern paint draws: its own `def`, else the registered pattern; `double` adds the perpendicular set. */
export function paintFamilies(paint: HatchPaint): PatternFamily[] | null {
  if (paint.kind !== "pattern") return null;
  const base = paint.def ?? lookupPattern(paint.name)?.families;
  if (!base) return null;
  if (!paint.double) return base;
  return [...base, ...base.map((f) => ({ ...f, angle: f.angle + 90 }))];
}

interface Edge {
  /** Perpendicular coordinate range, and the along-line coordinate at the low-v end. */
  vlo: number;
  vhi: number;
  tlo: number;
  thi: number;
  loop: number;
}

function periodOf(dashes: number[]): number {
  let l = 0;
  for (const d of dashes) l += Math.abs(d);
  return l;
}

/** The ink fraction (pen down) of a dash pattern; 1 for a continuous line. */
function inkFraction(dashes: number[], s: number): number {
  const l = periodOf(dashes);
  if (l <= 0) return 1;
  let down = 0;
  for (const d of dashes) if (d > 0) down += d;
  return down / l || (dashes.some((d) => d === 0) ? 0.05 : 0);
}

interface Family {
  u: Point;
  n: Point;
  /** Perpendicular coordinate of line 0 and the along-coordinate anchor of line 0's dash phase. */
  v0: number;
  t0: number;
  /** Step between lines: perpendicular (always > 0 after normalisation) and along. */
  dv: number;
  dt: number;
  dashes: number[];
}

function familyFrame(f: PatternFamily, paint: Extract<HatchPaint, { kind: "pattern" }>): Family | null {
  const s = paint.scale;
  const a = (f.angle + paint.angle) * RAD;
  const u = { x: Math.cos(a), y: Math.sin(a) };
  const n = { x: -u.y, y: u.x };
  // The family's origin turns with the hatch angle and scales, then sits at the hatch origin.
  const ra = paint.angle * RAD;
  const ox = (f.origin.x * Math.cos(ra) - f.origin.y * Math.sin(ra)) * s + (paint.origin?.x ?? 0);
  const oy = (f.origin.x * Math.sin(ra) + f.origin.y * Math.cos(ra)) * s + (paint.origin?.y ?? 0);
  let dv = f.offset.y * s;
  let dt = f.offset.x * s;
  if (!(Math.abs(dv) > 1e-12) || !Number.isFinite(dv + dt)) return null;
  if (dv < 0) {
    // Stepping the other way: the same set of lines, with the along-shift reversed in sense.
    dv = -dv;
    dt = -dt;
  }
  return { u, n, v0: ox * n.x + oy * n.y, t0: ox * u.x + oy * u.y, dv, dt, dashes: f.dashes.map((d) => d * s) };
}

/** Generates the strokes of a pattern hatch. Solid and gradient paints have none (an empty result). */
export function hatchFill(h: HatchEntity, opts: { maxSegments?: number; tol?: number } = {}): HatchFill {
  const paint = h.paint;
  if (paint.kind !== "pattern") return EMPTY;
  const families = paintFamilies(paint);
  if (!families) return { ...EMPTY, unknownPattern: true };
  if (!(paint.scale > 0) || !Number.isFinite(paint.scale)) return EMPTY;
  const polys = hatchPolygons(h, opts.tol ?? FILL_TOL);
  if (polys.length === 0) return EMPTY;
  const max = opts.maxSegments ?? MAX_SEGMENTS;

  const segs: number[] = [];
  const dots: number[] = [];
  let inkPerArea = 0;
  let minSpacing = Infinity;
  let estimate = 0;
  const frames = families.map((f) => familyFrame(f, paint));

  // Density guard first: lines × strokes per line, over the bounding box, before any clipping work.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys) for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  for (const fr of frames) {
    if (!fr) continue;
    const per = periodOf(fr.dashes);
    const perLine = per > 0 ? Math.max(1, (diag / per) * Math.max(1, fr.dashes.length / 2)) : 1;
    estimate += (diag / fr.dv + 1) * perLine;
    inkPerArea += inkFraction(fr.dashes, 1) / fr.dv;
    minSpacing = Math.min(minSpacing, fr.dv);
  }
  if (estimate > max) return { ...EMPTY, inkPerArea, minSpacing, truncated: true };

  for (const fr of frames) {
    if (!fr) continue;
    const { u, n } = fr;
    // Edges in (v, t) coordinates, bucketed by their low v so each line only sees the edges that span it.
    const edges: Edge[] = [];
    let vmin = Infinity, vmax = -Infinity;
    polys.forEach((poly, li) => {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        const pv = p.x * n.x + p.y * n.y;
        const qv = q.x * n.x + q.y * n.y;
        const pt = p.x * u.x + p.y * u.y;
        const qt = q.x * u.x + q.y * u.y;
        vmin = Math.min(vmin, pv, qv);
        vmax = Math.max(vmax, pv, qv);
        if (pv === qv) continue; // parallel to the lines: never crossed (half-open rule)
        edges.push(pv < qv ? { vlo: pv, vhi: qv, tlo: pt, thi: qt, loop: li } : { vlo: qv, vhi: pv, tlo: qt, thi: pt, loop: li });
      }
    });
    edges.sort((a, b) => a.vlo - b.vlo);
    const iFirst = Math.ceil((vmin - fr.v0) / fr.dv - 1e-9);
    const iLast = Math.floor((vmax - fr.v0) / fr.dv + 1e-9);
    const per = periodOf(fr.dashes);
    let next = 0;
    let active: Edge[] = [];
    const inside = new Uint8Array(polys.length);
    for (let i = iFirst; i <= iLast; i++) {
      const v = fr.v0 + i * fr.dv;
      while (next < edges.length && edges[next].vlo <= v) active.push(edges[next++]);
      active = active.filter((e) => e.vhi > v);
      // Half-open crossing rule: an edge spans v when vlo <= v < vhi.
      const xs: { t: number; loop: number }[] = [];
      for (const e of active) xs.push({ t: e.tlo + ((v - e.vlo) / (e.vhi - e.vlo)) * (e.thi - e.tlo), loop: e.loop });
      if (xs.length < 2) continue;
      xs.sort((a, b) => a.t - b.t);
      inside.fill(0);
      let count = 0;
      let start = 0;
      let painted = false;
      const anchor = fr.t0 + i * fr.dt;
      const emit = (ta: number, tb: number): void => {
        if (tb - ta < 1e-9) return;
        if (per <= 0) {
          segs.push(ta * u.x + v * n.x, ta * u.y + v * n.y, tb * u.x + v * n.x, tb * u.y + v * n.y);
          return;
        }
        // Lay the dash cycle from the anchor; start at the cycle containing `ta`.
        let cycleStart = anchor + Math.floor((ta - anchor) / per) * per;
        for (let guard = 0; cycleStart < tb && guard < 5_000_000; guard++, cycleStart += per) {
          let pos = cycleStart;
          for (const d of fr.dashes) {
            const len = Math.abs(d);
            if (d === 0) {
              if (pos >= ta && pos <= tb) dots.push(pos * u.x + v * n.x, pos * u.y + v * n.y);
            } else if (d > 0) {
              const a = Math.max(pos, ta);
              const b = Math.min(pos + len, tb);
              if (b - a > 1e-9) segs.push(a * u.x + v * n.x, a * u.y + v * n.y, b * u.x + v * n.x, b * u.y + v * n.y);
            }
            pos += len;
            if (pos >= tb) break;
          }
        }
      };
      for (const x of xs) {
        const now = (inside[x.loop] ^= 1) === 1;
        count += now ? 1 : -1;
        const nowPainted = paintedAtDepth(h.style, count);
        if (nowPainted && !painted) start = x.t;
        else if (!nowPainted && painted) emit(start, x.t);
        painted = nowPainted;
      }
      if (segs.length / 4 > max * 2) return { ...EMPTY, inkPerArea, minSpacing, truncated: true };
    }
  }
  return { segments: Float32Array.from(segs), dots: Float32Array.from(dots), inkPerArea, minSpacing, truncated: false, unknownPattern: false };
}

const cache = new WeakMap<HatchEntity, HatchFill>();

/** {@link hatchFill} memoised per entity object — entities are replaced, never mutated, so identity is the revision. */
export function hatchFillCached(h: HatchEntity): HatchFill {
  let hit = cache.get(h);
  if (!hit) {
    hit = hatchFill(h);
    cache.set(h, hit);
  }
  return hit;
}

/** Number of strokes in a result. */
export const segmentCount = (f: HatchFill): number => f.segments.length / 4;
