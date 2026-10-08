import { useMemo, useRef, useState } from "react";
import { IMPORTED_CATEGORY, PATTERN_CATEGORIES, parsePat, registeredPatterns, tileToFamilies, writePat, type PatternDef } from "@sketchor/core";
import { PatternSwatch } from "./PatternSwatch";
import { deleteUserPattern, saveUserPatterns } from "./userLibrary";

/**
 * Pattern library browser (H-06): every registered pattern by category with
 * live swatches, `.pat` import/export, and a small editor — pattern text with a
 * live preview, plus a "tile" helper that turns lines drawn in a W x H tile
 * into line families.
 */

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const order = (c: string): number => {
  const i = PATTERN_CATEGORIES.indexOf(c);
  return i < 0 ? 99 : i;
};

export function PatternLibrary({ current, onPick }: { current: string; onPick: (p: PatternDef) => void }) {
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("All");
  const [msg, setMsg] = useState("");
  const [editor, setEditor] = useState<string | null>(null);
  const [tile, setTile] = useState({ w: 10, h: 10, lines: "0,0, 6,0\n0,0, 0,10" });
  const file = useRef<HTMLInputElement>(null);
  const all = useMemo(() => registeredPatterns(), [version]);
  const cats = useMemo(() => ["All", ...[...new Set(all.map((p) => p.category ?? "Other"))].sort((a, b) => order(a) - order(b) || a.localeCompare(b))], [all]);
  const q = query.trim().toLowerCase();
  const shown = all.filter((p) => (cat === "All" || (p.category ?? "Other") === cat) && (q === "" || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
  const editParsed = editor === null ? null : parsePat(editor);
  const editDef = editParsed?.patterns[0];

  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    const defs: PatternDef[] = [];
    const issues: string[] = [];
    for (const f of Array.from(files)) {
      const r = parsePat(await f.text());
      defs.push(...r.patterns);
      issues.push(...r.issues.map((i) => `${f.name}:${i.line} ${i.message}`));
    }
    const names = saveUserPatterns(defs);
    setVersion((v) => v + 1);
    setCat(names.length ? IMPORTED_CATEGORY : "All");
    setMsg(`Imported ${names.length} pattern${names.length === 1 ? "" : "s"}${issues.length ? `, ${issues.length} problem line(s): ${issues[0]}` : ""}`);
    if (file.current) file.current.value = "";
  };

  const applyTile = () => {
    const nums = tile.lines.split("\n").map((l) => l.split(/[\s,]+/).filter(Boolean).map(Number));
    const segs = nums.filter((n) => n.length === 4 && n.every(Number.isFinite)).map((n) => ({ a: { x: n[0], y: n[1] }, b: { x: n[2], y: n[3] } }));
    const r = tileToFamilies(tile.w, tile.h, segs);
    const head = editDef ? `*${editDef.name}, ${editDef.description}` : "*TILE1, drawn tile";
    setEditor(writePat([{ name: head.slice(1).split(",")[0], description: head.split(",").slice(1).join(",").trim(), families: r.families }]));
    setMsg(r.issues.length ? r.issues.join("; ") : `${r.families.length} line famil${r.families.length === 1 ? "y" : "ies"} from the tile`);
  };

  return (
    <div data-testid="pattern-library" style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 460 }}>
      <div className="fill-row">
        <input type="search" placeholder="Search patterns" value={query} data-testid="lib-search" onChange={(e) => setQuery(e.target.value)} style={{ flex: 1 }} />
        <select value={cat} data-testid="lib-category" onChange={(e) => setCat(e.target.value)}>
          {cats.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div data-testid="lib-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, maxHeight: 220, overflowY: "auto" }}>
        {shown.map((p) => (
          <button key={p.name} className={`btn ghost ${p.name.toUpperCase() === current.toUpperCase() ? "active" : ""}`} data-testid={`lib-${p.name}`} title={`${p.name} — ${p.description}`} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: 3 }} onClick={() => onPick(p)} onDoubleClick={() => setEditor(writePat([p]))}>
            <PatternSwatch paint={{ kind: "pattern", name: p.name, scale: p.defaultScale?.mm ?? 1, angle: 0 }} width={84} height={44} />
            <span style={{ fontSize: 10 }}>{p.name}</span>
          </button>
        ))}
        {shown.length === 0 && <span className="straighten-hint">No pattern matches.</span>}
      </div>
      <div className="fill-row">
        <button className="btn ghost" data-testid="lib-import" onClick={() => file.current?.click()}>Import .pat…</button>
        <input ref={file} type="file" accept=".pat,text/plain" multiple hidden data-testid="lib-file" onChange={(e) => void importFiles(e.target.files)} />
        <button className="btn ghost" data-testid="lib-export" disabled={!all.some((p) => p.category === IMPORTED_CATEGORY || p.category === "Document")} onClick={() => download("patterns.pat", writePat(all.filter((p) => p.category === IMPORTED_CATEGORY || p.category === "Document")))} title="Export imported and drawing patterns">Export .pat</button>
        <button className="btn ghost" data-testid="lib-edit" onClick={() => setEditor(writePat([all.find((p) => p.name.toUpperCase() === current.toUpperCase()) ?? { name: "NEW1", description: "my pattern", families: [{ angle: 45, origin: { x: 0, y: 0 }, offset: { x: 0, y: 3 }, dashes: [] }] }]))} title="Duplicate and edit the selected pattern">Edit copy…</button>
        <button className="btn ghost" data-testid="lib-delete" disabled={all.find((p) => p.name.toUpperCase() === current.toUpperCase())?.category !== IMPORTED_CATEGORY} onClick={() => { deleteUserPattern(current); setVersion((v) => v + 1); }}>Delete</button>
      </div>
      {editor !== null && (
        <div className="fill-row" data-testid="lib-editor" style={{ alignItems: "flex-start" }}>
          <textarea value={editor} rows={6} cols={34} spellCheck={false} data-testid="lib-editor-text" style={{ fontFamily: "var(--mono, monospace)", fontSize: 11 }} onChange={(e) => setEditor(e.target.value)} />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {editDef ? <PatternSwatch paint={{ kind: "pattern", name: editDef.name, scale: 1, angle: 0 }} families={editDef.families} width={96} height={64} /> : <span className="straighten-hint">No valid pattern yet</span>}
            <button className="btn ghost" data-testid="lib-save" disabled={!editParsed || editParsed.patterns.length === 0} onClick={() => { const names = saveUserPatterns(editParsed!.patterns); setVersion((v) => v + 1); setMsg(names.length ? `Saved ${names.join(", ")}` : "Name is taken by a built-in pattern — rename it"); }}>Save</button>
            <button className="btn ghost" onClick={() => setEditor(null)}>Close</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }} data-testid="lib-tile">
            <span>Tile</span>
            <span>
              <input type="number" value={tile.w} style={{ width: 44 }} onChange={(e) => setTile({ ...tile, w: Number(e.target.value) })} />×<input type="number" value={tile.h} style={{ width: 44 }} onChange={(e) => setTile({ ...tile, h: Number(e.target.value) })} />
            </span>
            <textarea value={tile.lines} rows={3} cols={16} spellCheck={false} title="x1,y1, x2,y2 per line, inside the tile" onChange={(e) => setTile({ ...tile, lines: e.target.value })} />
            <button className="btn ghost" data-testid="lib-tile-make" onClick={applyTile}>Make families</button>
          </div>
        </div>
      )}
      {editParsed && editParsed.issues.length > 0 && <span className="straighten-hint">Line {editParsed.issues[0].line}: {editParsed.issues[0].message}</span>}
      {msg && <span className="straighten-hint" data-testid="lib-msg">{msg}</span>}
    </div>
  );
}
