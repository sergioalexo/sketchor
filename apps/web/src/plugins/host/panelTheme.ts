import type { ThemeTokens } from "@sketchor/core";

/**
 * TH-08: plugin panels live in an opaque-origin iframe and can't see the host's
 * CSS variables, so the host hands them the `ui.*` tokens as `--sk-*` custom
 * properties. A panel opts in with `var(--sk-bg, #1e1f22)`-style references
 * (the fallback keeps it readable in an older host). The first values are
 * baked into the srcDoc; later theme changes arrive as a `sketchorTheme`
 * message so the panel keeps its state instead of reloading.
 */
export type PanelThemeVars = Record<string, string>;

export function panelThemeVars(tokens: ThemeTokens): PanelThemeVars {
  const { ui } = tokens;
  return {
    "--sk-bg": ui.bg,
    "--sk-panel": ui.panel,
    "--sk-border": ui.border,
    "--sk-text": ui.text,
    "--sk-text-dim": ui.textDim,
    "--sk-accent": ui.accent,
    "--sk-accent-soft": ui.accentSoft,
    "--sk-danger": ui.danger,
  };
}

const cssText = (vars: PanelThemeVars) =>
  `:root{${Object.entries(vars)
    .map(([k, v]) => `${k}:${String(v).replace(/[<>{};]/g, "")}`)
    .join(";")}}`;

/** Style + listener injected at the top of a panel's `<head>`. */
export function panelThemeHead(vars: PanelThemeVars): string {
  const script =
    "addEventListener('message',function(e){var d=e.data;if(!d||!d.sketchorTheme||e.source!==parent)return;" +
    "var s=document.getElementById('sketchor-theme');if(s&&typeof d.sketchorTheme==='string')s.textContent=d.sketchorTheme;});";
  return `<style id="sketchor-theme">${cssText(vars)}</style><script>${script}</script>`;
}

/** The message the host posts to a live panel when the theme changes. */
export function panelThemeMessage(vars: PanelThemeVars): { sketchorTheme: string } {
  return { sketchorTheme: cssText(vars) };
}
