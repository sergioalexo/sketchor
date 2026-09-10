import { gcodeToEntities, type GcodeStats, type GcodeUnit, type GcodeUnitMode } from "@sketchor/plugin-gcode";
import type { PluginModule } from "@sketchor/plugin-sdk";

/**
 * G-code Ripper — decode a CNC program (G0/G1 moves, G2/G3 arcs, G20/G21 units,
 * G90/G91 distance mode) into drawing geometry. All the parsing lives in
 * `@sketchor/plugin-gcode`; this module shows a paste/drop panel and applies the
 * result through `document.apply` as one undo step.
 *
 * Units are the thing that actually bites here. Document coordinates are always
 * millimetres, so an inch program has to be scaled by 25.4 on the way in — and
 * plenty of posts never emit G20/G21 at all, leaving the unit to the machine's
 * own default. Rather than silently guessing millimetres (which drops an inch
 * part in at 1/25th size), the panel offers an explicit unit and falls back to
 * the *document's* display unit, the best available evidence of what the user is
 * actually working in.
 *
 * Contributes the command `gcode.import` and an `io` importer for
 * .nc/.gcode/.tap/.ngc.
 */

interface ImportRequest {
  type: "import";
  text: string;
  includeRapids: boolean;
  layer: string;
  unit: GcodeUnitMode;
}

type PanelRequest = ImportRequest | { type: "ready" };

function parseRequest(raw: unknown): PanelRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.type === "ready") return { type: "ready" };
  if (o.type !== "import" || typeof o.text !== "string") return null;
  return {
    type: "import",
    text: o.text,
    includeRapids: o.includeRapids === true,
    layer: typeof o.layer === "string" && o.layer.trim() ? o.layer : "G-code",
    unit: o.unit === "mm" || o.unit === "in" ? o.unit : "auto",
  };
}

/**
 * What an undeclared program most likely means, given what the user is drawing
 * in. Display units are only mm/cm/m/in/ft; the imperial two imply an inch post.
 */
function assumedUnitFor(displayUnit: string): GcodeUnit {
  return displayUnit === "in" || displayUnit === "ft" ? "in" : "mm";
}

