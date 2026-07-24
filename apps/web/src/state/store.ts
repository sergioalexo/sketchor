import { create } from "zustand";
import { dxfCodeToDisplayUnit, type DisplayUnit } from "../units";
import {
  CommandBus,
  DEFAULT_DUPLICATE_OPTIONS,
  DEFAULT_HEAL_OPTIONS,
  DEFAULT_LAYER,
  SketchDocument,
  centroidOfEntities,
  diffToCommands,
  dxfToSvg,
  fixAllDuplicates,
  fixAllIssues,
  fixDuplicate,
  fixIssue,
  freeEndpointEntityIds,
  issueEntityIds,
  layerOf,
  mid,
  newGroupId,
  parseCode,
  parseDxf,
  reduceToHalfTurn,
  scanForDuplicates,
  scanForIssues,
  toCode,
  wholeGroupSelected,
  type ClosedRegion,
  type Command,
  type DuplicateIssue,
  type DuplicateOptions,
  type DxfImportReport,
  type Entity,
  type EntityId,
  type GroupId,
  type HealIssue,
  type HealOptions,
  type ParseIssue,
  type Point,
} from "@sketchor/core";

/**
 * Multi-document sessions ("tabs"). Each open drawing gets its own
 * `SketchDocument` + `CommandBus` (so undo/redo is isolated per tab) plus
 * its own selection, layers, and viewport. `doc`/`bus` below stay as the
 * two names every other module already imports — they're now proxies that
 * always forward to the *active* session, so the rest of the app didn't
 * need to change to become multi-document aware.
 */
export interface DocSession {
  id: string;
  name: string;
  /** True once this tab has been loaded from or saved to a real file (vs. a fresh "Untitled-N"). */
  named: boolean;
  dirty: boolean;
  doc: SketchDocument;
  bus: CommandBus;
  selection: EntityId[];
  layers: Layer[];
  activeLayer: string;
  /** Saved pan/zoom, restored when this tab becomes active again; null until the viewport has set one. */
  view: { scale: number; ox: number; oy: number } | null;
}

let sessionCounter = 0;
function newSessionId(): string {
  sessionCounter += 1;
  return `sess${Date.now().toString(36)}${sessionCounter.toString(36)}`;
}

function newSession(name: string): DocSession {
  const document = new SketchDocument();
  return {
    id: newSessionId(),
    name,
    named: false,
    dirty: false,
    doc: document,
    bus: new CommandBus(document),
    selection: [],
    layers: [{ name: DEFAULT_LAYER, visible: true }],
    activeLayer: DEFAULT_LAYER,
    view: null,
  };
}

const sessions: DocSession[] = [newSession("Untitled-1")];

function activeSession(): DocSession {
  const id = useApp.getState().activeSessionId;
  return sessions.find((s) => s.id === id) ?? sessions[0];
}

/** A proxy that always forwards property access to `getTarget()`'s current value — see the module doc comment. */
function makeProxy<T extends object>(getTarget: () => T): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const target = getTarget();
      const value = Reflect.get(target as object, prop, target as object);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_t, prop, value) {
      const target = getTarget();
      return Reflect.set(target as object, prop, value, target as object);
    },
  });
}

export const doc: SketchDocument = makeProxy(() => activeSession().doc);
export const bus: CommandBus = makeProxy(() => activeSession().bus);

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

/** Shared by every import path: replaces (or adds to) the drawing's entities as one undoable step. */
function applyImportedEntities(entities: Entity[], replace: boolean): void {
  const commands: Command[] = [];
  if (replace) {
    const ids = doc.all().map((e) => e.id);
    if (ids.length) commands.push({ type: "delete-entities", ids });
  }
  for (const entity of entities) commands.push({ type: "add-entity", entity });
  if (commands.length === 1) bus.execute(commands[0]);
  else if (commands.length > 1) bus.execute({ type: "batch", commands });
  useApp.getState().syncLayersFromDoc(replace);
  useApp.getState().setTool("select");
  useApp.getState().requestFit();
}

/**
 * Imports already-parsed entities (SVG, DWG): replaces the drawing as one
 * undoable step and surfaces any parse warnings via the import banner.
 */
export function importEntities(entities: Entity[], warnings: string[], replace = true): { count: number } {
  applyImportedEntities(entities, replace);
  useApp.getState().setFileWarnings(warnings);
  return { count: entities.length };
}

