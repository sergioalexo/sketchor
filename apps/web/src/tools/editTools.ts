import type { Command, Entity, LineEntity, Point, PolylineEntity } from "@sketchor/core";
import {
  chamferLines,
  dist,
  extendTo,
  filletAllCorners,
  filletLines,
  filletPolylineCorner,
  layerOf,
  newEntityId,
  offsetEntity,
  splitAt,
  trimAt,
} from "@sketchor/core";
import { hiddenLayerSet } from "../state/store";
import { parseLength } from "./typedInput";
import type { Pick, Tool, ToolContext } from "./tool";

/**
 * The geometry-editing tools (roadmap T-15/T-16/T-17): trim/extend, split,
 * fillet, chamfer, offset. The maths is @sketchor/core's intersect.ts,
 * fillet.ts and offset.ts; these classes only pick entities and points and
 * turn the result into one undoable batch (delete the original, add what
 * replaces it).
 */

/** Entities on visible layers — the boundaries trim/extend consider, in AutoCAD's quick-trim spirit (everything counts). */
function visible(ctx: ToolContext): Entity[] {
  const hidden = hiddenLayerSet();
  return ctx.doc.all().filter((e) => !hidden.has(layerOf(e)));
}

/** The visible entity under a world point, if any (group-agnostic — editing works on the piece you clicked). */
function entityAt(ctx: ToolContext, world: Point): Entity | null {
  const ids = ctx.hitTest(world);
  if (ids.length === 0) return null;
  // hitTest expands to the group; the member actually under the cursor is
  // the nearest of them.
  let best: { e: Entity; d: number } | null = null;
  for (const id of ids) {
    const e = ctx.doc.get(id);
    if (!e) continue;
    const d = distanceTo(e, world);
    if (!best || d < best.d) best = { e, d };
  }
  return best?.e ?? null;
}

function distanceTo(e: Entity, p: Point): number {
  // Cheap and good enough to pick among group members: distance to the nearest defining point.
  switch (e.type) {
    case "line":
      return Math.min(dist(p, e.a), dist(p, e.b), pointToSegment(p, e.a, e.b));
    case "circle":
      return Math.abs(dist(p, e.center) - e.radius);
    case "arc":
      return Math.abs(dist(p, e.center) - e.radius);
    case "polyline":
      return Math.min(...e.points.map((q, i) => pointToSegment(p, q, e.points[(i + 1) % e.points.length])));
    default:
      return Infinity;
  }
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return dist(p, { x: a.x + dx * t, y: a.y + dy * t });
}

/** Replaces `original` with `pieces` (fresh ids, names left to the sketch code) in one undo step. */
function replaceWith(ctx: ToolContext, original: Entity, pieces: Entity[]): void {
  const commands: Command[] = [{ type: "delete-entities", ids: [original.id] }];
  for (const p of pieces) {
    const { name: _dropped, ...rest } = p;
    commands.push({ type: "add-entity", entity: { ...rest, id: newEntityId() } as Entity });
  }
  ctx.commit(commands);
}

/* ------------------------------ trim / extend ----------------------------- */

/**
 * Quick trim (AutoCAD 2021+): every visible entity is a cutting edge; click
 * the piece to remove. Shift-click near an end of a line or arc extends it
 * to the first thing in its way instead. Repeats until Esc.
 */
export class TrimTool implements Tool {
  readonly id = "trim" as const;
  private message: string | null = null;

  prompt(): string {
    return this.message ?? "Trim: click the piece to remove (everything visible cuts) — Shift-click near an end to extend it instead";
  }
  busy(): boolean {
    return false;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.message = null;
  }

  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const target = entityAt(ctx, p.world);
    if (!target) return;
    const others = visible(ctx);
    if (p.shiftKey) {
      const extended = extendTo(target, others, p.world);
      if (!extended) {
        this.message = "Nothing in the way to extend to — Shift-click nearer the end that should grow, toward a boundary";
        return;
      }
      ctx.execute({ type: "update-entity", entity: extended });
      return;
    }
    const result = trimAt(target, others, p.world);
    if (!result) {
      this.message = "Nothing cuts this entity here — it needs to cross something to be trimmed";
      return;
    }
    replaceWith(ctx, target, result.pieces);
  }

  preview(): Entity[] {
    return [];
  }
}

