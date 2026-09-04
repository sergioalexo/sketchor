import { describe, expect, it } from "vitest";
import {
  centroidOfEntities,
  entityPoints,
  imageCorners,
  layerOf,
  newEntityId,
  polylineLength,
  polylineSegments,
  rotated,
  transformed,
  translated,
} from "./entities";
import type { ArcEntity, CircleEntity, ImageEntity, LineEntity, PointEntity, PolylineEntity } from "./entities";

/**
 * The geometric primitives every tool and command builds on. Two invariants
 * get most of the attention here because they are silent when wrong: rigid
 * transforms must carry an entity's non-geometric fields (id, name, layer,
 * colour, fill) through untouched, and a polyline's per-segment `bulges` must
 * survive rotation and uniform scale — bulge encodes an *angle*, not a
 * distance, so neither operation may alter it.
 */

const HALF_PI = Math.PI / 2;

const line = (): LineEntity => ({
  id: "L",
  type: "line",
  name: "L1",
  layer: "walls",
  color: "#ff0000",
  fill: "#00ff00",
  a: { x: 1, y: 0 },
  b: { x: 3, y: 4 },
});
const circle = (): CircleEntity => ({ id: "C", type: "circle", layer: "holes", center: { x: 2, y: 2 }, radius: 5 });
const arc = (): ArcEntity => ({
  id: "A",
  type: "arc",
  center: { x: 0, y: 0 },
  radius: 4,
  startAngle: 0,
  endAngle: HALF_PI,
  ccw: true,
});
const point = (): PointEntity => ({ id: "P", type: "point", p: { x: 7, y: -2 } });
const polyline = (): PolylineEntity => ({
  id: "PL",
  type: "polyline",
  name: "PL1",
  layer: "outline",
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ],
  bulges: [0, 0.5, -0.25],
  closed: true,
});

const image = (): ImageEntity => ({
  id: "IMG",
  type: "image",
  name: "IMG1",
  layer: "photos",
  color: "#ff0000",
  fill: "#00ff00",
  insert: { x: 1, y: 0 },
  width: 20,
  height: 10,
  rotation: 0,
  dataUrl: "data:image/png;base64,AAA=",
});

const all = () => [line(), circle(), arc(), point(), polyline(), image()];

const closeTo = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 10);
  expect(p.y).toBeCloseTo(y, 10);
};

describe("layerOf", () => {
  it("defaults to the DXF layer 0", () => {
    expect(layerOf(point())).toBe("0");
    expect(layerOf(circle())).toBe("holes");
  });
});

describe("translated", () => {
  it("shifts every entity type by the same delta", () => {
    closeTo(translated(line(), 5, -1).a, 6, -1);
    closeTo(translated(line(), 5, -1).b, 8, 3);
    closeTo(translated(circle(), 5, -1).center, 7, 1);
    closeTo(translated(arc(), 5, -1).center, 5, -1);
    closeTo(translated(point(), 5, -1).p, 12, -3);
    closeTo(translated(polyline(), 5, -1).points[1], 15, -1);
    closeTo(translated(image(), 5, -1).insert, 6, -1);
  });

  it("leaves size and angles alone", () => {
    expect(translated(circle(), 5, -1).radius).toBe(5);
    const moved = translated(arc(), 5, -1);
    expect(moved.radius).toBe(4);
    expect(moved.startAngle).toBe(0);
    expect(moved.endAngle).toBe(HALF_PI);
  });

  it("carries id, name, layer, colour and fill through", () => {
    for (const e of all()) {
      const moved = translated(e, 3, 3);
      expect(moved.id).toBe(e.id);
      expect(moved.name).toBe(e.name);
      expect(moved.layer).toBe(e.layer);
      expect(moved.color).toBe(e.color);
      expect(moved.fill).toBe(e.fill);
      expect(moved.type).toBe(e.type);
    }
  });
});

