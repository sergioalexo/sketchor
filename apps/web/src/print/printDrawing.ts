import { entitiesToSvgDocument } from "@sketchor/core";
import { doc, hiddenLayerSet, useApp } from "../state/store";
import { activeSaveTarget } from "../io/drawingFile";

/**
 * Opens a clean print view of the current drawing in a new window and triggers
 * the browser's print dialog — which offers "Save as PDF". No PDF library: the
 * drawing is the existing SVG export, the browser does the rest.
 */
export function printDrawing(): void {
  const hidden = hiddenLayerSet();
  const entities = doc.all().filter((e) => !hidden.has(e.layer ?? "0"));
  if (entities.length === 0) return;

  const svg = entitiesToSvgDocument(entities, { strokeColor: "#000000", padding: 8 });
  const title = activeSaveTarget()?.name ?? "Sketchor drawing";
  const unit = useApp.getState().displayUnit;

  // No `noopener` — we need the handle to write the document into it.
  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  @page { margin: 12mm; }
  body { margin: 0; font: 12px system-ui, sans-serif; color: #111; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  h1 { font-size: 14px; margin: 0; }
  .meta { color: #666; }
  svg { width: 100%; height: auto; max-height: 88vh; }
  @media print { header { position: running(head); } }
</style></head><body>
  <header><h1>${escapeHtml(title)}</h1><span class="meta">Sketchor &middot; units: ${escapeHtml(unit)}</span></header>
  ${svg}
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 60); };
  window.onafterprint = function(){ window.close(); };</script>
</body></html>`);
  win.document.close();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}
