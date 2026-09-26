/**
 * Anonymous usage statistics, sent to PostHog.
 *
 * What leaves the machine: the explicit events this module and its callers
 * send — a launch, a heartbeat while the window is visible, which toolbar
 * button or shortcut was used (`action`, by the stable ids in
 * `metrics/actions.ts`), files opened and saved by format and size bucket,
 * STEP/IGES reads by part-count bucket and duration, and how an update went.
 * Every event also carries the app version and whether this is the desktop
 * or the web build; PostHog adds the coarse OS/browser it reads from the user
 * agent. Never a file name, a path, geometry, sketch text, layer names or
 * plugin code — the button table is deliberately a whitelist, and the file
 * events only ever see extensions and counts.
 *
 * Errors go the same way (PostHog's error tracking): unhandled exceptions
 * and rejections from the window, plus `reportError` at the spots that catch
 * and swallow one (a model that failed to read, a save target gone stale).
 * Messages in this app can quote a file name or path, so `scrubText` runs
 * on every exception before it leaves — see `before_send` below.
 *
 * There is no user identity. PostHog keeps a random id in localStorage so
 * one install can be counted once, and no person profile is ever created
 * (`person_profiles: "never"`). Turning statistics off wipes that id, so
 * turning them back on starts a fresh anonymous user.
 *
 * Opt-out, not opt-in, like updates: on by default, and a one-time notice on
 * first launch (`MetricsNotice.tsx`) says so and offers the switch; the
 * toolbar's update popover keeps it afterwards.
 *
 * The SDK is a separate chunk that loads lazily on the first event, so
 * start-up never waits on it and an install with statistics off never even
 * fetches it. Events tracked before it's ready queue up. Dev builds send
 * nothing unless `VITE_METRICS_DEV=1`, so clicking around in `npm run dev`
 * doesn't pollute the numbers.
 */

import { create } from "zustand";
import { installActionTracking } from "./actions";

declare const __APP_VERSION__: string;

/**
 * PostHog project API key. It's a public, write-only key (it can only
 * ingest events), which is why it lives in source like everyone else's.
 * Empty means "no metrics" — the whole module is inert.
 */
export const POSTHOG_KEY = "phc_m8SjJUnGKcKMFDV7zmuWpkTcMCmLwCtFHoNCS4BiwZDj";
export const POSTHOG_HOST = "https://us.i.posthog.com";

const ENABLED_KEY = "sketchor.metrics";
const NOTICED_KEY = "sketchor.metrics.noticed";
const LAUNCHED_KEY = "sketchor.metrics.launchedAt";
const LAST_VERSION_KEY = "sketchor.metrics.lastVersion";
const LAUNCH_SENT_KEY = "sketchor.metrics.launchSent";

export const HEARTBEAT_MS = 5 * 60 * 1000;

/** Exceptions per session after which the rest are dropped — a render loop mustn't become a flood. */
export const MAX_EXCEPTIONS_PER_SESSION = 20;

/** The slice of the SDK this module needs; tests inject a fake. */
export interface MetricsClient {
  capture(event: string, properties: Record<string, unknown>): void;
  captureException(error: unknown, properties: Record<string, unknown>): void;
  /** Forget the stored anonymous id (and anything else the SDK persisted). */
  reset(): void;
}

interface MetricsState {
  enabled: boolean;
  /** The first-launch notice has been seen (or the switch was used). */
  noticed: boolean;
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v !== "off";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    /* private mode / storage disabled — the choice just won't persist */
  }
}

/** Opt-out, not opt-in: the notice on first launch is what makes that fair. */
export const useMetrics = create<MetricsState>(() => ({
  enabled: readFlag(ENABLED_KEY, true),
  noticed: readFlag(NOTICED_KEY, false),
}));

export function isMetricsEnabled(): boolean {
  return useMetrics.getState().enabled;
}

export function setMetricsEnabled(on: boolean): void {
  writeFlag(ENABLED_KEY, on);
  // Using the switch counts as having seen the notice.
  writeFlag(NOTICED_KEY, true);
  useMetrics.setState({ enabled: on, noticed: true });
  if (!on) {
    queue.length = 0;
    client?.reset();
    forgetStoredId();
  }
}

/**
 * Removes what PostHog persisted (its keys all start with `ph_`) even when
 * the SDK hasn't loaded this session — otherwise an id from an earlier
 * session would survive an opt-out and be reused on opt-in.
 */
function forgetStoredId(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith("ph_")) localStorage.removeItem(key);
    }
  } catch {
    /* no storage — nothing was persisted either */
  }
}

export function dismissMetricsNotice(): void {
  writeFlag(NOTICED_KEY, true);
  useMetrics.setState({ noticed: true });
}

/**
 * True when a build can send anything at all: a key is configured and this
 * is a production build (or a dev build that asked for it).
 */
