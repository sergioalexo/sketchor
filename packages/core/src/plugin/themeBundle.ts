/**
 * TH-02: a theme-only plugin bundle — manifest plus the theme JSON files it
 * names, and no code. Unlike a {@link SignedBundle} it carries no signature:
 * it can't run anything, and `validateTheme` admits only colours and
 * whitelisted fonts, so the host reads, validates and applies it directly and
 * labels it "unsigned theme" in the UI.
 */
import { resolveTheme, validateTheme, type ThemeFile } from "../themeFile";
import type { ThemeTokens } from "../theme";
import { isThemeOnly, validateManifest, type PluginManifest } from "./manifest";

export interface ThemeBundle {
  /** Raw `manifest.json` text. */
  manifest: string;
  /** Theme file text keyed by the bundle-relative path the manifest names. */
  themes: Record<string, string>;
}

export interface LoadedTheme {
  /** `<pluginId>/<themeId>`, unique across plugins. */
  key: string;
  pluginId: string;
  id: string;
  title: string;
  file: ThemeFile;
  tokens: ThemeTokens;
}

export type ThemeBundleResult =
  | { ok: true; manifest: PluginManifest; themes: LoadedTheme[] }
  | { ok: false; errors: string[] };

const MAX_THEME_BYTES = 64 * 1024;
const MAX_THEMES = 32;

export function isThemeBundle(v: unknown): v is ThemeBundle {
  const b = v as Partial<ThemeBundle> | null;
  return !!b && typeof b === "object" && typeof b.manifest === "string" && typeof b.themes === "object" && b.themes !== null && !("code" in b);
}

/** Validates a theme-only bundle end to end; collects every problem rather than stopping at the first. */
export function loadThemeBundle(bundle: ThemeBundle): ThemeBundleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundle.manifest);
  } catch {
    return { ok: false, errors: ["manifest.json is not valid JSON"] };
  }
  const v = validateManifest(parsed);
  if (!v.ok) return { ok: false, errors: v.errors };
  const manifest = v.manifest;
  if (!isThemeOnly(manifest)) {
    return { ok: false, errors: ["this bundle contains code or permissions — only signed plugin bundles may do that"] };
  }
  const entries = manifest.contributes!.themes!;
  if (entries.length > MAX_THEMES) return { ok: false, errors: [`a plugin may contribute at most ${MAX_THEMES} themes`] };

  const errors: string[] = [];
  const themes: LoadedTheme[] = [];
  for (const entry of entries) {
    const text = Object.prototype.hasOwnProperty.call(bundle.themes, entry.file) ? bundle.themes[entry.file] : undefined;
    if (typeof text !== "string") {
      errors.push(`${entry.file}: listed in the manifest but missing from the bundle`);
      continue;
    }
    if (text.length > MAX_THEME_BYTES) {
      errors.push(`${entry.file}: larger than ${MAX_THEME_BYTES / 1024} KB`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      errors.push(`${entry.file}: not valid JSON`);
      continue;
    }
    const r = validateTheme(json);
    if (!r.ok) {
      for (const i of r.issues) errors.push(`${entry.file}: ${i.path ? i.path + " " : ""}${i.message}`);
      continue;
    }
    themes.push({
      key: `${manifest.id}/${entry.id}`,
      pluginId: manifest.id,
      id: entry.id,
      title: entry.title,
      file: r.theme,
      tokens: resolveTheme(r.theme),
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, manifest, themes };
}
