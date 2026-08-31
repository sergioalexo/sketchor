import {
  HOST_API_VERSION,
  PERMISSIONS,
  patternCommands,
  type GrantedCapabilities,
  type Permission,
  type PatternSpec,
  type PluginManifest,
} from "@sketchor/core";
import { doc, useApp } from "../state/store";
import { PluginHost } from "./host/PluginHost";
import { previewGenerator, registerContributions, runGenerator, unregisterContributions } from "./host/registries";
import { removePluginUi } from "./host/uiManager";
import { BUILTIN_MANIFESTS } from "./builtins/manifests";

/**
 * Phase 2 plugin runtime entry. Loads plugins from their {@link PluginManifest},
 * registers what they contribute into the host registries (see
 * {@link ./host/registries}), and boots the first-party plugins so their
 * contributions are reachable from the UI (command palette + save/export menu).
 *
 * A manifest's `engines.sketchor` is checked against the host API version before
 * the worker starts — an incompatible plugin is refused at load, never at
 * runtime (see `docs/plugin-v1-plan.md`, "Cross-cutting: API versioning").
 */

const running = new Map<string, PluginHost>();

/** Loads a plugin by manifest, granting the given permissions, and registers its contributions. */
export async function loadPlugin(
  manifest: PluginManifest,
  builtinId: string,
  permissions: Permission[] = manifest.permissions ?? [],
): Promise<void> {
  const engine = manifest.engines?.sketchor ?? "";
  if (!satisfiesEngine(engine, HOST_API_VERSION)) {
    throw new Error(
      `Plugin "${manifest.id}" needs Sketchor plugin API ${engine}, but this host provides ${HOST_API_VERSION}`,
    );
  }

  stopPlugin(manifest.id);
  const granted: GrantedCapabilities = new Set(permissions);
  const host = new PluginHost({ pluginId: manifest.id, builtinId, granted });
  running.set(manifest.id, host);
  await host.load();
  registerContributions(host, manifest);
}

export function stopPlugin(pluginId: string): void {
  running.get(pluginId)?.dispose();
  running.delete(pluginId);
  unregisterContributions(pluginId);
  removePluginUi(pluginId);
}

/** Boots the in-repo first-party plugins. Called once at app start. */
export async function loadFirstPartyPlugins(): Promise<void> {
  await Promise.all(
    BUILTIN_MANIFESTS.map((m) =>
      loadPlugin(m, m.id).catch((err) => console.error(`[plugins] failed to load ${m.id}:`, err)),
    ),
  );
}

// --- engine compatibility (minimal; Phase 4 generalizes to full semver ranges) ---

/** Supports the `^x.y.z` caret ranges the first-party manifests use. */
function satisfiesEngine(range: string, version: string): boolean {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m || !v) return false;
  const [, rMaj, rMin, rPat] = m.map(Number);
  const [, vMaj, vMin, vPat] = v.map(Number);
  if (vMaj !== rMaj) return false;
  // Caret on a 0.x range pins the minor; otherwise any minor >= is compatible.
  if (rMaj === 0) return vMin === rMin && vPat >= rPat;
  return vMin > rMin || (vMin === rMin && vPat >= rPat);
}

// --- dev handle & Phase 2 acceptance ---

const TEST_ID = "com.sketchor.test";

/**
 * Exposes `window.sketchorPlugins` for console-driven acceptance:
 *
 *   await sketchorPlugins.run()                  // Phase 1: draws a line, undoes in one step
 *   await sketchorPlugins.run(["read-document"]) // no write → apply() rejects
 *   sketchorPlugins.stop()
 *
 *   // Phase 2: the pattern plugin (loaded, not built-in) matches core geometry.
 *   sketchorPlugins.testPattern({ kind: "rectangular", columns: 3, rows: 2, columnSpacing: 40, rowSpacing: 30 })
 */
export function installPluginDevHandle(): void {
  const handle = {
    run: (permissions: Permission[] = ["read-document", "write-document"]) => {
      const testManifest: PluginManifest = {
        id: TEST_ID,
        version: "1.0.0",
        name: "Test",
        engines: { sketchor: `^${HOST_API_VERSION}` },
        main: "testPlugin.ts",
      };
      return loadPlugin(testManifest, TEST_ID, permissions);
    },
    stop: () => stopPlugin(TEST_ID),
    /**
     * Phase 2 acceptance: compares the pattern *plugin* generator's output —
     * produced in the worker, over the public API — against the built-in
     * `patternCommands` geometry, then applies it so it shows on the canvas.
     */
    testPattern: async (spec: PatternSpec) => {
      const selection = useApp.getState().selection;
      const expected = stripIds(patternCommands(doc, selection, spec));
      const pluginOutput = stripIds(await previewGenerator("pattern.array", spec));
      const match = JSON.stringify(expected) === JSON.stringify(pluginOutput);
      const added = await runGenerator("pattern.array", spec);
      console.info(
        `[plugins] pattern plugin added ${added} entities; geometry matches core patternCommands: ${match}`,
      );
      return { added, match };
    },
    PERMISSIONS,
  };
  (window as unknown as { sketchorPlugins: typeof handle }).sketchorPlugins = handle;
}

/** Drops entity ids so two runs are comparable by geometry alone (ids are freshly minted each time). */
function stripIds(commands: unknown[]): unknown {
  return JSON.parse(JSON.stringify(commands), (key, value) => (key === "id" ? undefined : value));
}
