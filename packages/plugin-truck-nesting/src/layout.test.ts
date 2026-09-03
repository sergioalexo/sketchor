import { describe, expect, it } from "vitest";
import type { DocumentReadModel } from "@sketchor/plugin-sdk";
import { buildNestLayout, clearPreviousLayout, LOAD_PLAN_LAYER } from "./layout";
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
    pallets: [{ id: "c", width: 1200, length: 800, shape: "rect" }],
  },
];

function model(over: Partial<DocumentReadModel> = {}): DocumentReadModel {
  return { revision: 1, entities: [], groups: [], constraints: [], ...over };
}

describe("buildNestLayout", () => {
  it("draws a trailer outline plus one coloured shape per pallet, grouped by order", () => {
    const result = nestByOrders(trailer, orders);
    const commands = buildNestLayout(result);
    const added = commands.filter((c) => c.type === "add-entity");
    const groups = commands.filter((c) => c.type === "group-entities");

    expect(added).toHaveLength(result.placed.length + 1); // + outline
    expect(groups).toHaveLength(2); // one per order

    for (const c of added) {
      if (c.type !== "add-entity") continue;
      expect(c.entity.layer).toBe(LOAD_PLAN_LAYER);
    }

    // Pallet shapes carry their order's colour as stroke + hatch fill.
    const pallets = added.filter((c) => c.type === "add-entity" && c.entity.fill);
    expect(pallets).toHaveLength(result.placed.length);
    for (const c of pallets) {
      if (c.type !== "add-entity") continue;
      expect(["#e2554e", "#4f86d6"]).toContain(c.entity.color);
      expect(c.entity.color).toBe(c.entity.fill);
    }

    const round = added.find((c) => c.type === "add-entity" && c.entity.type === "circle");
    expect(round).toBeTruthy();
    const rect = added.find((c) => c.type === "add-entity" && c.entity.type === "polyline" && c.entity.fill);
    expect(rect).toBeTruthy();

    for (const g of groups) {
      if (g.type !== "group-entities") continue;
      expect(["Leeds", "Hull"]).toContain(g.name);
    }
  });
});

describe("buildNestLayout margins", () => {
  it("adds no white guides when both margins are zero", () => {
    const commands = buildNestLayout(nestByOrders(trailer, orders));
    const guides = commands.filter((c) => c.type === "add-entity" && c.entity.color === "#ffffff");
    expect(guides).toHaveLength(0);
  });

  it("draws a white wall-clearance rectangle and a white slot around each pallet", () => {
    const result = nestByOrders({ ...trailer, wallMargin: 120 }, orders, { palletMargin: 30 });
    const commands = buildNestLayout(result);
    const guides = commands.filter((c) => c.type === "add-entity" && c.entity.color === "#ffffff");
    // one trailer clearance rect + one slot per placed pallet
    expect(guides).toHaveLength(1 + result.placed.length);
    for (const g of guides) {
      if (g.type === "add-entity") expect(g.entity.fill).toBeUndefined();
    }
    // pallets sit off the walls
    for (const p of result.placed) expect(p.x).toBeGreaterThanOrEqual(120 + 30 - 1e-6);
  });
});

describe("clearPreviousLayout", () => {
  it("returns nothing when there is no prior plan", () => {
    expect(clearPreviousLayout(model())).toEqual([]);
  });

  it("deletes every Load Plan entity and ungroups its per-order wrappers", () => {
    const m = model({
      entities: [
        { id: "e1", type: "polyline", layer: LOAD_PLAN_LAYER, points: [], closed: true },
        { id: "e2", type: "circle", layer: LOAD_PLAN_LAYER, center: { x: 0, y: 0 }, radius: 1 },
        { id: "keep", type: "polyline", layer: "0", points: [], closed: false },
      ] as DocumentReadModel["entities"],
      groups: [
        { id: "g1", name: "Leeds", members: ["e1", "e2"] },
        { id: "gkeep", name: "user group", members: ["keep"] },
      ],
    });
    const commands = clearPreviousLayout(m);
    expect(commands.some((c) => c.type === "ungroup" && c.groupId === "g1")).toBe(true);
    expect(commands.some((c) => c.type === "ungroup" && c.groupId === "gkeep")).toBe(false);
    const del = commands.find((c) => c.type === "delete-entities");
    expect(del && del.type === "delete-entities" && del.ids.sort()).toEqual(["e1", "e2"]);
  });
});