const plugin: PluginModule = {
  activate(sketchor) {
    /** Unit an undeclared program is read as; tracks the drawing's display unit. */
    let assume: GcodeUnit = "mm";

    const useUnit = (displayUnit: string) => {
      assume = assumedUnitFor(displayUnit);
      sketchor.ui.postMessage({ type: "context", assume, displayUnit });
    };

    const sendUnitContext = async () => {
      try {
        useUnit((await sketchor.app.displayUnit()).unit);
      } catch {
        // The panel's own default ("mm") stands if the host can't say.
      }
    };

    // Switching the toolbar to inches mid-session has to move the fallback with
    // it, or the panel keeps promising a unit it no longer uses.
    void sketchor.app.onDisplayUnitChange((info) => useUnit(info.unit));

    sketchor.commands.register("gcode.import", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "G-code Ripper", width: 340, height: 540 });
      void sendUnitContext();
    });

    sketchor.ui.onMessage(async (raw) => {
      const req = parseRequest(raw);
      if (!req) return;
      // The panel announces itself once loaded: `show()` can resolve before the
      // iframe is listening, so the first push of context would be missed.
      if (req.type === "ready") {
        void sendUnitContext();
        return;
      }
      try {
        const { commands, stats, warnings } = gcodeToEntities(req.text, {
          includeRapids: req.includeRapids,
          layer: req.layer,
          unit: req.unit,
          assume,
        });
        if (commands.length === 0) {
          sketchor.ui.postMessage({ type: "done", stats, warnings: ["No motion found in that program."] });
          return;
        }
        await sketchor.document.apply(commands);
        sketchor.ui.postMessage({ type: "done", stats, warnings });
        const s: GcodeStats = stats;
        sketchor.ui.notify(
          `Imported ${s.paths} path${s.paths === 1 ? "" : "s"} (${s.segments} segments) read as ${
            s.unit === "in" ? "inches" : "millimetres"
          } on the "${req.layer}" layer.`,
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
      textarea, input, select { width: 100%; margin-top: 3px; padding: 6px; background: #2b2d31; color: inherit; border: 1px solid #3a3d42; border-radius: 4px; font: 12px ui-monospace, monospace; }
      textarea { height: 130px; resize: vertical; }
      select { font-family: system-ui, -apple-system, sans-serif; }
      input[type="checkbox"] { width: auto; margin: 0 6px 0 0; }
      .row { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
      button { padding: 7px 12px; border: none; border-radius: 5px; background: #4f7cff; color: #fff; font: inherit; cursor: pointer; }
      .muted { opacity: 0.6; }
      .f { padding: 5px 7px; border-radius: 4px; background: #2b2d31; border-left: 3px solid #e3a008; margin-top: 4px; }
      .f.ok { border-left-color: #4f9d69; }
      #out { margin-top: 10px; }
      /* The drop zone wraps the paste field and the file picker, so dropping a
         file "onto the field" does the obvious thing. A drop anywhere in the
         panel counts, but the outline shows where it's aimed. */
      #zone { border: 1px dashed #4a4e55; border-radius: 6px; padding: 8px; margin-bottom: 8px; transition: border-color 0.1s, background 0.1s; }
      #zone.over { border-color: #4f7cff; border-style: solid; background: #23283a; }
      #zone label:last-of-type { margin-bottom: 0; }
      #hint { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
      #picked { font: 11px ui-monospace, monospace; color: #9fd3ac; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #file { padding: 4px; font: 11px system-ui, sans-serif; }
      #unithint { margin: -4px 0 8px; }
    </style>
  </head>
  <body>
    <div id="zone">
      <div id="hint"><span class="muted">Drop a G-code file here, or paste below</span><span id="picked"></span></div>
      <label><textarea id="src" placeholder="G21 G90&#10;G0 X0 Y0&#10;G1 X50 Y0&#10;G2 X50 Y50 R25"></textarea></label>
      <label><input id="file" type="file" accept=".nc,.gcode,.tap,.ngc,.txt"></label>
    </div>
    <label>Program units<select id="unit">
      <option value="auto">Auto — follow G20/G21</option>
      <option value="mm">Millimetres</option>
      <option value="in">Inches</option>
    </select></label>
    <div class="muted" id="unithint">Programs that never say G20/G21 are read as mm.</div>
    <label>Layer<input id="layer" type="text" value="G-code"></label>
    <div class="row"><input type="checkbox" id="rapids"><label style="margin:0">Draw rapid (G0) moves too</label></div>
    <button id="go">Import</button>
    <div id="out"></div>

    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      const $ = (id) => document.getElementById(id);
      const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

      /** Fills the paste field from a File, whether it arrived by picker or by drop. */
      function loadFile(f) {
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          $("src").value = String(r.result || "");
          $("picked").textContent = f.name;
          $("out").innerHTML = "";
        };
        r.onerror = () => { $("out").innerHTML = "<div class='f'>Couldn't read " + esc(f.name) + ".</div>"; };
        r.readAsText(f);
      }

      $("file").addEventListener("change", (e) => loadFile(e.target.files && e.target.files[0]));

      // --- drag & drop -------------------------------------------------------
      // Listening on the document, not just the zone: a drop that lands a few
      // pixels outside the outline is still obviously meant for the panel, and
      // an unhandled drop would otherwise be swallowed by the browser default.
      // dragenter/dragleave fire for every child crossed, so the highlight is
      // refcounted rather than toggled — toggling flickers over the textarea.
      let depth = 0;
      const setOver = (on) => $("zone").classList.toggle("over", on);

      document.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      });
      document.addEventListener("dragenter", (e) => {
        e.preventDefault();
        depth += 1;
        setOver(true);
      });
      document.addEventListener("dragleave", () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) setOver(false);
      });
      document.addEventListener("drop", (e) => {
        e.preventDefault();
        depth = 0;
        setOver(false);
        const dt = e.dataTransfer;
        if (!dt) return;
        if (dt.files && dt.files.length > 0) { loadFile(dt.files[0]); return; }
        // Not a file — a text selection dragged out of an editor carries the
        // program itself, which is just as usable here.
        const text = dt.getData("text/plain");
        if (text && text.trim()) {
          $("src").value = text;
          $("picked").textContent = "(dropped text)";
          $("out").innerHTML = "";
        } else {
          $("out").innerHTML = "<div class='f'>That drop carried no G-code file or text.</div>";
        }
      });

      $("go").addEventListener("click", () => {
        const text = $("src").value;
        if (!text.trim()) { $("out").innerHTML = "<div class='f'>Drop a file, pick one, or paste some G-code first.</div>"; return; }
        $("out").innerHTML = "<div class='muted'>Importing…</div>";
        post({ type: "import", text, includeRapids: $("rapids").checked, layer: $("layer").value, unit: $("unit").value });
      });

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m) return;
        if (m.type === "context") {
          $("unithint").textContent =
            "Programs that never say G20/G21 are read as " + (m.assume === "in" ? "inches" : "mm") +
            ", matching this drawing's " + m.displayUnit + " units.";
          return;
        }
        if (m.type !== "done") return;
        let html = "";
        if (m.stats) {
          const unit = m.stats.unit === "in" ? "inches" : "mm";
          const how = m.stats.unitSource === "declared" ? "declared by the program"
            : m.stats.unitSource === "forced" ? "your choice" : "assumed";
          html += "<div class='f ok'>" + m.stats.paths + " path(s), " + m.stats.segments +
            " segment(s), " + m.stats.rapids + " rapid(s) — read as " + unit + ", " + how + ".</div>";
        }
        (m.warnings || []).forEach((w) => { html += "<div class='f'>" + esc(w) + "</div>"; });
        $("out").innerHTML = html || "<div class='f ok'>Done.</div>";
      });

      post({ type: "ready" });
    </script>
  </body>
</html>`;

export default plugin;
