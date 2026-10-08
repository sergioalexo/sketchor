import type { LibraryEntry } from "@sketchor/core";

/** The user's block library (favourites): kept in local storage, shared by every drawing. Every access is guarded — storage may be absent or full. */
const KEY = "sketchor.blockLibrary.v1";

export function loadLibrary(): LibraryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is LibraryEntry => !!e && typeof e === "object" && typeof (e as LibraryEntry).def?.name === "string" && Array.isArray((e as LibraryEntry).def.entities));
  } catch {
    return [];
  }
}

/** Returns false when the browser refused the write (quota). */
export function saveLibrary(entries: LibraryEntry[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

/** Adds (or replaces, by block name) one entry. */
export function addToLibrary(entry: LibraryEntry): boolean {
  const rest = loadLibrary().filter((e) => e.def.name !== entry.def.name);
  return saveLibrary([...rest, entry]);
}

export function removeFromLibrary(name: string): void {
  saveLibrary(loadLibrary().filter((e) => e.def.name !== name));
}
