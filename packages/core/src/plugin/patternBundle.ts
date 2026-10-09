/**
 * H-06: a pattern-only plugin bundle — manifest plus the `.pat` files it names,
 * no code. Like a theme bundle it is data (the `.pat` parser only admits
 * numbers and a name), so the host reads, validates and registers it directly
 * and needs no signature.
 */
import type { PatternDef } from "../hatch/pat";
import { parsePat } from "../hatch/pat";
import { isPatternOnly, validateManifest, type PluginManifest } from "./manifest";

export interface PatternBundle {
  /** Raw `manifest.json` text. */
  manifest: string;
  /** `.pat` file text keyed by the bundle-relative path the manifest names. */
  patterns: Record<string, string>;
}

export type PatternBundleResult =
  | { ok: true; manifest: PluginManifest; patterns: PatternDef[]; warnings: string[] }
  | { ok: false; errors: string[] };

const MAX_PAT_BYTES = 512 * 1024;
const MAX_FILES = 32;
const MAX_PATTERNS = 500;

export function isPatternBundle(v: unknown): v is PatternBundle {
  const b = v as Partial<PatternBundle> | null;
  return !!b && typeof b === "object" && typeof b.manifest === "string" && typeof b.patterns === "object" && b.patterns !== null && !("code" in b);
}

/** Validates a pattern-only bundle end to end; every pattern comes back with its category set (the contribution's, else the plugin name). */
export function loadPatternBundle(bundle: PatternBundle): PatternBundleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundle.manifest);
  } catch {
    return { ok: false, errors: ["manifest.json is not valid JSON"] };
  }
  const v = validateManifest(parsed);
  if (!v.ok) return { ok: false, errors: v.errors };
  const manifest = v.manifest;
  if (!isPatternOnly(manifest)) return { ok: false, errors: ["this bundle contains code or permissions - only signed plugin bundles may do that"] };
  const entries = manifest.contributes!.hatchPatterns!;
  if (entries.length > MAX_FILES) return { ok: false, errors: [`a plugin may contribute at most ${MAX_FILES} pattern files`] };

  const errors: string[] = [];
  const warnings: string[] = [];
  const patterns: PatternDef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const text = Object.prototype.hasOwnProperty.call(bundle.patterns, entry.file) ? bundle.patterns[entry.file] : undefined;
    if (typeof text !== "string") {
      errors.push(`${entry.file}: listed in the manifest but missing from the bundle`);
      continue;
    }
    if (text.length > MAX_PAT_BYTES) {
      errors.push(`${entry.file}: larger than ${MAX_PAT_BYTES / 1024} KB`);
      continue;
    }
    const r = parsePat(text);
    for (const i of r.issues) warnings.push(`${entry.file}:${i.line} ${i.message}`);
    if (r.patterns.length === 0) {
      errors.push(`${entry.file}: no pattern found`);
      continue;
    }
    for (const p of r.patterns) {
      const key = p.name.toUpperCase();
      if (seen.has(key)) {
        warnings.push(`${entry.file}: ${p.name} is defined twice, the first one is kept`);
        continue;
      }
      seen.add(key);
      patterns.push({ ...p, category: entry.category?.trim() || manifest.name });
    }
  }
  if (patterns.length > MAX_PATTERNS) errors.push(`a plugin may contribute at most ${MAX_PATTERNS} patterns`);
  return errors.length ? { ok: false, errors } : { ok: true, manifest, patterns, warnings };
}
