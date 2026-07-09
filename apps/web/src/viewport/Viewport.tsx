import { useEffect, useRef } from "react";
import type { Entity, EntityId, Point } from "@sketchor/core";
import { dist, distToSegment, newEntityId, nextEntityName } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";
import { render } from "./renderer";
import { findSnap, type Snap } from "./snapping";
import { screenToWorld, zoomAt, type View } from "./view";

type Interaction =
  | { kind: "idle" }
  | { kind: "pan"; lastX: number; lastY: number }
  | { kind: "draw-line"; start: Point }
  | { kind: "draw-circle"; center: Point }
  | { kind: "measure"; start: Point }
  | { kind: "move"; ids: EntityId[]; startWorld: Point; dx: number; dy: number };

function hitTest(view: View, world: Point): EntityId | null {
  const tol = 6 / view.scale;
  let best: EntityId | null = null;
  let bestDist = tol;
  for (const e of doc.all()) {
    const d =
      e.type === "line"
        ? distToSegment(world, e.a, e.b)
        : Math.abs(dist(world, e.center) - e.radius);
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
  const tool = useApp((s) => s.tool);
  const selection = useApp((s) => s.selection);
  const revision = useApp((s) => s.revision);

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
    }

    render(ctx, w, h, viewRef.current, doc, {
      selection: new Set(state.selection),
      preview,
      snap: state.tool === "select" ? null : snap,
      moveOffset:
        interaction.kind === "move" ? { dx: interaction.dx, dy: interaction.dy } : null,
      measurement: state.measurement,
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

  const measurement = useApp((s) => s.measurement);

  // Redraw when document, selection, tool or measurement changes
  useEffect(redraw, [revision, selection, tool, measurement]);

  // Keyboard: tools, undo/redo, delete, escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const app = useApp.getState();
      if (e.ctrlKey && e.key.toLowerCase() === "z" && !e.shiftKey) {
        bus.undo();
        e.preventDefault();
      } else if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        bus.redo();
        e.preventDefault();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (app.selection.length > 0) {
          bus.execute({ type: "delete-entities", ids: app.selection });
        }
      } else if (e.key === "Escape") {
        interactionRef.current = { kind: "idle" };
        app.setSelection([]);
        app.setMeasurement(null);
        redraw();
      } else if (e.key.toLowerCase() === "v" || e.key.toLowerCase() === "s") {
        app.setTool("select");
      } else if (e.key.toLowerCase() === "l") {
        app.setTool("line");
      } else if (e.key.toLowerCase() === "c") {
        app.setTool("circle");
      } else if (e.key.toLowerCase() === "m") {
        app.setTool("measure");
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
    const screen = screenPos(e);
    const view = viewRef.current;
    const world = screenToWorld(view, screen);
    const app = useApp.getState();

    if (e.button === 1 || e.button === 2) {
      interactionRef.current = { kind: "pan", lastX: screen.x, lastY: screen.y };
      return;
    }
    if (e.button !== 0) return;

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
      case "measure": {
        if (interaction.kind === "measure") {
          // second click freezes the measurement
          app.setMeasurement({ a: interaction.start, b: snapped });
          interactionRef.current = { kind: "idle" };
        } else {
          interactionRef.current = { kind: "measure", start: snapped };
          app.setMeasurement({ a: snapped, b: snapped });
        }
        break;
      }
      case "select": {
        const hit = hitTest(view, world);
        if (hit) {
          let ids: EntityId[];
          if (e.shiftKey) {
            ids = app.selection.includes(hit)
              ? app.selection.filter((id) => id !== hit)
              : [...app.selection, hit];
          } else {
            ids = app.selection.includes(hit) ? app.selection : [hit];
          }
          app.setSelection(ids);
          if (ids.includes(hit)) {
            interactionRef.current = { kind: "move", ids, startWorld: world, dx: 0, dy: 0 };
          }
        } else if (!e.shiftKey) {
          app.setSelection([]);
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
      interactionRef.current = {
        ...interaction,
        dx: world.x - interaction.startWorld.x,
        dy: world.y - interaction.startWorld.y,
      };
    }

    const snap = findSnap(doc, view, world);
    snapRef.current = snap;
    if (interaction.kind === "measure") {
      app.setMeasurement({ a: interaction.start, b: snap.point });
    }
    const shown = app.tool === "select" ? world : snap.point;
    app.setCursor({ x: shown.x, y: shown.y });
    redraw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const interaction = interactionRef.current;
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

  return (
    <canvas
      ref={canvasRef}
      className="viewport"
      data-testid="viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
