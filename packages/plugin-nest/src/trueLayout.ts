import { translated, type Entity } from "@sketchor/core";
import { add, polyline, text, type Command, type DocumentReadModel } from "@sketchor/plugin-sdk";
import { extractParts } from "./partExtraction";
import { polygonsClash } from "./geometry";
import { NEST_LAYER, newGroupId, rectPoly } from "./layout";
import type { TrueNestSheet } from "./trueNest";

/**
 * Canvas output for the true-shape engine (N-21) — mirrors `layout.ts`'s
 * `buildNestLayout` (same `NEST_LAYER`, same stack-sheets-downward,
 * bucket-then-group convention), but draws each placement from its
 * `materializeInstance()` output instead of a baked polygon, so real arcs
 * make it onto the canvas, and titles each sheet.
 */

/** Sheets are stacked downward with this gap between them, in mm — matches `layout.ts`'s own convention (kept as a separate constant since the two layouts are otherwise independent). */
const SHEET_GAP = 200;

export interface SheetPlacementEntities {
  sheet: number;
  /** Already `materializeInstance()`-transformed and already positioned within the sheet (x/y in `[0,width]x[0,height]`) — only the cross-sheet stacking offset is still needed. */
  entities: Entity[];
}

function sheetOffsets(sheets: TrueNestSheet[]): number[] {
  const offsets: number[] = [];
  let y = 0;
  for (const sheet of sheets) {
    offsets.push(y);
    y += sheet.height + SHEET_GAP;
  }
  return offsets;
}

/**
 * Draws the nested layout: one titled outline per sheet plus every placed
 * part's real, materialized geometry, each sheet grouped. Prepend
 * `clearPreviousLayout` (from `layout.ts`, reusable as-is); apply as one batch.
 */
export function buildTrueNestLayout(
  sheets: TrueNestSheet[],
  placements: SheetPlacementEntities[],
  sheetLabel: (sheet: TrueNestSheet, index: number) => string,
): Command[] {
  const commands: Command[] = [];
  const offsets = sheetOffsets(sheets);

  const perSheet = new Map<number, string[]>();
  const bucket = (s: number): string[] => {
    let b = perSheet.get(s);
    if (!b) {
      b = [];
      perSheet.set(s, b);
    }
    return b;
  };

  sheets.forEach((sheet, i) => {
    const offsetY = offsets[i];
    const label = sheetLabel(sheet, i);
    const outline = polyline(rectPoly(0, offsetY, sheet.width, sheet.height), true, { layer: NEST_LAYER, name: label });
    commands.push(add(outline));
    bucket(i).push(outline.id);
    const title = text({ x: 0, y: offsetY - 12 }, label, { layer: NEST_LAYER, height: 10 });
    commands.push(add(title));
    bucket(i).push(title.id);
  });

  for (const group of placements) {
    const offsetY = offsets[group.sheet] ?? 0;
    for (const entity of group.entities) {
      const shifted = { ...translated(entity, 0, offsetY), layer: NEST_LAYER };
      commands.push(add(shifted));
      bucket(group.sheet).push(shifted.id);
    }
  }

  for (const [s, ids] of perSheet) {
    if (ids.length > 0) {
      commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: sheetLabel(sheets[s], s) });
    }
  }

  return commands;
}

/**
 * "Check nest": after a manual drag, re-examines every sheet group on the
 * `Nest` layer for parts that now overlap. Re-extracts each group's own
 * shapes with `extractParts` (the same containment-aware loop detection
 * N-01 uses) rather than assuming the drag preserved anything about how the
 * parts were originally placed.
 *
 * A sheet's group always contains the sheet outline itself, which — being
 * the one shape that legitimately *contains* every placed part — comes back
 * from `extractParts` as a single top-level "part" with every real placed
 * part as its `holes` (that containment is correct and expected, not a
 * defect). So the pairwise check runs over each part's `holes` (the real
 * placed shapes), not the top-level parts themselves; a part with no holes
 * contributes its own outer (covers the rare group with nothing placed in
 * it, or a placed part's own inner hole surfacing as its own entry).
 */
export function checkNestOverlaps(model: DocumentReadModel): { groupName: string }[] {
  const issues: { groupName: string }[] = [];
  const entityIds = new Set(model.entities.filter((e) => e.layer === NEST_LAYER).map((e) => e.id));
  for (const group of model.groups) {
    if (group.members.length === 0 || !group.members.every((id) => entityIds.has(id))) continue;
    const memberSet = new Set(group.members);
    const memberEntities = model.entities.filter((e) => memberSet.has(e.id));
    const parts = extractParts(memberEntities, memberSet);
    const shapes = parts.flatMap((part) => (part.holes.length > 0 ? part.holes : [part.outer]));

    let clashed = false;
    for (let i = 0; i < shapes.length && !clashed; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        if (polygonsClash(shapes[i], shapes[j], 0)) {
          clashed = true;
          break;
        }
      }
    }
    if (clashed) issues.push({ groupName: group.name ?? group.id });
  }
  return issues;
}
