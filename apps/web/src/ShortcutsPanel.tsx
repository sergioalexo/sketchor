import { useEffect, useState } from "react";
import { ACTIONS, bindingLabel, comboFromEvent, useKeybindings, type ActionDef } from "./keybindings";

/**
 * The keyboard-shortcuts reference and settings surface: every rebindable
 * action (see keybindings.ts), grouped, with its current combo and a control
 * to change or clear it. The same rebind flow is reachable faster by
 * right-clicking a toolbar button (see RebindPopover.tsx) — this panel is the
 * place to see everything at once, per-tool mouse conventions included.
 */
export function ShortcutsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bindings = useKeybindings((s) => s.bindings);
  const setBinding = useKeybindings((s) => s.setBinding);
  const clearBinding = useKeybindings((s) => s.clearBinding);
  const resetBinding = useKeybindings((s) => s.resetBinding);
  const [capturing, setCapturing] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setCapturing(null);
  }, [open]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return; // wait for a real key
      setBinding(capturing, comboFromEvent(e));
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, setBinding]);

  if (!open) return null;

  const groups = new Map<string, ActionDef[]>();
  for (const a of ACTIONS) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group)!.push(a);
  }

  return (
    <div className="cmdpalette-backdrop" onMouseDown={onClose} data-testid="shortcuts-panel">
      <div className="shortcuts-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shortcuts-panel-head">
          <h2>Keyboard shortcuts</h2>
          <button className="shortcuts-panel-close" onClick={onClose} aria-label="Close">
            &#10005;
          </button>
        </div>
        <div className="shortcuts-panel-body">
          <div className="shortcuts-row">
            <span className="shortcuts-desc">
              Click a shortcut to rebind it (press the new key combo, or Esc to cancel) — or right-click any toolbar
              button that has one.
            </span>
          </div>
          {[...groups].map(([group, actions]) => (
            <div className="shortcuts-group" key={group}>
              <h3>{group}</h3>
              {actions.map((a) => (
                <div className="shortcuts-row" key={a.id}>
                  <span className="shortcuts-keys">
                    <button
                      className="shortcuts-rebind"
                      title="Click to change"
                      onClick={() => setCapturing(a.id)}
                    >
                      {capturing === a.id ? (
                        <kbd className="shortcut-key">Press a key…</kbd>
                      ) : bindings[a.id] ? (
                        <kbd className="shortcut-key">{bindingLabel(bindings[a.id])}</kbd>
                      ) : (
                        <span className="shortcuts-desc">unbound</span>
                      )}
                    </button>
                    {bindings[a.id] && (
                      <button className="shortcuts-panel-close" title="Clear" onClick={() => clearBinding(a.id)}>
                        &#10005;
                      </button>
                    )}
                    <button className="shortcuts-panel-close" title="Reset to default" onClick={() => resetBinding(a.id)}>
                      &#8635;
                    </button>
                  </span>
                  <span className="shortcuts-desc">{a.label}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="shortcuts-group">
            <h3>Mouse &amp; other keys</h3>
            <div className="shortcuts-row">
              <span className="shortcuts-desc">
                Shift-click adds to the selection; drag left-to-right window-selects, right-to-left crossing-selects;
                drag a selection to move it. Middle- or right-drag pans, the wheel zooms. Delete/Backspace deletes the
                selection. Escape always returns to the select tool. Ctrl (or Alt) held during a drag turns off
                snapping. These aren't rebindable.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
