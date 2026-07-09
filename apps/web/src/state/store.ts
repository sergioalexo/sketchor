import { create } from "zustand";
import {
  CommandBus,
  SketchDocument,
  diffToCommands,
  dxfToSvg,
  parseCode,
  parseDxf,
  toCode,
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

/**
 * Imports DXF text: replaces the drawing with the file's geometry as one
 * undoable step. Returns the entity count and any parse warnings.
 */
export function importDxfText(text: string, replace = true): { count: number; warnings: string[] } {
  const { entities, warnings } = parseDxf(text);
  const commands = [];
  if (replace) {
    const ids = doc.all().map((e) => e.id);
    if (ids.length) commands.push({ type: "delete-entities" as const, ids });
  }
  for (const entity of entities) commands.push({ type: "add-entity" as const, entity });
  if (commands.length === 1) bus.execute(commands[0]);
  else if (commands.length > 1) bus.execute({ type: "batch", commands });
  return { count: entities.length, warnings };
}

export type ToolId = "select" | "line" | "circle" | "measure";

export const TOOL_HINTS: Record<ToolId, string> = {
  select: "Click to select (Shift adds) - drag to move - Del deletes",
  line: "Click start point, then click next points to chain - Esc to finish",
  circle: "Click center, then click a point on the circle",
  measure: "Click two points to measure distance and angle - Esc clears",
};

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

interface AppState {
  tool: ToolId;
  selection: EntityId[];
  revision: number;
  cursor: { x: number; y: number } | null;
  zoom: number;
  measurement: Measurement | null;
  library: DxfFile[];
  setTool: (tool: ToolId) => void;
  setSelection: (ids: EntityId[]) => void;
  setCursor: (cursor: { x: number; y: number } | null) => void;
  setZoom: (zoom: number) => void;
  setMeasurement: (measurement: Measurement | null) => void;
  addLibraryFiles: (files: DxfFile[]) => void;
  clearLibrary: () => void;
}

export const useApp = create<AppState>((set) => ({
  tool: "line",
  selection: [],
  revision: 0,
  cursor: null,
  zoom: 1,
  measurement: null,
  library: [],
  setTool: (tool) => set({ tool }),
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
}));

bus.onChange(() => {
  useApp.setState((s) => ({
    revision: doc.revision,
    selection: s.selection.filter((id) => doc.has(id)),
  }));
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
