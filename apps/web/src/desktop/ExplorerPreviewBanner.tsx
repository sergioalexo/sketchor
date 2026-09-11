import { useEffect, useState } from "react";

/**
 * Desktop (Windows) only: offers the one-time elevated step that lets
 * Explorer show previews on `.step`/`.dxf` file icons.
 *
 * Windows 11 Explorer only consults a thumbnail handler for an extension if
 * a marker key exists under HKLM, and Sketchor installs per-user, so it
 * can't write that key itself. The installer asks when run by hand; the
 * silent in-app updater can't, so this banner asks instead — once, with a
 * UAC prompt behind the button. Dismissal is remembered.
 */

const DISMISS_KEY = "sketchor.explorerPreviews.dismissed.v1";

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

export function ExplorerPreviewBanner() {
  const [needed, setNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    const t = tauri();
    if (!t) return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      // storage unavailable: just ask
    }
    if (dismissed) return;
    t.core
      .invoke("explorer_previews_status")
      .then((s) => {
        const status = s as Status;
        if (status.applicable && status.needs_elevation) setNeeded(true);
      })
      .catch(() => {
        // older desktop build without the command: nothing to offer
      });
  }, []);

  if (!needed) return null;

  const enable = async () => {
    const t = tauri();
    if (!t) return;
    setBusy(true);
    setDeclined(false);
    try {
      const ok = (await t.core.invoke("enable_explorer_previews")) as boolean;
      if (ok) setNeeded(false);
      else setDeclined(true);
    } catch {
      setDeclined(true);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // fine
    }
    setNeeded(false);
  };

  return (
    <div className="explorer-banner" data-testid="explorer-preview-banner">
      <span>
        Explorer can show previews on STEP and DXF file icons — this needs a one-time administrator approval.
        {declined ? " The approval was declined; nothing was changed." : ""}
      </span>
      <button className="btn primary sm" onClick={() => void enable()} disabled={busy}>
        {busy ? "Waiting for approval…" : "Enable previews"}
      </button>
      <button className="btn ghost sm" onClick={dismiss} disabled={busy}>
        Not now
      </button>
    </div>
  );
}
