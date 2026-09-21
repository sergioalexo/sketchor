import { useEffect, useRef, useState } from "react";
import { SNAP_KIND_LABELS, useSnapSettings } from "./tools/snapSettings";

/**
 * The status bar's SNAP button: a popover with one checkbox per object
 * snap kind (roadmap T-21). Click outside or Esc closes it.
 */
export function SnapPopover() {
  const settings = useSnapSettings((s) => s.settings);
  const toggle = useSnapSettings((s) => s.toggle);
  const setAll = useSnapSettings((s) => s.setAll);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        e.stopPropagation();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const onCount = Object.values(settings).filter(Boolean).length;
  const total = Object.keys(settings).length;
  return (
    <div className="snap-popover-wrap" ref={ref}>
      <button
        className={`tracking-toggle ${onCount > 0 ? "active" : ""}`}
        title={`Object snaps: ${onCount} of ${total} on — click to choose which kinds`}
        data-testid="toggle-snaps"
        onClick={() => setOpen((v) => !v)}
      >
        SNAP
      </button>
      {open && (
        <div className="snap-popover" data-testid="snap-popover">
          <div className="snap-popover-head">
            <span>Object snaps</span>
            <button className="btn ghost sm" onClick={() => setAll(true)}>
              All
            </button>
            <button className="btn ghost sm" onClick={() => setAll(false)}>
              None
            </button>
          </div>
          {SNAP_KIND_LABELS.map((k) => (
            <label key={k.id} className="snap-popover-row" title={k.hint}>
              <input type="checkbox" checked={settings[k.id]} onChange={() => toggle(k.id)} data-testid={`snap-${k.id}`} />
              <span>{k.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
