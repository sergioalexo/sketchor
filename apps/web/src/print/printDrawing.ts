import { entitiesToSvgDocument } from "@sketchor/core";
import { doc, hiddenLayerSet, useApp } from "../state/store";
import { activeSaveTarget } from "../io/drawingFile";
import { escapeHtml, printHtml } from "./printHtml";

/**
 * Prints a clean view of the current drawing via the browser's print dialog
 * (which offers "Save as PDF"). No PDF library: the drawing is the existing
 * SVG export, rendered in-page (see printHtml.ts) so the browser does the rest.
 */
export function printDrawing(): void {
  const hidden = hiddenLayerSet();
  const entities = doc.all().filter((e) => !hidden.has(e.layer ?? "0"));
  if (entities.length === 0) return;

  const svg = entitiesToSvgDocument(entities, { strokeColor: "#000000", padding: 8 });
  const title = activeSaveTarget()?.name ?? "Sketchor drawing";
  const unit = useApp.getState().displayUnit;

  printHtml(
    `<header><h1>${escapeHtml(title)}</h1><span class="meta">Sketchor &middot; units: ${escapeHtml(unit)}</span></header>${svg}`,
  );
}
