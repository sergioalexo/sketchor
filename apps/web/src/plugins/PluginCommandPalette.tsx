import { useEffect, useMemo, useRef, useState } from "react";
import { listActions, onRegistriesChange, runCommand, runGenerator, type CommandListItem } from "./host/registries";

/**
 * A minimal command palette (Ctrl/Cmd-K) over the plugin contribution
 * registries — the Phase 2 entry point for running contributed commands and
 * generators from the UI. It reads {@link listActions} and re-renders whenever a
 * plugin loads or unloads; selecting an item routes back into that plugin's
 * sandbox via the host. Third-party command contributions appear here for free
 * once installed (Phase 4/5).
 */
export function PluginCommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [version, setVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-render when the registries change (plugins load asynchronously at start).
  useEffect(() => onRegistriesChange(() => setVersion((v) => v + 1)), []);

  const actions = useMemo(() => listActions(), [version, open]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setStatus(null);
      setActive(0);
      // Focus after the element mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const run = async (item: CommandListItem) => {
    setStatus(`Running ${item.title}…`);
    try {
      if (item.kind === "command") {
        await runCommand(item.id);
        onClose();
      } else {
        const added = await runGenerator(item.id);
        if (added > 0) {
          onClose();
        } else {
          setStatus(`${item.title}: nothing to generate — select some geometry first.`);
        }
      }
    } catch (err) {
      setStatus(`${item.title} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[active];
      if (item) void run(item);
    }
  };

  return (
    <div className="cmdpalette-backdrop" onMouseDown={onClose} data-testid="command-palette">
      <div className="cmdpalette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="cmdpalette-input"
          placeholder="Run a plugin command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="command-palette-input"
        />
        <div className="cmdpalette-list">
          {filtered.length === 0 ? (
            <div className="cmdpalette-empty">
              {actions.length === 0 ? "No plugin commands available." : "No matches."}
            </div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                className={`cmdpalette-item${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => void run(item)}
              >
                <span className="cmdpalette-item-title">{item.title}</span>
                <span className="cmdpalette-item-kind">{item.kind}</span>
              </button>
            ))
          )}
        </div>
        {status && <div className="cmdpalette-status">{status}</div>}
      </div>
    </div>
  );
}
