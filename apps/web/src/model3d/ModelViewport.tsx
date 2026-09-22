import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { DocSession } from "../state/store";
import { useApp } from "../state/store";
import { formatArea, formatLength, formatVolume } from "../units";
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
import { measureBetween, snapToEdges, type MeasurePoint } from "./measure3d";
import { measureSelection, partOf, refLabel, type SelRef } from "./measure";
import { pickEdge, pickVertex, type Projector } from "./picking";
import { useOpenLoads } from "./stepImport";
import type { Model3D } from "./types";
import { useViewer } from "./viewerStore";

/**
 * The 3D viewer that replaces the drawing canvas in a model tab.
 *
 * Mouse: left-drag orbits, right/middle-drag pans, wheel zooms toward the
 * cursor, double-click frames what is under it. Clicking picks **topology**,
 * the way Onshape does — the vertex, edge or face under the cursor, in that
 * order of preference — and the corner readout says what it measures:
 * a length, a radius, an area, or the distance and angle between two picks.
 * Shift-click adds to the selection; the Structure panel picks whole parts. Touch: one finger
 * orbits, two fingers pinch-zoom and pan, tap selects, double-tap frames,
 * long-press hides the part under the finger. Keys: F fits all,
 * H hides the selected part, Shift+H shows everything, E toggles edges,
 * M toggles the measure tool, Esc clears the measurement / selection,
 * 1/2/3/4 jump to iso/top/front/right.
 *
 * Measure: with the tool on, each click/tap picks a point on the model,
 * snapped to the nearest B-rep vertex or edge (measure3d.ts); the second
 * point completes a distance, drawn as a screen-space overlay that is
 * re-projected after every render so it sticks to the geometry while the
 * camera moves. Nothing is stored — a measurement is a readout, not data.
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

/* ------------------------------ highlighting ----------------------------- */

const HIGHLIGHT_SELECT = (SELECT_COLOR[0] << 16) | (SELECT_COLOR[1] << 8) | SELECT_COLOR[2];
/** Hover is the selection colour washed toward white, so the two read apart at a glance. */
const HOVER_RGB: [number, number, number] = SELECT_COLOR.map((c) => Math.round(c + (255 - c) * 0.45)) as [number, number, number];
const HIGHLIGHT_HOVER = (HOVER_RGB[0] << 16) | (HOVER_RGB[1] << 8) | HOVER_RGB[2];

/** Push the edges and vertices of `refs` into the overlay line/point objects. */
function setOverlay(lines: THREE.LineSegments, points: THREE.Points, model: Model3D, refs: readonly SelRef[]) {
  const linePts: number[] = [];
  const pointPts: number[] = [];
  for (const r of refs) {
    if (r.kind === "edge") {
      const start = model.edgeTable.segStart[r.index];
      const count = model.edgeTable.segCount[r.index];
      for (let i = 0; i < count; i++) {
        const o = (start + i) * 6;
        for (let k = 0; k < 6; k++) linePts.push(model.edges[o + k]);
      }
    } else if (r.kind === "vertex") {
      const o = r.index * 3;
      pointPts.push(model.nodes.xyz[o], model.nodes.xyz[o + 1], model.nodes.xyz[o + 2]);
    }
  }
  setPositions(lines.geometry, linePts);
  setPositions(points.geometry, pointPts);
}

function setPositions(g: THREE.BufferGeometry, values: number[]) {
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(values), 3));
  g.computeBoundingSphere();
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
  /** Selection/hover overlays: picked edges and vertices, drawn over the shaded model. */
  selLines: THREE.LineSegments;
  hoverLines: THREE.LineSegments;
  selPoints: THREE.Points;
  hoverPoints: THREE.Points;
  requestRender: () => void;
  /** Called after each frame with the camera settled — the measure overlay re-projects itself here. */
  afterRender: { current: (() => void) | null };
  dispose: () => void;
}

