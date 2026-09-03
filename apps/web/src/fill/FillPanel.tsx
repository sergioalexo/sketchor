import { PALETTE, type Command, type Entity } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";

/**
 * Floating toolbar for the Fill/Hatch tool: pick a colour, then click a closed
 * shape on the canvas to hatch-fill it (see Viewport's `case "fill"`). The
 * buttons here apply to the whole current selection at once. Only shown while
 * the fill tool is active (see App.tsx).
 */

/** Closed shapes are the only ones a hatch fill means anything for. */
function isFillable(e: Entity | undefined): e is Entity {
  return !!e && (e.type === "circle" || (e.type === "polyline" && e.closed));
}

function applyToSelection(fill: string | undefined): void {
  const { selection } = useApp.getState();
  const targets = selection.map((id) => doc.get(id)).filter(isFillable);
  if (targets.length === 0) return;
  const commands: Command[] = targets.map((e) => {
    const entity = { ...e };
    if (fill) entity.fill = fill;
    else delete entity.fill;
    return { type: "update-entity", entity };
  });
  bus.execute(commands.length === 1 ? commands[0] : { type: "batch", commands });
}

export function FillPanel() {
  const fillColor = useApp((s) => s.fillColor);
  const setFillColor = useApp((s) => s.setFillColor);
  const selection = useApp((s) => s.selection);
  const revision = useApp((s) => s.revision);

  const fillableCount = selection
    .map((id) => doc.get(id))
    .filter(isFillable).length;

  return (
    <div className="fill-panel" data-testid="fill-panel" data-revision={revision}>
      <div className="fill-swatches">
        {PALETTE.map((c) => (
          <button
            key={c}
            className={`fill-swatch ${fillColor === c ? "active" : ""}`}
            style={{ background: c }}
            title={c}
            data-testid={`fill-swatch-${c}`}
            onClick={() => setFillColor(c)}
          />
        ))}
        <label className="fill-swatch fill-swatch-custom" title="Custom colour">
          <input
            type="color"
            value={fillColor}
            onChange={(e) => setFillColor(e.target.value)}
            data-testid="fill-custom"
          />
        </label>
      </div>
      <div className="fill-row">
        <span className="straighten-hint" data-testid="fill-status">
          {fillableCount > 0
            ? `${fillableCount} closed shape${fillableCount === 1 ? "" : "s"} selected`
            : "Click a closed shape, or select some first"}
        </span>
        <button
          className="btn ghost"
          disabled={fillableCount === 0}
          onClick={() => applyToSelection(fillColor)}
          data-testid="fill-apply"
        >
          Fill selection
        </button>
        <button
          className="btn ghost"
          disabled={fillableCount === 0}
          onClick={() => applyToSelection(undefined)}
          data-testid="fill-remove"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
