import { describe, expect, it } from "vitest";
import type { DocumentReadModel } from "@sketchor/plugin-sdk";
import { buildNestLayout, clearPreviousLayout, LOAD_PLAN_LAYER } from "./layout";
import { nestTruck } from "./nest";
import type { PalletItem, TrailerProfile } from "./types";

const trailer: TrailerProfile = { name: "T", length: 13600, width: 2480 };
const items: PalletItem[] = [
  { id: "a", label: "EUR", length: 1200, width: 800, weightKg: 400, qty: 3, stop: 1, rotatable: true },
];

function model(over: Partial<DocumentReadModel> = {}): DocumentReadModel {
  return { revision: 1, entities: [], groups: [], constraints: [], ...over };
}

describe("buildNestLayout", () => {
  it("emits a trailer outline plus a grouped rectangle per placed item", () => {
    const result = nestTruck(trailer, items);
    const commands = buildNestLayout(result);
    const added = commands.filter((c) => c.type === "add-entity");
    const groups = commands.filter((c) => c.type === "group-entities");
    expect(added).toHaveLength(result.placed.length + 1); // + outline
    expect(groups).toHaveLength(result.placed.length);
    for (const c of added) {
      expect(c.type).toBe("add-entity");
      if (c.type === "add-entity") {
        expect(c.entity.type).toBe("polyline");
        expect(c.entity.layer).toBe(LOAD_PLAN_LAYER);
      }
    }
    // Each group wraps exactly the entity added just before it.
    for (const g of groups) {
      if (g.type !== "group-entities") continue;
      expect(g.ids).toHaveLength(1);
    }
  });
});

describe("clearPreviousLayout", () => {
  it("returns nothing when there is no prior plan", () => {
    expect(clearPreviousLayout(model())).toEqual([]);
  });

  it("deletes every Load Plan entity and ungroups its wrappers", () => {
    const m = model({
      entities: [
        { id: "e1", type: "polyline", layer: LOAD_PLAN_LAYER, points: [], closed: true },
        { id: "e2", type: "polyline", layer: LOAD_PLAN_LAYER, points: [], closed: true },
        { id: "keep", type: "polyline", layer: "0", points: [], closed: false },
      ] as DocumentReadModel["entities"],
      groups: [
        { id: "g1", name: "EUR — stop 1", members: ["e1"] },
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
