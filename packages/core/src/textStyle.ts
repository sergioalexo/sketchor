import type { TableRecord } from "./tables";
import { registerEntityRefRewriter } from "./tables";

/**
 * D-01: text styles. A `textStyles` table record names a font and the shape
 * parameters AutoCAD's STYLE command has. `TextEntity.style` refers to it by
 * name; per-entity `widthFactor`/`oblique` override the style's.
 *
 * `font` is one of `"sketchor-stroke"` (the built-in single-stroke font),
 * `"shx:<name>"` (mapped onto a stroke font — see {@link SHX_STROKE_MAP}) or
 * `"ttf:<family>"` (a system font on the canvas).
 */
export interface TextStyle extends TableRecord {
  font: string;
  /** Fixed text height; 0 = variable (each text carries its own). */
  height: number;
  widthFactor: number;
  /** Oblique angle in degrees (DXF 51), clockwise-positive lean to the right. */
  oblique: number;
  backwards: boolean;
  upsideDown: boolean;
}

export type TextHAlign = "left" | "center" | "right";
export type TextVAlign = "baseline" | "bottom" | "middle" | "top";

export const STANDARD_TEXT_STYLE: TextStyle = {
  name: "Standard",
  font: "sketchor-stroke",
  height: 0,
  widthFactor: 1,
  oblique: 0,
  backwards: false,
  upsideDown: false,
};

/** Styles every drawing can use without declaring them (ISO 3098 / GOST 2.304 are 15 degree italic). */
export const TEXT_STYLE_PRESETS: readonly TextStyle[] = [
  STANDARD_TEXT_STYLE,
  { ...STANDARD_TEXT_STYLE, name: "ISO", font: "shx:isocp", oblique: 15 },
  { ...STANDARD_TEXT_STYLE, name: "ANSI", font: "shx:simplex" },
  { ...STANDARD_TEXT_STYLE, name: "GOST", font: "shx:gost", oblique: 15 },
];

/** Common SHX names → the stroke font that stands in for them. */
export const SHX_STROKE_MAP: Record<string, string> = {
  txt: "sketchor-stroke",
  simplex: "sketchor-stroke",
  romans: "sketchor-stroke",
  isocp: "sketchor-stroke",
  gost: "sketchor-stroke",
};

/** Normalises a loosely-typed record into a full {@link TextStyle}. */
export function textStyleOf(record: TableRecord | undefined): TextStyle {
  if (!record) return STANDARD_TEXT_STYLE;
  const r = record as Partial<TextStyle>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    name: record.name,
    font: typeof r.font === "string" && r.font ? r.font : "sketchor-stroke",
    height: Math.max(0, num(r.height, 0)),
    widthFactor: num(r.widthFactor, 1) > 0 ? num(r.widthFactor, 1) : 1,
    oblique: num(r.oblique, 0),
    backwards: !!r.backwards,
    upsideDown: !!r.upsideDown,
  };
}

/** The slice of a text entity the style resolution reads. */
export interface StyledText {
  style?: string;
  widthFactor?: number;
  oblique?: number;
}

export interface ResolvedTextLook {
  font: string;
  widthFactor: number;
  oblique: number;
  backwards: boolean;
  upsideDown: boolean;
}

/** Entity overrides win over the named style (looked up through `lookup`; unknown name = Standard). */
export function resolveTextLook(e: StyledText, lookup?: (name: string) => TableRecord | undefined): ResolvedTextLook {
  const s = e.style && lookup ? textStyleOf(lookup(e.style)) : STANDARD_TEXT_STYLE;
  return {
    font: s.font,
    widthFactor: e.widthFactor && e.widthFactor > 0 ? e.widthFactor : s.widthFactor,
    oblique: e.oblique ?? s.oblique,
    backwards: s.backwards,
    upsideDown: s.upsideDown,
  };
}

/** CSS font-family for the canvas: TTF family by name, everything else the UI sans. */
export function canvasFontFamily(font: string): string {
  const ttf = font.startsWith("ttf:") ? font.slice(4).replace(/["\\]/g, "") : "";
  return (ttf ? `"${ttf}", ` : "") + "ui-sans-serif, system-ui, sans-serif";
}

/** Horizontal/vertical alignment as DXF 72/73 codes. */
export const H_ALIGN_CODE: Record<TextHAlign, number> = { left: 0, center: 1, right: 2 };
export const V_ALIGN_CODE: Record<TextVAlign, number> = { baseline: 0, bottom: 1, middle: 2, top: 3 };
export function hAlignFromCode(c: number): TextHAlign | undefined {
  return c === 1 ? "center" : c === 2 ? "right" : undefined;
}
export function vAlignFromCode(c: number): TextVAlign | undefined {
  return c === 1 ? "bottom" : c === 2 ? "middle" : c === 3 ? "top" : undefined;
}

/** Offset of the text box origin from the alignment point, as fractions of (width, height). */
export function alignOffset(h: TextHAlign | undefined, v: TextVAlign | undefined): { fx: number; fy: number } {
  return {
    fx: h === "center" ? -0.5 : h === "right" ? -1 : 0,
    fy: v === "middle" ? -0.5 : v === "top" ? -1 : 0,
  };
}

// Renaming a text style rewrites every text that names it.
registerEntityRefRewriter("textStyles", (entity, from, to) =>
  entity.type === "text" && entity.style === from ? { ...entity, style: to } : null,
);
