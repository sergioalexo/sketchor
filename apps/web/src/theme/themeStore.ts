import { create } from "zustand";
import type { ThemeMode, ThemeTokens } from "@sketchor/core";
import { defaultTheme } from "@sketchor/core";
import { setCanvasTheme } from "../viewport/renderer";

/**
 * Z-03: the one place a theme is chosen and pushed out to every surface —
 * `styles.css`'s `:root` variables (UI chrome), `viewport/renderer.ts`'s
 * canvas colours, and `model3d/modelScene.ts`'s stage/edge/highlight
 * colours. `localStorage` + manual load/save, same convention as
 * `keybindings.ts` (no zustand `persist` middleware in this codebase).
 */

export type ThemeSetting = ThemeMode | "system";

const STORAGE_KEY = "sketchor.theme.v1";

function loadSetting(): ThemeSetting {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "dark" || raw === "light" || raw === "system" ? raw : "system";
  } catch {
    return "system";
  }
}

function saveSetting(setting: ThemeSetting): void {
  try {
    localStorage.setItem(STORAGE_KEY, setting);
  } catch {
    /* storage unavailable — the choice just won't survive a reload */
  }
}

/** Pure: a `ThemeSetting` plus whatever `prefers-color-scheme` says resolves to one real mode. Exported for testing without touching `matchMedia`. */
export function resolveMode(setting: ThemeSetting, systemPrefersDark: boolean): ThemeMode {
  return setting === "system" ? (systemPrefersDark ? "dark" : "light") : setting;
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true; // no media-query support (or SSR/tests): fall back to today's only theme
}

/** Writes `ui.*` (+ `danger`) as CSS custom properties on `:root`, and pushes `canvas.*`/`model3d.*` to the renderer/3D viewer. */
function applyTheme(tokens: ThemeTokens): void {
  setCanvasTheme(tokens.canvas);
  // model3d/modelScene.ts imports three.js, which the thumbnail worker and
  // every other non-3D code path would otherwise pull in — load it lazily so
  // picking a theme on a tab that never opens a model stays light.
  void import("../model3d/modelScene").then(({ setModel3dTheme }) => setModel3dTheme(tokens.model3d));
  if (typeof document === "undefined") return; // no DOM (a non-browser import) — CSS vars are skipped, canvas/3D theming above still applies
  const root = document.documentElement;
  root.style.setProperty("--bg", tokens.ui.bg);
  root.style.setProperty("--panel", tokens.ui.panel);
  root.style.setProperty("--border", tokens.ui.border);
  root.style.setProperty("--text", tokens.ui.text);
  root.style.setProperty("--text-dim", tokens.ui.textDim);
  root.style.setProperty("--accent", tokens.ui.accent);
  root.style.setProperty("--accent-soft", tokens.ui.accentSoft);
  root.style.setProperty("--danger", tokens.ui.danger);
  if (tokens.fonts?.mono) root.style.setProperty("--mono", tokens.fonts.mono);
}

interface ThemeState {
  setting: ThemeSetting;
  resolved: ThemeMode;
  tokens: ThemeTokens;
  setSetting: (setting: ThemeSetting) => void;
}

function computeAndApply(setting: ThemeSetting): { resolved: ThemeMode; tokens: ThemeTokens } {
  const resolved = resolveMode(setting, systemPrefersDark());
  const tokens = defaultTheme(resolved);
  applyTheme(tokens);
  return { resolved, tokens };
}

const initialSetting = loadSetting();

export const useTheme = create<ThemeState>((set) => ({
  setting: initialSetting,
  ...computeAndApply(initialSetting),
  setSetting: (setting) => {
    saveSetting(setting);
    set({ setting, ...computeAndApply(setting) });
  },
}));

// Live-follow the OS theme while "system" is selected (matches `prefers-color-scheme` switching, e.g. sunset/sunrise OS schedules), without a page reload.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const { setting } = useTheme.getState();
    if (setting === "system") useTheme.setState(computeAndApply(setting));
  });
}
