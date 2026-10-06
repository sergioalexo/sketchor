import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "./builtinThemes";
import { checkTheme, contrastRatio, parseColor, toHex } from "./contrast";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "./theme";
import { resolveTheme, validateTheme } from "./themeFile";
import { themeBundleFor, themeFromTokens, themeId } from "./themeAuthoring";
import { loadThemeBundle } from "./plugin/themeBundle";

describe("contrast", () => {
  it("matches the WCAG reference ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
  });
  it("reads hex, rgb, hsl and names alike", () => {
    expect(toHex(parseColor("rgb(255, 0, 0)")!)).toBe("#ff0000");
    expect(toHex(parseColor("hsl(120, 100%, 50%)")!)).toBe("#00ff00");
    expect(toHex(parseColor("#0f0")!)).toBe("#00ff00");
    expect(toHex(parseColor("Navy")!)).toBe("#000080");
    expect(parseColor("nonsense")).toBeNull();
    expect(contrastRatio("red", "nonsense")).toBeNull();
  });
  it("composites a translucent foreground onto the background", () => {
    const solid = contrastRatio("#000000", "#ffffff")!;
    expect(contrastRatio("rgba(0,0,0,0.5)", "#ffffff")!).toBeLessThan(solid);
  });
  it("the two default themes pass every text pair", () => {
    for (const t of [DEFAULT_DARK, DEFAULT_LIGHT]) {
      for (const r of checkTheme(t).filter((r) => r.min === 4.5 && r.id.startsWith("text"))) expect(r.ok, r.label).toBe(true);
    }
  });
  it("flags a theme with unreadable text", () => {
    const bad = { ...DEFAULT_DARK, ui: { ...DEFAULT_DARK.ui, text: DEFAULT_DARK.ui.bg } };
    expect(checkTheme(bad).find((r) => r.id === "text-bg")!.ok).toBe(false);
  });
});

describe("theme authoring", () => {
  it("writes only what differs from the base, and it resolves back to the same tokens", () => {
    const edited = { ...DEFAULT_DARK, ui: { ...DEFAULT_DARK.ui, accent: "#ff8800" }, canvas: { ...DEFAULT_DARK.canvas, bg: "#000000" } };
    const file = themeFromTokens(edited, "dark", { name: "Night Owl", author: "me" });
    expect(file.tokens).toEqual({ ui: { accent: "#ff8800" }, canvas: { bg: "#000000" } });
    expect(file.id).toBe("night-owl");
    expect(validateTheme(file).ok).toBe(true);
    expect(resolveTheme(file)).toMatchObject({ ui: edited.ui, canvas: edited.canvas, model3d: edited.model3d, code: edited.code });
  });
  it("an unchanged theme has no overrides; a built-in survives the round trip", () => {
    expect(themeFromTokens(DEFAULT_LIGHT, "light", { name: "x" }).tokens).toEqual({});
    const b = BUILTIN_THEMES[0];
    const tokens = resolveTheme(b);
    expect(resolveTheme(themeFromTokens(tokens, b.base, { name: b.name }))).toMatchObject({ ui: tokens.ui, canvas: tokens.canvas, model3d: tokens.model3d, code: tokens.code });
  });
  it("makes safe ids", () => {
    expect(themeId("  Ünï Théme!! ")).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(themeId("???")).toBe("theme");
  });
  it("packages as a bundle the host accepts", () => {
    const file = themeFromTokens({ ...DEFAULT_DARK, ui: { ...DEFAULT_DARK.ui, accent: "#ff8800" } }, "dark", { name: "Orange" });
    const r = loadThemeBundle(themeBundleFor(file));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.themes[0].tokens.ui.accent).toBe("#ff8800");
  });
});
