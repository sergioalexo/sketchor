/**
 * DXF text encoding (X-07). AC1021+ files are UTF-8; older files are in the
 * ANSI codepage named by `$DWGCODEPAGE`, and R12 writers escape anything
 * outside ASCII as `\U+XXXX`. Cyrillic labels must survive every direction.
 */

/** `$DWGCODEPAGE` value → WHATWG `TextDecoder` label. */
const CODEPAGE_LABELS: Record<string, string> = {
  ANSI_874: "windows-874",
  ANSI_932: "shift_jis",
  ANSI_936: "gbk",
  ANSI_949: "euc-kr",
  ANSI_950: "big5",
  ANSI_1250: "windows-1250",
  ANSI_1251: "windows-1251",
  ANSI_1252: "windows-1252",
  ANSI_1253: "windows-1253",
  ANSI_1254: "windows-1254",
  ANSI_1255: "windows-1255",
  ANSI_1256: "windows-1256",
  ANSI_1257: "windows-1257",
  ANSI_1258: "windows-1258",
  DOS866: "ibm866",
  DOS852: "ibm852",
  "UTF-8": "utf-8",
  UTF8: "utf-8",
};

/** First `$ACADVER` ("AC1032") and `$DWGCODEPAGE` ("ANSI_1251") in the HEADER, read byte-wise so no decoding is needed. */
export function sniffDxfHeader(bytes: Uint8Array): { version?: string; codepage?: string } {
  let head = "";
  const n = Math.min(bytes.length, 65536);
  for (let i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
  return {
    version: /\$ACADVER\s+1\s+(AC\d+)/.exec(head)?.[1],
    codepage: /\$DWGCODEPAGE\s+3\s+(\S+)/.exec(head)?.[1]?.toUpperCase(),
  };
}

function decodeWith(label: string, bytes: Uint8Array, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/** DXF file bytes → text, choosing UTF-8 or the declared codepage (never mojibake an AC1021+ file or a 1251 one). */
export function decodeDxfBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes);
  const { version, codepage } = sniffDxfHeader(bytes);
  const modern = version !== undefined && version >= "AC1021";
  if (modern) return decodeWith("utf-8", bytes, true) ?? decodeWith("utf-8", bytes, false)!;
  const declared = codepage ? CODEPAGE_LABELS[codepage] : undefined;
  if (declared) {
    // A file that says 1251 but is really valid UTF-8 (third-party writers) is far likelier UTF-8 than a coincidence.
    if (declared !== "utf-8") {
      const utf = decodeWith("utf-8", bytes, true);
      if (utf !== null && /[^\x00-\x7f]/.test(utf)) return utf;
    }
    return decodeWith(declared, bytes, false) ?? decodeWith("windows-1252", bytes, false)!;
  }
  return decodeWith("utf-8", bytes, true) ?? decodeWith("windows-1252", bytes, false)!;
}

/** Resolves `\U+XXXX` and AutoCAD `%%c %%d %%p %%nnn` codes in a TEXT/MTEXT string. */
export function unescapeDxfText(s: string): string {
  if (!s.includes("\U+") && !s.includes("%%")) return s;
  return s
    .replace(/\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%([cCdDpP%]|\d{3})/g, (_, c: string) => {
      switch (c.toLowerCase()) {
        case "c":
          return "Ø";
        case "d":
          return "°";
        case "p":
          return "±";
        case "%":
          return "%";
        default:
          return String.fromCharCode(parseInt(c, 10));
      }
    });
}

/** Escapes everything outside ASCII as `\U+XXXX` for writers that target a codepage-less R12 file. */
export function escapeDxfText(s: string): string {
  return s.replace(/[^\x00-\x7f]/g, (c) => "\U+" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
}
