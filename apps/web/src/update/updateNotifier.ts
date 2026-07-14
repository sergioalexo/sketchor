/**
 * Keyless update notifier.
 *
 * On startup the app asks GitHub's public Releases API whether a newer
 * version has been published. If so, it offers to open the release's
 * download page — no signing keys, no auto-install, no CI secrets. The
 * NSIS installer upgrades in place, so the user never has to remove the
 * old build by hand.
 *
 * Works in the browser and the desktop shell alike (the version check is a
 * plain `fetch`). Opening the page uses the Tauri opener plugin on desktop
 * and `window.open` on the web.
 */

declare const __APP_VERSION__: string;

const REPO = "sergioalexo/sketchor";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Compares dotted numeric versions. Returns true when `latest` > `current`. */
function isNewer(latest: string, current: string): boolean {
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
  return exe?.browser_download_url ?? release.html_url ?? `https://github.com/${REPO}/releases/latest`;
}

async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export async function initUpdateNotifier(): Promise<void> {
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return; // no releases yet, rate-limited, offline — stay quiet
    const release: GithubRelease = await res.json();
    const latest = release.tag_name;
    if (!latest || !isNewer(latest, __APP_VERSION__)) return;

    const label = release.name || latest;
    const accepted = window.confirm(
      `Sketchor ${label} is available (you have ${__APP_VERSION__}).\n\n` +
        `Open the download page? The installer updates your copy in place.`,
    );
    if (accepted) await openExternal(downloadUrl(release));
  } catch {
    // A failed update check must never disrupt startup.
  }
}
