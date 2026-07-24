import { entitiesToDxf, entitiesToSvgDocument, parseSvgText } from "@sketchor/core";
import { importDwgBuffer } from "../browser/dwgImport";
import { doc, finishSessionSave, importDxfText, importEntities, openIntoSession, useApp } from "../state/store";
import { displayUnitToDxfCode } from "../units";

/**
 * Save / open of Sketchor's supported drawing formats: DXF and SVG for
 * both directions, plus DWG import (read-only — see dwgImport.ts and
 * NOTICE.md for why there's no DWG export).
 *
 * Prefers the File System Access API (`showSaveFilePicker` / `showOpenFilePicker`),
 * which is available both in Chromium browsers and in Tauri's WebView2, so the
 * same code path serves the web app and the desktop shell. Falls back to a
 * download / hidden `<input type=file>` where the API is missing.
 */

export type SaveFormat = "dxf" | "svg";

const SAVE_FORMAT: Record<SaveFormat, { mime: string; description: string }> = {
  dxf: { mime: "application/dxf", description: "DXF Drawing" },
  svg: { mime: "image/svg+xml", description: "SVG Drawing" },
};

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

const OPEN_TYPES: PickerType[] = [
  { description: "Drawing", accept: { "application/octet-stream": [".dxf", ".svg", ".dwg"] } },
];

function serialize(format: SaveFormat): string {
  const entities = doc.all();
  if (format === "dxf") {
    return entitiesToDxf(entities, displayUnitToDxfCode(useApp.getState().displayUnit));
  }
  return entitiesToSvgDocument(entities);
}

/** Saves the current drawing as DXF or SVG, prompting for a location. No-op if cancelled. */
export async function saveDrawing(format: SaveFormat, suggestedName?: string): Promise<void> {
  const text = serialize(format);
  const { mime, description } = SAVE_FORMAT[format];
  const name = suggestedName ?? `drawing.${format}`;
  const w = window as WindowWithFS;

  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: name,
        types: [{ description, accept: { [mime]: [`.${format}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      finishSessionSave(handle.name);
    } catch (err) {
      // The user dismissing the picker throws AbortError — treat as a no-op.
      if ((err as DOMException)?.name !== "AbortError") throw err;
    }
    return;
  }

  // Fallback: trigger a browser download.
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  finishSessionSave(name);
}

/** Loads a DXF/SVG/DWG `File` into a tab (opening or reusing one — see openIntoSession). */
export async function loadDrawingFile(name: string, file: File): Promise<void> {
  if (/\.svg$/i.test(name)) {
    const text = await file.text();
    const { entities, warnings } = parseSvgText(text);
    openIntoSession(name, () => importEntities(entities, warnings));
  } else if (/\.dwg$/i.test(name)) {
    const buffer = await file.arrayBuffer();
    const { entities, warnings } = await importDwgBuffer(buffer);
    openIntoSession(name, () => importEntities(entities, warnings));
  } else {
    const text = await file.text();
    openIntoSession(name, () => importDxfText(text));
  }
}

/** Opens a DXF/SVG/DWG file into the canvas. No-op if cancelled. */
export async function openDrawing(): Promise<void> {
  const w = window as WindowWithFS;

  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [handle] = await w.showOpenFilePicker({ multiple: false, types: OPEN_TYPES });
      if (!handle) return;
      const file = await handle.getFile();
      await loadDrawingFile(handle.name, file);
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") throw err;
    }
    return;
  }

  // Fallback: a hidden file input.
  await new Promise<void>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".dxf,.svg,.dwg";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await loadDrawingFile(file.name, file);
      resolve();
    };
    input.oncancel = () => resolve();
    input.click();
  });
}
