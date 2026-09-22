import { useMemo, useState } from "react";
import { partOf } from "./measure";
import type { Model3D, ModelNode } from "./types";
import { useViewer } from "./viewerStore";

/**
 * The model tab's right-hand panel: the assembly structure, in the slot
 * layers occupy for a drawing. Layers mean nothing to a STEP file — its
 * hierarchy does, so a model tab shows that instead.
 *
 * Clicking a part selects it (the measurement readout then reports its
 * size, area and volume), double-clicking frames it, and the dot hides it.
 */
export function StructurePanel({ model }: { model: Model3D }) {
  const selection = useViewer((s) => s.selection);
  const hidden = useViewer((s) => s.hidden);
  const hover = useViewer((s) => s.hover);
  const pick = useViewer((s) => s.pick);
  const setHover = useViewer((s) => s.setHover);
  const toggleHidden = useViewer((s) => s.toggleHidden);
  const showAll = useViewer((s) => s.showAll);
  const requestFrame = useViewer((s) => s.requestFrame);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();

  // Which parts the current selection touches, so a picked face highlights its part in the tree.
  const selectedParts = useMemo(() => new Set(selection.map((r) => partOf(model, r))), [selection, model]);
  const hoveredPart = hover ? partOf(model, hover) : null;

  const rows: { key: string; depth: number; label: string; part: number | null }[] = [];
  const walk = (node: ModelNode, depth: number, key: string, isRoot: boolean) => {
    let childDepth = depth;
    if (!isRoot || node.children.length > 0) {
      rows.push({ key, depth, label: node.name || "Assembly", part: null });
      childDepth = depth + 1;
      if (collapsed.has(key) && !q) return;
    }
    for (const p of node.parts) {
      const name = model.parts[p].name;
      if (q && !name.toLowerCase().includes(q)) continue;
      rows.push({ key: `${key}/p${p}`, depth: childDepth, label: name, part: p });
    }
    node.children.forEach((c, i) => walk(c, childDepth, `${key}/${i}`, false));
  };
  walk(model.tree, 0, "root", true);

  return (
    <aside className="layerpanel" data-testid="structure-panel">
      <div className="layerpanel-header">
        <span>Structure</span>
        <button className="btn ghost sm" onClick={showAll} disabled={hidden.size === 0} title="Show every hidden part">
          Show all{hidden.size > 0 ? ` (${hidden.size})` : ""}
        </button>
      </div>
      <input
        className="filexplorer-search"
        type="search"
        placeholder="Filter parts…"
        value={filter}
        data-testid="structure-filter"
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="model-parts-list" onPointerLeave={() => setHover(null)}>
        {rows.map((r) =>
          r.part === null ? (
            <div
              key={r.key}
              className="model-parts-group"
              style={{ paddingLeft: 8 + r.depth * 12 }}
              onClick={() =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(r.key)) next.delete(r.key);
                  else next.add(r.key);
                  return next;
                })
              }
            >
              <span className="model-parts-caret">{collapsed.has(r.key) ? "▸" : "▾"}</span>
              {r.label}
            </div>
          ) : (
            <div
              key={r.key}
              className={`model-parts-row ${selectedParts.has(r.part) ? "selected" : ""} ${hidden.has(r.part) ? "hidden" : ""} ${hoveredPart === r.part ? "hovered" : ""}`}
              style={{ paddingLeft: 8 + r.depth * 12 }}
              data-testid={`structure-part-${r.part}`}
              onClick={(e) => pick({ kind: "part", index: r.part! }, e.shiftKey || e.ctrlKey || e.metaKey)}
              onDoubleClick={() => requestFrame(r.part!)}
              onPointerEnter={() => setHover({ kind: "part", index: r.part! })}
              title="Click to select · double-click to frame"
            >
              <button
                className="model-parts-eye"
                title={hidden.has(r.part) ? "Show" : "Hide"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleHidden(r.part!);
                }}
              >
                {hidden.has(r.part) ? "○" : "●"}
              </button>
              <span className="model-parts-name">{r.label}</span>
            </div>
          ),
        )}
      </div>
      <div className="structure-footer">
        {model.parts.length} parts · {model.faces.area.length} faces · {model.edgeTable.length.length} edges
      </div>
    </aside>
  );
}
