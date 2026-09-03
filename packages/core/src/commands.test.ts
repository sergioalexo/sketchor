import { describe, expect, it, vi } from "vitest";
import { CommandBus, type Command } from "./commands";
import { SketchDocument } from "./document";
import type { CircleEntity, LineEntity, PolylineEntity } from "./entities";
import type { Constraint } from "./constraints";

/**
 * The one architectural rule (see CLAUDE.md): the document is only ever
 * mutated through serializable Command values, and every command derives the
 * commands that revert it. Tools, the future constraint solver and the AI
 * assistant are all just command producers, so a broken inverse corrupts a
 * drawing silently and from any direction.
 *
 * The centrepiece is the table-driven round-trip below: execute -> undo must
 * restore the document for *every* command type, which means a new command
 * type has to be added to CASES before this file will cover it.
 */

const line = (id: string, name?: string): LineEntity => ({
  id,
  type: "line",
  ...(name ? { name } : {}),
  a: { x: 0, y: 0 },
  b: { x: 10, y: 0 },
});
const circle = (id: string): CircleEntity => ({ id, type: "circle", center: { x: 5, y: 5 }, radius: 2 });
const polyline = (id: string): PolylineEntity => ({
  id,
  type: "polyline",
  layer: "outline",
  points: [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
  ],
  bulges: [0, 0.5, 0],
  closed: true,
});
const constraint: Constraint = { id: "k1", type: "horizontal", entityId: "e1" };

/** e1 (line), e2 (circle), e3 (polyline); group g1 over e1+e2; constraint k1. */
function fixture(): { doc: SketchDocument; bus: CommandBus } {
  const doc = new SketchDocument();
  doc._put(line("e1", "L1"));
  doc._put(circle("e2"));
  doc._put(polyline("e3"));
  doc._putGroup({ id: "g1", name: "Plate", members: ["e1", "e2"] });
  doc._putConstraint(constraint);
  return { doc, bus: new CommandBus(doc) };
}

/**
 * Order-insensitive document state. Deleting an entity and undoing re-inserts
 * it at the end of the Map, so insertion *order* is deliberately not part of
 * the round-trip invariant — identity and content are.
 */
function snapshot(doc: SketchDocument): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
      const src = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(src)
          .sort()
          .map((k) => [k, sortKeys(src[k])]),
      );
    }
    return value;
  };
  const byId = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  const json = doc.toJSON();
  return JSON.stringify(
    sortKeys({ entities: byId(json.entities), groups: byId(json.groups), constraints: byId(json.constraints) }),
  );
}

const CASES: { name: string; command: Command }[] = [
  { name: "add-entity", command: { type: "add-entity", entity: line("new") } },
  { name: "delete-entities", command: { type: "delete-entities", ids: ["e1", "e2"] } },
  { name: "move-entities", command: { type: "move-entities", ids: ["e1", "e3"], dx: 3, dy: -4 } },
  { name: "update-entity", command: { type: "update-entity", entity: { ...circle("e2"), radius: 99 } } },
  {
    name: "transform-entities",
    command: {
      type: "transform-entities",
      ids: ["e1", "e2", "e3"],
      pivot: { x: 1, y: 1 },
      dx: 2,
      dy: 3,
      rotation: Math.PI / 3,
      scale: 1.5,
    },
  },
  { name: "group-entities", command: { type: "group-entities", groupId: "g2", ids: ["e3"], name: "Second" } },
  { name: "ungroup", command: { type: "ungroup", groupId: "g1" } },
  {
    name: "add-constraint",
    command: { type: "add-constraint", constraint: { id: "k2", type: "radius", entityId: "e2", value: 4 } },
  },
  { name: "remove-constraint", command: { type: "remove-constraint", id: "k1" } },
  {
    name: "batch",
    command: {
      type: "batch",
      commands: [
        { type: "add-entity", entity: line("new") },
        { type: "move-entities", ids: ["e1"], dx: 1, dy: 1 },
        { type: "delete-entities", ids: ["e2"] },
      ],
    },
  },
];

describe("CommandBus undo/redo round-trip", () => {
  for (const { name, command } of CASES) {
    it(`restores the document after undoing ${name}`, () => {
      const { doc, bus } = fixture();
      const before = snapshot(doc);

      bus.execute(command);
      const after = snapshot(doc);
      expect(after).not.toBe(before); // every case must actually change something

      bus.undo();
      expect(snapshot(doc)).toBe(before);

      bus.redo();
      expect(snapshot(doc)).toBe(after);

      // Redo recomputes the inverse, so a second cycle must behave identically.
      bus.undo();
      expect(snapshot(doc)).toBe(before);
      bus.redo();
      expect(snapshot(doc)).toBe(after);
      bus.undo();
      expect(snapshot(doc)).toBe(before);
    });
  }
});

