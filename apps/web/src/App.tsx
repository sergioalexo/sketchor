import { useState } from "react";
import { dist, freeEndpointEntityIds } from "@sketchor/core";
import { bus, doc, TOOL_HINTS, useApp, type ToolId } from "./state/store";
import { openSketchor, saveSketchor } from "./io/sketchorFile";
import { Viewport } from "./viewport/Viewport";
import { CodePanel } from "./code/CodePanel";
import { FileExplorerPanel } from "./browser/FileExplorerPanel";
import { DiagnosticsPanel } from "./heal/DiagnosticsPanel";
import { ImportReportBanner } from "./dxf/ImportReportBanner";
import { LayerPanel } from "./layers/LayerPanel";
import { StraightenPanel } from "./viewport/StraightenPanel";
import { TabStrip } from "./tabs/TabStrip";

const TOOLS: { id: ToolId; label: string; keyHint: string; icon: JSX.Element }[] = [
  {
    id: "select",
    label: "Select",
    keyHint: "V",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M6 3l12 9-5.2 1L15 19l-2.6 1.2-2.2-6L6 17z" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "line",
    label: "Line",
    keyHint: "L",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M4 20L20 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="4" cy="20" r="2.4" fill="currentColor" />
        <circle cx="20" cy="4" r="2.4" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "circle",
    label: "Circle",
    keyHint: "C",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" fill="none" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "measure",
    label: "Measure",
    keyHint: "M",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path
          d="M3 15L15 3l6 6L9 21z"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinejoin="round"
        />
        <path
          d="M14 4l2 2M11 7l2 2M8 10l2 2M5 13l2 2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "straighten",
    label: "Straighten",
    keyHint: "T",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path
          d="M4 17L15 6M15 6h-5M15 6v5"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function App() {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  const cursor = useApp((s) => s.cursor);
  const zoom = useApp((s) => s.zoom);
  const revision = useApp((s) => s.revision);
  const selection = useApp((s) => s.selection);
  const measurement = useApp((s) => s.measurement);
  const [showCode, setShowCode] = useState(false);
  const [showLayers, setShowLayers] = useState(true);
  const [showDiag, setShowDiag] = useState(false);
  const showFiles = useApp((s) => s.fileBrowserVisible);
  const setShowFiles = useApp((s) => s.setFileBrowserVisible);
  const showConnectivityHint = useApp((s) => s.showConnectivityHint);
  const setShowConnectivityHint = useApp((s) => s.setShowConnectivityHint);

  const measuredDistance = measurement ? dist(measurement.a, measurement.b) : null;
  // Recomputed every render (cheap, matches the entity-count footer pattern below); `revision` forces the re-render.
  const freeEndpointCount = showConnectivityHint ? freeEndpointEntityIds(doc).size : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path
              d="M4 18L11 5l3.5 6.5L18 6l2 12"
              stroke="currentColor"
              strokeWidth="2.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Sketchor
        </div>
        <div className="topbar-actions">
          <button
            className="action"
            title="Open .sketchor drawing (Ctrl+O)"
            data-testid="open-file"
            onClick={() => void openSketchor()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="action"
            title="Save as .sketchor (Ctrl+S)"
            data-testid="save-file"
            onClick={() => void saveSketchor()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M5 3h11l3 3v13a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinejoin="round"
              />
              <path d="M8 3v5h6V3M8 21v-6h8v6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="action-sep" />
          <button
            className="action"
            title="Undo (Ctrl+Z)"
            disabled={!bus.canUndo}
            onClick={() => bus.undo()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M8 6L3 11l5 5M3.5 11H15a5 5 0 010 10h-3"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="action"
            title="Redo (Ctrl+Y)"
            disabled={!bus.canRedo}
            onClick={() => bus.redo()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M16 6l5 5-5 5M20.5 11H9a5 5 0 000 10h3"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className={`action ${showLayers ? "toggled" : ""}`}
            title="Toggle layers panel"
            data-testid="toggle-layers"
            onClick={() => setShowLayers((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5"
                stroke="currentColor"
                strokeWidth="1.8"
                fill="none"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className={`action ${showCode ? "toggled" : ""}`}
            title="Toggle sketch code panel"
            data-testid="toggle-code"
            onClick={() => setShowCode((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M9 6l-6 6 6 6M15 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className={`action ${showDiag ? "toggled" : ""}`}
            title="Toggle diagnostics (find & heal unjointed lines)"
            data-testid="toggle-diagnostics"
            onClick={() => setShowDiag((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M12 2v6M12 16v6M2 12h6M16 12h6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
          </button>
          <button
            className={`action ${showFiles ? "toggled" : ""}`}
            title="Toggle file browser"
            data-testid="toggle-file-browser"
            onClick={() => setShowFiles(!showFiles)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M3 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v1H3zM3 9h18v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className={`action ${showConnectivityHint ? "toggled" : ""}`}
            title="Toggle connectivity hint — endpoints with nothing joined to them turn blue. This is NOT real constraint status (no solver yet), just a free-endpoint heuristic."
            data-testid="toggle-connectivity-hint"
            onClick={() => setShowConnectivityHint(!showConnectivityHint)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M4 18L10 8l4 5 6-9"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="4" cy="18" r="1.8" fill="currentColor" />
              <circle cx="20" cy="4" r="1.8" fill="currentColor" />
            </svg>
          </button>
        </div>
        <div className="hint">{TOOL_HINTS[tool]}</div>
      </header>

      <ImportReportBanner />

      <div className="body">
        <nav className="toolrail">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool ${tool === t.id ? "active" : ""}`}
              title={`${t.label} (${t.keyHint})`}
              data-testid={`tool-${t.id}`}
              onClick={() => setTool(t.id)}
            >
              {t.icon}
              <span className="keyhint">{t.keyHint}</span>
            </button>
          ))}
        </nav>
        {showFiles && <FileExplorerPanel onClose={() => setShowFiles(false)} />}
        <div className="center">
          <TabStrip />
          <main className="stage">
            <Viewport />
            {tool === "straighten" && <StraightenPanel />}
          </main>
        </div>
        {showDiag && <DiagnosticsPanel onClose={() => setShowDiag(false)} />}
        {showLayers && <LayerPanel />}
        {showCode && <CodePanel />}
      </div>

      <footer className="statusbar" data-revision={revision}>
        <span data-testid="coords">
          {cursor ? `${cursor.x.toFixed(2)}, ${cursor.y.toFixed(2)}` : "--, --"}
        </span>
        <span>{Math.round(zoom * 100)}%</span>
        <span data-testid="entity-count">{doc.all().length} entities</span>
        <span>{selection.length > 0 ? `${selection.length} selected` : ""}</span>
        {measuredDistance !== null && (
          <span className="measure-readout" data-testid="measure-readout">
            distance {measuredDistance.toFixed(2)}
          </span>
        )}
        {showConnectivityHint && (
          <span
            className="connectivity-readout"
            data-testid="connectivity-readout"
            title="Free-endpoint heuristic, not real constraint status — see the toggle's tooltip"
          >
            {freeEndpointCount === 0 ? "No free endpoints (hint)" : `${freeEndpointCount} with a free endpoint (hint)`}
          </span>
        )}
      </footer>
    </div>
  );
}