export function isMetricsConfigured(): boolean {
  if (!POSTHOG_KEY) return false;
  return import.meta.env.PROD || import.meta.env.VITE_METRICS_DEV === "1";
}

/**
 * Order-of-magnitude bucket for a count, so an event says "a 1k–9k entity
 * drawing" rather than the exact number — enough to know what people open,
 * nothing that fingerprints a file.
 */
export function magnitudeBucket(n: number): string {
  if (!(n > 0)) return "0";
  if (n < 10) return "1-9";
  if (n < 100) return "10-99";
  if (n < 1000) return "100-999";
  if (n < 10_000) return "1k-9k";
  if (n < 100_000) return "10k-99k";
  return "100k+";
}

/** Lower-cased extension of a file name, or "other" — never the name itself. */
export function formatOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  if (!m) return "other";
  const ext = m[1].toLowerCase();
  return ext === "stp" ? "step" : ext === "igs" ? "iges" : ext;
}

/**
 * Strips what an error message might quote about the user's files: URLs,
 * absolute paths (both flavours) and names with a drawing/model/image
 * extension. Applied to every exception's message, never to the stack
 * frames (those name the app bundle, not the user's files).
 */
export function scrubText(text: string): string {
  return (
    text
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
      .replace(/\b[A-Za-z]:\\[^\s"'<>|]+/g, "<path>")
      .replace(/(?<=^|[\s"'(])(?:~|\/)[^\s"'<>:]+/g, "<path>")
      // A name may contain spaces, so this eats the words before the
      // extension back to the previous punctuation — "Couldn't write My
      // Part.dxf — choose" becomes "<file> — choose". Losing a verb is
      // cheaper than keeping a customer's part name.
      .replace(
        /(?:[^\s"'\\/<>:—(]+(?:'[^\s"'\\/<>:—(]+)* )*[^\s"'\\/<>:—(]+\.(?:dxf|dwg|svg|step|stp|iges|igs|png|jpe?g|gif|bmp|webp|pdf|txt|csv|json|zip)\b/gi,
        "<file>",
      )
      // Also caps the damage from a message that concatenated file contents.
      .slice(0, 500)
  );
}

type ExceptionEntry = { value?: unknown };

/** `before_send` for `$exception` events: scrubs each message in place. Other events pass through. */
export function scrubExceptionProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const out = { ...properties };
  if (typeof out.$exception_message === "string") out.$exception_message = scrubText(out.$exception_message);
  if (Array.isArray(out.$exception_list)) {
    out.$exception_list = (out.$exception_list as ExceptionEntry[]).map((e) =>
      typeof e?.value === "string" ? { ...e, value: scrubText(e.value) } : e,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sending

type Loader = () => Promise<MetricsClient>;

let loadClient: Loader | null = null;
let client: MetricsClient | null = null;
let loading: Promise<void> | null = null;
/** Work waiting for the SDK: each entry runs once against the loaded client. */
const queue: ((c: MetricsClient) => void)[] = [];
let exceptionsThisSession = 0;

// Same two checks as updateService.ts, repeated here rather than imported
// because that module reports update outcomes through `track` — importing
// it back would make a cycle.
function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
}

function baseProps(): Record<string, unknown> {
  return {
    app_version: appVersion(),
    platform: typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? "desktop" : "web",
  };
}

/** Stands in for localStorage where there is none (tests): every call throws. */
const failingStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => {
    throw new Error("no storage");
  },
  setItem: () => {
    throw new Error("no storage");
  },
};

/**
 * Records one event. A no-op unless statistics are on and the build is
 * configured to send; queues until the SDK has loaded.
 */
export function track(event: string, properties: Record<string, unknown> = {}): void {
  const payload = { ...baseProps(), ...properties };
  send((c) => c.capture(event, payload));
}

/**
 * Reports a caught error to PostHog's error tracking, with the same consent
 * and scrubbing as everything else. `context` says where it was caught
 * (`"model_open"`, `"save"`, ...) — never anything about the file.
 */
export function reportError(error: unknown, context: string, properties: Record<string, unknown> = {}): void {
  if (exceptionsThisSession >= MAX_EXCEPTIONS_PER_SESSION) return;
  if (!loadClient || !useMetrics.getState().enabled) return;
  exceptionsThisSession++;
  const payload = { ...baseProps(), ...properties, context };
  send((c) => c.captureException(error, payload));
}

function send(job: (c: MetricsClient) => void): void {
  if (!loadClient || !useMetrics.getState().enabled) return;
  if (client) {
    job(client);
    return;
  }
  queue.push(job);
  ensureClient();
}

function ensureClient(): void {
  if (loading || !loadClient) return;
  loading = loadClient().then(
    (c) => {
      client = c;
      if (!useMetrics.getState().enabled) {
        queue.length = 0;
        return;
      }
      for (const job of queue.splice(0)) job(c);
    },
    () => {
      // The chunk didn't load (offline first launch, blocked host). Give up
      // for this session rather than retrying on every click.
      loadClient = null;
      queue.length = 0;
    },
  );
}

async function loadPosthog(): Promise<MetricsClient> {
  const { default: posthog } = await import("posthog-js");
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    persistence: "localStorage",
    person_profiles: "never",
    // Explicit events only. Autocapture would send clicked element text,
    // which in this app includes file names in the tab strip and browser.
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    disable_scroll_properties: true,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    // No feature-flag / remote-config request on start-up, and never load
    // anything from PostHog's CDN — the SDK chunk is bundled with the app.
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    // `capture_exceptions` stays off: its window.onerror wrapper is the one
    // piece the SDK fetches from the CDN. initMetrics listens for the same
    // two events itself and hands them to captureException, which is
    // bundled.
    before_send: (event) => {
      if (event?.event === "$exception") event.properties = scrubExceptionProperties(event.properties);
      return event;
    },
  });
  return {
    capture: (event, properties) => {
      posthog.capture(event, properties);
    },
    captureException: (error, properties) => {
      posthog.captureException(error, properties);
    },
    reset: () => posthog.reset(),
  };
}

/**
 * What this launch is: the install's first, and/or the first on a new
 * version. The version change is how a completed update gets counted —
 * an event sent just before the updater relaunches the app would rarely be
 * flushed in time, so the next launch reports it instead.
 */
export function launchKind(
  storage: Pick<Storage, "getItem" | "setItem">,
  version: string,
): { first_launch: boolean; previous_version?: string } {
  try {
    const first = !storage.getItem(LAUNCHED_KEY);
    if (first) storage.setItem(LAUNCHED_KEY, String(Date.now()));
    const previous = storage.getItem(LAST_VERSION_KEY);
    if (previous !== version) storage.setItem(LAST_VERSION_KEY, version);
    return previous && previous !== version ? { first_launch: first, previous_version: previous } : { first_launch: first };
  } catch {
    return { first_launch: false };
  }
}

/**
 * Whether this document should send `app_launched` — true once per tab, and
 * marked in *session* storage, which survives a reload but not a new tab.
 *
 * A reload is not a launch, and treating it as one inflates the count badly:
 * `npm run dev` reloads the page by itself the first time Vite optimizes a
 * lazily imported dependency ("optimized dependencies changed. reloading"),
 * which lands two launches milliseconds apart, and a user pressing F5 in the
 * web build is not starting the app again either. A new tab or window is a
 * new launch, which is why this can't live in a module variable.
 *
 * No storage (private mode) means no way to tell, so the launch is sent —
 * a duplicate is better than a launch count that only ever sees some users.
 */
export function shouldCountLaunch(storage: Pick<Storage, "getItem" | "setItem">): boolean {
  try {
    if (storage.getItem(LAUNCH_SENT_KEY)) return false;
    storage.setItem(LAUNCH_SENT_KEY, "1");
    return true;
  } catch {
    return true;
  }
}

/** Set once `initMetrics` has run: a second call in one document does nothing. */
let initialized = false;

/**
 * Wires everything up: the launch event, the click/shortcut listeners that
 * feed `action`, and the heartbeat that makes "users right now" answerable.
 * Call once from main.tsx. Tests pass their own `loadClient`.
 */
export function initMetrics(options: { loadClient?: Loader } = {}): void {
  if (initialized) return;
  if (options.loadClient) loadClient = options.loadClient;
  else if (isMetricsConfigured()) loadClient = loadPosthog;
  else return;
  initialized = true;

  // `launchKind` consumes the first-launch and version-change markers, so it
  // only runs when the event is actually going to be sent.
  if (shouldCountLaunch(typeof sessionStorage !== "undefined" ? sessionStorage : failingStorage)) {
    track("app_launched", launchKind(typeof localStorage !== "undefined" ? localStorage : failingStorage, appVersion()));
  }
  installActionTracking((id, source) => track("action", { id, source }));

  if (typeof window !== "undefined") {
    window.addEventListener("error", (e) => reportError(e.error ?? e.message, "window"));
    window.addEventListener("unhandledrejection", (e) => reportError(e.reason, "promise"));
  }

  if (typeof document !== "undefined" && typeof setInterval === "function") {
    // Unique users per 5-minute bucket of this event ≈ concurrent users;
    // a hidden window (minimised, other tab) isn't "in use".
    setInterval(() => {
      if (document.visibilityState === "visible") track("heartbeat");
    }, HEARTBEAT_MS);
  }
}

/** Test seam: forget the loader, client, queue and this tab's launch marker. */
export function _resetMetricsForTests(): void {
  initialized = false;
  try {
    sessionStorage?.removeItem(LAUNCH_SENT_KEY);
  } catch {
    /* no session storage — nothing was marked */
  }
  loadClient = null;
  client = null;
  loading = null;
  queue.length = 0;
  exceptionsThisSession = 0;
}
