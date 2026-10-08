import { useMemo, useState } from "react";
import { GRADIENT_NAMES, PALETTE, PATTERN_CATEGORIES, fillToHatch, lookupPattern, newEntityId, registeredPatterns, type Command, type HatchEntity } from "@sketchor/core";
import { bus, doc, useApp, type HatchSettings } from "../state/store";
import { paintFromSettings } from "../tools/hatchTool";
import { PatternSwatch } from "./PatternSwatch";
import { PatternLibrary } from "./PatternLibrary";
import { loadUserPatterns } from "./userLibrary";

loadUserPatterns();

/**
 * Floating panel of the Hatch tool (H-04, replaces the old FillPanel): paint
 * kind (pattern / solid / gradient), pattern picker with a live swatch drawn by
 * the same engine as the canvas, scale, angle, island style, gap tolerance and
 * the three pick modes. "Convert fills" upgrades legacy colour fills to solid
 * hatches in one undo step.
 */

function Swatch({ s }: { s: HatchSettings }) {
  return <PatternSwatch paint={paintFromSettings(s)} />;
}

function convertFills(): number {
  const commands: Command[] = [];
  for (const e of doc.all()) {
    const h: HatchEntity | null = fillToHatch(e, newEntityId());
    if (!h) continue;
    const bare = { ...e } as Record<string, unknown>;
    delete bare.fill;
    commands.push({ type: "update-entity", entity: bare as unknown as typeof e }, { type: "add-entity", entity: h });
  }
  if (commands.length) bus.execute(commands.length === 1 ? commands[0] : { type: "batch", commands });
  return commands.length / 2;
}

