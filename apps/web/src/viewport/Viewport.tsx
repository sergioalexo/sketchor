import { useEffect, useRef, useState } from "react";
import type { BoxSelectMode, ClosedRegion, Command, Entity, EntityId, Point, TextEntity } from "@sketchor/core";
import {
  arcSweep,
  boundsOf,
  bulgeToArc,
  dist,
  distToArc,
  distToSegment,
  polylineSegments,
  entitiesInBox,
  entityPoints,
  findClosedRegions,
  freeEndpointEntityIds,
  imageCorners,
  regionContainingPoint,
  resolveSelection,
  layerOf,
  newEntityId,
  nextEntityName,
  polylineLength,
  textCorners,
  linearDimension,
  newGroupId,
  wholeGroupSelected,
} from "@sketchor/core";
import {
  applyStraighten,
  bus,
  closeTab,
  computeStraightenTransform,
  doc,
  getSessionView,
  groupSelection,
  hiddenLayerSet,
  measurementText,
  referenceEdgeAngleDeg,
  setSessionView,
  ungroupSelection,
  useApp,
} from "../state/store";
import { openDrawing, saveCurrent } from "../io/drawingFile";
import { matchesBinding, matchesModifier } from "../keybindings";
import { printDrawing } from "../print/printDrawing";
import { formatArea, formatLength } from "../units";
import { render } from "./renderer";
import { setImageDecodeCallback } from "./imageCache";
import { findSnap, snapMovingSelection, snapRotation, type Snap } from "./snapping";
import { fitToBounds, gridStep, screenToWorld, worldToScreen, zoomAt, type View } from "./view";
import { getTool, type Pick, type ToolContext } from "../tools";
import { copySelectionToClipboard, pasteFromClipboard } from "../io/clipboard";
import { applyTracking, trackingIncrement, useTracking } from "../tools/tracking";
import { useSnapSettings } from "../tools/snapSettings";
import { parseTypedInput, resolveTypedInput, startsTypedInput } from "../tools/typedInput";

/**
 * The half-finished states a pan can interrupt. Panning or zooming mid-draw
 * must not throw the drawing away — you routinely need to scroll to where the
 * far end of a line goes — so a pan stashes one of these in its `resume` and
 * puts it back on pointer-up. (The drawing tools on the tool framework —
 * see ../tools — keep their own state and need no stashing; only the
 * legacy measure/dim sequences still live here.)
 */
type DrawInteraction = { kind: "measure"; start: Point } | { kind: "dim"; start: Point };

type Interaction =
  | { kind: "idle" }
  | { kind: "pan"; lastX: number; lastY: number; resume: DrawInteraction | { kind: "idle" } }
  /** Two fingers down: pan by the midpoint, zoom by the spread. Like "pan", it keeps a half-drawn entity. */
  | { kind: "pinch"; resume: DrawInteraction | { kind: "idle" } }
  | DrawInteraction
  | {
      kind: "move";
      ids: EntityId[];
      startWorld: Point;
      startScreen: Point;
      dx: number;
      dy: number;
      /** Every vertex of the selection at grab time; a snapped move aligns whichever one lands closest to a target. */
      baseVertices: Point[];
      /**
       * If this pointerdown grabbed an already-multi-selected item, the ids to
       * collapse the selection down to on pointerup *if it turns out to be a
       * plain click* (no drag) — a drag instead moves every currently selected
       * id together. `null` when no collapsing is needed (fresh click, or the
       * click already matched the whole selection).
       */
      collapseTo: EntityId[] | null;
    }
  | { kind: "rotate-group"; ids: EntityId[]; pivot: Point; startAngle: number; rotation: number }
  | { kind: "box-select"; startScreen: Point; startWorld: Point; currentWorld: Point; additive: boolean };

const DRAW_KINDS = ["measure", "dim"] as const;

/** Narrows to the states worth preserving across a pan (see DrawInteraction). */
function resumable(i: Interaction): DrawInteraction | { kind: "idle" } {
  return (DRAW_KINDS as readonly string[]).includes(i.kind) ? (i as DrawInteraction) : { kind: "idle" };
}

/** Fixed pixel offset above a selected group's bounding box where its rotate handle is drawn/hit-tested. */
const GROUP_HANDLE_OFFSET_PX = 26;
const GROUP_HANDLE_HIT_PX = 8;

function groupHandleScreenPos(view: View, bb: { minX: number; maxX: number; maxY: number }): Point {
  const s = worldToScreen(view, { x: (bb.minX + bb.maxX) / 2, y: bb.maxY });
  return { x: s.x, y: s.y - GROUP_HANDLE_OFFSET_PX };
}

/** Every vertex of the selection — the anchors a snapped move/rotate can align. */
function selectionVertices(ids: EntityId[]): Point[] {
  const out: Point[] = [];
  for (const id of ids) {
    const entity = doc.get(id);
    if (!entity) continue;
    for (const p of entityPoints(entity)) out.push(p);
  }
  return out;
}

/** The "mouse.freeMove" modifier (Ctrl/⌘ by default, rebindable) held during a drag turns off position and angle snapping. */
function noSnap(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return matchesModifier(e, "mouse.freeMove");
}

/**
 * Flips the current selection between construction (dashed) and normal
 * (solid) lines — reusing the existing `dashed` entity flag, the same one
 * the load-planner guides and other construction geometry already draw with.
 * Text has no `dashed` concept and is skipped. If every eligible entity is
 * already dashed, this turns them all solid; otherwise it dashes them all.
 */
function toggleConstruction(): void {
  const { selection } = useApp.getState();
  const targets = selection
    .map((id) => doc.get(id))
    .filter((e): e is Exclude<Entity, TextEntity> => !!e && e.type !== "text");
  if (targets.length === 0) return;
  const allDashed = targets.every((e) => e.dashed === true);
  const commands: Command[] = targets.map((e) => {
    const entity = { ...e };
    if (allDashed) delete entity.dashed;
    else entity.dashed = true;
    return { type: "update-entity", entity };
  });
  bus.execute(commands.length === 1 ? commands[0] : { type: "batch", commands });
}

/** New geometry carries the active layer (omitted when it's the default). */
function activeLayerProp(active: string): { layer?: string } {
  return active && active !== "0" ? { layer: active } : {};
}

