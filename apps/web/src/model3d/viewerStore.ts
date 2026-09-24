import { create } from "zustand";
import type { SelRef } from "./measure";
import { sameRef } from "./measure";

/**
 * What is selected, hovered and hidden in the model tab — shared state
 * because two views drive it: the 3D canvas (click a face, an edge, a
 * vertex) and the Structure panel beside it (click a part in the tree).
 *
 * Selection is a list of references, newest last: the measurement readout
 * reads the last two, the way Onshape's measure box does.
 */

const MAX_SELECTION = 8;

const DENSITY_STORAGE_KEY = "sketchor.density.v1";
/** Generic structural steel (g/cm³) — a reasonable default until the user says otherwise. */
const DEFAULT_DENSITY = 7.85;

function loadDensity(): number {
  try {
    const raw = localStorage.getItem(DENSITY_STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_DENSITY;
  } catch {
    return DEFAULT_DENSITY;
  }
}

function saveDensity(v: number): void {
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, String(v));
  } catch {
    /* storage unavailable */
  }
}

interface ViewerState {
  /** Hash of the model this state belongs to; a different model resets it. */
  modelHash: string | null;
  selection: SelRef[];
  hover: SelRef | null;
  /** Part indices hidden from the view. */
  hidden: Set<number>;
  /** Bumped to ask the viewer to frame a part (the panel can't drive the camera itself). */
  frameRequest: { part: number; n: number } | null;
  /** Bumped to ask the viewer to fit everything still visible — what isolating should end with. */
  fitRequest: number;
  /** Material density (g/cm³) the mass-properties readout multiplies volume by — one value for the whole model, persisted across sessions. */
  density: number;

  useModel(hash: string): void;
  setDensity(v: number): void;
  setSelection(selection: SelRef[]): void;
  /** Click semantics: plain replaces, additive toggles. */
  pick(ref: SelRef | null, additive: boolean): void;
  setHover(ref: SelRef | null): void;
  hide(part: number): void;
  toggleHidden(part: number): void;
  /**
   * Isolate: hide everything *except* these parts. The way you look
   * inside an assembly — and the reason it is one action rather than
   * "hide the other 126 parts" is that it has to be reversible in one
   * click, which Show all is.
   */
  isolate(parts: readonly number[], partCount: number): void;
  showAll(): void;
  requestFrame(part: number): void;
}

export const useViewer = create<ViewerState>((set, get) => ({
  modelHash: null,
  selection: [],
  hover: null,
  hidden: new Set(),
  frameRequest: null,
  fitRequest: 0,
  density: loadDensity(),

  setDensity: (v) => {
    if (!Number.isFinite(v) || v <= 0) return;
    saveDensity(v);
    set({ density: v });
  },
  useModel: (hash) => {
    if (get().modelHash === hash) return;
    set({ modelHash: hash, selection: [], hover: null, hidden: new Set(), frameRequest: null, fitRequest: 0 });
  },
  setSelection: (selection) => set({ selection: selection.slice(-MAX_SELECTION) }),
  pick: (ref, additive) => {
    if (!ref) {
      // A plain click on empty space clears; an additive one missed the thing
      // it was aiming at, and throwing the selection away for that is cruel.
      if (!additive) set({ selection: [] });
      return;
    }
    const current = get().selection;
    if (!additive) {
      set({ selection: [ref] });
      return;
    }
    const without = current.filter((r) => !sameRef(r, ref));
    set({ selection: (without.length === current.length ? [...current, ref] : without).slice(-MAX_SELECTION) });
  },
  setHover: (ref) => {
    const prev = get().hover;
    if (prev === ref || (prev && ref && sameRef(prev, ref))) return;
    set({ hover: ref });
  },
  hide: (part) =>
    set((s) => ({
      hidden: new Set(s.hidden).add(part),
      selection: s.selection.filter((r) => r.kind === "part" && r.index === part ? false : true),
    })),
  isolate: (parts, partCount) => {
    const keep = new Set(parts);
    if (keep.size === 0) return;
    const hidden = new Set<number>();
    for (let i = 0; i < partCount; i++) if (!keep.has(i)) hidden.add(i);
    // Fit afterwards: isolating one screw in a 127-part assembly and
    // leaving the camera where it was shows you an empty screen with a
    // speck in it.
    set((s) => ({ hidden, fitRequest: s.fitRequest + 1 }));
  },
  toggleHidden: (part) =>
    set((s) => {
      const next = new Set(s.hidden);
      if (next.has(part)) next.delete(part);
      else next.add(part);
      return { hidden: next };
    }),
  showAll: () => set({ hidden: new Set() }),
  requestFrame: (part) => set((s) => ({ frameRequest: { part, n: (s.frameRequest?.n ?? 0) + 1 } })),
}));
