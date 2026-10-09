import type { DimensionEntity } from "../entities";
import type { DimStyle } from "./style";

/** Number to text under a style's decimals / zero suppression / separator. */
export function formatNumber(v: number, decimals: number, zero: DimStyle["zeroSuppress"], sep: string): string {
  let s = Math.abs(v) < 0.5 * Math.pow(10, -decimals) ? (0).toFixed(decimals) : v.toFixed(decimals);
  if (zero === "trailing" || zero === "both") {
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (zero === "leading" || zero === "both") s = s.replace(/^(-?)0(?=\.)/, "$1");
  return s.replace(".", sep);
}

/** The auto text of a measured value (before any override): "R", diameter and arc symbols, degrees, prefix/suffix. */
export function measuredText(e: Pick<DimensionEntity, "kind">, st: DimStyle, measure: number): string {
  if (!Number.isFinite(measure)) return "";
  switch (e.kind) {
    case "angular2l":
    case "angular3p":
      return formatNumber((measure * 180) / Math.PI, st.angleDecimals, st.zeroSuppress, st.decimalSep) + "°";
    default: {
      const body = formatNumber(measure * st.lengthFactor, st.decimals, st.zeroSuppress, st.decimalSep);
      const lead = e.kind === "radial" || e.kind === "jogged" ? "R" : e.kind === "diametric" ? "⌀" : e.kind === "arclength" ? "⌒" : "";
      return st.prefix + lead + body + st.suffix;
    }
  }
}

/** Final dimension text: the override (with `<>` standing for the measurement) or the measurement; reference dimensions in parentheses. */
export function formatDimText(e: DimensionEntity, st: DimStyle, measure: number): string {
  const auto = measuredText(e, st, measure);
  let out = auto;
  if (e.textOverride !== undefined && e.textOverride !== "") out = e.textOverride.includes("<>") ? e.textOverride.split("<>").join(auto) : e.textOverride;
  return e.driving === false && st.referenceParens ? `(${out})` : out;
}
