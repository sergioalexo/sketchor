import {
  area as polygonArea,
  bounds,
  buildTrueNestLayout,
  checkNestOverlaps,
  clearPreviousLayout,
  computeJobMetrics,
  extractParts,
  materializeInstance,
  nestTrueShape,
  NEST_LAYER,
  placementTransform,
  type CutTableRow,
  type Gravity,
  type SheetPlacementEntities,
  type StockRow,
  type TrueNestPart,
  type TrueNestSheet,
} from "@sketchor/plugin-nest";
import type { Entity } from "@sketchor/core";
import { type DisplayUnitInfo, type DocumentReadModel, type PluginModule } from "@sketchor/plugin-sdk";
import { displayUnitToDxfCode, factorFromMm } from "../../units";
import { entitiesToDxf, entitiesToSvgDocument } from "@sketchor/core";

/**
 * First-party dogfood: sheet metal nesting. The true-shape (no-fit-polygon)
 * engine lives in `@sketchor/plugin-nest` (SDK-only, no document access);
 * this module shows the panel, tracks a *working set* of parts built up
 * from the selection across multiple "Add selection" clicks, and on
 * request nests them and applies the layout through `document.apply` as
 * one undo step. Upgrades the plugin in place (same manifest id) — the old
 * bbox engine (`nest.ts`/`nestParts()`) stays exported and untouched, just
 * no longer wired to this UI.
 */

// --- persisted state ---

export type RotationMode = "locked" | "quarter" | "any";

export interface PartSettings {
  quantity: number;
  rotationMode: RotationMode;
  /** "any" only. */
  stepDeg?: number;
  mirror: boolean;
  /** N-12: try this part inside another part's hole before the open sheet area. */
  allowInHoles: boolean;
}

/** A part in the working set: identified by its stable `sourceIds` key, not `ExtractedPart.id` (synthetic, not stable across extraction calls). */
export interface WorkingPartEntry {
  key: string;
  sourceIds: string[];
  settings: PartSettings;
}

export interface PersistedState {
  stock: StockRow[];
  workingParts: WorkingPartEntry[];
  /** Gap between parts, mm. */
  spacing: number;
  edgeMargin: number;
  /** Added into spacing at nest time. */
  kerf: number;
  gravity: Gravity;
  /** N-12: a hole smaller than this (mm², after shrinking inward by spacing) is never offered to an allowInHoles part. */
  minHoleArea: number;
}

const STORAGE_KEY = "state";

export const SEED_STOCK: StockRow[] = [
  { size: { name: "48×96 in", width: 1219.2, height: 2438.4 }, qty: null },
  { size: { name: "60×120 in", width: 1524, height: 3048 }, qty: null },
  { size: { name: "48×120 in", width: 1219.2, height: 3048 }, qty: null },
  { size: { name: "1250×2500 mm", width: 1250, height: 2500 }, qty: null },
  { size: { name: "1500×3000 mm", width: 1500, height: 3000 }, qty: null },
];

/**
 * Seed cutting-time table — deliberately small and clearly `estimated`.
 * There's no cut-table editor in this pass; a matching row (by material name,
 * case-insensitively, and thickness within 0.05mm) just lets the Results
 * tab show a rough time instead of nothing. Real machine values are a
 * follow-up, not a guess this pass should pretend is precise.
 */
export const DEFAULT_CUT_TABLE: CutTableRow[] = [
  { material: "Mild Steel", thickness: 1, feedRateMmPerMin: 6000, pierceTimeSec: 0.3, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 7850 },
  { material: "Mild Steel", thickness: 3, feedRateMmPerMin: 3500, pierceTimeSec: 0.6, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 7850 },
  { material: "Mild Steel", thickness: 6, feedRateMmPerMin: 1800, pierceTimeSec: 1.2, rapidMmPerMin: 12000, estimated: true, densityKgPerM3: 7850 },
  { material: "Stainless Steel", thickness: 3, feedRateMmPerMin: 2800, pierceTimeSec: 0.8, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 8000 },
  { material: "Aluminum", thickness: 3, feedRateMmPerMin: 4500, pierceTimeSec: 0.4, rapidMmPerMin: 15000, estimated: true, densityKgPerM3: 2700 },
];

