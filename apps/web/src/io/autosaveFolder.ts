/**
 * The folder a printed sheet is also saved into, remembered between
 * sessions.
 *
 * Printing a load plan usually means two things at once: send it to the
 * printer, and keep a copy where the office keeps them. Asking for the
 * folder on every print would defeat that, so the chosen directory is kept
 * as a `FileSystemDirectoryHandle` in IndexedDB — a handle survives a
 * reload where a path string wouldn't, because the browser stores the
 * grant with it.
 *
 * Two things the File System Access API makes non-obvious and this module
 * has to respect:
 *
 * - **Permission is not permanent.** A restored handle comes back in the
 *   `prompt` state, and `requestPermission` only works inside a user
 *   gesture. So the write has to happen on the click that started the
 *   print, not in a timer or after an await of something slow.
 * - **A handle can outlive its folder.** Renamed, unplugged, or on a
 *   network share that's gone: every call here fails soft and says what
 *   happened, rather than throwing into the middle of printing.
 */

const DB_NAME = "sketchor-autosave";
const STORE = "folders";
const LABEL_KEY = "sketchor.autosave.label";
const ENABLED_KEY = "sketchor.autosave.enabled";

type DirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
};

/** True when this browser can pick a folder at all (Chromium; not Firefox/Safari). */
export function supportsAutosave(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function get<T>(key: string): Promise<T | null> {
  const db = await openDb();
  const value = await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

/** The remembered folder's display name, or null — readable without touching IndexedDB, for first paint. */
export function autosaveFolderLabel(): string | null {
  try {
    return localStorage.getItem(LABEL_KEY);
  } catch {
    return null;
  }
}

/** Whether a copy should be saved on print. Off until the user turns it on. */
export function autosaveEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutosaveEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/** Asks for a folder and remembers it. Returns its name, or null if the user cancelled. */
export async function pickAutosaveFolder(): Promise<string | null> {
  if (!supportsAutosave()) return null;
  try {
    const dir = await (window as unknown as { showDirectoryPicker: (o?: { mode?: string }) => Promise<DirectoryHandle> }).showDirectoryPicker({
      mode: "readwrite",
    });
    await put("printFolder", dir);
    try {
      localStorage.setItem(LABEL_KEY, dir.name);
    } catch {
      /* storage unavailable */
    }
    return dir.name;
  } catch {
    return null; // cancelled, or the picker is unavailable in this context
  }
}

/** Forgets the folder (the next print asks again). */
export async function forgetAutosaveFolder(): Promise<void> {
  await put("printFolder", null);
  try {
    localStorage.removeItem(LABEL_KEY);
  } catch {
    /* storage unavailable */
  }
}

export type SaveOutcome =
  | { ok: true; folder: string; file: string }
  | { ok: false; reason: "no-folder" | "denied" | "failed"; message: string };

/** Turns a load name into something a file system will accept, without losing the sense of it. */
export function safeFileName(name: string, extension = "html"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, " ") // characters Windows refuses outright
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${cleaned || "Sketchor print"}.${extension}`;
}

/**
 * Writes `data` (sheet text, or PDF bytes) into the remembered folder. Must be
 * called from within a user gesture: a restored handle needs
 * `requestPermission`, and browsers only grant that to a real click.
 */
export async function saveToAutosaveFolder(fileName: string, data: string | Uint8Array): Promise<SaveOutcome> {
  const dir = await get<DirectoryHandle>("printFolder");
  if (!dir) return { ok: false, reason: "no-folder", message: "No folder chosen yet" };

  try {
    const mode = { mode: "readwrite" as const };
    let state: PermissionState = (await dir.queryPermission?.(mode)) ?? "granted";
    if (state === "prompt") state = (await dir.requestPermission?.(mode)) ?? "denied";
    if (state !== "granted") {
      return { ok: false, reason: "denied", message: `Access to “${dir.name}” was declined` };
    }
    const file = await dir.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    // A Uint8Array from the plugin sandbox arrives structured-cloned; write
    // it through a fresh copy so a detached or subclassed buffer can't
    // surprise the writer.
    await writable.write(typeof data === "string" ? data : new Uint8Array(data));
    await writable.close();
    return { ok: true, folder: dir.name, file: fileName };
  } catch (err) {
    // A folder that has been renamed, unmounted or revoked lands here.
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : "Could not write the file" };
  }
}

/** The whole document, as a standalone file that opens and prints the same way later. */
export function standalonePrintDocument(bodyHtml: string, title: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string)}</title>
    <style>
      body { margin: 24px; background: #fff; color: #111; font: 13px system-ui, -apple-system, sans-serif; }
      @page { margin: 12mm; }
    </style>
  </head>
  <body>${bodyHtml}</body>
</html>`;
}
