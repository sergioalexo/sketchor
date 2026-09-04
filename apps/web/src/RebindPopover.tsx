import { useEffect, useState } from "react";
import { ACTIONS, bindingLabel, comboFromEvent, useKeybindings } from "./keybindings";

/**
 * A small popover for assigning/changing one action's keyboard shortcut,
 * opened by right-clicking a toolbar button (see App.tsx's `rebind(actionId)`
 * context-menu handler). The same actions and combos live in the Shortcuts
 * panel (ShortcutsPanel.tsx) for an at-a-glance view of everything at once.
 */
export function RebindPopover({
  actionId,
  x,
  y,
  onClose,
}: {
  actionId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const combo = useKeybindings((s) => s.bindings[actionId]);
  const setBinding = useKeybindings((s) => s.setBinding);
  const clearBinding = useKeybindings((s) => s.clearBinding);
  const resetBinding = useKeybindings((s) => s.resetBinding);
  const [capturing, setCapturing] = useState(false);
  const action = ACTIONS.find((a) => a.id === actionId);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;
      setBinding(actionId, comboFromEvent(e));
      setCapturing(false);
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, actionId, setBinding, onClose]);

  return (
    <div className="cmdpalette-backdrop" onMouseDown={onClose} style={{ background: "transparent" }}>
      <div
        className="rebind-popover"
        style={{ left: x, top: y }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="rebind-popover-title">{action?.label ?? actionId}</div>
        <button className="btn ghost sm" onClick={() => setCapturing(true)}>
          {capturing ? "Press a key…" : combo ? `Change (${bindingLabel(combo)})` : "Assign a shortcut"}
        </button>
        {combo && (
          <button
            className="btn ghost sm"
            onClick={() => {
              clearBinding(actionId);
              onClose();
            }}
          >
            Clear
          </button>
        )}
        <button
          className="btn ghost sm"
          onClick={() => {
            resetBinding(actionId);
            onClose();
          }}
        >
          Reset to default
        </button>
      </div>
    </div>
  );
}
