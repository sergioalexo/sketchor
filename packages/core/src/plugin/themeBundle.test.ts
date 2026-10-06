/**
 * Why: theme-only plugins skip signature checks, so the *only* thing keeping
 * code out is that validation. A bundle with a `main`, a permission, or a
 * theme path that climbs out of the bundle must never be treated as a theme.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_LIGHT } from "../theme";
import { isSafeBundlePath, isThemeOnly, validateManifest } from "./manifest";
import { isThemeBundle, loadThemeBundle } from "./themeBundle";

const theme = (tokens = {}) => JSON.stringify({ id: "nord", name: "Nord", base: "light", tokens });
const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "com.acme.nord",
    version: "1.0.0",
    name: "Nord",
    engines: { sketchor: "^0.5.0" },
    contributes: { themes: [{ id: "nord", title: "Nord", file: "themes/nord.json" }] },
    ...extra,
  });

describe("theme-only manifests", () => {
  it("validate without a main", () => {
    expect(validateManifest(JSON.parse(manifest())).ok).toBe(true);
    expect(isThemeOnly(JSON.parse(manifest()))).toBe(true);
  });
  it("must not declare main, ui, permissions or other contributions", () => {
    expect(validateManifest(JSON.parse(manifest({ main: "x.js" }))).ok).toBe(false);
    expect(isThemeOnly(JSON.parse(manifest({ ui: "p.html" })))).toBe(false);
    expect(isThemeOnly(JSON.parse(manifest({ permissions: ["document.read"] })))).toBe(false);
    const withCmd = JSON.parse(manifest());
    withCmd.contributes.commands = [{ id: "a.b", title: "x" }];
    expect(isThemeOnly(withCmd)).toBe(false);
  });
  it("a plugin without themes still needs main", () => {
    const m = JSON.parse(manifest());
    delete m.contributes;
    expect(validateManifest(m).ok).toBe(false);
  });
  it("rejects bad theme entries", () => {
    const bad = (themes: unknown) => validateManifest({ ...JSON.parse(manifest()), contributes: { themes } }).ok;
    expect(bad([{ id: "A B", title: "t", file: "a.json" }])).toBe(false);
    expect(bad([{ id: "a", title: "", file: "a.json" }])).toBe(false);
    expect(bad([{ id: "a", title: "t", file: "../a.json" }])).toBe(false);
    expect(bad([{ id: "a", title: "t", file: "a.json" }, { id: "a", title: "t", file: "b.json" }])).toBe(false);
    expect(bad("nope")).toBe(false);
  });
  it("isSafeBundlePath blocks traversal and absolute paths", () => {
    for (const p of ["/etc/x.json", "a/../b.json", "..\\b.json", "C:/x.json", "a//b.json", "a.txt", "./a.json"]) expect(isSafeBundlePath(p)).toBe(false);
    expect(isSafeBundlePath("themes/nord.json")).toBe(true);
  });
});

describe("loadThemeBundle", () => {
  it("loads and resolves a valid bundle", () => {
    const r = loadThemeBundle({ manifest: manifest(), themes: { "themes/nord.json": theme({ canvas: { bg: "#112233" } }) } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.themes[0].key).toBe("com.acme.nord/nord");
    expect(r.themes[0].tokens.canvas.bg).toBe("#112233");
    expect(r.themes[0].tokens.canvas.entity).toBe(DEFAULT_LIGHT.canvas.entity);
  });
  it("reports a missing file, bad JSON and unsafe tokens together", () => {
    const m = JSON.stringify({
      ...JSON.parse(manifest()),
      contributes: { themes: [
        { id: "a", title: "A", file: "a.json" },
        { id: "b", title: "B", file: "b.json" },
        { id: "c", title: "C", file: "c.json" },
      ] },
    });
    const r = loadThemeBundle({ manifest: m, themes: { "b.json": "{nope", "c.json": theme({ ui: { bg: "url(x)" } }) } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(/a\.json.*missing/);
    expect(r.errors.join("\n")).toMatch(/b\.json.*not valid JSON/);
    expect(r.errors.join("\n")).toMatch(/c\.json.*tokens\.ui\.bg/);
  });
  it("refuses a bundle that carries code, and an oversized theme", () => {
    expect(loadThemeBundle({ manifest: manifest({ main: "x.js" }), themes: {} }).ok).toBe(false);
    expect(loadThemeBundle({ manifest: manifest(), themes: { "themes/nord.json": " ".repeat(70000) } }).ok).toBe(false);
    expect(loadThemeBundle({ manifest: "{", themes: {} }).ok).toBe(false);
  });
  it("does not read inherited keys as files", () => {
    const m = JSON.stringify({ ...JSON.parse(manifest()), contributes: { themes: [{ id: "a", title: "A", file: "constructor.json" }] } });
    expect(loadThemeBundle({ manifest: m, themes: {} }).ok).toBe(false);
  });
  it("isThemeBundle tells it apart from a signed plugin bundle", () => {
    expect(isThemeBundle({ manifest: "{}", themes: {} })).toBe(true);
    expect(isThemeBundle({ manifest: "{}", code: "x", signature: "s", publicKey: "k" })).toBe(false);
    expect(isThemeBundle(null)).toBe(false);
  });
});