const ROTATION_MODES: RotationMode[] = ["locked", "quarter", "any"];
const GRAVITIES: Gravity[] = ["bottom-left", "bottom-right", "top-left", "top-right"];

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function asStockRow(v: unknown): StockRow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const sizeObj = (o.size && typeof o.size === "object" ? o.size : {}) as Record<string, unknown>;
  const width = Math.max(1, num(sizeObj.width, 1));
  const height = Math.max(1, num(sizeObj.height, 1));
  const name = str(sizeObj.name) || "Sheet";
  const material = str(o.material);
  const qty = o.qty === null || o.qty === undefined || o.qty === "" ? null : Math.max(0, Math.floor(num(o.qty, 0)));
  const thickness = o.thickness === undefined || o.thickness === null || o.thickness === "" ? undefined : Math.max(0, num(o.thickness, 0));
  const cost = o.cost === undefined || o.cost === null || o.cost === "" ? undefined : Math.max(0, num(o.cost, 0));
  return { size: { name, width, height }, ...(material ? { material } : {}), ...(thickness !== undefined ? { thickness } : {}), qty, ...(cost !== undefined ? { cost } : {}) };
}

export function asPartSettings(v: unknown): PartSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const rotationMode = ROTATION_MODES.includes(o.rotationMode as RotationMode) ? (o.rotationMode as RotationMode) : "quarter";
  return {
    quantity: Math.max(0, Math.floor(num(o.quantity, 1))),
    rotationMode,
    stepDeg: o.stepDeg === undefined ? undefined : Math.max(1, num(o.stepDeg, 15)),
    mirror: !!o.mirror,
    allowInHoles: !!o.allowInHoles,
  };
}

function asWorkingPart(v: unknown): WorkingPartEntry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const key = str(o.key);
  const sourceIds = Array.isArray(o.sourceIds) ? o.sourceIds.filter((x): x is string => typeof x === "string") : [];
  if (!key || sourceIds.length === 0) return null;
  return { key, sourceIds, settings: asPartSettings(o.settings) };
}

/**
 * Unrecognized/old-shaped stored data (the previous panel's `presets`/
 * `maxSheets` model is a different data model entirely — there's no
 * meaningful field-by-field migration from a global `maxSheets` counter to
 * per-row stock quantities) is simply treated as absent: fresh seeds, empty
 * working set, never a crash.
 */
export function asState(v: unknown): PersistedState {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const stock = Array.isArray(o.stock) ? o.stock.map(asStockRow).filter((s): s is StockRow => s !== null) : [];
  const workingParts = Array.isArray(o.workingParts) ? o.workingParts.map(asWorkingPart).filter((p): p is WorkingPartEntry => p !== null) : [];
  const gravity = GRAVITIES.includes(o.gravity as Gravity) ? (o.gravity as Gravity) : "bottom-left";
  return {
    stock: stock.length > 0 ? stock : SEED_STOCK.map((s) => ({ ...s, size: { ...s.size } })),
    workingParts,
    spacing: Math.max(0, num(o.spacing, 0)),
    edgeMargin: Math.max(0, num(o.edgeMargin, 0)),
    kerf: Math.max(0, num(o.kerf, 0)),
    gravity,
    minHoleArea: Math.max(0, num(o.minHoleArea, 0)),
  };
}

// --- part resolution ---

export type Point = { x: number; y: number };

export interface ResolvedPart {
  key: string;
  name: string;
  outer: Point[];
  holes: Point[][];
  sourceIds: string[];
  area: number;
  w: number;
  h: number;
}

export function stableKey(sourceIds: string[]): string {
  return [...sourceIds].sort().join(",");
}

/** Re-derives a working-set entry's current outline from the live document — geometry is never persisted, only the `sourceIds` that identify it, so an edited shape is always re-read fresh. */
export function resolvePart(entities: Entity[], sourceIds: string[]): ResolvedPart | null {
  const extracted = extractParts(entities, new Set(sourceIds));
  if (extracted.length === 0) return null;
  const part = extracted[0];
  const b = bounds(part.outer);
  return {
    key: stableKey(sourceIds),
    name: part.name,
    outer: part.outer,
    holes: part.holes,
    sourceIds: part.sourceIds,
    area: polygonArea(part.outer),
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
  };
}

