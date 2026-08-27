import { useMemo, useState } from "react";
import {
  buildNestCommands,
  clearPreviousLayout,
  LOAD_PLAN_LAYER,
  nestTruck,
  PLUGIN_ID,
  validateNest,
  type NestResult,
  type PalletItem,
  type TrailerProfile,
  type ValidationFinding,
} from "@sketchor/plugin-truck-nesting";
import { useApp } from "../../state/store";
import { createTruckNestingContext } from "./pluginContext";

/**
 * The reference plugin's panel (roadmap v0.11). Per the plugin-boundary
 * discipline in step 3 — "the nesting package may not import
 * @sketchor/core, the zustand store, or React" — all of the actual nesting
 * logic lives in `@sketchor/plugin-truck-nesting`, built against only
 * `@sketchor/plugin-api`; this file is the host's own React shell around
 * it, exactly like `pluginContext.ts` is the host's own command adapter.
 * Registering it here, in a hardcoded `showNesting` toggle in App.tsx, is
 * the "temporary hardcoded array" the roadmap describes for pre-registry
 * wiring — it becomes a real panel-contribution registry lookup in v0.10
 * without this component changing.
 */

let idCounter = 0;
function newItemId(): string {
  idCounter += 1;
  return `item-${idCounter}`;
}

function defaultTrailer(): TrailerProfile {
  return { name: "Standard 13.6m curtainsider", length: 13600, width: 2480, maxWeightKg: 24000 };
}

function defaultItem(stop: number): PalletItem {
  return { id: newItemId(), label: "EUR pallet", length: 1200, width: 800, weightKg: 400, qty: 4, stop, rotatable: true };
}

const LEVEL_LABEL: Record<ValidationFinding["level"], string> = { error: "Error", warn: "Warning", info: "OK" };