function hitTest(view: View, world: Point): EntityId | null {
  const tol = 6 / view.scale;
  const hidden = hiddenLayerSet();
  let best: EntityId | null = null;
  let bestDist = tol;
  for (const e of doc.all()) {
    if (hidden.has(layerOf(e))) continue; // can't pick what you can't see
    const d =
      e.type === "line"
        ? distToSegment(world, e.a, e.b)
        : e.type === "circle"
          ? // A hatch-filled circle (e.g. a round pallet) is clickable anywhere
            // inside it, not just on its rim — matching how a solid shape
            // behaves in every other drawing app.
            e.fill && dist(world, e.center) <= e.radius
            ? 0
            : Math.abs(dist(world, e.center) - e.radius)
          : e.type === "point"
            ? dist(world, e.p)
            : e.type === "text"
              ? // Anywhere inside the label's box counts.
                textCorners(e).some((p, i, c) => distToSegment(world, p, c[(i + 1) % c.length]) < tol) ||
                pointInPolygon(world, textCorners(e))
                ? 0
                : Infinity
              : e.type === "arc"
              ? distToArc(world, e.center, e.radius, e.startAngle, e.endAngle, e.ccw)
              : e.type === "polyline"
                ? // A closed, hatch-filled polyline (e.g. a pallet) is clickable
                  // anywhere inside it, not just near its outline — otherwise
                  // clicking the middle of a big filled shape selects nothing.
                  e.closed && e.fill && pointInPolygon(world, e.points)
                  ? 0
                  : // Whichever of its segments the cursor is nearest to.
                    Math.min(
                      ...polylineSegments(e).map((seg) => {
                        const bulgeArc = bulgeToArc(seg.a, seg.b, seg.bulge);
                        return bulgeArc
                          ? distToArc(
                              world,
                              bulgeArc.center,
                              bulgeArc.radius,
                              bulgeArc.startAngle,
                              bulgeArc.endAngle,
                              bulgeArc.ccw,
                            )
                          : distToSegment(world, seg.a, seg.b);
                      }),
                    )
                : e.type === "image"
                  ? pointInPolygon(world, imageCorners(e))
                    ? 0
                    : Infinity
                  : Infinity;
    if (d <= bestDist) {
      best = e.id;
      bestDist = d;
    }
  }
  return best;
}

/**
 * The topmost closed shape (a `closed` polyline or a circle) whose interior
 * contains `world` — the "click anywhere inside" target for the Fill tool.
 * Later entities win, matching paint order.
 */
