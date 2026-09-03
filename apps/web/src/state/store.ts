import { create } from "zustand";
import { dxfCodeToDisplayUnit, formatArea, formatLength, loadDisplayUnit, saveDisplayUnit, type DisplayUnit } from "../units";
import {
  CommandBus,
  DEFAULT_DUPLICATE_OPTIONS,
  DEFAULT_HEAL_OPTIONS,
  DEFAULT_LAYER,
  SketchDocument,
  centroidOfEntities,
  diffToCommands,
  dist,
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
  PALETTE,
  parseCode,
  parseDxf,
  patternCommands,
  reduceToHalfTurn,
  scanForCrossings,
  scanForDuplicates,
  scanForIssues,
  toCode,
  wholeGroupSelected,
  type ClosedRegion,
  type Command,
  type CrossingIssue,
  type DuplicateIssue,
  type DuplicateOptions,
  type DxfImportReport,
  type Entity,
  type EntityId,
  type GroupId,
  type HealIssue,
  type HealOptions,
  type ParseIssue,
  type PatternSpec,
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
  /** Display unit for this tab (e.g. from a DXF's $INSUNITS on open), restored when it becomes active again. */
  displayUnit: DisplayUnit;
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
    displayUnit: loadDisplayUnit() ?? "mm",
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
  // The file's own $INSUNITS becomes the document's saved unit; unspecified/
  // unmapped units leave it as-is. Only a real open (replace) may do this —
  // the document keeps its own unit unless the user explicitly changes it
  // (via the display-unit picker) or opens a new file over it; an overlay
  // add (see overlayEntities) never reaches this branch.
  const unit = dxfCodeToDisplayUnit(insUnits);
  if (replace && unit) useApp.getState().setDisplayUnit(unit);
  return { count: entities.length, warnings };
}

