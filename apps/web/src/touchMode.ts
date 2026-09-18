import { create } from "zustand";

/**
 * Touch mode: finger-sized UI. The tool rail moves to the bottom of the
 * screen as a row of big labelled buttons (thumbs reach the bottom edge,
 * not the left one), the 3D viewer's toolbar does the same, and the toolbar
 * and status bar grow to comfortable tap targets.
 *
 * It's a user preference, not a device sniff: it defaults on when the
 * browser reports a coarse pointer (a tablet, a touch laptop being poked)
 * and the topbar button flips it either way, remembered across launches —
 * the same manual load/save convention as the display unit and keybindings.
 * Gesture handling in the viewports does *not* depend on it: pinch-zoom and
 * two-finger pan always work; touch mode is only about layout.
 */

const STORAGE_KEY = "sketchor.touchMode.v1";

function loadTouchMode(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* storage unavailable — fall through to the device default */
  }
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function saveTouchMode(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* private mode / storage disabled — the choice just won't persist */
  }
}

interface TouchModeState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

export const useTouchMode = create<TouchModeState>((set, get) => ({
  enabled: loadTouchMode(),
  setEnabled: (enabled) => {
    saveTouchMode(enabled);
    set({ enabled });
  },
  toggle: () => get().setEnabled(!get().enabled),
}));
