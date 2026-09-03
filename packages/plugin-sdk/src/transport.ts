/**
 * The RPC transport the SDK client sits on. This is the seam between the typed
 * host-API proxy (this package) and the actual message channel (implemented by
 * the host's worker/iframe bootstrap in Phase 1). Keeping it an interface lets
 * the SDK compile and be unit-tested against a fake channel with no sandbox.
 *
 * Every payload that crosses must be structured-cloneable — no functions, no
 * live object references.
 */
export interface RpcTransport {
  /** Invoke a host method by dotted path (e.g. "document.apply"); resolves with its return value. */
  call(method: string, args: readonly unknown[]): Promise<unknown>;
  /**
   * Subscribe to a host event stream (e.g. "document.onChange"). `onEvent` is
   * called with each emitted payload; resolves with an unsubscribe function.
   */
  subscribe(
    method: string,
    args: readonly unknown[],
    onEvent: (payload: unknown) => void,
  ): Promise<() => void>;
  /** Fire-and-forget call with no reply (e.g. "ui.postMessage", "ui.notify"). */
  post(method: string, args: readonly unknown[]): void;
}
