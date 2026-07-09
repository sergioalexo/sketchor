import { useMemo, useRef } from "react";
import { dxfToSvg } from "@sketchor/core";
import { importDxfText, useApp, type DxfFile } from "../state/store";

/**
 * Browsable strip of DXF files with live thumbnails. Load a folder (File
 * System Access API) or pick files, preview them all, and click one to
 * open it on the canvas. The thumbnails are rendered by the same
 * `dxfToSvg` used by the future native Explorer handler.
 */
export function DxfBrowser({ onClose }: { onClose: () => void }) {
  const library = useApp((s) => s.library);
  const addLibraryFiles = useApp((s) => s.addLibraryFiles);
  const clearLibrary = useApp((s) => s.clearLibrary);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const supportsDirPicker = typeof (window as any).showDirectoryPicker === "function";

  const openFolder = async () => {
    try {
      const dir = await (window as any).showDirectoryPicker();
      const files: DxfFile[] = [];
      for await (const entry of dir.values()) {
        if (entry.kind === "file" && /\.dxf$/i.test(entry.name)) {
          const file = await entry.getFile();
          files.push({ name: entry.name, text: await file.text() });
        }
      }
      if (files.length) addLibraryFiles(files);
    } catch {
      // user cancelled the picker
    }
  };

  const onFilesPicked = async (list: FileList | null) => {
    if (!list) return;
    const files: DxfFile[] = [];
    for (const file of Array.from(list)) {
      if (/\.dxf$/i.test(file.name)) files.push({ name: file.name, text: await file.text() });
    }
    if (files.length) addLibraryFiles(files);
  };

  return (
    <section className="dxfstrip" data-testid="dxf-browser">
      <div className="dxfstrip-header">
        <span className="dxfstrip-title">DXF Library</span>
        <span className="dxfstrip-count">{library.length ? `${library.length} files` : ""}</span>
        <div className="dxfstrip-actions">
          {supportsDirPicker && (
            <button className="btn ghost" onClick={openFolder} data-testid="dxf-open-folder">
              Open folder…
            </button>
          )}
          <button className="btn ghost" onClick={() => fileInputRef.current?.click()}>
            Add files…
          </button>
          {library.length > 0 && (
            <button className="btn ghost" onClick={clearLibrary}>
              Clear
            </button>
          )}
          <button className="btn ghost" onClick={onClose} title="Hide library">
            ✕
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".dxf"
          multiple
          hidden
          onChange={(e) => onFilesPicked(e.target.files)}
        />
      </div>

      {library.length === 0 ? (
        <div className="dxfstrip-empty">
          No DXF files loaded. Use <strong>{supportsDirPicker ? "Open folder…" : "Add files…"}</strong>{" "}
          to preview a folder of drawings, then click one to open it.
        </div>
      ) : (
        <div className="dxfstrip-grid" data-testid="dxf-grid">
          {library.map((f) => (
            <DxfCard key={f.name} file={f} />
          ))}
        </div>
      )}
    </section>
  );
}

function DxfCard({ file }: { file: DxfFile }) {
  const svg = useMemo(
    () => dxfToSvg(file.text, { size: 120, background: "#17181c", stroke: "#c7d0dc" }),
    [file.text],
  );
  return (
    <button
      className="dxfcard"
      data-testid="dxf-card"
      title={`Open ${file.name}`}
      onClick={() => importDxfText(file.text)}
    >
      <span className="dxfcard-thumb" dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="dxfcard-name">{file.name}</span>
    </button>
  );
}
