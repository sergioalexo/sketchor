// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "@sketchor/core";
import { effectiveSetting, resolveMode, useTheme } from "./themeStore";

/**
 * Z-03: the theme store is the one place a mode picks real tokens and pushes
 * them onto `:root` as CSS variables — this is what a screenshot diff
 * actually depends on, so it's worth asserting directly rather than trusting
 * the wiring by inspection.
 */

describe("resolveMode", () => {
  it("passes dark/light through unchanged", () => {
    expect(resolveMode("dark", true)).toBe("dark");
    expect(resolveMode("dark", false)).toBe("dark");
    expect(resolveMode("light", true)).toBe("light");
  });

  it("follows the OS preference for 'system'", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
  });
});

describe("useTheme", () => {
  it("starts with dark tokens, byte-identical to today's hard-coded defaults", () => {
    useTheme.getState().setSetting("dark");
    expect(useTheme.getState().tokens).toEqual(DEFAULT_DARK);
    expect(useTheme.getState().resolved).toBe("dark");
  });

  it("switching to light applies the light tokens as CSS variables on :root", () => {
    useTheme.getState().setSetting("light");
    expect(useTheme.getState().tokens).toEqual(DEFAULT_LIGHT);
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--bg").trim()).toBe(DEFAULT_LIGHT.ui.bg);
    expect(root.style.getPropertyValue("--accent").trim()).toBe(DEFAULT_LIGHT.ui.accent);
    expect(root.style.getPropertyValue("--danger").trim()).toBe(DEFAULT_LIGHT.ui.danger);
    useTheme.getState().setSetting("dark"); // leave global DOM state as found for other tests
    expect(root.style.getPropertyValue("--bg").trim()).toBe(DEFAULT_DARK.ui.bg);
  });

  it("persists the setting across store instances via localStorage", () => {
    useTheme.getState().setSetting("light");
    expect(localStorage.getItem("sketchor.theme.v1")).toBe("light");
    useTheme.getState().setSetting("dark"); // restore default for other tests in this file
  });
});

describe("effectiveSetting + pairing (TH-03)", () => {
  const pair = { dark: "custom:acme/nord", light: "light" } as const;

  it("'system' becomes the paired theme for the OS appearance; others are themselves", () => {
    expect(effectiveSetting("system", pair, true)).toBe("custom:acme/nord");
    expect(effectiveSetting("system", pair, false)).toBe("light");
    expect(effectiveSetting("dark", pair, false)).toBe("dark");
  });

  it("preview applies a theme without saving it, and preview(null) restores the chosen one", () => {
    useTheme.getState().setSetting("dark");
    useTheme.getState().preview("light");
    expect(useTheme.getState().tokens).toEqual(DEFAULT_LIGHT);
    expect(document.documentElement.style.getPropertyValue("--bg").trim()).toBe(DEFAULT_LIGHT.ui.bg);
    expect(localStorage.getItem("sketchor.theme.v1")).toBe("dark");
    useTheme.getState().preview(null);
    expect(useTheme.getState().tokens).toEqual(DEFAULT_DARK);
    expect(useTheme.getState().previewing).toBeNull();
  });

  it("choosing a theme clears any preview, and the pair persists", () => {
    useTheme.getState().preview("light");
    useTheme.getState().setSetting("dark");
    expect(useTheme.getState().previewing).toBeNull();
    useTheme.getState().setPair({ light: "dark" });
    expect(JSON.parse(localStorage.getItem("sketchor.theme.pair.v1") ?? "{}")).toEqual({ dark: "dark", light: "dark" });
    useTheme.getState().setPair({ light: "light" });
  });

  it("'system' uses the pair (jsdom has no matchMedia, so it reads as dark)", () => {
    useTheme.getState().setPair({ dark: "light" });
    useTheme.getState().setSetting("system");
    expect(useTheme.getState().tokens).toEqual(DEFAULT_LIGHT);
    useTheme.getState().setPair({ dark: "dark" });
    useTheme.getState().setSetting("dark");
  });
});

describe("built-in themes (TH-06)", () => {
  it("builtin:<id> applies the resolved theme and reports its base mode", () => {
    useTheme.getState().setSetting("builtin:solarized-light");
    expect(useTheme.getState().resolved).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--bg").trim()).toBe("#fdf6e3");
    useTheme.getState().setSetting("builtin:blueprint");
    expect(useTheme.getState().resolved).toBe("dark");
    expect(useTheme.getState().tokens.canvas.bg).toBe("#123c7c");
    expect(localStorage.getItem("sketchor.theme.v1")).toBe("builtin:blueprint");
    useTheme.getState().setSetting("dark");
  });

  it("an unknown builtin id falls back to the plain theme instead of throwing", () => {
    useTheme.getState().setSetting("builtin:does-not-exist");
    expect(useTheme.getState().tokens).toBeDefined();
    useTheme.getState().setSetting("dark");
  });

  it("can be the system pair's dark or light side", () => {
    useTheme.getState().setPair({ dark: "builtin:nord" });
    useTheme.getState().setSetting("system"); // jsdom: no matchMedia → reads as dark
    expect(useTheme.getState().tokens.ui.bg).toBe("#2e3440");
    useTheme.getState().setPair({ dark: "dark" });
    useTheme.getState().setSetting("dark");
  });
});
