import type { TableRecord } from "../tables";

/**
 * Dimension style (D-02a keeps the part layout needs; D-03 grows it into the
 * full DIMVAR set). Every length is in drawing units (mm) at DIMSCALE 1 —
 * a dimension's own `scale` multiplies them, which is how a dimension inside
 * a scaled block insert stays proportionate.
 */
export type ArrowKind = "closed" | "closedBlank" | "open" | "tick" | "dot" | "dotSmall" | "none";

export interface DimStyle extends TableRecord {
  /** DIMTXT — text height. */
  textHeight: number;
  /** DIMASZ — arrow length. */
  arrowSize: number;
  /** Arrow head full opening angle, degrees. */
  arrowAngle: number;
  arrow: ArrowKind;
  /** DIMEXO — gap between the measured point and the extension line. */
  extOffset: number;
  /** DIMEXE — extension past the dimension line. */
  extExtend: number;
  /** DIMGAP — clearance between text and dimension line. */
  gap: number;
  /** DIMDLI — spacing of baseline / continued dimension lines. */
  baselineSpacing: number;
  /** DIMTAD: text sits above the dimension line (true) or breaks it (false). */
  textAbove: boolean;
  /** DIMTIH/DIMTOH: text always horizontal. */
  textHorizontal: boolean;
  /** DIMDEC / DIMADEC. */
  decimals: number;
  angleDecimals: number;
  /** DIMZIN: which zeros go. */
  zeroSuppress: "none" | "leading" | "trailing" | "both";
  decimalSep: string;
  /** DIMLFAC — measured length multiplier. */
  lengthFactor: number;
  /** DIMPOST split into prefix/suffix. */
  prefix: string;
  suffix: string;
  /** Non-driving (reference) dimensions are shown in parentheses. */
  referenceParens: boolean;
  [extra: string]: unknown;
}

export const DEFAULT_DIM_STYLE: DimStyle = {
  name: "Standard",
  textHeight: 2.5,
  arrowSize: 2.5,
  arrowAngle: 20,
  arrow: "closed",
  extOffset: 0.625,
  extExtend: 1.25,
  gap: 0.625,
  baselineSpacing: 3.75,
  textAbove: true,
  textHorizontal: false,
  decimals: 2,
  angleDecimals: 1,
  zeroSuppress: "trailing",
  decimalSep: ".",
  lengthFactor: 1,
  prefix: "",
  suffix: "",
  referenceParens: false,
};

/** Built-in presets: ISO 129 (ISO-25), ASME Y14.5 (ANSI), GOST 2.307. Authored from the standards' proportions, not copied from any CAD product. */
export const DIM_STYLE_PRESETS: readonly DimStyle[] = [
  { ...DEFAULT_DIM_STYLE, name: "ISO-25" },
  {
    ...DEFAULT_DIM_STYLE,
    name: "ANSI",
    textHeight: 3.5,
    arrowSize: 3,
    extOffset: 1.5,
    extExtend: 1.5,
    gap: 1,
    baselineSpacing: 6,
    textAbove: false,
    textHorizontal: true,
    zeroSuppress: "none",
  },
  {
    ...DEFAULT_DIM_STYLE,
    name: "GOST",
    textHeight: 3.5,
    arrowSize: 3.5,
    arrowAngle: 15,
    extOffset: 0,
    extExtend: 2,
    gap: 1,
    baselineSpacing: 7,
    textAbove: true,
    decimalSep: ",",
  },
];

/** A loosely-typed table record (or nothing) as a complete {@link DimStyle}. Bad numbers fall back to the default. */
export function dimStyleOf(record: TableRecord | undefined, overrides?: Partial<DimStyle>): DimStyle {
  const out: DimStyle = { ...DEFAULT_DIM_STYLE };
  for (const src of [record, overrides]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      const def = (DEFAULT_DIM_STYLE as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (typeof def === "number") {
        if (typeof v === "number" && Number.isFinite(v)) (out as Record<string, unknown>)[k] = v;
      } else if (typeof def === "boolean") {
        if (typeof v === "boolean") (out as Record<string, unknown>)[k] = v;
      } else if (typeof def === "string") {
        if (typeof v === "string") (out as Record<string, unknown>)[k] = v;
      } else (out as Record<string, unknown>)[k] = v;
    }
  }
  out.name = record?.name ?? out.name;
  if (out.textHeight <= 0) out.textHeight = DEFAULT_DIM_STYLE.textHeight;
  if (out.arrowSize < 0) out.arrowSize = 0;
  out.decimals = Math.min(8, Math.max(0, Math.round(out.decimals)));
  out.angleDecimals = Math.min(8, Math.max(0, Math.round(out.angleDecimals)));
  if (out.lengthFactor === 0) out.lengthFactor = 1;
  return out;
}
