/** DXF numeric group values are conventionally written with an explicit decimal point. */
export function n(x: number): string {
  const r = Math.round(x * 1e6) / 1e6;
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

export function pair(code: number, value: string | number): string {
  return `${code}\n${typeof value === "number" ? n(value) : value}\n`;
}
