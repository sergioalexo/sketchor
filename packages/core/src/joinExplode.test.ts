import { describe, expect, it } from "vitest";
import { CommandBus } from "./commands";
import { SketchDocument } from "./document";
import type { ArcEntity, Entity, LineEntity, PolylineEntity } from "./entities";
import { polylineSegments } from "./entities";
import { bulgeToArc, dist } from "./geometry";
import { explodeCommands, explodePolyline, joinCommands, joinEntities, pointsAlong } from "./joinExplode";

/**
 * Join turns a DXF's loose lines and arcs into the one closed contour a
 * cutter, an offset or a fillet-all-corners needs; explode is how you get
 * back to editing a single edge. A chain joined in the wrong order or an
 * arc leg with a flipped bulge gives a contour that looks right and cuts
 * wrong.
 */

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ id, type: "line", a: { x: ax, y: ay }, b: { x: bx, y: by } });

describe("joinEntities", () => {
  it("chains lines end to end, whichever way round they were drawn, into one closed polyline", () => {
    const es: Entity[] = [line("a", 0, 0, 10, 0), line("b", 10, 10, 10, 0), line("c", 10, 10, 0, 10), line("d", 0, 0, 0, 10)];
    const chains = joinEntities(es);
    expect(chains).toHaveLength(1);
    expect(chains[0].replaced.sort()).toEqual(["a", "b", "c", "d"]);
    const pl = chains[0].polyline;
    expect(pl.closed).toBe(true);
    expect(pl.points).toHaveLength(4);
  });

  it("keeps an arc as a bulged leg, with the right side", () => {
    // Line to (10,0), then a semicircle up and back to (0,0)... via (5,5): ccw from (10,0) to (0,0).
    const arc: ArcEntity = { id: "arc", type: "arc", center: { x: 5, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI, ccw: true };
    const chains = joinEntities([line("a", 0, 0, 10, 0), arc]);
    expect(chains).toHaveLength(1);
    const pl = chains[0].polyline;
    expect(pl.closed).toBe(true);
    const arcs = polylineSegments(pl).map((s) => bulgeToArc(s.a, s.b, s.bulge)).filter((a): a is NonNullable<typeof a> => !!a);
    expect(arcs).toHaveLength(1);
    expect(arcs[0].center.x).toBeCloseTo(5, 9);
    expect(arcs[0].center.y).toBeCloseTo(0, 9);
    // The leg passes through (5, 5), above the chord.
    const mid = arcs[0].ccw ? arcs[0].startAngle + Math.PI / 2 : arcs[0].startAngle - Math.PI / 2;
    expect(arcs[0].center.y + arcs[0].radius * Math.sin(mid)).toBeCloseTo(5, 9);
  });

  it("leaves unconnected entities and closed polylines alone", () => {
    const closed: PolylineEntity = { id: "p", type: "polyline", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true };
    expect(joinEntities([line("a", 0, 0, 10, 0), line("b", 20, 0, 30, 0), closed])).toHaveLength(0);
  });

  it("joinCommands replaces the chain in one batch that undoes cleanly", () => {
    const d = new SketchDocument();
    const es = [line("a", 0, 0, 10, 0), line("b", 10, 0, 10, 10), line("z", 50, 50, 60, 60)];
    for (const e of es) d._put(e);
    const bus = new CommandBus(d);
    const commands = joinCommands(d.all());
    expect(commands.length).toBeGreaterThan(0);
    bus.execute({ type: "batch", commands });
    expect(d.all().map((e) => e.type).sort()).toEqual(["line", "polyline"]);
    bus.undo();
    expect(d.all().map((e) => e.id).sort()).toEqual(["a", "b", "z"]);
  });
});

describe("explodePolyline", () => {
  it("gives back lines and arcs that trace the same path, inheriting properties", () => {
    const pl: PolylineEntity = {
      id: "p",
      type: "polyline",
      layer: "cut",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      closed: true,
      bulges: [0, 1, 0],
    };
    const parts = explodePolyline(pl);
    expect(parts.map((p) => p.type)).toEqual(["line", "arc", "line"]);
    expect(parts.every((p) => p.layer === "cut")).toBe(true);
    const arc = parts[1] as ArcEntity;
    expect(dist(arc.center, { x: 10, y: 5 })).toBeLessThan(1e-9);
    expect(explodeCommands([pl])).toHaveLength(4);
    expect(explodeCommands([line("l", 0, 0, 1, 1)])).toHaveLength(0);
  });
});

describe("pointsAlong", () => {
  it("divides a line into N equal parts and spaces points along a circle", () => {
    const pts = pointsAlong(line("l", 0, 0, 10, 0), { divisions: 4 });
    expect(pts.map((p) => p.x)).toEqual([2.5, 5, 7.5]);
    const circle: Entity = { id: "c", type: "circle", center: { x: 0, y: 0 }, radius: 10 };
    const around = pointsAlong(circle, { divisions: 4 });
    expect(around).toHaveLength(4); // a closed path includes its start
    for (const p of around) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 9);
    const spaced = pointsAlong(line("l", 0, 0, 10, 0), { spacing: 3 });
    expect(spaced.map((p) => p.x)).toEqual([3, 6, 9]);
  });
});
