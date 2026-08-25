import {
  applyUpdate,
  checkForUpdates,
  currentVersion,
  dismissUpdate,
  resetUpdateState,
  useUpdate,
} from "./updateService";

/**
 * The update UI, in two pieces:
 *
 * - {@link UpdateButton} — a toolbar button that runs an explicit check and
 *   shows the result in a popover ("up to date", progress, errors).
 * - {@link UpdateBanner} — a strip under the toolbar that appears on its own
 *   when the silent start-up check finds something, so an available update is
 *   visible without hunting for it.
 *
 * Both drive the same {@link useUpdate} state, so starting a download from
 * one is reflected in the other.
 */

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "12.4 MB of 31.0 MB (40%)" — degrades gracefully when there's no total. */
function progressText(received: number, total: number | null): string {
  if (!total) return formatMb(received);
  return `${formatMb(received)} of ${formatMb(total)} (${Math.round((received / total) * 100)}%)`;
}

export function UpdateButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { phase, version, notes, channel, received, total, message } = useUpdate();
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";

  return (
    <div className="action-menu-wrap">
      <button
        className={`action action-labeled ${phase === "available" ? "update-ready" : ""}`}
        title={
          phase === "available"
            ? `Sketchor ${version} is available — click to update`
            : `Check for updates (you have ${currentVersion()})`
        }
        data-testid="check-updates"
        onClick={() => {
          resetUpdateState();
          onToggle();
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path
            d="M12 3v11m0 0l-4-4m4 4l4-4"
            stroke="currentColor"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
        </svg>
        {/* Spelled out rather than icon-only: an update button nobody can find
            is an update nobody installs. */}
        <span className="action-label">
          {busy
            ? phase === "checking"
              ? "Checking..."
              : "Updating..."
            : phase === "available"
              ? `Update to ${version}`
              : "Check for updates"}
        </span>
        {phase === "available" && <span className="update-dot" />}
      </button>

      {open && (
        <div className="action-menu update-menu" data-testid="update-menu">
          <div className="update-version">Sketchor {currentVersion()}</div>

          {phase === "available" ? (
            <>
              <div className="update-headline">Version {version} is available</div>
              {notes && <div className="update-notes">{notes}</div>}
              <button
                className="update-primary"
                data-testid="update-now"
                onClick={() => void applyUpdate()}
              >
                {channel === "install" ? "Update now" : "Open download page"}
              </button>
              {channel === "install" && (
                <div className="update-sub">Downloads, installs and restarts Sketchor.</div>
              )}
            </>
          ) : phase === "downloading" ? (
            <>
              <div className="update-headline">Downloading {version}...</div>
              <div className="update-progress">
                <div
                  className="update-progress-fill"
                  style={{ width: total ? `${Math.min(100, (received / total) * 100)}%` : "100%" }}
                />
              </div>
              <div className="update-sub">{progressText(received, total)}</div>
            </>
          ) : phase === "installing" || phase === "ready" ? (
            <>
              <div className="update-headline">Installing {version}...</div>
              <div className="update-sub">Sketchor will restart when it's done.</div>
            </>
          ) : phase === "checking" ? (
            <div className="update-headline">Checking for updates...</div>
          ) : phase === "up-to-date" ? (
            <div className="update-headline" data-testid="update-uptodate">
              You're up to date.
            </div>
          ) : phase === "error" ? (
            <>
              <div className="update-headline">Couldn't check for updates</div>
              <div className="update-sub">{message}</div>
              <button className="update-primary" onClick={() => void checkForUpdates()}>
                Try again
              </button>
            </>
          ) : (
            <button
              className="update-primary"
              data-testid="update-check"
              onClick={() => void checkForUpdates()}
              disabled={busy}
            >
              Check for updates
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function UpdateBanner() {
  const { phase, version, channel, received, total, dismissed } = useUpdate();
  const downloading = phase === "downloading" || phase === "installing" || phase === "ready";
  if (dismissed || (phase !== "available" && !downloading)) return null;

  return (
    <div className="update-banner" data-testid="update-banner">
      {downloading ? (
        <span className="update-banner-text">
          {phase === "downloading"
            ? `Downloading Sketchor ${version} — ${progressText(received, total)}`
            : `Installing Sketchor ${version} — the app will restart.`}
        </span>
      ) : (
        <>
          <span className="update-banner-text">
            Sketchor {version} is available (you have {currentVersion()}).
          </span>
          <button className="update-primary" data-testid="banner-update-now" onClick={() => void applyUpdate()}>
            {channel === "install" ? "Update now" : "Download"}
          </button>
          <button className="update-later" onClick={dismissUpdate}>
            Later
          </button>
        </>
      )}
    </div>
  );
}
