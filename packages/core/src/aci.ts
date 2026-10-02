/**
 * X-04: the AutoCAD Color Index (ACI) — DXF's 256-entry indexed palette
 * (group code 62 everywhere an entity/layer/table-record wants a colour).
 * Values verified against ezdxf's `DXF_DEFAULT_COLORS` (same table every
 * DXF-writing application ships, because readers expect exactly these RGBs
 * for a bare index — it's the published AutoCAD default, not Sketchor's own
 * choice). Index 0 is nominally "ByBlock" and index 256 ("ByLayer") isn't a
 * real palette entry — both are handled as "no explicit colour" by callers,
 * never looked up here.
 *
 * Index 7 is the odd one: "white on a dark background, black on a light
 * one" — every DXF reader special-cases it, which is also why it's
 * Sketchor's own default entity colour (see dxf.ts's unscaled-colour note
 * and theme.ts's `canvas.entity`, which inverts the same way per theme).
 */
export const ACI_PALETTE: readonly string[] = [
  "#000000", "#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ffffff",
  "#808080", "#c0c0c0", "#ff0000", "#ff7f7f", "#a50000", "#a55252", "#7f0000", "#7f3f3f",
  "#4c0000", "#4c2626", "#260000", "#261313", "#ff3f00", "#ff9f7f", "#a52900", "#a56752",
  "#7f1f00", "#7f4f3f", "#4c1300", "#4c2f26", "#260900", "#261713", "#ff7f00", "#ffbf7f",
  "#a55200", "#a57c52", "#7f3f00", "#7f5f3f", "#4c2600", "#4c3926", "#261300", "#261c13",
  "#ffbf00", "#ffdf7f", "#a57c00", "#a59152", "#7f5f00", "#7f6f3f", "#4c3900", "#4c4226",
  "#261c00", "#262113", "#ffff00", "#ffff7f", "#a5a500", "#a5a552", "#7f7f00", "#7f7f3f",
  "#4c4c00", "#4c4c26", "#262600", "#262613", "#bfff00", "#dfff7f", "#7ca500", "#91a552",
  "#5f7f00", "#6f7f3f", "#394c00", "#424c26", "#1c2600", "#212613", "#7fff00", "#bfff7f",
  "#52a500", "#7ca552", "#3f7f00", "#5f7f3f", "#264c00", "#394c26", "#132600", "#1c2613",
  "#3fff00", "#9fff7f", "#29a500", "#67a552", "#1f7f00", "#4f7f3f", "#134c00", "#2f4c26",
  "#092600", "#172613", "#00ff00", "#7fff7f", "#00a500", "#52a552", "#007f00", "#3f7f3f",
  "#004c00", "#264c26", "#002600", "#132613", "#00ff3f", "#7fff9f", "#00a529", "#52a567",
  "#007f1f", "#3f7f4f", "#004c13", "#264c2f", "#002609", "#135817", "#00ff7f", "#7fffbf",
  "#00a552", "#52a57c", "#007f3f", "#3f7f5f", "#004c26", "#264c39", "#002613", "#13581c",
  "#00ffbf", "#7fffdf", "#00a57c", "#52a591", "#007f5f", "#3f7f6f", "#004c39", "#264c42",
  "#00261c", "#135858", "#00ffff", "#7fffff", "#00a5a5", "#52a5a5", "#007f7f", "#3f7f7f",
  "#004c4c", "#264c4c", "#002626", "#135858", "#00bfff", "#7fdfff", "#007ca5", "#5291a5",
  "#005f7f", "#3f6f7f", "#00394c", "#26427e", "#001c26", "#135858", "#007fff", "#7fbfff",
  "#0052a5", "#527ca5", "#003f7f", "#3f5f7f", "#00264c", "#26397e", "#001326", "#131c58",
  "#003fff", "#7f9fff", "#0029a5", "#5267a5", "#001f7f", "#3f4f7f", "#00134c", "#262f7e",
  "#000926", "#131758", "#0000ff", "#7f7fff", "#0000a5", "#5252a5", "#00007f", "#3f3f7f",
  "#00004c", "#26267e", "#000026", "#131358", "#3f00ff", "#9f7fff", "#2900a5", "#6752a5",
  "#1f007f", "#4f3f7f", "#13004c", "#2f267e", "#090026", "#171358", "#7f00ff", "#bf7fff",
  "#5200a5", "#7c52a5", "#3f007f", "#5f3f7f", "#26004c", "#39267e", "#130026", "#1c1358",
  "#bf00ff", "#df7fff", "#7c00a5", "#9152a5", "#5f007f", "#6f3f7f", "#39004c", "#42264c",
  "#1c0026", "#581358", "#ff00ff", "#ff7fff", "#a500a5", "#a552a5", "#7f007f", "#7f3f7f",
  "#4c004c", "#4c264c", "#260026", "#581358", "#ff00bf", "#ff7fdf", "#a5007c", "#a55291",
  "#7f005f", "#7f3f6f", "#4c0039", "#4c2642", "#26001c", "#581358", "#ff007f", "#ff7fbf",
  "#a50052", "#a5527c", "#7f003f", "#7f3f5f", "#4c0026", "#4c2639", "#260013", "#58131c",
  "#ff003f", "#ff7f9f", "#a50029", "#a55267", "#7f001f", "#7f3f4f", "#4c0013", "#4c262f",
  "#260009", "#581317", "#000000", "#656565", "#666666", "#999999", "#cccccc", "#ffffff",
];

/** ACI index (0–255) → its palette hex. Out-of-range falls back to 7 (the "default" index). */
export function aciToHex(index: number): string {
  return ACI_PALETTE[index] ?? ACI_PALETTE[7];
}

/** `"#rrggbb"` (case/hash-insensitive) → `[r, g, b]`, or null for anything else (a named CSS colour, `rgba(...)`, malformed input — ACI has no use for those). */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

let paletteRgb: [number, number, number][] | null = null;
function palette(): [number, number, number][] {
  if (!paletteRgb) paletteRgb = ACI_PALETTE.map((h) => hexToRgb(h) ?? [0, 0, 0]);
  return paletteRgb;
}

/**
 * Nearest ACI index (1–255; 0/"ByBlock" is never returned) for an arbitrary
 * colour — used wherever only an indexed colour is representable (DXF R12's
 * group 62, and as the AC1032 writer's fallback alongside an exact true
 * colour). A non-hex `hex` (can't happen for a DXF-sourced colour, but
 * entity.color accepts any CSS colour) falls back to 7.
 */
export function nearestAci(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 7;
  const pal = palette();
  let best = 7;
  let bestDist = Infinity;
  for (let i = 1; i < pal.length; i++) {
    const [r, g, b] = pal[i];
    const d = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
