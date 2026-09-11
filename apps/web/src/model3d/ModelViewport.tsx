import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { DocSession } from "../state/store";
import { useApp } from "../state/store";
import { formatLength } from "../units";
import {
  buildLights,
  buildModelObjects,
  framePerspective,
  SELECT_COLOR,
  STAGE_BACKGROUND,
  toBox3,
  type ModelObjects,
  type ViewPreset,
} from "./modelScene";
import { useOpenLoads } from "./stepImport";
import type { Model3D, ModelNode } from "./types";

/**
 * The 3D viewer that replaces the drawing canvas in a model tab.
 *
 * Mouse: left-drag orbits, right/middle-drag pans, wheel zooms toward the
 * cursor, click selects a part, double-click frames it. Keys: F fits all,
 * H hides the selected part, Shift+H shows everything, E toggles edges,
 * Esc clears the selection, 1/2/3/4 jump to iso/top/front/right.
 *
 * Rendering is on demand — a frame is drawn only when the camera or the
 * scene changed — so an open model tab costs nothing while idle.
 *
 * Everything the file parsed into is one merged mesh (see Model3D), so
 * per-part operations work on index/colour *ranges* rather than objects:
 * selecting a part rewrites its vertex colours, hiding one collapses its
 * triangles and edge segments to degenerate zero-area ones. That keeps a
 * 3,000-part assembly at two draw calls, and part offsets stable so picking
 * needs no bookkeeping.
 */

interface Props {
  session: DocSession;
}

export function ModelViewport({ session }: Props) {
  const model = session.model ?? null;
  if (session.modelError) return <ModelError name={session.name} message={session.modelError} />;
  if (!model) return <ModelLoading name={session.name} />;
  return <Viewer key={model.hash} model={model} />;
}

/* ------------------------------ loading/error --------------------------- */

function ModelLoading({ name }: { name: string }) {
  const loads = useOpenLoads();
  const load = loads.find((l) => l.name === name) ?? loads[0];
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const seconds = load ? Math.floor((Date.now() - load.startedAt) / 1000) : 0;
  const phase =
    load?.phase === "queued"
      ? "Waiting for a free import worker…"
      : load?.phase === "cached"
        ? "Loading from cache…"
        : load?.phase === "hashing"
          ? "Reading file…"
          : "Reading geometry with OpenCascade…";
  return (
    <div className="model-stage model-loading" data-testid="model-loading">
      <div className="model-loading-card">
        <div className="model-loading-spinner" />
        <div className="model-loading-title">{name}</div>
        <div className="model-loading-phase">{phase}</div>
        <div className="model-loading-hint">
          {seconds > 0 ? `${seconds}s · ` : ""}
          Large assemblies take a while the first time; this file opens instantly afterwards.
        </div>
      </div>
    </div>
  );
}

function ModelError({ name, message }: { name: string; message: string }) {
  return (
    <div className="model-stage model-loading" data-testid="model-error">
      <div className="model-loading-card error">
        <div className="model-loading-title">Couldn't open {name}</div>
        <div className="model-loading-phase">{message}</div>
      </div>
    </div>
  );
}

/* --------------------------------- viewer -------------------------------- */

interface Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  objects: ModelObjects;
  raycaster: THREE.Raycaster;
  partBoxes: THREE.Box3[];
  requestRender: () => void;
  dispose: () => void;
}

