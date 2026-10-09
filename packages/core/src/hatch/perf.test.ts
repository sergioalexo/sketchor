/**
 * Why this matters: LibreCAD hangs on dense hatches. This pins the budget the
 * engine must keep on a fixed fixture (the plan's benchmark region: ANSI31 on
 * a 1 m x 1 m area at scale 1), with generous bounds so only a real regression
 * (an accidental quadratic, a lost density guard) trips it.
 */
import { describe, expect, it } from "vitest";
import "../kinds/builtin";
import type { HatchEntity } from "../entities";
import { hatchFill, MAX_SEGMENTS } from "./fillLines";
import "./library";
import { loopFromPoints } from "./loops";

const meter = loopFromPoints([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }]);
const ansi31 = (scale: number): HatchEntity => ({ id: "h", type: "hatch", loops: [meter], paint: { kind: "pattern", name: "ANSI31", scale, angle: 0 }, style: "normal" });

describe("hatch generation budget", () => {
  it("ANSI31 on 1 m2 at scale 1 makes a few hundred strokes, fast", () => {
    const t0 = performance.now();
    const f = hatchFill(ansi31(1));
    const ms = performance.now() - t0;
    expect(f.truncated).toBe(false);
    expect(f.segments.length / 4).toBeGreaterThan(300);
    expect(f.segments.length / 4).toBeLessThan(5000);
    expect(ms).toBeLessThan(500);
  });

  it("500 such hatches stay inside a few seconds of generation", () => {
    const t0 = performance.now();
    let strokes = 0;
    for (let i = 0; i < 500; i++) strokes += hatchFill(ansi31(1)).segments.length / 4;
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(strokes).toBeGreaterThan(150_000);
  });

  it("a hopelessly dense scale is stopped by the density guard instead of hanging", () => {
    const t0 = performance.now();
    const f = hatchFill(ansi31(0.001));
    expect(f.truncated).toBe(true);
    expect(f.segments.length).toBe(0);
    expect(MAX_SEGMENTS).toBe(200_000);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
