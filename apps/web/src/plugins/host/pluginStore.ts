import type { Permission, PluginManifest, SignedBundle } from "@sketchor/core";

/**
 * Persistence for **installed third-party plugins** — the local install store
 * behind the marketplace. First-party builtins ship inside the app and aren't
 * stored here; this holds what the user has installed from a file or the
 * registry: the verified bundle, the permissions they granted, and the signer
 * key they trusted. Backed by `localStorage` in the browser (a picked folder /
 * Tauri FS on desktop is a later refinement); every read tolerates absent or
 * corrupt storage and returns an empty set rather than throwing.
 */

/** Where an installed plugin came from (first-party builtins aren't stored here). */
export type InstallOrigin = "file" | "registry";

export interface InstalledPlugin {
  manifest: PluginManifest;
  bundle: SignedBundle;
  /** The subset of requested permissions the user granted (revocable). */
  granted: Permission[];
  /** The signer public key the user trusted at install (equals `bundle.publicKey`). */
  trustedKey: string;
  /** How it was installed — shown in the plugins panel. Optional for records predating this field. */
  origin?: InstallOrigin;
  installedAt: number;
}

const KEY = "sketchor.plugins.installed";

const listeners = new Set<() => void>();
export function onInstalledChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(): void {
  for (const l of listeners) l();
}

export function listInstalled(): InstalledPlugin[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InstalledPlugin[]) : [];
  } catch {
    return [];
  }
}

export function getInstalled(id: string): InstalledPlugin | undefined {
  return listInstalled().find((p) => p.manifest.id === id);
}

function writeAll(plugins: InstalledPlugin[]): void {
  localStorage.setItem(KEY, JSON.stringify(plugins));
  emit();
}

/** Adds or replaces an installed plugin (an update reuses the same id). */
export function saveInstalled(plugin: InstalledPlugin): void {
  const next = listInstalled().filter((p) => p.manifest.id !== plugin.manifest.id);
  next.push(plugin);
  writeAll(next);
}

export function removeInstalled(id: string): void {
  writeAll(listInstalled().filter((p) => p.manifest.id !== id));
}

/** Revokes/regrants permissions for an installed plugin. */
export function setGranted(id: string, granted: Permission[]): void {
  const next = listInstalled().map((p) => (p.manifest.id === id ? { ...p, granted } : p));
  writeAll(next);
}

/** Whether the user has previously trusted this signer key on any installed plugin. */
export function isKeyTrusted(publicKey: string): boolean {
  return listInstalled().some((p) => p.trustedKey === publicKey);
}
