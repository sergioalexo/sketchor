import { create } from "zustand";
import {
  CommandBus,
  DEFAULT_LAYER,
  SketchDocument,
  centroidOfEntities,
  diffToCommands,
  dxfToSvg,
  layerOf,
  mid,
  parseCode,
  parseDxf,
  reduceToHalfTurn,
  toCode,
  type Command,
  type DxfImportReport,
  type Entity,
  type EntityId,
  type ParseIssue,
  type Point,
} from "@sketchor/core";

export const doc = new SketchDocument();
export const bus = new CommandBus(doc);

/** Reads the whole drawing as sketch code. */
export function sketchToCode(): string {
  return toCode(doc);
}

/**
 * Applies edited sketch code to the drawing as one undoable step.
 * Returns parse issues instead of applying if the code is invalid.
 * This is the intended entry point for AI agents.
 */
export function applySketchCode(text: string): ParseIssue[] {
  const { entities, errors } = parseCode(text);
  if (errors.length > 0) return errors;
  const commands = diffToCommands(doc, entities);
  if (commands.length === 1) bus.execute(commands[0]);
  else if (commands.length > 1) bus.execute({ type: "batch", commands });
  return [];
}

/** Serialise the whole drawing to Sketchor's native `.sketchor` JSON. */
export function drawingToJson(): string {
  return JSON.stringify(doc.toJSON(), null, 2);
}

/**
 * Loads a native `.sketchor` document (the JSON produced by {@link drawingToJson}
 * / `SketchDocument.toJSON()`): replaces the drawing with the file's entities
 * as one undoable step. Returns the entity count; throws on malformed JSON.
 */
export function loadDrawingJson(text: string): { count: number } {
  const parsed = JSON.parse(text) as { entities?: unknown };
  const entities = Array.isArray(parsed.entities) ? (parsed.entities as Entity[]) : [];
  const commands: Command[] = [];
  const existing = doc.all().map((e) => e.id);
  if (existing.length) commands.push({ type: "delete-entities", ids: existing });
  for (const entity of entities) commands.push({ type: "add-entity", entity });
  if (commands.length === 1) bus.execute(commands[0]);
  else if (commands.length > 1) bus.execute({ type: "batch", commands });
  useApp.getState().syncLayersFromDoc(true);
  return { count: entities.length };
}

/**
 * Imports DXF text: replaces the drawing with the file's geometry as one
 * undoable step. Returns the entity count and any parse warnings.
 */
export function importDxfText(text: string, replace = true): { count: number; warnings: string[] } {
  const { entities, warnings, report } = parseDxf(text);
  const commands = [];
  if (replace) {
    const ids = doc.all().map((e) => e.id);
    if (ids.length) commands.push({ type: "delete-entities" as const, ids });
  }
  for (const entity of entities) commands.push({ type: "add-entity" as const, entity });
  if (commands.length === 1) bus.execute(commands[0]);
  else if (commands.length > 1) bus.execute({ type: "batch", commands });
  useApp.getState().syncLayersFromDoc(replace);
  useApp.getState().setImportReport(report);
  return { count: entities.length, warnings };
}

export type ToolId = "select" | "line" | "circle" | "measure" | "straighten";

export const TOOL_HINTS: Record<ToolId, string> = {
  select: "Click to select (Shift adds) - drag to move - Del deletes",
  line: "Click start point, then click next points to chain - Esc to finish",
  circle: "Click center, then click a point on the circle",
  measure: "Click two points to measure distance and angle - Esc clears",
  straighten: "Select the part with V, switch here, click the reference edge, then Enter to apply",
};

export type StraightenAxis = "horizontal" | "vertical";
export type StraightenPivot = "center" | "edge-mid" | "edge-start";

/**
 * The pivot the straighten tool rotates the whole selection about,
 * matching the pivot-mode toggle from the spec (selection center by
 * default, or a point on the reference edge itself).
 */
function straightenPivotPoint(
  mode: StraightenPivot,
  selectionEntities: Entity[],
  ref: Extract<Entity, { type: "line" }>,
): Point {
  switch (mode) {
    case "edge-mid":
      return mid(ref.a, ref.b);
    case "edge-start":
      return ref.a;
    case "center":
    default:
      return centroidOfEntities(selectionEntities);
  }
}

