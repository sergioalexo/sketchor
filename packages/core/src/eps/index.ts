/**
 * EPS import entry points (F-01 / SV-08). `importEps` takes a whole file (with
 * or without the DOS binary header); `importEpsParts` takes the already-split
 * sections so a 260 MB Photoshop EPS never has to be read — only its header
 * and TIFF preview are needed.
 */
import type { Entity, ImageEntity, PolylineEntity } from "../entities";
import { newEntityId } from "../entities";
import { parseEpsHeader, splitEps, type EpsHeader, type EpsParts } from "./dsc";
import { Interp } from "./interp";
import { rgbaToPngDataUrl } from "./png";
import { decodeTiff, downscale, type RgbaImage } from "./tiff";

export * from "./dsc";
export { decodeTiff, downscale } from "./tiff";
export { encodePng, rgbaToPngDataUrl } from "./png";
export { cmykToRgb, rgbToCss } from "./color";

export interface EpsImportOptions {
  maxEntities?: number;
  maxOps?: number;
  /** Longest side, in pixels, of an image entity made from the TIFF preview. */
  previewMaxSide?: number;
}

export interface EpsImportResult {
  entities: Entity[];
  warnings: string[];
  header: EpsHeader;
  /** True when the geometry is the embedded raster preview, not vector data. */
  fromPreview: boolean;
  /** Distinct PostScript operators that were not understood (name → count). */
  unsupported: Record<string, number>;
}

const K = 25.4 / 72;
const AGM_MARKERS = ["%%EndPageSetup", "%%Page:"];

/** The TIFF preview as a PNG data URI + its pixel size, or null. */
export function epsPreviewImage(tiff: Uint8Array | null, maxSide = 512): RgbaImage | null {
  if (!tiff) return null;
  const img = decodeTiff(tiff);
  return img ? downscale(img, maxSide) : null;
}

/** Preview as a `data:image/png` URI (for thumbnails). */
export function epsPreviewDataUrl(tiff: Uint8Array | null, maxSide = 256): string | null {
  const img = epsPreviewImage(tiff, maxSide);
  return img ? rgbaToPngDataUrl(img.width, img.height, img.rgba) : null;
}

function find(b: Uint8Array, s: string, from: number): number {
  const c0 = s.charCodeAt(0);
  for (let i = b.indexOf(c0, from); i >= 0; i = b.indexOf(c0, i + 1)) {
    let k = 1;
    while (k < s.length && b[i + k] === s.charCodeAt(k)) k++;
    if (k === s.length) return i;
  }
  return -1;
}

function previewEntity(tiff: Uint8Array | null, header: EpsHeader, maxSide: number): ImageEntity | null {
  const img = epsPreviewImage(tiff, maxSide);
  if (!img) return null;
  const bb = header.hiResBbox ?? header.bbox;
  const wMm = bb ? Math.max(bb[2] - bb[0], 0) * K : img.width * K;
  const hMm = bb ? Math.max(bb[3] - bb[1], 0) * K : img.height * K;
  return { id: newEntityId(), type: "image", insert: { x: 0, y: 0 }, width: wMm || img.width * K, height: hMm || img.height * K, rotation: 0, dataUrl: rgbaToPngDataUrl(img.width, img.height, img.rgba) };
}

export function importEps(bytes: Uint8Array, opts: EpsImportOptions = {}): EpsImportResult {
  return importEpsParts(splitEps(bytes), opts);
}

export function importEpsParts(parts: EpsParts, opts: EpsImportOptions = {}): EpsImportResult {
  const warnings: string[] = [];
  const ps = parts.ps;
  const header = ps ? parseEpsHeader(ps) : parseEpsHeader(new Uint8Array(0));
  const empty = (fromPreview: boolean, entities: Entity[]): EpsImportResult => ({ entities, warnings, header, fromPreview, unsupported: {} });
  const maxSide = opts.previewMaxSide ?? 2048;

  if (header.kind === "pdf") {
    warnings.push("this Illustrator file is PDF-based (saved without EPS/PostScript data) — save it as EPS or SVG, or open it with PDF import");
    return empty(false, []);
  }
  const usePreview = (why: string): EpsImportResult => {
    const e = previewEntity(parts.tiff, header, maxSide);
    if (e) {
      warnings.push(why);
      return empty(true, [e]);
    }
    return empty(false, []);
  };
  if (header.kind === "photoshop") {
    const r = usePreview("raster EPS (Photoshop): the embedded preview image was imported — no vector geometry in this file");
    if (!r.entities.length) warnings.push("raster EPS (Photoshop) with no readable preview image");
    return r;
  }
  if (!ps || ps.length === 0) {
    warnings.push("the file has no PostScript section");
    return empty(false, []);
  }

  const bb = header.hiResBbox;
  const ox = bb ? bb[0] : 0;
  const oy = bb ? bb[1] : 0;
  let startAt: number | undefined;
  if (header.agm) {
    for (const m of AGM_MARKERS) {
      const i = find(ps, m, 0);
      if (i >= 0) {
        startAt = i;
        break;
      }
    }
  }
  const interp = new Interp(ps, { originX: ox, originY: oy, maxEntities: opts.maxEntities ?? 400_000, maxOps: opts.maxOps ?? 60_000_000, startAt }, { w: bb ? bb[2] - bb[0] : 0, h: bb ? bb[3] - bb[1] : 0 });
  const res = interp.run();
  const unsupported: Record<string, number> = {};
  for (const [k, v] of [...res.unsupported].sort((a, b) => b[1] - a[1])) unsupported[k] = v;
  const notable = Object.entries(unsupported).filter(([k]) => !IGNORABLE.has(k) && !/[+*]/.test(k));
  if (notable.length) warnings.push(`PostScript operators not supported (ignored): ${notable.slice(0, 8).map(([k, n]) => `${k} ×${n}`).join(", ")}${notable.length > 8 ? ", …" : ""}`);
  if (res.croppingClips) warnings.push(`${res.croppingClips} clipping path${res.croppingClips === 1 ? "" : "s"} ignored (shapes are not cropped)`);
  if (res.truncated) warnings.push("the file is very large — import stopped at the entity limit");
  if (res.budgetHit) warnings.push("the PostScript was too complex to finish — import stopped early");
  if (res.entities.length === 0) {
    const r = usePreview("no vector geometry could be read — the embedded preview image was imported instead");
    if (r.entities.length) return { ...r, unsupported };
    if (bb) {
      const rect: PolylineEntity = { id: newEntityId(), type: "polyline", points: [{ x: 0, y: 0 }, { x: (bb[2] - bb[0]) * K, y: 0 }, { x: (bb[2] - bb[0]) * K, y: (bb[3] - bb[1]) * K }, { x: 0, y: (bb[3] - bb[1]) * K }], closed: true, construction: true };
      warnings.push("no geometry could be read — a placeholder rectangle marks the bounding box");
      return { entities: [rect], warnings, header, fromPreview: false, unsupported };
    }
  }
  return { entities: res.entities, warnings, header, fromPreview: false, unsupported };
}

/** Operators that appear in every Illustrator page and mean nothing for geometry. */
const IGNORABLE = new Set<string>(["Adobe_AGM_Utils", "Adobe_AGM_Core", "Adobe_CoolType_Core", "Adobe_AGM_Image", "AGMIMG_fl", "userdict", "AI11_PDFMark5", "AI9_read_buffer", "ai9_skip_data", "nzopmsc", "chp"]);