/** Layer name for {@link overlayEntities}: `base` if free, else `base (2)`, `base (3)`, ... */
function uniqueOverlayLayerName(base: string): string {
  const used = new Set(useApp.getState().layers.map((l) => l.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}

/**
 * Adds entities to the current drawing on their own new layer, without
 * replacing anything — used to overlay a second file (e.g. another
 * revision of the same part) on top of the current one so the differences
 * show up visually and the overlay can be toggled or selected apart from
 * the existing geometry. Deliberately never touches `displayUnit`: unlike
 * {@link importDxfText}'s replace path, overlaying isn't "opening" a
 * document, so the document keeps whatever unit it already had.
 */
export function overlayEntities(entities: Entity[], label: string): { count: number; layer: string } {
  const layer = uniqueOverlayLayerName(label);
  const tagged = entities.map((e) => ({ ...e, layer }));
  applyImportedEntities(tagged, false);
  useApp.getState().setActiveLayer(layer);
  return { count: entities.length, layer };
}

/** DXF-specific overlay: parses `text` and adds it via {@link overlayEntities}. The file's own `$INSUNITS` still scales its coordinates into the shared millimeter space (see dxf.ts) — only the document's own saved unit is left alone. */
export function overlayDxfText(text: string, label: string): { count: number; warnings: string[]; layer: string } {
  const { entities, warnings, report } = parseDxf(text);
  useApp.getState().setImportReport(report);
  return { ...overlayEntities(entities, label), warnings };
}

export type ToolId = "select" | "line" | "polyline" | "circle" | "point" | "measure" | "straighten" | "fill";

export const TOOL_HINTS: Record<ToolId, string> = {
  select: "Click to select (Shift adds) - drag left-to-right to window-select, right-to-left to crossing-select - drag to move - Del deletes - G groups - U ungroups",
  line: "Click start point, then click next points to chain - middle/right-drag pans and the wheel zooms without losing the line - Esc finishes and returns to the select tool",
  polyline: "Click each vertex - Enter or double-click to finish, C to close the shape, Backspace undoes the last vertex, middle/right-drag pans without losing it, Esc cancels and returns to the select tool",
  circle: "Click center, then click a point on the circle",
  point: "Click to place a point",
  measure: "Click two points to measure distance (snaps to endpoints, midpoints, centers, on-line points, intersections) - Ctrl-click a line to set it as the angle reference - Alt-click a line/circle/arc for its whole length/radius, Shift-Alt-click more lines/arcs to total - click inside a closed area for its area+perimeter - Ctrl+C copies the readout",
  straighten: "Select the part with V, switch here, click the reference edge, then Enter to apply",
  fill: "Pick a colour, then click a closed shape to hatch-fill it - Alt-click removes a fill - use the panel to apply to a whole selection",
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

/* --------------------------------- pattern -------------------------------- */

/**
 * Arrays the current selection, as one undoable step, and selects the result
 * (originals plus copies) so it can be moved or patterned again. No-op when
 * nothing is selected or the spec produces no copies.
 */
export function applyPattern(spec: PatternSpec): number {
  const { selection } = useApp.getState();
  if (selection.length === 0) return 0;
  const commands = patternCommands(doc, selection, spec);
  if (commands.length === 0) return 0;

  bus.execute({ type: "batch", commands });
  const added = commands
    .map((c) => (c.type === "add-entity" ? c.entity.id : null))
    .filter((id): id is EntityId => id !== null);
  useApp.getState().setSelection([...selection, ...added]);
  return added.length;
}

/* ---------------------------- duplicate geometry -------------------------- */

/** Re-scans the drawing for duplicate/overlapping geometry under the current tolerance, and for line crossings. */
export function rescanDuplicates(): void {
  useApp.getState().setDuplicateIssues(scanForDuplicates(doc, useApp.getState().duplicateOptions));
  useApp.getState().setCrossingIssues(scanForCrossings(doc));
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
  | { kind: "radius"; id: EntityId; center: Point; radius: number; arcLength?: number }
  | { kind: "area"; region: ClosedRegion };

function wrapDeg(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** Plain-text rendering of a measurement (status bar readout, and what Ctrl+C copies). `referenceAngleDeg` is the measure tool's Ctrl-clicked reference edge, if any. */
export function measurementText(m: MeasureResult, unit: DisplayUnit, referenceAngleDeg: number | null = null): string {
  switch (m.kind) {
    case "distance": {
      const d = dist(m.a, m.b);
      const dx = Math.abs(m.b.x - m.a.x);
      const dy = Math.abs(m.b.y - m.a.y);
      const angle = (Math.atan2(m.b.y - m.a.y, m.b.x - m.a.x) * 180) / Math.PI;
      const angleText = referenceAngleDeg === null ? "" : `  ∠ edge ${wrapDeg(angle - referenceAngleDeg).toFixed(2)}°`;
      return `distance ${formatLength(d, unit)}  (Δx ${formatLength(dx, unit)}, Δy ${formatLength(dy, unit)})${angleText}`;
    }
    case "length":
      return m.ids.length > 1
        ? `total length ${formatLength(m.total, unit)} (${m.ids.length} entities)`
        : `length ${formatLength(m.total, unit)}`;
    case "radius":
      return (
        `radius ${formatLength(m.radius, unit)}  diameter ${formatLength(m.radius * 2, unit)}` +
        (m.arcLength !== undefined ? `  arc length ${formatLength(m.arcLength, unit)}` : "")
      );
    case "area": {
      let perimeter = 0;
      const pts = m.region.points;
      for (let i = 0; i < pts.length; i++) perimeter += dist(pts[i], pts[(i + 1) % pts.length]);
      return `area ${formatArea(m.region.area, unit)}  perimeter ${formatLength(perimeter, unit)}`;
    }
  }
}

/** Direction (degrees) of the measure/straighten tool's Ctrl/click-picked reference edge, or null if none/not a line. */
export function referenceEdgeAngleDeg(): number | null {
  const id = useApp.getState().referenceEdgeId;
  const edge = id ? doc.get(id) : null;
  return edge?.type === "line" ? (Math.atan2(edge.b.y - edge.a.y, edge.b.x - edge.a.x) * 180) / Math.PI : null;
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
  measurement: MeasureResult | null;
  /** Measurements kept on screen alongside the live one (measure tool's "pin" action), newest last. */
  pinnedMeasurements: MeasureResult[];
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
  /** The colour the Fill/Hatch tool applies on click and the Fill panel seeds from. */
  fillColor: string;
  setFillColor: (color: string) => void;
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
  /** Read-only findings from the most recent line-crossing scan — no auto-fix (see crossings.ts). */
  crossingIssues: CrossingIssue[];
  setCrossingIssues: (issues: CrossingIssue[]) => void;
  /**
   * Outcome of the most recent save, surfaced in the status bar. Ctrl+S over
   * an already-chosen file writes with no dialog, so without this the app
   * gives no sign it did anything.
   */
  saveNotice: { kind: "saved" | "error"; message: string; at: number } | null;
  setSaveNotice: (notice: { kind: "saved" | "error"; message: string; at: number } | null) => void;
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
  /** Adds the current live measurement to the pinned list (capped, drops the oldest). No-op if there's nothing live. */
  pinMeasurement: () => void;
  clearPinnedMeasurements: () => void;
  displayUnit: DisplayUnit;
  setDisplayUnit: (unit: DisplayUnit) => void;
  setActiveLayer: (name: string) => void;
  addLayer: () => void;
  deleteLayer: (name: string) => void;
  renameLayer: (from: string, to: string) => void;
  toggleLayer: (name: string) => void;
  /** Rebuild the layer list from the document (used after DXF import). */
  syncLayersFromDoc: (reset?: boolean) => void;
  /** Moves every entity onto the default layer and drops all other layer definitions, as one undo step. */
  flattenLayers: () => void;
  /** Removes every layer with no entities on it (never the default layer). */
  deleteEmptyLayers: () => void;
}

/** entity with its `layer` field cleared (falls back to the default layer via layerOf). */
function withoutLayer(e: Entity): Entity {
  const { layer: _layer, ...rest } = e;
  return rest as Entity;
}

export const useApp = create<AppState>((set, get) => ({
  tool: "select",
  selection: [],
  revision: 0,
  cursor: null,
  zoom: 1,
  measurement: null,
  pinnedMeasurements: [],
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
  fillColor: PALETTE[0],
  setFillColor: (color) => set({ fillColor: color }),
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
  crossingIssues: [],
  setCrossingIssues: (crossingIssues) => set({ crossingIssues }),
  saveNotice: null,
  setSaveNotice: (saveNotice) => set({ saveNotice }),
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
  pinMeasurement: () =>
    set((s) => (s.measurement ? { pinnedMeasurements: [...s.pinnedMeasurements, s.measurement].slice(-5) } : s)),
  clearPinnedMeasurements: () => set({ pinnedMeasurements: [] }),
  displayUnit: loadDisplayUnit() ?? "mm",
  setDisplayUnit: (displayUnit) => {
    saveDisplayUnit(displayUnit);
    set({ displayUnit });
  },
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
    // Deleting a layer removes the grouping, not the geometry: its entities
    // move to the default layer as one undoable step rather than being
    // destroyed along with the layer.
    const entities = doc.all().filter((e) => layerOf(e) === name);
    if (entities.length > 0) {
      bus.execute({ type: "batch", commands: entities.map((e) => ({ type: "update-entity", entity: withoutLayer(e) })) });
    }
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
  flattenLayers: () => {
    const toMove = doc.all().filter((e) => layerOf(e) !== DEFAULT_LAYER);
    if (toMove.length > 0) {
      bus.execute({ type: "batch", commands: toMove.map((e) => ({ type: "update-entity", entity: withoutLayer(e) })) });
    }
    set({ layers: [{ name: DEFAULT_LAYER, visible: true }], activeLayer: DEFAULT_LAYER });
  },
  deleteEmptyLayers: () => {
    set((s) => {
      const used = new Set(doc.all().map((e) => layerOf(e)));
      const layers = s.layers.filter((l) => l.name === DEFAULT_LAYER || used.has(l.name));
      const activeLayer = layers.some((l) => l.name === s.activeLayer) ? s.activeLayer : DEFAULT_LAYER;
      return { layers, activeLayer };
    });
  },
}));

function syncFromBus(): void {
  const session = activeSession();
  const becameDirty = !session.dirty;
  session.dirty = true;

  useApp.setState((s) => {
    const selection = s.selection.filter((id) => doc.has(id));
    return {
      revision: doc.revision,
      selection,
      // `dirty` lives on the session object, which the tab strip reads through
      // getSessions() rather than subscribing to. Bumping the version here is
      // what actually makes the unsaved-changes dot appear — without it the
      // flag flips but nothing re-renders, so an edit looked unrecorded.
      ...(becameDirty ? { sessionsVersion: s.sessionsVersion + 1 } : {}),
      // The straighten tool's reference edge must stay part of the selection;
      // the measure tool's angle-reference edge (Ctrl-click) isn't selection-bound,
      // so it only needs to still exist.
      referenceEdgeId: s.referenceEdgeId && doc.has(s.referenceEdgeId) && (s.tool === "measure" || selection.includes(s.referenceEdgeId))
        ? s.referenceEdgeId
        : null,
      // Drop findings that no longer make sense (their entities were edited/removed elsewhere).
      healIssues: s.healIssues.filter((issue) => issueEntityIds(issue).every((id) => doc.has(id))),
      duplicateIssues: s.duplicateIssues.filter((issue) => issue.entityIds.every((id) => doc.has(id))),
      crossingIssues: s.crossingIssues.filter((issue) => issue.entityIds.every((id) => doc.has(id))),
    };
  });
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
    outgoing.displayUnit = state.displayUnit;
  }
  const incomingIdx = sessions.findIndex((s) => s.id === id);
  if (incomingIdx === -1) return;
  // Most-recently-used ordering: the tab being switched to moves to the front of the strip.
  const [incoming] = sessions.splice(incomingIdx, 1);
  sessions.unshift(incoming);
  useApp.setState({
    activeSessionId: id,
    selection: incoming.selection,
    layers: incoming.layers,
    activeLayer: incoming.activeLayer,
    displayUnit: incoming.displayUnit,
    revision: incoming.doc.revision,
    // Tool-scoped state doesn't carry meaning across a document switch.
    referenceEdgeId: null,
    enteredGroupId: null,
    healIssues: [],
    duplicateIssues: [],
    crossingIssues: [],
    measurement: null,
    pinnedMeasurements: [],
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
