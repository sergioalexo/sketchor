import { drawingToJson, finishSessionSave, loadDrawingJson, openIntoSession } from "../state/store";

/**
 * Save / open of Sketchor's native `.sketchor` documents.
 *
 * These files are exactly `SketchDocument.toJSON()` on disk, which is also
 * what the native Windows Explorer shell extension (`native/sketchor-shell`)
 * parses to render its geometry thumbnail and preview pane. Saving here is
 * what finally produces files for Explorer to preview.
 *
 * Prefers the File System Access API (`showSaveFilePicker` / `showOpenFilePicker`),
 * which is available both in Chromium browsers and in Tauri's WebView2, so the
 * same code path serves the web app and the desktop shell. Falls back to a
 * download / hidden `<input type=file>` where the API is missing.
 */

const EXT = ".sketchor";

// Minimal shape of the File System Access API we use — declared locally so we
// don't need the `@types/wicg-file-system-access` package. Supported by
// Chromium browsers and Tauri's WebView2.
interface PickerType {
  description?: string;
  accept: Record<string, string[]>;
}
interface FsWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  name: string;
  createWritable(): Promise<FsWritable>;
  getFile(): Promise<File>;
}
interface WindowWithFS extends Window {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: PickerType[];
  }) => Promise<FsFileHandle>;
  showOpenFilePicker?: (opts: {
    multiple?: boolean;
    types?: PickerType[];
  }) => Promise<FsFileHandle[]>;
}

const FILE_TYPES: PickerType[] = [
  { description: "Sketchor Drawing", accept: { "application/x-sketchor": [EXT] } },
];

/** Saves the current drawing, prompting for a location. No-op if cancelled. */
export async function saveSketchor(suggestedName = "drawing.sketchor"): Promise<void> {
  const json = drawingToJson();
  const w = window as WindowWithFS;

  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName, types: FILE_TYPES });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      finishSessionSave(handle.name);
    } catch (err) {
      // The user dismissing the picker throws AbortError — treat as a no-op.
      if ((err as DOMException)?.name !== "AbortError") throw err;
    }
    return;
  }

  // Fallback: trigger a browser download.
  const blob = new Blob([json], { type: "application/x-sketchor" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  finishSessionSave(suggestedName);
}

/** Opens a `.sketchor` file into the canvas. No-op if cancelled. */
export async function openSketchor(): Promise<void> {
  const w = window as WindowWithFS;

  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [handle] = await w.showOpenFilePicker({ multiple: false, types: FILE_TYPES });
      if (!handle) return;
      const file = await handle.getFile();
      const text = await file.text();
      openIntoSession(handle.name, () => loadDrawingJson(text));
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") throw err;
    }
    return;
  }

  // Fallback: a hidden file input.
  await new Promise<void>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = EXT;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        const text = await file.text();
        openIntoSession(file.name, () => loadDrawingJson(text));
      }
      resolve();
    };
    input.oncancel = () => resolve();
    input.click();
  });
}
