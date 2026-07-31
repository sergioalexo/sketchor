import { useEffect, useRef, useState } from "react";
import { parseSvgText } from "@sketchor/core";
import { getSessions, importDxfText, importEntities, openIntoSession, useApp } from "../state/store";
import { fileToSvg, isDrawingFile, queueThumbnail } from "./thumbnail";

interface Entry {
  name: string;
  /** Already-read content — skips the lazy read below. */
  text?: string;
  /** A picked `File` whose content is read on demand, so adding hundreds of files doesn't read them all upfront. */
  file?: File;
  /** Web folder browsing: a handle to lazily read the file's text. */
  handle?: FileSystemFileHandle;
  /** Desktop: a full path passed to the Rust `read_drawing_file` command. */
  path?: string;
  /** Last-modified time (ms epoch), when known. */
  mtime?: number;
  /** File size in bytes, when known. */
  size?: number;
}

type SortMode = "name" | "date" | "size";
type SortDir = "asc" | "desc";
type ViewMode = "grid" | "list";

/** Default direction per column: names read A-Z, but dates and sizes are most useful largest/newest first. */
const DEFAULT_DIR: Record<SortMode, SortDir> = { name: "asc", date: "desc", size: "desc" };

function sortEntries(list: Entry[], mode: SortMode, dir: SortDir): Entry[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (mode === "date" || mode === "size") {
      const av = mode === "date" ? a.mtime : a.size;
      const bv = mode === "date" ? b.mtime : b.size;
      // Entries with no value (e.g. a desktop listing that couldn't stat the
      // file) always sink to the bottom rather than flipping with direction.
      if (av === undefined || bv === undefined) {
        if (av !== bv) return av === undefined ? 1 : -1;
      } else if (av !== bv) {
        return (av - bv) * sign;
      }
    }
    return a.name.localeCompare(b.name) * (mode === "name" ? sign : 1);
  });
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface TauriInvoke {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function tauri(): TauriInvoke | undefined {
  return (window as unknown as { __TAURI__?: TauriInvoke }).__TAURI__;
}

async function readEntryText(entry: Entry): Promise<string> {
  if (entry.text !== undefined) return entry.text;
  if (entry.file) return entry.file.text();
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

/* ------------------------------- tagging -------------------------------- */

/**
 * File tags, persisted in localStorage keyed by the file's full path where we
 * have one (desktop) and by its name otherwise. A name-only key is the honest
 * limit of the browser build: the File System Access API's handles aren't a
 * durable identifier across sessions, so two same-named files from different
 * folders share tags there.
 */
const TAG_STORE_KEY = "sketchor.fileTags.v1";

function tagKey(entry: Entry): string {
  return entry.path ?? entry.name;
}

function loadTags(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TAG_STORE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {}; // corrupt or unavailable storage — start clean rather than break the panel
  }
}

function saveTags(tags: Record<string, string[]>): void {
  try {
    localStorage.setItem(TAG_STORE_KEY, JSON.stringify(tags));
  } catch {
    // storage full or blocked: tags stay in memory for this session
  }
}

const MIME_FOR = (name: string): string =>
  /\.svg$/i.test(name) ? "image/svg+xml" : /\.dwg$/i.test(name) ? "application/acad" : "application/dxf";

/**
 * Starts a drag carrying real files out of the panel.
 *
 * Two mechanisms, because drop targets read different things and no single
 * one covers both:
 *
 * - **Real `File` objects** on `dataTransfer.items`. This is what any *web*
 *   drop target (a chat's upload box, a file input, a drag-and-drop zone)
 *   reads via `dataTransfer.files`. Without these a web target sees no files
 *   at all and falls back to whatever text it can find — which is why a drag
 *   into a chat used to paste the filename instead of attaching the drawing.
 *   Supports any number of files.
 * - **`DownloadURL`**, which is what lets a drop onto the *OS* (Explorer, the
 *   desktop) actually write a file. It's Chromium-only (WebView2 included)
 *   and carries exactly one file, so it's set only for single-file drags.
 *
 * `text/plain` is deliberately NOT set: with files present, some targets
 * prefer the text flavor and would paste a filename over attaching the file.
 */
function startFileDrag(e: React.DragEvent, files: { name: string; text: string }[]): void {
  if (files.length === 0) return;
  const dt = e.dataTransfer;
  dt.effectAllowed = "copy";

  for (const f of files) {
    dt.items.add(new File([f.text], f.name, { type: MIME_FOR(f.name) }));
  }

  if (files.length === 1) {
    const { name, text } = files[0];
    const mime = MIME_FOR(name);
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    dt.setData("DownloadURL", `${mime}:${name}:${url}`);
    // The blob has to outlive the drag; a timeout is the only hook available
    // since there's no "drop completed on the OS" event.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

const MIN_WIDTH = 160;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 240;
/** How many files' contents to pre-read so dragging works without waiting; the rest load on hover/scroll. */
const PREFETCH_COUNT = 24;

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
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<Record<string, string[]>>(loadTags);
  /** Tags currently filtering the list; empty means "show everything". */
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /**
   * File contents, cached per entry. Shared across the panel because a drag
   * starts synchronously — there's no chance to await a read once `dragstart`
   * fires, so every draggable file's text has to already be here.
   */
  const textCache = useRef(new Map<string, string>());
  const desktopDir = useApp((s) => s.fileBrowserDesktopDir);
  const activeSessionId = useApp((s) => s.activeSessionId);

  const supportsDirPicker = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
  const isDesktop = !!tauri();

  const openFolder = async () => {
    try {
      const dir = await (
        window as unknown as { showDirectoryPicker: () => Promise<{ name: string; values: () => AsyncIterable<FileSystemHandle & { kind: string; name: string }> }> }
      ).showDirectoryPicker();
      const handles: FileSystemFileHandle[] = [];
      for await (const item of dir.values()) {
        if (item.kind === "file" && isDrawingFile(item.name)) {
          handles.push(item as unknown as FileSystemFileHandle);
        }
      }
      // Metadata only (not content) — cheap enough to fetch eagerly so date-sort works; per-file content still loads lazily via IntersectionObserver.
      const list: Entry[] = await Promise.all(
        handles.map(async (handle) => {
          try {
            const f = await handle.getFile();
            return { name: handle.name, handle, mtime: f.lastModified, size: f.size };
          } catch {
            return { name: handle.name, handle };
          }
        }),
      );
      setEntries(list);
      setFolderLabel(dir.name);
    } catch {
      // user cancelled the picker
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    // Metadata only — contents are read lazily per file. Reading every picked
    // file upfront is what made adding a large library stall the app.
    const picked: Entry[] = Array.from(files)
      .filter((f) => isDrawingFile(f.name))
      .map((f) => ({ name: f.name, file: f, mtime: f.lastModified, size: f.size }));
    if (picked.length === 0) return;
    setEntries((prev) => {
      const byName = new Map(prev.map((e) => [e.name, e]));
      for (const p of picked) byName.set(p.name, p);
      return [...byName.values()];
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
        const list = (res as { name: string; path: string; mtime?: number | null; size?: number | null }[])
          .filter((e) => isDrawingFile(e.name))
          .map((e) => ({
            name: e.name,
            path: e.path,
            ...(e.mtime != null ? { mtime: e.mtime } : {}),
            ...(e.size != null ? { size: e.size } : {}),
          }));
        setEntries(list);
        setFolderLabel(desktopDir.split(/[/\\]/).filter(Boolean).pop() ?? desktopDir);
      })
      .catch(() => {
        // Best-effort: an older desktop build without the command, or a read error.
      });
  }, [desktopDir]);

  // Ctrl+F focuses the panel's own search box, while it's visible, instead of the browser's page search.
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);

  const tagsOf = (entry: Entry): string[] => tags[tagKey(entry)] ?? [];

  const setEntryTags = (entry: Entry, next: string[]) => {
    setTags((prev) => {
      const updated = { ...prev };
      if (next.length === 0) delete updated[tagKey(entry)];
      else updated[tagKey(entry)] = next;
      saveTags(updated);
      return updated;
    });
  };

  const addTagTo = (targets: Entry[], tag: string) => {
    const t = tag.trim();
    if (!t) return;
    setTags((prev) => {
      const updated = { ...prev };
      for (const entry of targets) {
        const key = tagKey(entry);
        const existing = updated[key] ?? [];
        if (!existing.includes(t)) updated[key] = [...existing, t];
      }
      saveTags(updated);
      return updated;
    });
  };

  /** Every tag in use, for the filter bar. */
  const allTags = [...new Set(entries.flatMap((e) => tagsOf(e)))].sort((a, b) => a.localeCompare(b));

  const toggleActiveTag = (tag: string) =>
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const q = query.trim().toLowerCase();
  const displayEntries = sortEntries(
    entries.filter((e) => {
      if (q && !e.name.toLowerCase().includes(q)) return false;
      // Multiple active tags narrow rather than widen (an AND, like faceted search).
      if (activeTags.length > 0 && !activeTags.every((t) => tagsOf(e).includes(t))) return false;
      return true;
    }),
    sortMode,
    sortDir,
  );

  /** Clicking a column re-sorts by it; clicking the active column flips direction. */
  const sortByColumn = (mode: SortMode) => {
    if (mode === sortMode) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortMode(mode);
      setSortDir(DEFAULT_DIR[mode]);
    }
  };

  const selectedEntries = displayEntries.filter((e) => selected.includes(tagKey(e)));

  /** Read-through accessor for an entry's text; every read populates the shared cache. */
  const textOf = (entry: Entry) => async (): Promise<string> => {
    const key = tagKey(entry);
    const hit = textCache.current.get(key);
    if (hit !== undefined) return hit;
    const text = await readEntryText(entry);
    textCache.current.set(key, text);
    return text;
  };

  const warmText = async (entry: Entry): Promise<void> => {
    try {
      await textOf(entry)();
    } catch {
      // unreadable file: leave it uncached so it's simply excluded from a drag
    }
  };

  /**
   * Warm the first screenful of files in the background.
   *
   * `dragstart` is synchronous and can't wait for a read, so a file's content
   * has to already be cached when the drag begins. Hovering warms it (and
   * hover reliably precedes a mouse drag), but prefetching the top of the list
   * means the common case of a modest folder behaves as if everything were
   * loaded, without the stall of reading a large library upfront. Reads go
   * through the same queue as thumbnails, so this never blocks the canvas.
   */
  useEffect(() => {
    const cancels = entries.slice(0, PREFETCH_COUNT).map((entry) => queueThumbnail(() => warmText(entry)));
    return () => cancels.forEach((cancel) => cancel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // Selecting files is the signal that they're about to be dragged or
  // exported, so pull their contents in now rather than at `dragstart`, which
  // is synchronous and can't wait for a read.
  useEffect(() => {
    for (const entry of entries.filter((e) => selected.includes(tagKey(e)))) void warmText(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  /**
   * The files a drag should carry: the whole selection when the dragged item
   * is part of it, otherwise just the item itself. Entries whose text hasn't
   * been read yet are dropped rather than sent empty.
   */
  const dragPayload = (entry: Entry): { name: string; text: string }[] => {
    const group = selected.includes(tagKey(entry)) ? selectedEntries : [entry];
    return group
      .map((e) => ({ name: e.name, text: textCache.current.get(tagKey(e)) }))
      .filter((f): f is { name: string; text: string } => f.text !== undefined);
  };

  const onItemDragStart = (entry: Entry) => (e: React.DragEvent) => {
    const files = dragPayload(entry);
    if (files.length === 0) {
      e.preventDefault();
      void warmText(entry); // ready for the next attempt
      return;
    }
    startFileDrag(e, files);
  };

  /**
   * Pull a file's text in as soon as the pointer touches its row/card, so the
   * content is present by the time a drag actually starts. Hovering and
   * pressing both fire well before `dragstart`.
   */
  const onItemPointerHint = (entry: Entry) => () => void warmText(entry);

  const toggleSelected = (entry: Entry, additive: boolean) => {
    const key = tagKey(entry);
    setSelected((prev) =>
      additive ? (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]) : prev.includes(key) && prev.length === 1 ? [] : [key],
    );
  };

  /** Writes the current selection out as individual files (the multi-file counterpart to dragging one out). */
  const exportSelected = async () => {
    for (const entry of selectedEntries) {
      const text = await readEntryText(entry);
      const url = URL.createObjectURL(new Blob([text], { type: MIME_FOR(entry.name) }));
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const tagSelected = () => {
    const tag = window.prompt(`Tag ${selectedEntries.length} file(s) as:`);
    if (tag) addTagTo(selectedEntries, tag);
  };

  const editTags = (entry: Entry) => {
    const next = window.prompt(`Tags for ${entry.name} (comma-separated):`, tagsOf(entry).join(", "));
    if (next !== null) setEntryTags(entry, next.split(",").map((t) => t.trim()).filter(Boolean));
  };

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

      {entries.length > 0 && (
        <div className="filexplorer-toolbar">
          <input
            ref={searchRef}
            className="filexplorer-search"
            type="search"
            placeholder="Filter… (Ctrl+F)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="file-explorer-search"
          />
          {/* The list view sorts from its column headers; the grid has none, so it keeps a compact toggle. */}
          {viewMode === "grid" && (
            <div className="filexplorer-toggle" role="group" aria-label="Sort by">
              <button
                className={sortMode === "name" ? "active" : ""}
                onClick={() => sortByColumn("name")}
                title="Sort by name"
                data-testid="file-explorer-sort-name"
              >
                Name
              </button>
              <button
                className={sortMode === "date" ? "active" : ""}
                onClick={() => sortByColumn("date")}
                title="Sort by date modified"
                data-testid="file-explorer-sort-date"
              >
                Date
              </button>
            </div>
          )}
          <div className="filexplorer-toggle" role="group" aria-label="View">
            <button
              className={viewMode === "grid" ? "active" : ""}
              onClick={() => setViewMode("grid")}
              title="Grid view"
              data-testid="file-explorer-view-grid"
            >
              <GridIcon />
            </button>
            <button
              className={viewMode === "list" ? "active" : ""}
              onClick={() => setViewMode("list")}
              title="List view"
              data-testid="file-explorer-view-list"
            >
              <ListIcon />
            </button>
          </div>
        </div>
      )}

      {allTags.length > 0 && (
        <div className="filexplorer-tagbar" data-testid="file-explorer-tagbar">
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`filetag ${activeTags.includes(tag) ? "active" : ""}`}
              onClick={() => toggleActiveTag(tag)}
              title={activeTags.includes(tag) ? `Stop filtering by "${tag}"` : `Show only files tagged "${tag}"`}
              data-testid={`file-explorer-tag-${tag}`}
            >
              {tag}
            </button>
          ))}
          {activeTags.length > 0 && (
            <button className="filetag clear" onClick={() => setActiveTags([])} data-testid="file-explorer-tags-clear">
              Clear
            </button>
          )}
        </div>
      )}

      {selectedEntries.length > 0 && (
        <div className="filexplorer-selbar" data-testid="file-explorer-selbar">
          <span>{selectedEntries.length} selected</span>
          <button className="btn ghost sm" onClick={tagSelected} data-testid="file-explorer-tag-selected">
            Tag…
          </button>
          <button className="btn ghost sm" onClick={() => void exportSelected()} data-testid="file-explorer-export-selected">
            Export
          </button>
          <button className="btn ghost sm" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="filexplorer-empty">
          {isDesktop
            ? "Open a .dxf or .svg file, or pick a folder, to browse its drawings."
            : supportsDirPicker
              ? "Use Open folder… or Add files… to browse drawings."
              : "Use Add files… to preview and open drawings."}
        </div>
      ) : displayEntries.length === 0 ? (
        <div className="filexplorer-empty">
          {query ? `No files match "${query}".` : "No files carry all of the selected tags."}
        </div>
      ) : viewMode === "grid" ? (
        <div className="filexplorer-grid" data-testid="file-explorer-grid">
          {displayEntries.map((entry) => (
            <FileCard
              key={tagKey(entry)}
              entry={entry}
              activeSessionId={activeSessionId}
              tags={tagsOf(entry)}
              selected={selected.includes(tagKey(entry))}
              onToggleSelect={(additive) => toggleSelected(entry, additive)}
              onEditTags={() => editTags(entry)}
              onDragStart={onItemDragStart(entry)}
              onPointerHint={onItemPointerHint(entry)}
              getText={textOf(entry)}
            />
          ))}
        </div>
      ) : (
        <div className="filexplorer-list" data-testid="file-explorer-list">
          <div className="filexplorer-list-head">
            <SortHeader label="Name" mode="name" active={sortMode} dir={sortDir} onSort={sortByColumn} />
            <SortHeader label="Modified" mode="date" active={sortMode} dir={sortDir} onSort={sortByColumn} />
            <SortHeader label="Size" mode="size" active={sortMode} dir={sortDir} onSort={sortByColumn} />
          </div>
          {displayEntries.map((entry) => (
            <FileRow
              key={tagKey(entry)}
              entry={entry}
              activeSessionId={activeSessionId}
              tags={tagsOf(entry)}
              selected={selected.includes(tagKey(entry))}
              onToggleSelect={(additive) => toggleSelected(entry, additive)}
              onEditTags={() => editTags(entry)}
              onDragStart={onItemDragStart(entry)}
              onPointerHint={onItemPointerHint(entry)}
              getText={textOf(entry)}
            />
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

interface FileItemProps {
  entry: Entry;
  activeSessionId: string;
  tags: string[];
  selected: boolean;
  onToggleSelect: (additive: boolean) => void;
  onEditTags: () => void;
  onDragStart: (e: React.DragEvent) => void;
  /** Called on hover/press to pre-read the file, so a drag has content ready. */
  onPointerHint: () => void;
  /** Read-through accessor for the file's text; fills the panel's shared cache. */
  getText: () => Promise<string>;
}

/** A clickable list-view column title; clicking the active one flips direction. */
function SortHeader({
  label,
  mode,
  active,
  dir,
  onSort,
}: {
  label: string;
  mode: SortMode;
  active: SortMode;
  dir: SortDir;
  onSort: (mode: SortMode) => void;
}) {
  const isActive = active === mode;
  return (
    <button
      className={`filexplorer-col ${isActive ? "active" : ""}`}
      onClick={() => onSort(mode)}
      title={`Sort by ${label.toLowerCase()}`}
      data-testid={`file-explorer-col-${mode}`}
    >
      {label}
      <span className="filexplorer-col-arrow">{isActive ? (dir === "asc" ? "▲" : "▼") : ""}</span>
    </button>
  );
}

/** Lazily renders a geometry preview once the element scrolls into view. */
function useThumbnail(
  entry: Entry,
  getText: () => Promise<string>,
  size: number,
  ref: React.RefObject<HTMLElement>,
): string | null {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let done = false;
    let cancelQueued: (() => void) | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!done && entries.some((e) => e.isIntersecting)) {
          done = true;
          observer.disconnect();
          // Reading and rasterising happens on the shared queue, so a folder
          // of hundreds of drawings fills in gradually instead of locking up
          // the app while every visible card parses at once.
          cancelQueued = queueThumbnail(async () => {
            try {
              const text = await getText();
              setSvg(fileToSvg(entry.name, text, { size, background: "#17181c", stroke: "#c7d0dc" }));
            } catch {
              setSvg(fileToSvg(entry.name, "", { size }));
            }
          });
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelQueued?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.name, size]);
  return svg;
}

function FileCard({ entry, activeSessionId, tags, selected, onToggleSelect, onEditTags, onDragStart, onPointerHint, getText }: FileItemProps) {
  const cardRef = useRef<HTMLButtonElement>(null);
  const svg = useThumbnail(entry, getText, 110, cardRef);

  const activeName = getSessions().find((s) => s.id === activeSessionId)?.name;
  const isActive = activeName === entry.name;

  const handleOpen = async () => openEntry(entry, await getText());

  return (
    <button
      className={`filecard ${isActive ? "active" : ""} ${selected ? "selected" : ""}`}
      data-testid="file-card"
      title={`Open ${entry.name}${tags.length ? ` — tagged ${tags.join(", ")}` : ""}\nCtrl-click to select · drag out to copy the file · right-click to tag`}
      onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? onToggleSelect(true) : void handleOpen())}
      onContextMenu={(e) => {
        e.preventDefault();
        onEditTags();
      }}
      draggable
      onDragStart={onDragStart}
      onPointerEnter={onPointerHint}
      onPointerDown={onPointerHint}
      ref={cardRef}
    >
      <span className="filecard-thumb">
        {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="filecard-placeholder" />}
      </span>
      <span className="filecard-name">{entry.name}</span>
      {tags.length > 0 && (
        <span className="filecard-tags">
          {tags.map((t) => (
            <span key={t} className="filetag mini">
              {t}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function FileRow({ entry, activeSessionId, tags, selected, onToggleSelect, onEditTags, onDragStart, onPointerHint, getText }: FileItemProps) {
  const rowRef = useRef<HTMLButtonElement>(null);
  // A small geometry preview, so the list is still scannable by shape and not
  // just by filename. Rendering it also warms the shared text cache, which is
  // what makes a drag out of the list work on the first attempt.
  const svg = useThumbnail(entry, getText, 22, rowRef);
  const activeName = getSessions().find((s) => s.id === activeSessionId)?.name;
  const isActive = activeName === entry.name;

  const handleOpen = async () => openEntry(entry, await getText());

  return (
    <button
      ref={rowRef}
      className={`filerow ${isActive ? "active" : ""} ${selected ? "selected" : ""}`}
      data-testid="file-row"
      title={`Open ${entry.name}${tags.length ? ` — tagged ${tags.join(", ")}` : ""}\nCtrl-click to select · drag out to copy the file · right-click to tag`}
      onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? onToggleSelect(true) : void handleOpen())}
      onContextMenu={(e) => {
        e.preventDefault();
        onEditTags();
      }}
      draggable
      onDragStart={onDragStart}
      onPointerEnter={onPointerHint}
      onPointerDown={onPointerHint}
    >
      <span className="filerow-name">
        <span className="filerow-thumb" aria-hidden="true">
          {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : null}
        </span>
        <span className="filerow-label">{entry.name}</span>
        {tags.length > 0 && (
          <span className="filecard-tags">
            {tags.map((t) => (
              <span key={t} className="filetag mini">
                {t}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="filerow-date">{formatDate(entry.mtime)}</span>
      <span className="filerow-size">{formatSize(entry.size)}</span>
    </button>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14">
      <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" fill="currentColor" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14">
      <rect x="3" y="4.5" width="18" height="2.5" rx="1" fill="currentColor" />
      <rect x="3" y="10.75" width="18" height="2.5" rx="1" fill="currentColor" />
      <rect x="3" y="17" width="18" height="2.5" rx="1" fill="currentColor" />
    </svg>
  );
}
