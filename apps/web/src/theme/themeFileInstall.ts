import { isThemeBundle, loadThemeBundle, themeBundleFor, validateTheme, type ThemeBundle } from "@sketchor/core";

/**
 * TH-05: what a dropped or picked file means as a theme. A theme-only plugin
 * bundle (manifest + themes) is used as is; a bare theme file
 * (`.sketchor-theme.json`, what the editor exports) is wrapped in a generated
 * manifest. Either way `loadThemeBundle` is the gate — nothing is installed
 * from here, the caller confirms first.
 */
export type ThemeFileParse =
  | { ok: true; bundle: ThemeBundle; titles: string[] }
  | { ok: false; reason: string; notATheme: boolean };

export const isThemeFileName = (name: string): boolean => /\.sketchor-theme(\.json)?$/i.test(name);

export function parseThemeFileText(text: string): ThemeFileParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON.", notATheme: true };
  }
  let bundle: ThemeBundle;
  if (isThemeBundle(parsed)) {
    bundle = parsed;
  } else if (parsed && typeof parsed === "object" && "base" in parsed && "tokens" in parsed) {
    const v = validateTheme(parsed);
    if (!v.ok) return { ok: false, reason: v.issues.map((i) => `${i.path} ${i.message}`.trim()).join("; "), notATheme: false };
    bundle = themeBundleFor(v.theme);
  } else {
    return { ok: false, reason: "That isn't a Sketchor theme.", notATheme: true };
  }
  const r = loadThemeBundle(bundle);
  if (!r.ok) return { ok: false, reason: r.errors.join("; "), notATheme: false };
  return { ok: true, bundle, titles: r.themes.map((t) => t.title) };
}
