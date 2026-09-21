import { describe, expect, it } from "vitest";
import { parseClipboard, pasteCommands, payloadBase, serializeSelection } from "./clipboard";
import { CommandBus } from "./commands";
import { SketchDocument } from "./document";
import type { Entity, PolylineEntity } from "./entities";

/**
 * Copy/paste moves geometry between tabs and out to text. A paste that
 * loses the layer, a bulge or a group membership silently degrades the
 * drawing; a paste that reuses ids corrupts the document. The text form
 * also has to survive a trip through an editor that only kept the code.
 */

function docWith(...entities: Entity[]): SketchDocument {
  const d = new SketchDocument();
  for (const e of entities) d._put(e);
  return d;
}

const rounded: PolylineEntity = {
  id: "p1",
  type: "polyline",
  layer: "cut",
  color: "#0f0",
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
  ],
  closed: true,
  bulges: [0, 0.5, 0],
};
const line: Entity = { id: "l1", type: "line", a: { x: 0, y: 0 }, b: { x: 5, y: 5 } };

describe("clipboard", () => {
  it("serialises as readable sketch code plus a lossless comment line", () => {
    const text = serializeSelection(docWith(rounded, line), ["p1", "l1"]);
    expect(text.startsWith("sketch v1")).toBe(true);
    expect(text).toMatch(/^polyline /m);
    expect(text).toMatch(/^# sketchor \{/m);
    expect(serializeSelection(docWith(line), [])).toBe("");
  });

  it("round-trips layer, colour and bulges through the comment line", () => {
    const text = serializeSelection(docWith(rounded), ["p1"]);
    const payload = parseClipboard(text)!;
    expect(payload.entities).toHaveLength(1);
    expect(payload.entities[0]).toMatchObject({ layer: "cut", color: "#0f0", bulges: [0, 0.5, 0] });
  });

  it("still pastes plain sketch code without the comment (lossy, by design)", () => {
    const payload = parseClipboard("sketch v1\n\nline L1 from (1, 2) to (3, 4)\ncircle C1 at (0, 0) r 5\n")!;
    expect(payload.entities.map((e) => e.type).sort()).toEqual(["circle", "line"]);
    expect(parseClipboard("just some words")).toBeNull();
  });

  it("carries a group only when every member was copied, and re-ids it on paste", () => {
    const d = docWith(rounded, line);
    const bus = new CommandBus(d);
    bus.execute({ type: "group-entities", groupId: "g1", ids: ["p1", "l1"], name: "part" });
    expect(parseClipboard(serializeSelection(d, ["p1"]))!.groups).toHaveLength(0);
    const payload = parseClipboard(serializeSelection(d, ["p1", "l1"]))!;
    expect(payload.groups).toHaveLength(1);

    const { commands, ids } = pasteCommands(payload, { x: 100, y: 0 });
    bus.execute({ type: "batch", commands });
    expect(ids.every((id) => id !== "p1" && id !== "l1")).toBe(true);
    expect(d.all()).toHaveLength(4);
    const pasted = d.all().filter((e) => ids.includes(e.id));
    const pastedLine = pasted.find((e) => e.type === "line")!;
    expect(pastedLine.type === "line" && pastedLine.a).toEqual({ x: 100, y: 0 });
    // The pasted group is a new group over the new ids, the original untouched.
    expect(d.groups()).toHaveLength(2);
    const g = d.groups().find((x) => x.id !== "g1")!;
    expect(g.members.sort()).toEqual([...ids].sort());
    expect(g.name).toBe("part");
    // Undo removes everything the paste added.
    bus.undo();
    expect(d.all()).toHaveLength(2);
    expect(d.groups()).toHaveLength(1);
  });

  it("reports the bottom-left of the payload as the base point", () => {
    expect(payloadBase(parseClipboard(serializeSelection(docWith(rounded, line), ["p1", "l1"]))!)).toEqual({ x: 0, y: 0 });
  });
});
