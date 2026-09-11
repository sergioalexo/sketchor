import { useUpdate } from "../update/updateService";

/**
 * Desktop (Windows) only: makes sure Explorer will show previews on
 * `.step`/`.dxf` file icons — on by default, no opt-in.
 *
 * Windows 11 Explorer only consults a thumbnail handler for an extension if
 * a marker key exists under HKLM, and Sketchor installs per-user, so it
 * can't write that key silently. The installer asks when run by hand; the
 * silent in-app updater can't, so a launch without the markers asks Windows
 * for the elevation itself (one UAC prompt, "Registry Editor"). Declining
 * is respected for a week rather than nagging every launch.
 *
 * Deferred past the update check so the prompt never collides with an
 * update that is about to relaunch the app.
 */

const DECLINED_KEY = "sketchor.explorerPreviews.declinedAt.v1";
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const LAUNCH_DELAY_MS = 6000;

interface Status {
  needs_elevation: boolean;
  applicable: boolean;
}

interface TauriInvoke {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function tauri(): TauriInvoke | undefined {
  return (window as unknown as { __TAURI__?: TauriInvoke }).__TAURI__;
}

function declinedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DECLINED_KEY) ?? 0);
    return at > 0 && Date.now() - at < RETRY_AFTER_MS;
  } catch {
    return false;
  }
}

/** Whether a launch should prompt now: never mid-update, never within a week of a decline. */
export function shouldPromptForPreviews(status: Status, updatePhase: string, declined: boolean): boolean {
  if (!status.applicable || !status.needs_elevation) return false;
  if (declined) return false;
  return !["downloading", "installing", "downloaded", "ready"].includes(updatePhase);
}

export function initExplorerPreviews(): void {
  const t = tauri();
  if (!t) return;
  window.setTimeout(async () => {
    try {
      const status = (await t.core.invoke("explorer_previews_status")) as Status;
      if (!shouldPromptForPreviews(status, useUpdate.getState().phase, declinedRecently())) return;
      const ok = (await t.core.invoke("enable_explorer_previews")) as boolean;
      if (!ok) {
        try {
          localStorage.setItem(DECLINED_KEY, String(Date.now()));
        } catch {
          // fine
        }
      }
    } catch {
      // Older desktop build without the commands, or the prompt failed to
      // open: Explorer keeps showing icons; nothing else is affected.
    }
  }, LAUNCH_DELAY_MS);
}
