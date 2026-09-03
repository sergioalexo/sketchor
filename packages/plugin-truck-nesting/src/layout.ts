import { add, circle, polyline, type Command, type DocumentReadModel } from "@sketchor/plugin-sdk";
import type { NestResult, TrailerProfile } from "./types";

/**
 * Turns a {@link NestResult} into `Command[]` the host applies as one undo step,
 * and finds the previous run's output so a re-nest can replace it.
 *
 * Everything this plugin draws goes on one dedicated layer, {@link LOAD_PLAN_LAYER}.
 * That layer *is* the persistence mechanism: `clearPreviousLayout` recovers the
 * prior layout from the document read-model alone (every entity on the layer,
 * plus the per-order groups wrapping them), so nothing has to be remembered
 * between sessions and "Clear" works even after a reload.
 */
export const LOAD_PLAN_LAYER = "Load Plan";

let groupCounter = 0;
function newGroupId(): string {
  groupCounter += 1;
  return `tn-g-${Date.now().toString(36)}-${groupCounter.toString(36)}`;
}

function rectEntity(x: number, y: number, length: number, width: number, color: string) {
  return polyline(
    [
      { x, y },
      { x: x + length, y },
      { x: x + length, y: y + width },
      { x, y: y + width },
    ],
    true,
    { layer: LOAD_PLAN_LAYER, color, fill: color },
  );
}

function trailerOutline(trailer: TrailerProfile): Command {
  return add(
    polyline(
      [
        { x: 0, y: 0 },
        { x: trailer.length, y: 0 },
        { x: trailer.length, y: trailer.width },
        { x: 0, y: trailer.width },
      ],
      true,
      { layer: LOAD_PLAN_LAYER, name: `${trailer.name} — outline` },
    ),
  );
}

/**
 * Commands that remove whatever the last Auto-nest run drew: every entity on the
 * {@link LOAD_PLAN_LAYER} layer, and any group all of whose members are those
 * entities (the per-order wrappers). Returns `[]` when the layer is empty.
 */
export function clearPreviousLayout(model: DocumentReadModel): Command[] {
  const planEntityIds = new Set(
    model.entities.filter((e) => e.layer === LOAD_PLAN_LAYER).map((e) => e.id),
  );
  if (planEntityIds.size === 0) return [];

  const commands: Command[] = [];
  for (const group of model.groups) {
    if (group.members.length > 0 && group.members.every((m) => planEntityIds.has(m))) {
      commands.push({ type: "ungroup", groupId: group.id });
    }
  }
  commands.push({ type: "delete-entities", ids: [...planEntityIds] });
  return commands;
}

/**
 * Draws a nest result: a trailer outline plus one hatched shape per placed
 * pallet (a rectangle, or a circle for a round pallet), coloured by its order
 * and wrapped — per order — in a group named after the city, so a whole drop
 * moves and selects as a unit. Prepend {@link clearPreviousLayout}, apply as one
 * batch.
 */
export function buildNestLayout(result: NestResult): Command[] {
  const commands: Command[] = [trailerOutline(result.trailer)];

  // Entity ids collected per order, in unload sequence, for the group wrappers.
  const byOrder = new Map<string, { city: string; ids: string[] }>();

  for (const p of result.placed) {
    const entity =
      p.shape === "round"
        ? circle({ x: p.x + p.width / 2, y: p.y + p.width / 2 }, p.width / 2, {
            layer: LOAD_PLAN_LAYER,
            color: p.color,
            fill: p.color,
          })
        : rectEntity(p.x, p.y, p.length, p.width, p.color);
    commands.push(add(entity));

    const bucket = byOrder.get(p.orderId) ?? { city: p.city, ids: [] };
    bucket.ids.push(entity.id);
    byOrder.set(p.orderId, bucket);
  }

  for (const { city, ids } of byOrder.values()) {
    if (ids.length === 0) continue;
    commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: city || "Order" });
  }

  return commands;
}
