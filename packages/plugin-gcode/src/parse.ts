import { add, polyline, type Command, type Point } from "@sketchor/plugin-sdk";

/**
 * A dependency-free G-code decoder — the "GcodeRipper" direction: read a program
 * and turn its motion into drawing geometry. Handles the milling subset that
 * covers most 2D toolpaths:
 *
 *   - G0 rapid / G1 linear moves          → polyline segments
 *   - G2 CW / G3 CCW arcs (I/J centre, or R)  → bulged polyline segments, or a
 *                                              full circle when start == end
 *   - G17 XY plane only (G18/G19 warn and skip)
 *   - G20 inch / G21 mm                    → coordinates scaled to millimetres
 *   - G90 absolute / G91 incremental
 *
 * Everything else (feed words, spindle/coolant M-codes, canned cycles, tool
 * comp) is ignored; unknown motion just carries the modal state forward.
 *
 * Document coordinates are always millimetres, so every program is converted on
 * the way in. A program that never declares G20/G21 is a real hazard — an inch
 * program read as mm comes out 25.4x too small — so the unit is caller-
 * controllable ({@link GcodeOptions.unit} / {@link GcodeOptions.assume}) and the
 * result always reports which unit was used and where that reading came from.
 */

/** The unit a program's coordinates are in. */
export type GcodeUnit = "mm" | "in";

/** How to decide that unit: follow the program's own G20/G21, or override it. */
export type GcodeUnitMode = "auto" | GcodeUnit;

export interface GcodeOptions {
  /** Also draw G0 rapids, on a separate "<layer> rapids" layer. Default false. */
  includeRapids?: boolean;
  /** Layer for cutting moves. Default "G-code". */
  layer?: string;
  /**
   * How to read coordinates. "auto" (default) follows G20/G21; "mm"/"in" force
   * the unit and ignore what the program declares.
   */
  unit?: GcodeUnitMode;
  /** Unit to assume under "auto" when the program never declares one. Default "mm". */
  assume?: GcodeUnit;
}

export interface GcodeStats {
  paths: number;
  segments: number;
  rapids: number;
  /** The unit the program's numbers were read as. */
  unit: GcodeUnit;
  /** Where that unit came from — "assumed" means the program never said. */
  unitSource: "declared" | "forced" | "assumed";
  /** Millimetres per program unit actually applied (1 or 25.4). */
  scale: number;
}

export interface GcodeResult {
  commands: Command[];
  stats: GcodeStats;
  warnings: string[];
}

const IN_TO_MM = 25.4;
const EPS = 1e-6;

interface Modal {
  motion: 0 | 1 | 2 | 3;
  abs: boolean;
  inch: boolean;
  x: number;
  y: number;
  z: number;
}

/** Strips `(...)` block comments and `;` line comments, returns the words. */
function words(line: string): { letter: string; value: number }[] {
  const clean = line.replace(/\([^)]*\)/g, " ").replace(/;.*/, "");
  const out: { letter: string; value: number }[] = [];
  const re = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) out.push({ letter: m[1].toUpperCase(), value: Number(m[2]) });
  return out;
}

/** Signed sweep start→end about `center`, in the direction of travel (+ CCW, − CW), magnitude in (0, 2π]. */
function signedSweep(start: Point, end: Point, center: Point, ccw: boolean): number {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  let s = a1 - a0;
  if (ccw) {
    while (s <= EPS) s += 2 * Math.PI;
  } else {
    while (s >= -EPS) s -= 2 * Math.PI;
  }
  return s;
}

/** Centre for an `R`-word arc: |R| picks the radius, sign(R) < 0 selects the >180° arc. */
function centerFromR(start: Point, end: Point, r: number, ccw: boolean): Point | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const q = Math.hypot(dx, dy);
  if (q < EPS) return null;
  const half = q / 2;
  const rad = Math.abs(r);
  if (rad < half - 1e-4) return null;
  const h = Math.sqrt(Math.max(0, rad * rad - half * half));
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const ux = -dy / q;
  const uy = dx / q;
  const wantMajor = r < 0;
  for (const c of [
    { x: mx + ux * h, y: my + uy * h },
    { x: mx - ux * h, y: my - uy * h },
  ]) {
    const major = Math.abs(signedSweep(start, end, c, ccw)) > Math.PI + 1e-4;
    if (major === wantMajor) return c;
  }
  return { x: mx + ux * h, y: my + uy * h };
}

