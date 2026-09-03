import type {
  CommandHandler,
  ExporterHandler,
  GeneratorHandler,
  ImporterHandler,
  PluginHostApi,
} from "@sketchor/core";

/**
 * The plugin-side table of contribution handlers a plugin registers during
 * `activate`. Handlers are functions — they can't cross the RPC boundary — so
 * they live here in the sandbox, keyed by contribution id, and the host invokes
 * them by messaging in. Each host-API client owns one store (see
 * {@link contributionStore}); the worker bootstrap reads it to dispatch invokes.
 */
export interface ContributionStore {
  readonly commands: Map<string, CommandHandler>;
  readonly generators: Map<string, GeneratorHandler>;
  readonly exporters: Map<string, ExporterHandler>;
  readonly importers: Map<string, ImporterHandler>;
}

const stores = new WeakMap<PluginHostApi, ContributionStore>();

/** The (get-or-create) contribution store bound to a given host-API client. */
export function contributionStore(api: PluginHostApi): ContributionStore {
  let store = stores.get(api);
  if (!store) {
    store = { commands: new Map(), generators: new Map(), exporters: new Map(), importers: new Map() };
    stores.set(api, store);
  }
  return store;
}

/** The contribution kinds the host can invoke, matching the fields of a {@link ContributionStore}. */
export type ContributionKind = "command" | "generator" | "exporter" | "importer";
