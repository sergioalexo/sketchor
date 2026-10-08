import { attributeCsv, attributeTable, type AttributeDef, type BlockDefinition } from "@sketchor/core";
import { doc, useApp } from "../state/store";
import { downloadText } from "./download";

/**
 * Floating panel of the Insert tool (B-05/B-06): pick the block, scale and
 * rotation, and fill the attribute prompts (blank = the block's default).
 */
export function InsertPanel() {
  const s = useApp((st) => st.insertSettings);
  const set = useApp((st) => st.setInsertSettings);
  useApp((st) => st.revision);
  const blocks = doc.records("blocks") as BlockDefinition[];
  const def = blocks.find((b) => b.name === s.block);
  const attrs = ((def?.attributeDefs ?? []) as AttributeDef[]).filter((a) => !a.flags?.constant);

  return (
    <div className="fill-panel" data-testid="insert-panel" style={{ minWidth: 300 }}>
      <div className="fill-row">
        <label style={{ flex: 1 }}>
          Block{" "}
          <select value={s.block} data-testid="insert-block" onChange={(e) => set({ block: e.target.value, values: {} })}>
            <option value="">(choose)</option>
            {blocks.map((b) => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
        </label>
        <label>
          Scale <input type="number" step="any" value={s.scale} data-testid="insert-scale" style={{ width: 60 }} onChange={(e) => set({ scale: parseFloat(e.target.value) })} />
        </label>
        <label>
          Rot <input type="number" step="any" value={s.rotation} data-testid="insert-rotation" style={{ width: 55 }} onChange={(e) => set({ rotation: parseFloat(e.target.value) })} />
        </label>
      </div>
      {attrs.map((a) => (
        <div className="fill-row" key={a.tag}>
          <label style={{ flex: 1 }}>
            {a.prompt || a.tag}{" "}
            <input
              type="text"
              value={s.values[a.tag] ?? ""}
              placeholder={a.default ?? a.fieldExpr ?? ""}
              data-testid={`insert-attr-${a.tag}`}
              style={{ width: "55%" }}
              onChange={(e) => set({ values: { ...s.values, [a.tag]: e.target.value } })}
            />
          </label>
        </div>
      ))}
      <div className="fill-row">
        <button
          className="btn ghost"
          data-testid="insert-export-attrs"
          title="Export every insert's attribute values as CSV"
          onClick={() => {
            const t = attributeTable(doc);
            if (t.rows.length > 0) downloadText("attributes.csv", attributeCsv(t), "text/csv");
          }}
        >
          Export attributes CSV
        </button>
      </div>
    </div>
  );
}
