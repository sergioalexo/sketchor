import { importDxfText, useApp } from "../state/store";

/**
 * Desktop-only: when Sketchor is launched by double-clicking a .dxf (or via
 * "Open with"), the Rust side reads the file and emits an "open-dxf" event.
 * We load it onto the canvas and add it to the library.
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

export function initDesktopDxfOpen(): void {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.event) return;

  tauri.event.listen("open-dxf", ({ payload }) => {
    if (!payload?.text) return;
    useApp.getState().addLibraryFiles([{ name: payload.name, text: payload.text }]);
    importDxfText(payload.text);
  });
}
