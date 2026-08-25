import { entitiesToDxf, entitiesToSvgDocument, parseSvgText } from "@sketchor/core";
import { importDwgBuffer } from "../browser/dwgImport";
import {
  doc,
  finishSessionSave,
  getSessions,
  importDxfText,
  importEntities,
  openIntoSession,
  overlayDxfText,
  overlayEntities,
  useApp,
} from "../state/store";
import { displayUnitToDxfCode, factorFromMm } from "../units";

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
    const displayUnit = useApp.getState().displayUnit;
    // Stored coordinates are always millimeters — rescale to match the
    // declared unit so the file's numbers represent real-world size.
    return entitiesToDxf(entities, displayUnitToDxfCode(displayUnit), factorFromMm(displayUnit));
  }
  return entitiesToSvgDocument(entities);
}

/* ----------------------------- save targets ----------------------------- */

/**
 * The real file a tab is bound to, so a plain "Save" overwrites the drawing
 * the user actually opened instead of reprompting for a location.
 *
 * Two flavours, because a file reaches a tab two different ways:
 * - `handle` — picked through the File System Access API (Ctrl+O, Save As,
 *   or a folder chosen in the file browser on the web build).
 * - `path` — a native path from the desktop build: the file browser's folder
 *   listing and the OS file association both hand us a path, never a handle.
 *   Written back through the `write_drawing_file` Tauri command.
 *
 * Keyed by session id rather than stored on DocSession to avoid a circular
 * import (store.ts doesn't need to know about file handles).
 */
export type SaveTarget =
  | { kind: "handle"; handle: FsFileHandle; format: SaveFormat; name: string }
  | { kind: "path"; path: string; format: SaveFormat; name: string };

const saveTargets = new Map<string, SaveTarget>();

/** The format a filename implies, or null when it isn't something we can write (DWG). */
function writableFormat(name: string): SaveFormat | null {
  if (/\.svg$/i.test(name)) return "svg";
  if (/\.dwg$/i.test(name)) return null; // import-only, nothing to save back to
  return "dxf";
}

function activeSessionId(): string {
  return useApp.getState().activeSessionId;
}

/** The file the active tab would overwrite on a plain Save, or null if it has none yet. */
export function activeSaveTarget(): SaveTarget | null {
  return saveTargets.get(activeSessionId()) ?? null;
}

/**
 * Binds the active tab to a file opened by full native path (desktop file
 * browser, or a drawing opened from Explorer). Call after the drawing has
 * been loaded, so `activeSessionId` is the tab it landed in.
 */
export function bindSavePath(path: string, name = path.split(/[\\/]/).pop() ?? path): void {
  const format = writableFormat(name);
  if (!format) return;
  saveTargets.set(activeSessionId(), { kind: "path", path, format, name });
}

/** Binds the active tab to a File System Access handle (web file browser / pickers). */
export function bindSaveHandle(handle: FsFileHandle): void {
  const format = writableFormat(handle.name);
  if (!format) return;
  saveTargets.set(activeSessionId(), { kind: "handle", handle, format, name: handle.name });
}

