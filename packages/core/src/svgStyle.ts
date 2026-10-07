import { BUILTIN_LINETYPES } from "./linetypes";

/**
 * SVG styling (SV-03): the pure half of how an imported element gets its
 * stroke / fill / dash / width. Presentation attributes < `<style>` rules
 * (by specificity, then source order) < the `style=""` attribute. Selector
 * *matching* is the browser's own `Element.matches` (see svg.ts) — this file
 * only parses the sheet and orders the rules, so there is no CSS engine here.
 */

export type Declarations = Record<string, string>;

/** The properties the importer maps; everything else in a style is ignored. */
export const STYLE_PROPS = ["stroke", "fill", "stroke-width", "stroke-dasharray", "display", "visibility", "opacity", "color", "fill-opacity", "stroke-opacity", "font-size", "text-anchor", "font-family"] as const;
/** Inherited through `<g>` (display and opacity are not). */
export const INHERITED_PROPS = new Set(["stroke", "fill", "stroke-width", "stroke-dasharray", "visibility", "color", "font-size", "text-anchor", "font-family"]);

/** `a:b; c:d` → `{a:"b", c:"d"}` (lower-cased names, `!important` stripped, tolerant of junk). */
export function parseDeclarations(text: string): Declarations {
  const out: Declarations = {};
  for (const part of text.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const value = part
      .slice(i + 1)
      .replace(/!\s*important/i, "")
      .trim();
    if (name && value) out[name] = value;
  }
  return out;
}

export interface StyleRule {
  selector: string;
  decls: Declarations;
  specificity: number;
  order: number;
}

/** A selector's specificity as one comparable number (ids·10000 + classes/attrs/pseudo-classes·100 + types). */
export function specificity(selector: string): number {
  const s = selector.replace(/\[[^\]]*\]/g, " [a] ").replace(/:not\(([^)]*)\)/g, " $1 ");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[a\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (s.replace(/#[\w-]+|\.[\w-]+|\[a\]|::?[\w-]+(\([^)]*\))?/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w:-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

/**
 * Parses stylesheet text into rules (one per comma-separated selector).
 * At-rules (`@media`, `@font-face`, `@import`, …) are skipped whole;
 * unbalanced input stops parsing instead of throwing.
 */
export function parseStyleSheet(text: string, firstOrder = 0): StyleRule[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!\[CDATA\[|\]\]>/g, "");
  const rules: StyleRule[] = [];
  let i = 0;
  let order = firstOrder;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    if (css[i] === "@") {
      // Skip to ';' (statement at-rule) or past the matching '}' (block at-rule).
      let j = i;
      while (j < css.length && css[j] !== ";" && css[j] !== "{") j++;
      if (css[j] === "{") {
        let depth = 0;
        for (; j < css.length; j++) {
          if (css[j] === "{") depth++;
          else if (css[j] === "}" && --depth === 0) break;
        }
      }
      i = j + 1;
      continue;
    }
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const close = css.indexOf("}", open);
    if (close < 0) break;
    const decls = parseDeclarations(css.slice(open + 1, close));
    for (const sel of css.slice(i, open).split(",")) {
      const selector = sel.trim();
      if (selector && Object.keys(decls).length) rules.push({ selector, decls, specificity: specificity(selector), order: order++ });
    }
    i = close + 1;
  }
  return rules;
}

const NAMED_BLACK = new Set(["black", "#000", "#000000", "#000f", "#000000ff"]);

/**
 * A CSS paint → a colour string, or `null` for "none"/unusable. `url(#…)`
 * (gradients, patterns) is unusable until gradient fills exist. Black maps
 * to `undefined`-like "automatic" via {@link isBlack} — callers decide.
 */
export function paintColor(value: string | undefined, currentColor?: string): string | null | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (!v || v === "inherit") return undefined;
  const lower = v.toLowerCase();
  if (lower === "none" || lower === "transparent") return null;
  if (lower.startsWith("url(")) return null;
  if (lower === "currentcolor") return currentColor ?? undefined;
  return v;
}

export function isBlack(color: string): boolean {
  const c = color.replace(/\s+/g, "").toLowerCase();
  return NAMED_BLACK.has(c) || /^rgba?\(0,0,0(,1(\.0+)?)?\)$/.test(c);
}

/** A CSS length in user units: bare number, `px`, or `%`-free; anything else → null. */
export function parseUserLength(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(value);
  return m ? parseFloat(m[1]) : null;
}

/** `stroke-dasharray` → numbers (an odd count is doubled, per SVG); `none`/zeros/garbage → null. */
export function parseDashArray(value: string | undefined): number[] | null {
  if (!value || /^\s*(none|inherit)\s*$/i.test(value)) return null;
  const nums = value
    .trim()
    .split(/[\s,]+/)
    .map((s) => parseFloat(s));
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const full = nums.length % 2 ? [...nums, ...nums] : nums;
  return full.reduce((a, b) => a + b, 0) > 0 ? full : null;
}

/**
 * The built-in linetype closest to a dash pattern (already in mm). Patterns
 * are compared as [dash, -gap, …] against {@link BUILTIN_LINETYPES}; only
 * same-length patterns compete, and a longer pattern is judged by its first
 * period. Never null — an unmatched pattern is "dashed".
 */
export function nearestLinetype(dashMm: number[]): string {
  const sig = (d: number[]): number[] => d.map((v, i) => (i % 2 ? -v : v));
  const want = sig(dashMm);
  let best = "DASHED";
  let bestDist = Infinity;
  for (const lt of Object.values(BUILTIN_LINETYPES)) {
    const p = lt.pattern;
    if (p.length === 0) continue;
    const n = p.length;
    if (want.length < n || want.length % n !== 0) continue;
    let dist = 0;
    for (let k = 0; k < want.length; k++) dist += Math.abs(want[k] - p[k % n]);
    dist /= want.length / n;
    if (dist < bestDist) {
      bestDist = dist;
      best = lt.name;
    }
  }
  return best;
}

/** A CSS `font-size` in user units (px = unitless; pt/mm/cm/in converted at 96 dpi, `em` against 16); null when unusable. */
export function parseFontSize(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*(px|pt|pc|mm|cm|in|em|rem)?\s*$/i.exec(value);
  if (!m) return null;
  const k = { "": 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, rem: 16 }[(m[2] ?? "").toLowerCase() as "px"];
  const v = parseFloat(m[1]) * k;
  return v > 0 ? v : null;
}
