import { describe, expect, it } from "vitest";
import { buildModel } from "./buildModel";
import { measureSelection, type Formatters } from "./measure";
import { EDGE_CIRCLE, EDGE_LINE } from "./topology";
import type { OcctMesh, OcctResult } from "./types";

/**
 * The topology recovered here is what makes the viewer clickable the way a
 * CAD user expects: a face, an edge, a vertex. If edge chaining regresses,
 * a hole's rim becomes thirty unrelated slivers and its diameter can't be
 * read; if the circle fit regresses, the rim reports a length but no
 * radius; if face aggregation regresses, an area or a "these two are
 * parallel, 40 mm apart" is silently wrong — and someone cuts to it.
 */

/** A unit cube, tessellated face by face with its own vertices, as OpenCascade does. */
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

/**
 * A cylinder of `sides` facets: top disc (face 0), bottom disc (face 1) and
 * the side (face 2). Each face carries its own vertices, but the rim
 * positions coincide exactly — which is what the welding relies on.
 */
function cylinder(radius: number, height: number, sides = 32): OcctMesh {
  const position: number[] = [];
  const index: number[] = [];
  const brep_faces: OcctMesh["brep_faces"] = [];
  const at = (i: number, z: number): [number, number, number] => [
    radius * Math.cos((i / sides) * Math.PI * 2),
    radius * Math.sin((i / sides) * Math.PI * 2),
    z,
  ];
  const push = (p: [number, number, number]) => {
    position.push(p[0], p[1], p[2]);
    return position.length / 3 - 1;
  };

  // Top disc: centre + rim, fanned.
  let firstTri = 0;
  const topCentre = push([0, 0, height]);
  const topRim = Array.from({ length: sides }, (_, i) => push(at(i, height)));
  for (let i = 0; i < sides; i++) index.push(topCentre, topRim[i], topRim[(i + 1) % sides]);
  brep_faces.push({ first: firstTri, last: index.length / 3 - 1, color: null });

  // Bottom disc, wound the other way.
  firstTri = index.length / 3;
  const botCentre = push([0, 0, 0]);
  const botRim = Array.from({ length: sides }, (_, i) => push(at(i, 0)));
  for (let i = 0; i < sides; i++) index.push(botCentre, botRim[(i + 1) % sides], botRim[i]);
  brep_faces.push({ first: firstTri, last: index.length / 3 - 1, color: null });

  // Side: its own ring of vertices, shared between neighbouring quads so the
  // vertical facet edges are interior to this one face.
  firstTri = index.length / 3;
  const sideTop = Array.from({ length: sides }, (_, i) => push(at(i, height)));
  const sideBot = Array.from({ length: sides }, (_, i) => push(at(i, 0)));
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    index.push(sideBot[i], sideBot[j], sideTop[j]);
    index.push(sideBot[i], sideTop[j], sideTop[i]);
  }
  brep_faces.push({ first: firstTri, last: index.length / 3 - 1, color: null });

  return { name: "Cylinder", brep_faces, attributes: { position: { array: position } }, index: { array: index } };
}

const model = (...meshes: OcctMesh[]) => buildModel({ success: true, meshes } as OcctResult, "t.step", "h", "step");

