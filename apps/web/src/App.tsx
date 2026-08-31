import { useEffect, useState } from "react";
import { freeEndpointEntityIds } from "@sketchor/core";
import { bus, doc, measurementText, TOOL_HINTS, useApp, type ToolId } from "./state/store";
import { activeSaveTarget, openDrawing, overlayDrawing, saveCurrent, saveDrawing } from "./io/drawingFile";
import { DISPLAY_UNITS, formatLength, type DisplayUnit } from "./units";
import { Viewport } from "./viewport/Viewport";
import { CodePanel } from "./code/CodePanel";
import { FileExplorerPanel } from "./browser/FileExplorerPanel";
import { DiagnosticsPanel } from "./heal/DiagnosticsPanel";
import { DuplicatesPanel } from "./heal/DuplicatesPanel";
import { ImportReportBanner } from "./dxf/ImportReportBanner";
import { LayerPanel } from "./layers/LayerPanel";
import { PatternPanel } from "./pattern/PatternPanel";
import { PluginCommandPalette } from "./plugins/PluginCommandPalette";
import { listExporters, onRegistriesChange, runExporter } from "./plugins/host/registries";
import { StraightenPanel } from "./viewport/StraightenPanel";
import { TabStrip } from "./tabs/TabStrip";
import { UpdateBanner, UpdateButton } from "./update/UpdatePanel";
import { openExternal } from "./update/updateService";

/**
 * The project's home page, opened by the logo in the toolbar. Must stay
 * inside the opener scope in src-tauri/capabilities/default.json — the
 * desktop build refuses any URL that isn't listed there.
 */
const SKETCHOR_SITE = "https://sketchor.sergioalexo.com/";

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
    id: "polyline",
    label: "Polyline",
    keyHint: "W",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M3 18l5-9 5 5 8-9" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="3" cy="18" r="2" fill="currentColor" />
        <circle cx="8" cy="9" r="2" fill="currentColor" />
        <circle cx="13" cy="14" r="2" fill="currentColor" />
        <circle cx="21" cy="5" r="2" fill="currentColor" />
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
    id: "point",
    label: "Point",
    keyHint: "P",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path d="M12 4v6M12 14v6M4 12h6M14 12h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

/**
 * Runs a plugin-contributed exporter and downloads its output. Plugin IO sits
 * alongside the built-in DXF/SVG saves; unlike those it isn't bound to a save
 * target (no round-trip file handle), so it always triggers a fresh download.
 */
