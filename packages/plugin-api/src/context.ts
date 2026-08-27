import type { Entity, EntityId } from "./entities";
import type { Group, GroupId } from "./groups";
import type { Json } from "./meta";
import type { PluginCommand } from "./commands";

/**
 * The runtime surface a plugin gets, v1. Every value crossing this
 * boundary is plain data — see the roadmap's "one call that matters":
 * write this as if the plugin already ran in a sandboxed Worker, so that
 * swapping today's in-process transport for a real one later is a host
 * change, not a plugin rewrite.
 *
 * v1 keeps this small on purpose: read snapshots, one write path, one
 * namespaced data slot, one way to talk to the user. The full contract
 * from the roadmap (declarative panel UI, overlays, per-plugin storage)
 * arrives with the plugin host itself (v0.10) — until then, the host
 * project supplies its own React panel and just uses this context to
 * read/write the document.
 */
export interface PluginContext {
  /** Read-only snapshots — never the live document. */
  doc: {
    entities(): Entity[];
    groups(): Group[];
    get(id: EntityId): Entity | null;
  };

  /** The current selection, by id. */
  selection(): EntityId[];

  /** The only mutation path — applied to the real document as one undoable step. */
  execute(commands: PluginCommand[], label?: string): void;

  /** This plugin's own namespaced slot in the document's `meta` map (see core's meta.ts) — persisted, and covered by undo through `set-meta`/`clear-meta` commands. */
  data: {
    get(targetId: EntityId | GroupId): Json | undefined;
    /** Every `targetId -> value` pair this plugin currently has stored. */
    all(): Record<string, Json>;
  };

  notify(level: "info" | "warn" | "error", message: string): void;
}
