/**
 * Why this matters: a pattern pack is installed without a signature because it
 * is data only. These pin that it really is: nothing with code or permissions
 * passes, paths cannot climb out of the bundle, a built-in is never replaced,
 * and a drawing carries a contributed pattern the way it carries an import.
 */
import { describe, expect, it } from "vitest";
import "../hatch/library";
import { isCustomPattern, registerContributed, removeContributed } from "../hatch/userPatterns";
import { lookupPattern } from "../hatch/registry";
import { isPatternBundle, loadPatternBundle } from "./patternBundle";
import { validateManifest } from "./manifest";

const PAT = "*BRICKX, test brick\n0, 0,0, 0,6\n90, 0,0, 12,6, 6,-6\n\n*ANSI31, would shadow a built-in\n45, 0,0, 0,3\n";
const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "com.example.materials",
    version: "1.0.0",
    name: "Materials",
    engines: { sketchor: "^1.0.0" },
    contributes: { hatchPatterns: [{ file: "patterns/materials.pat", category: "Shop" }] },
    ...extra,
  });

describe("pattern-only plugin bundles", () => {
  it("validates, parses the .pat, and tags every pattern with the category", () => {
    const r = loadPatternBundle({ manifest: manifest(), patterns: { "patterns/materials.pat": PAT } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patterns.map((p) => p.name)).toEqual(["BRICKX", "ANSI31"]);
    expect(r.patterns.every((p) => p.category === "Shop")).toBe(true);
  });

  it("falls back to the plugin name as the category", () => {
    const m = JSON.stringify({ id: "com.example.m", version: "1.0.0", name: "Mine", engines: { sketchor: "^1.0.0" }, contributes: { hatchPatterns: [{ file: "a.pat" }] } });
    const r = loadPatternBundle({ manifest: m, patterns: { "a.pat": PAT } });
    expect(r.ok && r.patterns[0].category).toBe("Mine");
  });

  it("rejects code, permissions, unsafe paths, missing and empty files", () => {
    expect(loadPatternBundle({ manifest: manifest({ main: "main.js" }), patterns: { "patterns/materials.pat": PAT } }).ok).toBe(false);
    expect(loadPatternBundle({ manifest: manifest({ permissions: ["document.write"] }), patterns: { "patterns/materials.pat": PAT } }).ok).toBe(false);
    expect(loadPatternBundle({ manifest: manifest(), patterns: {} }).ok).toBe(false);
    expect(loadPatternBundle({ manifest: manifest(), patterns: { "patterns/materials.pat": "no patterns here" } }).ok).toBe(false);
    expect(loadPatternBundle({ manifest: "{", patterns: {} }).ok).toBe(false);
    for (const file of ["../x.pat", "/abs.pat", "a\\b.pat", "x.json", "C:/x.pat"]) {
      const m = JSON.parse(manifest());
      m.contributes.hatchPatterns = [{ file }];
      expect(validateManifest(m).ok).toBe(false);
    }
  });

  it("recognises the bundle shape", () => {
    expect(isPatternBundle({ manifest: "{}", patterns: {} })).toBe(true);
    expect(isPatternBundle({ manifest: "{}", patterns: {}, code: "x" })).toBe(false);
    expect(isPatternBundle(null)).toBe(false);
  });

  it("registers under its category, never over a built-in, and counts as custom (stored in the drawing)", () => {
    const r = loadPatternBundle({ manifest: manifest(), patterns: { "patterns/materials.pat": PAT } });
    if (!r.ok) throw new Error("bundle");
    const builtin = lookupPattern("ANSI31");
    expect(registerContributed(r.patterns)).toEqual(["BRICKX"]);
    expect(lookupPattern("ANSI31")).toBe(builtin);
    expect(lookupPattern("BRICKX")?.category).toBe("Shop");
    expect(isCustomPattern("BRICKX")).toBe(true);
    expect(isCustomPattern("ANSI31")).toBe(false);
    removeContributed(["BRICKX"]);
    expect(lookupPattern("BRICKX")).toBeUndefined();
  });
});
