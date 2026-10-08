import type { Entity, HatchEntity, HatchLoop, HatchPaint, Point } from "@sketchor/core";
import { boundaryFromObjects, detectBoundary, ensurePatternRecord, newEntityId, nextEntityName } from "@sketchor/core";
import { selectableEntities, useApp, type HatchSettings } from "../state/store";
import { layerProp, type Pick, type Tool, type ToolContext } from "./tool";

/**
 * The Hatch tool (H-04). Three modes, chosen in the Hatch panel:
 *  - point: click inside a region — the smallest closed region around the
 *    click, with the islands inside it, is hatched (`detectBoundary`, which
 *    handles T-junctions and bridges gaps up to the panel's gap tolerance).
 *    Shift+click collects several regions into one hatch, committed with
 *    Enter or the next plain click.
 *  - objects: click boundary objects, then Enter (or use the selection).
 *  - match: click an existing hatch to copy its paint into the panel.
 * The region under the cursor is previewed before the click.
 */

export function paintFromSettings(s: HatchSettings): HatchPaint {
  if (s.kind === "solid") return { kind: "solid", color: s.solidColor };
  if (s.kind === "gradient") return { kind: "gradient", name: s.gradientName, colors: [s.gradientColors[0], s.gradientColors[1]], angle: s.gradientAngle };
  return { kind: "pattern", name: s.pattern, scale: s.scale, angle: s.angle };
}

/** Panel settings that reproduce an existing hatch's paint. */
export function settingsFromHatch(h: HatchEntity): Partial<HatchSettings> {
  const p = h.paint;
  const base = { style: h.style };
  if (p.kind === "solid") return { ...base, kind: "solid", solidColor: p.color };
  if (p.kind === "gradient") return { ...base, kind: "gradient", gradientName: p.name, gradientColors: [p.colors[0], p.colors[1] ?? "#ffffff"], gradientAngle: p.angle };
  return { ...base, kind: "pattern", pattern: p.name, scale: p.scale, angle: p.angle };
}

const PREVIEW_ID = "__hatch_preview__";
/** More entities than this and the live preview is skipped (the click still works). */
const PREVIEW_ENTITY_LIMIT = 4000;

export class HatchTool implements Tool {
  readonly id = "fill" as const;
  private pending: { loops: HatchLoop[]; sources: string[] } | null = null;
  private objects: Entity[] = [];
  private cache: { x: number; y: number; rev: number; at: number; cost: number; result: { loops: HatchLoop[]; sources: string[] } | null } | null = null;

  private settings(): HatchSettings {
    return useApp.getState().hatchSettings;
  }

  prompt(): string {
    const s = this.settings();
    if (s.mode === "match") return "Match hatch: click an existing hatch to copy its pattern, scale and angle";
    if (s.mode === "objects") return this.objects.length ? `Hatch: ${this.objects.length} object(s) picked — click more, Enter to hatch, Esc to cancel` : "Hatch: click boundary objects (or select some first), then Enter";
    return this.pending ? "Hatch: Shift+click adds regions, click or Enter to create the hatch" : "Hatch: click inside a closed region (Shift+click collects several)";
  }
  busy(): boolean {
    return this.pending !== null || this.objects.length > 0;
  }
  anchor(): Point | null {
    return null;
  }
  cancel(): void {
    this.pending = null;
    this.objects = [];
    this.cache = null;
  }

  private make(ctx: ToolContext, loops: HatchLoop[], sources: string[], id: string): HatchEntity {
    const s = this.settings();
    return {
      id,
      type: "hatch",
      name: id === PREVIEW_ID ? undefined : nextEntityName(ctx.doc, "hatch"),
      ...layerProp(ctx.activeLayer()),
      loops,
      paint: paintFromSettings(s),
      style: s.style,
      ...(sources.length ? { sources } : {}),
      ...(sources.length && s.associative ? { associative: true } : {}),
    } as HatchEntity;
  }

  private commit(ctx: ToolContext, found: { loops: HatchLoop[]; sources: string[] }): void {
    const entity = this.make(ctx, found.loops, found.sources, newEntityId());
    // A pattern outside the built-in library travels with the drawing (H-06).
    const record = entity.paint.kind === "pattern" ? ensurePatternRecord(ctx.doc, entity.paint.name) : null;
    ctx.execute(record ? { type: "batch", commands: [record, { type: "add-entity", entity }] } : { type: "add-entity", entity });
    this.pending = null;
    this.objects = [];
    this.cache = null;
  }

  private regionAt(ctx: ToolContext, p: Point): { loops: HatchLoop[]; sources: string[] } | null {
    return detectBoundary(selectableEntities(), p, { gapTol: this.settings().gapTol });
  }

  pick(ctx: ToolContext, p: Pick): void {
    const s = this.settings();
    if (s.mode === "match") {
      const hit = ctx.hitTest(p.world).map((id) => ctx.doc.get(id)).find((e) => e?.type === "hatch");
      if (hit && hit.type === "hatch") useApp.getState().setHatchSettings({ ...settingsFromHatch(hit), mode: "point" });
      return;
    }
    if (s.mode === "objects") {
      const sel = this.objects.length === 0 && ctx.selection().length > 0 ? ctx.selection().map((id) => ctx.doc.get(id)).filter((e): e is Entity => !!e) : [];
      if (sel.length) this.objects = sel;
      const hit = ctx.hitTest(p.world).map((id) => ctx.doc.get(id)).filter((e): e is Entity => !!e && e.type !== "hatch");
      for (const e of hit) if (!this.objects.some((o) => o.id === e.id)) this.objects.push(e);
      return;
    }
    const found = this.regionAt(ctx, p.point);
    if (!found) return;
    if (p.shiftKey) {
      this.pending = this.pending ? { loops: [...this.pending.loops, ...found.loops], sources: [...new Set([...this.pending.sources, ...found.sources])] } : found;
      return;
    }
    this.commit(ctx, this.pending ? { loops: [...this.pending.loops, ...found.loops], sources: [...new Set([...this.pending.sources, ...found.sources])] } : found);
  }

  key(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key === "Enter" && this.busy()) {
      if (this.pending) this.commit(ctx, this.pending);
      else {
        const res = boundaryFromObjects(this.objects, { gapTol: this.settings().gapTol });
        if (res) this.commit(ctx, res);
        else this.cancel();
      }
      return true;
    }
    return false;
  }

  preview(ctx: ToolContext, cursor: Point | null): Entity[] {
    const s = this.settings();
    const out: Entity[] = [];
    if (this.pending) out.push(this.make(ctx, this.pending.loops, this.pending.sources, PREVIEW_ID));
    if (s.mode !== "point" || !cursor) return out;
    const rev = useApp.getState().revision;
    const c = this.cache;
    // Re-detect only when the cursor really moved, and no more often than the last detection can afford.
    const moved = !c || c.rev !== rev || Math.hypot(c.x - cursor.x, c.y - cursor.y) > 1e-9;
    if (moved && (!c || c.rev !== rev || performance.now() - c.at > Math.min(250, c.cost * 3))) {
      const t0 = performance.now();
      const ents = selectableEntities();
      const result = ents.length > PREVIEW_ENTITY_LIMIT ? null : this.regionAt(ctx, cursor);
      this.cache = { x: cursor.x, y: cursor.y, rev, at: t0, cost: performance.now() - t0, result };
    }
    const found = this.cache?.result;
    if (found) out.push(this.make(ctx, found.loops, found.sources, PREVIEW_ID));
    return out;
  }
}
