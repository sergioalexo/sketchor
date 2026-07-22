import { closeTab, getSessions, newTab, switchToSession, useApp } from "../state/store";

/**
 * A tab per open drawing, shown above the canvas. Undo/redo, selection,
 * layers, and view are isolated per tab (see DocSession in state/store.ts).
 */
export function TabStrip() {
  const activeId = useApp((s) => s.activeSessionId);
  // Subscribed only to force a re-render when the session list itself changes
  // (new/closed tab, rename, dirty flag) — the actual data lives in getSessions().
  useApp((s) => s.sessionsVersion);
  const sessions = getSessions();

  return (
    <div className="tabstrip" data-testid="tab-strip">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`tab ${s.id === activeId ? "active" : ""}`}
          onClick={() => switchToSession(s.id)}
          data-testid={`tab-${s.id}`}
          title={s.name}
        >
          <span className="tab-name">{s.name}</span>
          {s.dirty && <span className="tab-dirty" title="Unsaved changes" />}
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(s.id);
            }}
            title="Close tab"
          >
            ✕
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={() => newTab()} title="New drawing">
        +
      </button>
    </div>
  );
}
