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

/** Construction guides (wall clearance, per-pallet spacing) are drawn white with no fill. */
const GUIDE_COLOR = "#ffffff";
const EPS = 1e-6;

let groupCounter = 0;
function newGroupId(): string {
  groupCounter += 1;
  return `tn-g-${Date.now().toString(36)}-${groupCounter.toString(36)}`;
}

function rectPoints(x: number, y: number, length: number, width: number) {
  return [
    { x, y },
    { x: x + length, y },
    { x: x + length, y: y + width },
    { x, y: y + width },
  ];
}

function palletRect(x: number, y: number, length: number, width: number, color: string) {
  return polyline(rectPoints(x, y, length, width), true, { layer: LOAD_PLAN_LAYER, color, fill: color });
}

function guideRect(x: number, y: number, length: number, width: number) {
  return polyline(rectPoints(x, y, length, width), true, { layer: LOAD_PLAN_LAYER, color: GUIDE_COLOR });
}

function trailerOutline(trailer: TrailerProfile): Command {
  return add(
    polyline(rectPoints(0, 0, trailer.length, trailer.width), true, {
      layer: LOAD_PLAN_LAYER,
      name: `${trailer.name} — outline`,
    }),
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
 * Draws a nest result: a trailer outline, an optional white wall-clearance
 * rectangle, and per placed pallet a hatched shape in its order's colour (plus
 * a white construction rectangle/circle at its reserved slot when a pallet
 * margin is set). Pallets and their guides are grouped per order, named after
 * the city. Prepend {@link clearPreviousLayout}, apply as one batch.
 */
export function buildNestLayout(result: NestResult): Command[] {
  const commands: Command[] = [trailerOutline(result.trailer)];

  const wall = Math.max(0, result.trailer.wallMargin ?? 0);
  if (wall > EPS) {
    commands.push(
      add(guideRect(wall, wall, result.trailer.length - 2 * wall, result.trailer.width - 2 * wall)),
    );
  }

  const byOrder = new Map<string, { city: string; ids: string[] }>();
  const bucket = (orderId: string, city: string) => {
    let b = byOrder.get(orderId);
    if (!b) {
      b = { city, ids: [] };
      byOrder.set(orderId, b);
    }
    return b;
  };

  for (const p of result.placed) {
    const b = bucket(p.orderId, p.city);

    // The pallet's reserved slot, drawn white when it's bigger than the pallet.
    const marginX = p.x - p.slotX;
    if (marginX > EPS) {
      const guide =
        p.shape === "round"
          ? circle({ x: p.slotX + p.slotWidth / 2, y: p.slotY + p.slotWidth / 2 }, p.slotWidth / 2, {
              layer: LOAD_PLAN_LAYER,
              color: GUIDE_COLOR,
            })
          : guideRect(p.slotX, p.slotY, p.slotLength, p.slotWidth);
      commands.push(add(guide));
      b.ids.push(guide.id);
    }

    const shape =
      p.shape === "round"
        ? circle({ x: p.x + p.width / 2, y: p.y + p.width / 2 }, p.width / 2, {
            layer: LOAD_PLAN_LAYER,
            color: p.color,
            fill: p.color,
          })
        : palletRect(p.x, p.y, p.length, p.width, p.color);
    commands.push(add(shape));
    b.ids.push(shape.id);
  }

  for (const { city, ids } of byOrder.values()) {
    if (ids.length === 0) continue;
    commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: city || "Order" });
  }

  return commands;
}
