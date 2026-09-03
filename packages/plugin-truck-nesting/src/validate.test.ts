import { describe, expect, it } from "vitest";
import { validateNest } from "./validate";
import type { NestResult, PlacedItem } from "./types";

function placed(over: Partial<PlacedItem> & Pick<PlacedItem, "instanceId" | "stop" | "x">): PlacedItem {
  return {
    itemId: "i",
    label: "Pallet",
    weightKg: 400,
    y: 0,
    length: 1200,
    width: 800,
    rotated: false,
    ...over,
  };
}

const trailer = { name: "T", length: 13600, width: 2480, maxWeightKg: 5000 };

describe("validateNest", () => {
  it("passes a clean, balanced result", () => {
    const result: NestResult = {
      trailer,
      // one pallet at the door, one at the nose — weight split ~50/50, unload order safe.
      placed: [placed({ instanceId: "a#0", stop: 1, x: 0 }), placed({ instanceId: "b#0", stop: 2, x: 12000 })],
      unplaced: [],
      usedLength: 13200,
    };
    expect(validateNest(result)).toEqual([{ level: "info", message: "No issues found." }]);
  });

  it("flags a later stop that blocks an earlier one from the door", () => {
    const result: NestResult = {
      trailer,
      // stop 2 (unloaded later) sits closer to the door than stop 1 — a real blockage.
      placed: [placed({ instanceId: "a#0", stop: 1, x: 1300 }), placed({ instanceId: "b#0", stop: 2, x: 0 })],
      unplaced: [],
      usedLength: 2500,
    };
    const findings = validateNest(result);
    expect(findings.some((f) => f.level === "error" && /blocks/.test(f.message))).toBe(true);
  });

  it("flags an overflowing load", () => {
    const result: NestResult = {
      trailer,
      placed: [placed({ instanceId: "a#0", stop: 1, x: 0 })],
      unplaced: [],
      usedLength: 15000,
    };
    expect(validateNest(result).some((f) => f.level === "error" && /doesn't fit/.test(f.message))).toBe(true);
  });

  it("flags exceeding the trailer weight limit", () => {
    const result: NestResult = {
      trailer,
      placed: [
        placed({ instanceId: "a#0", stop: 1, x: 0, weightKg: 3000 }),
        placed({ instanceId: "b#0", stop: 1, x: 1300, weightKg: 3000 }),
      ],
      unplaced: [],
      usedLength: 2500,
    };
    expect(validateNest(result).some((f) => f.level === "error" && /exceeds/.test(f.message))).toBe(true);
  });

  it("reports unplaced items as errors", () => {
    const result: NestResult = {
      trailer,
      placed: [],
      unplaced: [{ itemId: "big", label: "Crate", count: 2, reason: "wider than the trailer even rotated" }],
      usedLength: 0,
    };
    expect(validateNest(result).some((f) => f.level === "error" && /Crate/.test(f.message))).toBe(true);
  });
});