function Viewer({ model }: { model: Model3D }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [showEdges, setShowEdges] = useState(true);
  const [showParts, setShowParts] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const displayUnit = useApp((s) => s.displayUnit);

  // ---- scene lifetime: one per model --------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(STAGE_BACKGROUND, 1);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    camera.up.set(0, 0, 1);
    scene.add(...buildLights(camera));
    const objects = buildModelObjects(model);
    scene.add(objects.group);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    controls.target.copy(framePerspective(camera, model.bounds, "iso"));
    controls.update();

    let pending = false;
    const requestRender = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        renderer.render(scene, camera);
      });
    };
    controls.addEventListener("change", requestRender);

    const resize = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      // Re-read the ratio: the window may have moved to a different-DPI screen.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      requestRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const partBoxes = model.parts.map((p) => toBox3(p.bounds));
    const s: Scene = {
      renderer,
      scene,
      camera,
      controls,
      objects,
      raycaster: new THREE.Raycaster(),
      partBoxes,
      requestRender,
      dispose() {
        observer.disconnect();
        controls.dispose();
        objects.dispose();
        renderer.dispose();
      },
    };
    sceneRef.current = s;
    return () => {
      s.dispose();
      sceneRef.current = null;
    };
  }, [model]);

  // ---- derived scene state ------------------------------------------------
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.objects.edges.visible = showEdges;
    s.requestRender();
  }, [showEdges]);

  // Selection: paint the part's vertex colours, restoring everything else from the pristine model colours.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const attr = s.objects.geometry.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Uint8Array;
    arr.set(model.colors);
    if (selected !== null) {
      const p = model.parts[selected];
      for (let i = p.vertexStart; i < p.vertexStart + p.vertexCount; i++) {
        arr[i * 3] = SELECT_COLOR[0];
        arr[i * 3 + 1] = SELECT_COLOR[1];
        arr[i * 3 + 2] = SELECT_COLOR[2];
      }
    }
    attr.needsUpdate = true;
    s.requestRender();
  }, [selected, model]);

  // Visibility: hidden parts get degenerate triangles/segments in place, so
  // every other part's ranges stay where they are.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const index = s.objects.geometry.getIndex()!;
    const idx = index.array as Uint32Array;
    idx.set(model.indices);
    const edgeAttr = s.objects.edgeGeometry.getAttribute("position") as THREE.BufferAttribute;
    const edges = edgeAttr.array as Float32Array;
    edges.set(model.edges);
    for (const pi of hidden) {
      const p = model.parts[pi];
      if (!p) continue;
      idx.fill(p.vertexStart, p.indexStart, p.indexStart + p.indexCount);
      edges.fill(0, p.edgeStart * 6, (p.edgeStart + p.edgeCount) * 6);
    }
    index.needsUpdate = true;
    edgeAttr.needsUpdate = true;
    s.requestRender();
  }, [hidden, model]);

  // ---- picking ------------------------------------------------------------
  const pick = (clientX: number, clientY: number): number | null => {
    const s = sceneRef.current;
    const canvas = canvasRef.current;
    if (!s || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    s.raycaster.setFromCamera(ndc, s.camera);
    // Coarse pass on part boxes, then exact triangles only inside candidate
    // parts (via drawRange) — a click on a million-triangle assembly stays
    // instant.
    const ray = s.raycaster.ray;
    const hit = new THREE.Vector3();
    const candidates: { part: number; dist: number }[] = [];
    for (let i = 0; i < s.partBoxes.length; i++) {
      if (hidden.has(i)) continue;
      if (ray.intersectBox(s.partBoxes[i], hit)) candidates.push({ part: i, dist: hit.distanceTo(ray.origin) });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const geometry = s.objects.geometry;
    let best: { part: number; dist: number } | null = null;
    for (const c of candidates) {
      if (best && c.dist > best.dist) break;
      const p = model.parts[c.part];
      geometry.setDrawRange(p.indexStart, p.indexCount);
      const hits = s.raycaster.intersectObject(s.objects.mesh, false);
      if (hits.length > 0 && (!best || hits[0].distance < best.dist)) best = { part: c.part, dist: hits[0].distance };
    }
    geometry.setDrawRange(0, Infinity);
    return best?.part ?? null;
  };

  /** Frames `bounds` from a preset, or from wherever the camera is looking now. */
  const frame = (bounds: Model3D["bounds"], preset?: ViewPreset) => {
    const s = sceneRef.current;
    if (!s) return;
    const from = preset ?? s.camera.position.clone().sub(s.controls.target).normalize();
    s.controls.target.copy(framePerspective(s.camera, bounds, from));
    s.controls.update();
    s.requestRender();
  };
  const fitAll = (preset?: ViewPreset) => frame(visibleBounds(model, hidden), preset);
  const fitPart = (part: number) => frame(model.parts[part].bounds);

  // ---- pointer + keys -----------------------------------------------------
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    downAt.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = downAt.current;
    downAt.current = null;
    // A drag is an orbit, not a click.
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    setSelected(pick(e.clientX, e.clientY));
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const part = pick(e.clientX, e.clientY);
    if (part !== null) fitPart(part);
    else fitAll();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case "f":
        case "F":
          fitAll();
          break;
        case "e":
        case "E":
          setShowEdges((v) => !v);
          break;
        case "h":
          if (selected !== null) {
            setHidden((h) => new Set(h).add(selected));
            setSelected(null);
          }
          break;
        case "H":
          setHidden(new Set());
          break;
        case "Escape":
          setSelected(null);
          break;
        case "1":
          fitAll("iso");
          break;
        case "2":
          fitAll("top");
          break;
        case "3":
          fitAll("front");
          break;
        case "4":
          fitAll("right");
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, hidden, model]);

  const size = useMemo(() => {
    const b = model.bounds;
    return [0, 1, 2].map((k) => formatLength(b.max[k] - b.min[k], displayUnit)).join(" × ");
  }, [model, displayUnit]);

  const statusPart = hovered ?? selected;
  return (
    <div className="model-stage" ref={hostRef} data-testid="model-viewport">
      <canvas
        ref={canvasRef}
        className="model-canvas"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="model-toolbar" data-testid="model-toolbar">
        <button className="btn ghost sm" title="Isometric (1)" onClick={() => fitAll("iso")}>
          Iso
        </button>
        <button className="btn ghost sm" title="Top (2)" onClick={() => fitAll("top")}>
          Top
        </button>
        <button className="btn ghost sm" title="Front (3)" onClick={() => fitAll("front")}>
          Front
        </button>
        <button className="btn ghost sm" title="Right (4)" onClick={() => fitAll("right")}>
          Right
        </button>
        <span className="model-toolbar-sep" />
        <button className="btn ghost sm" title="Fit everything visible (F)" onClick={() => fitAll()}>
          Fit
        </button>
        <button
          className={`btn ghost sm ${showEdges ? "active" : ""}`}
          title="Toggle B-rep edges (E)"
          onClick={() => setShowEdges((v) => !v)}
        >
          Edges
        </button>
        <button
          className="btn ghost sm"
          title="Hide selected part (H)"
          disabled={selected === null}
          onClick={() => {
            if (selected === null) return;
            setHidden((h) => new Set(h).add(selected));
            setSelected(null);
          }}
        >
          Hide
        </button>
        <button
          className="btn ghost sm"
          title="Show all hidden parts (Shift+H)"
          disabled={hidden.size === 0}
          onClick={() => setHidden(new Set())}
        >
          Show all{hidden.size > 0 ? ` (${hidden.size})` : ""}
        </button>
        <span className="model-toolbar-sep" />
        <button
          className={`btn ghost sm ${showParts ? "active" : ""}`}
          title="Parts tree"
          onClick={() => setShowParts((v) => !v)}
          data-testid="model-parts-toggle"
        >
          Parts
        </button>
      </div>
      <div className="model-status" data-testid="model-status">
        <span>{model.parts.length} parts</span>
        <span>{model.triangleCount.toLocaleString()} triangles</span>
        <span title="Bounding box, X × Y × Z">{size}</span>
        {statusPart !== null && (
          <span className="model-status-part" data-testid="model-status-part">
            {model.parts[statusPart].name}
          </span>
        )}
      </div>
      {showParts && (
        <PartsTree
          model={model}
          selected={selected}
          hidden={hidden}
          onSelect={(p) => setSelected(p)}
          onHover={setHovered}
          onFrame={fitPart}
          onToggleHidden={(p) =>
            setHidden((h) => {
              const next = new Set(h);
              if (next.has(p)) next.delete(p);
              else next.add(p);
              return next;
            })
          }
          onClose={() => setShowParts(false)}
        />
      )}
    </div>
  );
}

