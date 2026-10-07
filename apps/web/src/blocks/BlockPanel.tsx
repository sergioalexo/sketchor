import { uniqueBlockName } from "@sketchor/core";
import { doc, useApp, type BlockSettings } from "../state/store";

/**
 * Floating panel of the Create-block tool (B-03): name, what happens to the
 * selected objects, description, and the two definition flags. The base point
 * is the next click on the canvas.
 */
export function BlockPanel() {
  const s = useApp((st) => st.blockSettings);
  const set = useApp((st) => st.setBlockSettings);
  const selected = useApp((st) => st.selection.length);
  useApp((st) => st.revision);
  const placeholder = uniqueBlockName(doc);
  const taken = s.name.trim() !== "" && doc.hasRecord("blocks", s.name.trim());

  return (
    <div className="fill-panel" data-testid="block-panel" style={{ minWidth: 300 }}>
      <div className="fill-row">
        <label style={{ flex: 1 }}>
          Name{" "}
          <input type="text" value={s.name} placeholder={placeholder} data-testid="block-name" style={{ width: "70%" }} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <span className="straighten-hint" data-testid="block-count">{selected} selected</span>
      </div>
      {taken && <div className="straighten-hint" data-testid="block-taken">A block with this name already exists.</div>}
      <div className="fill-row">
        {(["convert", "retain", "delete"] as const).map((m) => (
          <button key={m} className={`btn ghost ${s.mode === m ? "active" : ""}`} data-testid={`block-mode-${m}`} onClick={() => set({ mode: m as BlockSettings["mode"] })} title={m === "convert" ? "Replace the objects by one insert" : m === "retain" ? "Keep the objects, add no insert" : "Remove the objects, add no insert"}>
            {m === "convert" ? "Convert" : m === "retain" ? "Retain" : "Delete"}
          </button>
        ))}
      </div>
      <div className="fill-row">
        <label style={{ flex: 1 }}>
          Description{" "}
          <input type="text" value={s.description} data-testid="block-description" style={{ width: "65%" }} onChange={(e) => set({ description: e.target.value })} />
        </label>
      </div>
      <div className="fill-row">
        <label>
          <input type="checkbox" checked={s.explodable} onChange={(e) => set({ explodable: e.target.checked })} /> Allow exploding
        </label>
        <label>
          <input type="checkbox" checked={s.scaleUniformly} onChange={(e) => set({ scaleUniformly: e.target.checked })} /> Scale uniformly
        </label>
      </div>
      <div className="fill-row">
        <span className="straighten-hint" data-testid="block-hint">Click the base point on the canvas</span>
      </div>
    </div>
  );
}
