import { reinterpretImportUnits, useApp } from "../state/store";
import { DISPLAY_UNITS, dxfCodeToDisplayUnit, dxfUnitName } from "../units";

/**
 * A dismissible summary of the most recent import: for DXF/DWG, which entity
 * types were parsed vs. found-but-skipped (so an unsupported entity like
 * HATCH or DIMENSION is never silently dropped — see R8 in the engineering
 * brief) and which unit the file was read in; for SVG, whatever warnings the
 * parser produced (e.g. curve approximation, an unreadable file).
 *
 * A wrong unit silently makes every dimension wrong, so it is always shown.
 * When the file didn't state it (the unit was guessed from its drawing
 * defaults, or it has no hint at all), the banner turns amber and offers
 * one click to re-read the geometry in the right unit.
 */
export function ImportReportBanner() {
  const report = useApp((s) => s.importReport);
  const units = useApp((s) => s.importUnits);
  const dismissReport = useApp((s) => s.setImportReport);
  const dismissUnits = useApp((s) => s.setImportUnits);
  const warnings = useApp((s) => s.fileWarnings);
  const dismissWarnings = useApp((s) => s.setFileWarnings);

  if (report) {
    const { parsed, skipped } = report;
    const guessed = units !== null && (units.source === "inferred" || units.source === "none");
    const clean = skipped.length === 0 && warnings.length === 0 && !guessed;
    const current = units ? dxfCodeToDisplayUnit(units.code) : null;
    const summary =
      skipped.length === 0
        ? `Imported ${parsed.map((p) => `${p.count} ${p.type}`).join(", ") || "nothing"}`
        : `Imported with ${skipped.reduce((n, s) => n + s.count, 0)} unsupported entit${skipped.length === 1 && skipped[0].count === 1 ? "y" : "ies"}: ${skipped
            .map((s) => `${s.count} ${s.type}`)
            .join(", ")}`;
    return (
      <div className={`import-banner ${clean ? "clean" : "warn"}`} data-testid="import-report">
        <span className="import-banner-summary">
          {summary}
          {units && <> · {unitText(units.source, units.code)}</>}
          {warnings.length > 0 && <> · {warnings.join("; ")}</>}
        </span>
        {guessed && (
          <span className="import-banner-units" data-testid="import-units">
            Read as:
            {DISPLAY_UNITS.map((u) => (
              <button
                key={u.id}
                className={`btn ghost${u.id === current ? " active" : ""}`}
                onClick={() => reinterpretImportUnits(u.id)}
                title={`Re-read the drawing as if the file were in ${u.label}`}
              >
                {u.label}
              </button>
            ))}
          </span>
        )}
        <button
          className="btn ghost"
          onClick={() => {
            dismissReport(null);
            dismissUnits(null);
            dismissWarnings([]);
          }}
          title="Dismiss"
        >
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

function unitText(source: string, code: number): string {
  const name = dxfUnitName(code);
  switch (source) {
    case "insunits":
      return `units: ${name}`;
    case "measurement":
      return `units: ${name} (from the file's imperial/metric setting)`;
    case "inferred":
      return `units not stated in the file — guessed ${name} from its drawing defaults. Check a known dimension`;
    case "user":
      return `units: ${name} (set by you)`;
    default:
      return code
        ? `units not stated in the file — numbers read as ${name}. Check a known dimension`
        : "units not stated in the file — numbers read as millimetres. Check a known dimension";
  }
}
