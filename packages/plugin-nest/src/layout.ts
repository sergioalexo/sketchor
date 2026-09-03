import { add, circle, colorAt, polyline, type Command, type DocumentReadModel } from "@sketchor/plugin-sdk";
import { bounds } from "./geometry";
import type { NestResult, Point } from "./types";

/**
 * The nested layout goes on one dedicated layer; that layer is the persistence
 * mechanism (see the truck planner) — `clearPreviousLayout` finds and removes
 * the previous run from the read-model alone.
 */
export const NEST_LAYER = "Nest";

/** Sheets are stacked downward with this gap between them, in mm. */
const SHEET_GAP = 200;

let groupCounter = 0;
function newGroupId(): string {
  groupCounter += 1;
  return `nest-g-${Date.now().toString(36)}-${groupCounter.toString(36)}`;
}

export function clearPreviousLayout(model: DocumentReadModel): Command[] {
  const ids = new Set(model.entities.filter((e) => e.layer === NEST_LAYER).map((e) => e.id));
  if (ids.size === 0) return [];
  const commands: Command[] = [];
  for (const group of model.groups) {
    if (group.members.length > 0 && group.members.every((m) => ids.has(m))) {
      commands.push({ type: "ungroup", groupId: group.id });
    }
  }
  commands.push({ type: "delete-entities", ids: [...ids] });
  return commands;
}

function rectPoly(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/**
 * Draws a nest result: one outline per used sheet (stacked downward) and every
 * placed part as a polyline (or circle for a round part), coloured by sheet and
 * grouped per sheet. Prepend {@link clearPreviousLayout}; apply as one batch.
 */
export function buildNestLayout(result: NestResult): Command[] {
  const commands: Command[] = [];
  const { width: W, height: H } = result.sheet;
  const offsetY = (sheet: number) => sheet * (H + SHEET_GAP);

  const perSheet = new Map<number, string[]>();
  const bucket = (s: number) => {
    let b = perSheet.get(s);
    if (!b) {
      b = [];
      perSheet.set(s, b);
    }
    return b;
  };

  for (let s = 0; s < result.sheetsUsed; s++) {
    const outline = polyline(rectPoly(0, offsetY(s), W, H), true, {
      layer: NEST_LAYER,
      name: `${result.sheet.name || "Sheet"} ${s + 1}`,
    });
    commands.push(add(outline));
    bucket(s).push(outline.id);
  }

  for (const p of result.placed) {
    const color = colorAt(p.sheet);
    const pts = p.polygon.map((q) => ({ x: q.x, y: q.y + offsetY(p.sheet) }));
    let entity;
    if (p.round) {
      const b = bounds(pts);
      entity = circle(
        { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
        Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2,
        { layer: NEST_LAYER, color },
      );
    } else {
      entity = polyline(pts, true, { layer: NEST_LAYER, color });
    }
    commands.push(add(entity));
    bucket(p.sheet).push(entity.id);
  }

  for (const [s, ids] of perSheet) {
    if (ids.length > 0) {
      commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: `${result.sheet.name || "Sheet"} ${s + 1}` });
    }
  }

  return commands;
}
