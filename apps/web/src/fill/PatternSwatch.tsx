import { useEffect, useRef } from "react";
import { gradientSpec, hatchFill, loopFromPoints, lookupPattern, type HatchPaint, type PatternFamily } from "@sketchor/core";

/**
 * A small canvas showing a hatch paint, drawn by the same engine as the
 * drawing itself (hatchFill). `families` overrides the lookup so the pattern
 * editor can preview text that is not registered yet.
 */
export function PatternSwatch({ paint, families, width = 96, height = 56 }: { paint: HatchPaint; families?: PatternFamily[]; width?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify([paint, families]);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (paint.kind === "solid") {
      ctx.fillStyle = paint.color;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (paint.kind === "gradient") {
      const spec = gradientSpec(paint, { minX: 0, minY: 0, maxX: W, maxY: H });
      if (!spec) return;
      const g = spec.kind === "linear" ? ctx.createLinearGradient(spec.x1, H - spec.y1, spec.x2, H - spec.y2) : ctx.createRadialGradient(spec.fx, H - spec.fy, 0, spec.cx, H - spec.cy, spec.r);
      for (const st of spec.stops) g.addColorStop(st.t, st.color);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const fams = families ?? paint.def ?? lookupPattern(paint.name)?.families;
    const spacing = Math.max(...(fams ?? [{ offset: { x: 0, y: 1 } }]).map((f) => Math.abs(f.offset.y)), 0.01) * paint.scale;
    // About ten repeats of the coarsest family, however large the pattern is.
    const world = Math.min(Math.max(spacing * 10, 1e-3), 1e6);
    const ppu = W / world;
    const loop = loopFromPoints([{ x: 0, y: 0 }, { x: world, y: 0 }, { x: world, y: H / ppu }, { x: 0, y: H / ppu }]);
    const f = hatchFill({ id: "sw", type: "hatch", loops: [loop], paint: families ? { ...paint, def: families } : paint, style: "normal" });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <canvas ref={ref} width={width} height={height} className="hatch-swatch" data-testid="hatch-swatch" style={{ border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)" }} />;
}
