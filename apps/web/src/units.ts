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

/** How many display-unit units make up one stored (millimeter) world unit — e.g. `factorFromMm("in")` is `1/25.4`. */
export function factorFromMm(unit: DisplayUnit): number {
  return FACTOR_FROM_MM[unit];
}

export function formatLength(worldValue: number, unit: DisplayUnit): string {
  return `${round(worldValue * FACTOR_FROM_MM[unit], 3)}${unit}`;
}

export function formatArea(worldValueSquared: number, unit: DisplayUnit): string {
  const factor = FACTOR_FROM_MM[unit] ** 2;
  return `${round(worldValueSquared * factor, 3)}${unit}²`;
}

export function formatVolume(worldValueCubed: number, unit: DisplayUnit): string {
  const factor = FACTOR_FROM_MM[unit] ** 3;
  return `${round(worldValueCubed * factor, 3)}${unit}³`;
}

/** A mass in grams, shown as kg/g or lb/oz to match the display unit's system (in/ft = imperial, everything else metric). */
export function formatMass(grams: number, unit: DisplayUnit): string {
  if (unit === "in" || unit === "ft") {
    const lb = grams / 453.59237;
    return lb >= 0.1 ? `${round(lb, 3)}lb` : `${round(grams / 28.349523125, 2)}oz`;
  }
  const kg = grams / 1000;
  return kg >= 0.1 ? `${round(kg, 4)}kg` : `${round(grams, 2)}g`;
}

/**
 * DXF `$INSUNITS` codes this app can represent as a DisplayUnit (the spec
 * defines more — miles, mils, angstroms, US survey units, ... — which have
 * no DisplayUnit equivalent and are left unmapped rather than approximated).
 */
const DXF_UNIT_CODE: Record<DisplayUnit, number> = { in: 1, ft: 2, mm: 4, cm: 5, m: 6 };
const DXF_CODE_TO_UNIT = new Map<number, DisplayUnit>(
  Object.entries(DXF_UNIT_CODE).map(([unit, code]) => [code, unit as DisplayUnit]),
);

export function displayUnitToDxfCode(unit: DisplayUnit): number {
  return DXF_UNIT_CODE[unit];
}

/**
 * The closest DisplayUnit for the `$INSUNITS` codes that have no exact one
 * (the geometry itself is scaled exactly in dxf.ts; this only picks how the
 * numbers are shown): imperial small units as inches, imperial large units
 * as feet, metric by magnitude.
 */
const DXF_CODE_NEAREST_UNIT: Record<number, DisplayUnit> = {
  3: "ft", // miles
  7: "m", // kilometres
  8: "in", // microinches
  9: "in", // mils
  10: "ft", // yards
  11: "mm", // ångströms
  12: "mm", // nanometres
  13: "mm", // microns
  14: "cm", // decimetres
  15: "m", // decametres
  16: "m", // hectometres
  17: "m", // gigametres
  18: "m", // astronomical units
  19: "m", // light years
  20: "m", // parsecs
  21: "ft", // US survey feet
  22: "in", // US survey inches
  23: "ft", // US survey yards
  24: "ft", // US survey miles
};

/** The DisplayUnit for a DXF `$INSUNITS` code (nearest one for units Sketchor can't display), or null if unspecified/unknown. */
export function dxfCodeToDisplayUnit(code: number): DisplayUnit | null {
  return DXF_CODE_TO_UNIT.get(code) ?? DXF_CODE_NEAREST_UNIT[code] ?? null;
}

/** Human name of a DXF `$INSUNITS` code, for telling the user what a file was read in. */
export function dxfUnitName(code: number): string {
  return DXF_UNIT_NAMES[code] ?? "unitless";
}

const DXF_UNIT_NAMES: Record<number, string> = {
  1: "inches",
  2: "feet",
  3: "miles",
  4: "millimetres",
  5: "centimetres",
  6: "metres",
  7: "kilometres",
  8: "microinches",
  9: "mils",
  10: "yards",
  11: "ångströms",
  12: "nanometres",
  13: "microns",
  14: "decimetres",
  15: "decametres",
  16: "hectometres",
  17: "gigametres",
  18: "astronomical units",
  19: "light years",
  20: "parsecs",
  21: "US survey feet",
  22: "US survey inches",
  23: "US survey yards",
  24: "US survey miles",
};

// --- last-used unit, remembered per browser ---

const STORAGE_KEY = "sketchor.displayUnit";

/** The display unit the user last chose, or null if none stored / unavailable. */
export function loadDisplayUnit(): DisplayUnit | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return DISPLAY_UNITS.some((u) => u.id === v) ? (v as DisplayUnit) : null;
  } catch {
    return null;
  }
}

/** Remembers `unit` as the default for the next session. Failures are ignored. */
export function saveDisplayUnit(unit: DisplayUnit): void {
  try {
    localStorage.setItem(STORAGE_KEY, unit);
  } catch {
    /* private mode / storage disabled — the unit just won't persist */
  }
}
