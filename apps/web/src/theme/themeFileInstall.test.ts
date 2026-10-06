import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, themeBundleFor, themeFromTokens } from "@sketchor/core";
import { isThemeFileName, parseThemeFileText } from "./themeFileInstall";

const file = themeFromTokens({ ...DEFAULT_DARK, ui: { ...DEFAULT_DARK.ui, accent: "#ff8800" } }, "dark", { name: "Orange" });

describe("theme file install", () => {
  it("accepts a bare theme file (what the editor exports)", () => {
    const r = parseThemeFileText(JSON.stringify(file));
    expect(r.ok && r.titles).toEqual(["Orange"]);
  });
  it("accepts a theme-only bundle", () => {
    const r = parseThemeFileText(JSON.stringify(themeBundleFor(file)));
    expect(r.ok && r.titles).toEqual(["Orange"]);
  });
  it("explains an invalid theme, and says unrelated JSON is not a theme", () => {
    const bad = parseThemeFileText(JSON.stringify({ ...file, tokens: { ui: { bg: "url(x)" } } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.notATheme).toBe(false);
    const other = parseThemeFileText('{"hello":1}');
    expect(!other.ok && other.notATheme).toBe(true);
    expect(parseThemeFileText("nope").ok).toBe(false);
  });
  it("recognises theme file names", () => {
    expect(isThemeFileName("nord.sketchor-theme.json")).toBe(true);
    expect(isThemeFileName("drawing.dxf")).toBe(false);
  });
});
