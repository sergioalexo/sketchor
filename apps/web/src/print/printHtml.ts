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
 */
export function printHtml(bodyHtml: string): void {
  const root = ensurePrintRoot();
  root.innerHTML = `
    <div class="print-preview-bar">
      <span>Print preview</span>
      <div class="print-preview-actions">
        <button type="button" class="btn ghost" id="sketchor-print-close">Close</button>
        <button type="button" class="btn primary" id="sketchor-print-go">Print…</button>
      </div>
    </div>
    <div class="print-preview-page"><div class="print-preview-sheet">${bodyHtml}</div></div>
  `;
  document.body.classList.add("sketchor-printing");

  const cleanup = () => closePreview(root);
  root.querySelector("#sketchor-print-close")?.addEventListener("click", cleanup);
  root.querySelector("#sketchor-print-go")?.addEventListener("click", () => {
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
