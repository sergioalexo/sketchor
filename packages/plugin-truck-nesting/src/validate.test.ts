import { describe, expect, it } from "vitest";
import { validateNest } from "./validate";
import type { NestResult, PlacedItem } from "./types";

const trailer = { name: "T", length: 13600, width: 2480 };

function placed(over: Partial<PlacedItem> & Pick<PlacedItem, "instanceId" | "orderIndex" | "x" | "city">): PlacedItem {
  const base = {
    orderId: `o${over.orderIndex}`,
    jobNumber: "",
    state: "",
    color: "#000",
    shape: "rect" as const,
    y: 0,
    length: 1200,
    width: 800,
    rotated: false,
    ...over,
  };
  return { ...base, slotX: base.x, slotY: base.y, slotLength: base.length, slotWidth: base.width };
}

describe("validateNest", () => {
  it("passes a clean plan", () => {
    const result: NestResult = {
      trailer,
      placed: [
        placed({ instanceId: "a", orderIndex: 0, city: "Leeds", x: 0 }),
        placed({ instanceId: "b", orderIndex: 1, city: "Hull", x: 1300 }),
      ],
      unplaced: [],
      usedLength: 2500,
    };
    expect(validateNest(result)).toEqual([{ level: "info", message: "No issues — the plan unloads cleanly." }]);
  });

  it("flags a later drop parked between an earlier drop and the door", () => {
    const result: NestResult = {
      trailer,
      placed: [
        placed({ instanceId: "a", orderIndex: 0, city: "Leeds", x: 1300 }),
        placed({ instanceId: "b", orderIndex: 1, city: "Hull", x: 0 }),
      ],
      unplaced: [],
      usedLength: 2500,
    };
    const findings = validateNest(result);
    expect(findings.some((f) => f.level === "error" && /blocks it from the door/.test(f.message))).toBe(true);
  });

  it("flags an overflowing load", () => {
    const result: NestResult = {
      trailer,
      placed: [placed({ instanceId: "a", orderIndex: 0, city: "Leeds", x: 0 })],
      unplaced: [],
      usedLength: 15000,
    };
    expect(validateNest(result).some((f) => f.level === "error" && /doesn't fit/.test(f.message))).toBe(true);
  });

  it("notes the usable floor when a wall clearance is set", () => {
    const result: NestResult = {
      trailer: { ...trailer, wallMargin: 100 },
      placed: [placed({ instanceId: "a", orderIndex: 0, city: "Leeds", x: 100 })],
      unplaced: [],
      usedLength: 1400,
    };
    expect(validateNest(result).some((f) => f.level === "info" && /usable floor/.test(f.message))).toBe(true);
  });

  it("reports unplaced pallets as errors", () => {
    const result: NestResult = {
      trailer,
      placed: [],
      unplaced: [{ orderId: "o0", city: "Leeds", count: 2, reason: "too big for the trailer even turned" }],
      usedLength: 0,
    };
    expect(validateNest(result).some((f) => f.level === "error" && /Leeds/.test(f.message))).toBe(true);
  });
});
