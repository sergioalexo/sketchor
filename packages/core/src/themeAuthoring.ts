/**
 * TH-04: turning an edited token set back into a shareable theme — only the
 * tokens that differ from the base are written, so a theme survives later
 * changes to the base's other colours.
 */
import { defaultTheme, type ThemeMode, type ThemeTokens } from "./theme";
import { THEME_SCHEMA_URL, themeTokenKeys, type ThemeFile, type ThemeOverrides } from "./themeFile";
import type { ThemeBundle } from "./plugin/themeBundle";

export function themeId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, 48) || "theme"
  );
}

/** The minimal theme file that reproduces `tokens` on top of `base`. */
export function themeFromTokens(tokens: ThemeTokens, base: ThemeMode, meta: { name: string; author?: string; id?: string }): ThemeFile {
  const ref = defaultTheme(base);
  const keys = themeTokenKeys();
  const overrides: ThemeOverrides = {};
  for (const g of ["ui", "canvas", "model3d", "code"] as const) {
    const diff: Record<string, string> = {};
    for (const k of keys[g]) {
      const v = (tokens[g] as unknown as Record<string, string>)[k];
      if (v !== (ref[g] as unknown as Record<string, string>)[k]) diff[k] = v;
    }
    if (Object.keys(diff).length) (overrides as Record<string, unknown>)[g] = diff;
  }
  if (tokens.fonts && JSON.stringify(tokens.fonts) !== JSON.stringify(ref.fonts ?? {})) {
    const f = { ...tokens.fonts };
    if (Object.keys(f).length) overrides.fonts = f;
  }
  const name = meta.name.trim() || "My theme";
  return {
    $schema: THEME_SCHEMA_URL,
    id: meta.id ?? themeId(name),
    name,
    ...(meta.author?.trim() ? { author: meta.author.trim() } : {}),
    version: "1.0.0",
    base,
    tokens: overrides,
  };
}

/** An unsigned theme-only plugin bundle (manifest + the theme file) for `file`. */
export function themeBundleFor(file: ThemeFile, engines = "^0.5.0"): ThemeBundle {
  const path = `themes/${file.id}.json`;
  return {
    manifest: JSON.stringify(
      {
        id: `user.theme.${file.id}`,
        version: file.version ?? "1.0.0",
        name: file.name,
        engines: { sketchor: engines },
        contributes: { themes: [{ id: file.id, title: file.name, file: path }] },
      },
      null,
      2,
    ),
    themes: { [path]: JSON.stringify(file, null, 2) },
  };
}