const plugin: PluginModule = {
  async activate(sketchor) {
    let unit: DisplayUnitInfo = { unit: "mm", perMm: 1, label: "mm" };
    try {
      unit = await sketchor.app.displayUnit();
    } catch {
      /* mm default */
    }

    const stored = await sketchor.storage.get(STORAGE_KEY).catch(() => undefined);
    let state = asState(stored);

    const persist = async () => {
      await sketchor.storage.set(STORAGE_KEY, state).catch(() => undefined);
    };

    const pushWorkingParts = async (entitiesIn?: readonly Entity[]) => {
      const entities = entitiesIn ? [...entitiesIn] : [...(await sketchor.document.read()).entities];
      const resolved: (ResolvedPart & { settings: PartSettings })[] = [];
      const survivors: WorkingPartEntry[] = [];
      for (const entry of state.workingParts) {
        const r = resolvePart(entities, entry.sourceIds);
        if (r) {
          resolved.push({ ...r, settings: entry.settings });
          survivors.push(entry);
        }
      }
      if (survivors.length !== state.workingParts.length) {
        state.workingParts = survivors;
        await persist();
      }
      void sketchor.ui.postMessage({
        type: "working-parts",
        parts: resolved.map((r) => ({ key: r.key, name: r.name, w: r.w, h: r.h, area: r.area, outer: r.outer, settings: r.settings })),
      });
    };

    const pushSelectionHint = async () => {
      const selection = await sketchor.selection.read();
      if (selection.length === 0) {
        void sketchor.ui.postMessage({ type: "selection-hint", count: 0 });
        return;
      }
      const model = await sketchor.document.read();
      const extracted = extractParts([...model.entities], new Set(selection));
      void sketchor.ui.postMessage({ type: "selection-hint", count: extracted.length });
    };

    const pushInit = () => {
      void sketchor.ui.postMessage({ type: "init", state, unit });
      void pushWorkingParts();
      void pushSelectionHint();
    };

    void sketchor.app.onDisplayUnitChange((info) => {
      unit = info;
      void sketchor.ui.postMessage({ type: "unit", unit });
    });
    void sketchor.selection.onChange(() => void pushSelectionHint());

    sketchor.commands.register("nest.open", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "Sheet Metal Nest", width: 380, height: 600 });
      pushInit();
    });

    sketchor.ui.onMessage(async (raw) => {
      const msg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

      if (msg.type === "ready") {
        pushInit();
        return;
      }

      if (msg.type === "persist") {
        state = asState(msg.state);
        await persist();
        return;
      }

      if (msg.type === "add-selection") {
        const [model, selection] = await Promise.all([sketchor.document.read(), sketchor.selection.read()]);
        const entities = [...model.entities];
        const extracted = extractParts(entities, new Set(selection));
        if (extracted.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Select one or more closed shapes first." });
          return;
        }
        for (const part of extracted) {
          const key = stableKey(part.sourceIds);
          const existing = state.workingParts.find((w) => w.key === key);
          if (existing) existing.sourceIds = part.sourceIds;
          else state.workingParts.push({ key, sourceIds: part.sourceIds, settings: { quantity: 1, rotationMode: "quarter", mirror: false, allowInHoles: false } });
        }
        await persist();
        await pushWorkingParts(entities);
        return;
      }

      if (msg.type === "remove-part") {
        const key = str(msg.key);
        state.workingParts = state.workingParts.filter((w) => w.key !== key);
        await persist();
        await pushWorkingParts();
        return;
      }

      if (msg.type === "update-part-settings") {
        const key = str(msg.key);
        const entry = state.workingParts.find((w) => w.key === key);
        if (entry) {
          entry.settings = asPartSettings(msg.settings);
          await persist();
        }
        return;
      }

      if (msg.type === "clear") {
        const model = await sketchor.document.read();
        const commands = clearPreviousLayout(model);
        if (commands.length > 0) await sketchor.document.apply(commands);
        void sketchor.ui.postMessage({ type: "cleared" });
        return;
      }

      if (msg.type === "check-nest") {
        const model = await sketchor.document.read();
        const issues = checkNestOverlaps(model);
        void sketchor.ui.postMessage({ type: "check-result", issues });
        sketchor.ui.notify(
          issues.length > 0 ? `${issues.length} sheet(s) have overlapping parts.` : "No overlaps found.",
          { error: issues.length > 0 },
        );
        return;
      }

      if (msg.type === "nest") {
        if (state.workingParts.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Add one or more parts first." });
          return;
        }
        if (state.stock.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Add at least one stock size first." });
          return;
        }

        const model = await sketchor.document.read();
        const entities = [...model.entities];
        const entityById = new Map(entities.map((e) => [e.id, e]));

        const withSettings: (ResolvedPart & { settings: PartSettings })[] = [];
        for (const entry of state.workingParts) {
          const r = resolvePart(entities, entry.sourceIds);
          if (r) withSettings.push({ ...r, settings: entry.settings });
        }
        if (withSettings.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "None of the added parts could be found — they may have been deleted." });
          return;
        }

        const trueParts: TrueNestPart[] = withSettings
          .filter((p) => p.settings.quantity > 0)
          .map((p) => ({
            id: p.key,
            name: p.name,
            outer: p.outer,
            holes: p.holes,
            quantity: p.settings.quantity,
            rotation: { mode: p.settings.rotationMode, stepDeg: p.settings.stepDeg, mirror: p.settings.mirror },
            allowInHoles: p.settings.allowInHoles,
          }));
        if (trueParts.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Every part has quantity 0." });
          return;
        }

        try {
          const result = nestTrueShape(trueParts, state.stock, {
            spacing: state.spacing + state.kerf,
            edgeMargin: state.edgeMargin,
            gravity: state.gravity,
            minHoleArea: state.minHoleArea,
          });

          const geometryByKey = new Map(withSettings.map((p) => [p.key, p]));
          const bySheet = new Map<number, Entity[]>();
          for (const placement of result.placed) {
            const p = geometryByKey.get(placement.partId);
            if (!p) continue;
            const originalEntities = p.sourceIds.map((id) => entityById.get(id)).filter((e): e is Entity => e !== undefined);
            if (originalEntities.length === 0) continue;
            const transform = placementTransform(p.outer, placement);
            const materialized = materializeInstance(originalEntities, transform);
            const list = bySheet.get(placement.sheet) ?? [];
            list.push(...materialized);
            bySheet.set(placement.sheet, list);
          }
          const placementEntities: SheetPlacementEntities[] = Array.from(bySheet, ([sheet, entities]) => ({ sheet, entities }));

          const toDisplay = (mm: number) => mm * unit.perMm;
          const sheetLabel = (sheet: TrueNestSheet, i: number): string => {
            const row = state.stock[sheet.stockIndex];
            const bits = [row?.material, row?.thickness !== undefined ? `${toDisplay(row.thickness).toFixed(2)}${unit.label}` : undefined].filter(Boolean);
            const dims = `${Math.round(toDisplay(sheet.width))}×${Math.round(toDisplay(sheet.height))} ${unit.label}`;
            return `Sheet ${i + 1}/${result.sheets.length} – ${dims}${bits.length ? " " + bits.join(" ") : ""}`;
          };

          const layoutCommands = buildTrueNestLayout(result.sheets, placementEntities, sheetLabel);
          await sketchor.document.apply([...clearPreviousLayout(model), ...layoutCommands]);

          const metricsGeoMap = new Map(withSettings.map((p) => [p.key, { outer: p.outer, holes: p.holes }]));
          const jobMetrics = computeJobMetrics(result, metricsGeoMap, state.stock, DEFAULT_CUT_TABLE, { gravity: state.gravity });
          const sheetLabels = result.sheets.map((s, i) => sheetLabel(s, i));

          void sketchor.ui.postMessage({ type: "result", result, metrics: jobMetrics, sheetLabels });
          const unplacedCount = result.unplaced.reduce((n, u) => n + u.count, 0);
          sketchor.ui.notify(
            unplacedCount > 0
              ? `Nested ${result.placed.length} on ${result.sheets.length} sheet(s) — ${unplacedCount} didn't fit.`
              : `Nested ${result.placed.length} part(s) on ${result.sheets.length} sheet(s), ${Math.round(result.utilisation * 100)}% used.`,
            { error: unplacedCount > 0 },
          );
        } catch (err) {
          void sketchor.ui.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (msg.type === "export-dxf") {
        const model = await sketchor.document.read();
        const nestEntities = [...model.entities].filter((e) => e.layer === NEST_LAYER);
        if (nestEntities.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Nothing to export — nest some parts first." });
          return;
        }
        const dxf = entitiesToDxf(nestEntities, displayUnitToDxfCode(unit.unit), factorFromMm(unit.unit));
        const res = await sketchor.ui.saveFile("nest.dxf", dxf, [{ description: "DXF Drawing", accept: { "application/dxf": [".dxf"] } }]);
        if (res.saved) sketchor.ui.notify(`Saved ${res.name ?? "nest.dxf"}.`);
        return;
      }

      if (msg.type === "print") {
        const model = await sketchor.document.read();
        const nestEntities = [...model.entities].filter((e) => e.layer === NEST_LAYER);
        if (nestEntities.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Nothing to print — nest some parts first." });
          return;
        }
        const svg = entitiesToSvgDocument(nestEntities, { strokeColor: "#111111" });
        sketchor.ui.print(svg, { fileName: "nest" });
        return;
      }
    });
  },
};

