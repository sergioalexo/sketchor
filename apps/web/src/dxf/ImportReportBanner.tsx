import { useApp } from "../state/store";

/**
 * A dismissible summary of the most recent DXF import: which entity types
 * were parsed, and which (if any) were found but skipped. Exists so an
 * unsupported entity (HATCH, DIMENSION, ...) is never silently dropped —
 * see R8 in the engineering brief.
 */
export function ImportReportBanner() {
  const report = useApp((s) => s.importReport);
  const dismiss = useApp((s) => s.setImportReport);

  if (!report) return null;
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
      <button className="btn ghost" onClick={() => dismiss(null)} title="Dismiss">
        ✕
      </button>
    </div>
  );
}
