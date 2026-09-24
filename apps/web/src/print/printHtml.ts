import {
  autosaveEnabled,
  autosaveFolderLabel,
  pickAutosaveFolder,
  safeFileName,
  saveToAutosaveFolder,
  setAutosaveEnabled,
  standalonePrintDocument,
  supportsAutosave,
} from "../io/autosaveFolder";

const PRINT_ROOT_ID = "sketchor-print-root";

function ensurePrintRoot(): HTMLDivElement {
  let root = document.getElementById(PRINT_ROOT_ID) as HTMLDivElement | null;
  if (!root) {
    root = document.createElement("div");
    root.id = PRINT_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

let escHandler: ((e: KeyboardEvent) => void) | null = null;

function closePreview(root: HTMLDivElement): void {
  document.body.classList.remove("sketchor-printing");
  root.innerHTML = "";
  if (escHandler) {
    window.removeEventListener("keydown", escHandler);
    escHandler = null;
  }
}

export interface PrintOptions {
  /**
   * What to call the saved copy (no extension). The load planner passes the
   * load's name and date; without one the file is stamped with today's date.
   */
  fileName?: string;
  /**
   * The same sheet as a PDF. When given, that is what the autosave folder
   * receives — a PDF is what an office files, and what opens the same on a
   * phone in a yard. Without it the copy is standalone HTML, as before.
   */
  pdf?: Uint8Array;
}

/**
 * Shows `bodyHtml` in an on-page print preview (a "Print…" button commits to
 * the OS print dialog via `window.print()`, "Close" backs out) instead of
 * jumping straight into the print dialog. In-page rather than a
 * `window.open("", "_blank")` popup: a popup blocker silently drops that, and
 * the Tauri desktop shell's webview doesn't reliably turn it into a real
 * second window either. `body.sketchor-printing` (see styles.css) hides
 * everything except `#sketchor-print-root` — both for this on-screen preview
 * and, via `@media print`, for the actual print output (the preview's own
 * Close/Print bar is hidden from print output there too).
 *
 * The bar also carries **autosave**: a remembered folder (see
 * `io/autosaveFolder.ts`) that each printed sheet is written into as a
 * standalone HTML file, so a plan that went to the printer is also filed
 * where the office keeps them without a second dialog.
 */
export function printHtml(bodyHtml: string, options: PrintOptions = {}): void {
  const root = ensurePrintRoot();
  const title = options.fileName?.trim() || `Sketchor print ${new Date().toISOString().slice(0, 10)}`;
  const canSave = supportsAutosave();
  const folder = autosaveFolderLabel();
  const kind = options.pdf ? "PDF" : "standalone HTML file";
  const autosave = `
    <label class="print-autosave" title="Also write the sheet into a folder, as a ${kind}">
      <input type="checkbox" id="sketchor-print-autosave"${autosaveEnabled() && folder ? " checked" : ""}>
      <span>Save a ${options.pdf ? "PDF" : "copy"}</span>
    </label>
    <button type="button" class="btn ghost sm" id="sketchor-print-folder">${folder ? escapeHtml(folder) : "Choose folder…"}</button>
    <span class="print-save-note" id="sketchor-print-note"></span>`;

  root.innerHTML = `
    <div class="print-preview-bar">
      <span>Print preview</span>
      <div class="print-preview-actions">
        ${canSave ? autosave : ""}
        <button type="button" class="btn ghost" id="sketchor-print-close">Close</button>
        <button type="button" class="btn primary" id="sketchor-print-go">Print…</button>
      </div>
    </div>
    <div class="print-preview-page"><div class="print-preview-sheet">${bodyHtml}</div></div>
  `;
  document.body.classList.add("sketchor-printing");

  const note = root.querySelector("#sketchor-print-note") as HTMLElement | null;
  const checkbox = root.querySelector("#sketchor-print-autosave") as HTMLInputElement | null;
  const folderBtn = root.querySelector("#sketchor-print-folder") as HTMLButtonElement | null;
  const say = (text: string, bad = false) => {
    if (!note) return;
    note.textContent = text;
    note.classList.toggle("bad", bad);
  };

  checkbox?.addEventListener("change", async () => {
    setAutosaveEnabled(checkbox.checked);
    // Turning it on with no folder yet: ask immediately rather than
    // failing silently at the moment the user presses Print.
    if (checkbox.checked && !autosaveFolderLabel()) {
      const picked = await pickAutosaveFolder();
      if (picked && folderBtn) folderBtn.textContent = picked;
      if (!picked) {
        checkbox.checked = false;
        setAutosaveEnabled(false);
      }
    }
  });

  folderBtn?.addEventListener("click", async () => {
    const picked = await pickAutosaveFolder();
    if (!picked) return;
    folderBtn.textContent = picked;
    say(`Copies go to “${picked}”`);
  });

  const cleanup = () => closePreview(root);
  root.querySelector("#sketchor-print-close")?.addEventListener("click", cleanup);
  root.querySelector("#sketchor-print-go")?.addEventListener("click", async () => {
    // The save happens first, inside this click: a restored folder handle
    // needs permission, and the browser only grants that during a gesture.
    // window.print() blocks, so anything after it would miss that window.
    if (checkbox?.checked) {
      const outcome = options.pdf
        ? await saveToAutosaveFolder(safeFileName(title, "pdf"), options.pdf)
        : await saveToAutosaveFolder(safeFileName(title), standalonePrintDocument(bodyHtml, title));
      if (outcome.ok) say(`Saved ${outcome.file} to “${outcome.folder}”`);
      else say(outcome.message, true);
      if (!outcome.ok && outcome.reason !== "no-folder") return; // let them see why before printing
    }
    window.print();
  });

  escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") cleanup();
  };
  window.addEventListener("keydown", escHandler);

  const afterprint = () => {
    window.removeEventListener("afterprint", afterprint);
    cleanup();
  };
  window.addEventListener("afterprint", afterprint);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}