/** Split: click a point on an entity to cut it there into two (a circle opens into an arc). */
export class SplitTool implements Tool {
  readonly id = "split" as const;
  prompt(): string {
    return "Split: click the point on a line, arc, circle or polyline where it should be cut";
  }
  busy(): boolean {
    return false;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {}
  pick(ctx: ToolContext, p: Pick): void {
    const target = entityAt(ctx, p.world);
    if (!target) return;
    const pieces = splitAt(target, p.point);
    if (!pieces) return;
    replaceWith(ctx, target, pieces);
  }
  preview(): Entity[] {
    return [];
  }
}

/* --------------------------------- fillet -------------------------------- */

/**
 * Fillet: type the radius (remembered; 0 = corner join), then click two
 * lines — the halves you click on are the halves that stay. Clicking a
 * polyline near a vertex rounds that corner; Enter rounds every corner of
 * the selected polylines.
 */
export class FilletTool implements Tool {
  readonly id = "fillet" as const;
  radius = 0;
  private first: { entity: LineEntity; at: Point } | null = null;
  private message: string | null = null;

  prompt(): string {
    if (this.message) return this.message;
    const r = this.radius > 0 ? `radius ${fmt(this.radius)}` : "radius 0 (sharp corner)";
    if (this.first) return `Fillet (${r}): click the second line on the side to keep — or type a new radius`;
    return `Fillet (${r}): type a radius, then click the first line on the side to keep — or click a polyline corner (Enter rounds every corner of the selected polylines)`;
  }
  busy(): boolean {
    return this.first !== null;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.first = null;
    this.message = null;
  }

  typed(ctx: ToolContext, text: string): boolean {
    const r = parseLength(text, ctx.displayUnit());
    if (r === null || r < 0) return false;
    this.radius = r;
    this.message = null;
    return true;
  }

  key(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey) return false;
    // Round every corner of the selected polylines.
    const targets = ctx
      .selection()
      .map((id) => ctx.doc.get(id))
      .filter((en): en is PolylineEntity => !!en && en.type === "polyline");
    if (targets.length === 0 || this.radius <= 0) {
      this.message = targets.length === 0 ? "Select a polyline first, then Enter rounds all its corners" : "Type a radius first";
      return true;
    }
    ctx.commit(targets.map((pl): Command => ({ type: "update-entity", entity: filletAllCorners(pl, this.radius) })));
    this.message = null;
    return true;
  }

  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const target = entityAt(ctx, p.world);
    if (!target) return;
    if (target.type === "polyline") {
      const vertex = nearestVertex(target, p.world);
      if (vertex === null) return;
      if (this.radius <= 0) {
        this.message = "Type a radius to round a polyline corner";
        return;
      }
      const rounded = filletPolylineCorner(target, vertex, this.radius);
      if (!rounded) {
        this.message = "That corner can't take this radius (leg too short, already an arc, or an open end)";
        return;
      }
      ctx.execute({ type: "update-entity", entity: rounded });
      this.first = null;
      return;
    }
    if (target.type !== "line") {
      this.message = "Fillet works between two lines, or on a polyline corner";
      return;
    }
    if (!this.first) {
      this.first = { entity: target, at: p.world };
      return;
    }
    if (this.first.entity.id === target.id) return;
    const r = filletLines(this.first.entity, target, this.radius, this.first.at, p.world);
    if (!r) {
      this.message = "Can't fillet these: parallel lines, or the radius is too large for them";
      this.first = null;
      return;
    }
    const commands: Command[] = [
      { type: "update-entity", entity: r.line1 },
      { type: "update-entity", entity: r.line2 },
    ];
    if (r.arc) commands.push({ type: "add-entity", entity: { ...r.arc, id: newEntityId() } });
    ctx.commit(commands);
    this.first = null;
  }

  preview(): Entity[] {
    return [];
  }
}

