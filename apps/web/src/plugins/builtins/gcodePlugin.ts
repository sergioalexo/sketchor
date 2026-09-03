import { gcodeToEntities, type GcodeStats } from "@sketchor/plugin-gcode";
import type { PluginModule } from "@sketchor/plugin-sdk";

/**
 * G-code Ripper — decode a CNC program (G0/G1 moves, G2/G3 arcs, G20/G21 units,
 * G90/G91 distance mode) into drawing geometry. All the parsing lives in
 * `@sketchor/plugin-gcode`; this module shows a paste/file panel and applies the
 * result through `document.apply` as one undo step.
 *
 * Contributes the command `gcode.import` and an `io` importer for
 * .nc/.gcode/.tap/.ngc.
 */

interface ImportRequest {
  type: "import";
  text: string;
  includeRapids: boolean;
  layer: string;
}

function parseRequest(raw: unknown): ImportRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.type !== "import" || typeof o.text !== "string") return null;
  return {
    type: "import",
    text: o.text,
    includeRapids: o.includeRapids === true,
    layer: typeof o.layer === "string" && o.layer.trim() ? o.layer : "G-code",
  };
}

const plugin: PluginModule = {
  activate(sketchor) {
    sketchor.commands.register("gcode.import", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "G-code Ripper", width: 340, height: 420 });
    });

    sketchor.ui.onMessage(async (raw) => {
      const req = parseRequest(raw);
      if (!req) return;
      try {
        const { commands, stats, warnings } = gcodeToEntities(req.text, {
          includeRapids: req.includeRapids,
          layer: req.layer,
        });
        if (commands.length === 0) {
          sketchor.ui.postMessage({ type: "done", stats, warnings: ["No motion found in that program."] });
          return;
        }
        await sketchor.document.apply(commands);
        sketchor.ui.postMessage({ type: "done", stats, warnings });
        const s: GcodeStats = stats;
        sketchor.ui.notify(
          `Imported ${s.paths} path${s.paths === 1 ? "" : "s"} (${s.segments} segments) on the "${req.layer}" layer.`,
        );
      } catch (err) {
        sketchor.ui.postMessage({
          type: "done",
          warnings: [err instanceof Error ? err.message : String(err)],
        });
      }
    });
  },
};

const PANEL_HTML = `<!doctype html>
<html>
  <head>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 12px; font: 12px system-ui, -apple-system, sans-serif; color: #dfe1e5; background: #1e1f22; }
      label { display: block; margin-bottom: 8px; }
      textarea, input { width: 100%; margin-top: 3px; padding: 6px; background: #2b2d31; color: inherit; border: 1px solid #3a3d42; border-radius: 4px; font: 12px ui-monospace, monospace; }
      textarea { height: 150px; resize: vertical; }
      input[type="checkbox"] { width: auto; margin: 0 6px 0 0; }
      .row { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
      button { padding: 7px 12px; border: none; border-radius: 5px; background: #4f7cff; color: #fff; font: inherit; cursor: pointer; }
      .muted { opacity: 0.6; }
      .f { padding: 5px 7px; border-radius: 4px; background: #2b2d31; border-left: 3px solid #e3a008; margin-top: 4px; }
      .f.ok { border-left-color: #4f9d69; }
      #out { margin-top: 10px; }
    </style>
  </head>
  <body>
    <label>Paste G-code<textarea id="src" placeholder="G21 G90&#10;G0 X0 Y0&#10;G1 X50 Y0&#10;G2 X50 Y50 R25"></textarea></label>
    <label>…or open a file<input id="file" type="file" accept=".nc,.gcode,.tap,.ngc,.txt"></label>
    <label>Layer<input id="layer" type="text" value="G-code"></label>
    <div class="row"><input type="checkbox" id="rapids"><label style="margin:0">Draw rapid (G0) moves too</label></div>
    <button id="go">Import</button>
    <div id="out"></div>

    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      const $ = (id) => document.getElementById(id);
      const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

      $("file").addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => { $("src").value = String(r.result || ""); };
        r.readAsText(f);
      });

      $("go").addEventListener("click", () => {
        const text = $("src").value;
        if (!text.trim()) { $("out").innerHTML = "<div class='f'>Paste some G-code or pick a file first.</div>"; return; }
        $("out").innerHTML = "<div class='muted'>Importing…</div>";
        post({ type: "import", text, includeRapids: $("rapids").checked, layer: $("layer").value });
      });

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m || m.type !== "done") return;
        let html = "";
        if (m.stats) {
          html += "<div class='f ok'>" + m.stats.paths + " path(s), " + m.stats.segments +
            " segment(s), " + m.stats.rapids + " rapid(s) — read as " + m.stats.unit + ".</div>";
        }
        (m.warnings || []).forEach((w) => { html += "<div class='f'>" + esc(w) + "</div>"; });
        $("out").innerHTML = html || "<div class='f ok'>Done.</div>";
      });
    </script>
  </body>
</html>`;

export default plugin;
