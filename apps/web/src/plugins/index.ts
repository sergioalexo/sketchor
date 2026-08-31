import { PERMISSIONS, type GrantedCapabilities, type Permission } from "@sketchor/core";
import { PluginHost } from "./host/PluginHost";

/**
 * Phase 1 plugin runtime entry. A minimal manager over running {@link PluginHost}
 * instances plus a dev handle for the acceptance test. Phase 2 grows this into
 * the manifest-driven loader that registers contributions.
 */

const running = new Map<string, PluginHost>();

export async function runBuiltinPlugin(
  pluginId: string,
  builtinId: string,
  permissions: Permission[],
): Promise<void> {
  stopPlugin(pluginId);
  const granted: GrantedCapabilities = new Set(permissions);
  const host = new PluginHost({ pluginId, builtinId, granted });
  running.set(pluginId, host);
  await host.load();
}

export function stopPlugin(pluginId: string): void {
  running.get(pluginId)?.dispose();
  running.delete(pluginId);
}

const TEST_ID = "com.sketchor.test";

/**
 * Exposes `window.sketchorPlugins` so the sandbox → RPC → capability → CommandBus
 * path can be exercised from the console (Phase 1 has no plugin UI yet):
 *
 *   await sketchorPlugins.run()                 // grants read+write; draws a line
 *   await sketchorPlugins.run(["read-document"]) // no write → apply() rejects
 *   sketchorPlugins.stop()
 */
export function installPluginDevHandle(): void {
  const handle = {
    run: (permissions: Permission[] = ["read-document", "write-document"]) =>
      runBuiltinPlugin(TEST_ID, TEST_ID, permissions),
    stop: () => stopPlugin(TEST_ID),
    PERMISSIONS,
  };
  (window as unknown as { sketchorPlugins: typeof handle }).sketchorPlugins = handle;
}