/**
 * The rigid rotation the straighten tool would apply right now: one pivot,
 * one angle, for the whole selection — the smallest turn that lands the
 * reference edge on the chosen axis. Null when there's no valid reference
 * edge picked yet. Shared by the live dashed preview and the commit below.
 */
export function computeStraightenTransform(): { ids: EntityId[]; pivot: Point; rotation: number } | null {
  const { referenceEdgeId, selection, straightenAxis, straightenPivot } = useApp.getState();
  if (!referenceEdgeId || !selection.includes(referenceEdgeId)) return null;
  const ref = doc.get(referenceEdgeId);
  if (!ref || ref.type !== "line") return null;

  const selectionEntities = selection.map((id) => doc.get(id)).filter((e): e is Entity => !!e);
  if (selectionEntities.length === 0) return null;

  const currentAngle = Math.atan2(ref.b.y - ref.a.y, ref.b.x - ref.a.x);
  const target = straightenAxis === "horizontal" ? 0 : Math.PI / 2;
  const rotation = reduceToHalfTurn(target - currentAngle);
  const pivot = straightenPivotPoint(straightenPivot, selectionEntities, ref);
  return { ids: selection, pivot, rotation };
}

/**
 * Commits the straighten tool: rotates the whole current selection, as one
 * rigid body about a single pivot, by the smallest angle that lands the
 * reference edge on the chosen axis. Returns false (no-op) if there's no
 * valid reference edge to straighten against.
 */
export function applyStraighten(): boolean {
  const plan = computeStraightenTransform();
  if (!plan) return false;
  bus.execute({ type: "transform-entities", ...plan, dx: 0, dy: 0, scale: 1 });
  useApp.getState().setReferenceEdge(null);
  return true;
}

/** A live or frozen measurement between two world points (not geometry). */
export interface Measurement {
  a: Point;
  b: Point;
}

/** A DXF file loaded into the browsable library (previews + open). */
export interface DxfFile {
  name: string;
  text: string;
}

/** A named drawing layer with a visibility toggle. */
export interface Layer {
  name: string;
  visible: boolean;
}

/** Names of layers currently hidden — consulted by the renderer/hit-test. */
export function hiddenLayerSet(): Set<string> {
  return new Set(useApp.getState().layers.filter((l) => !l.visible).map((l) => l.name));
}