describe("topology of a cube", () => {
  const m = model(cube());

  it("finds six planar faces with unit area and outward normals", () => {
    expect(m.faces.area).toHaveLength(6);
    for (let f = 0; f < 6; f++) {
      expect(m.faces.area[f]).toBeCloseTo(1, 6);
      expect(m.faces.planar[f]).toBe(1);
      expect(m.faces.perimeter[f]).toBeCloseTo(4, 6);
      expect(Math.hypot(m.faces.normal[f * 3], m.faces.normal[f * 3 + 1], m.faces.normal[f * 3 + 2])).toBeCloseTo(1, 6);
    }
    expect(m.parts[0].area).toBeCloseTo(6, 6);
    expect(m.parts[0].volume).toBeCloseTo(1, 6);
  });

  it("finds twelve straight edges of length 1 and eight vertices", () => {
    expect(m.edgeTable.length).toHaveLength(12);
    for (let e = 0; e < 12; e++) {
      expect(m.edgeTable.length[e]).toBeCloseTo(1, 6);
      expect(m.edgeTable.kind[e]).toBe(EDGE_LINE);
      // Each cube edge is where two different faces meet.
      expect(m.edgeTable.faceA[e]).not.toBe(m.edgeTable.faceB[e]);
    }
    expect(m.nodes.xyz).toHaveLength(8 * 3);
  });

  it("maps every triangle to its face, and every edge segment to its edge", () => {
    expect(m.faceOfTriangle).toHaveLength(12);
    expect([...new Set(m.faceOfTriangle)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(m.edgeOfSegment).toHaveLength(12);
    expect([...new Set(m.edgeOfSegment)]).toHaveLength(12);
  });

  it("keeps a second part's topology in its own ranges", () => {
    const two = model(cube(), cube(5));
    const p = two.parts[1];
    expect(p.faceCount).toBe(6);
    expect(p.edgeRefCount).toBe(12);
    expect(p.nodeCount).toBe(8);
    expect(two.faces.part[p.faceStart]).toBe(1);
    // The second part's edges point at the second part's faces, not the first's.
    expect(two.edgeTable.faceA[p.edgeRefStart]).toBeGreaterThanOrEqual(p.faceStart);
  });
});

describe("topology of a cylinder", () => {
  const r = 5;
  const h = 10;
  const sides = 48;
  const m = model(cylinder(r, h, sides));

  it("chains each rim into one circular edge with the right radius", () => {
    expect(m.edgeTable.length).toHaveLength(2);
    for (let e = 0; e < 2; e++) {
      expect(m.edgeTable.kind[e]).toBe(EDGE_CIRCLE);
      expect(m.edgeTable.radius[e]).toBeCloseTo(r, 4);
      expect(m.edgeTable.segCount[e]).toBe(sides);
      // A tessellated circle is a hair shorter than the true one.
      expect(m.edgeTable.length[e]).toBeLessThan(2 * Math.PI * r);
      expect(m.edgeTable.length[e]).toBeGreaterThan(2 * Math.PI * r * 0.99);
    }
    // The rim centres sit on the axis, one at each end.
    const zs = [0, 1].map((e) => m.edgeTable.center[e * 3 + 2]).sort((a, b) => a - b);
    expect(zs[0]).toBeCloseTo(0, 6);
    expect(zs[1]).toBeCloseTo(h, 6);
  });

  it("marks the discs planar and the side not, and gets the volume right", () => {
    expect(m.faces.planar[0]).toBe(1);
    expect(m.faces.planar[1]).toBe(1);
    expect(m.faces.planar[2]).toBe(0);
    expect(m.faces.area[0]).toBeCloseTo(Math.PI * r * r, 0);
    expect(m.parts[0].volume).toBeCloseTo(Math.PI * r * r * h, -1);
  });
});

/* ------------------------------ measurements ------------------------------ */

const fmt: Formatters = {
  length: (v) => `${Math.round(v * 1000) / 1000}mm`,
  area: (v) => `${Math.round(v * 1000) / 1000}mm²`,
  volume: (v) => `${Math.round(v * 1000) / 1000}mm³`,
};
const rowValue = (m: { rows: { label: string; value: string }[] }, label: string) => m.rows.find((r) => r.label === label)?.value;

describe("measureSelection", () => {
  const m = model(cube());

  it("an edge reports its length; a circle reports diameter and radius", () => {
    const edge = measureSelection(m, [{ kind: "edge", index: 0 }], fmt);
    expect(rowValue(edge, "Length")).toBe("1mm");
    const cyl = model(cylinder(5, 10, 48));
    const rim = measureSelection(cyl, [{ kind: "edge", index: 0 }], fmt);
    expect(rowValue(rim, "Diameter")).toBe("10mm");
    expect(rowValue(rim, "Radius")).toBe("5mm");
  });

  it("a face reports area and perimeter; a vertex reports its coordinates", () => {
    const face = measureSelection(m, [{ kind: "face", index: 0 }], fmt);
    expect(rowValue(face, "Area")).toBe("1mm²");
    expect(rowValue(face, "Perimeter")).toBe("4mm");
    const v = measureSelection(m, [{ kind: "vertex", index: 0 }], fmt);
    expect(v.rows.map((r) => r.label)).toEqual(["X", "Y", "Z"]);
  });

  it("draws the span it measured: a straight edge measures itself", () => {
    const edge = measureSelection(m, [{ kind: "edge", index: 0 }], fmt);
    expect(edge.segment).not.toBeNull();
    const span = Math.hypot(
      edge.segment!.to[0] - edge.segment!.from[0],
      edge.segment!.to[1] - edge.segment!.from[1],
      edge.segment!.to[2] - edge.segment!.from[2],
    );
    expect(span).toBeCloseTo(1, 9);
    // A circle's span is its radius — centre out to the rim.
    const cyl = model(cylinder(5, 10, 48));
    const rim = measureSelection(cyl, [{ kind: "edge", index: 0 }], fmt);
    const radius = Math.hypot(
      rim.segment!.to[0] - rim.segment!.from[0],
      rim.segment!.to[1] - rim.segment!.from[1],
      rim.segment!.to[2] - rim.segment!.from[2],
    );
    expect(radius).toBeCloseTo(5, 6);
  });

  it("has nothing to draw for measurements that aren't a distance", () => {
    expect(measureSelection(m, [{ kind: "face", index: 0 }], fmt).segment).toBeNull();
    expect(measureSelection(m, [{ kind: "vertex", index: 0 }], fmt).segment).toBeNull();
    expect(measureSelection(m, [{ kind: "part", index: 0 }], fmt).segment).toBeNull();
    // Two faces at an angle: there is an angle to report but no span.
    expect(measureSelection(m, [{ kind: "face", index: 0 }, { kind: "face", index: 2 }], fmt).segment).toBeNull();
  });

  it("measures a point to a plane along the normal, and says where it landed", () => {
    // Corner (0,0,0) against the top face (+Z at z = 1).
    const lo = [...Array(8).keys()].find((i) => m.nodes.xyz[i * 3] === 0 && m.nodes.xyz[i * 3 + 1] === 0 && m.nodes.xyz[i * 3 + 2] === 0)!;
    const measured = measureSelection(m, [{ kind: "vertex", index: lo }, { kind: "face", index: 0 }], fmt);
    expect(rowValue(measured, "Distance to plane")).toBe("1mm");
    const seg = measured.segment!;
    // Straight up the Z axis: the foot of the perpendicular, not a corner
    // of the face — which is what makes the drawn line believable.
    expect(seg.from).toEqual([0, 0, 0]);
    expect(seg.to[0]).toBeCloseTo(0, 9);
    expect(seg.to[1]).toBeCloseTo(0, 9);
    expect(seg.to[2]).toBeCloseTo(1, 9);
    expect(rowValue(measured, "ΔX ΔY ΔZ")).toBe("0mm, 0mm, 1mm");
  });

  it("the deltas always describe the same two points the line is drawn between", () => {
    const pts = Array.from({ length: 8 }, (_, i) => [m.nodes.xyz[i * 3], m.nodes.xyz[i * 3 + 1], m.nodes.xyz[i * 3 + 2]]);
    const lo = pts.findIndex((p) => p.every((c) => c === 0));
    const hi = pts.findIndex((p) => p.every((c) => c === 1));
    const measured = measureSelection(m, [{ kind: "vertex", index: lo }, { kind: "vertex", index: hi }], fmt);
    const seg = measured.segment!;
    const delta = rowValue(measured, "ΔX ΔY ΔZ");
    expect(delta).toBe(
      [0, 1, 2].map((k) => fmt.length(seg.to[k] - seg.from[k])).join(", "),
    );
  });

  it("two vertices give the distance and the axis deltas", () => {
    // The cube's eight corners: find the two that are a full diagonal apart.
    const pts = Array.from({ length: 8 }, (_, i) => [m.nodes.xyz[i * 3], m.nodes.xyz[i * 3 + 1], m.nodes.xyz[i * 3 + 2]]);
    const lo = pts.findIndex((p) => p.every((c) => c === 0));
    const hi = pts.findIndex((p) => p.every((c) => c === 1));
    const rows = measureSelection(m, [{ kind: "vertex", index: lo }, { kind: "vertex", index: hi }], fmt);
    expect(rowValue(rows, "Distance")).toBe(`${Math.round(Math.sqrt(3) * 1000) / 1000}mm`);
    expect(rowValue(rows, "ΔX ΔY ΔZ")).toBe("1mm, 1mm, 1mm");
  });

  it("two parallel planes give the distance between them, two others the angle", () => {
    // Faces 0 and 1 of the fixture are +Z and −Z: parallel, one unit apart.
    const parallel = measureSelection(m, [{ kind: "face", index: 0 }, { kind: "face", index: 1 }], fmt);
    expect(rowValue(parallel, "Distance")).toBe("1mm");
    const perpendicular = measureSelection(m, [{ kind: "face", index: 0 }, { kind: "face", index: 2 }], fmt);
    expect(rowValue(perpendicular, "Angle")).toBe("90°");
    expect(rowValue(perpendicular, "Total area")).toBe("2mm²");
  });

  it("two edges give the angle between them and their shortest distance", () => {
    // Two edges of the top face meet at a corner: 90°, distance 0.
    const top = [...m.edgeTable.length.keys()].filter((e) => {
      const az = m.edgeTable.a[e * 3 + 2];
      const bz = m.edgeTable.b[e * 3 + 2];
      return Math.abs(az - 1) < 1e-6 && Math.abs(bz - 1) < 1e-6;
    });
    expect(top.length).toBeGreaterThanOrEqual(2);
    const rows = measureSelection(m, [{ kind: "edge", index: top[0] }, { kind: "edge", index: top[1] }], fmt);
    expect(rowValue(rows, "Angle")).toMatch(/^(0|90)°$/);
    expect(rowValue(rows, "Distance")).toBe("0mm");
  });

  it("a vertex and a plane give the distance to the plane", () => {
    const top = [...m.faces.area.keys()].find((f) => Math.abs(m.faces.centroid[f * 3 + 2] - 1) < 1e-6)!;
    const bottomVertex = [...Array(8).keys()].find((i) => m.nodes.xyz[i * 3 + 2] === 0)!;
    const rows = measureSelection(m, [{ kind: "vertex", index: bottomVertex }, { kind: "face", index: top }], fmt);
    expect(rowValue(rows, "Distance to plane")).toBe("1mm");
  });

  it("a part reports its size, surface area and volume", () => {
    const rows = measureSelection(m, [{ kind: "part", index: 0 }], fmt);
    expect(rowValue(rows, "Size")).toBe("1mm × 1mm × 1mm");
    expect(rowValue(rows, "Surface area")).toBe("6mm²");
    expect(rowValue(rows, "Volume")).toBe("1mm³");
  });
});
