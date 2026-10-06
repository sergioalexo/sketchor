// @vitest-environment jsdom
/**
 * Why: an installed theme is re-validated on every read, so a tampered
 * localStorage entry can't push a url() into the app's CSS, and the custom
 * theme setting must degrade to a built-in when its theme disappears.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getInstalledTheme, installThemeBundle, listInstalledThemes, uninstallThemePlugin } from "./installedThemes";
import { resolveMode, useTheme } from "./themeStore";

const bundle = (id = "com.acme.nord", bg = "#112233") => ({
  manifest: JSON.stringify({
    id,
    version: "1.0.0",
    name: "Nord",
    engines: { sketchor: "^0.5.0" },
    contributes: { themes: [{ id: "nord", title: "Nord", file: "t.json" }] },
  }),
  themes: { "t.json": JSON.stringify({ id: "nord", name: "Nord", base: "light", tokens: { canvas: { bg }, ui: { bg } } }) },
});

beforeEach(() => localStorage.clear());

describe("installedThemes", () => {
  it("installs, lists, replaces on update, uninstalls", () => {
    expect(installThemeBundle(bundle()).ok).toBe(true);
    installThemeBundle(bundle("com.acme.nord", "#445566"));
    expect(listInstalledThemes()).toHaveLength(1);
    expect(getInstalledTheme("com.acme.nord/nord")?.tokens.canvas.bg).toBe("#445566");
    uninstallThemePlugin("com.acme.nord");
    expect(listInstalledThemes()).toHaveLength(0);
  });
  it("refuses an invalid bundle without storing it", () => {
    expect(installThemeBundle(bundle("com.acme.bad", "url(http://x)")).ok).toBe(false);
    expect(installThemeBundle({ nope: 1 }).ok).toBe(false);
    expect(listInstalledThemes()).toHaveLength(0);
  });
  it("re-validates stored bundles on read", () => {
    localStorage.setItem("sketchor.themes.installed.v1", JSON.stringify([bundle("com.acme.evil", "url(http://x)"), "junk"]));
    expect(listInstalledThemes()).toEqual([]);
  });
});

describe("custom theme setting", () => {
  it("applies the theme's tokens and falls back when it is gone", () => {
    installThemeBundle(bundle());
    useTheme.getState().setSetting("custom:com.acme.nord/nord");
    expect(useTheme.getState().tokens.canvas.bg).toBe("#112233");
    expect(useTheme.getState().resolved).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#112233");
    uninstallThemePlugin("com.acme.nord");
    expect(resolveMode("custom:com.acme.nord/nord", true)).toBe("dark");
    useTheme.getState().setSetting("dark");
  });
});
