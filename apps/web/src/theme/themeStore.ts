import { create } from "zustand";
import type { ThemeMode, ThemeTokens } from "@sketchor/core";
import { builtinTheme, defaultTheme, resolveTheme } from "@sketchor/core";
import { setCanvasTheme } from "../viewport/renderer";
import { getInstalledTheme } from "./installedThemes";

/**
 * Z-03: the one place a theme is chosen and pushed out to every surface —
 * `styles.css`'s `:root` variables (UI chrome), `viewport/renderer.ts`'s
 * canvas colours, and `model3d/modelScene.ts`'s stage/edge/highlight
 * colours. `localStorage` + manual load/save, same convention as
 * `keybindings.ts` (no zustand `persist` middleware in this codebase).
 */

/** A built-in mode, "system", a shipped theme `builtin:<id>` (TH-06), or an installed theme plugin's `custom:<pluginId>/<themeId>` (TH-02). */
export type ThemeSetting = ThemeMode | "system" | `builtin:${string}` | `custom:${string}`;

const isNamed = (v: unknown): v is `builtin:${string}` | `custom:${string}` =>
  typeof v === "string" && (v.startsWith("builtin:") || v.startsWith("custom:"));

/** The tokens and base mode a non-trivial setting names, or undefined when it's missing (an uninstalled theme). */
export function lookupTheme(setting: ThemeSetting): { tokens: ThemeTokens; base: ThemeMode } | undefined {
  if (setting.startsWith("builtin:")) {
    const file = builtinTheme(setting.slice(8));
    return file && { tokens: resolveTheme(file), base: file.base };
  }
  if (setting.startsWith("custom:")) {
    const t = getInstalledTheme(setting.slice(7));
    return t && { tokens: t.tokens, base: t.file.base };
  }
  return undefined;
}

const STORAGE_KEY = "sketchor.theme.v1";

function loadSetting(): ThemeSetting {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "dark" || raw === "light" || raw === "system" || isNamed(raw) ? (raw as ThemeSetting) : "system";
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
  if (isNamed(setting)) return lookupTheme(setting)?.base ?? (systemPrefersDark ? "dark" : "light");
  return setting === "system" ? (systemPrefersDark ? "dark" : "light") : (setting as ThemeMode);
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

/** What "Follow system" switches between: one theme for each OS appearance (TH-03). Never itself "system". */
export interface SystemPair {
  dark: Exclude<ThemeSetting, "system">;
  light: Exclude<ThemeSetting, "system">;
}

const PAIR_KEY = "sketchor.theme.pair.v1";
const DEFAULT_PAIR: SystemPair = { dark: "dark", light: "light" };

const isPairSetting = (v: unknown): v is SystemPair["dark"] => v === "dark" || v === "light" || isNamed(v);

function loadPair(): SystemPair {
  try {
    const raw = JSON.parse(localStorage.getItem(PAIR_KEY) ?? "null") as Partial<SystemPair> | null;
    return { dark: isPairSetting(raw?.dark) ? raw.dark : DEFAULT_PAIR.dark, light: isPairSetting(raw?.light) ? raw.light : DEFAULT_PAIR.light };
  } catch {
    return DEFAULT_PAIR;
  }
}

function savePair(pair: SystemPair): void {
  try {
    localStorage.setItem(PAIR_KEY, JSON.stringify(pair));
  } catch {
    /* storage unavailable — the pairing just won't survive a reload */
  }
}

/** Pure: "system" becomes the paired theme for the current OS appearance; anything else is itself. */
export function effectiveSetting(setting: ThemeSetting, pair: SystemPair, systemPrefersDark: boolean): Exclude<ThemeSetting, "system"> {
  return setting === "system" ? (systemPrefersDark ? pair.dark : pair.light) : setting;
}

interface ThemeState {
  setting: ThemeSetting;
  /** Dark/light themes "system" switches between. */
  pair: SystemPair;
  /** A theme being previewed on hover — applied to the app but never saved. */
  previewing: ThemeSetting | null;
  resolved: ThemeMode;
  tokens: ThemeTokens;
  setSetting: (setting: ThemeSetting) => void;
  setPair: (pair: Partial<SystemPair>) => void;
  /** Shows `setting` live without choosing it; `null` snaps back to the chosen theme. */
  preview: (setting: ThemeSetting | null) => void;
}

function computeAndApply(setting: ThemeSetting, pair: SystemPair): { resolved: ThemeMode; tokens: ThemeTokens } {
  const effective = effectiveSetting(setting, pair, systemPrefersDark());
  const resolved = resolveMode(effective, systemPrefersDark());
  // An uninstalled custom theme falls back to its base mode's defaults.
  const tokens = lookupTheme(effective)?.tokens ?? defaultTheme(resolved);
  applyTheme(tokens);
  return { resolved, tokens };
}

const initialSetting = loadSetting();
const initialPair = loadPair();

export const useTheme = create<ThemeState>((set, get) => ({
  setting: initialSetting,
  pair: initialPair,
  previewing: null,
  ...computeAndApply(initialSetting, initialPair),
  setSetting: (setting) => {
    saveSetting(setting);
    set({ setting, previewing: null, ...computeAndApply(setting, get().pair) });
  },
  setPair: (partial) => {
    const pair = { ...get().pair, ...partial };
    savePair(pair);
    const { setting } = get();
    set({ pair, previewing: null, ...computeAndApply(setting, pair) });
  },
  preview: (setting) => {
    const { setting: chosen, pair } = get();
    set({ previewing: setting, ...computeAndApply(setting ?? chosen, pair) });
  },
}));

// Live-follow the OS theme while "system" is selected (matches `prefers-color-scheme` switching, e.g. sunset/sunrise OS schedules), without a page reload.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const { setting, pair, previewing } = useTheme.getState();
    if (setting === "system" && previewing === null) useTheme.setState(computeAndApply(setting, pair));
  });
}