function Viewer({ model }: { model: Model3D }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const selection = useViewer((v) => v.selection);
  const hover = useViewer((v) => v.hover);
  const hidden = useViewer((v) => v.hidden);
  const frameRequest = useViewer((v) => v.frameRequest);
  const pickInto = useViewer((v) => v.pick);
  const setHover = useViewer((v) => v.setHover);
  const hidePart = useViewer((v) => v.hide);
  const showAllParts = useViewer((v) => v.showAll);
  const useModel = useViewer((v) => v.useModel);
  const [showEdges, setShowEdges] = useState(true);
  const [measuring, setMeasuring] = useState(false);
  const [measure, setMeasure] = useState<{ a: MeasurePoint | null; b: MeasurePoint | null }>({ a: null, b: null });
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const overlayRef = useRef<SVGSVGElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
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
    // One finger orbits; two fingers pinch-zoom and pan together.
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.target.copy(framePerspective(camera, model.bounds, "iso"));
    controls.update();

    let pending = false;
    const afterRender: Scene["afterRender"] = { current: null };
    const requestRender = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        renderer.render(scene, camera);
        afterRender.current?.();
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

    // Selection overlays. depthTest off so a picked edge stays visible when
    // it sits a hair behind the surface it bounds — the same call Onshape makes.
    const lineObject = (color: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
      o.renderOrder = 10;
      o.frustumCulled = false;
      return o;
    };
    const pointObject = (color: number, size: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      const o = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }));
      o.renderOrder = 11;
      o.frustumCulled = false;
      return o;
    };
    const selLines = lineObject(HIGHLIGHT_SELECT);
    const hoverLines = lineObject(HIGHLIGHT_HOVER);
    const selPoints = pointObject(HIGHLIGHT_SELECT, 11);
    const hoverPoints = pointObject(HIGHLIGHT_HOVER, 9);
    scene.add(selLines, hoverLines, selPoints, hoverPoints);

    const partBoxes = model.parts.map((p) => toBox3(p.bounds));
    const s: Scene = {
      renderer,
      scene,
      camera,
      controls,
      objects,
      raycaster: new THREE.Raycaster(),
      partBoxes,
      selLines,
      hoverLines,
      selPoints,
      hoverPoints,
      requestRender,
      afterRender,
      dispose() {
        observer.disconnect();
        controls.dispose();
        objects.dispose();
        for (const o of [selLines, hoverLines, selPoints, hoverPoints]) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
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

  // The state that belongs to this model, not the previous one.
  useEffect(() => {
    useModel(model.hash);
  }, [model, useModel]);

  /**
   * Highlighting. Faces and parts are painted into the shared colour
   * attribute (restored from the model's pristine colours each time);
   * edges and vertices go into the overlay objects, since they aren't
   * surfaces. Hover paints first so a selected thing stays selected-coloured.
   */
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const attr = s.objects.geometry.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Uint8Array;
    arr.set(model.colors);
    const paint = (refs: readonly SelRef[], rgb: readonly number[]) => {
      for (const r of refs) {
        if (r.kind === "face") {
          const start = model.faces.triStart[r.index];
          const count = model.faces.triCount[r.index];
          for (let t = 0; t < count; t++) {
            for (let k = 0; k < 3; k++) {
              const vi = model.indices[(start + t) * 3 + k];
              arr[vi * 3] = rgb[0];
              arr[vi * 3 + 1] = rgb[1];
              arr[vi * 3 + 2] = rgb[2];
            }
          }
        } else if (r.kind === "part") {
          const p = model.parts[r.index];
          if (!p) continue;
          for (let i = p.vertexStart; i < p.vertexStart + p.vertexCount; i++) {
            arr[i * 3] = rgb[0];
            arr[i * 3 + 1] = rgb[1];
            arr[i * 3 + 2] = rgb[2];
          }
        }
      }
    };
    if (hover) paint([hover], HOVER_RGB);
    paint(selection, SELECT_COLOR);
    attr.needsUpdate = true;

    setOverlay(s.selLines, s.selPoints, model, selection);
    setOverlay(s.hoverLines, s.hoverPoints, model, hover ? [hover] : []);
    s.requestRender();
  }, [selection, hover, model]);

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

  // The Structure panel can't drive the camera, so it asks through the store.
  useEffect(() => {
    if (!frameRequest) return;
    const p = model.parts[frameRequest.part];
    if (p) frame(p.bounds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameRequest]);

  // ---- picking ------------------------------------------------------------
  /**
   * Everything a pick needs from one ray: the nearest surface hit (with the
   * triangle, which names the face), the parts the ray passes through, and a
   * world→pixel projector for the screen-space edge and vertex search.
   *
   * Coarse pass on part boxes, then exact triangles only inside candidate
   * parts (via drawRange) — a click on a million-triangle assembly stays
   * instant.
   */
  const probe = (clientX: number, clientY: number) => {
    const s = sceneRef.current;
    const canvas = canvasRef.current;
    if (!s || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const cursor = { x: clientX - rect.left, y: clientY - rect.top };
    const ndc = new THREE.Vector2((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1);
    s.raycaster.setFromCamera(ndc, s.camera);
    const ray = s.raycaster.ray;
    const at = new THREE.Vector3();
    const candidates: { part: number; dist: number }[] = [];
    for (let i = 0; i < s.partBoxes.length; i++) {
      if (hidden.has(i)) continue;
      if (ray.intersectBox(s.partBoxes[i], at)) candidates.push({ part: i, dist: at.distanceTo(ray.origin) });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const geometry = s.objects.geometry;
    let hit: { part: number; triangle: number; point: THREE.Vector3; dist: number } | null = null;
    for (const c of candidates) {
      if (hit && c.dist > hit.dist) break;
      const p = model.parts[c.part];
      geometry.setDrawRange(p.indexStart, p.indexCount);
      const hits = s.raycaster.intersectObject(s.objects.mesh, false);
      if (hits.length > 0 && (!hit || hits[0].distance < hit.dist)) {
        hit = { part: c.part, triangle: hits[0].faceIndex ?? 0, point: hits[0].point.clone(), dist: hits[0].distance };
      }
    }
    geometry.setDrawRange(0, Infinity);

    const v = new THREE.Vector3();
    const project: Projector = (p) => {
      v.set(p[0], p[1], p[2]);
      const depth = v.distanceTo(s.camera.position);
      v.project(s.camera);
      return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height, visible: v.z < 1, depth };
    };
    const worldPerPixel = (d: number) => (2 * d * Math.tan((s.camera.fov * Math.PI) / 360)) / Math.max(1, canvas.clientHeight);
    return { cursor, hit, candidates, project, worldPerPixel };
  };

  /** The topology under the cursor: vertex, then edge, then the face the ray landed on. */
  const pickRef = (clientX: number, clientY: number, touch: boolean): SelRef | null => {
    const pr = probe(clientX, clientY);
    if (!pr) return null;
    const tolPx = touch ? 14 : 7;
    // Only the part the ray actually hit competes for edges and vertices;
    // with nothing hit, the few parts the ray passes near do.
    const parts = pr.hit ? [pr.hit.part] : pr.candidates.slice(0, 8).map((c) => c.part);
    const opts = {
      tolPx,
      maxDepth: pr.hit ? pr.hit.dist + pr.worldPerPixel(pr.hit.dist) * (tolPx + 2) : Infinity,
    };
    for (const part of parts) {
      const v = pickVertex(model, part, pr.cursor, pr.project, opts);
      if (v !== null) return { kind: "vertex", index: v };
    }
    for (const part of parts) {
      const e = pickEdge(model, part, pr.cursor, pr.project, opts);
      if (e !== null) return { kind: "edge", index: e };
    }
    if (pr.hit) return { kind: "face", index: model.faceOfTriangle[pr.hit.triangle] ?? 0 };
    return null;
  };

  const pick = (clientX: number, clientY: number): number | null => probe(clientX, clientY)?.hit?.part ?? null;

  /**
   * A measure point under the pointer: the surface hit snapped to the part's
   * vertices/edges within a pixel tolerance — wider for a finger — converted
   * to world units at the hit's depth.
   */
  const pickMeasurePoint = (clientX: number, clientY: number, touch: boolean): MeasurePoint | null => {
    const pr = probe(clientX, clientY);
    if (!pr?.hit) return null;
    const px = touch ? 18 : 10;
    return snapToEdges(model, pr.hit.part, [pr.hit.point.x, pr.hit.point.y, pr.hit.point.z], px * pr.worldPerPixel(pr.hit.dist));
  };

  const addMeasurePoint = (clientX: number, clientY: number, touch: boolean) => {
    const pt = pickMeasurePoint(clientX, clientY, touch);
    if (!pt) return;
    setMeasure((m) => (m.a && !m.b ? { a: m.a, b: pt } : { a: pt, b: null }));
  };
  const clearMeasure = () => setMeasure({ a: null, b: null });

  // The overlay is re-projected imperatively after each render rather than
  // through React state, so orbiting with a measurement on screen doesn't
  // re-render the component per frame.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const sync = () => {
      const svg = overlayRef.current;
      const label = labelRef.current;
      const canvas = canvasRef.current;
      const m = measureRef.current;
      if (!svg || !label || !canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const project = (pt: MeasurePoint) => {
        const v = new THREE.Vector3(...pt.point).project(s.camera);
        return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, visible: v.z < 1 };
      };
      const pts = [m.a, m.b].filter((p): p is MeasurePoint => !!p).map(project);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const [c1, c2, line] = ["#m-a", "#m-b", "#m-line"].map((id) => svg.querySelector(id) as SVGElement | null);
      const place = (el: SVGElement | null, p?: { x: number; y: number; visible: boolean }) => {
        if (!el) return;
        el.style.display = p && p.visible ? "" : "none";
        if (p) {
          el.setAttribute("cx", String(p.x));
          el.setAttribute("cy", String(p.y));
        }
      };
      place(c1, pts[0]);
      place(c2, pts[1]);
      if (line) {
        const both = pts.length === 2 && pts[0].visible && pts[1].visible;
        line.style.display = both ? "" : "none";
        if (both) {
          line.setAttribute("x1", String(pts[0].x));
          line.setAttribute("y1", String(pts[0].y));
          line.setAttribute("x2", String(pts[1].x));
          line.setAttribute("y2", String(pts[1].y));
        }
        label.style.display = both ? "" : "none";
        if (both) {
          label.style.left = `${(pts[0].x + pts[1].x) / 2}px`;
          label.style.top = `${(pts[0].y + pts[1].y) / 2}px`;
        }
      }
    };
    s.afterRender.current = sync;
    sync();
    return () => {
      if (s.afterRender.current === sync) s.afterRender.current = null;
    };
  }, [measure, model]);

  const measured = useMemo(() => (measure.a && measure.b ? measureBetween(measure.a.point, measure.b.point) : null), [measure]);

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
  // Taps and clicks share one path. Touch gets a wider "didn't move" budget
  // (fingers wobble), its own double-tap detection (dblclick is unreliable
  // once touch-action is none), and a long-press to hide the part under the
  // finger — the touch stand-in for the H key. Orbit/pan/pinch themselves are
  // OrbitControls' built-in one- and two-finger gestures.
  const downAt = useRef<{ x: number; y: number; id: number; touch: boolean } | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current);
    longPress.current = null;
  };
  const slop = (touch: boolean) => (touch ? 12 : 4);

  const onPointerDown = (e: React.PointerEvent) => {
    const touch = e.pointerType === "touch";
    // A second finger means a pinch/pan gesture, never a tap.
    if (downAt.current && touch) {
      downAt.current = null;
      cancelLongPress();
      return;
    }
    downAt.current = { x: e.clientX, y: e.clientY, id: e.pointerId, touch };
    cancelLongPress();
    if (touch) {
      const { clientX, clientY } = e;
      longPress.current = setTimeout(() => {
        longPress.current = null;
        downAt.current = null;
        const part = pick(clientX, clientY);
        if (part === null) return;
        hidePart(part);
      }, 550);
    }
  };
  /** Hover highlighting, one pick per frame at most — the cursor moves far more often than that. */
  const hoverQueued = useRef(false);
  const onPointerMove = (e: React.PointerEvent) => {
    const d = downAt.current;
    if (d && d.id === e.pointerId && Math.hypot(e.clientX - d.x, e.clientY - d.y) > slop(d.touch)) cancelLongPress();
    if (e.pointerType === "touch" || e.buttons !== 0 || measuring) return;
    if (hoverQueued.current) return;
    hoverQueued.current = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      hoverQueued.current = false;
      setHover(pickRef(clientX, clientY, false));
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    cancelLongPress();
    const d = downAt.current;
    downAt.current = null;
    // A drag is an orbit, not a click.
    if (!d || d.id !== e.pointerId || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > slop(d.touch)) return;
    if (d.touch) {
      const prev = lastTap.current;
      const now = performance.now();
      if (prev && now - prev.at < 350 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30) {
        lastTap.current = null;
        frameAt(e.clientX, e.clientY);
        return;
      }
      lastTap.current = { at: now, x: e.clientX, y: e.clientY };
    }
    if (measuring) {
      addMeasurePoint(e.clientX, e.clientY, d.touch);
      return;
    }
    pickInto(pickRef(e.clientX, e.clientY, d.touch), e.shiftKey || e.ctrlKey || e.metaKey);
  };
  const onPointerCancel = () => {
    cancelLongPress();
    downAt.current = null;
  };
  const onPointerLeave = () => setHover(null);
  /** Double-click / double-tap: frame the part under the cursor, or everything. */
  const frameAt = (clientX: number, clientY: number) => {
    const part = pick(clientX, clientY);
    if (part !== null) fitPart(part);
    else fitAll();
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    // Touch double-taps are handled in onPointerUp.
    if ((e.nativeEvent as PointerEvent).pointerType === "touch") return;
    frameAt(e.clientX, e.clientY);
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
        case "h": {
          const last = selection[selection.length - 1];
          if (last) hidePart(partOf(model, last));
          break;
        }
        case "H":
          showAllParts();
          break;
        case "m":
        case "M":
          toggleMeasuring();
          break;
        case "Escape":
          // Peel back one layer at a time: points, then the tool, then the selection.
          if (measure.a) clearMeasure();
          else if (measuring) setMeasuring(false);
          else pickInto(null, false);
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
  }, [selection, hidden, model, measuring, measure]);

  const toggleMeasuring = () => {
    setMeasuring((v) => {
      if (v) clearMeasure();
      return !v;
    });
  };

  const sizeOf = (b: Model3D["bounds"]) => [0, 1, 2].map((k) => formatLength(b.max[k] - b.min[k], displayUnit)).join(" × ");
  const size = useMemo(() => sizeOf(model.bounds), [model, displayUnit]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = hover ?? selection[selection.length - 1] ?? null;
  const statusPart = shown ? partOf(model, shown) : null;
  const rows = useMemo(
    () =>
      measureSelection(model, selection, {
        length: (v) => formatLength(v, displayUnit),
        area: (v) => formatArea(v, displayUnit),
        volume: (v) => formatVolume(v, displayUnit),
      }),
    [model, selection, displayUnit],
  );
  const readoutTitle = selection
    .slice(-2)
    .map((r) => refLabel(model, r))
    .join(" ↔ ");
  const measureHint = !measuring
    ? null
    : !measure.a
      ? "Tap the first point"
      : !measure.b
        ? "Tap the second point"
        : null;
  return (
    <div className="model-stage" ref={hostRef} data-testid="model-viewport">
      <canvas
        ref={canvasRef}
        className={`model-canvas ${measuring ? "measuring" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      />
      {/* Measurement overlay: screen-space, re-projected after every render (see the sync effect). */}
      <svg ref={overlayRef} className="model-measure-overlay" data-testid="model-measure-overlay" aria-hidden="true">
        <line id="m-line" style={{ display: "none" }} />
        <circle id="m-a" r="5" style={{ display: "none" }} />
        <circle id="m-b" r="5" style={{ display: "none" }} />
      </svg>
      <div ref={labelRef} className="model-measure-label" data-testid="model-measure-label" style={{ display: "none" }}>
        {measured ? formatLength(measured.distance, displayUnit) : ""}
      </div>
      <div className="model-toolbar" data-testid="model-toolbar">
        <ToolButton title="Isometric (1)" label="Iso" icon={ICONS.iso} onClick={() => fitAll("iso")} />
        <ToolButton title="Top (2)" label="Top" icon={ICONS.top} onClick={() => fitAll("top")} />
        <ToolButton title="Front (3)" label="Front" icon={ICONS.front} onClick={() => fitAll("front")} />
        <ToolButton title="Right (4)" label="Right" icon={ICONS.right} onClick={() => fitAll("right")} />
        <span className="model-toolbar-sep" />
        <ToolButton title="Fit everything visible (F)" label="Fit" icon={ICONS.fit} onClick={() => fitAll()} />
        <ToolButton
          title="Toggle B-rep edges (E)"
          label="Edges"
          icon={ICONS.edges}
          active={showEdges}
          onClick={() => setShowEdges((v) => !v)}
        />
        <ToolButton
          title="Measure the distance between two points — snaps to corners and edges (M)"
          label="Measure"
          icon={ICONS.measure}
          active={measuring}
          onClick={toggleMeasuring}
          testId="model-measure-toggle"
        />
        <ToolButton
          title="Hide the selected part (H)"
          label="Hide"
          icon={ICONS.hide}
          disabled={selection.length === 0}
          onClick={() => {
            const last = selection[selection.length - 1];
            if (last) hidePart(partOf(model, last));
          }}
        />
        <ToolButton
          title="Show all hidden parts (Shift+H)"
          label={`Show all${hidden.size > 0 ? ` (${hidden.size})` : ""}`}
          icon={ICONS.showAll}
          disabled={hidden.size === 0}
          onClick={showAllParts}
        />
      </div>
      <div className="model-status" data-testid="model-status">
        {measuring ? (
          <>
            {measured && measure.a && measure.b ? (
              <span className="model-status-measure" data-testid="model-measure-readout">
                <b>{formatLength(measured.distance, displayUnit)}</b>
                {" · ΔX "}
                {formatLength(measured.dx, displayUnit)}
                {" ΔY "}
                {formatLength(measured.dy, displayUnit)}
                {" ΔZ "}
                {formatLength(measured.dz, displayUnit)}
                <span className="model-status-snap">
                  {" "}
                  ({measure.a.snap} → {measure.b.snap})
                </span>
              </span>
            ) : (
              <span className="model-status-part">{measureHint}</span>
            )}
          </>
        ) : (
          <>
            <span>{model.parts.length} parts</span>
            <span>{model.triangleCount.toLocaleString()} triangles</span>
            <span title={statusPart !== null ? "Part bounding box, X × Y × Z" : "Bounding box, X × Y × Z"}>
              {statusPart !== null ? sizeOf(model.parts[statusPart].bounds) : size}
            </span>
            {statusPart !== null && (
              <span className="model-status-part" data-testid="model-status-part">
                {model.parts[statusPart].name}
              </span>
            )}
          </>
        )}
      </div>
      {/* The corner readout: what the current picks measure. */}
      {!measuring && rows.length > 0 && (
        <div className="model-measure-panel" data-testid="model-measure-panel">
          <div className="model-measure-panel-head">
            <span className="model-measure-panel-title" title={readoutTitle}>
              {readoutTitle}
            </span>
            <button className="btn ghost sm" title="Clear the selection (Esc)" onClick={() => pickInto(null, false)}>
              ✕
            </button>
          </div>
          {rows.map((r) => (
            <div className="model-measure-row" key={r.label}>
              <span className="model-measure-key">{r.label}</span>
              <span className="model-measure-value" title={r.approx ? "Approximate — measured on the tessellation" : undefined}>
                {r.approx ? "≈ " : ""}
                {r.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- toolbar --------------------------------- */

interface ToolButtonProps {
  title: string;
  label: string;
  icon: JSX.Element;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}

/** A toolbar button: icon + label. In touch mode the stylesheet stacks them into a big tile. */
function ToolButton({ title, label, icon, active, disabled, onClick, testId }: ToolButtonProps) {
  return (
    <button
      className={`btn ghost sm model-tool ${active ? "active" : ""}`}
      title={title}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {icon}
      <span className="model-tool-label">{label}</span>
    </button>
  );
}

const stroke = { stroke: "currentColor", strokeWidth: 1.8, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ICONS = {
  iso: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9" {...stroke} />
    </svg>
  ),
  top: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <rect x="4" y="4" width="16" height="16" rx="1.5" {...stroke} />
      <path d="M4 9h16" {...stroke} />
    </svg>
  ),
  front: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <rect x="4" y="4" width="16" height="16" rx="1.5" {...stroke} />
      <path d="M4 15h16" {...stroke} />
    </svg>
  ),
  right: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <rect x="4" y="4" width="16" height="16" rx="1.5" {...stroke} />
      <path d="M15 4v16" {...stroke} />
    </svg>
  ),
  fit: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" {...stroke} />
      <rect x="9" y="9" width="6" height="6" {...stroke} />
    </svg>
  ),
  edges: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" {...stroke} />
      <path d="M12 12l8-4.5M12 12L4 7.5M12 12v9" {...stroke} strokeDasharray="2 2" />
    </svg>
  ),
  measure: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M3 17L17 3l4 4L7 21z" {...stroke} />
      <path d="M8 12l2 2M11 9l2 2M14 6l2 2" {...stroke} />
    </svg>
  ),
  hide: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" {...stroke} />
      <path d="M4 4l16 16" {...stroke} />
    </svg>
  ),
  showAll: (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" {...stroke} />
      <circle cx="12" cy="12" r="2.5" {...stroke} />
    </svg>
  ),
};

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
