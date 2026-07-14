/**
 * Desktop-only in-app updates.
 *
 * On startup the app asks GitHub whether a newer signed release exists
 * (the endpoint + public key are configured in `tauri.conf.json`). If one
 * does, we offer to download and install it in place and relaunch — so the
 * user never has to uninstall and grab a fresh build by hand.
 *
 * On the web there is no Tauri runtime, so this is a no-op. The plugin
 * modules are dynamically imported inside the guard, so they are never
 * even fetched by the browser bundle.
 */

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function initAutoUpdate(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;

    const notes = update.body ? `\n\n${update.body}` : "";
    const accepted = window.confirm(
      `Sketchor ${update.version} is available ` +
        `(you have ${update.currentVersion}).${notes}\n\n` +
        `Download and install it now? The app will restart.`,
    );
    if (!accepted) return;

    await update.downloadAndInstall();

    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    // Never let an update hiccup break app startup.
    console.error("Sketchor auto-update check failed:", err);
  }
}
