import { dxfToSvg, entitiesToSvg, parseSvgText, type ThumbnailOptions } from "@sketchor/core";

/**
 * True for drawing file kinds the in-app file browser lists thumbnails for.
 * DWG is import-only and not text-readable, so it's opened via the Open
 * dialog / file association rather than browsed here — see drawingFile.ts.
 */
export function isDrawingFile(name: string): boolean {
  return /\.(dxf|svg)$/i.test(name);
}

/**
 * Renders either file kind to a thumbnail SVG string, reusing the same
 * headless renderer that backs the native Explorer thumbnailer, so previews
 * everywhere agree.
 */
export function fileToSvg(name: string, text: string, opts?: ThumbnailOptions): string {
  if (/\.dxf$/i.test(name)) return dxfToSvg(text, opts);
  try {
    const { entities } = parseSvgText(text);
    return entitiesToSvg(entities, opts);
  } catch {
    return entitiesToSvg([], opts);
  }
}
