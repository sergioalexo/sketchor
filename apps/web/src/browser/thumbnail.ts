import { dxfToSvg, entitiesToSvg, type Entity, type ThumbnailOptions } from "@sketchor/core";

/** True for the two drawing file kinds the in-app file browser lists. */
export function isDrawingFile(name: string): boolean {
  return /\.(dxf|sketchor)$/i.test(name);
}

/**
 * Renders either file kind to a thumbnail SVG string, reusing the same
 * headless renderer that backs the DXF library strip and the native
 * Explorer thumbnailer — so previews here always agree with those.
 */
export function fileToSvg(name: string, text: string, opts?: ThumbnailOptions): string {
  if (/\.dxf$/i.test(name)) return dxfToSvg(text, opts);
  try {
    const parsed = JSON.parse(text) as { entities?: unknown };
    const entities = Array.isArray(parsed.entities) ? (parsed.entities as Entity[]) : [];
    return entitiesToSvg(entities, opts);
  } catch {
    return entitiesToSvg([], opts);
  }
}
