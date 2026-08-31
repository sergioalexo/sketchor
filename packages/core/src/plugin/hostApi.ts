import type { Command } from "../commands";
import type { EntityId } from "../entities";
import type { DocumentReadModel } from "./readModel";

/**
 * The Plugin Host API — the contract between a plugin (running in a sandbox)
 * and Sketchor. A plugin never touches this object directly: it lives on the
 * main thread; the `@sketchor/plugin-sdk` gives the plugin a typed proxy whose
 * calls are serialized across the RPC boundary. Every method here is therefore
 * async and traffics only in structured-cloneable data.
 *
 * Each sub-API is gated by a capability (see {@link ./capabilities}); calling
 * one the plugin wasn't granted rejects with a `CapabilityError`.
 *
 * This interface is **semver'd independently of the app** — see
 * {@link HOST_API_VERSION}. Additive changes are cheap; anything breaking is a
 * major bump, because installed third-party plugins can't be hot-patched.
 */
export interface PluginHostApi {
  /** The host API version this surface implements (see {@link HOST_API_VERSION}). */
  readonly apiVersion: string;
  readonly document: DocumentApi;
  readonly selection: SelectionApi;
  readonly storage: StorageApi;
  readonly network: NetworkApi;
  readonly ui: UiApi;
}

export interface DocumentApi {
  /** Requires `read-document`. A fresh snapshot of the current document. */
  read(): Promise<DocumentReadModel>;
  /**
   * Requires `write-document`. Applies commands as a **single undo step** — the
   * host wraps them in one `batch` — and resolves to the new document revision.
   * An empty array is a no-op.
   */
  apply(commands: Command[]): Promise<number>;
  /**
   * Requires `read-document`. Subscribes to document changes; the listener gets
   * a fresh read-model after each mutation. Returns an unsubscribe function.
   */
  onChange(listener: (model: DocumentReadModel) => void): Promise<Unsubscribe>;
}

export interface SelectionApi {
  /** Requires `read-document`. The currently selected entity ids. */
  read(): Promise<EntityId[]>;
  /** Requires `read-document`. Fires whenever the selection changes. */
  onChange(listener: (ids: EntityId[]) => void): Promise<Unsubscribe>;
}

/** A per-plugin namespaced key/value store. Requires `storage`. */
export interface StorageApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Host-mediated networking. Requires `network`. */
export interface NetworkApi {
  fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>;
}

export interface PluginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** Request body as text (binary bodies are out of scope for v1). */
  body?: string;
}

export interface PluginFetchResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
}

/**
 * The plugin's UI panel (a sandboxed iframe), mirroring Figma's
 * `showUI` ↔ `figma.ui.onmessage`. Available to any plugin that declares a
 * `ui` entry in its manifest; no separate permission.
 */
export interface UiApi {
  /** Mounts the plugin's UI panel. */
  show(options?: UiShowOptions): Promise<void>;
  /** Hides the panel without unloading the plugin. */
  hide(): Promise<void>;
  /** Posts a message to the panel iframe. */
  postMessage(message: unknown): void;
  /** Receives messages the panel posts back. Returns an unsubscribe function. */
  onMessage(listener: (message: unknown) => void): Promise<Unsubscribe>;
  /** Shows a transient host notification (toast). */
  notify(message: string, options?: NotifyOptions): void;
}

export interface UiShowOptions {
  title?: string;
  width?: number;
  height?: number;
}

export interface NotifyOptions {
  /** Milliseconds before auto-dismiss. */
  timeout?: number;
  /** Styles the toast as an error. */
  error?: boolean;
}

export type Unsubscribe = () => void;

/**
 * The host API contract version. Independent of the app version. A plugin's
 * `engines.sketchor` is a semver range checked against this at load time; an
 * incompatible plugin is refused rather than failing at runtime.
 */
export const HOST_API_VERSION = "0.1.0";
