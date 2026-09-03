import {
  add,
  circle,
  linearDimensionCommands,
  polyline,
  text,
  type Command,
  type DocumentReadModel,
} from "@sketchor/plugin-sdk";
import type { LayoutOptions, NestResult, PlacedItem, TrailerProfile, ValidationFinding } from "./types";

/**
 * Turns a {@link NestResult} into `Command[]` the host applies as one undo step,
 * and finds the previous run's output so a re-nest can replace it.
 *
 * Everything this plugin draws goes on one dedicated layer, {@link LOAD_PLAN_LAYER}
 * — that layer is the persistence mechanism (`clearPreviousLayout` recovers the
 * prior run from the read-model alone). Each pallet, together with its
 * construction guide, its tag and any dimensions, is one group — and that's the
 * only grouping, so a click selects a single pallet and dragging it snaps to its
 * neighbours (its guide and label move with it).
 */
export const LOAD_PLAN_LAYER = "Load Plan";

/** Construction guides (wall clearance, per-pallet spacing) are white + dashed, no fill. */
const GUIDE_COLOR = "#ffffff";
const EPS = 1e-6;

let idCounter = 0;
function newGroupId(): string {
  idCounter += 1;
  return `tn-g-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function rectPoints(x: number, y: number, length: number, width: number) {
  return [
    { x, y },
    { x: x + length, y },
    { x: x + length, y: y + width },
    { x, y: y + width },
  ];
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
 * Commands that remove whatever the last Auto-nest run drew: every entity on
 * {@link LOAD_PLAN_LAYER}, and any group all of whose members are those entities
 * (or nested groups thereof). Returns `[]` when the layer is empty.
 */
export function clearPreviousLayout(model: DocumentReadModel): Command[] {
  const planEntityIds = new Set(
    model.entities.filter((e) => e.layer === LOAD_PLAN_LAYER).map((e) => e.id),
  );
  if (planEntityIds.size === 0) return [];

  const groupById = new Map(model.groups.map((g) => [g.id, g]));
  const isPlanGroup = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const g = groupById.get(id);
    if (!g || g.members.length === 0) return false;
    return g.members.every((m) => planEntityIds.has(m) || isPlanGroup(m, seen));
  };

  const commands: Command[] = [];
  for (const g of model.groups) if (isPlanGroup(g.id)) commands.push({ type: "ungroup", groupId: g.id });
  commands.push({ type: "delete-entities", ids: [...planEntityIds] });
  return commands;
}

function fmt(mm: number, opts: LayoutOptions): string {
  const per = opts.perMm ?? 1;
  return `${Math.round(mm * per * 10) / 10} ${opts.unitLabel ?? "mm"}`;
}

/** Every command + entity id for one placed pallet, ready to wrap in a group. */
function palletCommands(p: PlacedItem, opts: LayoutOptions): { commands: Command[]; ids: string[] } {
  const commands: Command[] = [];
  const ids: string[] = [];
  const push = (c: Command, id: string) => {
    commands.push(c);
    ids.push(id);
  };

  // The reserved slot (dashed white) when a pallet margin is set.
  if (p.x - p.slotX > EPS) {
    const guide =
      p.shape === "round"
        ? circle({ x: p.slotX + p.slotWidth / 2, y: p.slotY + p.slotWidth / 2 }, p.slotWidth / 2, {
            layer: LOAD_PLAN_LAYER,
            color: GUIDE_COLOR,
            dashed: true,
          })
        : polyline(rectPoints(p.slotX, p.slotY, p.slotLength, p.slotWidth), true, {
            layer: LOAD_PLAN_LAYER,
            color: GUIDE_COLOR,
            dashed: true,
          });
    push(add(guide), guide.id);
  }

  // The pallet itself, hatched in its order colour.
  const shape =
    p.shape === "round"
      ? circle({ x: p.x + p.width / 2, y: p.y + p.width / 2 }, p.width / 2, {
          layer: LOAD_PLAN_LAYER,
          color: p.color,
          fill: p.color,
        })
      : polyline(rectPoints(p.x, p.y, p.length, p.width), true, {
          layer: LOAD_PLAN_LAYER,
          color: p.color,
          fill: p.color,
        });
  push(add(shape), shape.id);

  // Tag text, roughly centred on the pallet.
  if (p.tag && p.tag.trim()) {
    const label = p.tag.trim();
    const h = Math.min(Math.min(p.length, p.width) * 0.13, 70);
    const w = label.length * h * 0.55;
    const t = text({ x: p.x + Math.max(p.length / 2 - w / 2, p.length * 0.06), y: p.y + p.width / 2 - h / 2 }, label, {
      layer: LOAD_PLAN_LAYER,
      color: "#111111",
      height: h,
    });
    push(add(t), t.id);
  }

  // Per-pallet dimensions.
  if (opts.dimensions) {
    const th = Math.min(Math.max(Math.min(p.length, p.width) * 0.08, 18), 45);
    if (p.shape === "round") {
      for (const c of linearDimensionCommands({ x: p.x, y: p.y + p.width / 2 }, { x: p.x + p.width, y: p.y + p.width / 2 }, {
        offset: -th * 2,
        textHeight: th,
        label: `Ø ${fmt(p.width, opts)}`,
        layer: LOAD_PLAN_LAYER,
      })) {
        const id = (c as { entity?: { id: string } }).entity?.id;
        if (id) push(c, id);
      }
    } else {
      const dims = [
        linearDimensionCommands({ x: p.x, y: p.y }, { x: p.x + p.length, y: p.y }, {
          offset: -th * 2,
          textHeight: th,
          label: fmt(p.length, opts),
          layer: LOAD_PLAN_LAYER,
        }),
        linearDimensionCommands({ x: p.x, y: p.y + p.width }, { x: p.x, y: p.y }, {
          offset: -th * 2,
          textHeight: th,
          label: fmt(p.width, opts),
          layer: LOAD_PLAN_LAYER,
        }),
      ];
      for (const set of dims)
        for (const c of set) {
          const id = (c as { entity?: { id: string } }).entity?.id;
          if (id) push(c, id);
        }
    }
  }

  return { commands, ids };
}

/**
 * Draws a nest result. Prepend {@link clearPreviousLayout}, apply as one batch.
 */
export function buildNestLayout(
  result: NestResult,
  opts: LayoutOptions & { findings?: ValidationFinding[] } = {},
): Command[] {
  const commands: Command[] = [trailerOutline(result.trailer)];

  const wall = Math.max(0, result.trailer.wallMargin ?? 0);
  if (wall > EPS) {
    commands.push(
      add(
        polyline(rectPoints(wall, wall, result.trailer.length - 2 * wall, result.trailer.width - 2 * wall), true, {
          layer: LOAD_PLAN_LAYER,
          color: GUIDE_COLOR,
          dashed: true,
        }),
      ),
    );
  }

  // One group per pallet — shape + guide + tag + dimensions. A single group
  // (not nested per order) so a click selects one pallet and dragging it snaps
  // to its neighbours; the guide and label come along because they're in the
  // same group.
  for (const p of result.placed) {
    const { commands: pc, ids } = palletCommands(p, opts);
    commands.push(...pc);
    commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: p.city ? `${p.city} pallet` : "Pallet" });
  }

  // A printable summary block, just past the nose of the trailer.
  const summary = summaryLines(result, opts.findings ?? []);
  if (summary.length > 0) {
    const h = Math.min(result.trailer.width * 0.028, 55);
    summary.forEach((line, i) => {
      commands.push(
        add(
          text({ x: result.trailer.length + h * 2, y: result.trailer.width - i * h * 1.6 }, line, {
            layer: LOAD_PLAN_LAYER,
            color: "#111111",
            height: h,
          }),
        ),
      );
    });
  }

  return commands;
}

function summaryLines(result: NestResult, findings: ValidationFinding[]): string[] {
  const lines: string[] = [`${result.trailer.name} — load plan`];
  const bySeq = new Map<number, { city: string; n: number }>();
  for (const p of result.placed) {
    const e = bySeq.get(p.orderIndex) ?? { city: p.city, n: 0 };
    e.n += 1;
    bySeq.set(p.orderIndex, e);
  }
  lines.push(
    `${result.placed.length} pallets, ${Math.round(result.usedLength)} / ${Math.round(result.trailer.length)} mm used`,
  );
  lines.push("Unload order (first off at the door):");
  for (const [idx, { city, n }] of [...bySeq].sort((a, b) => a[0] - b[0])) {
    lines.push(`  ${idx + 1}. ${city || "—"} — ${n} pallet${n === 1 ? "" : "s"}`);
  }
  for (const f of findings) if (f.level !== "info") lines.push(`! ${f.message}`);
  return lines;
}
