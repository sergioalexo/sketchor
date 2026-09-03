import {
  buildNestLayout,
  clearPreviousLayout,
  LOAD_PLAN_LAYER,
  nestByOrders,
  validateNest,
  type NestResult,
  type Order,
  type Pallet,
  type PalletShape,
  type TrailerProfile,
  type ValidationFinding,
} from "@sketchor/plugin-truck-nesting";
import { PALETTE, type DisplayUnitInfo, type PluginModule } from "@sketchor/plugin-sdk";

/**
 * First-party dogfood: the Truck Load Planner. All the nesting maths lives in
 * `@sketchor/plugin-truck-nesting` (SDK-only); this module is the sandbox glue —
 * it shows the panel, keeps the user's trailer/pallet presets and orders in
 * plugin `storage`, feeds the panel the app's display unit, and on each request
 * reads the document, solves, and applies the coloured layout through
 * `document.apply` as one undo step. It never touches `window.sketchor`.
 */

interface PalletPreset {
  name: string;
  width: number;
  length: number;
  shape: PalletShape;
}

interface PersistedState {
  presets: TrailerProfile[];
  palletPresets: PalletPreset[];
  lastPresetName: string;
  wallMargin: number;
  palletMargin: number;
  /** Add a W×L dimension to every drawn pallet. */
  dimensions: boolean;
  orders: Order[];
}

const STORAGE_KEY = "state";

const SEED_PRESETS: TrailerProfile[] = [
  { name: "13.6 m curtainsider", length: 13620, width: 2480 },
  { name: "7.2 m rigid", length: 7200, width: 2450 },
  { name: "6.1 m box van", length: 6100, width: 2400 },
];

const SEED_PALLET_PRESETS: PalletPreset[] = [
  { name: "EUR pallet", width: 1200, length: 800, shape: "rect" },
  { name: "EUR-6 half", width: 800, length: 600, shape: "rect" },
  { name: "Industrial", width: 1200, length: 1000, shape: "rect" },
  { name: "Drum Ø600", width: 600, length: 600, shape: "round" },
];

function seedOrder(): Order {
  return {
    id: `o-${Date.now().toString(36)}`,
    city: "",
    color: PALETTE[0],
    pallets: [{ id: `p-${Date.now().toString(36)}`, name: "EUR pallet", width: 1200, length: 800, shape: "rect", qty: 1 }],
  };
}

// --- untrusted panel input ---

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asShape(v: unknown): PalletShape {
  return v === "round" ? "round" : "rect";
}

function asPallet(v: unknown): Pallet | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    id: typeof o.id === "string" ? o.id : `p-${Math.random().toString(36).slice(2)}`,
    name: str(o.name) || undefined,
    width: Math.max(0, num(o.width)),
    length: Math.max(0, num(o.length)),
    shape: asShape(o.shape),
    qty: Math.max(1, Math.floor(num(o.qty, 1))),
    tag: str(o.tag) || undefined,
  };
}

function asPalletPreset(v: unknown): PalletPreset | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return null;
  return { name, width: Math.max(0, num(o.width)), length: Math.max(0, num(o.length)), shape: asShape(o.shape) };
}

function asOrder(v: unknown): Order | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const pallets = Array.isArray(o.pallets) ? o.pallets.map(asPallet).filter((p): p is Pallet => p !== null) : [];
  return {
    id: typeof o.id === "string" ? o.id : `o-${Math.random().toString(36).slice(2)}`,
    city: str(o.city),
    color: str(o.color) || PALETTE[0],
    pallets,
  };
}

function asTrailer(v: unknown): TrailerProfile | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const length = Math.max(1, num(o.length, 1));
  const width = Math.max(1, num(o.width, 1));
  const wallMargin = Math.max(0, num(o.wallMargin));
  return { name: str(o.name) || "Trailer", length, width, ...(wallMargin > 0 ? { wallMargin } : {}) };
}

