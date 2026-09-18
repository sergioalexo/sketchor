import { describe, expect, it } from "vitest";
import { buildModel } from "./buildModel";
import { measureBetween, snapToEdges } from "./measure3d";
import type { OcctMesh } from "./types";

/**
 * The 3D measure tool reports a number someone will cut metal to. If snapping
 * regresses, a tap near a corner measures a random face point a few
 * millimetres off — and nothing on screen says so. These tests pin the snap
 * priority (vertex over edge over face), the tolerance, and that only the
 * hit part's edges are consulted.
 */

/** A unit cube tessellated per face, as occt-import-js does it. */
function cube(offset = 0): OcctMesh {
  const faces: number[][][] = [
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  ];
  const position: number[] = [];
  const index: number[] = [];
  const brep_faces: OcctMesh["brep_faces"] = [];
  faces.forEach((quad, f) => {
    const base = f * 4;
    for (const [x, y, z] of quad) position.push(x + offset, y, z);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    brep_faces.push({ first: f * 2, last: f * 2 + 1, color: null });
  });
  return { name: "Cube", brep_faces, attributes: { position: { array: position } }, index: { array: index } };
}

const model = buildModel({ success: true, meshes: [cube(0), cube(5)] }, "two-cubes.step", "hash", "step");

describe("snapToEdges", () => {
  it("snaps a near-corner face hit to the vertex", () => {
    const r = snapToEdges(model, 0, [0.03, 0.04, 1], 0.1);
    expect(r.snap).toBe("vertex");
    expect(r.point).toEqual([0, 0, 1]);
  });

  it("snaps a hit along an edge, away from its ends, onto the edge", () => {
    // On the top face, 0.02 in from the y=0 edge, half-way along it.
    const r = snapToEdges(model, 0, [0.5, 0.02, 1], 0.1);
    expect(r.snap).toBe("edge");
    expect(r.point[0]).toBeCloseTo(0.5, 6);
    expect(r.point[1]).toBeCloseTo(0, 6);
    expect(r.point[2]).toBeCloseTo(1, 6);
  });

  it("keeps a face hit that is farther than the tolerance from any edge", () => {
    const r = snapToEdges(model, 0, [0.5, 0.5, 1], 0.1);
    expect(r.snap).toBe("face");
    expect(r.point).toEqual([0.5, 0.5, 1]);
  });

  it("prefers a vertex to a closer edge point", () => {
    // 0.05 from the corner vertex along the edge, 0.01 off the edge: the edge
    // is nearer, but the corner is inside tolerance and wins.
    const r = snapToEdges(model, 0, [0.05, 0.01, 1], 0.1);
    expect(r.snap).toBe("vertex");
    expect(r.point).toEqual([0, 0, 1]);
  });

  it("only looks at the hit part's edges", () => {
    // Part 1 is the cube at x=5..6. A hit near part 0's corner, attributed
    // to part 1, must not snap to part 0's geometry.
    const r = snapToEdges(model, 1, [0.03, 0.04, 1], 0.1);
    expect(r.snap).toBe("face");
  });

  it("returns the raw hit for a bad part index or zero tolerance", () => {
    expect(snapToEdges(model, 99, [1, 2, 3], 0.1)).toEqual({ point: [1, 2, 3], snap: "face", part: 99 });
    expect(snapToEdges(model, 0, [0.01, 0.01, 1], 0).snap).toBe("face");
  });
});

describe("measureBetween", () => {
  it("reports the distance and signed axis deltas", () => {
    const m = measureBetween([1, 2, 3], [4, 6, 3]);
    expect(m.distance).toBeCloseTo(5, 9);
    expect(m.dx).toBe(3);
    expect(m.dy).toBe(4);
    expect(m.dz).toBe(0);
  });
});