/* -------------------------------- groups -------------------------------- */

/** Groups the current selection into a named group; requires 2+ selected entities. Returns the new group id, or null if not applicable. */
export function groupSelection(name?: string): GroupId | null {
  const { selection } = useApp.getState();
  if (selection.length < 2) return null;
  const groupId = newGroupId();
  bus.execute({ type: "group-entities", groupId, ids: selection, name: name ?? "Group" });
  useApp.getState().setSelection(selection); // keep the (now grouped) selection as-is
  return groupId;
}

/** Ungroups the current selection, if it's exactly one whole group. */
export function ungroupSelection(): boolean {
  const { selection } = useApp.getState();
  const groupId = wholeGroupSelected(doc, selection);
  if (!groupId) return false;
  bus.execute({ type: "ungroup", groupId });
  return true;
}

/**
 * Imports DXF text: replaces the drawing with the file's geometry as one
 * undoable step. Returns the entity count and any parse warnings.
 */
export function importDxfText(text: string, replace = true): { count: number; warnings: string[] } {
  const { entities, warnings, report, insUnits } = parseDxf(text);
  applyImportedEntities(entities, replace);
  useApp.getState().setImportReport(report);
  // The file's own $INSUNITS becomes the display unit; unspecified/unmapped units leave it as-is.
  const unit = dxfCodeToDisplayUnit(insUnits);
  if (unit) useApp.getState().setDisplayUnit(unit);
  return { count: entities.length, warnings };
}

export type ToolId = "select" | "line" | "circle" | "point" | "measure" | "straighten";

