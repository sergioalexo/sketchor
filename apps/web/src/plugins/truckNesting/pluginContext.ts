import type { Command as CoreCommand } from "@sketchor/core";
import type { Entity as PluginEntity, PluginCommand, PluginContext } from "@sketchor/plugin-api";
import { bus, doc, useApp } from "../../state/store";

/**
 * The host-side half of the plugin boundary (roadmap step 3: "wired in
 * through a temporary hardcoded array in App.tsx"). This is exactly the
 * seam the roadmap's "one call that matters" describes: the plugin only
 * ever produces `PluginCommand` values; this adapter is the one place
 * that translates them into real `CommandBus` calls. When plugins move
 * into a Worker (v0.12), this file's shape barely changes — only how the
 * commands arrive (postMessage instead of a function call) does.
 */

/** Explicit, exhaustive translation — not a cast — so a new `PluginCommand` variant fails to compile here until this function knows what to do with it. */
function toCoreCommand(command: PluginCommand): CoreCommand {
  switch (command.type) {
    case "add-entity":
      return { type: "add-entity", entity: command.entity };
    case "delete-entities":
      return { type: "delete-entities", ids: command.ids };
    case "group-entities":
      return {
        type: "group-entities",
        groupId: command.groupId,
        ids: command.ids,
        name: command.name,
        parent: command.parent,
      };
    case "ungroup":
      return { type: "ungroup", groupId: command.groupId };
    case "set-meta":
      return { type: "set-meta", pluginId: command.pluginId, targetId: command.targetId, value: command.value };
    case "clear-meta":
      return { type: "clear-meta", pluginId: command.pluginId, targetId: command.targetId };
    case "batch":
      return { type: "batch", commands: command.commands.map(toCoreCommand) };
  }
}

/**
 * Builds a `PluginContext` backed by the app's single active document
 * session. Cheap to call repeatedly (e.g. once per panel render) since it
 * only closes over the store's already-proxied `doc`/`bus`.
 */
export function createTruckNestingContext(
  pluginId: string,
  onNotify: (level: "info" | "warn" | "error", message: string) => void,
): PluginContext {
  return {
    doc: {
      entities: () => doc.all().filter((e): e is PluginEntity => e.type === "polyline"),
      groups: () => doc.groups(),
      get: (id) => {
        const entity = doc.get(id);
        return entity && entity.type === "polyline" ? entity : null;
      },
    },
    selection: () => useApp.getState().selection,
    execute: (commands, label) => {
      const converted = commands.map(toCoreCommand);
      if (converted.length === 1) bus.execute(converted[0]);
      else if (converted.length > 1) bus.execute({ type: "batch", commands: converted });
      void label; // no undo-label UI yet — see CommandBus; kept in the signature for when there is one
    },
    data: {
      get: (targetId) => doc.getMeta(pluginId, targetId),
      all: () => doc.metaFor(pluginId),
    },
    notify: onNotify,
  };
}
