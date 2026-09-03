import {
  buildNestLayout,
  clearPreviousLayout,
  NEST_LAYER,
  nestParts,
  type NestPart,
  type NestResult,
  type Point,
  type RotationMode,
  type Sheet,
} from "@sketchor/plugin-nest";
import { type DisplayUnitInfo, type DocumentReadModel, type PluginModule } from "@sketchor/plugin-sdk";

/**
 * First-party dogfood: laser / sheet nesting. The bottom-left-fill algorithm
 * lives in `@sketchor/plugin-nest` (SDK-only); this module shows the panel,
 * tracks which closed shapes are selected, and on request reads their outlines,
 * nests them, and applies the layout through `document.apply` as one undo step.
 *
 * Contributes the command `nest.open` and declares a `ui` entry.
 */

type SheetPreset = Sheet;

interface PersistedState {
  presets: SheetPreset[];
  lastPresetName: string;
  spacing: number;
  rotation: RotationMode;
  maxSheets: number;
}

const STORAGE_KEY = "state";

const SEED_PRESETS: SheetPreset[] = [
  { name: "Ply 2440 × 1220", width: 2440, height: 1220 },
  { name: "MDF 3050 × 1525", width: 3050, height: 1525 },
  { name: "Acrylic 600 × 400", width: 600, height: 400 },
];

const ROTATIONS: RotationMode[] = ["none", "flip", "quarter"];

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asSheet(v: unknown): SheetPreset | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const width = Math.max(1, num(o.width, 1));
  const height = Math.max(1, num(o.height, 1));
  return { name: typeof o.name === "string" && o.name ? o.name : "Sheet", width, height };
}

function asState(v: unknown): PersistedState {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const presets = Array.isArray(o.presets)
    ? o.presets.map(asSheet).filter((p): p is SheetPreset => p !== null)
    : [];
  const rotation = ROTATIONS.includes(o.rotation as RotationMode) ? (o.rotation as RotationMode) : "flip";
  return {
    presets: presets.length > 0 ? presets : [...SEED_PRESETS],
    lastPresetName: typeof o.lastPresetName === "string" ? o.lastPresetName : (presets[0]?.name ?? SEED_PRESETS[0].name),
    spacing: Math.max(0, num(o.spacing)),
    rotation,
    maxSheets: Math.max(1, Math.floor(num(o.maxSheets, 1))),
  };
}

// --- reading parts from the document ---

const CIRCLE_SIDES = 48;

interface PartInfo {
  part: NestPart;
  label: string;
  w: number;
  h: number;
}