describe("command application", () => {
  it("add-entity stores the entity", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "add-entity", entity: line("e9") });
    expect(doc.get("e9")).toEqual(line("e9"));
  });

  it("delete-entities removes exactly the named ids", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "delete-entities", ids: ["e1", "e3"] });
    expect(doc.all().map((e) => e.id)).toEqual(["e2"]);
  });

  it("move-entities translates every named entity", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "move-entities", ids: ["e1", "e2"], dx: 5, dy: -2 });
    expect((doc.get("e1") as LineEntity).a).toEqual({ x: 5, y: -2 });
    expect((doc.get("e1") as LineEntity).b).toEqual({ x: 15, y: -2 });
    expect((doc.get("e2") as CircleEntity).center).toEqual({ x: 10, y: 3 });
    expect((doc.get("e3") as PolylineEntity).points[0]).toEqual({ x: 0, y: 0 }); // untouched
  });

  it("update-entity replaces the record wholesale", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "update-entity", entity: { ...line("e1"), name: "Renamed", layer: "walls" } });
    expect(doc.get("e1")).toMatchObject({ name: "Renamed", layer: "walls" });
  });

  it("transform-entities rotates and scales about the pivot", () => {
    const { doc, bus } = fixture();
    bus.execute({
      type: "transform-entities",
      ids: ["e2"],
      pivot: { x: 0, y: 0 },
      rotation: Math.PI / 2,
      scale: 2,
    });
    const c = doc.get("e2") as CircleEntity;
    expect(c.radius).toBe(4);
    expect(c.center.x).toBeCloseTo(-10, 10);
    expect(c.center.y).toBeCloseTo(10, 10);
  });

  it("transform-entities defaults every optional term to a no-op", () => {
    const { doc, bus } = fixture();
    const before = doc.get("e2");
    bus.execute({ type: "transform-entities", ids: ["e2"], pivot: { x: 3, y: 3 } });
    expect(doc.get("e2")).toEqual(before);
  });

  it("group-entities falls back to the id as the display name", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "group-entities", groupId: "g7", ids: ["e3"] });
    expect(doc.getGroup("g7")).toEqual({ id: "g7", name: "g7", members: ["e3"] });
  });

  it("group-entities records a parent only when one is given", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "group-entities", groupId: "g7", ids: ["e3"], parent: "g1" });
    expect(doc.getGroup("g7")?.parent).toBe("g1");
    bus.execute({ type: "group-entities", groupId: "g8", ids: ["e3"] });
    expect("parent" in doc.getGroup("g8")!).toBe(false);
  });

  it("ungroup restores name, members and parent when undone", () => {
    const { doc, bus } = fixture();
    doc._putGroup({ id: "gx", name: "Nested", members: ["e3"], parent: "g1" });
    bus.execute({ type: "ungroup", groupId: "gx" });
    expect(doc.getGroup("gx")).toBeUndefined();
    bus.undo();
    expect(doc.getGroup("gx")).toEqual({ id: "gx", name: "Nested", members: ["e3"], parent: "g1" });
  });

  it("constraints are added and removed", () => {
    const { doc, bus } = fixture();
    const added: Constraint = { id: "k2", type: "parallel", a: "e1", b: "e3" };
    bus.execute({ type: "add-constraint", constraint: added });
    expect(doc.getConstraint("k2")).toEqual(added);
    bus.execute({ type: "remove-constraint", id: "k2" });
    expect(doc.getConstraint("k2")).toBeUndefined();
  });
});

describe("batch", () => {
  it("undoes children in reverse order", () => {
    // The update's inverse must run before the add's inverse; the other order
    // would re-create the entity after deleting it.
    const { doc, bus } = fixture();
    bus.execute({
      type: "batch",
      commands: [
        { type: "add-entity", entity: line("tmp") },
        { type: "update-entity", entity: { ...line("tmp"), b: { x: 99, y: 99 } } },
      ],
    });
    expect((doc.get("tmp") as LineEntity).b).toEqual({ x: 99, y: 99 });

    bus.undo();
    expect(doc.get("tmp")).toBeUndefined();
  });

  it("handles nested batches as a single undo step", () => {
    const { doc, bus } = fixture();
    const before = snapshot(doc);
    bus.execute({
      type: "batch",
      commands: [
        {
          type: "batch",
          commands: [
            { type: "add-entity", entity: line("a") },
            { type: "add-entity", entity: line("b") },
          ],
        },
        { type: "delete-entities", ids: ["e1"] },
      ],
    });
    expect(doc.all().map((e) => e.id).sort()).toEqual(["a", "b", "e2", "e3"]);

    bus.undo();
    expect(snapshot(doc)).toBe(before);
    expect(bus.canUndo).toBe(false); // one step, not three
  });

  it("treats an empty batch as a no-op that still occupies a history slot", () => {
    const { doc, bus } = fixture();
    const before = snapshot(doc);
    bus.execute({ type: "batch", commands: [] });
    expect(snapshot(doc)).toBe(before);
    expect(bus.canUndo).toBe(true);
    bus.undo();
    expect(snapshot(doc)).toBe(before);
  });
});

