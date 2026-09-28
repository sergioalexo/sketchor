import { dismissMetricsNotice, isMetricsConfigured, setMetricsEnabled, useMetrics } from "./metrics";

/**
 * The one-time strip under the toolbar that makes opt-out statistics fair:
 * it says what is sent, in one line, and puts the switch right there. Shown
 * until dismissed either way, and only in builds that can actually send
 * something — a dev build or one without a key has nothing to disclose.
 */
export function MetricsNotice() {
  const { enabled, noticed } = useMetrics();
  if (noticed || !enabled || !isMetricsConfigured()) return null;
  return (
    <div className="metrics-notice" data-testid="metrics-notice">
      <span className="metrics-notice-text">
        Sketchor sends anonymous usage statistics — which features get used, the app version and OS. Never your
        drawings, file names or anything that identifies you. You can change this any time in the update popover.
      </span>
      <button className="update-later" data-testid="metrics-notice-off" onClick={() => setMetricsEnabled(false)}>
        Turn off
      </button>
      <button className="update-primary" data-testid="metrics-notice-ok" onClick={dismissMetricsNotice}>
        OK
      </button>
    </div>
  );
}
