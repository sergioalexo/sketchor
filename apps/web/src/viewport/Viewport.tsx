import { useEffect, useRef } from "react";
import type { BoxSelectMode, ClosedRegion, Entity, EntityId, Point } from "@sketchor/core";
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
  regionContainingPoint,
  resolveSelection,
  layerOf,
  newEntityId,
  nextEntityName,
  polylineLength,
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
import { formatArea, formatLength } from "../units";
import { render } from "./renderer";
import { findSnap, type Snap } from "./snapping";
import { fitToBounds, screenToWorld, worldToScreen, zoomAt, type View } from "./view";

type Interaction =
  | { kind: "idle" }
  | { kind: "pan"; lastX: number; lastY: number }
  | { kind: "draw-line"; start: Point }
  | { kind: "draw-polyline"; points: Point[] }
  | { kind: "draw-circle"; center: Point }
  | { kind: "measure"; start: Point }
  | {
      kind: "move";
      ids: EntityId[];
      startWorld: Point;
      dx: number;
      dy: number;
      /** The selection vertex nearest the grab point; what snapping aligns to a target. */
      base: Point | null;
    }
  | { kind: "rotate-group"; ids: EntityId[]; pivot: Point; startAngle: number; rotation: number }
  | { kind: "box-select"; startScreen: Point; startWorld: Point; currentWorld: Point; additive: boolean };

/** Fixed pixel offset above a selected group's bounding box where its rotate handle is drawn/hit-tested. */
const GROUP_HANDLE_OFFSET_PX = 26;
const GROUP_HANDLE_HIT_PX = 8;

function groupHandleScreenPos(view: View, bb: { minX: number; maxX: number; maxY: number }): Point {
  const s = worldToScreen(view, { x: (bb.minX + bb.maxX) / 2, y: bb.maxY });
  return { x: s.x, y: s.y - GROUP_HANDLE_OFFSET_PX };
}

/**
 * The vertex of `ids` closest to `world` — the handle a snapped move aligns.
 * Grabbing near a corner therefore snaps that corner onto the target, which is
 * how you land a part exactly on the origin or on another corner.
 */
function nearestVertex(ids: EntityId[], world: Point): Point | null {
  let best: Point | null = null;
  let bestDist = Infinity;
  for (const id of ids) {
    const entity = doc.get(id);
    if (!entity) continue;
    for (const p of entityPoints(entity)) {
      const d = dist(p, world);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
  }
  return best;
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
          ? Math.abs(dist(world, e.center) - e.radius)
          : e.type === "point"
            ? dist(world, e.p)
            : e.type === "arc"
              ? distToArc(world, e.center, e.radius, e.startAngle, e.endAngle, e.ccw)
              : // Polyline: whichever of its segments the cursor is nearest to.
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
                );
    if (d <= bestDist) {
      best = e.id;
      bestDist = d;
    }
  }
  return best;
}