/** A closed-shape entity from the read-model → a nestable part, or null. */
function toPart(entity: DocumentReadModel["entities"][number]): PartInfo | null {
  let polygon: Point[] | null = null;
  let round = false;

  if (entity.type === "polyline" && entity.closed && entity.points.length >= 3) {
    polygon = entity.points.map((p) => ({ x: p.x, y: p.y }));
  } else if (entity.type === "circle") {
    round = true;
    polygon = Array.from({ length: CIRCLE_SIDES }, (_, i) => {
      const a = (i / CIRCLE_SIDES) * Math.PI * 2;
      return { x: entity.center.x + Math.cos(a) * entity.radius, y: entity.center.y + Math.sin(a) * entity.radius };
    });
  }
  if (!polygon) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const label = entity.name || (round ? "circle" : "shape");
  return { part: { id: entity.id, polygon, round, quantity: 1 }, label, w, h };
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

    const readParts = async (): Promise<PartInfo[]> => {
      const [model, selection] = await Promise.all([sketchor.document.read(), sketchor.selection.read()]);
      const sel = new Set(selection);
      return model.entities.filter((e) => sel.has(e.id)).map(toPart).filter((p): p is PartInfo => p !== null);
    };

    const pushParts = async () => {
      const parts = await readParts();
      void sketchor.ui.postMessage({
        type: "parts",
        parts: parts.map((p) => ({ id: p.part.id, label: p.label, w: p.w, h: p.h })),
      });
    };

    const pushInit = () => {
      void sketchor.ui.postMessage({ type: "init", state, unit });
      void pushParts();
    };

    void sketchor.app.onDisplayUnitChange((info) => {
      unit = info;
      void sketchor.ui.postMessage({ type: "unit", unit });
    });
    void sketchor.selection.onChange(() => void pushParts());

    sketchor.commands.register("nest.open", () => {
      void sketchor.ui.show(PANEL_HTML, { title: "Nest", width: 360, height: 520 });
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
        const sheet = asSheet(msg.sheet);
        const spacing = Math.max(0, num(msg.spacing));
        const rotation = ROTATIONS.includes(msg.rotation as RotationMode) ? (msg.rotation as RotationMode) : "none";
        const maxSheets = Math.max(1, Math.floor(num(msg.maxSheets, 1)));
        const quantities = (msg.quantities && typeof msg.quantities === "object" ? msg.quantities : {}) as Record<string, unknown>;

        if (!sheet) {
          void sketchor.ui.postMessage({ type: "error", message: "Set a sheet size first." });
          return;
        }
        const infos = await readParts();
        if (infos.length === 0) {
          void sketchor.ui.postMessage({ type: "error", message: "Select one or more closed shapes to nest." });
          return;
        }
        const parts: NestPart[] = infos.map((info) => ({
          ...info.part,
          quantity: Math.max(0, Math.floor(num(quantities[info.part.id], 1))),
        }));

        try {
          const result: NestResult = nestParts(parts, sheet, { spacing, rotation, maxSheets });
          const model = await sketchor.document.read();
          await sketchor.document.apply([...clearPreviousLayout(model), ...buildNestLayout(result)]);
          void sketchor.ui.postMessage({ type: "result", result });
          const unplaced = result.unplaced.reduce((n, u) => n + u.count, 0);
          sketchor.ui.notify(
            unplaced > 0
              ? `Nested ${result.placed.length} on ${result.sheetsUsed} sheet(s) — ${unplaced} didn't fit.`
              : `Nested ${result.placed.length} part(s) on ${result.sheetsUsed} sheet(s), ${Math.round(result.utilisation * 100)}% used.`,
            { error: unplaced > 0 },
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
      .actions { display: flex; gap: 8px; margin: 12px 0; }
      .muted { opacity: 0.6; }
      .part { display: grid; grid-template-columns: 1fr auto 46px; gap: 6px; align-items: center; margin-bottom: 4px; }
      .part .dim { opacity: 0.55; font-size: 11px; }
      .part input { margin-top: 0; padding: 3px 5px; }
      .f { padding: 5px 7px; border-radius: 4px; background: #2b2d31; border-left: 3px solid #6b7280; margin-top: 4px; }
      .f.error { border-left-color: #f0616d; }
      .f.ok { border-left-color: #4f9d69; }
    </style>
  </head>
  <body>
    <h4>Sheet</h4>
    <label>Preset<select id="preset"></select></label>
    <div class="grid2">
      <label>Width (<span class="u"></span>)<input id="s-w" type="number" min="0" step="any" /></label>
      <label>Height (<span class="u"></span>)<input id="s-h" type="number" min="0" step="any" /></label>
      <label>Spacing (<span class="u"></span>)<input id="s-gap" type="number" min="0" step="any" /></label>
      <label>Max sheets<input id="s-max" type="number" min="1" step="1" /></label>
    </div>
    <label>Rotation
      <select id="rot">
        <option value="none">Keep as drawn</option>
        <option value="flip">0° / 180°</option>
        <option value="quarter">90° steps</option>
      </select>
    </label>
    <div class="row">
      <button class="ghost sm" id="preset-save">Save sheet as preset</button>
      <button class="ghost sm" id="preset-del">Delete preset</button>
    </div>

    <h4>Parts <span class="muted" id="parts-hint"></span></h4>
    <div id="parts"></div>

    <div class="actions">
      <button id="nest">Nest</button>
      <button class="ghost" id="clear">Clear</button>
    </div>
    <div id="results"></div>

    <script>
      const post = (m) => parent.postMessage({ pluginMessage: m }, "*");
      const $ = (id) => document.getElementById(id);
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

      let unit = { unit: "mm", perMm: 1, label: "mm" };
      let state = { presets: [], lastPresetName: "", spacing: 0, rotation: "flip", maxSheets: 1 };
      let parts = [];
      let qty = {};
      let saveTimer = 0;

      const toU = (mm) => Math.round(mm * unit.perMm * 100) / 100;
      const fromU = (v) => (Number(v) || 0) / unit.perMm;

      function persist() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => post({ type: "persist", state }), 400);
      }

      function currentPreset() {
        return state.presets.find((p) => p.name === state.lastPresetName) || null;
      }
      function renderSheet() {
        document.querySelectorAll(".u").forEach((el) => (el.textContent = unit.label));
        const sel = $("preset");
        sel.innerHTML =
          state.presets.map((p) => "<option value='" + esc(p.name) + "'>" + esc(p.name) + "</option>").join("") +
          "<option value='__custom'>Custom…</option>";
        const preset = currentPreset();
        sel.value = preset ? preset.name : "__custom";
        if (preset) { $("s-w").value = toU(preset.width); $("s-h").value = toU(preset.height); }
        $("s-gap").value = toU(state.spacing);
        $("s-max").value = state.maxSheets;
        $("rot").value = state.rotation;
        $("preset-del").disabled = !preset;
      }
      $("preset").addEventListener("change", (e) => {
        if (e.target.value === "__custom") return;
        state.lastPresetName = e.target.value;
        renderSheet();
        persist();
      });
      const onSheetInput = () => {
        const p = currentPreset();
        if (!p || Math.abs(fromU($("s-w").value) - p.width) > 0.5 || Math.abs(fromU($("s-h").value) - p.height) > 0.5) {
          state.lastPresetName = "";
          $("preset").value = "__custom";
          $("preset-del").disabled = true;
        }
        persist();
      };
      $("s-w").addEventListener("input", onSheetInput);
      $("s-h").addEventListener("input", onSheetInput);
      $("s-gap").addEventListener("input", () => { state.spacing = fromU($("s-gap").value); persist(); });
      $("s-max").addEventListener("input", () => { state.maxSheets = Math.max(1, Math.floor(Number($("s-max").value) || 1)); persist(); });
      $("rot").addEventListener("change", () => { state.rotation = $("rot").value; persist(); });
      $("preset-save").addEventListener("click", () => {
        const name = (prompt("Name this sheet size:") || "").trim();
        if (!name) return;
        state.presets = state.presets.filter((p) => p.name !== name).concat({ name, width: fromU($("s-w").value), height: fromU($("s-h").value) });
        state.lastPresetName = name;
        renderSheet();
        persist();
      });
      $("preset-del").addEventListener("click", () => {
        const p = currentPreset();
        if (!p) return;
        state.presets = state.presets.filter((x) => x.name !== p.name);
        state.lastPresetName = state.presets[0] ? state.presets[0].name : "";
        renderSheet();
        persist();
      });

      function renderParts() {
        $("parts-hint").textContent = parts.length ? "" : "— select closed shapes on the canvas";
        const box = $("parts");
        box.innerHTML = parts
          .map(
            (p) =>
              "<div class='part' data-id='" + esc(p.id) + "'>" +
              "<span>" + esc(p.label) + "</span>" +
              "<span class='dim'>" + Math.round(toU(p.w)) + "×" + Math.round(toU(p.h)) + " " + esc(unit.label) + "</span>" +
              "<input type='number' min='0' step='1' class='q' value='" + (qty[p.id] || 1) + "'>" +
              "</div>",
          )
          .join("");
        box.querySelectorAll(".part").forEach((row) => {
          const id = row.dataset.id;
          row.querySelector(".q").addEventListener("input", (e) => { qty[id] = Math.max(0, Math.floor(Number(e.target.value) || 0)); });
        });
      }

      $("nest").addEventListener("click", () => {
        const p = currentPreset();
        post({
          type: "nest",
          sheet: { name: p ? p.name : "Sheet", width: fromU($("s-w").value), height: fromU($("s-h").value) },
          spacing: Math.max(0, state.spacing),
          rotation: state.rotation,
          maxSheets: state.maxSheets,
          quantities: qty,
        });
        $("results").innerHTML = "<div class='muted'>Nesting…</div>";
      });
      $("clear").addEventListener("click", () => { post({ type: "clear" }); $("results").innerHTML = ""; });

      window.addEventListener("message", (e) => {
        const m = e.data && e.data.pluginMessage;
        if (!m) return;
        if (m.type === "init") { state = m.state; unit = m.unit || unit; renderSheet(); return; }
        if (m.type === "unit") { unit = m.unit; renderSheet(); renderParts(); return; }
        if (m.type === "parts") {
          parts = m.parts || [];
          const live = {};
          parts.forEach((p) => (live[p.id] = qty[p.id] || 1));
          qty = live;
          renderParts();
          return;
        }
        const box = $("results");
        if (m.type === "cleared") { box.innerHTML = "<div class='f'>Cleared.</div>"; return; }
        if (m.type === "error") { box.innerHTML = "<div class='f error'>" + esc(m.message) + "</div>"; return; }
        if (m.type === "result") {
          const r = m.result;
          const unplaced = (r.unplaced || []).reduce((n, u) => n + u.count, 0);
          box.innerHTML =
            "<div class='f " + (unplaced ? "error" : "ok") + "'>" + r.placed.length + " placed on " + r.sheetsUsed +
            " sheet(s), " + Math.round(r.utilisation * 100) + "% used" + (unplaced ? " · " + unplaced + " didn't fit" : "") + ".</div>";
        }
      });

      post({ type: "ready" });
    </script>
  </body>
</html>`;

export default plugin;
