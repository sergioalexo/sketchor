import { importDxfText, importEntities, importSvgText, openIntoSession, useApp } from "../state/store";
import { DWG_UNREADABLE, dwgToDxfText } from "../browser/dwgImport";
import { decodeDxfBytes } from "@sketchor/core";
import { bindDxfVersion, bindSavePath, openModelBytes } from "../io/drawingFile";

/**
 * Desktop-only: when Sketchor is launched by double-clicking a file (or via
 * "Open with"), the Rust side reads it and emits an event. We load it into a
 * tab (reusing the active one if it's still blank, else opening a new one —
 * see openIntoSession). Three file kinds are handled:
 *
 *  - `open-dxf` → import DXF geometry (payload.text)
 *  - `open-svg` → import SVG geometry (payload.text)
 *  - `open-dwg` → import DWG geometry, since DWG is binary — see dwgImport.ts
 *  - `open-model` → open a STEP/IGES model in a 3D viewer tab; the exact
 *    bytes are the model cache key — see model3d/
 *
 * `open-dwg`/`open-model` carry only `payload.path`: the bytes are fetched
 * separately via `read_file_bytes`, which arrives as raw bytes over IPC
 * rather than a base64 string that both inflates the transfer by a third
 * and fails outright on a STEP file with non-UTF-8 bytes if read any other
 * way. `payload.base64` is still handled if present — a UI briefly out of
 * step with the Rust binary during an update — but the desktop shell no
 * longer sends it.
 *
 * On the web there is no `window.__TAURI__`, so this is a no-op — the same
 * bundle runs in the browser and the desktop shell.
 */
interface TauriGlobal {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (
      event: string,
      handler: (e: { payload: { name: string; text?: string; base64?: string; dir?: string; path?: string } }) => void,
    ) => Promise<() => void>;
  };
}

/**
 * Binds the freshly-opened tab to the file on disk it came from, so Save
 * (Ctrl+S) overwrites the drawing the user double-clicked. DWG is import-only
 * and bindSavePath ignores it.
 */
function bindOpened(path: string | undefined, name: string): void {
  if (path) bindSavePath(path, name);
}

/** Reveals the in-app file browser (R9) pointed at the opened file's folder, when the desktop side sent one. */
function revealFolder(dir: string | undefined): void {
  if (!dir) return;
  useApp.getState().setFileBrowserDesktopDir(dir);
  useApp.getState().setFileBrowserVisible(true);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Bytes for a binary `open-*` payload: the new path-only form, or the base64 fallback (see the module docblock). */
async function payloadBytes(
  tauri: TauriGlobal,
  payload: { base64?: string; path?: string },
): Promise<ArrayBuffer | undefined> {
  if (payload.base64) return base64ToArrayBuffer(payload.base64);
  if (payload.path) return (await tauri.core.invoke("read_file_bytes", { path: payload.path })) as ArrayBuffer;
  return undefined;
}

export function initDesktopFileOpen(): void {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.event) return;

  tauri.event.listen("open-dxf", ({ payload }) => {
    if (!payload) return;
    const textPromise = payload.text
      ? Promise.resolve(payload.text)
      : payloadBytes(tauri, payload).then((bytes) => (bytes ? decodeDxfBytes(new Uint8Array(bytes)) : undefined));
    textPromise.then((text) => {
      if (!text) return;
      openIntoSession(payload.name, () => importDxfText(text));
      bindDxfVersion(text);
      bindOpened(payload.path, payload.name);
      revealFolder(payload.dir);
    });
  });

  tauri.event.listen("open-svg", ({ payload }) => {
    if (!payload?.text) return;
    const svgText = payload.text;
    openIntoSession(payload.name, () => importSvgText(svgText));
    bindOpened(payload.path, payload.name);
    revealFolder(payload.dir);
  });

  tauri.event.listen("open-model", ({ payload }) => {
    if (!payload) return;
    payloadBytes(tauri, payload).then((bytes) => {
      if (!bytes) return;
      openModelBytes(payload.name, bytes);
      revealFolder(payload.dir);
    });
  });

  tauri.event.listen("open-dwg", ({ payload }) => {
    if (!payload) return;
    payloadBytes(tauri, payload).then((bytes) => {
      if (!bytes) return;
      dwgToDxfText(bytes).then((text) => {
        openIntoSession(payload.name, () => (text ? importDxfText(text) : importEntities([], [DWG_UNREADABLE])));
        revealFolder(payload.dir);
      });
    });
  });
}
