import { describe, expect, it } from "vitest";
import { CONSTRAINT_LABELS } from "@sketchor/core";
import { ACTIONS, DEFAULT_BINDINGS, useKeybindings } from "../keybindings";
import { APP_ALIASES } from "../tools/commandLine";
import { SNAP_KIND_LABELS } from "../tools/snapSettings";
import {
  COMMAND_LINE_ACTIONS,
  TRACKED_BUTTONS,
  TRACKED_PREFIXES,
  actionForClick,
  actionForKeydown,
  actionForTestId,
} from "./actions";

/**
 * The `action` event is a whitelist over test ids. Three things can go wrong
 * silently: a renamed test id stops a chart series without anyone noticing,
 * a runtime-built id (a layer, a part or a tag name) starts leaking user data
 * into it, and a new command-line alias dispatches something that is never
 * counted. All three are checked here against the real components.
 */

// Every component's source, as text (Vite's glob import; vitest runs it too).
const COMPONENT_SOURCES = import.meta.glob<string>("../**/*.tsx", { query: "?raw", import: "default", eager: true });
const sources = Object.values(COMPONENT_SOURCES).join("\n");

describe("TRACKED_BUTTONS", () => {
  it("names only test ids that exist on a component", () => {
    const missing = Object.keys(TRACKED_BUTTONS).filter(
      (id) => !sources.includes(`data-testid="${id}"`) && !sources.includes(`testId="${id}"`),
    );
    expect(missing).toEqual([]);
  });

  it("maps to stable dotted ids", () => {
    for (const action of Object.values(TRACKED_BUTTONS)) expect(action).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
  });

  it("reports a button under the same id as the shortcut that does the same thing", () => {
    // One series per feature, `source` tells them apart. A typo in either
    // table would split a chart in two without failing anything else.
    for (const [testId, action] of [
      ["undo", "edit.undo"],
      ["toggle-ortho", "view.ortho"],
      ["toggle-properties", "app.toggleProperties"],
      ["toggle-command-line", "view.commandLine"],
      ["toggle-select-by", "edit.selectBy"],
    ] as const) {
      expect(TRACKED_BUTTONS[testId]).toBe(action);
      expect(ACTIONS.some((a) => a.id === action)).toBe(true);
    }
  });
});

describe("TRACKED_PREFIXES", () => {
  it("names only families a component actually builds", () => {
    // Runtime ids are template literals, so this is what the source shows.
    const missing = TRACKED_PREFIXES.map(([prefix]) => prefix).filter((p) => !sources.includes(`data-testid={\`${p}`));
    expect(missing).toEqual([]);
  });

  it("tries the specific rule before the family it sits in", () => {
    const order = TRACKED_PREFIXES.map(([p]) => p);
    for (const [i, prefix] of order.entries()) {
      const shadowedBy = order.slice(0, i).find((earlier) => prefix.startsWith(earlier));
      expect(shadowedBy, `"${prefix}" can never match: "${shadowedBy}" comes first`).toBeUndefined();
    }
  });
});

