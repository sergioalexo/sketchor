/**
 * In-app updates.
 *
 * Desktop (Tauri): the signed updater plugin polls `latest.json`, published
 * with every release by .github/workflows/release.yml. "Update now" downloads
 * the NSIS installer, verifies its minisign signature against the public key
 * baked into tauri.conf.json, runs it and relaunches Sketchor — the user
 * never leaves the app.
 *
 * Web, or desktop where the updater can't answer (offline, no `latest.json`
 * on the release, an older build with no signing key): fall back to the public
 * GitHub Releases API, which can still tell the user a newer version exists
 * and open its download page. The fallback keeps the pre-0.7 keyless
 * behaviour alive rather than reporting a hard failure.
 *
 * On the desktop this runs itself: the start-up check downloads a new version
 * as soon as it finds one and installs it without being asked. Download and
 * install are deliberately separate steps, because installing hands the app to
 * the NSIS installer, which closes Sketchor to swap the files — so the install
 * only goes ahead while every tab is saved. With unsaved work open the download
 * waits on disk and the banner offers the restart, which is the user's call.
 * `autoUpdate` turns the whole thing off.
 */

import { create } from "zustand";

declare const __APP_VERSION__: string;

const REPO = "sergioalexo/sketchor";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** How the update, once found, can be applied. */
export type UpdateChannel =
  /** The Tauri updater has it: we can install it in place. */
  | "install"
  /** Only the Releases API knows about it: we can open the download page. */
  | "download";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  /** On disk and verified, waiting for a safe moment to close the app and install. */
  | "downloaded"
  | "installing"
  | "ready"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** Version offered, without a leading "v". */
  version: string | null;
  /** Release notes, when the source provides them. */
  notes: string | null;
  channel: UpdateChannel;
  /** Bytes received / expected during a download; total is null when the server sends no length. */
  received: number;
  total: number | null;
  message: string | null;
  /** True while a check the user didn't ask for is running, so the UI stays quiet. */
  silent: boolean;
  /** Dismissed by the user — hides the banner until the next explicit check. */
  dismissed: boolean;
  lastCheckedAt: number | null;
  /** Install new versions on launch without being asked. Desktop only. */
  autoUpdate: boolean;
  /** True when the update in flight was started by the app, not by a click. */
  unattended: boolean;
}

const AUTO_UPDATE_KEY = "sketchor.autoUpdate";

