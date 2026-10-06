/** DXF numeric group values are conventionally written with an explicit decimal point. */
export function n(x: number): string {
  const r = Math.round(x * 1e6) / 1e6;
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

export function pair(code: number, value: string | number): string {
  return `${code}\n${typeof value === "number" ? n(value) : value}\n`;
}

export interface HeaderBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * HEADER variables shared by the R12 and AC1032 writers (X-06): units
 * (`$INSUNITS`, `$MEASUREMENT`, `$LUNITS/$LUPREC/$AUNITS/$AUPREC`) and the
 * model- and paper-space extents/limits. `$MEASUREMENT` is only written for a
 * declared unit: dxf.ts's reader treats it as authoritative when `$INSUNITS`
 * is absent or 0 (Onshape's R14 export carries only that), so writing "0" for
 * an unspecified drawing would make our own file come back as inches, 25.4x
 * too big — the misread the v0.26 unit-detection work exists to prevent.
 */
export function unitsAndExtentsHeader(insUnits: number, b: HeaderBounds): string {
  const metric = insUnits === 4 || insUnits === 5 || insUnits === 6 || (insUnits >= 7 && insUnits <= 10);
  const imperial = insUnits === 1 || insUnits === 2;
  const pt = (code: number, x: number, y: number) => `${code}\n${n(x)}\n${code + 10}\n${n(y)}\n`;
  const point = (name: string, x: number, y: number) => `9\n${name}\n${pt(10, x, y)}`;
  return (
    (insUnits === 0 ? "" : `9\n$MEASUREMENT\n70\n${metric && !imperial ? 1 : 0}\n`) +
    `9\n$INSUNITS\n70\n${insUnits}\n` +
    // Decimal linear display (LUNITS 2), 4 places; decimal degrees (AUNITS 0).
    `9\n$LUNITS\n70\n2\n9\n$LUPREC\n70\n4\n9\n$AUNITS\n70\n0\n9\n$AUPREC\n70\n0\n` +
    `9\n$INSBASE\n10\n0.0\n20\n0.0\n30\n0.0\n` +
    `9\n$EXTMIN\n10\n${n(b.minX)}\n20\n${n(b.minY)}\n30\n0.0\n` +
    `9\n$EXTMAX\n10\n${n(b.maxX)}\n20\n${n(b.maxY)}\n30\n0.0\n` +
    point("$LIMMIN", b.minX, b.minY) +
    point("$LIMMAX", b.maxX, b.maxY) +
    // Nothing lives in paper space yet: AutoCAD's own empty-layout sentinels.
    `9\n$PEXTMIN\n10\n1e20\n20\n1e20\n30\n1e20\n9\n$PEXTMAX\n10\n-1e20\n20\n-1e20\n30\n-1e20\n` +
    point("$PLIMMIN", 0, 0) +
    point("$PLIMMAX", 12, 9)
  );
}