describe("actionForTestId", () => {
  it("passes tool ids through and collapses plugin ids", () => {
    expect(actionForTestId("tool-line")).toBe("tool.line");
    expect(actionForTestId("plugin-export-some.private.plugin")).toBe("file.exportPlugin");
    expect(actionForTestId("plugin-cmd-some.private.plugin.cmd")).toBe("plugin.command");
  });

  it("keeps a suffix that is an app constant, in every family that has one", () => {
    for (const kind of Object.keys(CONSTRAINT_LABELS)) expect(actionForTestId(`constraint-${kind}`)).toMatch(/^constraints\.apply\.[a-zA-Z]+$/);
    for (const { id } of SNAP_KIND_LABELS) expect(actionForTestId(`snap-${id}`)).toMatch(/^snap\.[a-zA-Z]+$/);
    // A hyphenated constant still has to come out as one id segment.
    expect(actionForTestId("constraint-point-on-curve")).toBe("constraints.apply.pointOnCurve");
    expect(actionForTestId("snap-on-line")).toBe("snap.onLine");
  });

  it("drops the suffix where it is the user's words or someone's plugin", () => {
    expect(actionForTestId("layer-delete-Customer secret")).toBe("layers.delete");
    expect(actionForTestId("layer-toggle-Customer secret")).toBe("layers.visibility");
    expect(actionForTestId("layer-lock-Customer secret")).toBe("layers.lock");
    expect(actionForTestId("constraint-remove-c17")).toBe("constraints.remove");
    expect(actionForTestId("prop-vertex-remove-3")).toBe("properties.vertexRemove");
    expect(actionForTestId("hatch-swatch-#ff00aa")).toBe("hatch.swatch");
    expect(actionForTestId("uninstall-com.acme.gear-generator")).toBe("plugins.uninstall");
    expect(actionForTestId("install-com.acme.gear-generator")).toBe("plugins.installRegistry");
    expect(actionForTestId("update-com.acme.gear-generator")).toBe("plugins.updateRegistry");
  });

  it("ignores ids that carry user data or aren't listed", () => {
    expect(actionForTestId("tool-prompt")).toBeNull(); // the status bar's prompt, not a tool
    expect(actionForTestId("layer-Customer secret")).toBeNull();
    expect(actionForTestId("structure-part-Housing rev B")).toBeNull();
    expect(actionForTestId("tab-abc123")).toBeNull();
    expect(actionForTestId("file-explorer-tag-confidential")).toBeNull();
    expect(actionForTestId("file-card")).toBeNull();
    expect(actionForTestId("")).toBeNull();
  });

  it("doesn't mistake a container or one of the app's own ids for a runtime one", () => {
    // These share a prefix with a family above; the guards are what keep
    // "snap.popover" and "plugins.installRegistry" out of the charts.
    expect(actionForTestId("snap-popover")).toBeNull();
    expect(actionForTestId("constraint-panel")).toBeNull();
    expect(actionForTestId("constraint-buttons")).toBeNull();
    expect(actionForTestId("install-prompt")).toBeNull();
    expect(actionForTestId("update-banner")).toBeNull();
    // ...while the app's own listed ids still win over the prefix rules.
    expect(actionForTestId("install-plugin")).toBe("plugins.install");
    expect(actionForTestId("update-check")).toBe("update.check");
  });
});

describe("COMMAND_LINE_ACTIONS", () => {
  it("covers every command the command line accepts", () => {
    const missing = [...new Set(Object.values(APP_ALIASES))].filter((id) => !COMMAND_LINE_ACTIONS[id]);
    expect(missing).toEqual([]);
  });

  it("uses the same ids as the buttons and shortcuts, not the command line's own words", () => {
    for (const action of Object.values(COMMAND_LINE_ACTIONS)) expect(action).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
    expect(COMMAND_LINE_ACTIONS.undo).toBe(TRACKED_BUTTONS.undo);
    expect(COMMAND_LINE_ACTIONS.save).toBe(TRACKED_BUTTONS["save-now"]);
  });
});

describe("actionForClick", () => {
  const el = (testId: string | null, parent?: unknown) => ({
    closest: (sel: string) => {
      expect(sel).toBe("[data-testid]");
      const found = testId !== null ? { getAttribute: () => testId } : (parent ?? null);
      return found;
    },
  });

  it("resolves through the nearest test id, e.g. the svg inside a button", () => {
    expect(actionForClick(el("open-file") as unknown as EventTarget)).toBe("file.open");
  });

  it("is null for clicks that reach nothing tracked", () => {
    expect(actionForClick(el(null) as unknown as EventTarget)).toBeNull();
    expect(actionForClick(null)).toBeNull();
    expect(actionForClick({} as EventTarget)).toBeNull();
  });
});

describe("actionForKeydown", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    key: k,
    ...mods,
  });

  it("recognises default bindings, plain and with modifiers", () => {
    useKeybindings.setState({ bindings: { ...DEFAULT_BINDINGS } });
    expect(actionForKeydown(key("l"), "BODY")).toBe("tool.line");
    expect(actionForKeydown(key("s", { ctrlKey: true }), "DIV")).toBe("file.save");
    expect(actionForKeydown(key("z", { ctrlKey: true }), "CANVAS")).toBe("edit.undo");
  });

  it("follows a rebinding, so a custom key is still counted under its action", () => {
    useKeybindings.setState({ bindings: { ...DEFAULT_BINDINGS, "tool.line": "q" } });
    expect(actionForKeydown(key("q"), "BODY")).toBe("tool.line");
    expect(actionForKeydown(key("l"), "BODY")).toBeNull();
    useKeybindings.setState({ bindings: { ...DEFAULT_BINDINGS } });
  });

  it("stays quiet while typing in a field, and never reports a mouse modifier", () => {
    useKeybindings.setState({ bindings: { ...DEFAULT_BINDINGS } });
    expect(actionForKeydown(key("l"), "INPUT")).toBeNull();
    expect(actionForKeydown(key("l"), "TEXTAREA")).toBeNull();
    expect(actionForKeydown(key("Shift", { shiftKey: true }), "BODY")).toBeNull();
    expect(ACTIONS.some((a) => a.id === "mouse.addToSelection")).toBe(true);
  });
});