function closedEntityAt(world: Point): Entity | null {
  const hidden = hiddenLayerSet();
  let found: Entity | null = null;
  for (const e of doc.all()) {
    if (hidden.has(layerOf(e))) continue;
    if (e.type === "circle") {
      if (dist(world, e.center) <= e.radius) found = e;
    } else if (e.type === "polyline" && e.closed && pointInPolygon(world, e.points)) {
      found = e;
    }
  }
  return found;
}

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ scale: 2, ox: 0, oy: 0 });
  const interactionRef = useRef<Interaction>({ kind: "idle" });
  /**
   * Fingers currently on the canvas, by pointer id, in screen space. One
   * finger is the tool (a tap clicks, a drag drags — exactly like the left
   * mouse button); the moment a second finger lands the gesture becomes a
   * two-finger pan/pinch-zoom from any tool, and a half-drawn line survives
   * it the same way it survives a middle-drag pan.
   */
  const touchesRef = useRef<Map<number, Point>>(new Map());
  /** Last single-finger tap, for double-tap detection (dblclick is unreliable with touch-action: none). */
  const lastTapRef = useRef<{ at: number; screen: Point } | null>(null);
  /**
   * A finger that has landed but whose tool action hasn't run yet. A
   * two-finger gesture necessarily starts with one finger down, and the
   * tools act on pointerdown — so a pinch would first place a line vertex
   * or select something. The action is held back until the finger either
   * moves (a drag), lifts (a tap), or is joined by a second one (a pinch,
   * and the action is dropped).
   */
  const pendingTouchRef = useRef<React.PointerEvent | null>(null);
  const snapRef = useRef<Snap | null>(null);
  /** The ortho/polar guide to draw, when the last pointer move was projected onto one. */
  const trackingRayRef = useRef<{ from: Point; to: Point; angleDeg: number } | null>(null);
  /** Last pointer position on the canvas, where the typed-coordinate box opens. */
  const lastScreenRef = useRef<Point | null>(null);
  const hoverRef = useRef<EntityId | null>(null);
  /** The typed-coordinate box (T-08), open while a framework tool waits for a point and the user has started typing. */
  const [typed, setTyped] = useState<{ text: string; screen: Point } | null>(null);
  const closedRegionsRef = useRef<ClosedRegion[]>([]);
  const tool = useApp((s) => s.tool);
  const selection = useApp((s) => s.selection);
  const revision = useApp((s) => s.revision);
  const layers = useApp((s) => s.layers);

  // The floating text editor: open while placing or editing a text entity.
  const [textEdit, setTextEdit] = useState<{
    screen: Point;
    world: Point;
    value: string;
    id: EntityId | null;
    rotation: number;
    height: number;
  } | null>(null);

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const state = useApp.getState();
    // During a pan, draw the interaction it suspended — otherwise the rubber
    // band vanishes the moment you scroll to see where the line is going.
    const held = interactionRef.current;
    const interaction: Interaction = held.kind === "pan" || held.kind === "pinch" ? held.resume : held;
    const snap = snapRef.current;

    const activeTool = getTool(state.tool);
    const preview: Entity[] = activeTool ? activeTool.preview(toolCtx, snap?.point ?? null) : [];

    const straightenPlan = state.tool === "straighten" ? computeStraightenTransform() : null;

    // A whole-group selection gets a dashed bbox + rotate handle (select tool only).
    const groupId = state.tool === "select" ? wholeGroupSelected(doc, state.selection) : null;
    const groupBounds = groupId
      ? boundsOf(state.selection.map((id) => doc.get(id)).filter((e): e is Entity => !!e))
      : null;
    const rotating = interaction.kind === "rotate-group" ? interaction : null;
    const groupPivot = rotating
      ? rotating.pivot
      : groupBounds
        ? { x: (groupBounds.minX + groupBounds.maxX) / 2, y: (groupBounds.minY + groupBounds.maxY) / 2 }
        : null;

    render(ctx, w, h, viewRef.current, doc, {
      selection: new Set(state.selection),
      preview,
      snap: state.tool === "select" ? null : snap,
      trackingRay: activeTool ? trackingRayRef.current : null,
      moveOffset:
        interaction.kind === "move" ? { dx: interaction.dx, dy: interaction.dy } : null,
      measurement: state.measurement,
      pinnedMeasurements: state.pinnedMeasurements,
      hiddenLayers: hiddenLayerSet(),
      referenceEdgeId: state.tool === "straighten" || state.tool === "measure" ? state.referenceEdgeId : null,
      hoverId: state.tool === "measure" ? hoverRef.current : null,
      transformPreview: rotating
        ? { ids: new Set(rotating.ids), pivot: rotating.pivot, rotation: rotating.rotation }
        : straightenPlan
          ? { ...straightenPlan, ids: new Set(straightenPlan.ids) }
          : null,
      healMarkers: state.healIssues.map((i) => i.location),
      duplicateMarkers: state.duplicateIssues.map((i) => i.location),
      crossingMarkers: state.crossingIssues.map((i) => i.location),
      groupHandle: groupBounds && groupPivot ? { bounds: groupBounds, pivot: groupPivot } : null,
      freeEndpointIds: state.showConnectivityHint ? freeEndpointEntityIds(doc) : null,
      closedRegions: state.showClosedRegions ? closedRegionsRef.current.map((r) => r.points) : [],
      fmtLength: (n: number) => formatLength(n, state.displayUnit),
      fmtArea: (n: number) => formatArea(n, state.displayUnit),
      boxSelect:
        interaction.kind === "box-select"
          ? {
              start: interaction.startWorld,
              end: interaction.currentWorld,
              mode: (interaction.currentWorld.x >= interaction.startWorld.x ? "window" : "crossing") as BoxSelectMode,
            }
          : null,
    });
  };

  /** What a framework tool may touch (see ../tools/tool.ts). Stable for the component's life. */
  const toolCtxRef = useRef<ToolContext | null>(null);
  if (!toolCtxRef.current) {
    toolCtxRef.current = {
      doc,
      execute: (command) => bus.execute(command),
      commit: (commands) => {
        if (commands.length === 1) bus.execute(commands[0]);
        else if (commands.length > 1) bus.execute({ type: "batch", commands });
      },
      activeLayer: () => useApp.getState().activeLayer,
      redraw: () => redraw(),
      setTool: (id) => useApp.getState().setTool(id),
      selection: () => useApp.getState().selection,
      setSelection: (ids) => useApp.getState().setSelection(ids),
      hitTest: (world) => {
        const hit = hitTest(viewRef.current, world);
        return hit ? resolveSelection(doc, hit, useApp.getState().enteredGroupId) : [];
      },
      displayUnit: () => useApp.getState().displayUnit,
    };
  }
  const toolCtx = toolCtxRef.current;

  /** Pushes the active tool's prompt to the status bar. */
  const syncPrompt = () => {
    const app = useApp.getState();
    const t = getTool(app.tool);
    app.setPrompt(t ? t.prompt(toolCtx) : "");
  };

  /**
   * Resolves a cursor position into what a tool receives: object snap,
   * then ortho/polar tracking from the tool's anchor (a feature snap the
   * cursor touched still wins — see tracking.ts). Also records the guide
   * ray for the renderer.
   */
  const resolvePick = (world: Point, shiftKey: boolean): { snap: Snap; ray: typeof trackingRayRef.current } => {
    const view = viewRef.current;
    const app = useApp.getState();
    const t = getTool(app.tool);
    const raw = findSnap(doc, view, world, { anchor: t?.anchor() ?? null, settings: useSnapSettings.getState().settings });
    if (!t) return { snap: raw, ray: null };
    const tracked = applyTracking(t.anchor(), world, raw, trackingIncrement(useTracking.getState(), shiftKey));
    if (!tracked.ray) return { snap: raw, ray: null };
    return {
      snap: { point: tracked.point, kind: "tracking" },
      ray: { from: tracked.ray.from, to: tracked.point, angleDeg: tracked.ray.angleDeg },
    };
  };

  const pickFrom = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, world: Point, snap: Snap): Pick => ({
    point: snap.point,
    world,
    snap,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey || e.metaKey,
    altKey: e.altKey,
  });

  // Switching tools drops the previous tool's half-finished sequence and
  // shows the new one's prompt.
  const prevToolRef = useRef(tool);
  useEffect(() => {
    if (prevToolRef.current !== tool) {
      getTool(prevToolRef.current)?.cancel(toolCtx);
      prevToolRef.current = tool;
      setTyped(null);
    }
    trackingRayRef.current = null;
    syncPrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // Initial placement of the origin + resize handling
  useEffect(() => {
    const canvas = canvasRef.current!;
    viewRef.current.ox = canvas.clientWidth * 0.25;
    viewRef.current.oy = canvas.clientHeight * 0.75;
    useApp.getState().setZoom(viewRef.current.scale);
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    redraw();
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Image entities decode asynchronously (drawEntity can't await); redraw
  // once a decode finishes so the placeholder box is replaced by the picture.
  useEffect(() => {
    setImageDecodeCallback(redraw);
    return () => setImageDecodeCallback(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSessionId = useApp((s) => s.activeSessionId);
  const prevSessionIdRef = useRef(activeSessionId);

  // Switching tabs: save the outgoing tab's pan/zoom, restore (or default) the incoming one's.
  useEffect(() => {
    const prevId = prevSessionIdRef.current;
    if (prevId === activeSessionId) return;
    setSessionView(prevId, viewRef.current);
    prevSessionIdRef.current = activeSessionId;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const saved = getSessionView(activeSessionId);
    viewRef.current = saved ?? {
      scale: 2,
      ox: canvas.clientWidth * 0.25,
      oy: canvas.clientHeight * 0.75,
    };
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const measurement = useApp((s) => s.measurement);
  const pinnedMeasurements = useApp((s) => s.pinnedMeasurements);
  const referenceEdgeId = useApp((s) => s.referenceEdgeId);
  const straightenAxis = useApp((s) => s.straightenAxis);
  const straightenPivot = useApp((s) => s.straightenPivot);
  const healIssues = useApp((s) => s.healIssues);
  const duplicateIssues = useApp((s) => s.duplicateIssues);
  const crossingIssues = useApp((s) => s.crossingIssues);
  const healFocus = useApp((s) => s.healFocus);
  const showConnectivityHint = useApp((s) => s.showConnectivityHint);
  const showClosedRegions = useApp((s) => s.showClosedRegions);

  // Closed-loop detection only needs to rerun when the document changes, not
  // on every redraw (pan/zoom/selection) — cached here. Computed regardless
  // of the display toggle, since the measure tool's area-click also needs
  // it even when the highlight fill itself is turned off.
  useEffect(() => {
    closedRegionsRef.current = findClosedRegions(doc.all());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  // Redraw when document, selection, tool, measurement, layers, the straighten pick, or heal findings change
  useEffect(redraw, [
    revision,
    selection,
    tool,
    measurement,
    pinnedMeasurements,
    layers,
    referenceEdgeId,
    straightenAxis,
    straightenPivot,
    healIssues,
    duplicateIssues,
    crossingIssues,
    showConnectivityHint,
    showClosedRegions,
  ]);

  // Diagnostics panel row click: frame that finding.
  useEffect(() => {
    if (!healFocus) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const margin = 15;
    viewRef.current = fitToBounds(
      {
        minX: healFocus.x - margin,
        minY: healFocus.y - margin,
        maxX: healFocus.x + margin,
        maxY: healFocus.y + margin,
      },
      canvas.clientWidth,
      canvas.clientHeight,
      0.3,
    );
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [healFocus]);

  const duplicateFocus = useApp((s) => s.duplicateFocus);
  // Duplicates panel row click: frame that finding.
  useEffect(() => {
    if (!duplicateFocus) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const margin = 15;
    viewRef.current = fitToBounds(
      {
        minX: duplicateFocus.x - margin,
        minY: duplicateFocus.y - margin,
        maxX: duplicateFocus.x + margin,
        maxY: duplicateFocus.y + margin,
      },
      canvas.clientWidth,
      canvas.clientHeight,
      0.3,
    );
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duplicateFocus]);

  /** Zoom-extents: frames `ids` if given and non-empty, else every visible entity. */
  const fitView = (ids?: EntityId[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hidden = hiddenLayerSet();
    const visible = doc.all().filter((e) => !hidden.has(layerOf(e)));
    const targets = ids && ids.length ? visible.filter((e) => ids.includes(e.id)) : visible;
    const bb = boundsOf(targets);
    if (!bb) return;
    viewRef.current = fitToBounds(bb, canvas.clientWidth, canvas.clientHeight);
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
  };

  const fitRequestId = useApp((s) => s.fitRequestId);
  const firstFitRequestRef = useRef(true);
  // Opening a file (importDxfText/importEntities) bumps fitRequestId so the
  // newly-loaded part fills the viewport instead of sitting at whatever pan/zoom was left over.
  useEffect(() => {
    if (firstFitRequestRef.current) {
      firstFitRequestRef.current = false;
      return;
    }
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequestId]);

  // Keyboard: tools, undo/redo, delete, escape. Most bindings are rebindable
  // (see keybindings.ts) via matchesBinding(); a few stay hard-coded because
  // they're mode-dependent rather than a single command — Escape, Delete/
  // Backspace-to-delete-selection, and the in-progress-polyline keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const app = useApp.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && app.tool === "measure" && app.measurement) {
        e.preventDefault();
        void navigator.clipboard.writeText(measurementText(app.measurement, app.displayUnit, referenceEdgeAngleDeg()));
      } else if (matchesBinding(e, "file.save")) {
        e.preventDefault();
        void saveCurrent();
      } else if (matchesBinding(e, "file.open")) {
        e.preventDefault();
        void openDrawing();
      } else if (matchesBinding(e, "file.print")) {
        e.preventDefault();
        printDrawing();
      } else if (matchesBinding(e, "file.closeTab")) {
        // Desktop only in practice: browsers reserve Ctrl+W to close their own
        // tab and won't let a page preventDefault it.
        e.preventDefault();
        closeTab(useApp.getState().activeSessionId);
      } else if (matchesBinding(e, "edit.undo")) {
        bus.undo();
        e.preventDefault();
      } else if (matchesBinding(e, "edit.redo")) {
        bus.redo();
        e.preventDefault();
      } else if (matchesBinding(e, "edit.copy") || matchesBinding(e, "edit.cut")) {
        if (app.selection.length > 0) {
          e.preventDefault();
          void copySelectionToClipboard(app.selection, matchesBinding(e, "edit.cut"));
        }
      } else if (matchesBinding(e, "edit.paste") || matchesBinding(e, "edit.pasteInPlace")) {
        e.preventDefault();
        const inPlace = matchesBinding(e, "edit.pasteInPlace");
        const at = !inPlace && lastScreenRef.current ? (snapRef.current?.point ?? screenToWorld(viewRef.current, lastScreenRef.current)) : null;
        void pasteFromClipboard(at).then((ids) => {
          if (ids.length > 0) {
            app.setSelection(ids);
            app.setTool("select");
          }
        });
      } else if (matchesBinding(e, "edit.duplicate")) {
        if (app.selection.length > 0) {
          e.preventDefault();
          const step = gridStep(viewRef.current.scale);
          void copySelectionToClipboard(app.selection, false, { internalOnly: true }).then(() =>
            pasteFromClipboard(null, { x: step, y: step }).then((ids) => {
              if (ids.length > 0) app.setSelection(ids);
            }),
          );
        }
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") && app.selection.length > 0 && !getTool(app.tool)?.busy()) {
        e.preventDefault();
        const step = gridStep(viewRef.current.scale) * (e.shiftKey ? 10 : 1);
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowDown" ? -step : e.key === "ArrowUp" ? step : 0;
        bus.execute({ type: "move-entities", ids: app.selection, dx, dy });
      } else if (matchesBinding(e, "view.ortho")) {
        e.preventDefault();
        useTracking.getState().toggleOrtho();
      } else if (matchesBinding(e, "view.polar")) {
        e.preventDefault();
        useTracking.getState().togglePolar();
      } else if (getTool(app.tool)?.key?.(toolCtx, e)) {
        // The active tool's own keys (finish/close a polyline, arc modes, ...) come before the global ones.
        e.preventDefault();
        syncPrompt();
        redraw();
      } else if (getTool(app.tool) && startsTypedInput(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Start of a typed coordinate: open the box with this character in it.
        e.preventDefault();
        const screen = lastScreenRef.current ?? { x: 40, y: 40 };
        setTyped({ text: e.key, screen });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (app.selection.length > 0) {
          bus.execute({ type: "delete-entities", ids: app.selection });
        }
      } else if (e.key === "Escape") {
        // One key that always gets you back to a known-safe state: abandon
        // whatever is half-drawn, drop the selection, and fall back to the
        // select tool so the next stray click can't add geometry.
        getTool(app.tool)?.cancel(toolCtx);
        setTyped(null);
        interactionRef.current = { kind: "idle" };
        app.setSelection([]);
        app.setMeasurement(null);
        app.setEnteredGroup(null);
        app.setTool("select");
        redraw();
      } else if (matchesBinding(e, "edit.toggleConstruction") && interactionRef.current.kind === "idle") {
        e.preventDefault();
        toggleConstruction();
      } else if (matchesBinding(e, "tool.select")) {
        app.setTool("select");
      } else if (matchesBinding(e, "tool.line")) {
        app.setTool("line");
      } else if (matchesBinding(e, "tool.polyline")) {
        app.setTool("polyline");
      } else if (matchesBinding(e, "tool.rectangle")) {
        app.setTool("rectangle");
      } else if (matchesBinding(e, "tool.circle")) {
        app.setTool("circle");
      } else if (matchesBinding(e, "tool.arc")) {
        app.setTool("arc");
      } else if (matchesBinding(e, "tool.move")) {
        app.setTool("move");
      } else if (matchesBinding(e, "tool.copy")) {
        app.setTool("copy");
      } else if (matchesBinding(e, "tool.rotate")) {
        app.setTool("rotate");
      } else if (matchesBinding(e, "tool.scale")) {
        app.setTool("scale");
      } else if (matchesBinding(e, "tool.mirror")) {
        app.setTool("mirror");
      } else if (matchesBinding(e, "tool.trim")) {
        app.setTool("trim");
      } else if (matchesBinding(e, "tool.split")) {
        app.setTool("split");
      } else if (matchesBinding(e, "tool.fillet")) {
        app.setTool("fillet");
      } else if (matchesBinding(e, "tool.chamfer")) {
        app.setTool("chamfer");
      } else if (matchesBinding(e, "tool.offset")) {
        app.setTool("offset");
      } else if (matchesBinding(e, "tool.point")) {
        app.setTool("point");
      } else if (matchesBinding(e, "tool.image")) {
        app.setTool("image");
      } else if (matchesBinding(e, "tool.measure")) {
        app.setTool("measure");
      } else if (matchesBinding(e, "view.fit")) {
        fitView(app.selection.length ? app.selection : undefined);
      } else if (matchesBinding(e, "tool.straighten")) {
        app.setTool("straighten");
      } else if (matchesBinding(e, "tool.fill")) {
        app.setTool("fill");
      } else if (matchesBinding(e, "tool.text")) {
        app.setTool("text");
      } else if (matchesBinding(e, "tool.dim")) {
        app.setTool("dim");
      } else if (e.key === "Enter" && app.tool === "straighten") {
        applyStraighten();
      } else if (e.key === "Enter" && app.tool === "measure" && app.measurement) {
        app.pinMeasurement();
      } else if (matchesBinding(e, "edit.group") && app.tool === "select") {
        groupSelection();
      } else if (matchesBinding(e, "edit.ungroup") && app.tool === "select") {
        ungroupSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const screenPos = (e: React.PointerEvent): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    try {
      canvasRef.current!.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events (tests, automation) have no active pointer
    }
    if (e.pointerType !== "touch") {
      toolPointerDown(e);
      return;
    }
    const screen = screenPos(e);
    touchesRef.current.set(e.pointerId, screen);
    if (touchesRef.current.size >= 2) {
      // Second finger: the first finger's pending action is dropped and the
      // gesture becomes a pinch. A drag-move or box-select already in
      // progress is simply abandoned (nothing was committed yet); a
      // half-drawn entity is kept, as for a pan.
      pendingTouchRef.current = null;
      if (interactionRef.current.kind !== "pinch") {
        interactionRef.current = { kind: "pinch", resume: resumable(interactionRef.current) };
        redraw();
      }
      return;
    }
    // Double-tap: fit the tapped entity, or the whole drawing.
    const prev = lastTapRef.current;
    const now = performance.now();
    if (prev && now - prev.at < 350 && dist(prev.screen, screen) < 30) {
      lastTapRef.current = null;
      const world = screenToWorld(viewRef.current, screen);
      const t = getTool(useApp.getState().tool);
      if (t?.doubleClick?.(toolCtx, pickFrom(e, world, resolvePick(world, e.shiftKey).snap))) {
        syncPrompt();
        redraw();
      } else {
        const hit = hitTest(viewRef.current, world);
        fitView(hit ? [hit] : undefined);
      }
      return;
    }
    lastTapRef.current = { at: now, screen };
    pendingTouchRef.current = e;
  };

  /** Runs the held-back tool action of a single finger (see pendingTouchRef), if any. */
  const flushPendingTouch = () => {
    const pending = pendingTouchRef.current;
    if (!pending) return;
    pendingTouchRef.current = null;
    toolPointerDown(pending);
  };

  /** The tool's response to a primary-button press (or a single finger): what pointerdown does once it's known not to be a gesture. */
  const toolPointerDown = (e: React.PointerEvent) => {
    const screen = screenPos(e);
    const view = viewRef.current;
    const world = screenToWorld(view, screen);
    const app = useApp.getState();

    // Middle/right-drag pans from any tool, and explicitly preserves a
    // half-drawn line/polyline/circle/measurement rather than replacing it.
    // The pan tool does the same with the primary button (one finger).
    if (e.button === 1 || e.button === 2 || (e.button === 0 && app.tool === "pan")) {
      interactionRef.current = {
        kind: "pan",
        lastX: screen.x,
        lastY: screen.y,
        resume: resumable(interactionRef.current),
      };
      return;
    }
    if (e.button !== 0) return;

    if (app.tool === "select") {
      const groupId = wholeGroupSelected(doc, app.selection);
      const bb = groupId
        ? boundsOf(app.selection.map((id) => doc.get(id)).filter((ent): ent is Entity => !!ent))
        : null;
      if (bb && dist(screen, groupHandleScreenPos(view, bb)) <= GROUP_HANDLE_HIT_PX) {
        const pivot = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
        const startAngle = Math.atan2(world.y - pivot.y, world.x - pivot.x);
        interactionRef.current = { kind: "rotate-group", ids: app.selection, pivot, startAngle, rotation: 0 };
        redraw();
        return;
      }
    }

    const fwTool = getTool(app.tool);
    if (fwTool) {
      const { snap } = resolvePick(world, e.shiftKey);
      fwTool.pick(toolCtx, pickFrom(e, world, snap));
      setTyped(null);
      syncPrompt();
      redraw();
      return;
    }

    const snapped = findSnap(doc, view, world, { settings: useSnapSettings.getState().settings }).point;
    const interaction = interactionRef.current;

    switch (app.tool) {
      case "line":
      case "polyline":
      case "circle":
      case "arc":
      case "rectangle":
      case "point":
      case "move":
      case "copy":
      case "rotate":
      case "scale":
      case "mirror":
      case "trim":
      case "split":
      case "fillet":
      case "chamfer":
      case "offset":
        // On the tool framework; dispatched above.
        break;
      case "image": {
        // A file picker, not a two-click draw — insert at the point clicked
        // once a file is actually chosen, then drop back to the select tool
        // so the new image can be moved/resized right away.
        const insertAt = snapped;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = String(reader.result);
            const probe = new Image();
            probe.onload = () => {
              const maxDim = 200; // mm — a sensible default footprint, independent of source pixel size
              const naturalW = probe.naturalWidth || 100;
              const naturalH = probe.naturalHeight || 100;
              const fit = Math.min(1, maxDim / Math.max(naturalW, naturalH));
              bus.execute({
                type: "add-entity",
                entity: {
                  id: newEntityId(),
                  type: "image",
                  name: nextEntityName(doc, "image"),
                  ...activeLayerProp(app.activeLayer),
                  insert: insertAt,
                  width: naturalW * fit,
                  height: naturalH * fit,
                  rotation: 0,
                  dataUrl,
                },
              });
              useApp.getState().setTool("select");
              redraw();
            };
            probe.src = dataUrl;
          };
          reader.readAsDataURL(file);
        };
        input.click();
        break;
      }
      case "measure": {
        const hit = hitTest(view, world);
        const hitEntity = hit ? doc.get(hit) : null;

        // Ctrl-click a line to pick it as the angle reference edge for
        // distance measurements (click it again to clear). Independent of
        // the straighten tool's own reference edge — each is reset when you
        // switch into that tool.
        if (e.ctrlKey && hitEntity?.type === "line") {
          app.setReferenceEdge(app.referenceEdgeId === hitEntity.id ? null : hitEntity.id);
          interactionRef.current = { kind: "idle" };
          break;
        }

        // Alt-click is the explicit "measure this whole entity" gesture —
        // a plain click always measures point-to-point (see below), snapping
        // to endpoints/midpoints/centers/intersections/on-line points, so it
        // isn't shadowed by clicking anywhere near a line. Shift-Alt-click
        // chains a running total across lines AND arcs (a mixed profile);
        // plain Alt-click always reports just the one entity clicked.
        if (e.altKey && hitEntity?.type === "arc") {
          const len = hitEntity.radius * arcSweep(hitEntity.startAngle, hitEntity.endAngle, hitEntity.ccw);
          const current = app.measurement;
          if (e.shiftKey && current?.kind === "length") {
            if (!current.ids.includes(hitEntity.id)) {
              app.setMeasurement({ kind: "length", ids: [...current.ids, hitEntity.id], total: current.total + len });
            }
          } else {
            app.setMeasurement({
              kind: "radius",
              id: hitEntity.id,
              center: hitEntity.center,
              radius: hitEntity.radius,
              arcLength: len,
            });
          }
          interactionRef.current = { kind: "idle" };
          break;
        }

        if (e.altKey && hitEntity?.type === "circle") {
          app.setMeasurement({ kind: "radius", id: hitEntity.id, center: hitEntity.center, radius: hitEntity.radius });
          interactionRef.current = { kind: "idle" };
          break;
        }

        if (e.altKey && (hitEntity?.type === "line" || hitEntity?.type === "polyline")) {
          const len =
            hitEntity.type === "line" ? dist(hitEntity.a, hitEntity.b) : polylineLength(hitEntity);
          const current = app.measurement;
          if (e.shiftKey && current?.kind === "length") {
            if (!current.ids.includes(hitEntity.id)) {
              app.setMeasurement({ kind: "length", ids: [...current.ids, hitEntity.id], total: current.total + len });
            }
          } else {
            app.setMeasurement({ kind: "length", ids: [hitEntity.id], total: len });
          }
          interactionRef.current = { kind: "idle" };
          break;
        }

        // Nothing under the cursor at all: an enclosing closed area takes
        // priority over starting a two-point distance drag.
        if (!hitEntity) {
          const region = regionContainingPoint(closedRegionsRef.current, world);
          if (region) {
            app.setMeasurement({ kind: "area", region });
            interactionRef.current = { kind: "idle" };
            break;
          }
        }

        if (interaction.kind === "measure") {
          // second click freezes the measurement
          app.setMeasurement({ kind: "distance", a: interaction.start, b: snapped });
          interactionRef.current = { kind: "idle" };
        } else {
          interactionRef.current = { kind: "measure", start: snapped };
          app.setMeasurement({ kind: "distance", a: snapped, b: snapped });
        }
        break;
      }
      case "select": {
        const hit = hitTest(view, world);
        if (hit) {
          // Clicking any member of a group selects the whole group, unless it's currently "entered".
          const resolved = resolveSelection(doc, hit, app.enteredGroupId);
          let ids: EntityId[];
          let collapseTo: EntityId[] | null = null;
          if (matchesModifier(e, "mouse.addToSelection")) {
            const allSelected = resolved.every((id) => app.selection.includes(id));
            ids = allSelected
              ? app.selection.filter((id) => !resolved.includes(id))
              : [...new Set([...app.selection, ...resolved])];
          } else {
            const alreadyExact =
              app.selection.length === resolved.length && resolved.every((id) => app.selection.includes(id));
            const isSubsetOfBigger = app.selection.length > resolved.length && resolved.every((id) => app.selection.includes(id));
            if (isSubsetOfBigger) {
              // Grabbed one member of a bigger multi-selection: keep the whole
              // selection so a drag moves everything together; only collapse
              // to just this item on pointerup if it turns out to be a plain
              // click with no drag.
              ids = app.selection;
              collapseTo = resolved;
            } else {
              ids = alreadyExact ? app.selection : resolved;
            }
          }
          app.setSelection(ids);
          if (resolved.every((id) => ids.includes(id))) {
            interactionRef.current = {
              kind: "move",
              ids,
              startWorld: world,
              startScreen: screen,
              collapseTo,
              dx: 0,
              dy: 0,
              baseVertices: selectionVertices(ids),
            };
          }
        } else {
          // Nothing under the cursor: could be a plain click (clears the
          // selection on release) or the start of a window/crossing
          // drag-select — onPointerUp decides based on how far it moved.
          interactionRef.current = {
            kind: "box-select",
            startScreen: screen,
            startWorld: world,
            currentWorld: world,
            additive: matchesModifier(e, "mouse.addToSelection"),
          };
        }
        break;
      }
      case "straighten": {
        // A line, or one straight (non-bulged) segment of a polyline, already
        // in the selection can become the reference edge.
        const hit = hitTest(view, world);
        const entity = hit ? doc.get(hit) : null;
        if (hit && entity?.type === "line" && app.selection.includes(hit)) {
          app.setReferenceEdge(hit);
        } else if (hit && entity?.type === "polyline" && app.selection.includes(hit)) {
          const segs = polylineSegments(entity);
          let best = -1;
          let bestDist = Infinity;
          segs.forEach((s, i) => {
            if (s.bulge !== 0) return; // straighten needs a straight edge
            const d = distToSegment(world, s.a, s.b);
            if (d < bestDist) {
              bestDist = d;
              best = i;
            }
          });
          if (best >= 0) app.setReferenceEdge(hit, best);
        }
        break;
      }
      case "fill": {
        // Click a closed shape — on its edge or anywhere inside it — to
        // hatch-fill it in the current colour; Alt-click clears a fill.
        const hit = hitTest(view, world);
        const hitEntity = hit ? doc.get(hit) : null;
        const target =
          hitEntity && (hitEntity.type === "circle" || (hitEntity.type === "polyline" && hitEntity.closed))
            ? hitEntity
            : closedEntityAt(world);
        if (target) {
          const next = { ...target };
          if (e.altKey) delete next.fill;
          else next.fill = app.fillColor;
          bus.execute({ type: "update-entity", entity: next });
        }
        break;
      }
      case "text": {
        // Edit the text under the cursor, or start a fresh one where you clicked.
        const hit = hitTest(view, world);
        const existing = hit ? doc.get(hit) : null;
        if (existing && existing.type === "text") {
          openTextEditor(existing);
        } else {
          setTextEdit({ screen, world, value: "", id: null, rotation: 0, height: app.textHeight });
        }
        break;
      }
      case "pan":
        // Handled above, together with the middle/right-button pan.
        break;
      case "dim": {
        if (interaction.kind === "dim") {
          placeDimension(interaction.start, snapped);
          interactionRef.current = { kind: "idle" };
          app.setMeasurement(null);
        } else {
          interactionRef.current = { kind: "dim", start: snapped };
          app.setMeasurement({ kind: "distance", a: snapped, b: snapped });
        }
        break;
      }
    }
    redraw();
  };

  /** Opens the floating editor for an existing text entity. */
  const openTextEditor = (t: TextEntity) => {
    const screen = worldToScreen(viewRef.current, t.at);
    setTextEdit({ screen, world: t.at, value: t.text, id: t.id, rotation: t.rotation, height: t.height });
  };

  /** Commits the floating text editor (add or update) and closes it. */
  const commitText = () => {
    const edit = textEdit;
    setTextEdit(null);
    if (!edit) return;
    const value = edit.value.trim();
    if (!value) {
      if (edit.id) bus.execute({ type: "delete-entities", ids: [edit.id] });
      return;
    }
    const app = useApp.getState();
    if (edit.id) {
      const cur = doc.get(edit.id);
      if (cur && cur.type === "text") {
        bus.execute({ type: "update-entity", entity: { ...cur, text: value, height: edit.height } });
      }
    } else {
      bus.execute({
        type: "add-entity",
        entity: {
          id: newEntityId(),
          type: "text",
          name: nextEntityName(doc, "text"),
          layer: app.activeLayer,
          at: edit.world,
          text: value,
          height: edit.height,
          rotation: edit.rotation,
        },
      });
    }
    redraw();
  };

  /** Draws a linear dimension between two points as a grouped batch on the Dimensions layer. */
  const placeDimension = (a: Point, b: Point) => {
    if (dist(a, b) < 1e-6) return;
    const app = useApp.getState();
    const d = linearDimension(a, b, {
      offset: Math.max(app.textHeight * 2, dist(a, b) * 0.12),
      textHeight: app.textHeight,
      label: formatLength(dist(a, b), app.displayUnit),
    });
    const layer = "Dimensions";
    const ids: EntityId[] = [];
    const commands: Command[] = [];
    for (const pts of d.lines) {
      const id = newEntityId();
      ids.push(id);
      commands.push({ type: "add-entity", entity: { id, type: "polyline", layer, points: pts, closed: false } });
    }
    const textId = newEntityId();
    ids.push(textId);
    commands.push({
      type: "add-entity",
      entity: { id: textId, type: "text", layer, at: d.text.at, text: d.text.text, height: d.text.height, rotation: d.text.rotation },
    });
    commands.push({ type: "group-entities", groupId: newGroupId(), ids, name: d.text.text });
    bus.execute({ type: "batch", commands });
    useApp.getState().syncLayersFromDoc?.();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const screen = screenPos(e);
    const view = viewRef.current;
    const world = screenToWorld(view, screen);
    const app = useApp.getState();
    const interaction = interactionRef.current;

    if (e.pointerType === "touch" && touchesRef.current.has(e.pointerId)) {
      if (interaction.kind === "pinch") {
        pinchMove(e.pointerId, screen);
        return;
      }
      touchesRef.current.set(e.pointerId, screen);
      const pending = pendingTouchRef.current;
      if (pending) {
        // Still within the wobble budget: keep waiting for a tap or a second finger.
        if (dist(screenPos(pending), screen) < 10) return;
        flushPendingTouch();
        onPointerMove(e);
        return;
      }
    }

    if (interaction.kind === "pan") {
      view.ox += screen.x - interaction.lastX;
      view.oy += screen.y - interaction.lastY;
      interactionRef.current = { ...interaction, lastX: screen.x, lastY: screen.y };
    } else if (interaction.kind === "move") {
      const rawDx = world.x - interaction.startWorld.x;
      const rawDy = world.y - interaction.startWorld.y;
      // Snap the moved geometry itself, not the cursor: each axis is nudged so
      // some dragged vertex lands on some anchor's x / y. Hold Ctrl (or Alt) to
      // move completely free.
      const { dx, dy } = noSnap(e)
        ? { dx: rawDx, dy: rawDy }
        : snapMovingSelection(doc, view, interaction.baseVertices, rawDx, rawDy, interaction.ids);
      interactionRef.current = { ...interaction, dx, dy };
    } else if (interaction.kind === "rotate-group") {
      const angle = Math.atan2(world.y - interaction.pivot.y, world.x - interaction.pivot.x);
      // Snap to 45° steps so a turned pallet still lines up; Ctrl frees it.
      const rotation = snapRotation(angle - interaction.startAngle, noSnap(e));
      interactionRef.current = { ...interaction, rotation };
    } else if (interaction.kind === "box-select") {
      interactionRef.current = { ...interaction, currentWorld: world };
    }

    lastScreenRef.current = screen;
    const resolved = resolvePick(world, e.shiftKey);
    const snap = resolved.snap;
    snapRef.current = snap;
    trackingRayRef.current = resolved.ray;
    hoverRef.current = app.tool === "measure" ? hitTest(view, world) : null;
    if (interaction.kind === "measure" || interaction.kind === "dim") {
      app.setMeasurement({ kind: "distance", a: interaction.start, b: snap.point });
    }
    const shown = app.tool === "select" ? world : snap.point;
    app.setCursor({ x: shown.x, y: shown.y });
    redraw();
  };

  /** Two-finger move: pan by the midpoint's travel, zoom by the change in finger spread, about the midpoint. */
  const pinchMove = (pointerId: number, screen: Point) => {
    const touches = touchesRef.current;
    const before = [...touches.values()];
    touches.set(pointerId, screen);
    const after = [...touches.values()];
    if (before.length < 2 || after.length < 2) return;
    const mid = (pts: Point[]) => ({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
    const m0 = mid(before);
    const m1 = mid(after);
    const d0 = dist(before[0], before[1]);
    const d1 = dist(after[0], after[1]);
    let view = viewRef.current;
    if (d0 > 0 && d1 > 0) view = zoomAt(view, m0, d1 / d0);
    view = { ...view, ox: view.ox + (m1.x - m0.x), oy: view.oy + (m1.y - m0.y) };
    viewRef.current = view;
    useApp.getState().setZoom(view.scale);
    redraw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      touchesRef.current.delete(e.pointerId);
      // A tap: the finger's action runs now, then its release is handled as usual.
      if (e.type !== "pointercancel") flushPendingTouch();
      else pendingTouchRef.current = null;
      // A finger lifting out of a pinch ends the gesture; the remaining
      // finger is not promoted to a tool action, it just has to lift too.
      if (interactionRef.current.kind === "pinch") {
        if (touchesRef.current.size === 0) {
          interactionRef.current = interactionRef.current.resume;
          redraw();
        }
        try {
          canvasRef.current!.releasePointerCapture(e.pointerId);
        } catch {
          // see setPointerCapture note
        }
        return;
      }
    }
    const interaction = interactionRef.current;
    if (interaction.kind === "box-select") {
      const screen = screenPos(e);
      const app = useApp.getState();
      if (dist(screen, interaction.startScreen) < (e.pointerType === "touch" ? 10 : 4)) {
        // Barely moved: treat as a plain click on empty canvas.
        if (!interaction.additive) app.setSelection([]);
      } else {
        const { startWorld: s, currentWorld: c } = interaction;
        const box = {
          minX: Math.min(s.x, c.x),
          maxX: Math.max(s.x, c.x),
          minY: Math.min(s.y, c.y),
          maxY: Math.max(s.y, c.y),
        };
        const mode: BoxSelectMode = c.x >= s.x ? "window" : "crossing";
        const hidden = hiddenLayerSet();
        const visible = doc.all().filter((ent) => !hidden.has(layerOf(ent)));
        const picked = entitiesInBox(visible, box, mode);
        app.setSelection(interaction.additive ? [...new Set([...app.selection, ...picked])] : picked);
      }
      interactionRef.current = { kind: "idle" };
      redraw();
      try {
        canvasRef.current!.releasePointerCapture(e.pointerId);
      } catch {
        // see setPointerCapture note
      }
      return;
    }
    if (interaction.kind === "pan") {
      interactionRef.current = interaction.resume;
      redraw();
    } else if (interaction.kind === "move") {
      const moved = dist(screenPos(e), interaction.startScreen) >= (e.pointerType === "touch" ? 10 : 4);
      if (moved && (interaction.dx !== 0 || interaction.dy !== 0)) {
        bus.execute({
          type: "move-entities",
          ids: interaction.ids,
          dx: interaction.dx,
          dy: interaction.dy,
        });
      } else if (!moved && interaction.collapseTo) {
        // A plain click (no drag) on one member of a bigger selection: now
        // collapse down to just that item, as a click normally would.
        useApp.getState().setSelection(interaction.collapseTo);
      }
      interactionRef.current = { kind: "idle" };
      redraw();
    } else if (interaction.kind === "rotate-group") {
      if (Math.abs(interaction.rotation) > 1e-9) {
        bus.execute({
          type: "transform-entities",
          ids: interaction.ids,
          pivot: interaction.pivot,
          rotation: interaction.rotation,
          dx: 0,
          dy: 0,
          scale: 1,
        });
      }
      interactionRef.current = { kind: "idle" };
      redraw();
    }
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      // see setPointerCapture note
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const screen = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    viewRef.current = zoomAt(viewRef.current, screen, factor);
    useApp.getState().setZoom(viewRef.current.scale);
    redraw();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    // Touch double-taps are detected in onPointerDown.
    if ((e.nativeEvent as PointerEvent).pointerType === "touch") return;
    const screen = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    const world = screenToWorld(viewRef.current, screen);
    const hit = hitTest(viewRef.current, world);
    const app = useApp.getState();

    // A tool's own double-click (finishing a polyline) takes priority over the zoom-to-fit / enter-group behavior below.
    const t = getTool(app.tool);
    if (t?.doubleClick?.(toolCtx, pickFrom(e, world, resolvePick(world, e.shiftKey).snap))) {
      syncPrompt();
      redraw();
      return;
    }

    // Double-click any text to edit it (from select or the text tool).
    const dblEntity = hit ? doc.get(hit) : null;
    if (dblEntity && dblEntity.type === "text" && (app.tool === "select" || app.tool === "text")) {
      openTextEditor(dblEntity);
      return;
    }

    if (hit && app.tool === "select") {
      const top = doc.topLevelGroupOf(hit);
      if (top && top.id !== app.enteredGroupId) {
        // Enter the group to edit its members individually (Esc exits).
        app.setEnteredGroup(top.id);
        app.setSelection([hit]);
        redraw();
        return;
      }
    }
    // Zoom to fit. Double-clicking *geometry* frames that entity; double-clicking
    // empty space always frames the whole drawing — deliberately ignoring the
    // selection, since the first click of the double-click may have just changed
    // it, which otherwise makes the gesture unpredictable.
    fitView(hit ? [hit] : undefined);
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className="viewport"
        data-testid="viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      {typed && (
        <TypedInputBox
          value={typed.text}
          screen={typed.screen}
          onChange={(text) => {
            setTyped({ text, screen: typed.screen });
            // Live preview of where the typed point would land.
            const t = getTool(useApp.getState().tool);
            const parsed = parseTypedInput(text, useApp.getState().displayUnit);
            const cursor = lastScreenRef.current ? screenToWorld(viewRef.current, lastScreenRef.current) : null;
            const point = t && parsed ? resolveTypedInput(parsed, t.anchor(), cursor) : null;
            if (point) snapRef.current = { point, kind: "tracking" };
            redraw();
          }}
          onCommit={(text) => {
            const app = useApp.getState();
            const t = getTool(app.tool);
            if (t?.typed?.(toolCtx, text)) {
              setTyped(null);
              syncPrompt();
              redraw();
              return true;
            }
            const parsed = parseTypedInput(text, app.displayUnit);
            const cursor = lastScreenRef.current ? screenToWorld(viewRef.current, lastScreenRef.current) : null;
            const point = t && parsed ? resolveTypedInput(parsed, t.anchor(), cursor) : null;
            if (!t || !point) return false;
            t.pick(toolCtx, { point, world: point, snap: null, shiftKey: false, ctrlKey: false, altKey: false });
            setTyped(null);
            syncPrompt();
            redraw();
            return true;
          }}
          onCancel={() => {
            setTyped(null);
            redraw();
          }}
        />
      )}
      {textEdit && (
        <input
          className="text-editor"
          data-testid="text-editor"
          autoFocus
          value={textEdit.value}
          style={{
            position: "absolute",
            left: textEdit.screen.x,
            top: textEdit.screen.y - textEdit.height * viewRef.current.scale,
            fontSize: Math.max(9, textEdit.height * viewRef.current.scale),
          }}
          onChange={(ev) => setTextEdit((s) => (s ? { ...s, value: ev.target.value } : s))}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") commitText();
            else if (ev.key === "Escape") setTextEdit(null);
            ev.stopPropagation();
          }}
          onBlur={commitText}
        />
      )}
    </>
  );
}

/**
 * The floating coordinate box (T-08). Opens at the cursor with the first
 * typed character already in it; Enter commits when the text parses,
 * Escape closes. Kept minimal on purpose — the grammar is the UI.
 */
function TypedInputBox({
  value,
  screen,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  screen: Point;
  onChange: (text: string) => void;
  onCommit: (text: string) => boolean;
  onCancel: () => void;
}) {
  const [bad, setBad] = useState(false);
  return (
    <div className="typed-input" style={{ left: screen.x + 16, top: screen.y + 16 }} data-testid="typed-input">
      <input
        className={bad ? "invalid" : ""}
        autoFocus
        value={value}
        spellCheck={false}
        onChange={(ev) => {
          setBad(false);
          onChange(ev.target.value);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            if (!onCommit(value)) setBad(true);
          } else if (ev.key === "Escape") {
            onCancel();
          }
          ev.stopPropagation();
        }}
        onBlur={onCancel}
      />
      <div className="typed-input-hint">length · len&lt;angle · x,y · @dx,dy</div>
    </div>
  );
}