describe("rotated", () => {
  it("rotates points about the pivot", () => {
    const pivot = { x: 0, y: 0 };
    closeTo(rotated(point(), pivot, HALF_PI).p, 2, 7);
    closeTo(rotated(polyline(), pivot, HALF_PI).points[1], 0, 10);
  });

  it("rotates an arc's angles but not its radius", () => {
    const spun = rotated(arc(), { x: 0, y: 0 }, HALF_PI);
    expect(spun.radius).toBe(4);
    expect(spun.startAngle).toBeCloseTo(HALF_PI, 10);
    expect(spun.endAngle).toBeCloseTo(Math.PI, 10);
    expect(spun.ccw).toBe(true);
  });

  it("rotates about a non-origin pivot", () => {
    closeTo(rotated(point(), { x: 7, y: 0 }, Math.PI).p, 7, 2);
  });

  it("rotates an image's insertion point and adds to its rotation", () => {
    const spun = rotated(image(), { x: 0, y: 0 }, HALF_PI);
    closeTo(spun.insert, 0, 1);
    expect(spun.rotation).toBeCloseTo(HALF_PI, 10);
    expect(spun.width).toBe(20);
    expect(spun.height).toBe(10);
  });

  it("leaves a polyline's bulges untouched (bulge is an angle, not a position)", () => {
    expect(rotated(polyline(), { x: 3, y: 3 }, 0.7).bulges).toEqual([0, 0.5, -0.25]);
  });

  it("carries id, name, layer, colour and fill through", () => {
    for (const e of all()) {
      const spun = rotated(e, { x: 1, y: 1 }, 0.3);
      expect(spun.id).toBe(e.id);
      expect(spun.name).toBe(e.name);
      expect(spun.layer).toBe(e.layer);
      expect(spun.color).toBe(e.color);
      expect(spun.fill).toBe(e.fill);
    }
  });
});

describe("transformed", () => {
  const origin = { x: 0, y: 0 };

  it("applies scale, then rotation, then translation", () => {
    // (1, 0) -> scale 2 -> (2, 0) -> rotate 90 -> (0, 2) -> translate -> (10, 2).
    const p: PointEntity = { id: "P", type: "point", p: { x: 1, y: 0 } };
    closeTo(transformed(p, origin, 10, 0, HALF_PI, 2).p, 10, 2);
  });

  it("scales radius and rotates angles for arcs and circles", () => {
    const c = transformed(circle(), origin, 0, 0, 0, 3);
    expect(c.radius).toBe(15);
    closeTo(c.center, 6, 6);

    const a = transformed(arc(), origin, 0, 0, HALF_PI, 2);
    expect(a.radius).toBe(8);
    expect(a.startAngle).toBeCloseTo(HALF_PI, 10);
    expect(a.endAngle).toBeCloseTo(Math.PI, 10);
  });

  it("scales about the pivot, not the origin", () => {
    const p: PointEntity = { id: "P", type: "point", p: { x: 4, y: 0 } };
    closeTo(transformed(p, { x: 2, y: 0 }, 0, 0, 0, 3).p, 8, 0);
  });

  it("scales an image's width and height along with its insertion point", () => {
    const scaled = transformed(image(), origin, 0, 0, 0, 3);
    expect(scaled.width).toBe(60);
    expect(scaled.height).toBe(30);
    closeTo(scaled.insert, 3, 0);
  });

  it("is the identity for scale 1, rotation 0 and no offset", () => {
    for (const e of all()) {
      expect(transformed(e, { x: 3, y: -2 }, 0, 0, 0, 1)).toEqual(e);
    }
  });

  it("leaves a polyline's bulges untouched under uniform scale", () => {
    expect(transformed(polyline(), origin, 1, 1, 0.4, 2.5).bulges).toEqual([0, 0.5, -0.25]);
  });
});

