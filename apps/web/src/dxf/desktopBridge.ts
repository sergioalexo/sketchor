import { importDxfText, importEntities, openIntoSession, useApp } from "../state/store";
import { importDwgBuffer } from "../browser/dwgImport";
import { parseSvgText } from "@sketchor/core";

/**
 * Desktop-only: when Sketchor is launched by double-clicking a file (or via
 * "Open with"), the Rust side reads it and emits an event. We load it into a
 * tab (reusing the active one if it's still blank, else opening a new one —
 * see openIntoSession). Three file kinds are handled:
 *
 *  - `open-dxf` → import DXF geometry (payload.text)
 *  - `open-svg` → import SVG geometry (payload.text)
 *  - `open-dwg` → import DWG geometry (payload.base64, since DWG is binary
 *    — see dwgImport.ts)
 *
 * On the web there is no `window.__TAURI__`, so this is a no-op — the same
 * bundle runs in the browser and the desktop shell.
 */
interface TauriGlobal {
  event: {
    listen: (
      event: string,
      handler: (e: { payload: { name: string; text?: string; base64?: string; dir?: string } }) => void,
    ) => Promise<() => void>;
  };
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

export function initDesktopFileOpen(): void {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.event) return;

  tauri.event.listen("open-dxf", ({ payload }) => {
    if (!payload?.text) return;
    openIntoSession(payload.name, () => importDxfText(payload.text!));
    revealFolder(payload.dir);
  });

  tauri.event.listen("open-svg", ({ payload }) => {
    if (!payload?.text) return;
    const { entities, warnings } = parseSvgText(payload.text);
    openIntoSession(payload.name, () => importEntities(entities, warnings));
    revealFolder(payload.dir);
  });

  tauri.event.listen("open-dwg", ({ payload }) => {
    if (!payload?.base64) return;
    importDwgBuffer(base64ToArrayBuffer(payload.base64)).then(({ entities, warnings }) => {
      openIntoSession(payload.name, () => importEntities(entities, warnings));
      revealFolder(payload.dir);
    });
  });
}
