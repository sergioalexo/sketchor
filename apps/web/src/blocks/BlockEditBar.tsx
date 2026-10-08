import { useState } from "react";
import { discardBlockEdit, saveBlockEdit, useApp } from "../state/store";

/**
 * B-04: the bar shown while a tab is editing a block definition. Edits are
 * already live in the drawing's instances; Save commits them as one undoable
 * update, Discard restores the old body.
 */
export function BlockEditBar() {
  const name = useApp((s) => s.editingBlock);
  const setTool = useApp((s) => s.setTool);
  const [error, setError] = useState("");
  if (!name) return null;
  return (
    <div className="fill-panel block-edit-bar" data-testid="block-edit-bar" style={{ flexDirection: "row", alignItems: "center", top: 8 }}>
      <strong>Editing block {name}</strong>
      <button className="btn" data-testid="block-edit-save" onClick={() => setError(saveBlockEdit() ?? "")}>Save</button>
      <button className="btn ghost" data-testid="block-edit-discard" onClick={() => discardBlockEdit()}>Discard</button>
      <button className="btn ghost" data-testid="block-edit-base" onClick={() => setTool("blockbase")}>Base point</button>
      {error && <span className="straighten-hint" data-testid="block-edit-error">{error}</span>}
    </div>
  );
}
