import type { Entity, EntityId } from "./entities";
import type { GroupId } from "./groups";
import type { Json } from "./meta";

/**
 * The document-write surface available to a plugin, v1 — the subset of
 * `@sketchor/core`'s `Command` union a plugin actually needs. Every
 * variant here has the exact field shape of its core counterpart, so the
 * host can hand these straight to its `CommandBus` (see the web app's
 * plugin-context adapter) without a translation layer. That equivalence
 * is the thing to preserve if this union grows.
 */
export type PluginCommand =
  | { type: "add-entity"; entity: Entity }
  | { type: "delete-entities"; ids: EntityId[] }
  | { type: "group-entities"; groupId: GroupId; ids: (EntityId | GroupId)[]; name?: string; parent?: GroupId }
  | { type: "ungroup"; groupId: GroupId }
  | { type: "set-meta"; pluginId: string; targetId: EntityId | GroupId; value: Json }
  | { type: "clear-meta"; pluginId: string; targetId: EntityId | GroupId }
  | { type: "batch"; commands: PluginCommand[] };
