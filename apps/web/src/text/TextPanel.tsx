import { useApp } from "../state/store";
import { factorFromMm } from "../units";

/**
 * Floating toolbar for the Text and Dimension tools: the one shared knob is the
 * text / label height (in the current display unit). Only shown while one of
 * those tools is active (see App.tsx).
 */
export function TextPanel() {
  const tool = useApp((s) => s.tool);
  const height = useApp((s) => s.textHeight);
  const setHeight = useApp((s) => s.setTextHeight);
  const unit = useApp((s) => s.displayUnit);
  const perMm = factorFromMm(unit);

  return (
    <div className="fill-panel" data-testid="text-panel">
      <div className="fill-row">
        <span className="straighten-label">{tool === "dim" ? "Label size" : "Text size"}</span>
        <input
          type="number"
          min="0.1"
          step="any"
          style={{ width: 80 }}
          value={Math.round(height * perMm * 100) / 100}
          onChange={(e) => setHeight((Number(e.target.value) || 0) / perMm)}
          data-testid="text-height"
        />
        <span className="straighten-label">{unit}</span>
      </div>
      <div className="fill-row">
        <span className="straighten-hint">
          {tool === "dim"
            ? "Click two points to dimension them."
            : "Click on the canvas and type. Double-click text to edit."}
        </span>
      </div>
    </div>
  );
}
