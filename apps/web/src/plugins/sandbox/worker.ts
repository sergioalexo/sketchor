/// <reference lib="webworker" />
import { createClient, type PluginModule } from "@sketchor/plugin-sdk";
import type { HostToWorker, WorkerToHost } from "../rpc/protocol";
import { serializeError } from "../rpc/protocol";
import { WorkerTransport } from "../rpc/workerTransport";

/**
 * The plugin sandbox entry. Runs in a Web Worker: no DOM, no `window.sketchor`,
 * no access to the host beyond the RPC transport. On `init` it loads the plugin
 * module, hands it a host-API client, and calls `activate`.
 *
 * Phase 1 loads only in-repo *builtin* plugins by id (Vite can statically
 * analyze these dynamic imports). Loading third-party bundles from a URL/blob
 * is the install flow in Phase 4.
 */
const BUILTINS: Record<string, () => Promise<{ default: PluginModule }>> = {
  "com.sketchor.test": () => import("../builtins/testPlugin"),
};

const transport = new WorkerTransport();
const client = createClient(transport);
let active: PluginModule | null = null;

function send(msg: WorkerToHost): void {
  (self as unknown as Worker).postMessage(msg);
}

self.addEventListener("message", async (e: MessageEvent) => {
  const msg = e.data as HostToWorker;
  if (msg.kind === "init") {
    const loader = BUILTINS[msg.builtinId];
    if (!loader) {
      send({ kind: "activated", ok: false, error: { message: `Unknown builtin plugin "${msg.builtinId}"` } });
      return;
    }
    try {
      active = (await loader()).default;
      await active.activate(client);
      send({ kind: "activated", ok: true });
    } catch (err) {
      send({ kind: "activated", ok: false, error: serializeError(err) });
    }
    return;
  }
  if (msg.kind === "deactivate") {
    try {
      await active?.deactivate?.();
    } finally {
      active = null;
      self.close();
    }
  }
});

send({ kind: "ready" });
