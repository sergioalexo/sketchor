import { useEffect, useRef, useState } from "react";
import { parseSvgText } from "@sketchor/core";
import { getSessions, importDxfText, importEntities, openIntoSession, useApp } from "../state/store";
import { fileToSvg, isDrawingFile } from "./thumbnail";

interface Entry {
  name: string;
  /** Already-read content (e.g. from the "Add files…" picker) — skips the lazy read below. */
  text?: string;
  /** Web folder browsing: a handle to lazily read the file's text. */
  handle?: FileSystemFileHandle;
  /** Desktop: a full path passed to the Rust `read_drawing_file` command. */
  path?: string;
}

interface TauriInvoke {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function tauri(): TauriInvoke | undefined {
  return (window as unknown as { __TAURI__?: TauriInvoke }).__TAURI__;
}

async function readEntryText(entry: Entry): Promise<string> {
  if (entry.text !== undefined) return entry.text;
  if (entry.handle) return (await entry.handle.getFile()).text();
  if (entry.path) {
    const t = tauri();
    if (!t) return "";
    return (await t.core.invoke("read_drawing_file", { path: entry.path })) as string;
  }
  return "";
}

function openEntry(entry: Entry, text: string): void {
  if (/\.svg$/i.test(entry.name)) {
    const { entities, warnings } = parseSvgText(text);
    openIntoSession(entry.name, () => importEntities(entities, warnings));
  } else {
    openIntoSession(entry.name, () => importDxfText(text));
  }
}

const MIN_WIDTH = 160;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 240;

/**
 * Left-dock "mini-Explorer" (R9): geometry thumbnails of every .dxf/.svg
 * drawing in a folder, click to open into a new tab. Reuses the same
 * dxfToSvg/entitiesToSvg headless renderer as the native Explorer
 * thumbnailer, so previews everywhere agree. Drag the right edge to resize.
 *
 * Folder access, in order of preference: on desktop, a directory (from a
 * file opened via Explorer/file-association) is read in Rust with no
 * sandbox limits; on the web, a one-time `showDirectoryPicker()` grant, or
 * (always available) picking individual files.
 *
 * Stays mounted even while toggled off (`hidden`, shown via CSS) — its
 * loaded entries/thumbnails are local state, so unmounting on every toggle
 * would throw them away and re-browse from scratch each time it's reopened.
 */
export function FileExplorerPanel({ hidden, onClose }: { hidden: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const desktopDir = useApp((s) => s.fileBrowserDesktopDir);
  const activeSessionId = useApp((s) => s.activeSessionId);

  const supportsDirPicker = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
  const isDesktop = !!tauri();

  const openFolder = async () => {
    try {
      const dir = await (
        window as unknown as { showDirectoryPicker: () => Promise<{ name: string; values: () => AsyncIterable<FileSystemHandle & { kind: string; name: string }> }> }
      ).showDirectoryPicker();
      const list: Entry[] = [];
      for await (const item of dir.values()) {
        if (item.kind === "file" && isDrawingFile(item.name)) {
          list.push({ name: item.name, handle: item as unknown as FileSystemFileHandle });
        }
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      setEntries(list);
      setFolderLabel(dir.name);
    } catch {
      // user cancelled the picker
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const picked = await Promise.all(
      Array.from(files)
        .filter((f) => isDrawingFile(f.name))
        .map(async (f) => ({ name: f.name, text: await f.text() })),
    );
    if (picked.length === 0) return;
    setEntries((prev) => {
      const byName = new Map(prev.map((e) => [e.name, e]));
      for (const p of picked) byName.set(p.name, p);
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
    setFolderLabel(null);
  };

  // Resize: drag the right-edge handle.
  const resizing = useRef(false);
  const onResizeStart = (e: React.PointerEvent) => {
    resizing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizing.current) return;
    const panelLeft = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().left;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX - panelLeft));
    setWidth(next);
  };
  const onResizeEnd = (e: React.PointerEvent) => {
    resizing.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
  };

  // Desktop: a file opened from Explorer sets fileBrowserDesktopDir -> auto-load + reveal.
  useEffect(() => {
    if (!desktopDir) return;
    const t = tauri();
    if (!t) return;
    t.core
      .invoke("list_drawings_in_dir", { dir: desktopDir })
      .then((res) => {
        const list = (res as { name: string; path: string }[])
          .filter((e) => isDrawingFile(e.name))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => ({ name: e.name, path: e.path }));
        setEntries(list);
        setFolderLabel(desktopDir.split(/[/\\]/).filter(Boolean).pop() ?? desktopDir);
      })
      .catch(() => {
        // Best-effort: an older desktop build without the command, or a read error.
      });
  }, [desktopDir]);

  return (
    <aside
      className="filexplorer"
      data-testid="file-explorer"
      style={{ width, display: hidden ? "none" : undefined }}
    >
      <div className="filexplorer-header">
        <span className="filexplorer-title">{folderLabel ?? "Files"}</span>
        <div className="filexplorer-actions">
          {(supportsDirPicker || isDesktop) && (
            <button className="btn ghost" onClick={openFolder} data-testid="file-explorer-open-folder">
              Open folder…
            </button>
          )}
          <button className="btn ghost" onClick={() => fileInputRef.current?.click()} data-testid="file-explorer-add-files">
            Add files…
          </button>
          <button className="btn ghost" onClick={onClose} title="Hide panel">
            ✕
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".dxf,.svg"
          multiple
          hidden
          onChange={(e) => void addFiles(e.target.files)}
        />
      </div>

      {entries.length === 0 ? (
        <div className="filexplorer-empty">
          {isDesktop
            ? "Open a .dxf or .svg file, or pick a folder, to browse its drawings."
            : supportsDirPicker
              ? "Use Open folder… or Add files… to browse drawings."
              : "Use Add files… to preview and open drawings."}
        </div>
      ) : (
        <div className="filexplorer-grid" data-testid="file-explorer-grid">
          {entries.map((entry) => (
            <FileCard key={entry.name} entry={entry} activeSessionId={activeSessionId} />
          ))}
        </div>
      )}

      <div
        className="filexplorer-resize"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        title="Drag to resize"
        data-testid="file-explorer-resize"
      />
    </aside>
  );
}

function FileCard({ entry, activeSessionId }: { entry: Entry; activeSessionId: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cardRef = useRef<HTMLButtonElement>(null);
  const textCacheRef = useRef<string | null>(entry.text ?? null);

  const activeName = getSessions().find((s) => s.id === activeSessionId)?.name;
  const isActive = activeName === entry.name;

  // Render on demand: only fetch + rasterize once this card actually scrolls into view.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || svg || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setLoading(true);
          readEntryText(entry)
            .then((text) => {
              textCacheRef.current = text;
              setSvg(fileToSvg(entry.name, text, { size: 110, background: "#17181c", stroke: "#c7d0dc" }));
            })
            .catch(() => setSvg(fileToSvg(entry.name, "", { size: 110 })))
            .finally(() => setLoading(false));
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.name]);

  const handleOpen = async () => {
    const text = textCacheRef.current ?? (await readEntryText(entry));
    openEntry(entry, text);
  };

  return (
    <button
      className={`filecard ${isActive ? "active" : ""}`}
      data-testid="file-card"
      title={`Open ${entry.name}`}
      onClick={handleOpen}
      ref={cardRef}
    >
      <span className="filecard-thumb">
        {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="filecard-placeholder" />}
      </span>
      <span className="filecard-name">{entry.name}</span>
    </button>
  );
}
