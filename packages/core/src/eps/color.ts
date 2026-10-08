/** Colour helpers for the EPS importer (SV-08: CMYK → RGB). */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex2 = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");

export type Rgb = [number, number, number];

export const rgbToCss = (c: Rgb): string => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;

/**
 * Plain subtractive CMYK → RGB, `(1-c)(1-k)`. Not ICC-managed: Illustrator's
 * own swatch conversion is a little duller, but this keeps pure inks exact
 * (0,1,0,0 → magenta, 0,0,0,1 → black) which is what cut/print work needs.
 */
export function cmykToRgb(c: number, m: number, y: number, k: number): Rgb {
  const kk = 1 - clamp01(k);
  return [(1 - clamp01(c)) * kk, (1 - clamp01(m)) * kk, (1 - clamp01(y)) * kk];
}

export function hsbToRgb(h: number, s: number, v: number): Rgb {
  h = clamp01(h) * 6;
  s = clamp01(s);
  v = clamp01(v);
  const i = Math.floor(h) % 6;
  const f = h - Math.floor(h);
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i] as Rgb;
}

export const isBlackRgb = (c: Rgb): boolean => c[0] < 0.004 && c[1] < 0.004 && c[2] < 0.004;
