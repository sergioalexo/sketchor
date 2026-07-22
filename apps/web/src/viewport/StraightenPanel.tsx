import { applyStraighten, useApp, type StraightenAxis, type StraightenPivot } from "../state/store";

const AXES: { id: StraightenAxis; label: string }[] = [
  { id: "horizontal", label: "Horizontal" },
  { id: "vertical", label: "Vertical" },
];

const PIVOTS: { id: StraightenPivot; label: string }[] = [
  { id: "center", label: "Selection center" },
  { id: "edge-mid", label: "Edge midpoint" },
  { id: "edge-start", label: "Edge start" },
];

/**
 * Floating toolbar for the straighten tool: pick the target axis and
 * pivot, then commit the rigid rotation. Only shown while the straighten
 * tool is active (see App.tsx).
 */
export function StraightenPanel() {
  const referenceEdgeId = useApp((s) => s.referenceEdgeId);
  const axis = useApp((s) => s.straightenAxis);
  const pivot = useApp((s) => s.straightenPivot);
  const setAxis = useApp((s) => s.setStraightenAxis);
  const setPivot = useApp((s) => s.setStraightenPivot);
  const selection = useApp((s) => s.selection);

  return (
    <div className="straighten-panel" data-testid="straighten-panel">
      <div className="straighten-row">
        <span className="straighten-label">Axis</span>
        {AXES.map((a) => (
          <button
            key={a.id}
            className={`btn ghost ${axis === a.id ? "toggled" : ""}`}
            onClick={() => setAxis(a.id)}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="straighten-row">
        <span className="straighten-label">Pivot</span>
        <select value={pivot} onChange={(e) => setPivot(e.target.value as StraightenPivot)}>
          {PIVOTS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="straighten-row">
        <span className="straighten-hint" data-testid="straighten-status">
          {selection.length === 0
            ? "Select the part first (V)"
            : referenceEdgeId
              ? "Reference edge picked — Enter to apply"
              : "Click a selected line as the reference edge"}
        </span>
        <button
          className="btn primary"
          disabled={!referenceEdgeId}
          onClick={() => applyStraighten()}
          data-testid="straighten-apply"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
