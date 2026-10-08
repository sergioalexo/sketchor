import { useEffect, useMemo, useRef } from "react";
import { PALETTE, PATTERN_CATEGORIES, fillToHatch, hatchFill, loopFromPoints, lookupPattern, newEntityId, registeredPatterns, type Command, type HatchEntity } from "@sketchor/core";
import { bus, doc, useApp, type HatchSettings } from "../state/store";
import { paintFromSettings } from "../tools/hatchTool";

/**
 * Floating panel of the Hatch tool (H-04, replaces the old FillPanel): paint
 * kind (pattern / solid / gradient), pattern picker with a live swatch drawn by
 * the same engine as the canvas, scale, angle, island style, gap tolerance and
 * the three pick modes. "Convert fills" upgrades legacy colour fills to solid
 * hatches in one undo step.
 */

function Swatch({ s }: { s: HatchSettings }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    const paint = paintFromSettings(s);
    if (paint.kind === "solid") {
      ctx.fillStyle = paint.color;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (paint.kind === "gradient") {
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, paint.colors[0]);
      g.addColorStop(1, paint.colors[1] ?? "#fff");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const def = lookupPattern(paint.name);
    const spacing = Math.max(...(def?.families ?? [{ offset: { x: 0, y: 1 } }]).map((f) => Math.abs(f.offset.y)), 0.01) * paint.scale;
    // Show about ten repeats of the coarsest family, however large the pattern is.
    const world = Math.min(Math.max(spacing * 10, 1e-3), 1e6);
    const ppu = W / world;
    const loop = loopFromPoints([{ x: 0, y: 0 }, { x: world, y: 0 }, { x: world, y: H / ppu }, { x: 0, y: H / ppu }]);
    const f = hatchFill({ id: "sw", type: "hatch", loops: [loop], paint, style: "normal" });
    ctx.strokeStyle = getComputedStyle(c).color || "#ccc";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1;
    if (f.truncated || f.unknownPattern) {
      ctx.globalAlpha = f.unknownPattern ? 0.15 : 0.5;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    ctx.beginPath();
    for (let i = 0; i < f.segments.length; i += 4) {
      ctx.moveTo(f.segments[i] * ppu, H - f.segments[i + 1] * ppu);
      ctx.lineTo(f.segments[i + 2] * ppu, H - f.segments[i + 3] * ppu);
    }
    ctx.stroke();
    for (let i = 0; i < f.dots.length; i += 2) ctx.fillRect(f.dots[i] * ppu - 0.75, H - f.dots[i + 1] * ppu - 0.75, 1.5, 1.5);
  }, [s.kind, s.pattern, s.scale, s.angle, s.solidColor, s.gradientColors]);
  return <canvas ref={ref} width={96} height={56} className="hatch-swatch" data-testid="hatch-swatch" style={{ border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)" }} />;
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
  const byCategory = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of registeredPatterns()) {
      const c = p.category ?? "Other";
      m.set(c, [...(m.get(c) ?? []), p.name]);
    }
    return [...m.entries()].sort((a, b) => (PATTERN_CATEGORIES.indexOf(a[0]) + 99) % 99 - (PATTERN_CATEGORIES.indexOf(b[0]) + 99) % 99);
  }, []);
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
          </div>
        </div>
      )}
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
          <label>
            Angle <input type="number" step="any" value={s.gradientAngle} style={{ width: 60 }} onChange={(e) => set({ gradientAngle: Number(e.target.value) || 0 })} />°
          </label>
        </div>
      )}
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