export function Viewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ scale: 2, ox: 0, oy: 0 });
  const interactionRef = useRef<Interaction>({ kind: "idle" });
  const snapRef = useRef<Snap | null>(null);
  const hoverRef = useRef<EntityId | null>(null);
  const closedRegionsRef = useRef<ClosedRegion[]>([]);
  const tool = useApp((s) => s.tool);
  const selection = useApp((s) => s.selection);
  const revision = useApp((s) => s.revision);
  const layers = useApp((s) => s.layers);

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
    const interaction = interactionRef.current;
    const snap = snapRef.current;

    let preview: Entity | null = null;
    if (snap && interaction.kind === "draw-line") {
      preview = { id: "preview", type: "line", a: interaction.start, b: snap.point };
    } else if (snap && interaction.kind === "draw-circle") {
      preview = {
        id: "preview",
        type: "circle",
        center: interaction.center,
        radius: dist(interaction.center, snap.point),
      };
    } else if (interaction.kind === "draw-polyline") {
      // Committed vertices plus a rubber-band leg to the cursor.
      const points = snap ? [...interaction.points, snap.point] : interaction.points;
      if (points.length >= 2) preview = { id: "preview", type: "polyline", points, closed: false };
    }

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

  // Keyboard: tools, undo/redo, delete, escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const app = useApp.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && app.tool === "measure" && app.measurement) {
        e.preventDefault();
        void navigator.clipboard.writeText(measurementText(app.measurement, app.displayUnit, referenceEdgeAngleDeg()));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveCurrent();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openDrawing();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
        // Desktop only in practice: browsers reserve Ctrl+W to close their own
        // tab and won't let a page preventDefault it.
        e.preventDefault();
        closeTab(useApp.getState().activeSessionId);
      } else if (e.ctrlKey && e.key.toLowerCase() === "z" && !e.shiftKey) {
        bus.undo();
        e.preventDefault();
      } else if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        bus.redo();
        e.preventDefault();
      } else if (e.key === "Enter" && interactionRef.current.kind === "draw-polyline") {
        finishPolyline(false);
      } else if (e.key.toLowerCase() === "c" && interactionRef.current.kind === "draw-polyline") {
        // While drawing, C closes the shape rather than switching to the circle tool.
        finishPolyline(true);
      } else if (e.key === "Backspace" && interactionRef.current.kind === "draw-polyline") {
        const points = interactionRef.current.points.slice(0, -1);
        interactionRef.current = points.length > 0 ? { kind: "draw-polyline", points } : { kind: "idle" };
        redraw();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (app.selection.length > 0) {
          bus.execute({ type: "delete-entities", ids: app.selection });
        }
      } else if (e.key === "Escape") {
        interactionRef.current = { kind: "idle" };
        app.setSelection([]);
        app.setMeasurement(null);
        app.setEnteredGroup(null);
        redraw();
      } else if (e.key.toLowerCase() === "v" || e.key.toLowerCase() === "s") {
        app.setTool("select");
      } else if (e.key.toLowerCase() === "l") {
        app.setTool("line");
      } else if (e.key.toLowerCase() === "w") {
        app.setTool("polyline");
      } else if (e.key.toLowerCase() === "c") {
        app.setTool("circle");
      } else if (e.key.toLowerCase() === "p" && !e.ctrlKey && !e.metaKey) {
        app.setTool("point");
      } else if (e.key.toLowerCase() === "m") {
        app.setTool("measure");
      } else if (e.key.toLowerCase() === "f") {
        fitView(app.selection.length ? app.selection : undefined);
      } else if (e.key.toLowerCase() === "t") {
        app.setTool("straighten");
      } else if (e.key === "Enter" && app.tool === "straighten") {
        applyStraighten();
      } else if (e.key === "Enter" && app.tool === "measure" && app.measurement) {
        app.pinMeasurement();
      } else if (e.key.toLowerCase() === "g" && !e.ctrlKey && !e.metaKey && app.tool === "select") {
        groupSelection();
      } else if (e.key.toLowerCase() === "u" && !e.ctrlKey && !e.metaKey && app.tool === "select") {
        ungroupSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Commits an in-progress polyline (needs 2+ vertices) and resets the interaction. No-op otherwise. */
  const finishPolyline = (closed: boolean): void => {
    const interaction = interactionRef.current;
    if (interaction.kind !== "draw-polyline") return;
    const app = useApp.getState();
    if (interaction.points.length >= 2) {
      bus.execute({
        type: "add-entity",
        entity: {
          id: newEntityId(),
          type: "polyline",
          name: nextEntityName(doc, "polyline"),
          ...activeLayerProp(app.activeLayer),
          points: interaction.points,
          closed: closed && interaction.points.length >= 3,
        },
      });
    }
    interactionRef.current = { kind: "idle" };
    redraw();
  };

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
    const screen = screenPos(e);
    const view = viewRef.current;
    const world = screenToWorld(view, screen);
    const app = useApp.getState();

    if (e.button === 1 || e.button === 2) {
      interactionRef.current = { kind: "pan", lastX: screen.x, lastY: screen.y };
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

    const snapped = findSnap(doc, view, world).point;
    const interaction = interactionRef.current;

    switch (app.tool) {
      case "line": {
        if (interaction.kind === "draw-line") {
          if (dist(interaction.start, snapped) > 0) {
            bus.execute({
              type: "add-entity",
              entity: {
                id: newEntityId(),
                type: "line",
                name: nextEntityName(doc, "line"),
                ...activeLayerProp(app.activeLayer),
                a: interaction.start,
                b: snapped,
              },
            });
          }
          interactionRef.current = { kind: "draw-line", start: snapped };
        } else {
          interactionRef.current = { kind: "draw-line", start: snapped };
        }
        break;
      }
      case "polyline": {
        if (interaction.kind === "draw-polyline") {
          // Ignore a repeat click on the vertex just placed (double-click finishes instead, see onDoubleClick).
          const last = interaction.points[interaction.points.length - 1];
          if (dist(last, snapped) > 0) {
            interactionRef.current = { kind: "draw-polyline", points: [...interaction.points, snapped] };
          }
        } else {
          interactionRef.current = { kind: "draw-polyline", points: [snapped] };
        }
        break;
      }
      case "circle": {
        if (interaction.kind === "draw-circle") {
          const radius = dist(interaction.center, snapped);
          if (radius > 0) {
            bus.execute({
              type: "add-entity",
              entity: {
                id: newEntityId(),
                type: "circle",
                name: nextEntityName(doc, "circle"),
                ...activeLayerProp(app.activeLayer),
                center: interaction.center,
                radius,
              },
            });
          }
          interactionRef.current = { kind: "idle" };
        } else {
          interactionRef.current = { kind: "draw-circle", center: snapped };
        }
        break;
      }
      case "point": {
        bus.execute({
          type: "add-entity",
          entity: {
            id: newEntityId(),
            type: "point",
            name: nextEntityName(doc, "point"),
            ...activeLayerProp(app.activeLayer),
            p: snapped,
          },
        });
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
          if (e.shiftKey) {
            const allSelected = resolved.every((id) => app.selection.includes(id));
            ids = allSelected
              ? app.selection.filter((id) => !resolved.includes(id))
              : [...new Set([...app.selection, ...resolved])];
          } else {
            const alreadyExact =
              app.selection.length === resolved.length && resolved.every((id) => app.selection.includes(id));
            ids = alreadyExact ? app.selection : resolved;
          }
          app.setSelection(ids);
          if (resolved.every((id) => ids.includes(id))) {
            interactionRef.current = {
              kind: "move",
              ids,
              startWorld: world,
              dx: 0,
              dy: 0,
              base: nearestVertex(ids, world),
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
            additive: e.shiftKey,
          };
        }
        break;
      }
      case "straighten": {
        // Only a line already in the selection can become the reference edge.
        const hit = hitTest(view, world);
        const entity = hit ? doc.get(hit) : null;
        if (hit && entity?.type === "line" && app.selection.includes(hit)) {
          app.setReferenceEdge(hit);
        }
        break;
      }
    }
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const screen = screenPos(e);
    const view = viewRef.current;
    const world = screenToWorld(view, screen);
    const app = useApp.getState();
    const interaction = interactionRef.current;

    if (interaction.kind === "pan") {
      view.ox += screen.x - interaction.lastX;
      view.oy += screen.y - interaction.lastY;
      interactionRef.current = { ...interaction, lastX: screen.x, lastY: screen.y };
    } else if (interaction.kind === "move") {
      let dx = world.x - interaction.startWorld.x;
      let dy = world.y - interaction.startWorld.y;
      // Snap the moved geometry itself, not the cursor: the selection's base
      // vertex (the one nearest where the drag began) is tested against every
      // snap target — including the origin — and the whole selection is offset
      // so that vertex lands exactly on it. Hold Alt for a free, unsnapped move.
      if (interaction.base && !e.altKey) {
        const moved = { x: interaction.base.x + dx, y: interaction.base.y + dy };
        const candidate = findSnap(doc, view, moved, interaction.ids);
        // Only real targets pull the selection; the grid fallback would
        // quantise every move and make free positioning impossible.
        if (candidate.kind !== "grid") {
          dx = candidate.point.x - interaction.base.x;
          dy = candidate.point.y - interaction.base.y;
        }
      }
      interactionRef.current = { ...interaction, dx, dy };
    } else if (interaction.kind === "rotate-group") {
      const angle = Math.atan2(world.y - interaction.pivot.y, world.x - interaction.pivot.x);
      interactionRef.current = { ...interaction, rotation: angle - interaction.startAngle };
    } else if (interaction.kind === "box-select") {
      interactionRef.current = { ...interaction, currentWorld: world };
    }

    const snap = findSnap(doc, view, world);
    snapRef.current = snap;
    hoverRef.current = app.tool === "measure" ? hitTest(view, world) : null;
    if (interaction.kind === "measure") {
      app.setMeasurement({ kind: "distance", a: interaction.start, b: snap.point });
    }
    const shown = app.tool === "select" ? world : snap.point;
    app.setCursor({ x: shown.x, y: shown.y });
    redraw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const interaction = interactionRef.current;
    if (interaction.kind === "box-select") {
      const screen = screenPos(e);
      const app = useApp.getState();
      if (dist(screen, interaction.startScreen) < 4) {
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
      interactionRef.current = { kind: "idle" };
    } else if (interaction.kind === "move") {
      if (interaction.dx !== 0 || interaction.dy !== 0) {
        bus.execute({
          type: "move-entities",
          ids: interaction.ids,
          dx: interaction.dx,
          dy: interaction.dy,
        });
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
    const screen = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    const world = screenToWorld(viewRef.current, screen);
    const hit = hitTest(viewRef.current, world);
    const app = useApp.getState();

    // Finishing a polyline takes priority over the zoom-to-fit / enter-group behavior below.
    if (interactionRef.current.kind === "draw-polyline") {
      finishPolyline(false);
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
    <canvas
      ref={canvasRef}
      className="viewport"
      data-testid="viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
