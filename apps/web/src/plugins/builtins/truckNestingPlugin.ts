import {
  buildNestLayout,
  clearPreviousLayout,
  LOAD_PLAN_LAYER,
  nestTruck,
  validateNest,
  type PalletItem,
  type TrailerProfile,
  type ValidationFinding,
} from "@sketchor/plugin-truck-nesting";
import type { NestResult } from "@sketchor/plugin-truck-nesting";
import type { PluginModule } from "@sketchor/plugin-sdk";

/**
 * First-party dogfood: the Truck Load Planner, built entirely over the public
 * plugin API. All the nesting maths lives in `@sketchor/plugin-truck-nesting`
 * (which imports only the SDK); this module is the sandbox glue — it shows the
 * panel, and on each panel request reads the document, runs the solver, and
 * applies the resulting `Command[]` through `document.apply` as one undo step.
 * It never touches `window.sketchor` or the host DOM — only `postMessage`.
 *
 * Contributes the command `truck-nesting.open` and declares a `ui` entry.
 */

interface NestRequest {
  type: "nest";
  trailer: TrailerProfile;
  items: PalletItem[];
}
interface ClearRequest {
  type: "clear";
}
type PanelRequest = NestRequest | ClearRequest;

function isTrailer(v: unknown): v is TrailerProfile {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return typeof t.name === "string" && typeof t.length === "number" && typeof t.width === "number";
}

function isItemArray(v: unknown): v is PalletItem[] {
  return (
    Array.isArray(v) &&
    v.every((it) => {
      if (!it || typeof it !== "object") return false;
      const i = it as Record<string, unknown>;
      return (
        typeof i.id === "string" &&
        typeof i.label === "string" &&
        typeof i.length === "number" &&
        typeof i.width === "number" &&
        typeof i.weightKg === "number" &&
        typeof i.qty === "number" &&
        typeof i.stop === "number" &&
        typeof i.rotatable === "boolean"
      );
    })
  );
}

function parseRequest(raw: unknown): PanelRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;
  if (msg.type === "clear") return { type: "clear" };
  if (msg.type === "nest" && isTrailer(msg.trailer) && isItemArray(msg.items)) {
    return { type: "nest", trailer: msg.trailer, items: msg.items };
  }
  return null;
}

const plugin: PluginModule = {
  activate(sketchor) {
    sketchor.commands.register("truck-nesting.open", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "Load Plan", width: 340, height: 520 });
    });

    sketchor.ui.onMessage(async (raw) => {
      const req = parseRequest(raw);
      if (!req) return;
      try {
        const model = await sketchor.document.read();

        if (req.type === "clear") {
          const commands = clearPreviousLayout(model);
          if (commands.length > 0) await sketchor.document.apply(commands);
          sketchor.ui.postMessage({ type: "cleared" });
          return;
        }

        const result: NestResult = nestTruck(req.trailer, req.items);
        const findings: ValidationFinding[] = validateNest(result);
        await sketchor.document.apply([...clearPreviousLayout(model), ...buildNestLayout(result)]);
        sketchor.ui.postMessage({ type: "result", result, findings });
        const errors = findings.filter((f) => f.level === "error").length;
        sketchor.ui.notify(
          errors > 0
            ? `Load plan drawn with ${errors} problem${errors === 1 ? "" : "s"} — see the panel.`
            : `Load plan drawn on the "${LOAD_PLAN_LAYER}" layer.`,
          { error: errors > 0 },
        );
      } catch (err) {
        sketchor.ui.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    });
  },
};

/**
 * The panel's markup — self-contained, sandboxed, talks to the plugin only via
 * `parent.postMessage({ pluginMessage })`. Keeps its own catalogue state and
 * sends the whole trailer + item list on each Auto-nest.
 */
