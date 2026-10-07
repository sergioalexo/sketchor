import type { InsertEntity } from "../entities";

/**
 * The `insert` statement of sketch code (B-01):
 *
 *   insert I1 block "NAME" at (x, y) [scale SX [SY]] [rot DEG] [array COLSxROWS spacing DX DY]
 *
 * Attribute values and dynamic-block params are not expressible here; an edit
 * of the line keeps the existing ones (see `diffToCommands`).
 */

export interface ParsedInsert {
  type: "insert";
  name: string;
  block: string;
  at: { x: number; y: number };
  scale: { x: number; y: number };
  rotation: number;
  array?: { cols: number; rows: number; colSpacing: number; rowSpacing: number };
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const HEAD = new RegExp(
  String.raw`^insert\s+([A-Za-z_]\w*)\s+block\s+("(?:[^"\\]|\\.)*")\s+at\s*\(\s*(${NUM})\s*,\s*(${NUM})\s*\)(.*)$`,
);

const fmt = (n: number): string => {
  const r = Math.round(n * 10000) / 10000;
  return String(Object.is(r, -0) ? 0 : r);
};

export function insertLine(name: string, e: InsertEntity): string {
  let s = `insert ${name} block ${JSON.stringify(e.block)} at (${fmt(e.insert.x)}, ${fmt(e.insert.y)})`;
  if (e.scale.x !== 1 || e.scale.y !== 1) s += e.scale.x === e.scale.y ? ` scale ${fmt(e.scale.x)}` : ` scale ${fmt(e.scale.x)} ${fmt(e.scale.y)}`;
  if (e.rotation) s += ` rot ${fmt((e.rotation * 180) / Math.PI)}`;
  if (e.array && (e.array.cols > 1 || e.array.rows > 1)) s += ` array ${e.array.cols}x${e.array.rows} spacing ${fmt(e.array.colSpacing)} ${fmt(e.array.rowSpacing)}`;
  return s;
}

/** Parses a whole `insert` row; returns the reason when it cannot. */
export function parseInsertLine(row: string): ParsedInsert | string {
  const m = row.match(HEAD);
  const usage = 'insert NAME block "BLOCK" at (x, y) [scale SX [SY]] [rot DEG] [array COLSxROWS spacing DX DY]';
  if (!m) return usage;
  let block: string;
  try {
    block = JSON.parse(m[2]) as string;
  } catch {
    return "insert block name must be a quoted string";
  }
  if (block === "") return "insert block name is empty";
  const rest = m[5];
  const scaleM = rest.match(new RegExp(String.raw`\bscale\s+(${NUM})(?:\s+(${NUM}))?`));
  const rotM = rest.match(new RegExp(String.raw`\brot\s+(${NUM})`));
  const arrM = rest.match(new RegExp(String.raw`\barray\s+(\d+)x(\d+)\s+spacing\s+(${NUM})\s+(${NUM})`));
  const sx = scaleM ? Number(scaleM[1]) : 1;
  const sy = scaleM ? (scaleM[2] !== undefined ? Number(scaleM[2]) : sx) : 1;
  if (sx === 0 || sy === 0) return "insert scale cannot be zero";
  let array: ParsedInsert["array"];
  if (arrM) {
    const cols = Number(arrM[1]);
    const rows = Number(arrM[2]);
    if (cols < 1 || rows < 1 || cols * rows > 100000) return "insert array needs 1 or more columns and rows (at most 100000 cells)";
    array = { cols, rows, colSpacing: Number(arrM[3]), rowSpacing: Number(arrM[4]) };
  }
  return {
    type: "insert",
    name: m[1],
    block,
    at: { x: Number(m[3]), y: Number(m[4]) },
    scale: { x: sx, y: sy },
    rotation: rotM ? (Number(rotM[1]) * Math.PI) / 180 : 0,
    ...(array ? { array } : {}),
  };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4;

/** The parsed line says nothing new about `existing` (code carries 4 decimals). */
export function insertSameGeometry(existing: InsertEntity, p: ParsedInsert): boolean {
  const ea = existing.array && (existing.array.cols > 1 || existing.array.rows > 1) ? existing.array : undefined;
  if (!!ea !== !!p.array) return false;
  if (ea && p.array && (ea.cols !== p.array.cols || ea.rows !== p.array.rows || !near(ea.colSpacing, p.array.colSpacing) || !near(ea.rowSpacing, p.array.rowSpacing))) return false;
  return (
    existing.block === p.block &&
    near(existing.insert.x, p.at.x) &&
    near(existing.insert.y, p.at.y) &&
    near(existing.scale.x, p.scale.x) &&
    near(existing.scale.y, p.scale.y) &&
    near(existing.rotation, p.rotation)
  );
}