interface AppState {
  tool: ToolId;
  selection: EntityId[];
  revision: number;
  cursor: { x: number; y: number } | null;
  zoom: number;
  measurement: Measurement | null;
  library: DxfFile[];
  layers: Layer[];
  activeLayer: string;
  /** Parsed-vs-skipped tally from the most recent DXF import; null once dismissed. */
  importReport: DxfImportReport | null;
  setImportReport: (report: DxfImportReport | null) => void;
  /** The line entity picked as the straighten tool's reference edge (must be in `selection`). */
  referenceEdgeId: EntityId | null;
  straightenAxis: StraightenAxis;
  straightenPivot: StraightenPivot;
  setReferenceEdge: (id: EntityId | null) => void;
  setStraightenAxis: (axis: StraightenAxis) => void;
  setStraightenPivot: (pivot: StraightenPivot) => void;
  setTool: (tool: ToolId) => void;
  setSelection: (ids: EntityId[]) => void;
  setCursor: (cursor: { x: number; y: number } | null) => void;
  setZoom: (zoom: number) => void;
  setMeasurement: (measurement: Measurement | null) => void;
  addLibraryFiles: (files: DxfFile[]) => void;
  clearLibrary: () => void;
  setActiveLayer: (name: string) => void;
  addLayer: () => void;
  deleteLayer: (name: string) => void;
  renameLayer: (from: string, to: string) => void;
  toggleLayer: (name: string) => void;
  /** Rebuild the layer list from the document (used after DXF import). */
  syncLayersFromDoc: (reset?: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  tool: "line",
  selection: [],
  revision: 0,
  cursor: null,
  zoom: 1,
  measurement: null,
  library: [],
  layers: [{ name: DEFAULT_LAYER, visible: true }],
  activeLayer: DEFAULT_LAYER,
  importReport: null,
  setImportReport: (report) => set({ importReport: report }),
  referenceEdgeId: null,
  straightenAxis: "horizontal",
  straightenPivot: "center",
  setReferenceEdge: (id) => set({ referenceEdgeId: id }),
  setStraightenAxis: (axis) => set({ straightenAxis: axis }),
  setStraightenPivot: (pivot) => set({ straightenPivot: pivot }),
  // Switching tools invalidates any in-progress reference-edge pick.
  setTool: (tool) => set({ tool, referenceEdgeId: null }),
  setSelection: (selection) => set({ selection }),
  setCursor: (cursor) => set({ cursor }),
  setZoom: (zoom) => set({ zoom }),
  setMeasurement: (measurement) => set({ measurement }),
  addLibraryFiles: (files) =>
    set((s) => {
      const byName = new Map(s.library.map((f) => [f.name, f]));
      for (const f of files) byName.set(f.name, f);
      return { library: [...byName.values()] };
    }),
  clearLibrary: () => set({ library: [] }),
  setActiveLayer: (name) => set({ activeLayer: name }),
  addLayer: () =>
    set((s) => {
      const used = new Set(s.layers.map((l) => l.name));
      let i = 1;
      while (used.has(`layer${i}`)) i += 1;
      const name = `layer${i}`;
      return { layers: [...s.layers, { name, visible: true }], activeLayer: name };
    }),
  deleteLayer: (name) => {
    if (name === DEFAULT_LAYER) return; // the default layer is permanent
    // Remove the layer's geometry as one undoable step.
    const ids = doc.all().filter((e) => layerOf(e) === name).map((e) => e.id);
    if (ids.length > 0) bus.execute({ type: "delete-entities", ids });
    set((s) => {
      const layers = s.layers.filter((l) => l.name !== name);
      const activeLayer = s.activeLayer === name ? DEFAULT_LAYER : s.activeLayer;
      return { layers, activeLayer };
    });
  },
  renameLayer: (from, to) =>
    set((s) => {
      const t = to.trim();
      if (from === DEFAULT_LAYER || t === "" || s.layers.some((l) => l.name === t)) return s;
      return {
        layers: s.layers.map((l) => (l.name === from ? { ...l, name: t } : l)),
        activeLayer: s.activeLayer === from ? t : s.activeLayer,
      };
    }),
  toggleLayer: (name) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.name === name ? { ...l, visible: !l.visible } : l)),
    })),
  syncLayersFromDoc: (reset = false) => {
    const present = new Set(doc.all().map((e) => layerOf(e)));
    present.add(DEFAULT_LAYER);
    const prev = get().layers;
    const prevByName = new Map(prev.map((l) => [l.name, l]));
    const layers: Layer[] = [];
    // Keep the default first, then the rest in document order.
    layers.push(prevByName.get(DEFAULT_LAYER) ?? { name: DEFAULT_LAYER, visible: true });
    for (const name of present) {
      if (name === DEFAULT_LAYER) continue;
      // On a fresh import, previously-toggled visibility is irrelevant.
      const existing = reset ? undefined : prevByName.get(name);
      layers.push(existing ?? { name, visible: true });
    }
    const activeLayer = layers.some((l) => l.name === get().activeLayer)
      ? get().activeLayer
      : DEFAULT_LAYER;
    set({ layers, activeLayer });
  },
}));

bus.onChange(() => {
  useApp.setState((s) => {
    const selection = s.selection.filter((id) => doc.has(id));
    return {
      revision: doc.revision,
      selection,
      referenceEdgeId:
        s.referenceEdgeId && selection.includes(s.referenceEdgeId) ? s.referenceEdgeId : null,
    };
  });
});

// Debug handle; later this same surface becomes the AI-assistant entry
// point (an LLM proposes Command values, the user previews and accepts).
declare global {
  interface Window {
    sketchor: {
      doc: SketchDocument;
      bus: CommandBus;
      toCode: typeof sketchToCode;
      applyCode: typeof applySketchCode;
      importDxf: typeof importDxfText;
      dxfToSvg: typeof dxfToSvg;
      loadLibrary: (files: DxfFile[]) => void;
    };
  }
}
window.sketchor = {
  doc,
  bus,
  toCode: sketchToCode,
  applyCode: applySketchCode,
  importDxf: importDxfText,
  dxfToSvg,
  loadLibrary: (files) => useApp.getState().addLibraryFiles(files),
};
