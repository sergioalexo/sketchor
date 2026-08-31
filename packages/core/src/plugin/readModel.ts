import type { Entity } from "../entities";
import type { Group } from "../groups";
import type { Constraint } from "../constraints";
import type { SketchDocument } from "../document";

/**
 * The safe, serializable projection of a {@link SketchDocument} a plugin is
 * allowed to see. Deliberately *not* the document itself: it exposes only
 * plain, structured-cloneable data (no `_put`/`_remove` handles, no live
 * references), so it can cross the sandbox RPC boundary and a plugin can never
 * reach in and mutate state directly.
 *
 * `revision` mirrors `SketchDocument.revision` so a plugin can cheaply tell
 * whether its snapshot is stale.
 *
 * Note: layer *visibility* is a viewport/UI concern and lives in the web store,
 * not here. Entities carry their layer name via `entity.layer`; the set of
 * layers is derivable from that.
 */
export interface DocumentReadModel {
  readonly revision: number;
  readonly entities: readonly Entity[];
  readonly groups: readonly Group[];
  readonly constraints: readonly Constraint[];
}

/**
 * Projects the live document into a read-model snapshot. Returns fresh plain
 * arrays; the entity/group/constraint records are the document's own immutable
 * value objects (every mutation replaces them wholesale via the CommandBus), so
 * they're safe to hand out and to structured-clone.
 */
export function projectDocument(doc: SketchDocument): DocumentReadModel {
  return {
    revision: doc.revision,
    entities: doc.all(),
    groups: doc.groups(),
    constraints: doc.constraints(),
  };
}
