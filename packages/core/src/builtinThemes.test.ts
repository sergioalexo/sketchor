/**
 * Why: built-in themes are the first thing a user sees in the picker. One
 * mistyped token or an unreadable text/background pair ships to everyone, and
 * nothing else in the suite looks at them.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES, builtinTheme } from "./builtinThemes";
import { resolveTheme, validateTheme } from "./themeFile";

function lum(c: string): number {
  const h = c.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("BUILTIN_THEMES", () => {
  it("has unique ids that don't shadow the plain dark/light settings", () => {
    const ids = BUILTIN_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("dark");
    expect(ids).not.toContain("light");
    expect(builtinTheme("nord")?.name).toBe("Nord");
    expect(builtinTheme("nope")).toBeUndefined();
  });

  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))("%s passes the same validator an installed theme does", (_id, t) => {
    expect(validateTheme(t)).toMatchObject({ ok: true });
  });

  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))("%s keeps text and geometry readable on their backgrounds", (_id, t) => {
    const k = resolveTheme(t);
    const opaque = (c: string) => /^#[0-9a-f]{6}$/i.test(c);
    expect(contrast(k.ui.text, k.ui.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(k.ui.text, k.ui.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(k.ui.textDim, k.ui.panel)).toBeGreaterThanOrEqual(3);
    if (opaque(k.canvas.bg)) {
      expect(contrast(k.canvas.entity, k.canvas.bg)).toBeGreaterThanOrEqual(7);
      for (const key of ["selected", "snap", "handle", "reference"] as const) {
        expect(contrast(k.canvas[key], k.canvas.bg), key).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("a base mode matches the theme's actual brightness (the system pairing relies on it)", () => {
    for (const t of BUILTIN_THEMES) {
      const bg = resolveTheme(t).ui.bg;
      expect(lum(bg) < 0.2, t.id).toBe(t.base === "dark");
    }
  });
});
