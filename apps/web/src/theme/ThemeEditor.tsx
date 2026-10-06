import { useEffect, useMemo, useState } from "react";
import {
  checkTheme,
  isSafeColor,
  parseColor,
  resolveTheme,
  themeBundleFor,
  themeFromTokens,
  themeTokenKeys,
  toHex,
  validateTheme,
  type ThemeMode,
  type ThemeTokens,
} from "@sketchor/core";
import { installThemeBundle } from "./installedThemes";
import { useTheme } from "./themeStore";

/**
 * TH-04: the theme editor. Starts from whatever theme is showing, edits colours
 * live on the real app (`previewTokens`, never saved until asked), and shows the
 * WCAG ratio for every pair that has one — below 4.5:1 for text or 3:1 for
 * geometry is flagged. Saving installs it as an unsigned theme-only plugin;
 * Export downloads the same theme as a `.sketchor-theme.json` file.
 */

type Group = "ui" | "canvas" | "model3d" | "code";
const GROUPS: { id: Group; title: string }[] = [
  { id: "ui", title: "Interface" },
  { id: "canvas", title: "Canvas" },
  { id: "model3d", title: "3D viewer" },
  { id: "code", title: "Code" },
];

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ThemeEditor({ onClose }: { onClose: () => void }) {
  const start = useTheme.getState();
  const [tokens, setTokens] = useState<ThemeTokens>(() => structuredClone(start.tokens));
  const [base, setBase] = useState<ThemeMode>(start.resolved);
  const [name, setName] = useState("My theme");
  const [author, setAuthor] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const keys = useMemo(() => themeTokenKeys(), []);
  const previewTokens = useTheme((s) => s.previewTokens);
  const setSetting = useTheme((s) => s.setSetting);

  useEffect(() => {
    previewTokens(tokens);
  }, [tokens, previewTokens]);
  // Whatever way the editor closes, the unsaved colours must not stay applied.
  useEffect(() => () => useTheme.getState().previewTokens(null), []);

  const results = useMemo(() => checkTheme(tokens), [tokens]);
  const failing = results.filter((r) => !r.ok);
  const byToken = useMemo(() => {
    const m = new Map<string, typeof results>();
    for (const r of results) for (const path of [r.fg, r.bg]) m.set(path, [...(m.get(path) ?? []), r]);
    return m;
  }, [results]);

  const set = (g: Group, k: string, v: string) =>
    setTokens((t) => ({ ...t, [g]: { ...t[g], [k]: v } }) as ThemeTokens);

  const file = () => themeFromTokens(tokens, base, { name, author });

  const valid = () => {
    const f = file();
    const r = validateTheme(f);
    if (!r.ok) {
      setMessage({ ok: false, text: r.issues.map((i) => `${i.path} ${i.message}`).join("; ") });
      return null;
    }
    return f;
  };

  const save = () => {
    const f = valid();
    if (!f) return;
    const r = installThemeBundle(themeBundleFor(f));
    if (!r.ok) return setMessage({ ok: false, text: r.reason });
    const t = r.themes.find((x) => x.id === f.id) ?? r.themes[0];
    setSetting(`custom:${t.key}`);
    onClose();
  };

  const exportFile = () => {
    const f = valid();
    if (f) download(`${f.id}.sketchor-theme.json`, JSON.stringify(f, null, 2));
  };

  const reset = (mode: ThemeMode) => {
    setBase(mode);
    setTokens(structuredClone(resolveTheme({ id: "x", name: "x", base: mode, tokens: {} })));
  };

  return (
    <div className="theme-editor" data-testid="theme-editor">
      <div className="theme-editor-head">
        <strong>Theme editor</strong>
        <button className="btn ghost" onClick={onClose} title="Close without saving" data-testid="theme-editor-close">
          ✕
        </button>
      </div>
      <div className="theme-editor-meta">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Theme name" data-testid="theme-editor-name" />
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Author (optional)" />
        <select value={base} onChange={(e) => reset(e.target.value as ThemeMode)} title="Starting point; changing it discards edits">
          <option value="dark">Based on Dark</option>
          <option value="light">Based on Light</option>
        </select>
      </div>
      <div className={`theme-editor-summary ${failing.length ? "theme-editor-warn" : "theme-editor-pass"}`} data-testid="theme-editor-summary">
        {failing.length === 0
          ? "All contrast checks pass"
          : `${failing.length} contrast ${failing.length === 1 ? "check" : "checks"} below the recommended ratio: ${failing.map((f) => f.label).join(", ")}`}
      </div>
      <div className="theme-editor-list">
        {GROUPS.map((g) => (
          <section key={g.id}>
            <h4>{g.title}</h4>
            {keys[g.id].map((k) => {
              const value = (tokens[g.id] as unknown as Record<string, string>)[k];
              const parsed = parseColor(value);
              const bad = !isSafeColor(value);
              const checks = byToken.get(`${g.id}.${k}`) ?? [];
              return (
                <div className="theme-editor-row" key={k} data-testid={`theme-token-${g.id}-${k}`}>
                  <label>{k}</label>
                  <input
                    type="color"
                    value={parsed ? toHex(parsed) : "#000000"}
                    onChange={(e) => set(g.id, k, e.target.value)}
                    title="Pick a colour"
                  />
                  <input
                    className={bad ? "theme-editor-invalid" : ""}
                    value={value}
                    spellCheck={false}
                    onChange={(e) => set(g.id, k, e.target.value)}
                  />
                  <span className="theme-editor-ratios">
                    {checks.map((c) => (
                      <span
                        key={c.id}
                        className={c.ok ? "ratio-ok" : "ratio-bad"}
                        title={`${c.label}: ${c.ratio?.toFixed(2) ?? "?"}:1 (needs ${c.min}:1)`}
                      >
                        {c.ratio ? c.ratio.toFixed(1) : "?"}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      {message && <div className={message.ok ? "theme-editor-pass" : "theme-editor-warn"}>{message.text}</div>}
      <div className="theme-editor-actions">
        <button className="btn" onClick={save} data-testid="theme-editor-save" title="Install as an unsigned theme and switch to it">
          Save &amp; apply
        </button>
        <button className="btn ghost" onClick={exportFile} data-testid="theme-editor-export">
          Export .json
        </button>
      </div>
    </div>
  );
}
