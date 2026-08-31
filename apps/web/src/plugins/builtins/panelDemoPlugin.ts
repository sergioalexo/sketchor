import { add, circle, type PluginModule } from "@sketchor/plugin-sdk";

/**
 * First-party dogfood for Phase 3: a plugin whose UI lives in a sandboxed
 * iframe. The `panel-demo.open` command shows the panel; the panel has an input
 * and a button and drives a real document change **through the worker** — it
 * never touches `window.sketchor` or the host DOM, only `postMessage`. This is
 * the Phase 3 acceptance case.
 *
 * Contributes the command `panel-demo.open` and declares a `ui` entry.
 */
const plugin: PluginModule = {
  activate(sketchor) {
    // Panel → plugin: apply the requested circle, then confirm back to the panel.
    sketchor.ui.onMessage((raw) => {
      const msg = raw as { type?: string; radius?: number } | null;
      if (!msg || msg.type !== "add-circle") return;
      const radius = Number(msg.radius) || 10;
      void sketchor.document
        .apply([add(circle({ x: 0, y: 0 }, radius))])
        .then(() => sketchor.ui.postMessage({ type: "added", radius }));
    });

    sketchor.commands.register("panel-demo.open", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "Circle Maker", width: 240, height: 150 });
    });
  },
};

/** Self-contained panel markup. Talks to the plugin via `parent.postMessage({ pluginMessage })`. */
const PANEL_HTML = `<!doctype html>
<html>
  <head>
    <style>
      body { margin: 0; padding: 12px; font: 13px system-ui, sans-serif; color: #dfe1e5; background: #1e1f22; }
      label { display: block; margin-bottom: 8px; }
      input { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px; background: #2b2d31; color: inherit; border: 1px solid #3a3d42; border-radius: 4px; }
      button { width: 100%; padding: 7px; border: none; border-radius: 5px; background: #4f7cff; color: #fff; font: inherit; cursor: pointer; }
      .status { margin-top: 8px; min-height: 16px; opacity: 0.7; }
    </style>
  </head>
  <body>
    <label>Radius<input id="r" type="number" value="25" min="1" /></label>
    <button id="go">Add circle</button>
    <div class="status" id="status"></div>
    <script>
      const post = (message) => parent.postMessage({ pluginMessage: message }, "*");
      document.getElementById("go").addEventListener("click", () => {
        post({ type: "add-circle", radius: Number(document.getElementById("r").value) });
      });
      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (m && m.type === "added") {
          document.getElementById("status").textContent = "Added a circle r=" + m.radius;
        }
      });
    </script>
  </body>
</html>`;

export default plugin;
