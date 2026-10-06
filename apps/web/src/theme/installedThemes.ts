import { isThemeBundle, loadThemeBundle, type LoadedTheme, type ThemeBundle } from "@sketchor/core";

/**
 * TH-02: theme-only plugin bundles installed by the user. They hold no code
 * and are not signed — `loadThemeBundle` (core) is the gate — so they live
 * apart from `plugins/host/pluginStore.ts`'s signed-plugin records and never
 * reach the worker host. The raw bundle is stored and re-validated on every
 * load, so a corrupted or hand-edited store entry can't smuggle in a value
 * the validator would have refused.
 */

const KEY = "sketchor.themes.installed.v1";

const listeners = new Set<() => void>();
export const onThemesChange = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function readBundles(): ThemeBundle[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isThemeBundle) : [];
  } catch {
    return [];
  }
}

function writeBundles(bundles: ThemeBundle[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(bundles));
  } catch {
    /* storage unavailable: the install lasts until reload */
  }
  for (const l of listeners) l();
}

const pluginIdOf = (b: ThemeBundle): string | null => {
  const r = loadThemeBundle(b);
  return r.ok ? r.manifest.id : null;
};

/** Every installed theme that still validates, in install order. */
export function listInstalledThemes(): LoadedTheme[] {
  return readBundles().flatMap((b) => {
    const r = loadThemeBundle(b);
    return r.ok ? r.themes : [];
  });
}

export function getInstalledTheme(key: string): LoadedTheme | undefined {
  return listInstalledThemes().find((t) => t.key === key);
}

export type ThemeInstallResult = { ok: true; pluginId: string; themes: LoadedTheme[] } | { ok: false; reason: string };

/** Validates and stores an unsigned theme bundle (replacing an earlier version of the same plugin). */
export function installThemeBundle(bundle: unknown): ThemeInstallResult {
  if (!isThemeBundle(bundle)) return { ok: false, reason: "That isn't a theme bundle." };
  const r = loadThemeBundle(bundle);
  if (!r.ok) return { ok: false, reason: r.errors.join("; ") };
  const others = readBundles().filter((b) => pluginIdOf(b) !== r.manifest.id);
  writeBundles([...others, { manifest: bundle.manifest, themes: bundle.themes }]);
  return { ok: true, pluginId: r.manifest.id, themes: r.themes };
}

export function uninstallThemePlugin(pluginId: string): void {
  writeBundles(readBundles().filter((b) => pluginIdOf(b) !== pluginId));
}