export const PANEL_HTML = String.raw`<!doctype html>
<html>
  <head>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 12px; font: 12px system-ui, -apple-system, sans-serif; color: #dfe1e5; background: #1e1f22; }
      h4 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.55; }
      h4:first-child { margin-top: 0; }
      label { display: block; margin-bottom: 6px; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
      input, select { width: 100%; margin-top: 3px; padding: 5px 6px; background: #2b2d31; color: inherit; border: 1px solid #3a3d42; border-radius: 4px; font: inherit; }
      button { padding: 6px 10px; border: none; border-radius: 5px; background: #4f7cff; color: #fff; font: inherit; cursor: pointer; }
      button.ghost { background: #2b2d31; color: #dfe1e5; border: 1px solid #3a3d42; }
      button.sm { padding: 3px 7px; font-size: 11px; }
      button:disabled { opacity: 0.4; cursor: default; }
      .row { display: flex; gap: 6px; align-items: center; }
      .actions { display: flex; gap: 8px; margin: 12px 0; }
      .muted { opacity: 0.6; }
      .f { padding: 5px 7px; border-radius: 4px; background: #2b2d31; border-left: 3px solid #6b7280; margin-top: 4px; }
      .f.error { border-left-color: #f0616d; }
      .f.ok { border-left-color: #4f9d69; }

      .tabs { display: flex; gap: 2px; margin-bottom: 10px; border-bottom: 1px solid #3a3d42; }
      .tab-btn { flex: 1; background: none; border: none; border-radius: 0; color: #9aa0a6; padding: 7px 4px; font: inherit; cursor: pointer; border-bottom: 2px solid transparent; }
      .tab-btn.active { color: #dfe1e5; border-bottom-color: #4f7cff; }
      .tab-panel { display: none; }
      .tab-panel.active { display: block; }

      .part-row { border: 1px solid #3a3d42; border-radius: 6px; padding: 6px 8px; margin-bottom: 6px; background: #232529; display: grid; grid-template-columns: 34px 1fr auto; gap: 8px; align-items: center; }
      .part-thumb { width: 34px; height: 34px; background: #2b2d31; border-radius: 4px; flex: none; }
      .part-thumb svg { width: 100%; height: 100%; display: block; }
      .part-info { min-width: 0; }
      .part-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .part-dim { opacity: 0.55; font-size: 11px; }
      .part-controls { display: grid; grid-template-columns: 44px 1fr auto auto auto; gap: 4px; align-items: center; }
      .part-controls input, .part-controls select { margin-top: 0; padding: 3px 4px; font-size: 11px; }
      .part-controls .icon { background: none; border: none; color: #9aa0a6; cursor: pointer; padding: 2px 4px; font-size: 13px; }
      .step-row { grid-column: 1 / -1; margin-top: 3px; }

      .presets { border: 1px solid #3a3d42; border-radius: 6px; padding: 8px; background: #232529; }
      .stock-row { display: grid; grid-template-columns: 1fr 46px 46px 1fr 40px 40px 44px 20px; gap: 4px; align-items: center; margin-bottom: 4px; }
      .stock-row input { margin-top: 0; padding: 4px; font-size: 11px; }
      .stock-head { display: grid; grid-template-columns: 1fr 46px 46px 1fr 40px 40px 44px 20px; gap: 4px; font-size: 9px; opacity: 0.5; margin-bottom: 2px; }
      .icon { background: none; border: none; color: #9aa0a6; cursor: pointer; padding: 2px 3px; font-size: 12px; }

      .sheet-card { border: 1px solid #3a3d42; border-radius: 6px; padding: 8px; margin-bottom: 6px; background: #232529; }
      .sheet-card .title { font-weight: 500; margin-bottom: 4px; }
      .sheet-card .metric { display: flex; justify-content: space-between; opacity: 0.75; font-size: 11px; }
    </style>
  </head>
  <body>
    <div class="tabs">
      <button class="tab-btn active" data-tab="parts">Parts</button>
      <button class="tab-btn" data-tab="sheets">Sheets</button>
      <button class="tab-btn" data-tab="settings">Settings</button>
      <button class="tab-btn" data-tab="results">Results</button>
    </div>

    <div class="tab-panel active" data-tab="parts">
      <div class="row" style="margin-bottom:8px">
        <button id="add-selection">+ Add selection</button>
        <span class="muted" id="selection-hint"></span>
      </div>
      <div id="parts-list"></div>
      <div class="muted" id="parts-empty">No parts added yet — select closed shapes on the canvas and click "Add selection".</div>
    </div>

    <div class="tab-panel" data-tab="sheets">
      <div class="presets">
        <div class="stock-head">
          <span>Name</span><span>W</span><span>H</span><span>Material</span><span>Thk</span><span>Qty</span><span>Cost</span><span></span>
        </div>
        <div id="stock-rows"></div>
        <button class="ghost sm" id="stock-add" style="margin-top:4px">+ New stock size</button>
      </div>
    </div>

    <div class="tab-panel" data-tab="settings">
      <div class="grid2">
        <label>Spacing (<span class="u"></span>)<input id="set-spacing" type="number" min="0" step="any" /></label>
        <label>Edge margin (<span class="u"></span>)<input id="set-margin" type="number" min="0" step="any" /></label>
        <label>Kerf (<span class="u"></span>)<input id="set-kerf" type="number" min="0" step="any" /></label>
        <label>Min hole size (<span class="u"></span>)<input id="set-minhole" type="number" min="0" step="any" title="Holes smaller than this aren't offered to in-hole parts" /></label>
        <label>Gravity
          <select id="set-gravity">
            <option value="bottom-left">Bottom-left</option>
            <option value="bottom-right">Bottom-right</option>
            <option value="top-left">Top-left</option>
            <option value="top-right">Top-right</option>
          </select>
        </label>
      </div>
    </div>

    <div class="tab-panel" data-tab="results">
      <div class="actions">
        <button id="nest">Nest</button>
        <button class="ghost" id="clear">Clear</button>
      </div>
      <div class="row" style="margin-bottom:8px">
        <button class="ghost sm" id="check-nest">Check nest</button>
      </div>
      <div id="summary"></div>
      <div id="sheet-cards"></div>
      <div class="actions">
        <button class="ghost sm" id="export-dxf">Export DXF</button>
        <button class="ghost sm" id="print">Print</button>
      </div>
    </div>

    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      const $ = (id) => document.getElementById(id);
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

      let unit = { unit: "mm", perMm: 1, label: "mm" };
      let state = { stock: [], workingParts: [], spacing: 0, edgeMargin: 0, kerf: 0, gravity: "bottom-left", minHoleArea: 0 };
      let parts = []; // working-set parts, as last pushed by the plugin: {key,name,w,h,area,outer,settings}
      let saveTimer = 0;

      const toU = (mm) => Math.round(mm * unit.perMm * 100) / 100;
      const fromU = (v) => (Number(v) || 0) / unit.perMm;

      function persist() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => post({ type: "persist", state }), 400);
      }

      // ---- tabs ----
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
          document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === btn.dataset.tab));
        });
      });

      // ---- parts tab ----
      function thumbSvg(outer) {
        if (!outer || outer.length < 3) return "";
        const xs = outer.map((p) => p.x), ys = outer.map((p) => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
        const pts = outer.map((p) => (p.x - minX) + "," + (h - (p.y - minY))).join(" ");
        return "<svg viewBox='-2 -2 " + (w + 4) + " " + (h + 4) + "' preserveAspectRatio='xMidYMid meet'>" +
          "<polygon points='" + pts + "' fill='none' stroke='#8ab4f8' stroke-width='" + Math.max(w, h) / 20 + "'/></svg>";
      }

      function renderParts() {
        $("parts-empty").style.display = parts.length ? "none" : "block";
        $("parts-list").innerHTML = parts
          .map((p) => {
            const s = p.settings;
            return "<div class='part-row' data-key='" + esc(p.key) + "'>" +
              "<div class='part-thumb'>" + thumbSvg(p.outer) + "</div>" +
              "<div class='part-info'><div class='part-name'>" + esc(p.name) + "</div>" +
              "<div class='part-dim'>" + Math.round(toU(p.w)) + "×" + Math.round(toU(p.h)) + " " + esc(unit.label) + "</div></div>" +
              "<div class='part-controls'>" +
              "<input class='qty' type='number' min='0' step='1' value='" + s.quantity + "' title='Quantity'>" +
              "<select class='rot'>" +
              "<option value='locked'" + (s.rotationMode === "locked" ? " selected" : "") + ">Locked</option>" +
              "<option value='quarter'" + (s.rotationMode === "quarter" ? " selected" : "") + ">90°</option>" +
              "<option value='any'" + (s.rotationMode === "any" ? " selected" : "") + ">Any</option>" +
              "</select>" +
              "<label style='display:flex;align-items:center;gap:2px;margin:0' title='Mirror'><input class='mirror' type='checkbox'" + (s.mirror ? " checked" : "") + "> M</label>" +
              "<label style='display:flex;align-items:center;gap:2px;margin:0' title='Try inside another placed part&#39;s hole first'><input class='in-holes' type='checkbox'" + (s.allowInHoles ? " checked" : "") + "> H</label>" +
              "<button class='icon remove' title='Remove'>&#10005;</button>" +
              (s.rotationMode === "any"
                ? "<div class='step-row'><input class='step' type='number' min='1' step='1' value='" + (s.stepDeg || 15) + "' title='Step degrees'> °</div>"
                : "") +
              "</div></div>";
          })
          .join("");
        $("parts-list").querySelectorAll(".part-row").forEach((row) => {
          const key = row.dataset.key;
          const entry = parts.find((p) => p.key === key);
          const sendSettings = () => post({ type: "update-part-settings", key, settings: entry.settings });
          row.querySelector(".qty").addEventListener("input", (e) => { entry.settings.quantity = Math.max(0, Math.floor(Number(e.target.value) || 0)); sendSettings(); });
          row.querySelector(".rot").addEventListener("change", (e) => { entry.settings.rotationMode = e.target.value; sendSettings(); renderParts(); });
          row.querySelector(".mirror").addEventListener("change", (e) => { entry.settings.mirror = e.target.checked; sendSettings(); });
          row.querySelector(".in-holes").addEventListener("change", (e) => { entry.settings.allowInHoles = e.target.checked; sendSettings(); });
          const stepInput = row.querySelector(".step");
          if (stepInput) stepInput.addEventListener("input", (e) => { entry.settings.stepDeg = Math.max(1, Number(e.target.value) || 15); sendSettings(); });
          row.querySelector(".remove").addEventListener("click", () => post({ type: "remove-part", key }));
        });
      }
      $("add-selection").addEventListener("click", () => post({ type: "add-selection" }));

      // ---- sheets tab ----
      function stockRowHtml(row, i) {
        return "<div class='stock-row' data-i='" + i + "'>" +
          "<input class='st-name' value='" + esc(row.size.name) + "'>" +
          "<input class='st-w' type='number' min='0' step='any' value='" + toU(row.size.width) + "'>" +
          "<input class='st-h' type='number' min='0' step='any' value='" + toU(row.size.height) + "'>" +
          "<input class='st-mat' value='" + esc(row.material || "") + "' placeholder='—'>" +
          "<input class='st-thk' type='number' min='0' step='any' value='" + (row.thickness !== undefined ? toU(row.thickness) : "") + "' placeholder='—'>" +
          "<input class='st-qty' type='number' min='0' step='1' value='" + (row.qty === null ? "" : row.qty) + "' placeholder='∞'>" +
          "<input class='st-cost' type='number' min='0' step='any' value='" + (row.cost !== undefined ? row.cost : "") + "' placeholder='—'>" +
          "<button class='icon st-del' title='Delete'>&#10005;</button>" +
          "</div>";
      }
      function renderStock() {
        $("stock-rows").innerHTML = state.stock.map(stockRowHtml).join("");
        $("stock-rows").querySelectorAll(".stock-row").forEach((row) => {
          const i = Number(row.dataset.i);
          const r = state.stock[i];
          const upd = () => persist();
          row.querySelector(".st-name").addEventListener("input", (e) => { r.size.name = e.target.value; upd(); });
          row.querySelector(".st-w").addEventListener("input", (e) => { r.size.width = fromU(e.target.value); upd(); });
          row.querySelector(".st-h").addEventListener("input", (e) => { r.size.height = fromU(e.target.value); upd(); });
          row.querySelector(".st-mat").addEventListener("input", (e) => { r.material = e.target.value || undefined; upd(); });
          row.querySelector(".st-thk").addEventListener("input", (e) => { r.thickness = e.target.value === "" ? undefined : fromU(e.target.value); upd(); });
          row.querySelector(".st-qty").addEventListener("input", (e) => { r.qty = e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value) || 0)); upd(); });
          row.querySelector(".st-cost").addEventListener("input", (e) => { r.cost = e.target.value === "" ? undefined : Number(e.target.value); upd(); });
          row.querySelector(".st-del").addEventListener("click", () => { state.stock.splice(i, 1); renderStock(); persist(); });
        });
      }
      $("stock-add").addEventListener("click", () => {
        state.stock.push({ size: { name: "New sheet", width: fromU(1000), height: fromU(1000) }, qty: null });
        renderStock();
        persist();
      });

      // ---- settings tab ----
      function renderSettings() {
        document.querySelectorAll(".u").forEach((el) => (el.textContent = unit.label));
        $("set-spacing").value = toU(state.spacing);
        $("set-margin").value = toU(state.edgeMargin);
        $("set-kerf").value = toU(state.kerf);
        // Stored as an area (mm²) but shown/edited as a side length — much
        // easier to reason about ("holes under 10mm across") than mm².
        $("set-minhole").value = toU(Math.sqrt(state.minHoleArea || 0));
        $("set-gravity").value = state.gravity;
      }
      $("set-spacing").addEventListener("input", () => { state.spacing = fromU($("set-spacing").value); persist(); });
      $("set-margin").addEventListener("input", () => { state.edgeMargin = fromU($("set-margin").value); persist(); });
      $("set-kerf").addEventListener("input", () => { state.kerf = fromU($("set-kerf").value); persist(); });
      $("set-minhole").addEventListener("input", () => { const side = fromU($("set-minhole").value); state.minHoleArea = Math.max(0, side * side); persist(); });
      $("set-gravity").addEventListener("change", () => { state.gravity = $("set-gravity").value; persist(); });

      // ---- results tab ----
      $("nest").addEventListener("click", () => {
        $("summary").innerHTML = "<div class='muted'>Nesting…</div>";
        $("sheet-cards").innerHTML = "";
        post({ type: "nest" });
      });
      $("clear").addEventListener("click", () => { post({ type: "clear" }); $("summary").innerHTML = ""; $("sheet-cards").innerHTML = ""; });
      $("check-nest").addEventListener("click", () => post({ type: "check-nest" }));
      $("export-dxf").addEventListener("click", () => post({ type: "export-dxf" }));
      $("print").addEventListener("click", () => post({ type: "print" }));

      function renderResult(r, metrics, sheetLabels) {
        const unplaced = (r.unplaced || []).reduce((n, u) => n + u.count, 0);
        $("summary").innerHTML =
          "<div class='f " + (unplaced ? "error" : "ok") + "'>" + r.placed.length + " placed on " + r.sheets.length +
          " sheet(s), " + Math.round(r.utilisation * 100) + "% used" + (unplaced ? " · " + unplaced + " didn't fit" : "") + ".</div>";
        const cards = (metrics ? metrics.sheets : []).map((m, i) => {
          const label = (sheetLabels && sheetLabels[i]) || "Sheet " + (i + 1);
          const time = m.cuttingTimeSec != null ? Math.round(m.cuttingTimeSec / 6) / 10 + " min (est.)" : "—";
          const remnant = m.remnant ? Math.round(toU(m.remnant.width)) + "×" + Math.round(toU(m.remnant.height)) + " " + esc(unit.label) : "none";
          return "<div class='sheet-card'>" +
            "<div class='title'>" + esc(label) + "</div>" +
            "<div class='metric'><span>Utilisation</span><span>" + Math.round(m.utilisation * 100) + "%</span></div>" +
            "<div class='metric'><span>Reusable remnant</span><span>" + remnant + "</span></div>" +
            "<div class='metric'><span>Cutting time</span><span>" + time + "</span></div>" +
            (m.weightKg != null ? "<div class='metric'><span>Weight</span><span>" + m.weightKg.toFixed(2) + " kg</span></div>" : "") +
            (m.costEstimate != null ? "<div class='metric'><span>Sheet cost</span><span>" + m.costEstimate.toFixed(2) + "</span></div>" : "") +
            "</div>";
        }).join("");
        $("sheet-cards").innerHTML = cards;
      }

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m) return;
        if (m.type === "init") { state = m.state; unit = m.unit || unit; renderStock(); renderSettings(); return; }
        if (m.type === "unit") { unit = m.unit; renderStock(); renderSettings(); renderParts(); return; }
        if (m.type === "selection-hint") {
          $("selection-hint").textContent = m.count > 0 ? m.count + " shape(s) selected" : "";
          return;
        }
        if (m.type === "working-parts") {
          parts = (m.parts || []).map((p) => ({ ...p, settings: p.settings }));
          renderParts();
          return;
        }
        if (m.type === "cleared") { $("summary").innerHTML = "<div class='f'>Cleared.</div>"; $("sheet-cards").innerHTML = ""; return; }
        if (m.type === "error") { $("summary").innerHTML = "<div class='f error'>" + esc(m.message) + "</div>"; return; }
        if (m.type === "result") { renderResult(m.result, m.metrics, m.sheetLabels); return; }
        if (m.type === "check-result") {
          const issues = m.issues || [];
          $("summary").innerHTML = issues.length
            ? "<div class='f error'>Overlaps on: " + issues.map((i) => esc(i.groupName)).join(", ") + "</div>"
            : "<div class='f ok'>No overlaps found.</div>";
          return;
        }
      });

      post({ type: "ready" });
    </script>
  </body>
</html>`;

export default plugin;
