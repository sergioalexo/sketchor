import { duplicateIssueLabel } from "@sketchor/core";
import { fixAllDuplicatesAction, fixOneDuplicate, rescanDuplicates, useApp } from "../state/store";

/**
 * Lists redundant-geometry findings (duplicate circles, duplicate points,
 * overlapping/duplicate lines) from the most recent scan — the "holes on
 * holes" case — with a tolerance input and fix-selected / fix-all / re-scan
 * actions. Mirrors DiagnosticsPanel's layout for the unjointed-line scan.
 */
export function DuplicatesPanel({ onClose }: { onClose: () => void }) {
  const issues = useApp((s) => s.duplicateIssues);
  const options = useApp((s) => s.duplicateOptions);
  const setOptions = useApp((s) => s.setDuplicateOptions);
  const setFocus = useApp((s) => s.setDuplicateFocus);

  return (
    <aside className="diagpanel" data-testid="duplicates-panel">
      <div className="diagpanel-header">
        <span>Duplicates</span>
        <button className="btn ghost" onClick={onClose} title="Hide panel">
          ✕
        </button>
      </div>

      <div className="diagpanel-options">
        <label>
          Tolerance
          <input
            type="number"
            min="0"
            step="0.1"
            value={options.tolerance}
            onChange={(e) => setOptions({ tolerance: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
      </div>

      <div className="diagpanel-actions">
        <button className="btn ghost" onClick={rescanDuplicates} data-testid="dup-rescan">
          Re-scan
        </button>
        <button
          className="btn primary"
          onClick={fixAllDuplicatesAction}
          disabled={issues.length === 0}
          data-testid="dup-fix-all"
        >
          Fix all ({issues.length})
        </button>
      </div>

      <div className="diagpanel-list">
        {issues.length === 0 ? (
          <div className="diagpanel-empty">
            No findings. Click <strong>Re-scan</strong> after editing the drawing.
          </div>
        ) : (
          issues.map((issue) => (
            <div key={issue.id} className="diag-row" data-testid="dup-row">
              <button
                className="diag-row-main"
                onClick={() => setFocus({ ...issue.location })}
                title="Frame this finding"
              >
                <span className="diag-row-label">{duplicateIssueLabel(issue)}</span>
                <span className="diag-row-entities">{issue.entityIds.length} entities</span>
              </button>
              <button className="btn ghost" onClick={() => fixOneDuplicate(issue.id)} data-testid="dup-fix-one">
                Fix
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
