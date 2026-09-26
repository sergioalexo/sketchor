import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_EXCEPTIONS_PER_SESSION,
  _resetMetricsForTests,
  formatOf,
  initMetrics,
  launchKind,
  magnitudeBucket,
  reportError,
  shouldCountLaunch,
  scrubExceptionProperties,
  scrubText,
  setMetricsEnabled,
  track,
  useMetrics,
  type MetricsClient,
} from "./metrics";

/**
 * Usage statistics are opt-out, so the guarantees that make that acceptable
 * are what's tested: nothing is sent once the user has said no (including
 * events that were already queued), the stored id is wiped when they do,
 * events never carry more than an extension or a bucket, error messages
 * are scrubbed of anything that names a file, and an install is counted as
 * new exactly once. A regression here is a privacy bug, not a chart bug.
 */

function fakeClient() {
  const sent: [string, Record<string, unknown>][] = [];
  const errors: [unknown, Record<string, unknown>][] = [];
  let resets = 0;
  const client: MetricsClient = {
    capture: (event, props) => {
      sent.push([event, props]);
    },
    captureException: (error, props) => {
      errors.push([error, props]);
    },
    reset: () => {
      resets++;
    },
  };
  return { client, sent, errors, resets: () => resets };
}

/** Resolves the client only when the test says so, like a chunk still downloading. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetMetricsForTests();
  useMetrics.setState({ enabled: true, noticed: false });
});
afterEach(() => _resetMetricsForTests());

describe("track", () => {
  it("drops (not queues) events tracked before initMetrics", async () => {
    const { client, sent } = fakeClient();
    track("action", { id: "tool.line" });
    initMetrics({ loadClient: async () => client });
    await flush();
    expect(sent.map(([e]) => e)).toEqual(["app_launched"]);
  });

  it("queues events until the SDK loads, then sends them in order with the base properties", async () => {
    const { client, sent } = fakeClient();
    const load = deferred<MetricsClient>();
    initMetrics({ loadClient: () => load.promise });
    track("action", { id: "tool.line", source: "key" });
    expect(sent).toEqual([]);

    load.resolve(client);
    await flush();
    expect(sent.map(([e]) => e)).toEqual(["app_launched", "action"]);
    for (const [, props] of sent) {
      expect(props.platform).toBe("web");
      expect(typeof props.app_version).toBe("string");
    }
    expect(sent[1][1]).toMatchObject({ id: "tool.line", source: "key" });

    track("heartbeat");
    expect(sent.at(-1)?.[0]).toBe("heartbeat");
  });

  it("drops everything, queued or later, once statistics are turned off — and wipes the stored id", async () => {
    const { client, sent, resets } = fakeClient();
    const load = deferred<MetricsClient>();
    initMetrics({ loadClient: () => load.promise });
    track("action", { id: "tool.line" });
    setMetricsEnabled(false);
    load.resolve(client);
    await flush();
    expect(sent).toEqual([]);

    track("action", { id: "tool.circle" });
    expect(sent).toEqual([]);
    // The client arrived after the opt-out (nothing to reset then); a later
    // opt-out with it loaded wipes what it stored.
    setMetricsEnabled(false);
    expect(resets()).toBe(1);
  });

  it("gives up for the session when the SDK chunk fails to load", async () => {
    const load = deferred<MetricsClient>();
    initMetrics({ loadClient: () => load.promise });
    load.reject(new Error("offline"));
    await flush();
    const { client, sent } = fakeClient();
    void client;
    track("action", { id: "tool.line" });
    await flush();
    expect(sent).toEqual([]);
  });

  it("sends one app_launched however many times initMetrics is called in a document", async () => {
    const { client, sent } = fakeClient();
    initMetrics({ loadClient: async () => client });
    initMetrics({ loadClient: async () => client });
    await flush();
    expect(sent.filter(([e]) => e === "app_launched")).toHaveLength(1);
  });

  it("does nothing without a configured key (the default in this repo and in dev)", () => {
    initMetrics();
    const { sent } = fakeClient();
    track("action", { id: "tool.line" });
    expect(sent).toEqual([]);
  });
});

describe("reportError", () => {
  it("queues behind the SDK like an event, keeps the error object and tags the context", async () => {
    const { client, errors } = fakeClient();
    const load = deferred<MetricsClient>();
    initMetrics({ loadClient: () => load.promise });
    const boom = new Error("Couldn't write bracket.dxf");
    reportError(boom, "save", { format: "dxf" });
    expect(errors).toEqual([]);
    load.resolve(client);
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe(boom);
    expect(errors[0][1]).toMatchObject({ context: "save", format: "dxf", platform: "web" });
  });

  it("is silent once statistics are off", async () => {
    const { client, errors } = fakeClient();
    initMetrics({ loadClient: async () => client });
    await flush();
    setMetricsEnabled(false);
    reportError(new Error("x"), "window");
    expect(errors).toEqual([]);
  });

  it("stops after MAX_EXCEPTIONS_PER_SESSION so a render loop can't flood", async () => {
    const { client, errors } = fakeClient();
    initMetrics({ loadClient: async () => client });
    await flush();
    for (let i = 0; i < MAX_EXCEPTIONS_PER_SESSION + 5; i++) reportError(new Error(`e${i}`), "window");
    expect(errors).toHaveLength(MAX_EXCEPTIONS_PER_SESSION);
  });
});

describe("scrubText", () => {
  it("removes the file names and paths this app's own messages quote", () => {
    // Names can have spaces, so everything back to the previous punctuation goes.
    expect(scrubText("Couldn't write Customer Part 42 rev B.dxf — choose a location")).toBe("<file> — choose a location");
    expect(scrubText('Bad file: Customer Part 42 rev B.dxf')).toBe("Bad file: <file>");
    expect(scrubText("Couldn't open https://example.com/secret?x=1")).toBe("Couldn't open <url>");
    expect(scrubText("ENOENT: C:\\Users\\dan\\Desktop\\bracket.step")).toBe("ENOENT: <path>");
    expect(scrubText("open /Users/dan/Desktop/bracket.step failed")).toBe("open <path> failed");
    expect(scrubText("open ~/Desktop/bracket.step failed")).toBe("open <path> failed");
    expect(scrubText('Bad file "Housing_v3.STP"')).toBe('Bad file "<file>"');
  });

  it("leaves ordinary messages alone", () => {
    for (const m of [
      "Cannot read properties of undefined (reading 'x')",
      "Unexpected token / in JSON at position 3",
      "Expected 1/2 of the points",
      "RuntimeError: memory access out of bounds",
    ]) {
      expect(scrubText(m)).toBe(m);
    }
  });

  it("caps the length, so a message that embedded file contents can't carry them", () => {
    expect(scrubText("x".repeat(5000))).toHaveLength(500);
  });
});

describe("scrubExceptionProperties", () => {
  it("scrubs every message in $exception_list and the legacy field, keeping the rest", () => {
    const props = scrubExceptionProperties({
      $exception_message: "read /tmp/a.dxf",
      $exception_list: [
        { type: "Error", value: "read /tmp/a.dxf", stacktrace: { frames: [{ filename: "http://tauri.localhost/assets/index.js" }] } },
        { type: "Error" },
      ],
      context: "model_open",
    });
    expect(props.$exception_message).toBe("read <path>");
    expect(props.$exception_list).toEqual([
      { type: "Error", value: "read <path>", stacktrace: { frames: [{ filename: "http://tauri.localhost/assets/index.js" }] } },
      { type: "Error" },
    ]);
    expect(props.context).toBe("model_open");
  });
});

describe("consent state", () => {
  it("defaults to on, and using the switch dismisses the notice too", () => {
    expect(useMetrics.getState()).toEqual({ enabled: true, noticed: false });
    setMetricsEnabled(false);
    expect(useMetrics.getState()).toEqual({ enabled: false, noticed: true });
    setMetricsEnabled(true);
    expect(useMetrics.getState()).toEqual({ enabled: true, noticed: true });
  });
});

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("shouldCountLaunch", () => {
  it("counts one launch per tab, so a reload isn't a second one", () => {
    // The dev server reloads the page by itself while optimizing a lazily
    // imported dependency, which used to land two launches 1ms apart.
    const session = memoryStorage();
    expect(shouldCountLaunch(session)).toBe(true);
    expect(shouldCountLaunch(session)).toBe(false);
    expect(shouldCountLaunch(session)).toBe(false);
    // A new tab gets its own session storage, and is a launch again.
    expect(shouldCountLaunch(memoryStorage())).toBe(true);
  });

  it("still counts the launch when there is no storage to remember it in", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(shouldCountLaunch(throwing)).toBe(true);
    expect(shouldCountLaunch(throwing)).toBe(true);
  });
});

describe("launchKind", () => {

  it("counts an install as new exactly once, and a version change exactly once", () => {
    const s = memoryStorage();
    expect(launchKind(s, "1.0.0")).toEqual({ first_launch: true });
    expect(launchKind(s, "1.0.0")).toEqual({ first_launch: false });
    expect(launchKind(s, "1.1.0")).toEqual({ first_launch: false, previous_version: "1.0.0" });
    expect(launchKind(s, "1.1.0")).toEqual({ first_launch: false });
  });

  it("never claims a first launch when storage is unavailable (it would claim it every time)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(launchKind(throwing, "1.0.0")).toEqual({ first_launch: false });
  });
});

describe("what a file event may carry", () => {
  it("formatOf keeps only the extension, normalised", () => {
    expect(formatOf("Customer Part 42 rev B.DXF")).toBe("dxf");
    expect(formatOf("/Users/someone/secret/bracket.stp")).toBe("step");
    expect(formatOf("housing.IGS")).toBe("iges");
    expect(formatOf("README")).toBe("other");
  });

  it("magnitudeBucket is monotone and coarse", () => {
    const samples = [0, 1, 9, 10, 99, 100, 999, 1000, 9999, 10_000, 99_999, 100_000, 5_000_000];
    const buckets = samples.map(magnitudeBucket);
    expect(new Set(buckets).size).toBe(7);
    expect(buckets).toEqual(["0", "1-9", "1-9", "10-99", "10-99", "100-999", "100-999", "1k-9k", "1k-9k", "10k-99k", "10k-99k", "100k+", "100k+"]);
    expect(magnitudeBucket(NaN)).toBe("0");
    expect(magnitudeBucket(-3)).toBe("0");
  });
});
