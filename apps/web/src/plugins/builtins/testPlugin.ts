import { add, line, type PluginModule } from "@sketchor/plugin-sdk";

/**
 * Phase 1 acceptance plugin. Proves the whole sandbox → RPC → capability →
 * CommandBus path end to end: it reads the selection (needs `read-document`)
 * and adds one line (needs `write-document`), which must appear on the canvas
 * and undo in a single step. Loaded without `write-document`, its `apply` must
 * reject with a capability error.
 *
 * Not a user-facing plugin — a dogfood fixture wired to the dev handle
 * (`window.sketchorPlugins`).
 */
const plugin: PluginModule = {
  async activate(sketchor) {
    const selection = await sketchor.selection.read();
    // A short diagonal line near the origin — visible regardless of view.
    await sketchor.document.apply([add(line({ x: 0, y: 0 }, { x: 50, y: 50 }, { name: "PLUGIN" }))]);
    sketchor.ui.notify(`test plugin ran (selection had ${selection.length} entities)`);
  },
};

export default plugin;
