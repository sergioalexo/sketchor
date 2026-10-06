import { useEffect } from "react";
import { useApp } from "../state/store";
import { installThemeBundle } from "./installedThemes";
import { isThemeFileName, parseThemeFileText } from "./themeFileInstall";
import { useTheme } from "./themeStore";

/**
 * TH-05: drop a `.sketchor-theme.json` anywhere on the window to install it.
 * Only files named like a theme are claimed (capture phase, so a canvas or
 * panel drop handler never sees them); everything else is left alone. A
 * confirm dialog comes first — a theme can't run code, but it is still
 * something the user didn't type.
 */
export function useThemeDrop(): void {
  useEffect(() => {
    const drop = async (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => isThemeFileName(f.name));
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const notice = useApp.getState().setSaveNotice;
      for (const f of files) {
        const r = parseThemeFileText(await f.text());
        if (!r.ok) {
          notice({ kind: "error", message: `${f.name}: ${r.reason}`, at: Date.now() });
          continue;
        }
        const names = r.titles.join(", ");
        if (!window.confirm(`Install the unsigned theme ${names} and switch to it?\n\nThemes only change colours and can't run code.`)) continue;
        const res = installThemeBundle(r.bundle);
        if (!res.ok) {
          notice({ kind: "error", message: `Not installed: ${res.reason}`, at: Date.now() });
          continue;
        }
        useTheme.getState().setSetting(`custom:${res.themes[0].key}`);
        notice({ kind: "saved", message: `Installed theme ${names}`, at: Date.now() });
      }
    };
    // dragover must be cancelled for the browser to deliver a drop at all.
    const allow = (e: DragEvent) => {
      if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", allow, true);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragover", allow, true);
      window.removeEventListener("drop", drop, true);
    };
  }, []);
}
