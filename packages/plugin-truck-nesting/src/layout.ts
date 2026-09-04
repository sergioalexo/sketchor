import {
  add,
  circle,
  polyline,
  text,
  type Command,
  type DocumentReadModel,
  type Entity,
} from "@sketchor/plugin-sdk";
import type { LayoutOptions, NestResult, PalletShape, PlacedItem, TrailerProfile, ValidationFinding } from "./types";

/**
 * Turns a {@link NestResult} into `Command[]` the host applies as one undo step,
 * and finds the previous run's output so a re-nest can replace it.
 *
 * Everything this plugin draws goes on two dedicated layers: {@link LOAD_PLAN_LAYER}
 * for the pallets, tags, dimensions and summary, and {@link LOAD_PLAN_GUIDE_LAYER}
 * for the dashed wall-clearance and per-pallet margin guides — kept apart so the
 * margins can be hidden/shown from the Layers panel without touching the plan
 * (their visibility survives a re-nest). Those layers are also the persistence
 * mechanism: `clearPreviousLayout` recovers the prior run from the read-model
 * alone. Each pallet, together with its guide, tag and any dimensions, is one
 * group — the only grouping — so a click selects a single pallet and dragging it
 * snaps to its neighbours (its guide and label move with it).
 */
export const LOAD_PLAN_LAYER = "Load Plan";

/** The dashed construction guides live on their own layer so they can be toggled off. */
export const LOAD_PLAN_GUIDE_LAYER = "Load Plan — margins";

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

/**
 * The trailer outline and its wall-clearance guide, grouped as one unit — so
 * a drag can't accidentally separate "the truck" from its construction wall.
 * No group is created when there's no wall margin (nothing to keep together).
 */
function trailerOutlineCommands(trailer: TrailerProfile): { commands: Command[]; ids: string[] } {
  const commands: Command[] = [];
  const ids: string[] = [];

  const outline = polyline(rectPoints(0, 0, trailer.length, trailer.width), true, {
    layer: LOAD_PLAN_LAYER,
    name: `${trailer.name} — outline`,
  });
  commands.push(add(outline));
  ids.push(outline.id);

  const wall = Math.max(0, trailer.wallMargin ?? 0);
  if (wall > EPS) {
    const guide = polyline(rectPoints(wall, wall, trailer.length - 2 * wall, trailer.width - 2 * wall), true, {
      layer: LOAD_PLAN_GUIDE_LAYER,
      color: GUIDE_COLOR,
      dashed: true,
      name: NAME_GUIDE,
    });
    commands.push(add(guide));
    ids.push(guide.id);
  }

  if (ids.length > 1) {
    commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: `${trailer.name} — outline` });
  }
  return { commands, ids };
}

/** The layers this plugin owns — a re-nest wipes everything on them. */
const PLAN_LAYERS = new Set<string>([LOAD_PLAN_LAYER, LOAD_PLAN_GUIDE_LAYER]);

/**
 * Commands that remove whatever the last Auto-nest run drew: every entity on a
 * {@link PLAN_LAYERS} layer, and any group all of whose members are those
 * entities (or nested groups thereof). Returns `[]` when they're empty.
 */
