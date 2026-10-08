import { useEffect, useState } from "react";
import { attributeValue, editableAttributes, withAttributeValues } from "@sketchor/core";
import { bus, doc, useApp } from "../state/store";

/** ATTEDIT (B-05): one field per editable tag of the chosen insert; OK applies them as a single undoable update. */
export function AttEditDialog() {
  const id = useApp((s) => s.atteditId);
  const close = useApp((s) => s.setAttedit);
  const [values, setValues] = useState<Record<string, string>>({});
  const insert = id ? doc.get(id) : undefined;
  const defs = insert && insert.type === "insert" ? editableAttributes(doc, insert) : [];

  useEffect(() => {
    if (insert && insert.type === "insert") {
      setValues(Object.fromEntries(defs.map((a) => [a.tag, insert.attributes[a.tag] ?? ""])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!id || !insert || insert.type !== "insert") return null;
  const apply = () => {
    bus.execute({ type: "update-entity", entity: withAttributeValues(insert, values) });
    close(null);
  };
  return (
    <div className="fill-panel" data-testid="attedit-dialog" style={{ minWidth: 320, top: "30%" }}>
      <strong>Attributes of {insert.block}</strong>
      {defs.length === 0 && <div className="straighten-hint">This block has no editable attributes.</div>}
      {defs.map((a) => (
        <div className="fill-row" key={a.tag}>
          <label style={{ flex: 1 }}>
            {a.prompt || a.tag}{" "}
            <input
              type="text"
              value={values[a.tag] ?? ""}
              placeholder={attributeValue(a, { attributes: {} })}
              data-testid={`attedit-${a.tag}`}
              style={{ width: "55%" }}
              onChange={(e) => setValues({ ...values, [a.tag]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply();
                if (e.key === "Escape") close(null);
              }}
            />
          </label>
        </div>
      ))}
      <div className="fill-row">
        <button className="btn" data-testid="attedit-ok" onClick={apply}>OK</button>
        <button className="btn ghost" data-testid="attedit-cancel" onClick={() => close(null)}>Cancel</button>
      </div>
    </div>
  );
}
