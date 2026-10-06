import { useEffect, useState } from "react";
import { BUILTIN_THEMES, DEFAULT_DARK, DEFAULT_LIGHT, resolveTheme, type ThemeTokens } from "@sketchor/core";
import { listInstalledThemes, onThemesChange } from "./installedThemes";
import { useTheme, type ThemeSetting } from "./themeStore";

/**
 * TH-03: the theme picker. A grid of cards, each a miniature of the app drawn
 * with that theme's own tokens; hovering a card previews it on the real app
 * (never saved), clicking applies it. "Follow system" switches between a
 * chosen dark theme and a chosen light theme as the OS appearance changes.
 */

type Choice = Exclude<ThemeSetting, "system">;

interface Entry {
  setting: Choice;
  title: string;
  tokens: ThemeTokens;
  /** True for dark themes, by the theme file's own `base` (built-ins by id). */
  dark: boolean;
  /** An installed, unsigned theme-plugin theme. */
  custom: boolean;
}

function useEntries(): Entry[] {
  const [installed, setInstalled] = useState(() => listInstalledThemes());
  useEffect(() => onThemesChange(() => setInstalled(listInstalledThemes())), []);
  return [
    { setting: "dark", title: "Dark", tokens: DEFAULT_DARK, dark: true, custom: false },
    { setting: "light", title: "Light", tokens: DEFAULT_LIGHT, dark: false, custom: false },
    ...BUILTIN_THEMES.map(
      (t): Entry => ({ setting: `builtin:${t.id}`, title: t.name, tokens: resolveTheme(t), dark: t.base === "dark", custom: false }),
    ),
    ...installed.map(
      (t): Entry => ({ setting: `custom:${t.key}`, title: t.title, tokens: t.tokens, dark: t.file.base === "dark", custom: true }),
    ),
  ];
}

function tokensOf(entries: Entry[], setting: Choice): ThemeTokens {
  return entries.find((e) => e.setting === setting)?.tokens ?? (setting === "light" ? DEFAULT_LIGHT : DEFAULT_DARK);
}

/** A 96×64 miniature: toolbar strip, side panel, canvas with a grid, a polyline, a circle and a selected line. */
function Mini({ tokens }: { tokens: ThemeTokens }) {
  const { ui, canvas } = tokens;
  return (
    <svg viewBox="0 0 96 64" width="96" height="64" aria-hidden="true">
      <rect width="96" height="64" fill={ui.bg} />
      <rect width="96" height="8" fill={ui.panel} />
      <line x1="0" y1="8" x2="96" y2="8" stroke={ui.border} />
      <rect x="4" y="2.5" width="14" height="3" rx="1.5" fill={ui.accent} />
      <rect x="22" y="2.5" width="10" height="3" rx="1.5" fill={ui.textDim} />
      <rect x="0" y="8.5" width="16" height="55.5" fill={ui.panel} />
      <rect x="3" y="13" width="10" height="2" rx="1" fill={ui.text} />
      <rect x="3" y="18" width="7" height="2" rx="1" fill={ui.textDim} />
      <rect x="3" y="23" width="9" height="2" rx="1" fill={ui.textDim} />
      <rect x="3" y="28" width="10" height="4" rx="1" fill={ui.accentSoft} />
      <rect x="16.5" y="8.5" width="79.5" height="55.5" fill={canvas.bg} />
      {[28, 40, 52, 64, 76, 88].map((x) => (
        <line key={`v${x}`} x1={x} y1="9" x2={x} y2="64" stroke={x === 28 || x === 76 ? canvas.gridMajor : canvas.gridMinor} />
      ))}
      {[20, 32, 44].map((y) => (
        <line key={`h${y}`} x1="17" y1={y} x2="96" y2={y} stroke={y === 32 ? canvas.gridMajor : canvas.gridMinor} />
      ))}
      <line x1="17" y1="56" x2="96" y2="56" stroke={canvas.axisX} />
      <line x1="28" y1="9" x2="28" y2="64" stroke={canvas.axisY} />
      <polyline points="34,48 62,48 62,26" fill="none" stroke={canvas.entity} strokeWidth="1.2" />
      <circle cx="74" cy="38" r="9" fill="none" stroke={canvas.entity} strokeWidth="1.2" />
      <line x1="36" y1="22" x2="58" y2="34" stroke={canvas.selected} strokeWidth="1.4" />
      <rect x="34.5" y="20.5" width="3" height="3" fill={canvas.handle} />
      <rect x="56.5" y="32.5" width="3" height="3" fill={canvas.handle} />
    </svg>
  );
}

export function ThemePicker({ onClose }: { onClose: () => void }) {
  const entries = useEntries();
  const setting = useTheme((s) => s.setting);
  const pair = useTheme((s) => s.pair);
  const setSetting = useTheme((s) => s.setSetting);
  const setPair = useTheme((s) => s.setPair);
  const preview = useTheme((s) => s.preview);

  // However the picker closes, a hover preview must not stay applied.
  useEffect(() => () => useTheme.getState().preview(null), []);

  const apply = (next: ThemeSetting) => {
    setSetting(next);
    onClose();
  };

  return (
    <div className="theme-picker" data-testid="theme-menu" onMouseLeave={() => preview(null)}>
      <div className="theme-grid">
        {entries.map((e) => (
          <button
            key={e.setting}
            className={`theme-card${setting === e.setting ? " theme-card-active" : ""}`}
            data-testid={e.setting.startsWith("custom:") ? `theme-custom-${e.setting.slice(7)}` : `theme-${e.setting.replace(":", "-")}`}
            onMouseEnter={() => preview(e.setting)}
            onFocus={() => preview(e.setting)}
            onBlur={() => preview(null)}
            onClick={() => apply(e.setting)}
          >
            <Mini tokens={e.tokens} />
            <span className="theme-card-title">{e.title}</span>
            {e.custom && <span className="theme-card-tag">Unsigned theme</span>}
          </button>
        ))}
        <button
          className={`theme-card${setting === "system" ? " theme-card-active" : ""}`}
          data-testid="theme-system"
          onMouseEnter={() => preview("system")}
          onFocus={() => preview("system")}
          onBlur={() => preview(null)}
          onClick={() => apply("system")}
        >
          <span className="theme-split">
            <span className="theme-split-half">
              <Mini tokens={tokensOf(entries, pair.dark)} />
            </span>
            <span className="theme-split-half theme-split-light">
              <Mini tokens={tokensOf(entries, pair.light)} />
            </span>
          </span>
          <span className="theme-card-title">Follow system</span>
        </button>
      </div>
      <div className="theme-pair" data-testid="theme-pair">
        {(["dark", "light"] as const).map((mode) => (
          <label key={mode}>
            System {mode}
            <select
              data-testid={`theme-pair-${mode}`}
              value={pair[mode]}
              onChange={(ev) => setPair({ [mode]: ev.target.value as Choice })}
            >
              {entries
                .filter((e) => e.dark === (mode === "dark"))
                .map((e) => (
                  <option key={e.setting} value={e.setting}>
                    {e.title}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}
