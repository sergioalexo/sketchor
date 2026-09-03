import { describe, expect, it } from "vitest";
import type { DocumentReadModel } from "@sketchor/plugin-sdk";
import { buildNestLayout, clearPreviousLayout, LOAD_PLAN_GUIDE_LAYER, LOAD_PLAN_LAYER } from "./layout";
import { nestByOrders } from "./nest";
import type { Order, TrailerProfile } from "./types";

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
