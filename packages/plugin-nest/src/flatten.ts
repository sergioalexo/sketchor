import { arcPointAt, arcSweep, bulgeToArc, dist, polylineSegments, type PolylineEntity } from "@sketchor/core";
import type { Point } from "./types";

/**
 * Chord-tolerance arc flattening (N-02): tessellates a curve so no sampled
 * chord deviates from the true arc by more than `chordTol`, rather than the
 * fixed 64-step tessellation `@sketchor/core`'s `regions.ts` uses for loop
 * *detection*. Nesting needs this because a sheet-edge-scale radius and a
 * tiny fillet get equally coarse treatment from a fixed step count — chord
 * tolerance scales the step count to the radius instead.
 */

/** Default chord tolerance (mm) per the sheet-metal-nesting plan. */
export const DEFAULT_CHORD_TOLERANCE = 0.05;

/**
 * Points along an arc from `startAngle`, sweeping `sweep` radians (always
 * positive — the magnitude, as returned by {@link arcSweep}) in the
 * direction `ccw` says, each consecutive chord within `chordTol` of the true
 * arc. Inclusive of both endpoints.
 */
export function flattenArc(
  center: Point,
  radius: number,
  startAngle: number,
  sweep: number,
  ccw: boolean,
  chordTol: number,
): Point[] {
  if (!(radius > 0) || !(sweep > 0)) {
    return [arcPointAt(center, Math.max(radius, 0), startAngle)];
  }
  // Per-segment angle keeping the sagitta r(1-cos(theta/2)) within chordTol;
  // a tolerance at or past the radius covers the whole sweep in one step.
  const theta = chordTol >= radius ? sweep : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - chordTol / radius)));
  const steps = Math.max(1, Math.ceil(sweep / Math.max(theta, 1e-9)));
  const dir = ccw ? 1 : -1;
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    points.push(arcPointAt(center, radius, startAngle + dir * sweep * (i / steps)));
  }
  return points;
}

/** A full circle's outline, chord-tolerance flattened, without a repeated closing point. */
export function flattenCircle(center: Point, radius: number, chordTol: number): Point[] {
  const points = flattenArc(center, radius, 0, Math.PI * 2, true, chordTol);
  if (points.length > 1) points.pop();
  return points;
}

/**
 * A closed polyline's outline, chord-tolerance flattened, without a repeated
 * closing point. `entity.closed` is assumed true — an open polyline has no
 * well-defined "outline".
 */
export function flattenClosedPolyline(entity: PolylineEntity, chordTol: number): Point[] {
  const segments = polylineSegments(entity);
  const points: Point[] = [];
  segments.forEach((seg, i) => {
    const arc = bulgeToArc(seg.a, seg.b, seg.bulge);
    const path = arc
      ? flattenArc(arc.center, arc.radius, arc.startAngle, arcSweep(arc.startAngle, arc.endAngle, arc.ccw), arc.ccw, chordTol)
      : [seg.a, seg.b];
    points.push(...(i === 0 ? path : path.slice(1)));
  });
  if (points.length > 1 && dist(points[0], points[points.length - 1]) < 1e-9) points.pop();
  return points;
}
