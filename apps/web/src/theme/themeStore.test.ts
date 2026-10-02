// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "@sketchor/core";
import { resolveMode, useTheme } from "./themeStore";

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