async function writeTarget(target: SaveTarget, text: string): Promise<void> {
  if (target.kind === "handle") {
    const writable = await target.handle.createWritable();
    await writable.write(text);
    await writable.close();
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_drawing_file", { path: target.path, contents: text });
}

function noticeSaved(name: string): void {
  useApp.getState().setSaveNotice({ kind: "saved", message: `Saved ${name}`, at: Date.now() });
}

/**
 * - "save": overwrite the tab's bound file silently if there is one;
 *   otherwise behaves like "save-as" (nothing to overwrite yet).
 * - "save-as": always prompts for a location and becomes the tab's file for
 *   future plain saves.
 * - "save-copy": always prompts for a location but leaves the tab bound to
 *   whatever file it already had (a branch-off, not a switch).
 */
export type SaveMode = "save" | "save-as" | "save-copy";

/**
 * What the save dialog should be pre-filled with: the tab's own filename,
 * re-extensioned for the format being written, so saving an opened
 * `bracket.dxf` suggests `bracket.dxf` (or `bracket.svg`) rather than a
 * generic `drawing.dxf`. Falls back to `drawing.<fmt>` for a tab that has
 * never been named (an untouched "Untitled-1").
 */
function defaultSaveName(format: SaveFormat): string {
  const target = activeSaveTarget();
  const base = target?.name ?? getSessions().find((s) => s.id === activeSessionId() && s.named)?.name;
  if (!base) return `drawing.${format}`;
  return `${base.replace(/\.(dxf|svg|dwg)$/i, "")}.${format}`;
}

/** Saves the current drawing as DXF or SVG. No-op if the location prompt is cancelled. */
export async function saveDrawing(format: SaveFormat, suggestedName?: string, mode: SaveMode = "save"): Promise<void> {
  const text = serialize(format);
  const { mime, description } = SAVE_FORMAT[format];
  const w = window as WindowWithFS;
  const sessionId = activeSessionId();
  const name = suggestedName ?? defaultSaveName(format);

  if (mode === "save") {
    const target = saveTargets.get(sessionId);
    if (target && target.format === format) {
      try {
        await writeTarget(target, text);
        finishSessionSave(target.name);
        noticeSaved(target.name);
        return;
      } catch (err) {
        // Target went stale (file moved/deleted, permission revoked). Say so
        // rather than silently reopening the picker, which looks like the save
        // was simply ignored.
        useApp.getState().setSaveNotice({
          kind: "error",
          message: `Couldn't write ${target.name} — choose a location`,
          at: Date.now(),
        });
        void err;
      }
    }
  }

  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: name,
        types: [{ description, accept: { [mime]: [`.${format}`] } }],
      });
      await writeTarget({ kind: "handle", handle, format, name: handle.name }, text);
      if (mode !== "save-copy") {
        saveTargets.set(sessionId, { kind: "handle", handle, format, name: handle.name });
      }
      finishSessionSave(handle.name);
      noticeSaved(handle.name);
    } catch (err) {
      // The user dismissing the picker throws AbortError — treat as a no-op.
      if ((err as DOMException)?.name !== "AbortError") throw err;
    }
    return;
  }

  // Fallback (no File System Access API): trigger a browser download — there's
  // no real file handle to keep, so every save here prompts a download regardless of mode.
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  finishSessionSave(name);
  noticeSaved(name);
}

/** Plain "Save": overwrites the active tab's bound file in its own format, defaulting to DXF if it has none. */
export async function saveCurrent(): Promise<void> {
  const target = activeSaveTarget();
  await saveDrawing(target?.format ?? "dxf", undefined, "save");
}

/** "Save As": always prompts, pre-filled with the current file's name, and rebinds the tab to the result. */
export async function saveAs(format: SaveFormat = activeSaveTarget()?.format ?? "dxf"): Promise<void> {
  await saveDrawing(format, undefined, "save-as");
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
      // DWG has no export path (read-only), so bindSaveHandle ignores it and
      // Save falls through to a prompt.
      bindSaveHandle(handle);
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

/**
 * Overlays a DXF/SVG/DWG `File` onto the current drawing, on a new layer
 * named after the file — added geometry, not a replacement, so the tab's
 * own file binding and saved unit are untouched. Meant for comparing two
 * revisions of the same drawing: open the base one normally, then overlay
 * the other and toggle its layer to spot what changed.
 */
export async function overlayDrawingFile(name: string, file: File): Promise<{ count: number; warnings: string[]; layer: string }> {
  const label = name.replace(/\.(dxf|svg|dwg)$/i, "");
  if (/\.svg$/i.test(name)) {
    const text = await file.text();
    const { entities, warnings } = parseSvgText(text);
    useApp.getState().setFileWarnings(warnings);
    return { ...overlayEntities(entities, label), warnings };
  }
  if (/\.dwg$/i.test(name)) {
    const buffer = await file.arrayBuffer();
    const { entities, warnings } = await importDwgBuffer(buffer);
    useApp.getState().setFileWarnings(warnings);
    return { ...overlayEntities(entities, label), warnings };
  }
  const text = await file.text();
  return overlayDxfText(text, label);
}

/** Opens a file picker and overlays the chosen DXF/SVG/DWG onto the current drawing (see {@link overlayDrawingFile}). No-op if cancelled. */
export async function overlayDrawing(): Promise<{ count: number; warnings: string[]; layer: string } | null> {
  const w = window as WindowWithFS;

  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [handle] = await w.showOpenFilePicker({ multiple: false, types: OPEN_TYPES });
      if (!handle) return null;
      const file = await handle.getFile();
      return await overlayDrawingFile(handle.name, file);
    } catch (err) {
      if ((err as DOMException)?.name !== "AbortError") throw err;
      return null;
    }
  }

  // Fallback: a hidden file input.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".dxf,.svg,.dwg";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? await overlayDrawingFile(file.name, file) : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
