import { create } from "zustand";
import type { Point } from "@sketchor/core";
import type { Snap } from "../viewport/snapping";

/**
 * Ortho and polar tracking (roadmap T-09): AutoCAD's F8 / F10.
 *
 * Ortho constrains the next point to 0/90/180/270° from the tool's anchor
 * (its last pick); polar snaps to a configurable angle increment. Both are
 * a stage *after* object snapping: a feature snap the cursor actually
 * touched (endpoint, intersection, center…) still wins, as in AutoCAD —
 * tracking only replaces the fall-through grid/on-line/nothing result.
 * Shift held is temporary ortho, the habit both AutoCAD and Onshape share.
 *
 * Settings persist like the keybindings (manual load/save, localStorage).
 */

export interface TrackingSettings {
  ortho: boolean;
  polar: boolean;
  /** Degrees. */
  polarIncrement: number;
  /**
   * Object snap tracking (T-20, `objectTracking.ts`): align with feature
   * points the cursor has hovered. On by default — it only acts when the
   * cursor genuinely lines up with something, the way Onshape's inference
   * lines do, and it is the one that makes "above that corner" placeable.
   */
  otrack: boolean;
}

const STORAGE_KEY = "sketchor.tracking.v1";
const DEFAULTS: TrackingSettings = { ortho: false, polar: false, polarIncrement: 45, otrack: true };
export const POLAR_INCREMENTS = [5, 10, 15, 22.5, 30, 45, 90] as const;

function load(): TrackingSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<TrackingSettings>;
    return {
      ortho: typeof p.ortho === "boolean" ? p.ortho : DEFAULTS.ortho,
      polar: typeof p.polar === "boolean" ? p.polar : DEFAULTS.polar,
      polarIncrement:
        typeof p.polarIncrement === "number" && p.polarIncrement > 0 && p.polarIncrement <= 90
          ? p.polarIncrement
          : DEFAULTS.polarIncrement,
      otrack: typeof p.otrack === "boolean" ? p.otrack : DEFAULTS.otrack,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(s: TrackingSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

interface TrackingState extends TrackingSettings {
  toggleOrtho: () => void;
  togglePolar: () => void;
  toggleOtrack: () => void;
  setPolarIncrement: (deg: number) => void;
}

export const useTracking = create<TrackingState>((set, get) => ({
  ...load(),
  toggleOrtho: () => {
    // Ortho and polar are exclusive, as in AutoCAD: turning one on turns the other off.
    const next = { ...settingsOf(get()), ortho: !get().ortho, polar: false };
    save(next);
    set(next);
  },
  togglePolar: () => {
    const next = { ...settingsOf(get()), polar: !get().polar, ortho: false };
    save(next);
    set(next);
  },
  toggleOtrack: () => {
    const next = { ...settingsOf(get()), otrack: !get().otrack };
    save(next);
    set(next);
  },
  setPolarIncrement: (deg) => {
    const next = { ...settingsOf(get()), polarIncrement: deg };
    save(next);
    set(next);
  },
}));

function settingsOf(s: TrackingSettings): TrackingSettings {
  return { ortho: s.ortho, polar: s.polar, polarIncrement: s.polarIncrement, otrack: s.otrack };
}

/** Snap kinds that were found by touching a feature; tracking never overrides these. */
const FEATURE_SNAPS = new Set<Snap["kind"]>([
  "origin",
  "endpoint",
  "midpoint",
  "center",
  "quadrant",
  "intersection",
  "node",
  "perpendicular",
  "tangent",
]);

export interface TrackingResult {
  point: Point;
  /** The ray the point was projected onto, for the dashed guide; null when tracking didn't apply. */
  ray: { from: Point; angleDeg: number } | null;
}

/**
 * Projects the cursor onto the nearest allowed ray from `anchor`, when
 * tracking is on and the object snap didn't land on a feature. `increment`
 * is the polar step in degrees (ortho = 90). Pure, for tests; the viewport
 * decides the increment from the settings and the Shift key.
 */
export function applyTracking(anchor: Point | null, cursor: Point, snap: Snap | null, increment: number | null): TrackingResult {
  if (!anchor || increment === null || increment <= 0) return { point: snap?.point ?? cursor, ray: null };
  if (snap && FEATURE_SNAPS.has(snap.kind)) return { point: snap.point, ray: null };
  const dx = cursor.x - anchor.x;
  const dy = cursor.y - anchor.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return { point: cursor, ray: null };
  const step = (increment * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  // Project onto the ray (keep the along-ray component of the cursor offset).
  const along = dx * ux + dy * uy;
  const point = { x: anchor.x + ux * along, y: anchor.y + uy * along };
  let angleDeg = (angle * 180) / Math.PI;
  angleDeg = ((angleDeg % 360) + 360) % 360;
  return { point, ray: { from: anchor, angleDeg } };
}

/** The increment tracking should use right now, or null for off. */
export function trackingIncrement(settings: TrackingSettings, shiftHeld: boolean): number | null {
  if (shiftHeld || settings.ortho) return 90;
  if (settings.polar) return settings.polarIncrement;
  return null;
}
