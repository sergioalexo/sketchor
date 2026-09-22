import { describe, expect, it } from "vitest";
import { acquirePoint, trackAlignment, trackingAngles } from "./objectTracking";

/**
 * Object snap tracking is the difference between "roughly above that
 * corner" and exactly above it. If the projection is wrong the drawing is
 * quietly out of alignment by a pixel's worth of world units — the kind of
 * error that survives to the cutting machine — and if the two-point
 * intersection misfires, the cursor jumps somewhere the user never aimed,
 * which is worse than no tracking at all. Both are pinned here, along with
 * the guard rails that stop a guide firing when nothing really lines up.
 */

const corner = { x: 100, y: 100 };
const other = { x: 300, y: 40 };
const ortho = trackingAngles(90);

describe("trackAlignment", () => {
  it("pulls the cursor onto a vertical alignment and says where the guide starts", () => {
    const hit = trackAlignment({ x: 102, y: 250 }, [corner], ortho, 5);
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(100, 9);
    expect(hit!.point.y).toBeCloseTo(250, 9);
    expect(hit!.rays).toHaveLength(1);
    expect(hit!.rays[0].from).toEqual(corner);
  });

  it("tracks backwards through the point as readily as forwards", () => {
    const hit = trackAlignment({ x: 98, y: -400 }, [corner], ortho, 5);
    expect(hit!.point.x).toBeCloseTo(100, 9);
    expect(hit!.point.y).toBeCloseTo(-400, 9);
  });

  it("stays out of the way when nothing lines up", () => {
    expect(trackAlignment({ x: 140, y: 250 }, [corner], ortho, 5)).toBeNull();
  });

  it("ignores the acquired point itself — that is the snap's job", () => {
    expect(trackAlignment({ x: 101, y: 101 }, [corner], ortho, 5)).toBeNull();
  });

  it("takes the crossing of two alignments over either one alone", () => {
    // Vertically above `corner`, horizontally level with `other`.
    const hit = trackAlignment({ x: 103, y: 38 }, [corner, other], ortho, 5);
    expect(hit!.rays).toHaveLength(2);
    expect(hit!.point.x).toBeCloseTo(100, 9);
    expect(hit!.point.y).toBeCloseTo(40, 9);
    expect(hit!.rays.map((r) => r.from)).toEqual(expect.arrayContaining([corner, other]));
  });

  it("won't cross two alignments that are nearly parallel", () => {
    // Both points offer the same vertical; their "intersection" is meaningless.
    const twin = { x: 100.5, y: -200 };
    const hit = trackAlignment({ x: 101, y: 400 }, [corner, twin], ortho, 5);
    expect(hit!.rays).toHaveLength(1);
  });

  it("follows polar increments when asked, not just the four ortho rays", () => {
    const at45 = trackAlignment({ x: 200, y: 201 }, [corner], trackingAngles(45), 5);
    expect(at45!.rays[0].angleDeg).toBe(45);
    expect(at45!.point.x).toBeCloseTo(200.5, 6);
    expect(at45!.point.y).toBeCloseTo(200.5, 6);
    // The same cursor has no ortho alignment at all.
    expect(trackAlignment({ x: 200, y: 201 }, [corner], ortho, 5)).toBeNull();
  });

  it("prefers the alignment the cursor is closest to", () => {
    // Two verticals in the aperture: the cursor is 1 off one and 5 off the
    // other. They are parallel, so there is no crossing to prefer instead.
    const near = { x: 100, y: 0 };
    const far = { x: 96, y: 0 };
    const hit = trackAlignment({ x: 101, y: 300 }, [far, near], ortho, 6);
    expect(hit!.rays).toHaveLength(1);
    expect(hit!.rays[0].from).toEqual(near);
    expect(hit!.point.x).toBeCloseTo(100, 9);
  });

  it("returns nothing rather than guessing when it has nothing to work from", () => {
    expect(trackAlignment({ x: 0, y: 0 }, [], ortho, 5)).toBeNull();
    expect(trackAlignment({ x: 0, y: 0 }, [corner], [], 5)).toBeNull();
    expect(trackAlignment({ x: 0, y: 0 }, [corner], ortho, 0)).toBeNull();
  });
});

describe("trackingAngles", () => {
  it("is the four ortho rays by default", () => {
    expect(trackingAngles(null)).toEqual([0, 90, 180, 270]);
  });

  it("walks the whole circle at the polar step", () => {
    expect(trackingAngles(45)).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
    expect(trackingAngles(30)).toHaveLength(12);
  });
});

describe("acquirePoint", () => {
  it("keeps the newest first and caps the list", () => {
    let acquired: { x: number; y: number }[] = [];
    for (const x of [1, 2, 3, 4]) acquired = acquirePoint(acquired, { x, y: 0 }, 3);
    expect(acquired.map((p) => p.x)).toEqual([4, 3, 2]);
  });

  it("re-acquiring a point promotes it instead of duplicating it", () => {
    // The cursor rests on a point across many move events; that must not
    // flush everything else out of the list.
    let acquired = [{ x: 1, y: 0 }, { x: 2, y: 0 }];
    for (let i = 0; i < 5; i++) acquired = acquirePoint(acquired, { x: 2, y: 0 }, 3);
    expect(acquired).toEqual([{ x: 2, y: 0 }, { x: 1, y: 0 }]);
  });
});
