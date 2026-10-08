import { useEffect } from "react";
import { useApp } from "../state/store";
import { isThemeFileName } from "../theme/themeFileInstall";
import { loadDrawingFile } from "./drawingFile";
import { formatOf } from "./formats";

/** Most files opened by one drop (each gets its own tab). */
const MAX_DROPPED = 8;

/**
 * SV-08: drop drawing files (DXF, SVG, DWG, EPS/AI, STEP/IGES — anything in
 * the F-09 registry) anywhere on the window to open them, one tab each.
 * Capture phase and registered after the theme drop, so a `.sketchor-theme.json`
 * is claimed by that handler first and never reaches here.
 */
export function useDrawingDrop(): void {
  useEffect(() => {
    const drop = async (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => formatOf(f.name) && !isThemeFileName(f.name)).slice(0, MAX_DROPPED);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      for (const f of files) {
        try {
          await loadDrawingFile(f.name, f);
        } catch (err) {
          useApp.getState().setSaveNotice({ kind: "error", message: `${f.name}: could not be opened (${(err as Error).message})`, at: Date.now() });
        }
      }
    };
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
