/**
 * TH-04: WCAG contrast for the theme editor. `parseColor` reads the colour
 * syntax `isSafeColor` admits (hex, rgb(), hsl(), a handful of names) and
 * `contrastRatio` is the WCAG 2 relative-luminance ratio. `checkTheme` runs
 * the pairs that matter — text on its panel, geometry on the canvas — against
 * 4.5:1 for text and 3:1 for geometry (WCAG's "non-text contrast").
 */
import type { ThemeTokens } from "./theme";

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  orange: "#ffa500",
  lime: "#00ff00",
  navy: "#000080",
  silver: "#c0c0c0",
  transparent: "#00000000",
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function channel(s: string): number {
  const v = parseFloat(s);
  return s.trim().endsWith("%") ? (clamp(v, 0, 100) / 100) * 255 : clamp(v, 0, 255);
}

function alphaOf(s: string | undefined): number {
  if (s === undefined) return 1;
  const v = parseFloat(s);
  return clamp(s.trim().endsWith("%") ? v / 100 : v, 0, 1);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    const x = (t + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

/** A CSS colour as 0–255 channels plus alpha, or null when it isn't one this module understands. */
export function parseColor(input: string): Rgb | null {
  const v = input.trim().toLowerCase();
  const s = NAMED[v] ?? v;
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([^,\s/)]+)[,\s]+([^,\s/)]+)[,\s]+([^,\s/)]+)(?:\s*[,/]\s*([^)\s]+))?\s*\)$/.exec(s);
  if (m) return { r: channel(m[1]), g: channel(m[2]), b: channel(m[3]), a: alphaOf(m[4]) };
  m = /^hsla?\(\s*([^,\s/)%]+?)(?:deg)?[,\s]+([^,\s/)]+)%[,\s]+([^,\s/)]+)%(?:\s*[,/]\s*([^)\s]+))?\s*\)$/.exec(s);
  if (m) {
    const [r, g, b] = hslToRgb(parseFloat(m[1]), clamp(parseFloat(m[2]), 0, 100) / 100, clamp(parseFloat(m[3]), 0, 100) / 100);
    return { r, g, b, a: alphaOf(m[4]) };
  }
  return null;
}

/** `#rrggbb` for a colour the native colour input can show (alpha dropped). */
export function toHex(c: Rgb): string {
  const h = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function luminance(c: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** `fg` laid over opaque `bg`. */
function over(fg: Rgb, bg: Rgb): Rgb {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
}

/** WCAG contrast ratio, 1–21; a translucent foreground is composited onto `bg`, a translucent `bg` onto white. null if either colour doesn't parse. */
export function contrastRatio(fg: string, bg: string): number | null {
  const f = parseColor(fg);
  const b0 = parseColor(bg);
  if (!f || !b0) return null;
  const b = over(b0, { r: 255, g: 255, b: 255, a: 1 });
  const l1 = luminance(over(f, b));
  const l2 = luminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastPair {
  id: string;
  label: string;
  /** Token paths, e.g. `ui.text`. */
  fg: string;
  bg: string;
  /** 4.5 for text, 3 for geometry. */
  min: number;
}

const T = 4.5;
const G = 3;
// No code.* pairs: the sketch-code view does not use those tokens yet, so a ratio there would be noise.
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { id: "text-bg", label: "Text on window", fg: "ui.text", bg: "ui.bg", min: T },
  { id: "text-panel", label: "Text on panel", fg: "ui.text", bg: "ui.panel", min: T },
  { id: "dim-panel", label: "Dim text on panel", fg: "ui.textDim", bg: "ui.panel", min: T },
  { id: "accent-bg", label: "Accent on window", fg: "ui.accent", bg: "ui.bg", min: G },
  { id: "danger-panel", label: "Danger on panel", fg: "ui.danger", bg: "ui.panel", min: T },
  { id: "entity", label: "Geometry on canvas", fg: "canvas.entity", bg: "canvas.bg", min: G },
  { id: "selected", label: "Selection on canvas", fg: "canvas.selected", bg: "canvas.bg", min: G },
  { id: "preview", label: "Preview on canvas", fg: "canvas.preview", bg: "canvas.bg", min: G },
  { id: "snap", label: "Snap marker on canvas", fg: "canvas.snap", bg: "canvas.bg", min: G },
  { id: "handle", label: "Grips on canvas", fg: "canvas.handle", bg: "canvas.bg", min: G },
  { id: "hover", label: "Hover on canvas", fg: "canvas.hover", bg: "canvas.bg", min: 2.5 },
  { id: "measure", label: "Measurement on canvas", fg: "canvas.measure", bg: "canvas.bg", min: G },
  { id: "m3d-highlight", label: "3D selection on stage", fg: "model3d.highlight", bg: "model3d.bg", min: G },
];

export interface ContrastResult extends ContrastPair {
  ratio: number | null;
  ok: boolean;
}

const tokenAt = (t: ThemeTokens, path: string): string | undefined => {
  const [g, k] = path.split(".");
  return (t as unknown as Record<string, Record<string, string> | undefined>)[g]?.[k];
};

export function checkTheme(tokens: ThemeTokens): ContrastResult[] {
  return CONTRAST_PAIRS.map((p) => {
    const fg = tokenAt(tokens, p.fg);
    const bg = tokenAt(tokens, p.bg);
    const ratio = fg && bg ? contrastRatio(fg, bg) : null;
    return { ...p, ratio, ok: ratio !== null && ratio >= p.min };
  });
}
