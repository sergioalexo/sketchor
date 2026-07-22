import { issueEntityIds, issueLabel } from "@sketchor/core";
import { fixAllHeal, fixOneHeal, rescanHeal, useApp } from "../state/store";

/**
 * Lists unjointed-line findings (near-coincident endpoints, dangling ends,
 * T-junction gaps) from the most recent scan, with tolerance inputs and
 * fix-selected / fix-all / re-scan actions. See R4 in the engineering brief.
 */
export function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
  const issues = useApp((s) => s.healIssues);
  const options = useApp((s) => s.healOptions);
  const joinCollinear = useApp((s) => s.joinCollinear);
  const setOptions = useApp((s) => s.setHealOptions);
  const setJoinCollinear = useApp((s) => s.setJoinCollinear);
  const setFocus = useApp((s) => s.setHealFocus);

  const fixableCount = issues.filter((i) => i.kind !== "dangling").length;

  return (
    <aside className="diagpanel" data-testid="diagnostics-panel">
      <div className="diagpanel-header">
        <span>Diagnostics</span>
        <button className="btn ghost" onClick={onClose} title="Hide panel">
          ✕
        </button>
      </div>

      <div className="diagpanel-options">
        <label>
          Linear ε
          <input
            type="number"
            min="0"
            step="0.1"
            value={options.linearEps}
            onChange={(e) => setOptions({ linearEps: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <label>
          Angular ε°
          <input
            type="number"
            min="0"
            step="0.5"
            value={options.angularEpsDeg}
            onChange={(e) => setOptions({ angularEpsDeg: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <label className="diagpanel-checkbox">
          <input
            type="checkbox"
            checked={options.crossLayer}
            onChange={(e) => setOptions({ crossLayer: e.target.checked })}
          />
          Cross-layer
        </label>
        <label className="diagpanel-checkbox">
          <input type="checkbox" checked={joinCollinear} onChange={(e) => setJoinCollinear(e.target.checked)} />
          Join collinear
        </label>
      </div>

      <div className="diagpanel-actions">
        <button className="btn ghost" onClick={rescanHeal} data-testid="diag-rescan">
          Re-scan
        </button>
        <button
          className="btn primary"
          onClick={fixAllHeal}
          disabled={fixableCount === 0}
          data-testid="diag-fix-all"
        >
          Fix all ({fixableCount})
        </button>
      </div>

      <div className="diagpanel-list">
        {issues.length === 0 ? (
          <div className="diagpanel-empty">
            No findings. Click <strong>Re-scan</strong> after editing the drawing.
          </div>
        ) : (
          issues.map((issue) => (
            <div key={issue.id} className="diag-row" data-testid="diag-row">
              <button
                className="diag-row-main"
                onClick={() => setFocus({ ...issue.location })}
                title="Frame this finding"
              >
                <span className="diag-row-label">{issueLabel(issue)}</span>
                <span className="diag-row-entities">{issueEntityIds(issue).length} entities</span>
              </button>
              {issue.kind !== "dangling" && (
                <button
                  className="btn ghost"
                  onClick={() => fixOneHeal(issue.id)}
                  data-testid="diag-fix-one"
                >
                  Fix
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
