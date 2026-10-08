import { parsePat, registerImported, removeImported, writePat, type PatternDef } from "@sketchor/core";

/**
 * The user's imported / edited hatch patterns, kept as `.pat` text in
 * localStorage (H-06) and registered at startup. A pattern a drawing uses is
 * additionally stored in that drawing's `hatchPatterns` table by the hatch tool.
 */

const KEY = "sketchor.hatchPatterns.v1";

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function write(text: string): void {
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* storage unavailable: the patterns last for this session only */
  }
}

let loaded = false;
export function loadUserPatterns(): void {
  if (loaded) return;
  loaded = true;
  registerImported(parsePat(read()).patterns);
}

/** Adds or replaces user patterns and persists them. Returns the registered names. */
export function saveUserPatterns(defs: readonly PatternDef[]): string[] {
  loadUserPatterns();
  const names = registerImported(defs);
  const kept = new Map(parsePat(read()).patterns.map((p) => [p.name.toUpperCase(), p]));
  for (const d of defs) if (names.includes(d.name)) kept.set(d.name.toUpperCase(), d);
  write(writePat([...kept.values()]));
  return names;
}

export function deleteUserPattern(name: string): void {
  removeImported(name);
  write(writePat(parsePat(read()).patterns.filter((p) => p.name.toUpperCase() !== name.toUpperCase())));
}
