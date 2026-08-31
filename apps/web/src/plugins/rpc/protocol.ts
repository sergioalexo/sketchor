/**
 * The message protocol spoken across the sandbox boundary: plugin worker ⇄
 * host (main thread). Every payload is structured-cloneable — no functions, no
 * live references — so it survives `postMessage`.
 *
 * Three interaction shapes:
 *   - call/result   — request/response (e.g. document.apply)
 *   - subscribe/event/unsubscribe — a host event stream (e.g. document.onChange)
 *   - post          — fire-and-forget, no reply (e.g. ui.notify)
 */

export type WorkerToHost =
  | { kind: "ready" }
  | { kind: "call"; id: number; method: string; args: unknown[] }
  | { kind: "subscribe"; id: number; subId: number; method: string; args: unknown[] }
  | { kind: "unsubscribe"; subId: number }
  | { kind: "post"; method: string; args: unknown[] }
  | { kind: "activated"; ok: boolean; error?: SerializedError };

export type HostToWorker =
  | { kind: "init"; builtinId: string; pluginId: string }
  | { kind: "result"; id: number; ok: true; value: unknown }
  | { kind: "result"; id: number; ok: false; error: SerializedError }
  | { kind: "event"; subId: number; payload: unknown }
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
