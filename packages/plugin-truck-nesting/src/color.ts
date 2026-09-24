/**
 * How far apart two drop colours look.
 *
 * A load plan is read on a dock, often from a photocopy, and the colour is
 * the only thing that says which pallet belongs to which drop. Two colours
 * that a screen shows as clearly different can be near-identical to a
 * colour-blind reader or after a fax; RGB distance doesn't know that, so the
 * comparison happens in CIE Lab, where distance approximates what the eye
 * reports. The default palette (Okabe–Ito) is already safe — this is for
 * when someone picks their own.
 */

interface Lab {
  L: number;
  a: number;
  b: number;
}

function channel(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB hex → CIE Lab (D65). Returns null for anything that isn't a hex colour. */
export function toLab(color: string): Lab | null {
  const hex = color.trim().replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const [r, g, b] = [0, 1, 2].map((i) => channel(parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255));

  // Linear sRGB → XYZ (D65), then XYZ → Lab.
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return { L: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

/** CIE76 colour difference — roughly "just noticeable" at 2.3, obvious by 30. */
export function colorDistance(a: string, b: string): number {
  const la = toLab(a);
  const lb = toLab(b);
  if (!la || !lb) return Number.POSITIVE_INFINITY; // can't judge it, don't complain about it
  return Math.hypot(la.L - lb.L, la.a - lb.a, la.b - lb.b);
}

/**
 * Below this, two drops are close enough that someone glancing at a printed
 * plan — or a colour-blind reader, or a photocopy — can mistake one for the
 * other. Set well above "just noticeable": the plan has to survive being
 * read badly, in bad light, by someone in a hurry.
 */
export const MIN_DROP_DISTANCE = 25;

/** True when two drop colours are too close to tell apart on a printed plan. */
export function tooSimilar(a: string, b: string): boolean {
  return colorDistance(a, b) < MIN_DROP_DISTANCE;
}

/** The first palette colour that no existing drop is already using (or the next in rotation). */
export function nextDistinctColor(palette: readonly string[], used: readonly string[]): string {
  const free = palette.find((c) => used.every((u) => !tooSimilar(c, u)));
  return free ?? palette[used.length % palette.length] ?? "#4f86d6";
}
