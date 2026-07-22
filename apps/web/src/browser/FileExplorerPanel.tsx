import { useEffect, useRef, useState } from "react";
import { getSessions, importDxfText, loadDrawingJson, openIntoSession, useApp } from "../state/store";
import { fileToSvg, isDrawingFile } from "./thumbnail";

interface Entry {
  name: string;
  /** Web: a handle to lazily read the file's text. Desktop: a full path passed to the Rust `read_drawing_file` command. */
  handle?: FileSystemFileHandle;
  path?: string;
}

interface TauriInvoke {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function tauri(): TauriInvoke | undefined {
  return (window as unknown as { __TAURI__?: TauriInvoke }).__TAURI__;
}

async function readEntryText(entry: Entry): Promise<string> {
  if (entry.handle) return (await entry.handle.getFile()).text();
  if (entry.path) {
    const t = tauri();
    if (!t) return "";
    return (await t.core.invoke("read_drawing_file", { path: entry.path })) as string;
  }
  return "";
}

function openEntry(entry: Entry, text: string): void {
  if (/\.dxf$/i.test(entry.name)) {
    openIntoSession(entry.name, () => importDxfText(text));
  } else {
    openIntoSession(entry.name, () => loadDrawingJson(text));
  }
}

/**
 * Left-dock "mini-Explorer" (R9): geometry thumbnails of every .dxf/.sketchor
 * drawing in a folder, click to open into a new tab. Reuses the same
 * dxfToSvg/entitiesToSvg headless renderer as the DXF library strip and the
 * native Explorer thumbnailer, so previews everywhere agree.
 *
 * Two folder-access paths: on desktop, a directory (from a file opened via
 * Explorer/file-association) is read in Rust with no sandbox limits; on the
 * web, a one-time `showDirectoryPicker()` grant is required.
 */
export function FileExplorerPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [folderLabel, setFolderLabel] = useState<string | null>(null);
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
    <aside className="filexplorer" data-testid="file-explorer">
      <div className="filexplorer-header">
        <span className="filexplorer-title">{folderLabel ?? "Files"}</span>
        <div className="filexplorer-actions">
          {(supportsDirPicker || isDesktop) && (
            <button className="btn ghost" onClick={openFolder} data-testid="file-explorer-open-folder">
              Open folder…
            </button>
          )}
          <button className="btn ghost" onClick={onClose} title="Hide panel">
            ✕
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="filexplorer-empty">
          {isDesktop
            ? "Open a .dxf or .sketchor file, or pick a folder, to browse its drawings."
            : supportsDirPicker
              ? "Use Open folder… to browse a folder of drawings."
              : "Folder browsing isn't supported in this browser."}
        </div>
      ) : (
        <div className="filexplorer-grid" data-testid="file-explorer-grid">
          {entries.map((entry) => (
            <FileCard key={entry.name} entry={entry} activeSessionId={activeSessionId} />
          ))}
        </div>
      )}
    </aside>
  );
}

function FileCard({ entry, activeSessionId }: { entry: Entry; activeSessionId: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cardRef = useRef<HTMLButtonElement>(null);
  const textCacheRef = useRef<string | null>(null);

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