function visibleBounds(model: Model3D, hidden: Set<number>) {
  const parts = model.parts.filter((_, i) => !hidden.has(i));
  if (parts.length === 0 || hidden.size === 0) return model.bounds;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p.bounds.min[k]);
      max[k] = Math.max(max[k], p.bounds.max[k]);
    }
  }
  return { min, max };
}

/* ------------------------------- parts tree ------------------------------ */

interface TreeProps {
  model: Model3D;
  selected: number | null;
  hidden: Set<number>;
  onSelect: (part: number) => void;
  onHover: (part: number | null) => void;
  onFrame: (part: number) => void;
  onToggleHidden: (part: number) => void;
  onClose: () => void;
}

function PartsTree({ model, selected, hidden, onSelect, onHover, onFrame, onToggleHidden, onClose }: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();

  const rows: { key: string; depth: number; label: string; part: number | null }[] = [];
  const walk = (node: ModelNode, depth: number, key: string, isRoot: boolean) => {
    // The root is only worth a row when there is a hierarchy under it; a
    // single-part file or a flat list reads better without one.
    let childDepth = depth;
    if (!isRoot || node.children.length > 0) {
      rows.push({ key, depth, label: node.name || "Assembly", part: null });
      childDepth = depth + 1;
      if (collapsed.has(key) && !q) return;
    }
    for (const p of node.parts) {
      const name = model.parts[p].name;
      if (q && !name.toLowerCase().includes(q)) continue;
      rows.push({ key: `${key}/p${p}`, depth: childDepth, label: name, part: p });
    }
    node.children.forEach((c, i) => walk(c, childDepth, `${key}/${i}`, false));
  };
  walk(model.tree, 0, "root", true);

  return (
    <div className="model-parts" data-testid="model-parts">
      <div className="model-parts-header">
        <span>Parts</span>
        <button className="btn ghost sm" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <input
        className="filexplorer-search"
        type="search"
        placeholder="Filter parts…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="model-parts-list" onPointerLeave={() => onHover(null)}>
        {rows.map((r) =>
          r.part === null ? (
            <div
              key={r.key}
              className="model-parts-group"
              style={{ paddingLeft: 8 + r.depth * 12 }}
              onClick={() =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(r.key)) next.delete(r.key);
                  else next.add(r.key);
                  return next;
                })
              }
            >
              <span className="model-parts-caret">{collapsed.has(r.key) ? "▸" : "▾"}</span>
              {r.label}
            </div>
          ) : (
            <div
              key={r.key}
              className={`model-parts-row ${selected === r.part ? "selected" : ""} ${hidden.has(r.part) ? "hidden" : ""}`}
              style={{ paddingLeft: 8 + r.depth * 12 }}
              onClick={() => onSelect(r.part!)}
              onDoubleClick={() => onFrame(r.part!)}
              onPointerEnter={() => onHover(r.part)}
              title="Click to select · double-click to frame"
            >
              <button
                className="model-parts-eye"
                title={hidden.has(r.part) ? "Show" : "Hide"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleHidden(r.part!);
                }}
              >
                {hidden.has(r.part) ? "○" : "●"}
              </button>
              <span className="model-parts-name">{r.label}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
