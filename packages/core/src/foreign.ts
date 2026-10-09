import type { TableRecord } from "./tables";

/**
 * X-09: an entity the importer doesn't model (PROXY, 3DSOLID, ACAD_TABLE,
 * anything unknown), kept as its raw group-code pairs in the `foreign`
 * table so opening and re-saving a colleague's DXF doesn't silently delete
 * it. It is invisible and untouchable in Sketchor; the AC1032 writer puts it
 * back unchanged (new handle, owner = model space; XDICTIONARY / reactor /
 * cross-object handle references are dropped, as they can't be remapped).
 * Coordinates stay in the source file's unit (`units`, an `$INSUNITS` code):
 * the writer only emits a record when the output unit matches, since opaque
 * geometry cannot be rescaled.
 */
export interface ForeignRecord extends TableRecord {
  /** DXF record type, e.g. "PROXY_ENTITY". */
  type: string;
  layer: string;
  pairs: [number, string][];
  /** `$INSUNITS` the pairs are expressed in. */
  units: number;
  /** The CLASSES-section entry this type needs (group pairs), carried on the first record of its type. */
  cls?: [number, string][];
}

/** Group codes that hold handles pointing at other objects: dropped on write (they cannot be remapped). */
function isRefCode(code: number): boolean {
  return code >= 330 && code <= 369;
}

/** The record as AC1032 text with a fresh handle and model-space owner. */
export function foreignEntityText(rec: ForeignRecord, handle: string, owner: string): string {
  let out = `0\n${rec.type}\n5\n${handle}\n330\n${owner}\n`;
  let skipGroup = false;
  for (const [code, value] of rec.pairs) {
    if (code === 102) {
      // `102 {APP_NAME ... 102 }` reactor / xdictionary blocks reference other objects.
      skipGroup = value.trim().startsWith("{");
      continue;
    }
    if (skipGroup) continue;
    if (code === 0 || code === 5 || isRefCode(code)) continue;
    out += `${code}\n${value}\n`;
  }
  return out;
}

export function foreignClassText(rec: ForeignRecord): string {
  return rec.cls ? "0\nCLASS\n" + rec.cls.map(([c, v]) => `${c}\n${v}\n`).join("") : "";
}
