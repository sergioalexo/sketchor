import { describe, expect, it } from "vitest";
import type { Command, DocumentReadModel } from "@sketchor/plugin-sdk";
import { buildNestLayout, clearPreviousLayout, LOAD_PLAN_GUIDE_LAYER, LOAD_PLAN_LAYER, setDimensionsOnLayout } from "./layout";
import { nestByOrders } from "./nest";
import type { Order, TrailerProfile } from "./types";

/** A minimal in-memory reducer standing in for the host's document.apply — enough to test command output against. */
function applyCommands(m: DocumentReadModel, cmds: Command[]): DocumentReadModel {
  let entities = [...m.entities];
  let groups = [...m.groups];
  for (const c of cmds) {
    if (c.type === "add-entity") entities.push(c.entity);
    else if (c.type === "delete-entities") entities = entities.filter((e) => !c.ids.includes(e.id));
    else if (c.type === "group-entities") groups.push({ id: c.groupId, name: c.name ?? "", members: c.ids });
    else if (c.type === "ungroup") groups = groups.filter((g) => g.id !== c.groupId);
  }
  return { revision: m.revision + 1, entities, groups, constraints: m.constraints };
}

const trailer: TrailerProfile = { name: "T", length: 13600, width: 2480 };
const orders: Order[] = [
  {
    id: "leeds",
    city: "Leeds",
    color: "#e2554e",
    pallets: [
      { id: "a", width: 1200, length: 800, shape: "rect" },
      { id: "b", width: 1000, length: 1000, shape: "round" },
    ],
  },
  {
    id: "hull",
    city: "Hull",
    color: "#4f86d6",
    pallets: [{ id: "c", width: 1200, length: 800, shape: "rect", tag: "FRAGILE" }],
  },
];

function model(over: Partial<DocumentReadModel> = {}): DocumentReadModel {
  return { revision: 1, entities: [], groups: [], constraints: [], ...over };
}

const added = (cmds: ReturnType<typeof buildNestLayout>) => cmds.filter((c) => c.type === "add-entity");
const isColor = (c: ReturnType<typeof buildNestLayout>[number], col: string) =>
  c.type === "add-entity" && c.entity.color === col;

describe("buildNestLayout", () => {
  it("draws one hatched shape per pallet, each in its own group", () => {
    const result = nestByOrders(trailer, orders);
    const cmds = buildNestLayout(result);
    const pallets = added(cmds).filter((c) => c.type === "add-entity" && "fill" in c.entity && c.entity.fill);
    expect(pallets).toHaveLength(result.placed.length);

    const groups = cmds.filter((c) => c.type === "group-entities");
    // one group per pallet (shape + guide + tag + dims)
    expect(groups.length).toBe(result.placed.length);

    const round = added(cmds).find((c) => c.type === "add-entity" && c.entity.type === "circle" && c.entity.fill);
    expect(round).toBeTruthy();
  });

  it("draws the tag as a text entity", () => {
    const cmds = buildNestLayout(nestByOrders(trailer, orders));
    const texts = added(cmds).filter((c) => c.type === "add-entity" && c.entity.type === "text");
    expect(texts.some((c) => c.type === "add-entity" && c.entity.type === "text" && c.entity.text === "FRAGILE")).toBe(true);
  });

  it("adds W×L dimensions per pallet only when asked", () => {
    const without = buildNestLayout(nestByOrders(trailer, orders));
    const withDims = buildNestLayout(nestByOrders(trailer, orders), { dimensions: true });
    expect(added(withDims).length).toBeGreaterThan(added(without).length);
  });

  it("writes a printable summary block beside the trailer", () => {
    const result = nestByOrders(trailer, orders);
    const cmds = buildNestLayout(result, { findings: [{ level: "info", message: "ok" }] });
    const texts = added(cmds).filter((c) => c.type === "add-entity" && c.entity.type === "text");
    expect(texts.some((c) => c.type === "add-entity" && c.entity.type === "text" && /load plan/i.test(c.entity.text))).toBe(true);
    // the summary sits past the nose
    const summary = texts.find((c) => c.type === "add-entity" && c.entity.type === "text" && /load plan/i.test(c.entity.text));
    if (summary?.type === "add-entity" && summary.entity.type === "text") {
      expect(summary.entity.at.x).toBeGreaterThan(trailer.length);
    }
  });
});

describe("buildNestLayout margins", () => {
  it("adds no guides when both margins are zero", () => {
    const cmds = buildNestLayout(nestByOrders(trailer, orders));
    expect(added(cmds).filter((c) => isColor(c, "#ffffff"))).toHaveLength(0);
  });

  it("draws dashed white guides for the wall clearance and each pallet slot", () => {
    const result = nestByOrders({ ...trailer, wallMargin: 120 }, orders, { palletMargin: 30 });
    const cmds = buildNestLayout(result);
    const guides = added(cmds).filter((c) => isColor(c, "#ffffff"));
    expect(guides).toHaveLength(1 + result.placed.length);
    for (const g of guides) {
      if (g.type === "add-entity") {
        expect(g.entity.dashed).toBe(true);
        // guides live on their own layer so they can be hidden from the plan
        expect(g.entity.layer).toBe(LOAD_PLAN_GUIDE_LAYER);
        if ("fill" in g.entity) expect(g.entity.fill).toBeUndefined();
      }
    }
    // the pallets themselves stay on the main layer
    const pallets = added(cmds).filter((c) => c.type === "add-entity" && "fill" in c.entity && c.entity.fill);
    for (const p of pallets) if (p.type === "add-entity") expect(p.entity.layer).toBe(LOAD_PLAN_LAYER);
  });
});

