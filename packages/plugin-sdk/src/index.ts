/**
 * `@sketchor/plugin-sdk` — the library a Sketchor plugin imports. It provides
 * the typed host-API proxy, entity/command builders, and the plugin entry
 * contract. It carries no sandbox or transport implementation of its own — the
 * host injects the {@link RpcTransport} at load time (Phase 1).
 *
 * The SDK version tracks the host API version (`HOST_API_VERSION`), so building
 * against a given SDK is building against a known host contract.
 *
 * A plugin's `main` module is expected to satisfy {@link PluginModule}:
 *
 * ```ts
 * import { add, circle, type PluginModule } from "@sketchor/plugin-sdk";
 *
 * const plugin: PluginModule = {
 *   async activate(sketchor) {
 *     const sel = await sketchor.selection.read();
 *     await sketchor.document.apply([add(circle({ x: 0, y: 0 }, 10))]);
 *   },
 * };
 * export default plugin;
 * ```
 */

export { createClient } from "./client";
export type { RpcTransport } from "./transport";
export * from "./builders";

// Re-export the contract types authors need, so a plugin depends only on the SDK.
export type {
  PluginHostApi,
  DocumentApi,
  SelectionApi,
  StorageApi,
  NetworkApi,
  UiApi,
  DocumentReadModel,
  PluginManifest,
  PluginContributions,
  Permission,
  PluginFetchInit,
  PluginFetchResponse,
  UiShowOptions,
  NotifyOptions,
  Unsubscribe,
  Command,
  Entity,
  EntityId,
  LineEntity,
  CircleEntity,
  ArcEntity,
  PointEntity,
  PolylineEntity,
  Point,
} from "@sketchor/core";

export { HOST_API_VERSION, PERMISSIONS } from "@sketchor/core";

import type { PluginHostApi } from "@sketchor/core";

/**
 * The shape a plugin's `main` module exports (as its default export). The host
 * calls `activate` once, passing the client proxy, after the sandbox loads; it
 * calls `deactivate` (if present) on unload/uninstall.
 */
export interface PluginModule {
  activate(sketchor: PluginHostApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
