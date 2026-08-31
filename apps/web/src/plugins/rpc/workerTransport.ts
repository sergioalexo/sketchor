import type { RpcTransport } from "@sketchor/plugin-sdk";
import type { HostToWorker, WorkerToHost } from "./protocol";

/**
 * The {@link RpcTransport} implementation that lives *inside* the worker. It
 * serializes the SDK client's calls into {@link WorkerToHost} messages over
 * `self.postMessage` and resolves them from the host's {@link HostToWorker}
 * replies. The plugin, via the SDK, only ever sees typed promises — this is the
 * plumbing underneath.
 */
export class WorkerTransport implements RpcTransport {
  private nextId = 1;
  private nextSubId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private readonly subscribers = new Map<number, (payload: unknown) => void>();

  constructor(private readonly send: (msg: WorkerToHost) => void = (m) => (self as unknown as Worker).postMessage(m)) {
    self.addEventListener("message", (e: MessageEvent) => this.receive(e.data as HostToWorker));
  }

  call(method: string, args: readonly unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ kind: "call", id, method, args: [...args] });
    });
  }

  subscribe(
    method: string,
    args: readonly unknown[],
    onEvent: (payload: unknown) => void,
  ): Promise<() => void> {
    const id = this.nextId++;
    const subId = this.nextSubId++;
    this.subscribers.set(subId, onEvent);
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(() => this.unsubscribe(subId)),
        reject: (e) => {
          this.subscribers.delete(subId);
          reject(e);
        },
      });
      this.send({ kind: "subscribe", id, subId, method, args: [...args] });
    });
  }

  post(method: string, args: readonly unknown[]): void {
    this.send({ kind: "post", method, args: [...args] });
  }

  private unsubscribe(subId: number): void {
    if (this.subscribers.delete(subId)) this.send({ kind: "unsubscribe", subId });
  }

  private receive(msg: HostToWorker): void {
    switch (msg.kind) {
      case "result": {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.value);
        else entry.reject(Object.assign(new Error(msg.error.message), msg.error));
        return;
      }
      case "event": {
        this.subscribers.get(msg.subId)?.(msg.payload);
        return;
      }
      // init/deactivate are handled by the worker bootstrap, not the transport.
    }
  }
}