const PANEL_HTML = `<!doctype html>
<html>
  <head>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 12px; font: 12px system-ui, -apple-system, sans-serif; color: #dfe1e5; background: #1e1f22; }
      h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
      section { margin-bottom: 14px; }
      label { display: block; margin-bottom: 6px; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
      input { width: 100%; margin-top: 3px; padding: 5px 6px; background: #2b2d31; color: inherit; border: 1px solid #3a3d42; border-radius: 4px; font: inherit; }
      input[type="checkbox"] { width: auto; margin: 0; }
      table { width: 100%; border-collapse: collapse; }
      th { font-size: 10px; text-transform: uppercase; opacity: 0.5; font-weight: 600; padding: 2px; text-align: left; }
      td { padding: 1px; }
      td input { margin-top: 0; padding: 4px; }
      .num { width: 100%; }
      button { padding: 6px 10px; border: none; border-radius: 5px; background: #4f7cff; color: #fff; font: inherit; cursor: pointer; }
      button.ghost { background: #2b2d31; color: #dfe1e5; border: 1px solid #3a3d42; }
      button.sm { padding: 2px 6px; font-size: 11px; }
      .row { display: flex; gap: 8px; align-items: center; }
      .actions { display: flex; gap: 8px; margin: 10px 0; }
      .totals { margin-top: 6px; opacity: 0.7; }
      .findings { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
      .f { padding: 5px 7px; border-radius: 4px; background: #2b2d31; border-left: 3px solid #6b7280; }
      .f.error { border-left-color: #f0616d; }
      .f.warn { border-left-color: #e3a008; }
      .f.info { border-left-color: #4f9d69; }
      .stop { padding: 5px 7px; background: #2b2d31; border-radius: 4px; margin-top: 4px; }
      .stop b { font-weight: 600; }
      .muted { opacity: 0.6; }
      .del { background: none; border: none; color: #9aa0a6; cursor: pointer; padding: 0 4px; }
    </style>
  </head>
  <body>
    <section>
      <h4>Trailer</h4>
      <label>Name<input id="t-name" type="text" value="Standard 13.6m curtainsider" /></label>
      <div class="grid2">
        <label>Length mm<input id="t-length" class="num" type="number" min="0" value="13600" /></label>
        <label>Width mm<input id="t-width" class="num" type="number" min="0" value="2480" /></label>
        <label>Max weight kg<input id="t-weight" class="num" type="number" min="0" value="24000" /></label>
      </div>
    </section>

    <section>
      <div class="row" style="justify-content: space-between;">
        <h4>Items</h4>
        <button class="ghost sm" id="add">+ Add</button>
      </div>
      <table>
        <thead>
          <tr><th>Label</th><th>L</th><th>W</th><th>kg</th><th>Qty</th><th>Stop</th><th>Rot</th><th></th></tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="totals" id="totals"></div>
    </section>

    <div class="actions">
      <button id="nest">Auto-nest</button>
      <button class="ghost" id="clear">Clear layout</button>
    </div>

    <div id="results"></div>

    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      let items = [
        { id: "i1", label: "EUR pallet", length: 1200, width: 800, weightKg: 400, qty: 8, stop: 1, rotatable: true },
        { id: "i2", label: "Half pallet", length: 800, width: 600, weightKg: 250, qty: 4, stop: 2, rotatable: true },
      ];
      let seq = 3;

      function num(id) { return Number(document.getElementById(id).value) || 0; }

      function renderRows() {
        const tb = document.getElementById("rows");
        tb.innerHTML = "";
        items.forEach((it) => {
          const tr = document.createElement("tr");
          const cell = (key, type, min) => {
            const td = document.createElement("td");
            const inp = document.createElement("input");
            inp.type = type; inp.value = it[key]; inp.className = "num";
            if (min !== undefined) inp.min = String(min);
            if (type === "checkbox") { inp.checked = it[key]; inp.className = ""; }
            inp.addEventListener("input", () => {
              it[key] = type === "checkbox" ? inp.checked : type === "number" ? Number(inp.value) || 0 : inp.value;
              renderTotals();
            });
            td.appendChild(inp); return td;
          };
          tr.appendChild(cell("label", "text"));
          tr.appendChild(cell("length", "number", 0));
          tr.appendChild(cell("width", "number", 0));
          tr.appendChild(cell("weightKg", "number", 0));
          tr.appendChild(cell("qty", "number", 0));
          tr.appendChild(cell("stop", "number", 1));
          tr.appendChild(cell("rotatable", "checkbox"));
          const del = document.createElement("td");
          const b = document.createElement("button");
          b.className = "del"; b.textContent = "\\u2715"; b.title = "Remove";
          b.addEventListener("click", () => { items = items.filter((x) => x !== it); renderRows(); renderTotals(); });
          del.appendChild(b); tr.appendChild(del);
          tb.appendChild(tr);
        });
      }

      function renderTotals() {
        const pallets = items.reduce((n, it) => n + Math.max(0, Math.floor(it.qty)), 0);
        const kg = items.reduce((n, it) => n + it.weightKg * Math.max(0, Math.floor(it.qty)), 0);
        document.getElementById("totals").textContent = pallets + " pallets, " + Math.round(kg) + " kg";
      }

      document.getElementById("add").addEventListener("click", () => {
        const lastStop = items.length ? Math.max(...items.map((i) => i.stop)) : 1;
        items.push({ id: "i" + seq++, label: "Pallet", length: 1200, width: 800, weightKg: 400, qty: 1, stop: lastStop, rotatable: true });
        renderRows(); renderTotals();
      });

      document.getElementById("nest").addEventListener("click", () => {
        const w = num("t-weight");
        post({
          type: "nest",
          trailer: { name: document.getElementById("t-name").value || "Trailer", length: num("t-length"), width: num("t-width"), maxWeightKg: w > 0 ? w : undefined },
          items: items.map((it) => ({
            id: it.id, label: it.label,
            length: Math.max(0, it.length), width: Math.max(0, it.width),
            weightKg: Math.max(0, it.weightKg), qty: Math.max(0, Math.floor(it.qty)),
            stop: Math.max(1, Math.floor(it.stop)), rotatable: !!it.rotatable,
          })),
        });
        document.getElementById("results").innerHTML = '<div class="muted">Nesting…</div>';
      });

      document.getElementById("clear").addEventListener("click", () => {
        post({ type: "clear" });
        document.getElementById("results").innerHTML = "";
      });

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m) return;
        const box = document.getElementById("results");
        if (m.type === "cleared") { box.innerHTML = '<div class="muted">Layout cleared.</div>'; return; }
        if (m.type === "error") { box.innerHTML = '<div class="f error">' + esc(m.message) + '</div>'; return; }
        if (m.type !== "result") return;
        const r = m.result;
        let html = "<h4>Result</h4><div class='muted'>" + r.placed.length + " placed, " + r.unplaced.length +
          " unplaced &middot; " + Math.round(r.usedLength) + " / " + r.trailer.length + " mm used</div>";
        html += "<div class='findings'>" + m.findings.map((f) =>
          "<div class='f " + f.level + "'>" + esc(f.message) + "</div>").join("") + "</div>";
        const byStop = {};
        r.placed.forEach((p) => { (byStop[p.stop] = byStop[p.stop] || []).push(p); });
        const stops = Object.keys(byStop).map(Number).sort((a, b) => a - b);
        if (stops.length) html += "<h4 style='margin-top:10px'>Unload order (load in reverse)</h4>";
        stops.forEach((s) => {
          const ps = byStop[s];
          const kg = ps.reduce((n, p) => n + p.weightKg, 0);
          const counts = {};
          ps.forEach((p) => { counts[p.label] = (counts[p.label] || 0) + 1; });
          const parts = Object.keys(counts).map((l) => counts[l] + "\\u00d7 " + esc(l)).join(", ");
          html += "<div class='stop'><b>Stop " + s + "</b> &middot; " + ps.length + " items, " + Math.round(kg) + " kg<br><span class='muted'>" + parts + "</span></div>";
        });
        box.innerHTML = html;
      });

      function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

      renderRows(); renderTotals();
    </script>
  </body>
</html>`;

export default plugin;