function asState(v: unknown): PersistedState {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const presets = Array.isArray(o.presets) ? o.presets.map(asTrailer).filter((t): t is TrailerProfile => t !== null) : [];
  const palletPresets = Array.isArray(o.palletPresets)
    ? o.palletPresets.map(asPalletPreset).filter((p): p is PalletPreset => p !== null)
    : [];
  const orders = Array.isArray(o.orders) ? o.orders.map(asOrder).filter((x): x is Order => x !== null) : [];
  return {
    presets: presets.length > 0 ? presets : [...SEED_PRESETS],
    palletPresets: palletPresets.length > 0 ? palletPresets : [...SEED_PALLET_PRESETS],
    lastPresetName: str(o.lastPresetName) || presets[0]?.name || SEED_PRESETS[0].name,
    wallMargin: Math.max(0, num(o.wallMargin)),
    palletMargin: Math.max(0, num(o.palletMargin)),
    dimensions: o.dimensions === true,
    orders: orders.length > 0 ? orders : [seedOrder()],
  };
}

const plugin: PluginModule = {
  async activate(sketchor) {
    let unit: DisplayUnitInfo = { unit: "mm", perMm: 1, label: "mm" };
    try {
      unit = await sketchor.app.displayUnit();
    } catch {
      /* mm default */
    }

    const stored = await sketchor.storage.get(STORAGE_KEY).catch(() => undefined);
    let state = asState(stored);

    const pushInit = () => void sketchor.ui.postMessage({ type: "init", state, unit, palette: PALETTE });

    void sketchor.app.onDisplayUnitChange((info) => {
      unit = info;
      void sketchor.ui.postMessage({ type: "unit", unit });
    });

    sketchor.commands.register("truck-nesting.open", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "Load Plan", width: 400, height: 640 });
      pushInit();
    });

    sketchor.ui.onMessage(async (raw) => {
      const msg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

      if (msg.type === "ready") {
        pushInit();
        return;
      }
      if (msg.type === "persist") {
        state = asState(msg.state);
        await sketchor.storage.set(STORAGE_KEY, state).catch(() => undefined);
        return;
      }
      if (msg.type === "clear") {
        const model = await sketchor.document.read();
        const commands = clearPreviousLayout(model);
        if (commands.length > 0) await sketchor.document.apply(commands);
        void sketchor.ui.postMessage({ type: "cleared" });
        return;
      }
      if (msg.type === "nest") {
        const trailer = asTrailer(msg.trailer);
        const orders = Array.isArray(msg.orders)
          ? msg.orders.map(asOrder).filter((o): o is Order => o !== null)
          : [];
        const palletMargin = Math.max(0, num(msg.palletMargin));
        const dimensions = msg.dimensions === true;
        if (!trailer || orders.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Add a trailer size and at least one order." });
          return;
        }
        try {
          const result: NestResult = nestByOrders(trailer, orders, { palletMargin });
          const findings: ValidationFinding[] = validateNest(result);
          const model = await sketchor.document.read();
          await sketchor.document.apply([
            ...clearPreviousLayout(model),
            ...buildNestLayout(result, { dimensions, perMm: unit.perMm, unitLabel: unit.label, findings }),
          ]);
          void sketchor.ui.postMessage({ type: "result", result, findings });
          const errors = findings.filter((f) => f.level === "error").length;
          sketchor.ui.notify(
            errors > 0
              ? `Load plan drawn — ${errors} problem${errors === 1 ? "" : "s"}, see the panel.`
              : `Load plan drawn on the "${LOAD_PLAN_LAYER}" layer.`,
            { error: errors > 0 },
          );
        } catch (err) {
          void sketchor.ui.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
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
      h4 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.55; }
      h4:first-child { margin-top: 0; }
      label { display: block; margin-bottom: 6px; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
      input, select { width: 100%; margin-top: 3px; padding: 5px 6px; background: #2b2d31; color: inherit; border: 1px solid #3a3d42; border-radius: 4px; font: inherit; }
      button { padding: 6px 10px; border: none; border-radius: 5px; background: #4f7cff; color: #fff; font: inherit; cursor: pointer; }
      button.ghost { background: #2b2d31; color: #dfe1e5; border: 1px solid #3a3d42; }
      button.sm { padding: 3px 7px; font-size: 11px; }
      button:disabled { opacity: 0.4; cursor: default; }
      .row { display: flex; gap: 6px; align-items: center; }
      .actions { display: flex; gap: 8px; margin: 12px 0 6px; }
      .muted { opacity: 0.6; }
      .chk { display: flex; align-items: center; gap: 6px; margin: 4px 0 10px; }
      .chk input { width: auto; margin: 0; }

      .order { border: 1px solid #3a3d42; border-radius: 6px; padding: 8px; margin-bottom: 8px; background: #232529; }
      .order.drop-before { box-shadow: 0 -3px 0 #4f7cff; }
      .order.drop-after { box-shadow: 0 3px 0 #4f7cff; }
      .order-head { display: flex; gap: 5px; align-items: center; margin-bottom: 6px; }
      .handle { cursor: grab; opacity: 0.5; padding: 2px 3px; user-select: none; touch-action: none; }
      .move { display: flex; flex-direction: column; }
      .move button { padding: 0 3px; line-height: 10px; font-size: 9px; background: none; border: none; color: #9aa0a6; cursor: pointer; }
      .dot { width: 12px; height: 12px; border-radius: 3px; flex: none; }
      .order-head input.city { flex: 1; margin: 0; min-width: 0; }
      .seq { font-size: 10px; opacity: 0.5; flex: none; }

      .pallet { border-top: 1px solid #33353a; padding-top: 6px; margin-top: 6px; }
      .pallet:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
      .p-line { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; }
      .p-line input { margin-top: 0; padding: 4px; }
      .p-preset { flex: 1; min-width: 0; margin-top: 0; padding: 4px; }
      .p-num { width: 46px; text-align: center; }
      .p-tag { flex: 1; min-width: 0; }
      .times { opacity: 0.5; }
      .icon { background: none; border: none; color: #9aa0a6; cursor: pointer; padding: 2px 3px; font-size: 12px; }
      .shape-btn { background: #2b2d31; border: 1px solid #3a3d42; border-radius: 4px; padding: 3px; cursor: pointer; display: inline-flex; flex: none; }
      .shape-btn svg { display: block; }

      .presets { border: 1px solid #3a3d42; border-radius: 6px; padding: 8px; margin-top: 4px; background: #232529; }
      .preset-row { display: grid; grid-template-columns: 1fr 50px 50px 24px 20px; gap: 4px; align-items: center; margin-bottom: 4px; }
      .preset-row input { margin-top: 0; padding: 4px; }

      .findings { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
      .f { padding: 5px 7px; border-radius: 4px; background: #2b2d31; border-left: 3px solid #6b7280; }
      .f.error { border-left-color: #f0616d; }
      .f.warn { border-left-color: #e3a008; }
      .f.info { border-left-color: #4f9d69; }
      .stop { padding: 5px 7px; border-radius: 4px; margin-top: 4px; border-left: 3px solid #6b7280; background: #2b2d31; }
    </style>
  </head>
  <body>
    <h4>Trailer</h4>
    <label>Preset<select id="preset"></select></label>
    <div class="grid2">
      <label>Length (<span class="u"></span>)<input id="t-length" type="number" min="0" step="any" /></label>
      <label>Width (<span class="u"></span>)<input id="t-width" type="number" min="0" step="any" /></label>
      <label>From walls (<span class="u"></span>)<input id="m-wall" type="number" min="0" step="any" /></label>
      <label>Around pallet (<span class="u"></span>)<input id="m-pallet" type="number" min="0" step="any" /></label>
    </div>
    <div class="row">
      <button class="ghost sm" id="presets-toggle">Manage sizes…</button>
    </div>
    <div class="presets" id="presets" hidden></div>

    <h4>Orders — drag <span style="opacity:.6">&#10303;</span> or use &#9650;&#9660; to set unload order</h4>
    <div id="orders"></div>
    <button class="ghost sm" id="order-add">+ Add order</button>

    <label class="chk"><input type="checkbox" id="dim-each" /> Dimension every pallet on the plan</label>

    <div class="actions">
      <button id="nest">Auto-nest</button>
      <button class="ghost" id="clear">Clear layout</button>
    </div>
    <div id="results"></div>

    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      const $ = (id) => document.getElementById(id);
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const RECT_SVG = '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="3.5" width="10" height="7" rx="1" fill="none" stroke="#dfe1e5" stroke-width="1.4"/></svg>';
      const ROUND_SVG = '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="4.6" fill="none" stroke="#dfe1e5" stroke-width="1.4"/></svg>';

      let unit = { unit: "mm", perMm: 1, label: "mm" };
      let palette = ["#4f86d6"];
      let state = { presets: [], palletPresets: [], lastPresetName: "", wallMargin: 0, palletMargin: 0, dimensions: false, orders: [] };
      let saveTimer = 0;
      let nested = false; // a plan is currently drawn — toggles re-run it live

      const toU = (mm) => Math.round(mm * unit.perMm * 100) / 100;
      const fromU = (v) => (Number(v) || 0) / unit.perMm;
      const rid = (p) => p + "-" + Math.random().toString(36).slice(2, 8);
      const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => post({ type: "persist", state }), 400); };

      // ---- trailer ----
      const currentPreset = () => state.presets.find((p) => p.name === state.lastPresetName) || null;
      function renderTrailer() {
        document.querySelectorAll(".u").forEach((el) => (el.textContent = unit.label));
        const sel = $("preset");
        sel.innerHTML =
          state.presets.map((p) => "<option value='" + esc(p.name) + "'>" + esc(p.name) + "</option>").join("") +
          "<option value='__custom'>Custom…</option>";
        const p = currentPreset();
        sel.value = p ? p.name : "__custom";
        if (p) { $("t-length").value = toU(p.length); $("t-width").value = toU(p.width); }
        $("m-wall").value = toU(state.wallMargin);
        $("m-pallet").value = toU(state.palletMargin);
        $("dim-each").checked = !!state.dimensions;
      }
      $("preset").addEventListener("change", (e) => {
        if (e.target.value === "__custom") return;
        state.lastPresetName = e.target.value;
        renderTrailer();
        persist();
      });
      const onTrailerInput = () => {
        const p = currentPreset();
        if (!p || Math.abs(fromU($("t-length").value) - p.length) > 0.5 || Math.abs(fromU($("t-width").value) - p.width) > 0.5) {
          state.lastPresetName = "";
          $("preset").value = "__custom";
        }
        persist();
      };
      $("t-length").addEventListener("input", onTrailerInput);
      $("t-width").addEventListener("input", onTrailerInput);
      $("m-wall").addEventListener("input", () => { state.wallMargin = fromU($("m-wall").value); persist(); });
      $("m-pallet").addEventListener("input", () => { state.palletMargin = fromU($("m-pallet").value); persist(); });
      $("dim-each").addEventListener("change", () => {
        state.dimensions = $("dim-each").checked;
        persist();
        if (nested) runNest(); // redraw the existing plan with/without dimensions
      });
      function readTrailer() {
        const p = currentPreset();
        return { name: p ? p.name : "Custom trailer", length: fromU($("t-length").value), width: fromU($("t-width").value), wallMargin: Math.max(0, state.wallMargin) };
      }

      // ---- preset managers (trailer + pallet sizes, inline edit + delete) ----
      $("presets-toggle").addEventListener("click", () => {
        $("presets").hidden = !$("presets").hidden;
        if (!$("presets").hidden) renderPresets();
      });
      function presetRows(list, cls, hasShape) {
        return list
          .map(
            (p, i) =>
              "<div class='preset-row' data-i='" + i + "'>" +
              "<input class='" + cls + "-name' value='" + esc(p.name) + "'>" +
              "<input class='" + cls + "-a' type='number' min='0' step='any' value='" + toU(hasShape ? p.width : p.length) + "'>" +
              "<input class='" + cls + "-b' type='number' min='0' step='any' value='" + toU(hasShape ? p.length : p.width) + "'" + (hasShape && p.shape === "round" ? " disabled" : "") + ">" +
              (hasShape ? "<span class='shape-btn " + cls + "-shape'>" + (p.shape === "round" ? ROUND_SVG : RECT_SVG) + "</span>" : "<span></span>") +
              "<button class='icon " + cls + "-del' title='Delete'>&#10005;</button>" +
              "</div>",
          )
          .join("");
      }
      function renderPresets() {
        const box = $("presets");
        box.innerHTML =
          "<div class='muted'>Trailer sizes (L&times;W, " + esc(unit.label) + ")</div>" +
          presetRows(state.presets, "tp", false) +
          "<button class='ghost sm' id='tp-add' style='margin:2px 0 8px'>+ New trailer</button>" +
          "<div class='muted'>Pallet sizes (W&times;L, " + esc(unit.label) + ")</div>" +
          presetRows(state.palletPresets, "pp", true) +
          "<button class='ghost sm' id='pp-add' style='margin-top:2px'>+ New pallet</button>";

        box.querySelectorAll(".preset-row").forEach((row) => {
          const i = Number(row.dataset.i);
          const isPallet = !!row.querySelector(".pp-name");
          const p = (isPallet ? state.palletPresets : state.presets)[i];
          const nameEl = row.querySelector(isPallet ? ".pp-name" : ".tp-name");
          const aEl = row.querySelector(isPallet ? ".pp-a" : ".tp-a");
          const bEl = row.querySelector(isPallet ? ".pp-b" : ".tp-b");
          nameEl.addEventListener("input", (e) => { p.name = e.target.value; persist(); });
          aEl.addEventListener("input", (e) => { if (isPallet) p.width = fromU(e.target.value); else p.length = fromU(e.target.value); persist(); });
          bEl.addEventListener("input", (e) => { if (isPallet) p.length = fromU(e.target.value); else p.width = fromU(e.target.value); persist(); });
          const shapeEl = row.querySelector(".pp-shape");
          if (shapeEl) shapeEl.addEventListener("click", () => { p.shape = p.shape === "round" ? "rect" : "round"; renderPresets(); persist(); });
          row.querySelector(isPallet ? ".pp-del" : ".tp-del").addEventListener("click", () => {
            (isPallet ? state.palletPresets : state.presets).splice(i, 1);
            renderPresets();
            renderTrailer();
            persist();
          });
        });
        box.querySelector("#tp-add").addEventListener("click", () => { state.presets.push({ name: "New trailer", length: 13600, width: 2480 }); renderPresets(); renderTrailer(); persist(); });
        box.querySelector("#pp-add").addEventListener("click", () => { state.palletPresets.push({ name: "New pallet", width: 1200, length: 800, shape: "rect" }); renderPresets(); renderTrailer(); persist(); });
      }

      // ---- orders ----
      function renderOrders() {
        const host = $("orders");
        host.innerHTML = "";
        state.orders.forEach((order, oi) => {
          const card = document.createElement("div");
          card.className = "order";
          card.dataset.i = String(oi);

          const pallets = order.pallets
            .map((p, pi) => {
              const round = p.shape === "round";
              const known = state.palletPresets.some((x) => x.name === p.name);
              const opts =
                state.palletPresets.map((x) => "<option value='" + esc(x.name) + "'" + (x.name === p.name ? " selected" : "") + ">" + esc(x.name) + "</option>").join("") +
                "<option value='__custom'" + (known ? "" : " selected") + ">Custom size</option>";
              return (
                "<div class='pallet' data-p='" + pi + "'>" +
                "<div class='p-line'>" +
                "<select class='p-preset'>" + opts + "</select>" +
                "<span class='shape-btn ps' title='Rectangular / round'>" + (round ? ROUND_SVG : RECT_SVG) + "</span>" +
                "<input class='p-num pq' type='number' min='1' step='1' title='Quantity' value='" + (p.qty || 1) + "'>" +
                "<button class='icon dup' title='Duplicate'>&#8865;</button>" +
                "<button class='icon del' title='Delete'>&#10005;</button>" +
                "</div>" +
                "<div class='p-line'>" +
                "<input class='p-num pw' type='number' min='0' step='any' title='" + (round ? "Diameter" : "Width") + " (" + esc(unit.label) + ")' value='" + toU(p.width) + "'>" +
                (round ? "" : "<span class='times'>&times;</span><input class='p-num pl' type='number' min='0' step='any' title='Length (" + esc(unit.label) + ")' value='" + toU(p.length) + "'>") +
                "<input class='p-tag' placeholder='Tag (e.g. FRAGILE)' value='" + esc(p.tag || "") + "'>" +
                "</div>" +
                "</div>"
              );
            })
            .join("");

          card.innerHTML =
            "<div class='order-head'>" +
            "<span class='handle' title='Drag to reorder'>&#10303;</span>" +
            "<span class='move'><button class='up' title='Move up'>&#9650;</button><button class='down' title='Move down'>&#9660;</button></span>" +
            "<span class='dot' style='background:" + esc(order.color) + "'></span>" +
            "<input class='city' placeholder='City / drop' value='" + esc(order.city) + "'>" +
            "<span class='seq'>#" + (oi + 1) + "</span>" +
            "<button class='icon order-del' title='Remove order'>&#10005;</button>" +
            "</div>" +
            pallets +
            "<button class='ghost sm p-add' style='margin-top:6px'>+ Pallet</button>";

          host.appendChild(card);
        });
        bindOrderEvents();
      }

      function move(from, to) {
        if (to < 0 || to >= state.orders.length || from === to) return;
        const [m] = state.orders.splice(from, 1);
        state.orders.splice(to, 0, m);
        renderOrders();
        persist();
      }

      function bindOrderEvents() {
        $("orders").querySelectorAll(".order").forEach((card) => {
          const oi = Number(card.dataset.i);
          const order = state.orders[oi];
          card.querySelector(".up").disabled = oi === 0;
          card.querySelector(".down").disabled = oi === state.orders.length - 1;
          card.querySelector(".up").addEventListener("click", () => move(oi, oi - 1));
          card.querySelector(".down").addEventListener("click", () => move(oi, oi + 1));
          card.querySelector(".city").addEventListener("input", (e) => { order.city = e.target.value; persist(); });
          card.querySelector(".order-del").addEventListener("click", () => { state.orders.splice(oi, 1); renderOrders(); persist(); });
          card.querySelector(".p-add").addEventListener("click", () => {
            order.pallets.push({ id: rid("p"), name: "EUR pallet", width: 1200, length: 800, shape: "rect", qty: 1 });
            renderOrders();
            persist();
          });

          card.querySelectorAll(".pallet").forEach((row) => {
            const pi = Number(row.dataset.p);
            const p = order.pallets[pi];
            row.querySelector(".p-preset").addEventListener("change", (e) => {
              const v = e.target.value;
              const pp = state.palletPresets.find((x) => x.name === v);
              if (pp) { p.name = pp.name; p.width = pp.width; p.length = pp.length; p.shape = pp.shape; }
              else p.name = "";
              renderOrders();
              persist();
            });
            row.querySelector(".pq").addEventListener("input", (e) => { p.qty = Math.max(1, Math.floor(Number(e.target.value) || 1)); persist(); });
            row.querySelector(".pw").addEventListener("input", (e) => { p.width = fromU(e.target.value); persist(); });
            const plEl = row.querySelector(".pl");
            if (plEl) plEl.addEventListener("input", (e) => { p.length = fromU(e.target.value); persist(); });
            row.querySelector(".p-tag").addEventListener("input", (e) => { p.tag = e.target.value; persist(); });
            row.querySelector(".ps").addEventListener("click", () => {
              p.shape = p.shape === "round" ? "rect" : "round";
              if (p.shape === "round") p.length = p.width;
              renderOrders();
              persist();
            });
            row.querySelector(".dup").addEventListener("click", () => { order.pallets.splice(pi + 1, 0, { ...p, id: rid("p") }); renderOrders(); persist(); });
            row.querySelector(".del").addEventListener("click", () => { order.pallets.splice(pi, 1); renderOrders(); persist(); });
          });

          // Pointer-drag reorder on the handle (HTML5 DnD is unreliable in the sandbox).
          const handle = card.querySelector(".handle");
          handle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
            const cards = [...$("orders").querySelectorAll(".order")];
            const clear = () => cards.forEach((c) => c.classList.remove("drop-before", "drop-after"));
            // insertBefore is an index in 0..cards.length: where the dragged card
            // should land relative to the *current* list.
            let insertBefore = oi;
            let moved = false;
            const onMove = (ev) => {
              moved = true;
              clear();
              insertBefore = cards.length;
              for (let k = 0; k < cards.length; k++) {
                const r = cards[k].getBoundingClientRect();
                if (ev.clientY < r.top + r.height / 2) { insertBefore = k; break; }
              }
              if (insertBefore >= cards.length) cards[cards.length - 1].classList.add("drop-after");
              else cards[insertBefore].classList.add("drop-before");
            };
            const onUp = () => {
              clear();
              handle.removeEventListener("pointermove", onMove);
              handle.removeEventListener("pointerup", onUp);
              try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
              if (!moved) return;
              // Remove the dragged card first, then insert — every slot at or past
              // oi shifts down by one.
              const to = insertBefore > oi ? insertBefore - 1 : insertBefore;
              move(oi, Math.max(0, Math.min(to, state.orders.length - 1)));
            };
            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onUp);
          });
        });
      }

      $("order-add").addEventListener("click", () => {
        state.orders.push({ id: rid("o"), city: "", color: palette[state.orders.length % palette.length], pallets: [{ id: rid("p"), name: "EUR pallet", width: 1200, length: 800, shape: "rect", qty: 1 }] });
        renderOrders();
        persist();
      });

      function runNest() {
        post({ type: "nest", trailer: readTrailer(), orders: state.orders, palletMargin: Math.max(0, state.palletMargin), dimensions: !!state.dimensions });
        $("results").innerHTML = "<div class='muted'>Nesting…</div>";
      }
      $("nest").addEventListener("click", runNest);
      $("clear").addEventListener("click", () => { nested = false; post({ type: "clear" }); $("results").innerHTML = ""; });

      // ---- results ----
      function renderResult(m) {
        const box = $("results");
        if (m.type === "cleared") { nested = false; box.innerHTML = "<div class='muted'>Layout cleared.</div>"; return; }
        if (m.type === "error") { box.innerHTML = "<div class='f error'>" + esc(m.message) + "</div>"; return; }
        nested = true;
        const r = m.result;
        let html =
          "<h4>Result</h4><div class='muted'>" + r.placed.length + " placed, " + r.unplaced.length +
          " unplaced &middot; " + Math.round(toU(r.usedLength)) + " / " + Math.round(toU(r.trailer.length)) + " " + esc(unit.label) + " used</div>";
        html += "<div class='findings'>" + m.findings.map((f) => "<div class='f " + f.level + "'>" + esc(f.message) + "</div>").join("") + "</div>";
        const byOrder = new Map();
        r.placed.forEach((p) => {
          const e = byOrder.get(p.orderId) || { city: p.city, color: p.color, index: p.orderIndex, n: 0 };
          e.n += 1;
          byOrder.set(p.orderId, e);
        });
        const seq = [...byOrder.values()].sort((a, b) => a.index - b.index);
        if (seq.length) html += "<h4>Unload sequence</h4>";
        seq.forEach((o) => {
          html += "<div class='stop' style='border-left-color:" + esc(o.color) + "'>#" + (o.index + 1) + " " + esc(o.city || "—") + " · " + o.n + " pallet" + (o.n === 1 ? "" : "s") + "</div>";
        });
        html += "<div class='muted' style='margin-top:8px'>Use the toolbar Print button for a PDF with the plan and this summary.</div>";
        box.innerHTML = html;
      }

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m) return;
        if (m.type === "init") {
          state = m.state;
          unit = m.unit || unit;
          palette = m.palette && m.palette.length ? m.palette : palette;
          renderTrailer();
          renderOrders();
          if (!$("presets").hidden) renderPresets();
          return;
        }
        if (m.type === "unit") {
          unit = m.unit;
          renderTrailer();
          renderOrders();
          if (!$("presets").hidden) renderPresets();
          return;
        }
        renderResult(m);
      });

      post({ type: "ready" });
    </script>
  </body>
</html>`;

export default plugin;
