import { FIELD_NAMES } from "@sketchor/core";
import { activeBlockEdit, setBlockEditAttributes, useApp, type AttdefSettings } from "../state/store";

/** Floating panel of the Attribute-definition tool (B-05): tag, prompt, default/field, height, flags, and the block's current attributes. */
export function AttdefPanel() {
  const s = useApp((st) => st.attdefSettings);
  const set = useApp((st) => st.setAttdefSettings);
  useApp((st) => st.sessionsVersion);
  const edit = activeBlockEdit();
  const flag = (key: "invisible" | "constant" | "verify" | "preset" | "multiline", label: string) => (
    <label key={key}>
      <input type="checkbox" checked={s[key]} onChange={(e) => set({ [key]: e.target.checked } as Partial<AttdefSettings>)} /> {label}
    </label>
  );
  return (
    <div className="fill-panel" data-testid="attdef-panel" style={{ minWidth: 320 }}>
      {!edit && <div className="straighten-hint">Open a block for editing first (double-click an insert).</div>}
      <div className="fill-row">
        <label style={{ flex: 1 }}>
          Tag <input type="text" value={s.tag} data-testid="attdef-tag" style={{ width: "40%" }} onChange={(e) => set({ tag: e.target.value })} />
        </label>
        <label>
          Height <input type="number" step="any" value={s.height} data-testid="attdef-height" style={{ width: 55 }} onChange={(e) => set({ height: parseFloat(e.target.value) })} />
        </label>
      </div>
      <div className="fill-row">
        <label style={{ flex: 1 }}>
          Prompt <input type="text" value={s.prompt} data-testid="attdef-prompt" style={{ width: "70%" }} onChange={(e) => set({ prompt: e.target.value })} />
        </label>
      </div>
      <div className="fill-row">
        <label style={{ flex: 1 }}>
          Default <input type="text" value={s.default} data-testid="attdef-default" style={{ width: "70%" }} onChange={(e) => set({ default: e.target.value })} />
        </label>
      </div>
      <div className="fill-row">
        <label style={{ flex: 1 }} title={`Fields: ${FIELD_NAMES.map((f) => `{{${f}}}`).join(" ")}`}>
          Field <input type="text" value={s.fieldExpr} placeholder="{{filename}}" data-testid="attdef-field" style={{ width: "70%" }} onChange={(e) => set({ fieldExpr: e.target.value })} />
        </label>
      </div>
      <div className="fill-row">
        {flag("invisible", "Invisible")}
        {flag("constant", "Constant")}
        {flag("verify", "Verify")}
        {flag("preset", "Preset")}
      </div>
      {edit && edit.attributeDefs.length > 0 && (
        <div className="fill-row" style={{ flexWrap: "wrap" }} data-testid="attdef-list">
          {edit.attributeDefs.map((a) => (
            <span key={a.tag} className="straighten-hint">
              {a.tag}{" "}
              <button className="btn ghost" title="Remove this attribute" onClick={() => setBlockEditAttributes(edit.attributeDefs.filter((x) => x.tag !== a.tag))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
