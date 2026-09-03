/**
 * The message protocol spoken across the sandbox boundary: plugin worker ⇄
 * host (main thread). Every payload is structured-cloneable — no functions, no
 * live references — so it survives `postMessage`.
 *
 * Four interaction shapes:
 *   - call/result   — request/response, worker → host (e.g. document.apply)
 *   - subscribe/event/unsubscribe — a host event stream (e.g. document.onChange)
 *   - post          — fire-and-forget, no reply (e.g. ui.notify)
 *   - invoke/invoke-result — request/response, host → worker: the host runs one
 *     of the plugin's registered contribution handlers (command/generator/IO).
 */
import type { ContributionKind } from "@sketchor/plugin-sdk";

export type WorkerToHost =
  | { kind: "ready" }
  | { kind: "call"; id: number; method: string; args: unknown[] }
  | { kind: "subscribe"; id: number; subId: number; method: string; args: unknown[] }
  | { kind: "unsubscribe"; subId: number }
  | { kind: "post"; method: string; args: unknown[] }
  | { kind: "activated"; ok: boolean; error?: SerializedError }
  | { kind: "invoke-result"; id: number; ok: true; value: unknown }
  | { kind: "invoke-result"; id: number; ok: false; error: SerializedError };

export type HostToWorker =
  // Exactly one of `builtinId` (in-repo first-party) or `source` (an installed
  // third-party bundle's verified JS) identifies what the worker loads.
  | { kind: "init"; pluginId: string; builtinId?: string; source?: string }
  | { kind: "result"; id: number; ok: true; value: unknown }
  | { kind: "result"; id: number; ok: false; error: SerializedError }
  | { kind: "event"; subId: number; payload: unknown }
  | { kind: "invoke"; id: number; contribution: ContributionKind; contributionId: string; input: unknown }
  | { kind: "deactivate" };

export interface SerializedError {
  message: string;
  /** Present for CapabilityError, so the worker can surface a precise reason. */
  code?: string;
  permission?: string;
}

export function serializeError(err: unknown): SerializedError {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; permission?: unknown };
    return {
      message: typeof e.message === "string" ? e.message : String(err),
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      ...(typeof e.permission === "string" ? { permission: e.permission } : {}),
    };
  }
  return { message: String(err) };
}
