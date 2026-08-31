import { HOST_API_VERSION } from "@sketchor/core";
import type {
  Command,
  DocumentReadModel,
  EntityId,
  NotifyOptions,
  PluginFetchInit,
  PluginFetchResponse,
  PluginHostApi,
  UiShowOptions,
  Unsubscribe,
} from "@sketchor/core";
import type { RpcTransport } from "./transport";

/**
 * Builds the typed {@link PluginHostApi} a plugin uses, backed by an
 * {@link RpcTransport}. Each method is a thin serializer: it forwards the call
 * over the transport and returns the (already structured-cloned) result. The
 * transport itself — the actual worker/iframe message channel — is supplied by
 * the host in Phase 1; here it's an injected dependency so the SDK is testable
 * against a fake.
 */
export function createClient(transport: RpcTransport): PluginHostApi {
  return {
    apiVersion: HOST_API_VERSION,

    document: {
      read: () => transport.call("document.read", []) as Promise<DocumentReadModel>,
      apply: (commands: Command[]) => transport.call("document.apply", [commands]) as Promise<number>,
      onChange: (listener: (model: DocumentReadModel) => void): Promise<Unsubscribe> =>
        transport.subscribe("document.onChange", [], (p) => listener(p as DocumentReadModel)),
    },

    selection: {
      read: () => transport.call("selection.read", []) as Promise<EntityId[]>,
      onChange: (listener: (ids: EntityId[]) => void): Promise<Unsubscribe> =>
        transport.subscribe("selection.onChange", [], (p) => listener(p as EntityId[])),
    },

    storage: {
      get: (key: string) => transport.call("storage.get", [key]),
      set: (key: string, value: unknown) => transport.call("storage.set", [key, value]) as Promise<void>,
      delete: (key: string) => transport.call("storage.delete", [key]) as Promise<void>,
      keys: () => transport.call("storage.keys", []) as Promise<string[]>,
    },

    network: {
      fetch: (url: string, init?: PluginFetchInit) =>
        transport.call("network.fetch", [url, init]) as Promise<PluginFetchResponse>,
    },

    ui: {
      show: (options?: UiShowOptions) => transport.call("ui.show", [options]) as Promise<void>,
      hide: () => transport.call("ui.hide", []) as Promise<void>,
      postMessage: (message: unknown) => transport.post("ui.postMessage", [message]),
      onMessage: (listener: (message: unknown) => void): Promise<Unsubscribe> =>
        transport.subscribe("ui.onMessage", [], (p) => listener(p)),
      notify: (message: string, options?: NotifyOptions) => transport.post("ui.notify", [message, options]),
    },
  };
}