describe("clearPreviousLayout", () => {
  it("returns nothing when there is no prior plan", () => {
    expect(clearPreviousLayout(model())).toEqual([]);
  });

  it("deletes every plan entity — margins layer included — and ungroups its wrappers, nested groups too", () => {
    const m = model({
      entities: [
        { id: "e1", type: "polyline", layer: LOAD_PLAN_LAYER, points: [], closed: true },
        { id: "e2", type: "circle", layer: LOAD_PLAN_LAYER, center: { x: 0, y: 0 }, radius: 1 },
        { id: "guide", type: "polyline", layer: LOAD_PLAN_GUIDE_LAYER, points: [], closed: true },
        { id: "keep", type: "polyline", layer: "0", points: [], closed: false },
      ] as DocumentReadModel["entities"],
      groups: [
        { id: "pg", name: "Leeds", members: ["e1", "e2", "guide"] },
        { id: "og", name: "Leeds", members: ["pg"] },
        { id: "gkeep", name: "user group", members: ["keep"] },
      ],
    });
    const commands = clearPreviousLayout(m);
    expect(commands.some((c) => c.type === "ungroup" && c.groupId === "pg")).toBe(true);
    expect(commands.some((c) => c.type === "ungroup" && c.groupId === "og")).toBe(true);
    expect(commands.some((c) => c.type === "ungroup" && c.groupId === "gkeep")).toBe(false);
    const del = commands.find((c) => c.type === "delete-entities");
    expect(del && del.type === "delete-entities" && del.ids.sort()).toEqual(["e1", "e2", "guide"]);
  });
});

describe("setDimensionsOnLayout", () => {
  it("adds and removes dimensions on an already-drawn plan without touching pallet positions", () => {
    let m = applyCommands(model(), buildNestLayout(nestByOrders(trailer, orders)));
    expect(m.entities.some((e) => e.name === "pallet-dim")).toBe(false);

    m = applyCommands(m, setDimensionsOnLayout(m, true, {}));
    const dimCount = m.entities.filter((e) => e.name === "pallet-dim").length;
    expect(dimCount).toBeGreaterThan(0);
    const shapesAfterOn = m.entities.filter((e) => e.name === "pallet-shape");

    m = applyCommands(m, setDimensionsOnLayout(m, false, {}));
    expect(m.entities.some((e) => e.name === "pallet-dim")).toBe(false);
    const shapesAfterOff = m.entities.filter((e) => e.name === "pallet-shape");
    // Toggling dimensions off must not move or recreate a single pallet shape.
    expect(shapesAfterOff.map((e) => e.id).sort()).toEqual(shapesAfterOn.map((e) => e.id).sort());
    for (const s of shapesAfterOff) expect(s).toEqual(shapesAfterOn.find((e) => e.id === s.id));

    // A pallet the user drags by hand (simulated: translate one shape's points)
    // must keep that position when dimensions are toggled back on — this is
    // the fix for "adding dimensions re-nests the plan".
    const shape = m.entities.find((e) => e.name === "pallet-shape" && e.type === "polyline");
    if (!shape || shape.type !== "polyline") throw new Error("expected a rect pallet in the fixture");
    const dragged = { ...shape, points: shape.points.map((p) => ({ x: p.x + 1000, y: p.y })) };
    m = { ...m, entities: m.entities.map((e) => (e.id === dragged.id ? dragged : e)) };

    m = applyCommands(m, setDimensionsOnLayout(m, true, {}));
    const shapeAfterDragAndToggle = m.entities.find((e) => e.id === dragged.id);
    expect(shapeAfterDragAndToggle).toEqual(dragged);
    expect(m.entities.some((e) => e.name === "pallet-dim")).toBe(true);
  });

  it("groups the dragged pallet's own dimensions with it, not the original spot", () => {
    let m = applyCommands(model(), buildNestLayout(nestByOrders(trailer, orders)));
    const shape = m.entities.find((e) => e.name === "pallet-shape" && e.type === "polyline");
    if (!shape || shape.type !== "polyline") throw new Error("expected a rect pallet in the fixture");
    const dragged = { ...shape, points: shape.points.map((p) => ({ x: p.x + 500, y: p.y + 500 })) };
    m = { ...m, entities: m.entities.map((e) => (e.id === dragged.id ? dragged : e)) };

    m = applyCommands(m, setDimensionsOnLayout(m, true, {}));
    const group = m.groups.find((g) => g.members.includes(dragged.id));
    expect(group).toBeTruthy();
    const dimIdsInGroup = (group?.members ?? []).filter((id) => m.entities.find((e) => e.id === id)?.name === "pallet-dim");
    expect(dimIdsInGroup.length).toBeGreaterThan(0);
  });
});
