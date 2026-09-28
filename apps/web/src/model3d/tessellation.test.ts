import { describe, expect, it } from "vitest";
import { COARSE_THRESHOLD_BYTES, tessellationFor } from "./tessellation";

// Picks the deflection OCCT tessellates with — wrong here means every large
// file either wastes memory (too fine) or looks faceted for no reason (too
// coarse), and a cached model must never silently switch levels later.

describe("tessellationFor", () => {
  it("uses the fine setting under the threshold", () => {
    const t = tessellationFor(1024);
    expect(t.linearDeflection).toBe(0.002);
    expect(t.angularDeflection).toBe(0.5);
  });

  it("uses the fine setting exactly at the threshold", () => {
    const t = tessellationFor(COARSE_THRESHOLD_BYTES);
    expect(t.linearDeflection).toBe(0.002);
  });

  it("switches to the coarse setting just above the threshold", () => {
    const t = tessellationFor(COARSE_THRESHOLD_BYTES + 1);
    expect(t.linearDeflection).toBe(0.005);
    expect(t.angularDeflection).toBe(0.8);
  });

  it("is deterministic for the same input", () => {
    const bytes = 58 * 1024 * 1024;
    expect(tessellationFor(bytes)).toEqual(tessellationFor(bytes));
  });
});
