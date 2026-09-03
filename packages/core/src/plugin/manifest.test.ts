import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest";

/**
 * The manifest validator is the first thing an untrusted bundle meets, so it
 * has to accept a well-formed manifest and give precise reasons for a bad one —
 * including holding the line on `contributes.tools`, which is reserved until the
 * viewport tool loop is decoupled (v2).
 */

const valid = {
  id: "com.acme.gears",
  version: "1.2.0",
  name: "Gears",
  main: "plugin.js",
  engines: { sketchor: "^0.3.0" },
  permissions: ["read-document", "write-document"],
};

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = validateManifest(valid);
    expect(result.ok).toBe(true);
  });

  it("reports every missing required field at once", () => {
    const result = validateManifest({ name: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('"id"'))).toBe(true);
      expect(result.errors.some((e) => e.includes('"version"'))).toBe(true);
      expect(result.errors.some((e) => e.includes('"main"'))).toBe(true);
      expect(result.errors.some((e) => e.includes("engines.sketchor"))).toBe(true);
    }
  });

  it("rejects an unknown permission", () => {
    const result = validateManifest({ ...valid, permissions: ["read-document", "take-over-the-world"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("take-over-the-world"))).toBe(true);
  });

  it("refuses a contributed tool (reserved for a future version)", () => {
    const result = validateManifest({ ...valid, contributes: { tools: [{ id: "gear", title: "Gear" }] } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("contributes.tools"))).toBe(true);
  });
});
