/**
 * X-11: binary DXF → ASCII DXF text. The parser is record-based, so reading
 * the binary form only needs the sentinel skipped and every typed group
 * value turned back into its ASCII `code / value` pair.
 *
 * Layout: 22-byte sentinel `AutoCAD Binary DXF\r\n\x1a\0`, then groups of
 * `code` (1 byte; 255 = a 2-byte little-endian code follows) and a value
 * whose type the code decides: null-terminated string, int16, int32, int64,
 * double, 1-byte boolean or a length-prefixed binary chunk (310-319, 1004).
 * Truncated or garbled input stops the scan and returns what was read; it
 * never throws and always advances, so it terminates.
 */

export const BINARY_DXF_SENTINEL = "AutoCAD Binary DXF";

export function isBinaryDxf(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  for (let i = 0; i < BINARY_DXF_SENTINEL.length; i++) if (bytes[i] !== BINARY_DXF_SENTINEL.charCodeAt(i)) return false;
  return true;
}

type Kind = "str" | "i16" | "i32" | "i64" | "f64" | "bool" | "bin";

function kindOf(code: number): Kind {
  if (code >= 10 && code <= 59) return "f64";
  if (code >= 60 && code <= 79) return "i16";
  if (code >= 90 && code <= 99) return "i32";
  if (code >= 110 && code <= 149) return "f64";
  if (code >= 160 && code <= 169) return "i64";
  if (code >= 170 && code <= 179) return "i16";
  if (code >= 210 && code <= 239) return "f64";
  if (code >= 270 && code <= 289) return "i16";
  if (code >= 290 && code <= 299) return "bool";
  if (code >= 310 && code <= 319) return "bin";
  if (code >= 370 && code <= 389) return "i16";
  if (code >= 400 && code <= 409) return "i16";
  if (code >= 420 && code <= 429) return "i32";
  if (code >= 440 && code <= 459) return "i32";
  if (code >= 460 && code <= 469) return "f64";
  if (code === 1004) return "bin";
  if (code >= 1010 && code <= 1059) return "f64";
  if (code >= 1060 && code <= 1070) return "i16";
  if (code === 1071) return "i32";
  return "str";
}

function decodeString(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Binary DXF bytes → ASCII DXF text (lines of `code`, `value`). */
export function binaryDxfToText(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  let i = 22;
  while (i < bytes.length) {
    let code = bytes[i++];
    if (code === 255) {
      if (i + 2 > bytes.length) break;
      code = view.getInt16(i, true);
      i += 2;
    }
    const kind = kindOf(code);
    let value: string;
    switch (kind) {
      case "str": {
        let end = i;
        while (end < bytes.length && bytes[end] !== 0) end++;
        value = decodeString(bytes.subarray(i, end));
        i = end + 1;
        break;
      }
      case "i16":
        if (i + 2 > bytes.length) return out.join("\n") + "\n";
        value = String(view.getInt16(i, true));
        i += 2;
        break;
      case "i32":
        if (i + 4 > bytes.length) return out.join("\n") + "\n";
        value = String(view.getInt32(i, true));
        i += 4;
        break;
      case "i64":
        if (i + 8 > bytes.length) return out.join("\n") + "\n";
        value = String(view.getBigInt64(i, true));
        i += 8;
        break;
      case "f64":
        if (i + 8 > bytes.length) return out.join("\n") + "\n";
        value = String(view.getFloat64(i, true));
        i += 8;
        break;
      case "bool":
        if (i + 1 > bytes.length) return out.join("\n") + "\n";
        value = String(bytes[i++]);
        break;
      default: {
        // length-prefixed chunk, written back as the hex string ASCII DXF uses
        if (i + 1 > bytes.length) return out.join("\n") + "\n";
        const len = bytes[i++];
        const chunk = bytes.subarray(i, Math.min(bytes.length, i + len));
        value = Array.from(chunk, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");
        i += len;
      }
    }
    out.push(String(code), value);
  }
  return out.join("\n") + "\n";
}