export function LoadPlanPanel({ onClose }: { onClose: () => void }) {
  const revision = useApp((s) => s.revision);
  const requestFit = useApp((s) => s.requestFit);
  const syncLayersFromDoc = useApp((s) => s.syncLayersFromDoc);

  const [trailer, setTrailer] = useState<TrailerProfile>(defaultTrailer);
  const [items, setItems] = useState<PalletItem[]>(() => [defaultItem(1), { ...defaultItem(2), label: "Half-pallet", length: 800, width: 600, weightKg: 250, qty: 3, stop: 2 }]);
  const [result, setResult] = useState<NestResult | null>(null);
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [notices, setNotices] = useState<{ level: "info" | "warn" | "error"; message: string }[]>([]);

  const totalWeightKg = useMemo(() => items.reduce((sum, it) => sum + it.weightKg * Math.max(0, it.qty), 0), [items]);

  const updateItem = (id: string, patch: Partial<PalletItem>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const removeItem = (id: string) => setItems((prev) => prev.filter((it) => it.id !== id));
  const addItem = () => setItems((prev) => [...prev, defaultItem(prev.length ? Math.max(...prev.map((it) => it.stop)) : 1)]);

  const runAutoNest = () => {
    setNotices([]);
    const ctx = createTruckNestingContext(PLUGIN_ID, (level, message) => setNotices((prev) => [...prev, { level, message }]));
    const nested = nestTruck(trailer, items);
    const commands = [...clearPreviousLayout(ctx), ...buildNestCommands(nested)];
    ctx.execute(commands, "Auto-nest load");
    syncLayersFromDoc();
    requestFit();
    setResult(nested);
    setFindings(validateNest(nested));
  };

  const clearLayout = () => {
    const ctx = createTruckNestingContext(PLUGIN_ID, () => {});
    ctx.execute(clearPreviousLayout(ctx), "Clear load plan");
    syncLayersFromDoc();
    setResult(null);
    setFindings([]);
    setNotices([]);
  };

  // Unload sequence: stop 1 first, off the back of the truck. Loading order is exactly the reverse.
  const byStop = useMemo(() => {
    if (!result) return [];
    const groups = new Map<number, typeof result.placed>();
    for (const p of result.placed) {
      const arr = groups.get(p.stop);
      if (arr) arr.push(p);
      else groups.set(p.stop, [p]);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [result]);

  return (
    <aside className="diagpanel nestpanel" data-testid="nesting-panel">
      <div className="diagpanel-header">
        <span>Load Plan — Truck Nesting</span>
        <button className="btn ghost" onClick={onClose} title="Hide panel">
          ✕
        </button>
      </div>

      <div className="nestpanel-section">
        <div className="nestpanel-section-title">Trailer</div>
        <div className="diagpanel-options nestpanel-trailer">
          <label>
            Name
            <input
              type="text"
              value={trailer.name}
              onChange={(e) => setTrailer((t) => ({ ...t, name: e.target.value }))}
              data-testid="nest-trailer-name"
            />
          </label>
          <label>
            Length (mm)
            <input
              type="number"
              min="0"
              value={trailer.length}
              onChange={(e) => setTrailer((t) => ({ ...t, length: Number(e.target.value) || 0 }))}
              data-testid="nest-trailer-length"
            />
          </label>
          <label>
            Width (mm)
            <input
              type="number"
              min="0"
              value={trailer.width}
              onChange={(e) => setTrailer((t) => ({ ...t, width: Number(e.target.value) || 0 }))}
              data-testid="nest-trailer-width"
            />
          </label>
          <label>
            Max weight (kg)
            <input
              type="number"
              min="0"
              value={trailer.maxWeightKg ?? 0}
              onChange={(e) => setTrailer((t) => ({ ...t, maxWeightKg: Number(e.target.value) || undefined }))}
              data-testid="nest-trailer-weight"
            />
          </label>
        </div>
      </div>

      <div className="nestpanel-section">
        <div className="nestpanel-section-title">
          Item catalogue
          <button className="btn ghost sm" onClick={addItem} data-testid="nest-item-add">
            + Add
          </button>
        </div>
        <div className="nestpanel-table-wrap">
          <table className="nestpanel-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>L</th>
                <th>W</th>
                <th>kg</th>
                <th>Qty</th>
                <th>Stop</th>
                <th>Rot.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} data-testid={`nest-item-row-${it.id}`}>
                  <td>
                    <input
                      type="text"
                      value={it.label}
                      onChange={(e) => updateItem(it.id, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={it.length}
                      onChange={(e) => updateItem(it.id, { length: Number(e.target.value) || 0 })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={it.width}
                      onChange={(e) => updateItem(it.id, { width: Number(e.target.value) || 0 })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={it.weightKg}
                      onChange={(e) => updateItem(it.id, { weightKg: Number(e.target.value) || 0 })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      value={it.qty}
                      onChange={(e) => updateItem(it.id, { qty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="1"
                      value={it.stop}
                      onChange={(e) => updateItem(it.id, { stop: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                    />
                  </td>
                  <td className="nestpanel-checkbox-cell">
                    <input
                      type="checkbox"
                      checked={it.rotatable}
                      onChange={(e) => updateItem(it.id, { rotatable: e.target.checked })}
                    />
                  </td>
                  <td>
                    <button className="btn ghost sm" onClick={() => removeItem(it.id)} title="Remove">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="nestpanel-totals">
          {items.reduce((n, it) => n + Math.max(0, it.qty), 0)} pallets, {Math.round(totalWeightKg)} kg total
        </div>
      </div>

      <div className="diagpanel-actions">
        <button className="btn primary" onClick={runAutoNest} disabled={items.length === 0} data-testid="nest-auto">
          Auto-nest
        </button>
        <button className="btn ghost" onClick={clearLayout} disabled={!result} data-testid="nest-clear">
          Clear layout
        </button>
      </div>

      <div className="diagpanel-list nestpanel-results" data-revision={revision}>
        {!result ? (
          <div className="diagpanel-empty">
            Set up the trailer and item catalogue, then Auto-nest. Pallets are packed into unload-stop zones — the last
            stop off the truck sits deepest, the first sits at the door — so the loading sequence is always safe to
            unload. Drawn on the "{LOAD_PLAN_LAYER}" layer.
          </div>
        ) : (
          <>
            <div className="nestpanel-section-title">
              Result — {result.placed.length} placed, {result.unplaced.length} unplaced, {Math.round(result.usedLength)} /{" "}
              {trailer.length} mm used
            </div>
            {findings.map((f, i) => (
              <div key={i} className={`nestpanel-finding nestpanel-finding-${f.level}`}>
                <span className="nestpanel-finding-level">{LEVEL_LABEL[f.level]}</span> {f.message}
              </div>
            ))}
            <div className="nestpanel-section-title">Unload sequence (loading order is the reverse)</div>
            {byStop.map(([stop, placedItems]) => {
              const weight = placedItems.reduce((sum, p) => sum + p.weightKg, 0);
              const counts = new Map<string, number>();
              for (const p of placedItems) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
              return (
                <div key={stop} className="nestpanel-stop" data-testid={`nest-stop-${stop}`}>
                  <div className="nestpanel-stop-head">
                    Stop {stop} — {placedItems.length} items, {Math.round(weight)} kg
                  </div>
                  <div className="nestpanel-stop-items">
                    {[...counts.entries()].map(([label, count]) => (
                      <span key={label}>
                        {count}× {label}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
        {notices.map((n, i) => (
          <div key={i} className={`nestpanel-finding nestpanel-finding-${n.level}`}>
            {n.message}
          </div>
        ))}
      </div>
    </aside>
  );
}
