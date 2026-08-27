import type { EntityId } from "./entities";

export type GroupId = string;

/** Mirrors `@sketchor/core`'s `Group` — see entities.ts for why this is re-declared rather than imported. */
export interface Group {
  id: GroupId;
  name: string;
  members: (EntityId | GroupId)[];
  parent?: GroupId;
}
