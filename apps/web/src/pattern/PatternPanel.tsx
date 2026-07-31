import { useState } from "react";
import { centroidOfEntities, patternCopyCount, type Entity, type PatternSpec } from "@sketchor/core";
import { applyPattern, doc, useApp } from "../state/store";

/**
 * Pattern (array) panel: repeats the current selection in a grid or around a
 * circle. Copies are ordinary independent entities added in one undoable
 * step — there's no live array object linking them to the source, so each
 * copy can be edited afterwards like anything else.
 */
export function PatternPanel({ onClose }: { onClose: () => void }) {
  const selection = useApp((s) => s.selection);
  const revision = useApp((s) => s.revision);

  const [kind, setKind] = useState<PatternSpec["kind"]>("rectangular");
  const [columns, setColumns] = useState(3);
  const [rows, setRows] = useState(1);
  const [columnSpacing, setColumnSpacing] = useState(50);
  const [rowSpacing, setRowSpacing] = useState(50);
  const [count, setCount] = useState(6);
  const [totalAngle, setTotalAngle] = useState(360);
  const [rotateItems, setRotateItems] = useState(true);

  // Default the circular centre to the selection's centroid, recomputed as the
  // selection changes so it stays sensible without extra fiddling.
  const selectionEntities = selection.map((id) => doc.get(id)).filter((e): e is Entity => !!e);
  const centroid = selectionEntities.length ? centroidOfEntities(selectionEntities) : { x: 0, y: 0 };
  const [centerOverride, setCenterOverride] = useState<{ x: string; y: string } | null>(null);
  const center = centerOverride
    ? { x: Number(centerOverride.x) || 0, y: Number(centerOverride.y) || 0 }
    : centroid;

  const spec: PatternSpec =
    kind === "rectangular"
      ? { kind, columns, rows, columnSpacing, rowSpacing }
      : { kind, count, center, totalAngle: (totalAngle * Math.PI) / 180, rotateItems };

  const willAdd = selection.length ? patternCopyCount(spec, selection.length) : 0;

  return (
    <aside className="diagpanel" data-testid="pattern-panel">
      <div className="diagpanel-header">
        <span>Pattern</span>
        <button className="btn ghost" onClick={onClose} title="Hide panel">
          ✕
        </button>
      </div>

      <div className="filexplorer-toolbar">
        <div className="filexplorer-toggle" role="group" aria-label="Pattern type">
          <button
            className={kind === "rectangular" ? "active" : ""}
            onClick={() => setKind("rectangular")}
            data-testid="pattern-kind-rect"
          >
            Grid
          </button>
          <button
            className={kind === "circular" ? "active" : ""}
            onClick={() => setKind("circular")}
            data-testid="pattern-kind-circular"
          >
            Circular
          </button>
        </div>
      </div>

      <div className="diagpanel-options">
        {kind === "rectangular" ? (
          <>
            <label>
              Columns
              <input
                type="number"
                min="1"
                value={columns}
                onChange={(e) => setColumns(Math.max(1, Number(e.target.value) || 1))}
                data-testid="pattern-columns"
              />
            </label>
            <label>
              Column spacing
              <input
                type="number"
                value={columnSpacing}
                onChange={(e) => setColumnSpacing(Number(e.target.value) || 0)}
                data-testid="pattern-col-spacing"
              />
            </label>
            <label>
              Rows
              <input
                type="number"
                min="1"
                value={rows}
                onChange={(e) => setRows(Math.max(1, Number(e.target.value) || 1))}
                data-testid="pattern-rows"
              />
            </label>
            <label>
              Row spacing
              <input
                type="number"
                value={rowSpacing}
                onChange={(e) => setRowSpacing(Number(e.target.value) || 0)}
                data-testid="pattern-row-spacing"
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Count
              <input
                type="number"
                min="1"
                value={count}
                onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
                data-testid="pattern-count"
              />
            </label>
            <label>
              Sweep (°)
              <input
                type="number"
                value={totalAngle}
                onChange={(e) => setTotalAngle(Number(e.target.value) || 0)}
                data-testid="pattern-angle"
              />
            </label>
            <label>
              Centre X
              <input
                type="number"
                value={centerOverride ? centerOverride.x : Math.round(centroid.x * 1000) / 1000}
                onChange={(e) =>
                  setCenterOverride({ x: e.target.value, y: centerOverride?.y ?? String(centroid.y) })
                }
                data-testid="pattern-center-x"
              />
            </label>
            <label>
              Centre Y
              <input
                type="number"
                value={centerOverride ? centerOverride.y : Math.round(centroid.y * 1000) / 1000}
                onChange={(e) =>
                  setCenterOverride({ x: centerOverride?.x ?? String(centroid.x), y: e.target.value })
                }
                data-testid="pattern-center-y"
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={rotateItems}
                onChange={(e) => setRotateItems(e.target.checked)}
                data-testid="pattern-rotate"
              />
              Rotate copies to follow the circle
            </label>
            {centerOverride && (
              <button className="btn ghost sm" onClick={() => setCenterOverride(null)}>
                Reset centre to selection
              </button>
            )}
          </>
        )}
      </div>

      <div className="diagpanel-actions">
        <button
          className="btn primary"
          onClick={() => applyPattern(spec)}
          disabled={willAdd === 0}
          data-testid="pattern-apply"
        >
          Apply ({willAdd})
        </button>
      </div>

      <div className="diagpanel-list">
        <div className="diagpanel-empty" data-revision={revision}>
          {selection.length === 0
            ? "Select the geometry to repeat, then choose a layout."
            : `${selection.length} selected — ${willAdd} ${willAdd === 1 ? "copy" : "copies"} will be added as one undoable step.`}
        </div>
      </div>
    </aside>
  );
}
