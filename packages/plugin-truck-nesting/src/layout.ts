import { add, polyline, type Command, type DocumentReadModel } from "@sketchor/plugin-sdk";
import type { NestResult, TrailerProfile } from "./types";

/**
 * Turns a {@link NestResult} into `Command[]` the host applies as one undo step,
 * and finds the previous run's output so a re-nest can replace it.
 *
 * Everything this plugin draws goes on one dedicated layer, {@link LOAD_PLAN_LAYER}.
 * That layer *is* the persistence mechanism: `clearPreviousLayout` recovers the
 * prior layout from the document read-model alone (every entity on the layer,
 * plus the single-entity groups wrapping them), so nothing has to be remembered
 * between sessions and "Clear" works even after a reload. It also keeps the plan
 * one toggle away from being hidden without touching the real drawing.
 */
export const LOAD_PLAN_LAYER = "Load Plan";

let groupCounter = 0;
function newGroupId(): string {
  groupCounter += 1;
  return `tn-g-${Date.now().toString(36)}-${groupCounter.toString(36)}`;
}

/** A closed rectangle polyline, door-relative coordinates, on the load-plan layer. */
function rect(x: number, y: number, length: number, width: number, name: string): Command {
  return add(
    polyline(
      [
        { x, y },
        { x: x + length, y },
        { x: x + length, y: y + width },
        { x, y: y + width },
      ],
      true,
      { name, layer: LOAD_PLAN_LAYER },
    ),
  );
}

function trailerOutline(trailer: TrailerProfile): Command {
  return rect(0, 0, trailer.length, trailer.width, `${trailer.name} — outline`);
}

/**
 * Commands that remove whatever the last Auto-nest run drew: every entity on the
 * {@link LOAD_PLAN_LAYER} layer, and any group all of whose members are those
 * entities (the per-item wrappers this plugin creates). Returns `[]` when the
 * layer is empty, so it's safe to prepend unconditionally.
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
 * Draws a nest result: a trailer outline plus one rectangle per placed item,
 * each wrapped in its own named group ("<label> — stop <n>") so it moves and
 * selects as a unit. Prepend {@link clearPreviousLayout} and apply the whole
 * thing as one batch.
 */
export function buildNestLayout(result: NestResult): Command[] {
  const commands: Command[] = [trailerOutline(result.trailer)];

  for (const p of result.placed) {
    const entity = polyline(
      [
        { x: p.x, y: p.y },
        { x: p.x + p.length, y: p.y },
        { x: p.x + p.length, y: p.y + p.width },
        { x: p.x, y: p.y + p.width },
      ],
      true,
      { name: `${p.label} (stop ${p.stop})`, layer: LOAD_PLAN_LAYER },
    );
    commands.push(add(entity));
    commands.push({
      type: "group-entities",
      groupId: newGroupId(),
      ids: [entity.id],
      name: `${p.label} — stop ${p.stop}`,
    });
  }

  return commands;
}
