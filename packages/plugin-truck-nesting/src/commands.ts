import type { Group, Json, PluginCommand, PluginContext } from "@sketchor/plugin-api";
import type { NestResult, TrailerProfile } from "./types";

/** Pulls `entityId` back out of a `{ entityId }` meta value without an unchecked cast. */
function entityIdFrom(value: Json | undefined): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entityId = (value as { [key: string]: Json }).entityId;
  return typeof entityId === "string" ? entityId : null;
}

export const PLUGIN_ID = "com.sergioalexo.truck-nesting";
export const LOAD_PLAN_LAYER = "Load Plan";

/** The document-level marker for the trailer outline entity, so a re-nest can find and remove it without the host having to remember it itself. */
const TRAILER_META_KEY = "__trailer-outline";

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `tn-${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function rectPolyline(id: string, x: number, y: number, length: number, width: number, name: string) {
  return {
    id,
    type: "polyline" as const,
    name,
    layer: LOAD_PLAN_LAYER,
    closed: true,
    points: [
      { x, y },
      { x: x + length, y },
      { x: x + length, y: y + width },
      { x, y: y + width },
    ],
  };
}

function trailerOutlineEntity(id: string, trailer: TrailerProfile) {
  return rectPolyline(id, 0, 0, trailer.length, trailer.width, `${trailer.name} outline`);
}

/**
 * Removes whatever the previous Auto-nest run left in the document,
 * recovered entirely from `ctx.data` and `ctx.doc.groups()` — no state the
 * host needs to remember between sessions, since it's the document's own
 * meta that tracks it (see meta.ts / the roadmap's "documents must hold
 * plugin data" prerequisite).
 */
export function clearPreviousLayout(ctx: PluginContext): PluginCommand[] {
  const commands: PluginCommand[] = [];
  const stored = ctx.data.all();
  const groupsById = new Map<string, Group>(ctx.doc.groups().map((g) => [g.id, g]));

  const entityIds: string[] = [];
  const groupIds: string[] = [];

  for (const [targetId, value] of Object.entries(stored)) {
    if (targetId === TRAILER_META_KEY) {
      const entityId = entityIdFrom(value);
      if (entityId) entityIds.push(entityId);
      commands.push({ type: "clear-meta", pluginId: PLUGIN_ID, targetId });
      continue;
    }
    const group = groupsById.get(targetId);
    if (group) {
      groupIds.push(targetId);
      for (const member of group.members) entityIds.push(member);
    }
    commands.push({ type: "clear-meta", pluginId: PLUGIN_ID, targetId });
  }

  for (const groupId of groupIds) commands.push({ type: "ungroup", groupId });
  if (entityIds.length > 0) commands.push({ type: "delete-entities", ids: entityIds });

  return commands;
}

/**
 * Writes a nest result into the document: one rectangle + one group per
 * placed item — "each item is a group", per the roadmap, from the start —
 * carrying the plugin's own meta (stop, weight, rotation), plus a trailer
 * outline, all in one undoable batch alongside whatever `clearPreviousLayout` produced.
 */
export function buildNestCommands(result: NestResult): PluginCommand[] {
  const commands: PluginCommand[] = [];

  const trailerEntityId = newId("trailer");
  commands.push({ type: "add-entity", entity: trailerOutlineEntity(trailerEntityId, result.trailer) });
  commands.push({
    type: "set-meta",
    pluginId: PLUGIN_ID,
    targetId: TRAILER_META_KEY,
    value: { entityId: trailerEntityId },
  });

  for (const p of result.placed) {
    const entityId = newId("e");
    const groupId = newId("g");
    commands.push({ type: "add-entity", entity: rectPolyline(entityId, p.x, p.y, p.length, p.width, `${p.label} (stop ${p.stop})`) });
    commands.push({ type: "group-entities", groupId, ids: [entityId], name: `${p.label} — stop ${p.stop}` });
    commands.push({
      type: "set-meta",
      pluginId: PLUGIN_ID,
      targetId: groupId,
      value: {
        instanceId: p.instanceId,
        itemId: p.itemId,
        label: p.label,
        stop: p.stop,
        weightKg: p.weightKg,
        rotated: p.rotated,
      },
    });
  }

  return commands;
}
