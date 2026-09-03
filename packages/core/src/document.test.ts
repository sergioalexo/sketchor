import { describe, expect, it } from "vitest";
import { SketchDocument } from "./document";
import type { CircleEntity, LineEntity } from "./entities";
import type { Constraint } from "./constraints";

/**
 * The document store itself: serialization, the revision counter renderers
 * dirty-check on, and the group-tree walks. Group membership arrives as plain
 * `Command` data, so the walks have to survive malformed trees (missing
 * members, cycles) rather than assume the UI only ever builds sane ones.
 */

const line = (id: string): LineEntity => ({ id, type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
const circle = (id: string): CircleEntity => ({ id, type: "circle", center: { x: 5, y: 5 }, radius: 2 });

describe("SketchDocument serialization", () => {
  it("round-trips entities, groups and constraints through JSON", () => {
    const doc = new SketchDocument();
    doc._put(line("e1"));
    doc._put(circle("e2"));
    doc._putGroup({ id: "g1", name: "Plate", members: ["e1", "e2"] });
    const constraint: Constraint = { id: "k1", type: "horizontal", entityId: "e1" };
    doc._putConstraint(constraint);

    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    const restored = SketchDocument.fromJSON(json);

    expect(restored.toJSON()).toEqual(doc.toJSON());
    expect(restored.get("e1")).toEqual(line("e1"));
    expect(restored.getGroup("g1")?.members).toEqual(["e1", "e2"]);
    expect(restored.getConstraint("k1")).toEqual(constraint);
  });

  it("stamps the format version", () => {
    expect(new SketchDocument().toJSON().version).toBe(2);
  });

  it("accepts JSON with no groups or constraints (a v1-shaped file)", () => {
    const restored = SketchDocument.fromJSON({ entities: [line("e1")] });
    expect(restored.all()).toHaveLength(1);
    expect(restored.groups()).toEqual([]);
    expect(restored.constraints()).toEqual([]);
  });
});

describe("SketchDocument.revision", () => {
  it("bumps on every mutation", () => {
    const doc = new SketchDocument();
    expect(doc.revision).toBe(0);

    doc._put(line("e1"));
    doc._putGroup({ id: "g1", name: "g1", members: ["e1"] });
    doc._putConstraint({ id: "k1", type: "fix", entityId: "e1" });
    expect(doc.revision).toBe(3);

    doc._remove("e1");
    doc._removeGroup("g1");
    doc._removeConstraint("k1");
    expect(doc.revision).toBe(6);
  });

  it("bumps even when overwriting an entity in place", () => {
    const doc = new SketchDocument();
    doc._put(line("e1"));
    const before = doc.revision;
    doc._put({ ...line("e1"), b: { x: 20, y: 0 } });
    expect(doc.revision).toBe(before + 1);
    expect(doc.all()).toHaveLength(1);
  });
});

describe("group lookups", () => {
  /** g1 -> g2 -> e1, plus a loose e2. Parent links point back up the chain. */
  function nested(): SketchDocument {
    const doc = new SketchDocument();
    doc._put(line("e1"));
    doc._put(circle("e2"));
    doc._putGroup({ id: "g2", name: "Inner", members: ["e1"], parent: "g1" });
    doc._putGroup({ id: "g1", name: "Outer", members: ["g2"] });
    return doc;
  }

  it("finds the group that directly lists a member", () => {
    const doc = nested();
    expect(doc.groupContaining("e1")?.id).toBe("g2");
    expect(doc.groupContaining("g2")?.id).toBe("g1");
    expect(doc.groupContaining("e2")).toBeUndefined();
  });

  it("walks up to the outermost group", () => {
    const doc = nested();
    expect(doc.topLevelGroupOf("e1")?.id).toBe("g1");
    expect(doc.topLevelGroupOf("e2")).toBeUndefined();
  });

  it("stops walking up when the parent link is dangling", () => {
    const doc = new SketchDocument();
    doc._put(line("e1"));
    doc._putGroup({ id: "g1", name: "Orphan", members: ["e1"], parent: "gone" });
    expect(doc.topLevelGroupOf("e1")?.id).toBe("g1");
  });

  it("does not loop forever on a parent cycle", () => {
    const doc = new SketchDocument();
    doc._put(line("e1"));
    doc._putGroup({ id: "g1", name: "g1", members: ["e1"], parent: "g2" });
    doc._putGroup({ id: "g2", name: "g2", members: ["g1"], parent: "g1" });
    expect(doc.topLevelGroupOf("e1")).toBeDefined();
  });
});

describe("groupEntityIds", () => {
  it("flattens nested groups", () => {
    const doc = new SketchDocument();
    doc._put(line("e1"));
    doc._put(circle("e2"));
    doc._put(line("e3"));
    doc._putGroup({ id: "g2", name: "Inner", members: ["e2", "e3"] });
    doc._putGroup({ id: "g1", name: "Outer", members: ["e1", "g2"] });

    expect(doc.groupEntityIds("g1")).toEqual(["e1", "e2", "e3"]);
    expect(doc.groupEntityIds("g2")).toEqual(["e2", "e3"]);
  });

  it("skips members that no longer exist", () => {
    const doc = new SketchDocument();
    doc._put(line("e1"));
    doc._putGroup({ id: "g1", name: "g1", members: ["e1", "deleted", "alsoGone"] });
    expect(doc.groupEntityIds("g1")).toEqual(["e1"]);
  });

  it("returns nothing for an unknown group", () => {
    expect(new SketchDocument().groupEntityIds("nope")).toEqual([]);
  });

  it("terminates on a membership cycle instead of overflowing the stack", () => {
    const doc = new SketchDocument();
    doc._put(line("e1"));
    doc._put(circle("e2"));
    doc._putGroup({ id: "g1", name: "g1", members: ["e1", "g2"] });
    doc._putGroup({ id: "g2", name: "g2", members: ["e2", "g1"] });

    expect(doc.groupEntityIds("g1")).toEqual(["e1", "e2"]);
  });

  it("reports an entity once when two branches reach the same subgroup", () => {
    const doc = new SketchDocument();
    doc._put(line("e1"));
    doc._putGroup({ id: "shared", name: "shared", members: ["e1"] });
    doc._putGroup({ id: "a", name: "a", members: ["shared"] });
    doc._putGroup({ id: "b", name: "b", members: ["shared"] });
    doc._putGroup({ id: "root", name: "root", members: ["a", "b"] });

    expect(doc.groupEntityIds("root")).toEqual(["e1"]);
  });
});
