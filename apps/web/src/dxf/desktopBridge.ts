import { importDxfText, loadDrawingJson, openIntoSession, useApp } from "../state/store";

/**
 * Desktop-only: when Sketchor is launched by double-clicking a file (or via
 * "Open with"), the Rust side reads it and emits an event. We load it into a
 * tab (reusing the active one if it's still blank, else opening a new one —
 * see openIntoSession). Two file kinds are handled:
 *
 *  - `open-dxf`      → import DXF geometry (added to the library too)
 *  - `open-sketchor` → load a native `.sketchor` document
 *
 * On the web there is no `window.__TAURI__`, so this is a no-op — the same
 * bundle runs in the browser and the desktop shell.
 */
interface TauriGlobal {
  event: {
    listen: (
      event: string,
      handler: (e: { payload: { name: string; text: string } }) => void,
    ) => Promise<() => void>;
  };
}

export function initDesktopFileOpen(): void {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.event) return;

  tauri.event.listen("open-dxf", ({ payload }) => {
    if (!payload?.text) return;
    openIntoSession(payload.name, () => {
      useApp.getState().addLibraryFiles([{ name: payload.name, text: payload.text }]);
      importDxfText(payload.text);
    });
  });

  tauri.event.listen("open-sketchor", ({ payload }) => {
    if (!payload?.text) return;
    try {
      openIntoSession(payload.name, () => loadDrawingJson(payload.text));
    } catch {
      // Malformed file — leave the canvas as-is rather than crashing.
    }
  });
}

/** @deprecated Use {@link initDesktopFileOpen}. Kept for older call sites. */
export const initDesktopDxfOpen = initDesktopFileOpen;