export function HatchPanel() {
  const s = useApp((st) => st.hatchSettings);
  const set = useApp((st) => st.setHatchSettings);
  const revision = useApp((st) => st.revision);
  const [showLib, setShowLib] = useState(false);
  const byCategory = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of registeredPatterns()) {
      const c = p.category ?? "Other";
      m.set(c, [...(m.get(c) ?? []), p.name]);
    }
    return [...m.entries()].sort((a, b) => (PATTERN_CATEGORIES.indexOf(a[0]) + 99) % 99 - (PATTERN_CATEGORIES.indexOf(b[0]) + 99) % 99);
  }, [revision, showLib]);
  const def = lookupPattern(s.pattern);
  const filledCount = doc.all().filter((e) => "fill" in e && e.fill).length;

  return (
    <div className="fill-panel" data-testid="hatch-panel" data-revision={revision} style={{ minWidth: 320 }}>
      <div className="fill-row">
        {(["pattern", "solid", "gradient"] as const).map((k) => (
          <button key={k} className={`btn ghost ${s.kind === k ? "active" : ""}`} data-testid={`hatch-kind-${k}`} onClick={() => set({ kind: k })}>
            {k === "pattern" ? "Pattern" : k === "solid" ? "Solid" : "Gradient"}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {(["point", "objects", "match"] as const).map((m) => (
          <button key={m} className={`btn ghost ${s.mode === m ? "active" : ""}`} data-testid={`hatch-mode-${m}`} onClick={() => set({ mode: m })} title={m === "point" ? "Click inside a region" : m === "objects" ? "Pick boundary objects, Enter" : "Copy another hatch"}>
            {m === "point" ? "Points" : m === "objects" ? "Objects" : "Match"}
          </button>
        ))}
      </div>
      {s.kind === "pattern" && (
        <div className="fill-row">
          <Swatch s={s} />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
            <select value={s.pattern} data-testid="hatch-pattern" onChange={(e) => set({ pattern: e.target.value, scale: lookupPattern(e.target.value)?.defaultScale?.mm ?? 1 })}>
              {!def && <option value={s.pattern}>{s.pattern} (not in library)</option>}
              {byCategory.map(([cat, names]) => (
                <optgroup key={cat} label={cat}>
                  {names.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="straighten-hint" data-testid="hatch-desc">{def?.description ?? ""}</span>
            <button className={`btn ghost ${showLib ? "active" : ""}`} data-testid="hatch-library" onClick={() => setShowLib(!showLib)}>Library…</button>
          </div>
        </div>
      )}
      {s.kind === "pattern" && showLib && <PatternLibrary current={s.pattern} onPick={(p) => set({ pattern: p.name, scale: p.defaultScale?.mm ?? 1 })} />}
      {s.kind === "pattern" && (
        <div className="fill-row">
          <label>
            Scale{" "}
            <input type="number" min={0.001} step="any" value={s.scale} style={{ width: 70 }} data-testid="hatch-scale" onChange={(e) => Number(e.target.value) > 0 && set({ scale: Number(e.target.value) })} />
          </label>
          <label>
            Angle{" "}
            <input type="number" step="any" value={s.angle} style={{ width: 60 }} data-testid="hatch-angle" onChange={(e) => set({ angle: Number(e.target.value) || 0 })} />°
          </label>
        </div>
      )}
      {s.kind === "solid" && (
        <div className="fill-swatches">
          {PALETTE.map((c) => (
            <button key={c} className={`fill-swatch ${s.solidColor === c ? "active" : ""}`} style={{ background: c }} title={c} data-testid={`hatch-swatch-${c}`} onClick={() => set({ solidColor: c })} />
          ))}
          <label className="fill-swatch fill-swatch-custom" title="Custom colour">
            <input type="color" value={s.solidColor} onChange={(e) => set({ solidColor: e.target.value })} data-testid="hatch-custom" />
          </label>
        </div>
      )}
      {s.kind === "gradient" && (
        <div className="fill-row">
          <Swatch s={s} />
          <input type="color" value={s.gradientColors[0]} data-testid="hatch-grad-1" onChange={(e) => set({ gradientColors: [e.target.value, s.gradientColors[1]] })} />
          <input type="color" value={s.gradientColors[1]} data-testid="hatch-grad-2" onChange={(e) => set({ gradientColors: [s.gradientColors[0], e.target.value] })} />
          <select value={s.gradientName} data-testid="hatch-grad-name" onChange={(e) => set({ gradientName: e.target.value })}>
            {GRADIENT_NAMES.map((n) => (
              <option key={n} value={n}>
                {n.charAt(0) + n.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      )}
      {s.kind === "gradient" && (
        <div className="fill-row">
          <label>
            Angle <input type="number" step="any" value={s.gradientAngle} style={{ width: 60 }} data-testid="hatch-grad-angle" onChange={(e) => set({ gradientAngle: Number(e.target.value) || 0 })} />°
          </label>
          <label title="Off: the highlight moves by the shift amount">
            <input type="checkbox" checked={s.gradientCentered} data-testid="hatch-grad-centered" onChange={(e) => set({ gradientCentered: e.target.checked })} /> Centered
          </label>
          <label>
            Shift <input type="number" step={0.1} min={-1} max={1} disabled={s.gradientCentered} value={s.gradientShift} style={{ width: 55 }} onChange={(e) => set({ gradientShift: Math.max(-1, Math.min(1, Number(e.target.value) || 0)) })} />
          </label>
        </div>
      )}
      <div className="fill-row">
        <label title="0 = opaque, 100 = invisible">
          Transparency{" "}
          <input type="number" min={0} max={100} step={5} value={Math.round(s.transparency * 100)} style={{ width: 55 }} data-testid="hatch-transparency" onChange={(e) => set({ transparency: Math.max(0, Math.min(1, (Number(e.target.value) || 0) / 100)) })} />%
        </label>
        {s.kind === "pattern" && (
          <label title="Colour filled behind the pattern lines">
            <input type="checkbox" checked={s.backgroundColor !== ""} data-testid="hatch-bg-on" onChange={(e) => set({ backgroundColor: e.target.checked ? "#ffffcc" : "" })} /> Background{" "}
            <input type="color" value={s.backgroundColor || "#ffffcc"} disabled={s.backgroundColor === ""} data-testid="hatch-bg" onChange={(e) => set({ backgroundColor: e.target.value })} />
          </label>
        )}
      </div>
      <div className="fill-row">
        <label>
          Islands{" "}
          <select value={s.style} data-testid="hatch-style" onChange={(e) => set({ style: e.target.value as HatchSettings["style"] })}>
            <option value="normal">Normal</option>
            <option value="outer">Outer</option>
            <option value="ignore">Ignore</option>
          </select>
        </label>
        <label title="Endpoints closer than this count as joined (AutoCAD HPGAPTOL)">
          Gap tolerance{" "}
          <input type="number" min={0} step="any" value={s.gapTol} style={{ width: 60 }} data-testid="hatch-gap" onChange={(e) => set({ gapTol: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <label title="The hatch follows its boundary objects when they change">
          <input type="checkbox" checked={s.associative} data-testid="hatch-assoc" onChange={(e) => set({ associative: e.target.checked })} /> Associative
        </label>
      </div>
      <div className="fill-row">
        <span className="straighten-hint" data-testid="hatch-hint">
          {s.mode === "match" ? "Click a hatch to copy it" : s.mode === "objects" ? "Click boundary objects, Enter to hatch" : "Click inside a closed region; Shift+click collects several"}
        </span>
        <button className="btn ghost" disabled={filledCount === 0} data-testid="hatch-convert" onClick={convertFills} title="Turn legacy colour fills into solid hatches">
          Convert fills ({filledCount})
        </button>
      </div>
    </div>
  );
}
