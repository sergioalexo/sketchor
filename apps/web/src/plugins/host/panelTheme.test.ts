import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "@sketchor/core";
import { panelThemeHead, panelThemeMessage, panelThemeVars } from "./panelTheme";

describe("panel theme", () => {
  it("maps ui tokens to --sk-* variables", () => {
    const v = panelThemeVars(DEFAULT_LIGHT);
    expect(v["--sk-bg"]).toBe(DEFAULT_LIGHT.ui.bg);
    expect(v["--sk-accent"]).toBe(DEFAULT_LIGHT.ui.accent);
    expect(Object.keys(v)).toHaveLength(8);
  });
  it("builds a head with style + listener, and a matching update message", () => {
    const head = panelThemeHead(panelThemeVars(DEFAULT_DARK));
    expect(head).toContain('id="sketchor-theme"');
    expect(head).toContain(`--sk-bg:${DEFAULT_DARK.ui.bg}`);
    expect(panelThemeMessage(panelThemeVars(DEFAULT_DARK)).sketchorTheme).toContain("--sk-text:");
  });
  it("strips characters that could break out of the style rule", () => {
    const t = { ...DEFAULT_DARK, ui: { ...DEFAULT_DARK.ui, bg: "red;}</style><script>x" } };
    const head = panelThemeHead(panelThemeVars(t));
    expect(head.match(/<\/style>/g)).toHaveLength(1);
  });
});
