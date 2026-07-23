import { useApp } from "../state/store";

/**
 * A dismissible summary of the most recent import: for DXF, which entity
 * types were parsed vs. found-but-skipped (so an unsupported entity like
 * HATCH or DIMENSION is never silently dropped — see R8 in the engineering
 * brief); for SVG/DWG, whatever warnings the parser produced (e.g. curve
 * approximation, an unreadable file).
 */
export function ImportReportBanner() {
  const report = useApp((s) => s.importReport);
  const dismissReport = useApp((s) => s.setImportReport);
  const warnings = useApp((s) => s.fileWarnings);
  const dismissWarnings = useApp((s) => s.setFileWarnings);

  if (report) {
    const { parsed, skipped } = report;
    const clean = skipped.length === 0;
    return (
      <div className={`import-banner ${clean ? "clean" : "warn"}`} data-testid="import-report">
        <span className="import-banner-summary">
          {clean
            ? `Imported cleanly — ${parsed.map((p) => `${p.count} ${p.type}`).join(", ")}`
            : `Imported with ${skipped.reduce((n, s) => n + s.count, 0)} unsupported entit${skipped.length === 1 && skipped[0].count === 1 ? "y" : "ies"}: ${skipped
                .map((s) => `${s.count} ${s.type}`)
                .join(", ")}`}
        </span>
        <button className="btn ghost" onClick={() => dismissReport(null)} title="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  if (warnings.length > 0) {
    return (
      <div className="import-banner warn" data-testid="import-report">
        <span className="import-banner-summary">{warnings.join("; ")}</span>
        <button className="btn ghost" onClick={() => dismissWarnings([])} title="Dismiss">
          ✕
        </button>
      </div>
    );
  }

  return null;
}
