import { create } from "zustand";

/**
 * User-rebindable keyboard shortcuts. Every action a toolbar button performs
 * (a tool switch, undo, save, print, ...) has a stable id here; the actual key
 * combo is data the user can change — via the Shortcuts panel or by
 * right-clicking the button — not a literal comparison buried in a keydown
 * handler. `Viewport.tsx`'s global keydown listener and `App.tsx`'s toolbar
 * buttons both read the current binding through {@link matchesBinding} /
 * {@link useKeybindings} instead of hard-coding a key.
 *
 * A handful of keys stay hard-coded on purpose because they're mode-dependent
 * rather than a single command: Escape, Delete/Backspace-to-delete-selection,
 * and the in-progress-polyline keys (Enter/C/Backspace while drawing).
 */
export interface ActionDef {
  id: string;
  label: string;
  group: string;
}

export const ACTIONS: ActionDef[] = [
  { id: "tool.select", label: "Select tool", group: "Tools" },
  { id: "tool.line", label: "Line tool", group: "Tools" },
  { id: "tool.polyline", label: "Polyline tool", group: "Tools" },
  { id: "tool.rectangle", label: "Rectangle tool", group: "Tools" },
  { id: "tool.circle", label: "Circle tool", group: "Tools" },
  { id: "tool.point", label: "Point tool", group: "Tools" },
  { id: "tool.measure", label: "Measure tool", group: "Tools" },
  { id: "tool.straighten", label: "Straighten tool", group: "Tools" },
  { id: "tool.fill", label: "Fill tool", group: "Tools" },
  { id: "tool.text", label: "Text tool", group: "Tools" },
  { id: "tool.dim", label: "Dimension tool", group: "Tools" },
  { id: "edit.toggleConstruction", label: "Toggle construction line", group: "Edit" },
  { id: "file.open", label: "Open drawing", group: "File" },
  { id: "file.save", label: "Save", group: "File" },
  { id: "file.print", label: "Print / Save as PDF", group: "File" },
  { id: "file.closeTab", label: "Close tab", group: "File" },
  { id: "edit.undo", label: "Undo", group: "Edit" },
  { id: "edit.redo", label: "Redo", group: "Edit" },
  { id: "edit.group", label: "Group selection", group: "Edit" },
  { id: "edit.ungroup", label: "Ungroup selection", group: "Edit" },
  { id: "view.fit", label: "Fit view to selection", group: "View" },
  { id: "app.commandPalette", label: "Command palette", group: "App" },
  { id: "app.truckNesting", label: "Truck Load Planner", group: "App" },
  { id: "app.shortcuts", label: "Keyboard shortcuts", group: "App" },
  { id: "app.toggleLayers", label: "Toggle layers panel", group: "App" },
  { id: "app.toggleCode", label: "Toggle sketch code panel", group: "App" },
];

export const DEFAULT_BINDINGS: Record<string, string> = {
  "tool.select": "v",
  "tool.line": "l",
  "tool.polyline": "w",
  "tool.rectangle": "r",
  "tool.circle": "c",
  "tool.point": "p",
  "tool.measure": "m",
  "tool.straighten": "t",
  "tool.fill": "h",
  "tool.text": "x",
  "tool.dim": "d",
  "edit.toggleConstruction": "shift+c",
  "file.open": "ctrl+o",
  "file.save": "ctrl+s",
  "file.print": "ctrl+p",
  "file.closeTab": "ctrl+w",
  "edit.undo": "ctrl+z",
  "edit.redo": "ctrl+y",
  "edit.group": "g",
  "edit.ungroup": "u",
  "view.fit": "f",
  "app.commandPalette": "ctrl+k",
  "app.truckNesting": "",
  "app.shortcuts": "",
  "app.toggleLayers": "",
  "app.toggleCode": "",
};

const STORAGE_KEY = "sketchor.keybindings.v1";

function loadBindings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BINDINGS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_BINDINGS };
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

function saveBindings(bindings: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    /* storage unavailable — bindings just won't survive a reload */
  }
}

interface KeybindingsState {
  bindings: Record<string, string>;
  setBinding: (id: string, combo: string) => void;
  clearBinding: (id: string) => void;
  resetBinding: (id: string) => void;
}

export const useKeybindings = create<KeybindingsState>((set, get) => ({
  bindings: loadBindings(),
  setBinding: (id, combo) => {
    // A combo can only be bound to one action at a time — stealing it from
    // whoever had it avoids two buttons silently fighting over one key.
    const bindings = { ...get().bindings };
    for (const k of Object.keys(bindings)) if (k !== id && bindings[k] === combo && combo !== "") bindings[k] = "";
    bindings[id] = combo;
    saveBindings(bindings);
    set({ bindings });
  },
  clearBinding: (id) => {
    const bindings = { ...get().bindings, [id]: "" };
    saveBindings(bindings);
    set({ bindings });
  },
  resetBinding: (id) => {
    const bindings = { ...get().bindings, [id]: DEFAULT_BINDINGS[id] ?? "" };
    saveBindings(bindings);
    set({ bindings });
  },
}));

const MODIFIER_KEYS = new Set(["control", "meta", "alt", "shift"]);

/**
 * Canonical combo string for a keyboard event, e.g. "ctrl+shift+z". Cmd and
 * Ctrl are treated as the same binding so one combo works on every platform.
 */
export function comboFromEvent(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; key: string }): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key = e.key.toLowerCase();
  if (!MODIFIER_KEYS.has(key)) parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

/** True if `e` matches the currently bound combo for `actionId` (false when unbound). */
export function matchesBinding(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; key: string }, actionId: string): boolean {
  const combo = useKeybindings.getState().bindings[actionId];
  if (!combo) return false;
  return comboFromEvent(e) === combo;
}

/** Human-readable form of a combo string for display ("ctrl+shift+z" -> "Ctrl+Shift+Z"). */
export function bindingLabel(combo: string | undefined): string {
  if (!combo) return "";
  return combo
    .split("+")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+");
}