export const TOOL_HINTS: Record<ToolId, string> = {
  select: "Click to select (Shift adds) - drag left-to-right to window-select, right-to-left to crossing-select - drag to move - Del deletes - G groups - U ungroups",
  line: "Click start point, then click next points to chain - Esc to finish",
  circle: "Click center, then click a point on the circle",
  point: "Click to place a point",
  measure: "Click a line/circle/arc for its length/radius, click inside a closed area for its area, Shift-click more lines to total - else click two points to measure distance",
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

/* ------------------------------- healing -------------------------------- */

function runCommands(commands: Command[]): void {
  if (commands.length === 1) bus.execute(commands[0]);
  else if (commands.length > 1) bus.execute({ type: "batch", commands });
}

/** Re-scans the drawing for unjointed-line issues under the current tolerances. */
export function rescanHeal(): void {
  useApp.getState().setHealIssues(scanForIssues(doc, useApp.getState().healOptions));
}

/** Fixes one diagnostics-panel finding, then re-scans. */
export function fixOneHeal(issueId: string): void {
  const { healIssues, joinCollinear } = useApp.getState();
  const issue = healIssues.find((i) => i.id === issueId);
  if (!issue) return;
  runCommands(fixIssue(doc, issue, joinCollinear));
  rescanHeal();
}

/** Fixes every current finding as one undoable step, then re-scans. */
export function fixAllHeal(): void {
  const { healIssues, joinCollinear } = useApp.getState();
  runCommands(fixAllIssues(doc, healIssues, joinCollinear));
  rescanHeal();
}

/* ---------------------------- duplicate geometry -------------------------- */

/** Re-scans the drawing for duplicate/overlapping geometry under the current tolerance. */
export function rescanDuplicates(): void {
  useApp.getState().setDuplicateIssues(scanForDuplicates(doc, useApp.getState().duplicateOptions));
}

/** Fixes one duplicates-panel finding (deletes the redundant copies), then re-scans. */
export function fixOneDuplicate(issueId: string): void {
  const issue = useApp.getState().duplicateIssues.find((i) => i.id === issueId);
  if (!issue) return;
  runCommands(fixDuplicate(issue));
  rescanDuplicates();
}

/** Fixes every current finding as one undoable step, then re-scans. */
export function fixAllDuplicatesAction(): void {
  runCommands(fixAllDuplicates(useApp.getState().duplicateIssues));
  rescanDuplicates();
}

/**
 * A live or frozen result from the measure tool. `distance` is the original
 * two-point mode (now also carrying delta X/Y); the rest cover clicking an
 * entity or a closed area directly instead of picking two points.
 */
export type MeasureResult =
  | { kind: "distance"; a: Point; b: Point }
  | { kind: "length"; ids: EntityId[]; total: number }
  | { kind: "radius"; id: EntityId; center: Point; radius: number }
  | { kind: "area"; region: ClosedRegion };

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
  measurement: MeasureResult | null;
  layers: Layer[];
  activeLayer: string;
  /** Which tab (see DocSession) is currently shown; bump `sessionsVersion` after mutating the sessions array itself. */
  activeSessionId: string;
  sessionsVersion: number;
  /** Parsed-vs-skipped tally from the most recent DXF import; null once dismissed. */
  importReport: DxfImportReport | null;
  setImportReport: (report: DxfImportReport | null) => void;
  /** Warnings from the most recent SVG/DWG import (e.g. curve approximation, unreadable file); [] once dismissed. */
  fileWarnings: string[];
  setFileWarnings: (warnings: string[]) => void;
  /** The line entity picked as the straighten tool's reference edge (must be in `selection`). */
  referenceEdgeId: EntityId | null;
  straightenAxis: StraightenAxis;
  straightenPivot: StraightenPivot;
  setReferenceEdge: (id: EntityId | null) => void;
  setStraightenAxis: (axis: StraightenAxis) => void;
  setStraightenPivot: (pivot: StraightenPivot) => void;
  /** Findings from the most recent heal scan (see the Diagnostics panel). */
  healIssues: HealIssue[];
  healOptions: HealOptions;
  joinCollinear: boolean;
  /** World point the Diagnostics panel last asked the viewport to frame. */
  healFocus: Point | null;
  setHealIssues: (issues: HealIssue[]) => void;
  setHealOptions: (options: Partial<HealOptions>) => void;
  setJoinCollinear: (v: boolean) => void;
  setHealFocus: (p: Point | null) => void;
  /** Findings from the most recent duplicate/overlap scan (see the Duplicates panel). */
  duplicateIssues: DuplicateIssue[];
  duplicateOptions: DuplicateOptions;
  /** World point the Duplicates panel last asked the viewport to frame. */
  duplicateFocus: Point | null;
  setDuplicateIssues: (issues: DuplicateIssue[]) => void;
  setDuplicateOptions: (options: Partial<DuplicateOptions>) => void;
  setDuplicateFocus: (p: Point | null) => void;
  /** The group currently "entered" for editing individual members (double-click a group, Esc to exit). */
  enteredGroupId: GroupId | null;
  setEnteredGroup: (id: GroupId | null) => void;
  /** In-app file browser (R9): left-dock panel visibility. */
  fileBrowserVisible: boolean;
  setFileBrowserVisible: (v: boolean) => void;
  /** Desktop only: a directory the file browser should auto-load (set when a file is opened from Explorer). */
  fileBrowserDesktopDir: string | null;
  setFileBrowserDesktopDir: (dir: string | null) => void;
  /**
   * R2's interim connectivity hint: colors entities with a free (unshared)
   * endpoint blue. This is NOT real constraint/DOF status — there's no
   * solver yet — so it's opt-in and off by default. See connectivity.ts.
   */
  showConnectivityHint: boolean;
  setShowConnectivityHint: (v: boolean) => void;
  /** Fills detected closed loops (lines/arcs chained shut, or circles) with a translucent tint — on by default. */
  showClosedRegions: boolean;
  setShowClosedRegions: (v: boolean) => void;
  /** Bumped whenever the viewport should zoom-to-fit (e.g. after opening a file) — Viewport watches this. */
  fitRequestId: number;
  requestFit: () => void;
  setTool: (tool: ToolId) => void;
  setSelection: (ids: EntityId[]) => void;
  setCursor: (cursor: { x: number; y: number } | null) => void;
  setZoom: (zoom: number) => void;
  setMeasurement: (measurement: MeasureResult | null) => void;
  displayUnit: DisplayUnit;
  setDisplayUnit: (unit: DisplayUnit) => void;
  setActiveLayer: (name: string) => void;
  addLayer: () => void;
  deleteLayer: (name: string) => void;
  renameLayer: (from: string, to: string) => void;
  toggleLayer: (name: string) => void;
  /** Rebuild the layer list from the document (used after DXF import). */
  syncLayersFromDoc: (reset?: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  tool: "select",
  selection: [],
  revision: 0,
  cursor: null,
  zoom: 1,
  measurement: null,
  layers: [{ name: DEFAULT_LAYER, visible: true }],
  activeLayer: DEFAULT_LAYER,
  activeSessionId: sessions[0].id,
  sessionsVersion: 0,
  importReport: null,
  setImportReport: (report) => set({ importReport: report }),
  fileWarnings: [],
  setFileWarnings: (warnings) => set({ fileWarnings: warnings }),
  referenceEdgeId: null,
  straightenAxis: "horizontal",
  straightenPivot: "center",
  setReferenceEdge: (id) => set({ referenceEdgeId: id }),
  setStraightenAxis: (axis) => set({ straightenAxis: axis }),
  setStraightenPivot: (pivot) => set({ straightenPivot: pivot }),
  healIssues: [],
  healOptions: DEFAULT_HEAL_OPTIONS,
  joinCollinear: false,
  healFocus: null,
  setHealIssues: (healIssues) => set({ healIssues }),
  setHealOptions: (options) => set((s) => ({ healOptions: { ...s.healOptions, ...options } })),
  setJoinCollinear: (v) => set({ joinCollinear: v }),
  setHealFocus: (p) => set({ healFocus: p }),
  duplicateIssues: [],
  duplicateOptions: DEFAULT_DUPLICATE_OPTIONS,
  duplicateFocus: null,
  setDuplicateIssues: (duplicateIssues) => set({ duplicateIssues }),
  setDuplicateOptions: (options) => set((s) => ({ duplicateOptions: { ...s.duplicateOptions, ...options } })),
  setDuplicateFocus: (p) => set({ duplicateFocus: p }),
  enteredGroupId: null,
  setEnteredGroup: (id) => set({ enteredGroupId: id }),
  fileBrowserVisible: true,
  setFileBrowserVisible: (v) => set({ fileBrowserVisible: v }),
  fileBrowserDesktopDir: null,
  setFileBrowserDesktopDir: (dir) => set({ fileBrowserDesktopDir: dir }),
  showConnectivityHint: false,
  setShowConnectivityHint: (v) => set({ showConnectivityHint: v }),
  showClosedRegions: true,
  setShowClosedRegions: (v) => set({ showClosedRegions: v }),
  fitRequestId: 0,
  requestFit: () => set((s) => ({ fitRequestId: s.fitRequestId + 1 })),
  // Switching tools invalidates any in-progress reference-edge pick or entered group.
  setTool: (tool) => set({ tool, referenceEdgeId: null, enteredGroupId: null }),
  setSelection: (selection) => set({ selection }),
  setCursor: (cursor) => set({ cursor }),
  setZoom: (zoom) => set({ zoom }),
  setMeasurement: (measurement) => set({ measurement }),
  displayUnit: "mm",
  setDisplayUnit: (displayUnit) => set({ displayUnit }),
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

function syncFromBus(): void {
  useApp.setState((s) => {
    const selection = s.selection.filter((id) => doc.has(id));
    return {
      revision: doc.revision,
      selection,
      referenceEdgeId:
        s.referenceEdgeId && selection.includes(s.referenceEdgeId) ? s.referenceEdgeId : null,
      // Drop findings that no longer make sense (their entities were edited/removed elsewhere).
      healIssues: s.healIssues.filter((issue) => issueEntityIds(issue).every((id) => doc.has(id))),
      duplicateIssues: s.duplicateIssues.filter((issue) => issue.entityIds.every((id) => doc.has(id))),
    };
  });
  activeSession().dirty = true;
}

let unbindBus: (() => void) | null = null;
/** Re-subscribes the revision/selection/dirty sync to whichever session's bus is now active. */
function rebindBus(): void {
  unbindBus?.();
  unbindBus = bus.onChange(syncFromBus);
}
rebindBus();

/* ------------------------------ document tabs ---------------------------- */

function bumpSessionsVersion(): void {
  useApp.setState((s) => ({ sessionsVersion: s.sessionsVersion + 1 }));
}

function isSessionBlank(s: DocSession): boolean {
  return s.doc.all().length === 0 && !s.dirty && !s.named;
}

function nextUntitledName(): string {
  const used = new Set(sessions.filter((s) => !s.named).map((s) => s.name));
  let i = 1;
  while (used.has(`Untitled-${i}`)) i += 1;
  return `Untitled-${i}`;
}

/** All open tabs, in order. Re-read this after `sessionsVersion` changes. */
export function getSessions(): DocSession[] {
  return sessions;
}

export function getSessionView(id: string): { scale: number; ox: number; oy: number } | null {
  return sessions.find((s) => s.id === id)?.view ?? null;
}

export function setSessionView(id: string, view: { scale: number; ox: number; oy: number }): void {
  const s = sessions.find((s) => s.id === id);
  if (s) s.view = { ...view };
}

/** Switches the active tab, saving the outgoing tab's selection/layers and rebinding undo/redo sync. */
export function switchToSession(id: string): void {
  const state = useApp.getState();
  if (id === state.activeSessionId) return;
  const outgoing = sessions.find((s) => s.id === state.activeSessionId);
  if (outgoing) {
    outgoing.selection = state.selection;
    outgoing.layers = state.layers;
    outgoing.activeLayer = state.activeLayer;
  }
  const incoming = sessions.find((s) => s.id === id);
  if (!incoming) return;
  useApp.setState({
    activeSessionId: id,
    selection: incoming.selection,
    layers: incoming.layers,
    activeLayer: incoming.activeLayer,
    revision: incoming.doc.revision,
    // Tool-scoped state doesn't carry meaning across a document switch.
    referenceEdgeId: null,
    enteredGroupId: null,
    healIssues: [],
    duplicateIssues: [],
    measurement: null,
    importReport: null,
  });
  rebindBus();
  bumpSessionsVersion();
}

/** Opens a new, empty tab and switches to it. */
export function newTab(): void {
  const s = newSession(nextUntitledName());
  sessions.push(s);
  switchToSession(s.id);
  bumpSessionsVersion();
}

/** Closes a tab (prompting if it has unsaved changes); always leaves at least one tab open. */
export function closeTab(id: string): void {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  if (sessions[idx].dirty) {
    const ok = window.confirm(`"${sessions[idx].name}" has unsaved changes. Close anyway?`);
    if (!ok) return;
  }
  const wasActive = useApp.getState().activeSessionId === id;
  sessions.splice(idx, 1);
  if (sessions.length === 0) sessions.push(newSession(nextUntitledName()));
  if (wasActive) {
    // The closed session is already gone from `sessions`, so switchToSession's
    // "save the outgoing tab" step is naturally a no-op (nothing to save into).
    const next = sessions[Math.max(0, idx - 1)] ?? sessions[0];
    switchToSession(next.id);
  }
  bumpSessionsVersion();
}

/**
 * Targets a tab for opening a file into: if a tab with this name is already
 * open, switches to it and re-runs `load` there (so re-opening a file never
 * duplicates its tab — reloads it instead). Otherwise reuses the active tab
 * if it's still blank (a fresh, unmodified "Untitled" tab), else opens a new
 * one — matching Ctrl+O / desktop file-association behavior from the spec.
 */
export function openIntoSession(name: string, load: () => void): void {
  const existing = sessions.find((s) => s.named && s.name === name);
  let active: DocSession;
  if (existing) {
    switchToSession(existing.id);
    active = existing;
  } else {
    active = sessions.find((s) => s.id === useApp.getState().activeSessionId)!;
    if (!isSessionBlank(active)) {
      active = newSession(name);
      sessions.push(active);
      switchToSession(active.id);
    }
  }
  load();
  active.name = name;
  active.named = true;
  active.dirty = false;
  bumpSessionsVersion();
}

/** Marks the active tab as saved under `name` (e.g. after a successful Save-as). */
export function finishSessionSave(name: string): void {
  const active = sessions.find((s) => s.id === useApp.getState().activeSessionId);
  if (!active) return;
  active.name = name;
  active.named = true;
  active.dirty = false;
  bumpSessionsVersion();
}

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
      rescanHeal: typeof rescanHeal;
      fixAllHeal: typeof fixAllHeal;
      getHealIssues: () => HealIssue[];
      getSelection: () => EntityId[];
      getEnteredGroup: () => GroupId | null;
      newTab: typeof newTab;
      closeTab: typeof closeTab;
      switchToSession: typeof switchToSession;
      getSessions: typeof getSessions;
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
  rescanHeal,
  fixAllHeal,
  getSelection: () => useApp.getState().selection,
  getEnteredGroup: () => useApp.getState().enteredGroupId,
  getHealIssues: () => useApp.getState().healIssues,
  newTab,
  closeTab,
  switchToSession,
  getSessions,
};
