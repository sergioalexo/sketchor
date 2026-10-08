import { epsPreviewDataUrl, importEpsParts, parseDosHeader, parseEpsHeader, type EpsImportResult, type EpsParts } from "@sketchor/core";

/**
 * F-01 / F-03 glue: reads an EPS/AI file in *ranges*, so a 260 MB Photoshop
 * EPS (a few hundred kB of header + a 90 kB TIFF preview + the raster it
 * draws) never has to be loaded whole. The vector PostScript of an Illustrator
 * file is read in full up to {@link EPS_MAX_PS_BYTES}; past that the import
 * falls back to the embedded preview.
 */

/** Reads `length` bytes at `offset`; may return fewer at the end of the file. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** Largest PostScript section interpreted (the biggest Illustrator file seen is ~14 MB). */
export const EPS_MAX_PS_BYTES = 96 * 1024 * 1024;
/** How much of the PostScript is read to classify the file before deciding to read the rest. */
const HEAD_BYTES = 300_000;

export interface EpsSections {
  parts: EpsParts;
  /** The PostScript section was larger than {@link EPS_MAX_PS_BYTES} and was not read. */
  tooLarge: boolean;
}

/** Reads the sections an import needs, and nothing more. */
export async function readEpsSections(read: RangeReader): Promise<EpsSections> {
  const first = await read(0, 32);
  const dos = parseDosHeader(first);
  if (!dos) {
    const all = await read(0, EPS_MAX_PS_BYTES + 1);
    const tooLarge = all.length > EPS_MAX_PS_BYTES;
    return { parts: { ps: tooLarge ? all.subarray(0, HEAD_BYTES) : all, tiff: null, dos: null }, tooLarge };
  }
  const head = await read(dos.psOffset, Math.min(dos.psLength || HEAD_BYTES, HEAD_BYTES));
  const kind = parseEpsHeader(head).kind;
  const tiff = dos.tiffLength > 0 ? await read(dos.tiffOffset, dos.tiffLength) : null;
  const raster = kind === "photoshop" || kind === "pdf";
  const tooLarge = !raster && dos.psLength > EPS_MAX_PS_BYTES;
  const ps = raster || tooLarge || dos.psLength <= head.length ? head : await read(dos.psOffset, dos.psLength);
  return { parts: { ps, tiff, dos }, tooLarge };
}

/** Imports an EPS/AI file through a range reader. Never throws on bad input. */
export async function importEpsFromReader(read: RangeReader): Promise<EpsImportResult> {
  const { parts, tooLarge } = await readEpsSections(read);
  const r = importEpsParts(parts);
  if (tooLarge) r.warnings.unshift(`the PostScript is larger than ${Math.round(EPS_MAX_PS_BYTES / 1048576)} MB and was not interpreted`);
  return r;
}

/** A `Blob` (File) as a range reader. */
export const blobReader =
  (blob: Blob): RangeReader =>
  async (offset, length) =>
    new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

/** Imports an EPS/AI `File`. */
export const importEpsBlob = (blob: Blob): Promise<EpsImportResult> => importEpsFromReader(blobReader(blob));

/** Imports EPS/AI bytes already in memory (drag-drop, tests). */
export const importEpsBytes = (bytes: Uint8Array): Promise<EpsImportResult> =>
  importEpsFromReader(async (o, l) => bytes.subarray(o, Math.min(bytes.length, o + l)));

/**
 * A desktop file as a range reader: the `read_file_range` command when the
 * shell has it, else the whole file via `read_file_bytes` (an older binary).
 */
export function tauriReader(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>, path: string): RangeReader {
  let whole: Uint8Array | null = null;
  let ranged = true;
  return async (offset, length) => {
    if (ranged) {
      try {
        return new Uint8Array((await invoke("read_file_range", { path, offset, length })) as ArrayBuffer);
      } catch {
        ranged = false;
      }
    }
    whole ??= new Uint8Array((await invoke("read_file_bytes", { path })) as ArrayBuffer);
    return whole.subarray(offset, Math.min(whole.length, offset + length));
  };
}

/**
 * F-03: a thumbnail for an EPS/AI file as a `data:image/png` URI — the file's
 * own embedded TIFF preview when it has one (instant, and exactly what the
 * author saw), else null so the caller can render the imported vectors.
 */
export async function epsThumbnailDataUrl(read: RangeReader, maxSide = 256): Promise<string | null> {
  const first = await read(0, 32);
  const dos = parseDosHeader(first);
  if (!dos || !dos.tiffLength) return null;
  const tiff = await read(dos.tiffOffset, dos.tiffLength);
  return epsPreviewDataUrl(tiff, maxSide);
}
