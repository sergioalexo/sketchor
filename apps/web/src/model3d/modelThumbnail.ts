import * as THREE from "three";
import { getCachedThumb, putCachedThumb } from "./modelCache";
import { buildLights, buildModelObjects, frameOrthographic, STAGE_BACKGROUND } from "./modelScene";
import { hashBytes, loadModel } from "./stepImport";
import type { Model3D } from "./types";

/**
 * Isometric preview thumbnails for 3D model files, for the file browser.
 *
 * One shared offscreen WebGL renderer draws every thumbnail (browsers cap
 * live WebGL contexts at around a dozen, so a context per card is not an
 * option). The PNG is cached by content hash, so a folder you've browsed
 * before shows its previews immediately, without touching the meshes.
 *
 * Loaded lazily — this module (and three.js with it) stays out of the main
 * bundle until a model file first appears in the browser.
 */

/** Rendered at 2x the 110 px card so it stays crisp on high-DPI screens. */
const THUMB_SIZE = 256;

let shared: { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } | null = null;

function sharedRenderer(): { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } | null {
  if (shared) return shared;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
    renderer.setClearColor(STAGE_BACKGROUND, 1);
    canvas.addEventListener("webglcontextlost", () => {
      shared = null;
    });
    shared = { renderer, canvas };
    return shared;
  } catch {
    return null;
  }
}

/** Draws `model` in isometric view and returns a PNG data URL, or null if WebGL is unavailable. */
export function renderModelThumbnail(model: Model3D): string | null {
  const ctx = sharedRenderer();
  if (!ctx) return null;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  scene.add(...buildLights(camera));
  const objects = buildModelObjects(model);
  scene.add(objects.group);
  frameOrthographic(camera, model.bounds, "iso", 1, 0.1);
  try {
    ctx.renderer.render(scene, camera);
    return ctx.canvas.toDataURL("image/png");
  } finally {
    objects.dispose();
  }
}

/**
 * Desktop only: mirrors a preview to `%LOCALAPPDATA%/Sketchor/thumbs` for
 * the Explorer thumbnail handler (native/dxf-thumbnailer), so the file's
 * icon in Explorer shows the same picture as the app. No-op on the web.
 */
async function mirrorToExplorer(hash: string, dataUrl: string): Promise<void> {
  const tauri = (window as unknown as { __TAURI__?: { core: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__;
  if (!tauri) return;
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/png;base64,") || comma < 0) return;
  try {
    await tauri.core.invoke("write_thumbnail_cache", { hash, pngBase64: dataUrl.slice(comma + 1) });
  } catch {
    // Best-effort: Explorer falls back to its wireframe preview.
  }
}

/**
 * The thumbnail for a model file's bytes: from the thumbnail cache if it has
 * been rendered before, else by loading the model (itself cached) and
 * rendering it. `buffer` is consumed.
 */
export async function thumbnailForModelFile(name: string, buffer: ArrayBuffer): Promise<string | null> {
  const hash = await hashBytes(buffer);
  const cached = await getCachedThumb(hash);
  if (cached) {
    void mirrorToExplorer(hash, cached);
    return cached;
  }
  const model = await loadModel(name, buffer, "thumbnail", hash);
  const dataUrl = renderModelThumbnail(model);
  if (dataUrl) {
    await putCachedThumb(hash, dataUrl);
    void mirrorToExplorer(hash, dataUrl);
  }
  return dataUrl;
}

/**
 * Makes sure an already-loaded model has a thumbnail in both caches — called
 * after a model is *opened*, so a file reached through the Open dialog or a
 * double-click in Explorer gets its Explorer preview too, not only files the
 * in-app browser scrolled past.
 */
export async function ensureThumbnail(model: Model3D): Promise<void> {
  let dataUrl = await getCachedThumb(model.hash);
  if (!dataUrl) {
    dataUrl = renderModelThumbnail(model);
    if (!dataUrl) return;
    await putCachedThumb(model.hash, dataUrl);
  }
  await mirrorToExplorer(model.hash, dataUrl);
}
