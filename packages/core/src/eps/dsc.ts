/**
 * EPS container + DSC header handling (F-01 / SV-08): the DOS binary header
 * (`C5 D0 D3 C6`, a 30-byte table of offsets to the PostScript section and a
 * WMF/TIFF preview), `%%BoundingBox`, creator sniffing, and the PDF-based
 * Illustrator (AI >= 9 saved without "PDF compatible" off) check. Pure and
 * never throws — a truncated or hostile file just yields smaller sections.
 */

export interface DosHeader {
  psOffset: number;
  psLength: number;
  wmfOffset: number;
  wmfLength: number;
  tiffOffset: number;
  tiffLength: number;
}

/** True when the first four bytes are the DOS EPS magic. */
export function hasDosHeader(b: Uint8Array): boolean {
  return b.length >= 30 && b[0] === 0xc5 && b[1] === 0xd0 && b[2] === 0xd3 && b[3] === 0xc6;
}

/** Reads the 30-byte DOS header (`bytes` needs at least its first 30 bytes), or null. */
export function parseDosHeader(b: Uint8Array): DosHeader | null {
  if (!hasDosHeader(b)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    psOffset: dv.getUint32(4, true),
    psLength: dv.getUint32(8, true),
    wmfOffset: dv.getUint32(12, true),
    wmfLength: dv.getUint32(16, true),
    tiffOffset: dv.getUint32(20, true),
    tiffLength: dv.getUint32(24, true),
  };
}

export type EpsKind = "illustrator" | "photoshop" | "pdf" | "generic";

export interface EpsHeader {
  kind: EpsKind;
  creator: string;
  /** `%%BoundingBox` (integers) or null. */
  bbox: [number, number, number, number] | null;
  /** `%%HiResBoundingBox` when present, else the integer one. */
  hiResBbox: [number, number, number, number] | null;
  languageLevel: number;
  /** True when the PostScript carries Adobe's AGM procsets (Illustrator 9+ EPS). */
  agm: boolean;
  /** `%%Title` when present. */
  title: string;
}

function latin1(b: Uint8Array, start: number, end: number): string {
  let s = "";
  const e = Math.min(end, b.length);
  for (let i = Math.max(0, start); i < e; i += 8192) s += String.fromCharCode(...b.subarray(i, Math.min(e, i + 8192)));
  return s;
}

const bboxOf = (text: string, key: string): [number, number, number, number] | null => {
  const m = new RegExp("^%%" + key + ":\\s*([-+\\d.eE]+)\\s+([-+\\d.eE]+)\\s+([-+\\d.eE]+)\\s+([-+\\d.eE]+)", "m").exec(text);
  if (!m) return null;
  const v = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  return v.every(Number.isFinite) ? v : null;
};

/**
 * Parses the DSC comments of a PostScript section (`ps` = the section only,
 * i.e. after the DOS header). Looks at the first 200 kB, which holds the
 * whole comment header of every file seen.
 */
export function parseEpsHeader(ps: Uint8Array): EpsHeader {
  const text = latin1(ps, 0, 200_000).replace(/\r\n?/g, "\n");
  const pdf = text.startsWith("%PDF-");
  const end = text.indexOf("%%EndComments");
  const head = end >= 0 ? text.slice(0, end) : text.slice(0, 20_000);
  const creator = /^%%Creator:\s*(.*)$/m.exec(head)?.[1]?.replace(/^\((.*)\)$/, "$1").replace(/\\([()])/g, "$1").trim() ?? "";
  const title = /^%%Title:\s*(.*)$/m.exec(head)?.[1]?.trim() ?? "";
  const ll = /^%%LanguageLevel:\s*(\d+)/m.exec(head);
  const kind: EpsKind = pdf ? "pdf" : /Photoshop/i.test(creator) ? "photoshop" : /Illustrator/i.test(creator) || /^%AI\d*_/m.test(head) ? "illustrator" : "generic";
  const bbox = bboxOf(head, "BoundingBox");
  return {
    kind,
    creator,
    bbox,
    hiResBbox: bboxOf(head, "HiResBoundingBox") ?? bbox,
    languageLevel: ll ? Number(ll[1]) : 1,
    agm: text.includes("Adobe_AGM_Core"),
    title,
  };
}

export interface EpsParts {
  /** The PostScript section (whole file when there is no DOS header), or null when not provided. */
  ps: Uint8Array | null;
  /** The TIFF preview, when present. */
  tiff: Uint8Array | null;
  dos: DosHeader | null;
}

/** Splits a whole EPS file into its sections. Out-of-range offsets are clamped (truncated files still yield what is there). */
export function splitEps(bytes: Uint8Array): EpsParts {
  const dos = parseDosHeader(bytes);
  if (!dos) return { ps: bytes, tiff: null, dos: null };
  const slice = (off: number, len: number): Uint8Array | null => (len > 0 && off < bytes.length ? bytes.subarray(off, Math.min(bytes.length, off + len)) : null);
  return { ps: slice(dos.psOffset, dos.psLength) ?? new Uint8Array(0), tiff: slice(dos.tiffOffset, dos.tiffLength), dos };
}
