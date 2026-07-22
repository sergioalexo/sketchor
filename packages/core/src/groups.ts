import type { EntityId } from "./entities";
import type { SketchDocument } from "./document";

/**
 * Tier A grouping (see the engineering brief, R1): a registry on the
 * document rather than a per-entity `groupId` field, so groups can nest,
 * carry names, and stay out of entity records. Tier B (reusable block
 * definitions + placed instances) builds on this later.
 */
export type GroupId = string;

export interface Group {
  id: GroupId;
  name: string;
  /** Entity ids, or nested group ids. */
  members: (EntityId | GroupId)[];
  parent?: GroupId;
}

let counter = 0;

export function newGroupId(): GroupId {
  counter += 1;
  return `g${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * What clicking `hitId` should select: the whole top-level group it
 * belongs to, or just itself if it's ungrouped or the group is currently
 * "entered" (double-click to edit members, per the spec's FreeCAD/Illustrator
 * behavior).
 */
export function resolveSelection(
  doc: SketchDocument,
  hitId: EntityId,
  enteredGroupId: GroupId | null,
): EntityId[] {
  const top = doc.topLevelGroupOf(hitId);
  if (!top || top.id === enteredGroupId) return [hitId];
  return doc.groupEntityIds(top.id);
}

/**
 * The group id that exactly matches `selection` (used to enable "Ungroup" —
 * only offered when the current selection is precisely one whole group).
 */
export function wholeGroupSelected(doc: SketchDocument, selection: EntityId[]): GroupId | null {
  if (selection.length === 0) return null;
  const top = doc.topLevelGroupOf(selection[0]);
  if (!top) return null;
  const members = doc.groupEntityIds(top.id);
  if (members.length !== selection.length) return null;
  const set = new Set(selection);
  return members.every((id) => set.has(id)) ? top.id : null;
}