describe("imageCorners", () => {
  it("returns the four corners of the un-rotated rectangle", () => {
    const c = imageCorners({ ...image(), rotation: 0 });
    expect(c).toEqual([
      { x: 1, y: 0 },
      { x: 21, y: 0 },
      { x: 21, y: 10 },
      { x: 1, y: 10 },
    ]);
  });

  it("rotates the corners about the insertion point", () => {
    const c = imageCorners({ ...image(), insert: { x: 0, y: 0 }, rotation: HALF_PI });
    closeTo(c[0], 0, 0); // insert itself is the pivot — stays put
    closeTo(c[1], 0, 20); // (width, 0) rotates 90° CCW to (0, width)
  });
});

describe("polylineSegments", () => {
  const open = (): PolylineEntity => ({ ...polyline(), closed: false });

  it("emits one segment per gap when open and one more when closed", () => {
    expect(polylineSegments(open())).toHaveLength(2);
    expect(polylineSegments(polyline())).toHaveLength(3);
  });

  it("wraps the closing segment back to the first point", () => {
    const last = polylineSegments(polyline())[2];
    expect(last.a).toEqual({ x: 10, y: 10 });
    expect(last.b).toEqual({ x: 0, y: 0 });
  });

  it("aligns bulges[i] with the segment leaving points[i]", () => {
    expect(polylineSegments(polyline()).map((s) => s.bulge)).toEqual([0, 0.5, -0.25]);
  });

  it("treats a missing bulges array as all-straight", () => {
    const plain: PolylineEntity = { id: "PL", type: "polyline", points: polyline().points, closed: false };
    expect(polylineSegments(plain).map((s) => s.bulge)).toEqual([0, 0]);
  });

  it("emits nothing for a single-point open polyline", () => {
    const one: PolylineEntity = { id: "PL", type: "polyline", points: [{ x: 0, y: 0 }], closed: false };
    expect(polylineSegments(one)).toEqual([]);
  });
});

describe("polylineLength", () => {
  it("sums chord lengths when every segment is straight", () => {
    const l: PolylineEntity = {
      id: "PL",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 3, y: 14 },
      ],
      closed: false,
    };
    expect(polylineLength(l)).toBeCloseTo(15, 10);
  });

  it("counts a bulged segment's arc length, not its chord", () => {
    // bulge 1 is a half turn: chord 10 -> radius 5 -> length pi*5, not 10.
    const semi: PolylineEntity = {
      id: "PL",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      bulges: [1],
      closed: false,
    };
    expect(polylineLength(semi)).toBeCloseTo(Math.PI * 5, 10);
  });

  it("includes the closing segment when closed", () => {
    const square: PolylineEntity = {
      id: "PL",
      type: "polyline",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      closed: true,
    };
    expect(polylineLength(square)).toBeCloseTo(40, 10);
    expect(polylineLength({ ...square, closed: false })).toBeCloseTo(30, 10);
  });
});

describe("entityPoints", () => {
  it("gives a circle its four quadrant points", () => {
    expect(entityPoints(circle())).toEqual([
      { x: 7, y: 2 },
      { x: -3, y: 2 },
      { x: 2, y: 7 },
      { x: 2, y: -3 },
    ]);
  });

  it("gives an arc its two endpoints", () => {
    const [start, end] = entityPoints(arc());
    closeTo(start, 4, 0);
    closeTo(end, 0, 4);
  });

  it("gives a line its ends and a polyline its vertices", () => {
    expect(entityPoints(line())).toEqual([{ x: 1, y: 0 }, { x: 3, y: 4 }]);
    expect(entityPoints(polyline())).toEqual(polyline().points);
  });
});

describe("centroidOfEntities", () => {
  it("averages every defining point", () => {
    const a: PointEntity = { id: "a", type: "point", p: { x: 0, y: 0 } };
    const b: PointEntity = { id: "b", type: "point", p: { x: 4, y: 8 } };
    expect(centroidOfEntities([a, b])).toEqual({ x: 2, y: 4 });
  });

  it("falls back to the origin for an empty selection", () => {
    expect(centroidOfEntities([])).toEqual({ x: 0, y: 0 });
  });
});

describe("newEntityId", () => {
  it("never repeats, even when called in the same millisecond", () => {
    const ids = Array.from({ length: 500 }, () => newEntityId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
