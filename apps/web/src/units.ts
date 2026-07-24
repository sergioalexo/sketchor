/**
 * Display-only unit conversion. Stored coordinates are always plain numbers
 * (treated as millimeters, the typical DXF/CAD default) — switching the
 * display unit never touches the document, only how numbers are formatted
 * for the user (footer, measure readouts, canvas-drawn measurement labels).
 */
export type DisplayUnit = "mm" | "cm" | "m" | "in" | "ft";

export const DISPLAY_UNITS: { id: DisplayUnit; label: string }[] = [
  { id: "mm", label: "mm" },
  { id: "cm", label: "cm" },
  { id: "m", label: "m" },
  { id: "in", label: "in" },
  { id: "ft", label: "ft" },
];

const FACTOR_FROM_MM: Record<DisplayUnit, number> = {
  mm: 1,
  cm: 0.1,
  m: 0.001,
  in: 1 / 25.4,
  ft: 1 / 304.8,
};

function round(n: number, places: number): number {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function formatLength(worldValue: number, unit: DisplayUnit): string {
  return `${round(worldValue * FACTOR_FROM_MM[unit], 3)}${unit}`;
}

export function formatArea(worldValueSquared: number, unit: DisplayUnit): string {
  const factor = FACTOR_FROM_MM[unit] ** 2;
  return `${round(worldValueSquared * factor, 3)}${unit}²`;
}
