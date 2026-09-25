import { describe, expect, it } from "vitest";
import type { Entity } from "@sketchor/core";
import { buildCutPlan, type GcodePlacement } from "./toolpath";

/**
 * A cut plan drives an actual laser: cutting a part's outer profile before
 * its holes lets the part fall free before the holes are done, and cutting
 * a container's hole before a part nested inside it lets that whole disc
 * come loose (and shift) before the nested part is finished. Both are real
 * scrapped-part failure modes, not cosmetic — these pin the ordering rules
 * that prevent them, plus the kerf/lead-in geometry every feature carries.
 */

function line(id: string, a: { x: number; y: number }, b: { x: number; y: number }): Entity {
  return { id, type: "line", a, b };
}

function rectLines(prefix: string, x: number, y: number, w: number, h: number): Entity[] {
  const p = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  return [0, 1, 2, 3].map((i) => line(`${prefix}${i}`, p[i], p[(i + 1) % 4]));
}

function circle(id: string, cx: number, cy: number, r: number): Entity {
  return { id, type: "circle", center: { x: cx, y: cy }, radius: r };
}

function bboxOf(pts: { x: number; y: number }[]) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function loopPoints(loop: ReturnType<typeof buildCutPlan>["features"][number]["loop"]) {
  const pts: { x: number; y: number }[] = [];
  for (const c of loop) {
    if (c.kind === "segment") pts.push(c.a, c.b);
    else pts.push({ x: c.center.x - c.radius, y: c.center.y }, { x: c.center.x + c.radius, y: c.center.y }, { x: c.center.x, y: c.center.y - c.radius }, { x: c.center.x, y: c.center.y + c.radius });
  }
  return pts;
}

describe("buildCutPlan — ordering", () => {
  it("cuts a part's holes before its outer profile", () => {
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 100, 100),
      holeEntities: [circle("h", 50, 50, 10)],
    };
    const plan = buildCutPlan([placement]);
    expect(plan.warnings).toEqual([]);
    expect(plan.features.map((f) => f.role)).toEqual(["hole", "outer"]);
  });

  it("assembles a boundary drawn as separate line/arc entities via endpoint matching, not just single closed entities", () => {
    // The outer above is 4 separate lines; if they hadn't chained into one
    // closed loop, buildCutPlan would report a warning and skip the part.
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 40, 20),
      holeEntities: [],
    };
    const plan = buildCutPlan([placement]);
    expect(plan.warnings).toEqual([]);
    expect(plan.features).toHaveLength(1);
    expect(plan.features[0].role).toBe("outer");
  });

  it("cuts a part nested in another part's hole (N-12) completely before that hole is opened", () => {
    const container: GcodePlacement = {
      id: "big",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 90, 90),
      holeEntities: [circle("h", 45, 45, 15)],
    };
    const nested: GcodePlacement = {
      id: "small",
      number: 2,
      outerEntities: rectLines("s", 40, 40, 10, 10),
      holeEntities: [],
      insideOfId: "big",
    };
    const plan = buildCutPlan([container, nested]);
    const nestedOuterIdx = plan.features.findIndex((f) => f.placementId === "small" && f.role === "outer");
    const containerHoleIdx = plan.features.findIndex((f) => f.placementId === "big" && f.role === "hole");
    expect(nestedOuterIdx).toBeGreaterThanOrEqual(0);
    expect(containerHoleIdx).toBeGreaterThanOrEqual(0);
    expect(nestedOuterIdx).toBeLessThan(containerHoleIdx);
  });

  it("visits parts nearest-neighbour from the given start point rather than in input order", () => {
    const far: GcodePlacement = { id: "far", number: 1, outerEntities: rectLines("f", 500, 500, 10, 10), holeEntities: [] };
    const near: GcodePlacement = { id: "near", number: 2, outerEntities: rectLines("n", 0, 0, 10, 10), holeEntities: [] };
    const plan = buildCutPlan([far, near], { start: { x: 0, y: 0 } });
    expect(plan.features[0].placementId).toBe("near");
    expect(plan.features[1].placementId).toBe("far");
  });

  it("reports and skips a part whose outer boundary never closes, instead of throwing", () => {
    const openChain: GcodePlacement = {
      id: "broken",
      number: 1,
      outerEntities: [line("a", { x: 0, y: 0 }, { x: 10, y: 0 }), line("b", { x: 20, y: 0 }, { x: 20, y: 10 })], // gap between them
      holeEntities: [],
    };
    const plan = buildCutPlan([openChain]);
    expect(plan.features).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});

describe("buildCutPlan — kerf compensation", () => {
  it("expands the outer profile outward and shrinks a hole inward by half the kerf", () => {
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 100, 100),
      holeEntities: [circle("h", 50, 50, 10)],
    };
    const uncompensated = buildCutPlan([placement], { kerf: 0 });
    const compensated = buildCutPlan([placement], { kerf: 2 }); // kerf/2 = 1mm each way

    const outerBefore = bboxOf(loopPoints(uncompensated.features.find((f) => f.role === "outer")!.loop));
    const outerAfter = bboxOf(loopPoints(compensated.features.find((f) => f.role === "outer")!.loop));
    expect(outerAfter.minX).toBeCloseTo(outerBefore.minX - 1, 3);
    expect(outerAfter.maxX).toBeCloseTo(outerBefore.maxX + 1, 3);
    expect(outerAfter.minY).toBeCloseTo(outerBefore.minY - 1, 3);
    expect(outerAfter.maxY).toBeCloseTo(outerBefore.maxY + 1, 3);

    const holeBefore = bboxOf(loopPoints(uncompensated.features.find((f) => f.role === "hole")!.loop));
    const holeAfter = bboxOf(loopPoints(compensated.features.find((f) => f.role === "hole")!.loop));
    expect(holeAfter.maxX - holeAfter.minX).toBeCloseTo(holeBefore.maxX - holeBefore.minX - 2, 3);
  });
});

describe("buildCutPlan — lead-in", () => {
  it("pierces off the true edge and cuts a lead-in onto it, on the longest straight edge", () => {
    // A long, thin rectangle: the pierce/lead-in should sit on one of the
    // two long edges (y = 0 or y = 10), not a short end.
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 100, 10),
      holeEntities: [],
    };
    const plan = buildCutPlan([placement], { leadInLength: 5 });
    const feature = plan.features[0];
    expect(feature.leadIn.y === 0 || feature.leadIn.y === 10).toBe(true);
    // The pierce point is off the part, further from the sheet's own
    // interior than the point it leads into.
    const pierceOutside = feature.pierce.y < 0 || feature.pierce.y > 10;
    expect(pierceOutside).toBe(true);
    expect(Math.hypot(feature.pierce.x - feature.leadIn.x, feature.pierce.y - feature.leadIn.y)).toBeCloseTo(5, 6);
  });

  it("pierces into the open interior (not into surrounding material) for a circular hole with no straight edge", () => {
    const placement: GcodePlacement = {
      id: "p0",
      number: 1,
      outerEntities: rectLines("o", 0, 0, 100, 100),
      holeEntities: [circle("h", 50, 50, 10)],
    };
    const plan = buildCutPlan([placement], { leadInLength: 2 });
    const hole = plan.features.find((f) => f.role === "hole")!;
    const distFromCenter = Math.hypot(hole.pierce.x - 50, hole.pierce.y - 50);
    // Pierces inward (toward the hole's own centre), i.e. within the circle,
    // never out into the surrounding solid part.
    expect(distFromCenter).toBeLessThan(10);
  });
});
