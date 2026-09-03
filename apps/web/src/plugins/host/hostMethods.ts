import { projectDocument, type Command, type UiShowOptions } from "@sketchor/core";
import { bus, doc, useApp } from "../../state/store";
import { hidePanel, postToPanel, showPanel, subscribeToPanel } from "./uiManager";

/**
 * The actual host-side implementations behind each RPC method. These run on the
 * main thread with real access to the document, command bus, and selection —
 * the only place plugin intents become state changes. Every entry here is
 * reached *after* {@link ../host/capabilityGuard.assertCapability} has passed.
 */

export interface HostContext {
  /** Manifest id — namespaces this plugin's storage. */
  readonly pluginId: string;
}

const COMMAND_TYPES = new Set<Command["type"]>([
  "add-entity",
  "delete-entities",
  "move-entities",
  "update-entity",
  "transform-entities",
  "group-entities",
  "ungroup",
  "add-constraint",
  "remove-constraint",
  "batch",
]);

/** Untrusted input from the sandbox — reject anything that isn't a known command. */
export function assertCommands(value: unknown): asserts value is Command[] {
  if (!Array.isArray(value)) throw new Error("commands must be an array");
  for (const c of value) {
    if (!c || typeof c !== "object" || !COMMAND_TYPES.has((c as { type?: Command["type"] }).type as Command["type"])) {
      throw new Error(`invalid command: ${JSON.stringify(c)}`);
    }
    if ((c as Command).type === "batch") assertCommands((c as { commands: unknown }).commands);
  }
}

/** Request/response methods. */
export async function dispatchCall(ctx: HostContext, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "document.read":
      return projectDocument(doc);

    case "document.apply": {
      const commands = args[0];
      assertCommands(commands);
      // Collapse the plugin's whole action into one undo step.
      if (commands.length > 0) {
        bus.execute({ type: "batch", commands });
        // A plugin can introduce a new layer (e.g. the load planner's "Load
        // Plan"); surface it in the layer panel like any first-party edit would.
        useApp.getState().syncLayersFromDoc();
      }
      return doc.revision;
    }

    case "selection.read":
      return useApp.getState().selection;

    case "storage.get":
      return readStorage(ctx.pluginId, String(args[0]));
    case "storage.set":
      writeStorage(ctx.pluginId, String(args[0]), args[1]);
      return undefined;
    case "storage.delete":
      localStorage.removeItem(storageKey(ctx.pluginId, String(args[0])));
      return undefined;
    case "storage.keys":
      return storageKeys(ctx.pluginId);

    case "network.fetch":
      return hostFetch(String(args[0]), args[1] as RequestInit | undefined);

    case "filesystem.readFile":
      return desktopReadFile(String(args[0]));
    case "filesystem.writeFile":
      return desktopWriteFile(String(args[0]), String(args[1]));

    case "ui.show":
      showPanel(ctx.pluginId, String(args[0] ?? ""), args[1] as UiShowOptions | undefined);
      return undefined;
    case "ui.hide":
      hidePanel(ctx.pluginId);
      return undefined;

    default:
      throw new Error(`Unhandled call method "${method}"`);
  }
}

/** Event-stream methods. Returns an unsubscribe function. */
export function dispatchSubscribe(
  ctx: HostContext,
  method: string,
  _args: unknown[],
  emit: (payload: unknown) => void,
): () => void {
  switch (method) {
    case "document.onChange":
      return bus.onChange(() => emit(projectDocument(doc)));

    case "selection.onChange":
      return useApp.subscribe((state, prev) => {
        if (state.selection !== prev.selection) emit(state.selection);
      });

    case "ui.onMessage":
      return subscribeToPanel(ctx.pluginId, (message) => emit(message));

    default:
      throw new Error(`Unhandled subscribe method "${method}"`);
  }
}

/** Fire-and-forget methods. */
export function dispatchPost(ctx: HostContext, method: string, args: unknown[]): void {
  switch (method) {
    case "ui.notify": {
      const message = String(args[0]);
      window.dispatchEvent(new CustomEvent("sketchor:plugin-notify", { detail: { message, options: args[1] } }));
      // eslint-disable-next-line no-console
      console.info(`[plugin] ${message}`);
      return;
    }
    case "ui.postMessage":
      postToPanel(ctx.pluginId, args[0]);
      return;
    default:
      throw new Error(`Unhandled post method "${method}"`);
  }
}

// --- storage (localStorage, namespaced per plugin) ---

function storageKey(pluginId: string, key: string): string {
  return `sketchor.plugin.${pluginId}.${key}`;
}

function readStorage(pluginId: string, key: string): unknown {
  const raw = localStorage.getItem(storageKey(pluginId, key));
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function writeStorage(pluginId: string, key: string, value: unknown): void {
  localStorage.setItem(storageKey(pluginId, key), JSON.stringify(value ?? null));
}

function storageKeys(pluginId: string): string[] {
  const prefix = storageKey(pluginId, "");
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}

// --- network ---

// --- filesystem (desktop only, via the existing Tauri commands) ---

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

async function desktopReadFile(path: string): Promise<string> {
  if (!isDesktop()) throw new Error("filesystem is only available in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("read_drawing_file", { path });
}

async function desktopWriteFile(path: string, contents: string): Promise<void> {
  if (!isDesktop()) throw new Error("filesystem is only available in the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("write_drawing_file", { path, contents });
}

async function hostFetch(url: string, init: RequestInit | undefined): Promise<{
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
}> {
  const res = await fetch(url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, ok: res.ok, headers, text: await res.text() };
}
