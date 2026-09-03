/**
 * The shared entity-colour palette: distinct, reasonably legible hues used by
 * the Fill/Hatch tool's swatches and by plugins that colour-code output (the
 * load planner assigns one per order). Kept framework-free so both the web app
 * and the plugin SDK can import it and stay in sync.
 */
export const PALETTE: readonly string[] = [
  "#e2554e", // red
  "#e08a2e", // orange
  "#e0c341", // yellow
  "#5aa74f", // green
  "#3fa6a0", // teal
  "#4f86d6", // blue
  "#7a63d1", // indigo
  "#c765c0", // magenta
  "#9a7b52", // brown
  "#8a94a6", // slate
];

/** The palette colour at `index`, wrapping so any index is valid. */
export function colorAt(index: number): string {
  const n = PALETTE.length;
  return PALETTE[((index % n) + n) % n];
}