/** Opt-out, not opt-in: the point is that most users never think about updating. */
function loadAutoUpdate(): boolean {
  try {
    return localStorage.getItem(AUTO_UPDATE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAutoUpdate(on: boolean): void {
  try {
    localStorage.setItem(AUTO_UPDATE_KEY, on ? "on" : "off");
  } catch {
    /* private mode / storage disabled — the choice just won't persist */
  }
  set({ autoUpdate: on });
}

const INITIAL: UpdateState = {
  phase: "idle",
  version: null,
  notes: null,
  channel: "download",
  received: 0,
  total: null,
  message: null,
  silent: false,
  dismissed: false,
  lastCheckedAt: null,
  autoUpdate: loadAutoUpdate(),
  unattended: false,
};

export const useUpdate = create<UpdateState>(() => INITIAL);

const set = (patch: Partial<UpdateState>) => useUpdate.setState(patch);

export const currentVersion = (): string =>
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Opens a URL in the user's real browser (desktop) or a new tab (web).
 *
 * Failures are reported, not dropped. Callers fire this from click handlers
 * without awaiting, so a rejection here used to disappear into a floating
 * promise — which is exactly how the desktop build refusing every URL (an
 * opener permission with no scope attached) stayed invisible for three
 * releases. If it can't open, say so and show the address.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    if (isTauri()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  } catch (err) {
    console.error("Failed to open", url, err);
    const { useApp } = await import("../state/store");
    useApp.getState().setSaveNotice({ kind: "error", message: `Couldn't open ${url}`, at: Date.now() });
  }
}

/** Compares dotted numeric versions. Returns true when `latest` > `current`. */
export function isNewer(latest: string, current: string): boolean {
  const norm = (v: string) => v.replace(/^v/, "").split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const a = norm(latest);
  const b = norm(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  assets?: { name: string; browser_download_url: string }[];
}

/** Prefer a Windows installer asset, else fall back to the release page. */
function downloadUrl(release: GithubRelease): string {
  const exe = release.assets?.find((a) => /\.(exe|msi)$/i.test(a.name));
  return exe?.browser_download_url ?? release.html_url ?? RELEASES_PAGE;
}

/** Where the "download" channel sends the user; set alongside the version. */
let pendingDownloadUrl = RELEASES_PAGE;

/**
 * The Tauri `Update` handle from the last successful plugin check, held so
 * `applyUpdate()` installs exactly what `checkForUpdates()` found instead of
 * re-querying for it.
 */
interface TauriUpdate {
  version: string;
  body?: string;
  download(onEvent: (e: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  downloadAndInstall(onEvent: (e: DownloadEvent) => void): Promise<void>;
}
type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

let pendingUpdate: TauriUpdate | null = null;

/** Asks the signed updater. `undefined` means it couldn't answer at all. */
async function checkViaPlugin(): Promise<TauriUpdate | null | undefined> {
  if (!isTauri()) return undefined;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    return ((await check()) as unknown as TauriUpdate | null) ?? null;
  } catch {
    // No latest.json on the release, offline, or a dev build with no updater
    // configured — let the Releases API have a go.
    return undefined;
  }
}

/** Asks the public Releases API. Returns null when there's nothing newer. */
async function checkViaGithub(): Promise<{ version: string; notes: string | null; url: string } | null> {
  const res = await fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const release: GithubRelease = await res.json();
  const tag = release.tag_name;
  if (!tag || !isNewer(tag, currentVersion())) return null;
  return {
    version: tag.replace(/^v/, ""),
    notes: release.body?.trim() || null,
    url: downloadUrl(release),
  };
}

/**
 * Looks for a newer version. `silent` (used on start-up) suppresses the
 * "you're up to date" and error states so a flaky network never nags.
 */
export async function checkForUpdates({ silent = false } = {}): Promise<void> {
  if (useUpdate.getState().phase === "checking") return;
  set({ phase: "checking", silent, message: null, dismissed: false });

  try {
    const viaPlugin = await checkViaPlugin();
    if (viaPlugin) {
      pendingUpdate = viaPlugin;
      set({
        phase: "available",
        channel: "install",
        version: viaPlugin.version.replace(/^v/, ""),
        notes: viaPlugin.body?.trim() || null,
        lastCheckedAt: Date.now(),
      });
      return;
    }

    // The plugin said "nothing newer" (null) — trust it and stop. Only an
    // inconclusive answer (undefined) falls through to the Releases API.
    if (viaPlugin === null) {
      pendingUpdate = null;
      set({ phase: "up-to-date", version: null, notes: null, lastCheckedAt: Date.now() });
      return;
    }

    const viaApi = await checkViaGithub();
    if (viaApi) {
      pendingUpdate = null;
      pendingDownloadUrl = viaApi.url;
      set({
        phase: "available",
        channel: "download",
        version: viaApi.version,
        notes: viaApi.notes,
        lastCheckedAt: Date.now(),
      });
    } else {
      set({ phase: "up-to-date", version: null, notes: null, lastCheckedAt: Date.now() });
    }
  } catch (err) {
    set({
      phase: "error",
      message: err instanceof Error ? err.message : "Update check failed",
      lastCheckedAt: Date.now(),
    });
  }
}

/** Fetches the pending update to disk. Returns true once it's there. */
async function downloadPending(): Promise<boolean> {
  if (!pendingUpdate) return false;
  set({ phase: "downloading", received: 0, total: null, message: null });
  try {
    await pendingUpdate.download((e) => {
      if (e.event === "Started") set({ received: 0, total: e.data.contentLength ?? null });
      else if (e.event === "Progress") set({ received: useUpdate.getState().received + e.data.chunkLength });
    });
    set({ phase: "downloaded" });
    return true;
  } catch (err) {
    set({ phase: "error", message: err instanceof Error ? err.message : "Download failed" });
    return false;
  }
}

/**
 * Runs the installer for an already-downloaded update and relaunches into it.
 * This closes Sketchor, so callers own the decision that now is a safe moment.
 */
export async function installPending(): Promise<void> {
  if (!pendingUpdate) return;
  set({ phase: "installing", message: null });
  try {
    await pendingUpdate.install();
    set({ phase: "ready" });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    set({ phase: "error", message: err instanceof Error ? err.message : "Install failed" });
  }
}

/**
 * Applies the update found by the last check: installs it in place on the
 * desktop, or opens the download page when only the Releases API knew about
 * it. On success the app relaunches into the new version.
 */
export async function applyUpdate(): Promise<void> {
  const state = useUpdate.getState();
  if (state.phase === "downloaded") {
    // Already on disk — an unattended download the user is now approving.
    await installPending();
    return;
  }
  if (state.phase !== "available" && state.phase !== "error") return;

  if (state.channel === "download" || !pendingUpdate) {
    await openExternal(pendingDownloadUrl);
    return;
  }

  set({ unattended: false });
  if (await downloadPending()) await installPending();
}

/** Tabs with unsaved changes. Counted, not just flagged, so the UI can say how many. */
async function unsavedTabCount(): Promise<number> {
  try {
    const { getSessions } = await import("../state/store");
    return getSessions().filter((s) => s.dirty).length;
  } catch {
    // Can't tell — treat it as unsaved rather than closing over the user's work.
    return 1;
  }
}

/** Whether the launch check's result should start an unattended download. */
export function shouldAutoDownload(s: Pick<UpdateState, "autoUpdate" | "phase" | "channel">): boolean {
  return s.autoUpdate && s.phase === "available" && s.channel === "install";
}

/**
 * Whether a downloaded update may install itself with nobody watching.
 * Installing closes the app, so anything unsaved would go with it — one dirty
 * tab is enough to make the restart the user's decision instead.
 */
export function canInstallUnattended(unsavedTabs: number): boolean {
  return unsavedTabs === 0;
}

/**
 * The hands-off path: download the update the start-up check found, then
 * install it if nothing would be lost. Otherwise it stays in "downloaded" and
 * the banner offers the restart.
 */
async function updateUnattended(): Promise<void> {
  set({ unattended: true });
  if (!(await downloadPending())) return;
  if (canInstallUnattended(await unsavedTabCount())) await installPending();
}

/** Hides the update banner until the next explicit check. */
export function dismissUpdate(): void {
  set({ dismissed: true });
}

/** Clears a transient result ("up to date" / error) so the popover closes cleanly. */
export function resetUpdateState(): void {
  const { phase } = useUpdate.getState();
  if (phase === "up-to-date" || phase === "error") set({ phase: "idle", message: null });
}

/**
 * Fire-and-forget check a moment after launch; never blocks or throws. When a
 * signed update turns up and auto-update is on, it goes straight into
 * downloading and installing it — see {@link updateUnattended}.
 */
export function initUpdateCheck(): void {
  window.setTimeout(async () => {
    await checkForUpdates({ silent: true });
    if (shouldAutoDownload(useUpdate.getState())) await updateUnattended();
  }, 2500);
}