describe("commands naming things that aren't there", () => {
  it("ignores stale ids in delete-entities without resurrecting them on undo", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "delete-entities", ids: ["e1", "ghost"] });
    expect(doc.has("ghost")).toBe(false);
    bus.undo();
    expect(doc.has("e1")).toBe(true);
    expect(doc.has("ghost")).toBe(false);
  });

  it("ignores missing ids in move-entities", () => {
    const { doc, bus } = fixture();
    const before = snapshot(doc);
    bus.execute({ type: "move-entities", ids: ["ghost"], dx: 5, dy: 5 });
    expect(snapshot(doc)).toBe(before);
    bus.undo();
    expect(snapshot(doc)).toBe(before);
  });

  it("ignores missing ids in transform-entities", () => {
    const { doc, bus } = fixture();
    const before = snapshot(doc);
    bus.execute({ type: "transform-entities", ids: ["ghost"], pivot: { x: 0, y: 0 }, scale: 2 });
    expect(snapshot(doc)).toBe(before);
    bus.undo();
    expect(snapshot(doc)).toBe(before);
  });

  it("inverts update-entity on an unknown id to a delete", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "update-entity", entity: line("fresh") });
    expect(doc.has("fresh")).toBe(true);
    bus.undo();
    expect(doc.has("fresh")).toBe(false);
  });

  it("makes ungroup of an unknown group a no-op", () => {
    const { doc, bus } = fixture();
    const before = snapshot(doc);
    bus.execute({ type: "ungroup", groupId: "nope" });
    expect(snapshot(doc)).toBe(before);
    bus.undo();
    expect(snapshot(doc)).toBe(before);
  });

  it("makes remove-constraint of an unknown constraint a no-op", () => {
    const { doc, bus } = fixture();
    const before = snapshot(doc);
    bus.execute({ type: "remove-constraint", id: "nope" });
    expect(snapshot(doc)).toBe(before);
    bus.undo();
    expect(snapshot(doc)).toBe(before);
  });
});

describe("history stacks", () => {
  it("tracks canUndo/canRedo across a full cycle", () => {
    const { bus } = fixture();
    expect(bus.canUndo).toBe(false);
    expect(bus.canRedo).toBe(false);

    bus.execute({ type: "add-entity", entity: line("a") });
    expect(bus.canUndo).toBe(true);
    expect(bus.canRedo).toBe(false);

    bus.undo();
    expect(bus.canUndo).toBe(false);
    expect(bus.canRedo).toBe(true);

    bus.redo();
    expect(bus.canUndo).toBe(true);
    expect(bus.canRedo).toBe(false);
  });

  it("drops the redo stack once a new command is executed", () => {
    const { doc, bus } = fixture();
    bus.execute({ type: "add-entity", entity: line("a") });
    bus.undo();
    expect(bus.canRedo).toBe(true);

    bus.execute({ type: "add-entity", entity: line("b") });
    expect(bus.canRedo).toBe(false);

    bus.redo(); // must do nothing
    expect(doc.has("a")).toBe(false);
    expect(doc.has("b")).toBe(true);
  });

  it("unwinds several steps in order", () => {
    const { doc, bus } = fixture();
    const before = snapshot(doc);
    bus.execute({ type: "add-entity", entity: line("a") });
    bus.execute({ type: "move-entities", ids: ["a"], dx: 5, dy: 0 });
    bus.execute({ type: "delete-entities", ids: ["e1"] });

    bus.undo();
    bus.undo();
    expect((doc.get("a") as LineEntity).a).toEqual({ x: 0, y: 0 });
    bus.undo();
    expect(snapshot(doc)).toBe(before);
  });

  it("treats undo and redo on empty stacks as no-ops", () => {
    const { doc, bus } = fixture();
    const before = snapshot(doc);
    bus.undo();
    bus.redo();
    expect(snapshot(doc)).toBe(before);
    expect(bus.canUndo).toBe(false);
    expect(bus.canRedo).toBe(false);
  });
});

describe("change notification", () => {
  it("fires once per execute, undo and redo", () => {
    const { bus } = fixture();
    const listener = vi.fn();
    bus.onChange(listener);

    bus.execute({ type: "add-entity", entity: line("a") });
    expect(listener).toHaveBeenCalledTimes(1);
    bus.undo();
    expect(listener).toHaveBeenCalledTimes(2);
    bus.redo();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not fire when undo or redo has nothing to do", () => {
    const { bus } = fixture();
    const listener = vi.fn();
    bus.onChange(listener);
    bus.undo();
    bus.redo();
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after the returned unsubscribe is called", () => {
    const { bus } = fixture();
    const listener = vi.fn();
    const off = bus.onChange(listener);
    bus.execute({ type: "add-entity", entity: line("a") });
    off();
    bus.execute({ type: "add-entity", entity: line("b") });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies every subscriber", () => {
    const { bus } = fixture();
    const one = vi.fn();
    const two = vi.fn();
    bus.onChange(one);
    bus.onChange(two);
    bus.execute({ type: "add-entity", entity: line("a") });
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });
});