export function gcodeToEntities(text: string, opts: GcodeOptions = {}): GcodeResult {
  const layer = opts.layer?.trim() || "G-code";
  const rapidLayer = `${layer} rapids`;
  const warnings: string[] = [];

  // "auto" follows the program's own G20/G21; a forced unit ignores them. Under
  // "auto" the file may say nothing at all, in which case `assume` decides —
  // that is the case worth telling the user about, so it's tracked separately.
  const forced: GcodeUnit | null = opts.unit === "mm" || opts.unit === "in" ? opts.unit : null;
  const assumed: GcodeUnit = opts.assume === "in" ? "in" : "mm";
  const startUnit = forced ?? assumed;
  /** The first unit the program declares for itself, if it ever does. */
  let declared: GcodeUnit | null = null;

  const st: Modal = { motion: 0, abs: true, inch: startUnit === "in", x: 0, y: 0, z: 0 };

  // Open cut path: points in mm + per-segment bulges (0 = straight).
  let path: Point[] = [];
  let bulges: number[] = [];
  const commands: Command[] = [];
  const stats: GcodeStats = { paths: 0, segments: 0, rapids: 0, unit: startUnit, unitSource: forced ? "forced" : "assumed", scale: startUnit === "in" ? IN_TO_MM : 1 };
  let warnedPlane = false;

  const scale = () => (st.inch ? IN_TO_MM : 1);
  const pt = (): Point => ({ x: st.x * scale(), y: st.y * scale() });

  const flush = () => {
    if (path.length >= 2) {
      commands.push(add(polyline(path, false, { layer, ...(bulges.some((b) => b !== 0) ? { bulges } : {}) })));
      stats.paths += 1;
    }
    path = [];
    bulges = [];
  };

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const ws = words(raw);
    if (ws.length === 0) continue;

    let target: { x?: number; y?: number; z?: number } = {};
    let i: number | undefined;
    let j: number | undefined;
    let r: number | undefined;

    for (const { letter, value } of ws) {
      switch (letter) {
        case "G":
          if (value === 0 || value === 1 || value === 2 || value === 3) st.motion = value;
          else if (value === 20 || value === 21) {
            const u: GcodeUnit = value === 20 ? "in" : "mm";
            declared ??= u;
            // A forced unit wins, but only silently the first time: if the
            // program disagrees, say so rather than quietly resizing the part.
            if (!forced) st.inch = u === "in";
            else if (u !== forced && warnings.length === 0) {
              warnings.push(
                `The program declares G${value} (${u === "in" ? "inches" : "millimetres"}), but it was read as ${forced === "in" ? "inches" : "millimetres"} because you set the unit by hand.`,
              );
            }
          }
          else if (value === 90) st.abs = true;
          else if (value === 91) st.abs = false;
          else if ((value === 18 || value === 19) && !warnedPlane) {
            warnings.push(`Plane G${value} isn't supported — only the XY plane (G17); those moves are skipped.`);
            warnedPlane = true;
          }
          break;
        case "X":
          target.x = value;
          break;
        case "Y":
          target.y = value;
          break;
        case "Z":
          target.z = value;
          break;
        case "I":
          i = value;
          break;
        case "J":
          j = value;
          break;
        case "R":
          r = value;
          break;
        default:
          break;
      }
    }

    if (target.x === undefined && target.y === undefined && target.z === undefined && i === undefined && j === undefined) {
      continue; // a bare G/M/F line — modal state already updated
    }

    const start = pt();
    // Resolve the destination in the machine's own units, then convert.
    const nx = target.x === undefined ? st.x : st.abs ? target.x : st.x + target.x;
    const ny = target.y === undefined ? st.y : st.abs ? target.y : st.y + target.y;
    const nz = target.z === undefined ? st.z : st.abs ? target.z : st.z + target.z;
    st.x = nx;
    st.y = ny;
    st.z = nz;
    const end = pt();

    if (st.motion === 0) {
      flush();
      stats.rapids += 1;
      if (opts.includeRapids) commands.push(add(polyline([start, end], false, { layer: rapidLayer })));
      continue;
    }

    if (st.motion === 1) {
      if (path.length === 0) path.push(start);
      path.push(end);
      bulges.push(0);
      stats.segments += 1;
      continue;
    }

    // G2 / G3 arc in the XY plane.
    const ccw = st.motion === 3;
    let center: Point | null = null;
    if (i !== undefined || j !== undefined) {
      center = { x: start.x + (i ?? 0) * scale(), y: start.y + (j ?? 0) * scale() };
    } else if (r !== undefined) {
      center = centerFromR(start, end, r * scale(), ccw);
    }
    if (!center) {
      warnings.push("An arc was missing a usable centre (I/J or R) and was skipped.");
      continue;
    }

    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-4) {
      // Closed arc = full circle (two half-turn bulges, signed by direction).
      flush();
      const radius = Math.hypot(start.x - center.x, start.y - center.y);
      const b = ccw ? 1 : -1;
      commands.push(
        add(
          polyline(
            [
              { x: center.x - radius, y: center.y },
              { x: center.x + radius, y: center.y },
            ],
            true,
            { layer, bulges: [b, b] },
          ),
        ),
      );
      stats.paths += 1;
      stats.segments += 1;
      continue;
    }

    if (path.length === 0) path.push(start);
    path.push(end);
    bulges.push(Math.tan(signedSweep(start, end, center, ccw) / 4));
    stats.segments += 1;
  }

  flush();

  // Report the unit the geometry was actually built with — not `st.inch`, which
  // is only wherever the program's modal state happened to end up.
  const used: GcodeUnit = forced ?? declared ?? assumed;
  stats.unit = used;
  stats.unitSource = forced ? "forced" : declared ? "declared" : "assumed";
  stats.scale = used === "in" ? IN_TO_MM : 1;
  if (stats.unitSource === "assumed" && (stats.segments > 0 || stats.paths > 0)) {
    warnings.push(
      `This program never says G20 or G21, so it was read as ${used === "in" ? "inches" : "millimetres"}. If the geometry came in ${used === "in" ? "25.4x too big" : "25.4x too small"}, set the unit by hand and import again.`,
    );
  }
  return { commands, stats, warnings };
}