async function exportViaPlugin(id: string, ext: string): Promise<void> {
  const { setSaveNotice } = useApp.getState();
  try {
    const text = await runExporter(id);
    const target = activeSaveTarget();
    const base = (target?.name ?? "drawing").replace(/\.(dxf|svg|dwg)$/i, "");
    const blob = new Blob([text], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setSaveNotice({ kind: "saved", message: `Exported ${base}.${ext}`, at: Date.now() });
  } catch (err) {
    setSaveNotice({ kind: "error", message: `Export failed: ${err instanceof Error ? err.message : String(err)}`, at: Date.now() });
  }
}

export function App() {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  const cursor = useApp((s) => s.cursor);
  const zoom = useApp((s) => s.zoom);
  const revision = useApp((s) => s.revision);
  const selection = useApp((s) => s.selection);
  const measurement = useApp((s) => s.measurement);
  const pinnedMeasurements = useApp((s) => s.pinnedMeasurements);
  const pinMeasurement = useApp((s) => s.pinMeasurement);
  const clearPinnedMeasurements = useApp((s) => s.clearPinnedMeasurements);
  const referenceEdgeId = useApp((s) => s.referenceEdgeId);
  const saveNotice = useApp((s) => s.saveNotice);
  const setSaveNotice = useApp((s) => s.setSaveNotice);

  // A save confirmation is transient — clear it a few seconds after it lands.
  useEffect(() => {
    if (!saveNotice) return;
    const t = setTimeout(() => setSaveNotice(null), saveNotice.kind === "error" ? 8000 : 3000);
    return () => clearTimeout(t);
  }, [saveNotice, setSaveNotice]);
  const [showCode, setShowCode] = useState(false);
  const [showLayers, setShowLayers] = useState(true);
  const [showDiag, setShowDiag] = useState(false);
  const [showDup, setShowDup] = useState(false);
  const [showPattern, setShowPattern] = useState(false);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [showUpdateMenu, setShowUpdateMenu] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  // Bumped when plugins load/unload, so the export menu re-reads its list.
  const [pluginVersion, setPluginVersion] = useState(0);
  const showFiles = useApp((s) => s.fileBrowserVisible);
  const setShowFiles = useApp((s) => s.setFileBrowserVisible);
  const showConnectivityHint = useApp((s) => s.showConnectivityHint);
  const setShowConnectivityHint = useApp((s) => s.setShowConnectivityHint);
  const showClosedRegions = useApp((s) => s.showClosedRegions);
  const setShowClosedRegions = useApp((s) => s.setShowClosedRegions);
  const displayUnit = useApp((s) => s.displayUnit);
  const setDisplayUnit = useApp((s) => s.setDisplayUnit);

  // Ctrl/Cmd-K opens the plugin command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Refresh plugin-derived menus (export list) as plugins load/unload.
  useEffect(() => onRegistriesChange(() => setPluginVersion((v) => v + 1)), []);

  // Close the Save-format and update popovers on an outside click.
  useEffect(() => {
    if (!showSaveMenu && !showUpdateMenu) return;
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".action-menu-wrap")) return;
      setShowSaveMenu(false);
      setShowUpdateMenu(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [showSaveMenu, showUpdateMenu]);

  // Which real file a plain Save would overwrite. Subscribing to
  // `sessionsVersion` is what makes it refresh: the binding itself lives in
  // drawingFile.ts, but every event that changes it (opening a file, Save As,
  // switching tabs) bumps that counter.
  useApp((s) => s.sessionsVersion);
  const saveTarget = activeSaveTarget();

  const referenceEdge = referenceEdgeId ? doc.get(referenceEdgeId) : null;
  const referenceAngleDeg =
    referenceEdge?.type === "line" ? (Math.atan2(referenceEdge.b.y - referenceEdge.a.y, referenceEdge.b.x - referenceEdge.a.x) * 180) / Math.PI : null;

  const [justCopied, setJustCopied] = useState(false);
  const copyMeasurement = () => {
    if (!measurement) return;
    void navigator.clipboard.writeText(measurementText(measurement, displayUnit, referenceAngleDeg)).then(() => {
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1200);
    });
  };

  // Recomputed every render (cheap, matches the entity-count footer pattern below); `revision` forces the re-render.
  const freeEndpointCount = showConnectivityHint ? freeEndpointEntityIds(doc).size : 0;

  // `revision` (read via the hook above) forces this to recompute after edits/undo.
  const selectionLabel = (ids: string[]): string => {
    if (ids.length === 0) return "";
    const counts = new Map<string, number>();
    for (const id of ids) {
      const e = doc.get(id);
      if (e) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }
    if (counts.size === 1) {
      const [[type, n]] = counts;
      return ids.length === 1 ? `1 ${type} selected` : `${n} ${type}s selected`;
    }
    const parts = [...counts.entries()].map(([type, n]) => `${n} ${type}${n > 1 ? "s" : ""}`);
    return `${ids.length} selected (${parts.join(", ")})`;
  };

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="brand"
          type="button"
          title="Open sketchor.sergioalexo.com"
          data-testid="brand-link"
          onClick={() => void openExternal(SKETCHOR_SITE)}
        >
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
        </button>
        <div className="topbar-actions">
          <button
            className="action"
            title="Open DXF / SVG / DWG drawing (Ctrl+O)"
            data-testid="open-file"
            onClick={() => void openDrawing()}
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
            title="Overlay a DXF / SVG / DWG onto the current drawing, on its own layer — for comparing two revisions"
            data-testid="overlay-file"
            onClick={() => void overlayDrawing()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <rect x="3" y="7" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="2" fill="none" />
              <rect x="8" y="4" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.6" />
            </svg>
          </button>
          <div className="action-menu-wrap">
            <button
              className="action"
              title={
                saveTarget
                  ? `Save to ${saveTarget.name} (Ctrl+S) — or Save As / Save a Copy`
                  : "Save (Ctrl+S) — this drawing has no file yet, so Save will ask where to put it"
              }
              data-testid="save-file"
              onClick={() => {
                setShowUpdateMenu(false);
                setShowSaveMenu((v) => !v);
              }}
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
            {showSaveMenu && (
              <div className="action-menu" data-testid="save-menu">
                <div className="action-menu-caption" data-testid="save-target">
                  {saveTarget ? saveTarget.name : "Not saved to a file yet"}
                </div>
                <button
                  className="action-menu-default"
                  data-testid="save-now"
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveCurrent();
                  }}
                >
                  {saveTarget ? `Save to ${saveTarget.name}` : "Save..."}
                </button>
                <button
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("dxf", undefined, "save-as");
                  }}
                >
                  Save As DXF...
                </button>
                <button
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("svg", undefined, "save-as");
                  }}
                >
                  Save As SVG...
                </button>
                <button
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("dxf", undefined, "save-copy");
                  }}
                >
                  Save a Copy as DXF...
                </button>
                <button
                  onClick={() => {
                    setShowSaveMenu(false);
                    void saveDrawing("svg", undefined, "save-copy");
                  }}
                >
                  Save a Copy as SVG...
                </button>
                {listExporters().length > 0 && <div className="action-menu-sep" data-plugin-rev={pluginVersion} />}
                {listExporters().map((exp) => (
                  <button
                    key={exp.id}
                    data-testid={`plugin-export-${exp.id}`}
                    onClick={() => {
                      setShowSaveMenu(false);
                      void exportViaPlugin(exp.id, exp.extensions[0] ?? "txt");
                    }}
                  >
                    Export as {exp.title}...
                  </button>
                ))}
              </div>
            )}
          </div>
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
          <UpdateButton
            open={showUpdateMenu}
            onToggle={() => {
              setShowSaveMenu(false);
              setShowUpdateMenu((v) => !v);
            }}
          />
          <div className="action-sep" />
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
            className={`action ${showDup ? "toggled" : ""}`}
            title="Toggle duplicate/overlap detection (double circles, overlapping lines, line crossings)"
            data-testid="toggle-duplicates"
            onClick={() => setShowDup((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <circle cx="9" cy="12" r="6" stroke="currentColor" strokeWidth="2" fill="none" />
              <circle cx="15" cy="12" r="6" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
          </button>
          <button
            className={`action ${showPattern ? "toggled" : ""}`}
            title="Toggle pattern panel (repeat the selection in a grid or circle)"
            data-testid="toggle-pattern"
            onClick={() => setShowPattern((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <circle cx="6" cy="6" r="2.2" fill="currentColor" />
              <circle cx="12" cy="6" r="2.2" fill="currentColor" />
              <circle cx="18" cy="6" r="2.2" fill="currentColor" />
              <circle cx="6" cy="12" r="2.2" fill="currentColor" />
              <circle cx="12" cy="12" r="2.2" fill="currentColor" />
              <circle cx="18" cy="12" r="2.2" fill="currentColor" />
              <circle cx="6" cy="18" r="2.2" fill="currentColor" />
              <circle cx="12" cy="18" r="2.2" fill="currentColor" />
              <circle cx="18" cy="18" r="2.2" fill="currentColor" />
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
          <button
            className={`action ${showClosedRegions ? "toggled" : ""}`}
            title="Toggle closed-area highlight — tints any closed loop of lines/arcs/circles so you can see the profile is actually closed"
            data-testid="toggle-closed-regions"
            onClick={() => setShowClosedRegions(!showClosedRegions)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <rect
                x="4"
                y="4"
                width="16"
                height="16"
                rx="2"
                stroke="currentColor"
                strokeWidth="2"
                fill="currentColor"
                fillOpacity="0.25"
              />
            </svg>
          </button>
        </div>
        <div className="hint">{TOOL_HINTS[tool]}</div>
      </header>

      <UpdateBanner />
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
        <FileExplorerPanel hidden={!showFiles} onClose={() => setShowFiles(false)} />
        <div className="center">
          <TabStrip />
          <main className="stage">
            <Viewport />
            {tool === "straighten" && <StraightenPanel />}
          </main>
        </div>
        {showDiag && <DiagnosticsPanel onClose={() => setShowDiag(false)} />}
        {showDup && <DuplicatesPanel onClose={() => setShowDup(false)} />}
        {showPattern && <PatternPanel onClose={() => setShowPattern(false)} />}
        {showLayers && <LayerPanel />}
        {showCode && <CodePanel />}
      </div>

      <footer className="statusbar" data-revision={revision}>
        <span data-testid="coords">
          {cursor ? `${formatLength(cursor.x, displayUnit)}, ${formatLength(cursor.y, displayUnit)}` : "--, --"}
        </span>
        <span>{Math.round(zoom * 100)}%</span>
        <select
          className="unit-select"
          data-testid="unit-select"
          title="Display unit"
          value={displayUnit}
          onChange={(e) => setDisplayUnit(e.target.value as DisplayUnit)}
        >
          {DISPLAY_UNITS.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
        <span data-testid="entity-count">{doc.all().length} entities</span>
        {saveNotice && (
          <span
            className={saveNotice.kind === "error" ? "save-notice error" : "save-notice"}
            data-testid="save-notice"
          >
            {saveNotice.message}
          </span>
        )}
        <span data-testid="selection-hint">{selectionLabel(selection)}</span>
        {measurement && (
          <span className="measure-readout" data-testid="measure-readout">
            {measurementText(measurement, displayUnit, referenceAngleDeg)}
            <button
              className="measure-copy"
              title="Copy measurement (Ctrl+C)"
              data-testid="measure-copy"
              onClick={copyMeasurement}
            >
              {justCopied ? "Copied" : "Copy"}
            </button>
            <button
              className="measure-copy"
              title="Pin this measurement so it stays on screen (Enter)"
              data-testid="measure-pin"
              onClick={pinMeasurement}
            >
              Pin
            </button>
          </span>
        )}
        {pinnedMeasurements.length > 0 && (
          <span className="measure-readout" data-testid="measure-pinned-count">
            {pinnedMeasurements.length} pinned
            <button
              className="measure-copy"
              title="Clear pinned measurements"
              data-testid="measure-clear-pins"
              onClick={clearPinnedMeasurements}
            >
              Clear
            </button>
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

      <PluginCommandPalette open={showPalette} onClose={() => setShowPalette(false)} />
    </div>
  );
}