/** Chamfer: type the distance (one value, used on both lines), then click two lines. */
export class ChamferTool implements Tool {
  readonly id = "chamfer" as const;
  distance = 0;
  private first: { entity: LineEntity; at: Point } | null = null;
  private message: string | null = null;

  prompt(): string {
    if (this.message) return this.message;
    const d = `distance ${fmt(this.distance)}`;
    return this.first ? `Chamfer (${d}): click the second line on the side to keep` : `Chamfer (${d}): type a distance, then click the first line on the side to keep`;
  }
  busy(): boolean {
    return this.first !== null;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.first = null;
    this.message = null;
  }
  typed(ctx: ToolContext, text: string): boolean {
    const d = parseLength(text, ctx.displayUnit());
    if (d === null || d < 0) return false;
    this.distance = d;
    this.message = null;
    return true;
  }
  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    const target = entityAt(ctx, p.world);
    if (!target || target.type !== "line") {
      if (target) this.message = "Chamfer works between two lines";
      return;
    }
    if (!this.first) {
      this.first = { entity: target, at: p.world };
      return;
    }
    if (this.first.entity.id === target.id) return;
    if (this.distance <= 0) {
      this.message = "Type a chamfer distance first";
      return;
    }
    const r = chamferLines(this.first.entity, target, this.distance, this.distance, this.first.at, p.world);
    if (!r || !r.chamfer) {
      this.message = "Can't chamfer these: parallel lines, or the distance is too large for them";
      this.first = null;
      return;
    }
    ctx.commit([
      { type: "update-entity", entity: r.line1 },
      { type: "update-entity", entity: r.line2 },
      { type: "add-entity", entity: { ...r.chamfer, id: newEntityId() } },
    ]);
    this.first = null;
  }
  preview(): Entity[] {
    return [];
  }
}

function nearestVertex(pl: PolylineEntity, p: Point): number | null {
  let best = -1;
  let bestD = Infinity;
  pl.points.forEach((q, i) => {
    const d = dist(q, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best >= 0 ? best : null;
}

/* --------------------------------- offset -------------------------------- */

/**
 * Offset: type the distance (remembered), click an entity, then click the
 * side the copy goes on. Repeats until Esc. The preview follows the cursor
 * so the side is obvious before committing.
 */
export class OffsetTool implements Tool {
  readonly id = "offset" as const;
  distance = 0;
  private target: Entity | null = null;
  private message: string | null = null;

  prompt(): string {
    if (this.message) return this.message;
    const d = this.distance > 0 ? `distance ${fmt(this.distance)}` : "no distance yet";
    if (this.target) return `Offset (${d}): click the side the copy goes on`;
    return `Offset (${d}): type the distance, then click the entity to offset`;
  }
  busy(): boolean {
    return this.target !== null;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.target = null;
    this.message = null;
  }
  typed(ctx: ToolContext, text: string): boolean {
    const d = parseLength(text, ctx.displayUnit());
    if (d === null || d <= 0) return false;
    this.distance = d;
    this.message = null;
    return true;
  }
  pick(ctx: ToolContext, p: Pick): void {
    this.message = null;
    if (!this.target) {
      if (this.distance <= 0) {
        this.message = "Type the offset distance first";
        return;
      }
      const e = entityAt(ctx, p.world);
      if (!e) return;
      if (!["line", "circle", "arc", "polyline"].includes(e.type)) {
        this.message = "Offset works on lines, arcs, circles and polylines";
        return;
      }
      this.target = e;
      return;
    }
    const copy = offsetEntity(this.target, this.distance, p.world);
    if (!copy) {
      this.message = "That offset collapses the shape — try a smaller distance or the other side";
      this.target = null;
      return;
    }
    const { name: _dropped, ...rest } = copy;
    ctx.execute({ type: "add-entity", entity: { ...rest, id: newEntityId() } as Entity });
    this.target = null;
  }
  preview(_ctx: ToolContext, cursor: Point | null): Entity[] {
    if (!this.target || !cursor) return [];
    const copy = offsetEntity(this.target, this.distance, cursor);
    return copy ? [{ ...copy, id: "preview" }] : [];
  }
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
