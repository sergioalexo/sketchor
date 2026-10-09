import { isPatternBundle, loadPatternBundle, parsePat, registerContributed, registerImported, removeContributed, removeImported, writePat, type PatternBundle, type PatternDef } from "@sketchor/core";

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

/** H-06: installed pattern packs (pattern-only plugin bundles), keyed by plugin id. */
const PACKS_KEY = "sketchor.patternPacks.v1";

function readPacks(): Record<string, PatternBundle> {
  try {
    const raw = JSON.parse(localStorage.getItem(PACKS_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, PatternBundle> = {};
    for (const [id, b] of Object.entries(raw)) if (isPatternBundle(b)) out[id] = b;
    return out;
  } catch {
    return {};
  }
}

function writePacks(packs: Record<string, PatternBundle>): void {
  try {
    localStorage.setItem(PACKS_KEY, JSON.stringify(packs));
  } catch {
    /* storage unavailable: the pack lasts for this session only */
  }
}

let loaded = false;
export function loadUserPatterns(): void {
  if (loaded) return;
  loaded = true;
  registerImported(parsePat(read()).patterns);
  for (const bundle of Object.values(readPacks())) {
    const r = loadPatternBundle(bundle);
    if (r.ok) registerContributed(r.patterns);
  }
}

export type InstallResult = { ok: true; id: string; names: string[]; warnings: string[] } | { ok: false; reason: string };

/** Installs a pattern-only plugin bundle from its JSON text ({manifest, patterns}); a re-install of the same plugin replaces it. */
export function installPatternPack(text: string): InstallResult {
  loadUserPatterns();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON." };
  }
  if (!isPatternBundle(parsed)) return { ok: false, reason: "That isn't a Sketchor pattern pack ({manifest, patterns})." };
  const r = loadPatternBundle(parsed);
  if (!r.ok) return { ok: false, reason: r.errors.join("; ") };
  const packs = readPacks();
  const prev = packs[r.manifest.id] ? loadPatternBundle(packs[r.manifest.id]) : null;
  if (prev && prev.ok) removeContributed(prev.patterns.map((p) => p.name));
  const names = registerContributed(r.patterns);
  packs[r.manifest.id] = parsed;
  writePacks(packs);
  return { ok: true, id: r.manifest.id, names, warnings: r.warnings };
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