export function clearPreviousLayout(model: DocumentReadModel): Command[] {
  const planEntityIds = new Set(
    model.entities.filter((e) => e.layer !== undefined && PLAN_LAYERS.has(e.layer)).map((e) => e.id),
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

/**
 * Marker names stamped on entities this plugin draws, so a later pass (e.g.
 * {@link setDimensionsOnLayout}) can find "the pallet shape" or "the
 * dimension entities" inside a group without re-running the nest solver —
 * which matters because that solver run is exactly what would discard a
 * pallet the user has manually dragged.
 */
const NAME_SHAPE = "pallet-shape";
const NAME_DIM = "pallet-dim";
const NAME_LABEL = "pallet-label";
/** The big item-number label specifically — kept apart from NAME_LABEL (city/tag) so it can be found unambiguously by {@link readLivePlacements}, even if a city or tag happens to look numeric. */
const NAME_NUMBER = "pallet-number";
const NAME_GUIDE = "pallet-guide";

/** "City, ST" (or whichever half is present) — the destination shown on a pallet and in print. */
function cityState(p: { city: string; state: string }): string {
  return [p.city?.trim(), p.state?.trim()].filter(Boolean).join(", ");
}

interface PalletGeometry {
  x: number;
  y: number;
  length: number;
  width: number;
  shape: PalletShape;
}

/** Recovers a placed pallet's current footprint from its drawn shape entity — including any manual drag since it was nested. */
function geometryFromShapeEntity(e: Entity): PalletGeometry | null {
  if (e.type === "circle") {
    const d = e.radius * 2;
    return { x: e.center.x - e.radius, y: e.center.y - e.radius, length: d, width: d, shape: "round" };
  }
  if (e.type === "polyline" && e.points.length >= 3) {
    const [p0, p1, p2] = e.points;
    return { x: p0.x, y: p0.y, length: p1.x - p0.x, width: p2.y - p1.y, shape: "rect" };
  }
  return null;
}

/**
 * A pallet's dimensions as plain small numbers beside each edge — no
 * extension lines, no arrowheads, just the value, so it doesn't compete with
 * the item number for attention or clutter a tightly-packed plan.
 */
function dimensionEntitiesFor(geo: PalletGeometry, opts: LayoutOptions): { commands: Command[]; ids: string[] } {
  const commands: Command[] = [];
  const ids: string[] = [];
  const push = (c: Command, id: string) => {
    commands.push(c);
    ids.push(id);
  };
  const h = Math.min(Math.max(Math.min(geo.length, geo.width) * 0.07, 12), 30);
  const gap = h * 0.4;
  const label = (at: { x: number; y: number }, str: string) => {
    const t = text(at, str, { layer: LOAD_PLAN_LAYER, color: "#111111", height: h, name: NAME_DIM });
    push(add(t), t.id);
  };

  if (geo.shape === "round") {
    label({ x: geo.x + geo.width + gap, y: geo.y + geo.width / 2 - h / 2 }, `Ø${fmt(geo.width, opts)}`);
  } else {
    const lengthStr = fmt(geo.length, opts);
    const lengthW = lengthStr.length * h * 0.55;
    label({ x: geo.x + geo.length / 2 - lengthW / 2, y: geo.y - h - gap }, lengthStr); // below the bottom edge
    label({ x: geo.x + geo.length + gap, y: geo.y + geo.width / 2 - h / 2 }, fmt(geo.width, opts)); // beside the right edge
  }
  return { commands, ids };
}

/** Every command + entity id for one placed pallet, ready to wrap in a group. */
function palletCommands(p: PlacedItem, itemNumber: number, opts: LayoutOptions): { commands: Command[]; ids: string[] } {
  const commands: Command[] = [];
  const ids: string[] = [];
  const push = (c: Command, id: string) => {
    commands.push(c);
    ids.push(id);
  };

  // The reserved slot (dashed white) when a pallet margin is set — on the
  // margins layer so it can be hidden without touching the pallet.
  if (p.x - p.slotX > EPS) {
    const guide =
      p.shape === "round"
        ? circle({ x: p.slotX + p.slotWidth / 2, y: p.slotY + p.slotWidth / 2 }, p.slotWidth / 2, {
            layer: LOAD_PLAN_GUIDE_LAYER,
            color: GUIDE_COLOR,
            dashed: true,
            name: NAME_GUIDE,
          })
        : polyline(rectPoints(p.slotX, p.slotY, p.slotLength, p.slotWidth), true, {
            layer: LOAD_PLAN_GUIDE_LAYER,
            color: GUIDE_COLOR,
            dashed: true,
            name: NAME_GUIDE,
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
          name: NAME_SHAPE,
        })
      : polyline(rectPoints(p.x, p.y, p.length, p.width), true, {
          layer: LOAD_PLAN_LAYER,
          color: p.color,
          fill: p.color,
          name: NAME_SHAPE,
        });
  push(add(shape), shape.id);

  // A big item number is the primary, always-legible label — city/tag text
  // gets too small to read once the trailer is zoomed to fit the view, so the
  // number is what you actually read on screen. The printed pallet table
  // uses this same number so the plan and the table cross-reference
  // directly. City (where it goes) and tag stack below it, smaller.
  const numH = Math.min(Math.min(p.length, p.width) * 0.35, 160);
  const smallH = Math.min(Math.min(p.length, p.width) * 0.13, 70);
  const dest = cityState(p);
  const lines: { text: string; height: number; name: string }[] = [
    { text: String(itemNumber), height: numH, name: NAME_NUMBER },
  ];
  if (dest) lines.push({ text: dest, height: smallH, name: NAME_LABEL });
  if (p.tag?.trim()) lines.push({ text: p.tag.trim(), height: smallH, name: NAME_LABEL });

  const lineGaps = lines.map((l) => l.height * 1.25);
  const blockH = lineGaps.reduce((a, b) => a + b, 0);
  let cursorY = p.y + p.width / 2 - blockH / 2;
  lines.forEach((l, i) => {
    const w = l.text.length * l.height * 0.55;
    const t = text(
      { x: p.x + Math.max(p.length / 2 - w / 2, p.length * 0.06), y: cursorY + lineGaps[i] / 2 - l.height / 2 },
      l.text,
      { layer: LOAD_PLAN_LAYER, color: "#111111", height: l.height, name: l.name },
    );
    push(add(t), t.id);
    cursorY += lineGaps[i];
  });

  // Per-pallet dimensions.
  if (opts.dimensions) {
    const { commands: dimCommands, ids: dimIds } = dimensionEntitiesFor(p, opts);
    for (let i = 0; i < dimCommands.length; i++) push(dimCommands[i], dimIds[i]);
  }

  return { commands, ids };
}

/**
 * Adds or removes the per-pallet dimension overlay on an already-drawn plan,
 * *without* re-running the nest solver — so pallets the user has manually
 * dragged stay exactly where they put them. Reads each pallet's current
 * footprint straight off its drawn shape entity rather than a stale
 * {@link NestResult}. Apply the returned commands as one batch.
 */
export function setDimensionsOnLayout(model: DocumentReadModel, dimensions: boolean, opts: LayoutOptions): Command[] {
  const commands: Command[] = [];
  const entityById = new Map(model.entities.map((e) => [e.id, e]));

  for (const g of model.groups) {
    const memberEntities = g.members.map((m) => entityById.get(m)).filter((e): e is Entity => e !== undefined);
    if (memberEntities.length === 0) continue;
    if (!memberEntities.every((e) => e.layer !== undefined && PLAN_LAYERS.has(e.layer))) continue; // not one of ours

    const shapeEntity = memberEntities.find((e) => e.name === NAME_SHAPE);
    if (!shapeEntity) continue;
    const dimEntities = memberEntities.filter((e) => e.name === NAME_DIM);
    if (dimensions === dimEntities.length > 0) continue; // already matches

    if (!dimensions) {
      commands.push({ type: "ungroup", groupId: g.id });
      commands.push({ type: "delete-entities", ids: dimEntities.map((e) => e.id) });
      const dimIds = new Set(dimEntities.map((e) => e.id));
      commands.push({ type: "group-entities", groupId: g.id, ids: g.members.filter((m) => !dimIds.has(m)), name: g.name });
    } else {
      const geo = geometryFromShapeEntity(shapeEntity);
      if (!geo) continue;
      const { commands: dimCommands, ids: dimIds } = dimensionEntitiesFor(geo, opts);
      commands.push(...dimCommands);
      commands.push({ type: "ungroup", groupId: g.id });
      commands.push({ type: "group-entities", groupId: g.id, ids: [...g.members, ...dimIds], name: g.name });
    }
  }

  return commands;
}

/**
 * Draws a nest result. Prepend {@link clearPreviousLayout}, apply as one batch.
 */
export function buildNestLayout(
  result: NestResult,
  opts: LayoutOptions & { findings?: ValidationFinding[] } = {},
): Command[] {
  const commands: Command[] = [...trailerOutlineCommands(result.trailer).commands];

  // DOOR (x = 0, where the load unloads from) and NOSE (x = length, against
  // the cab) — orientation is otherwise implicit in the plan.
  const endLabelH = Math.min(result.trailer.width * 0.05, 90);
  const endLabel = (atX: number, str: string, alignRight: boolean) => {
    const w = str.length * endLabelH * 0.6;
    commands.push(
      add(
        text({ x: alignRight ? atX - w : atX, y: result.trailer.width + endLabelH * 0.4 }, str, {
          layer: LOAD_PLAN_LAYER,
          color: "#111111",
          height: endLabelH,
        }),
      ),
    );
  };
  endLabel(0, "DOOR", false);
  endLabel(result.trailer.length, "NOSE", true);

  // One group per pallet — shape + guide + tag + dimensions. A single group
  // (not nested per order) so a click selects one pallet and dragging it snaps
  // to its neighbours; the guide and label come along because they're in the
  // same group.
  result.placed.forEach((p, i) => {
    const { commands: pc, ids } = palletCommands(p, i + 1, opts);
    commands.push(...pc);
    const dest = cityState(p);
    commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: `#${i + 1}${dest ? ` — ${dest}` : ""}` });
  });

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

/**
 * Reconciles a solved {@link NestResult} against the *current* drawing —
 * picking up any manual drag the user made on the canvas after Auto-nest ran,
 * so a print (or any other consumer) reflects what's actually on screen
 * rather than the stale solver output. Pairs each placed item with its drawn
 * group by the rendered item number ({@link NAME_NUMBER}), not array order,
 * because {@link setDimensionsOnLayout}'s ungroup+regroup can reorder
 * `model.groups` without touching any pallet's position.
 */
export function readLivePlacements(model: DocumentReadModel, result: NestResult): PlacedItem[] {
  const entityById = new Map(model.entities.map((e) => [e.id, e]));
  const byNumber = new Map<number, PalletGeometry>();

  for (const g of model.groups) {
    const members = g.members.map((m) => entityById.get(m)).filter((e): e is Entity => e !== undefined);
    if (members.length === 0 || !members.every((e) => e.layer !== undefined && PLAN_LAYERS.has(e.layer))) continue;

    const shapeEntity = members.find((e) => e.name === NAME_SHAPE);
    const numberEntity = members.find((e) => e.name === NAME_NUMBER);
    if (!shapeEntity || !numberEntity || numberEntity.type !== "text") continue;

    const n = Number(numberEntity.text);
    if (!Number.isFinite(n)) continue;
    const geo = geometryFromShapeEntity(shapeEntity);
    if (geo) byNumber.set(n, geo);
  }

  return result.placed.map((p, i) => {
    const geo = byNumber.get(i + 1);
    return geo ? { ...p, x: geo.x, y: geo.y, length: geo.length, width: geo.width } : p;
  });
}
