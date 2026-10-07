/**
 * F-09 — the one table of file formats Sketchor knows. The Open dialogs,
 * the file browser's picker and mime types, "can this be saved back" and the
 * model/drawing split all read it, and `formats.test.ts` checks that the
 * places that can't import it (tauri.conf.json fileAssociations, the Explorer
 * thumbnailer's EXTENSIONS) still agree with it. Add a format here first.
 */

export type FormatKind = "2d" | "3d";

export interface FormatInfo {
  /** Lowercase extensions without the dot; the first is canonical. */
  ext: readonly string[];
  kind: FormatKind;
  label: string;
  mime: string;
  /** Sketchor can write this format back out. */
  writable: boolean;
  /** Registered as an OS file association (tauri.conf.json). */
  association: boolean;
  /** Explorer/Finder thumbnails come from the native shell extension. */
  nativeThumbnail: boolean;
}

export const FORMATS: readonly FormatInfo[] = [
  { ext: ["dxf"], kind: "2d", label: "DXF drawing", mime: "application/dxf", writable: true, association: true, nativeThumbnail: true },
  { ext: ["svg"], kind: "2d", label: "SVG drawing", mime: "image/svg+xml", writable: true, association: true, nativeThumbnail: false },
  { ext: ["dwg"], kind: "2d", label: "DWG drawing", mime: "application/acad", writable: false, association: true, nativeThumbnail: false },
  // EPS/AI: registered for "Open with" and the pickers; the importer is F-01, until then they open as an explanatory warning.
  { ext: ["eps"], kind: "2d", label: "EPS drawing", mime: "application/postscript", writable: false, association: true, nativeThumbnail: false },
  { ext: ["ai"], kind: "2d", label: "Illustrator drawing", mime: "application/illustrator", writable: false, association: true, nativeThumbnail: false },
  { ext: ["step", "stp"], kind: "3d", label: "STEP model", mime: "model/step", writable: false, association: true, nativeThumbnail: true },
  { ext: ["iges", "igs"], kind: "3d", label: "IGES model", mime: "model/iges", writable: false, association: true, nativeThumbnail: true },
];

const extOf = (name: string): string => name.split(/[\\/]/).pop()!.split(".").slice(1).pop()?.toLowerCase() ?? "";

/** The format a file name belongs to, or null if Sketchor doesn't open it. */
export function formatOf(name: string): FormatInfo | null {
  const e = extOf(name);
  return FORMATS.find((f) => f.ext.includes(e)) ?? null;
}

export const allExtensions = (pred: (f: FormatInfo) => boolean = () => true): string[] =>
  FORMATS.filter(pred).flatMap((f) => [...f.ext]);

/** `accept` string for an `<input type=file>`: ".dxf,.svg,…". */
export const acceptList = (pred?: (f: FormatInfo) => boolean): string =>
  allExtensions(pred).map((e) => `.${e}`).join(",");

/** MIME for a file name (drag-out, save pickers); DXF is the fallback like before. */
export const mimeOf = (name: string): string => formatOf(name)?.mime ?? "application/dxf";

/** Formats the file browser's "add files" input takes (not DWG, which needs the converter path, nor EPS/AI until F-01/F-03 give them an importer and thumbnails). */
export const browserAddFilter = (f: FormatInfo): boolean => !["dwg", "eps", "ai"].includes(f.ext[0]);

/** Shown when an EPS/AI file is opened before the EPS importer (F-01) exists. */
export const EPS_UNSUPPORTED = "EPS/AI import is not available yet — the file was recognised but not loaded";
