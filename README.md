# Sketchor

Modern parametric 2D sketching — web-first, desktop-capable, designed for AI integration from day one.

## Run it

```bash
npm install
npm run dev        # web app at http://localhost:5173
npm run desktop    # native desktop window via Tauri (needs Rust toolchain)
```

## Controls

| Action | Input |
|---|---|
| Line tool | `L` — click points to chain, `Esc` to finish |
| Polyline tool | `W` — click each vertex; `Enter` or double-click finishes, `C` closes the shape, `Backspace` undoes a vertex |
| Circle tool | `C` — click center, then a point on the circle |
| Select tool | `V` — click (Shift adds), drag to move, `Del` deletes |
| Measure tool | `M` — see below |
| Pan | middle- or right-button drag |
| Zoom | mouse wheel (at cursor) |
| Save / Save As | `Ctrl+S` overwrites the tab's own file; the Save menu names that file and offers Save As / Save a Copy |
| Close tab | `Ctrl+W` (desktop only — browsers reserve it for their own tab) |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |

Snapping is automatic, in priority order: **the origin**, endpoints, centers,
quadrants and **intersections**, then midpoints, then the nearest point
**along** a line/segment, then the grid.

The world origin is drawn as a crosshair with labelled +X / +Y stubs (and a
muted marker clamped to the edge when it's panned off-screen), so `0, 0` is
always locatable and there's something to aim at when snapping.

**Moving snaps the geometry, not the cursor.** Dragging a selection with the
select tool aligns the selection vertex nearest where you grabbed onto
whatever snap target you drag near — so grabbing a corner and dropping it by
the origin lands it exactly on `0, 0`. Hold `Alt` while dragging for a free,
unsnapped move. The grid is deliberately excluded, since quantising every
drag would make free positioning impossible.

### Patterns

The pattern panel repeats the current selection in a **grid** (columns/rows
plus spacing) or **around a circle** (count, sweep angle, centre, and whether
copies rotate to follow the arc). A full 360° sweep divides by the instance
count rather than count−1, so it doesn't stack a duplicate on the original.

Copies are ordinary independent entities added in a single undoable step —
there's no live array object linking them back to the source, so each copy is
editable afterwards like anything else.

### Measure tool

A plain click measures point-to-point using the snaps above. The modifiers
cover whole-entity and reference measurements:

| Action | Input |
|---|---|
| Distance between two points | click, then click |
| Whole length / radius of one entity | `Alt`-click it (arcs also report arc length) |
| Running total across lines *and* arcs | `Shift`+`Alt`-click each one |
| Area **and perimeter** of a closed region | click inside it |
| Angle relative to a chosen edge | `Ctrl`-click a line to set the reference |
| Keep a measurement on screen | `Enter` (up to 5 pinned) |
| Copy the readout | `Ctrl+C` |

## Architecture

```
packages/core     framework-free document model + command bus (TypeScript)
apps/web          React + Vite UI, custom Canvas2D viewport
apps/web/src-tauri  Tauri 2 shell -> same UI as a local desktop app
```

The one rule that everything else hangs on: **the document is only ever
mutated through serializable `Command` values** (`add-entity`,
`delete-entities`, `move-entities`, ...). The `CommandBus` applies them,
derives inverses for undo/redo, and notifies subscribers. Tools, the future
constraint solver, and the future AI assistant are all just command
producers — none of them get special access.

Try it in the browser console: `window.sketchor.bus.execute({...})`.

## Sketch code (the text view)

The right-hand panel is a **two-way text representation** of the drawing.
Drawing on the canvas regenerates the code; editing the code and pressing
**Apply** (or `Ctrl+Enter`) turns your edit into ordinary undoable commands.

```
sketch v1

line L1 from (0, 0) to (100, 0)
line L2 from (100, 0) to (100, 60)
circle C1 at (50, 30) r 15
polyline PL1 pts (0, 0) (40, 0) (40, 30) closed
```

Code doesn't express a polyline's per-segment arc bulge (just as it doesn't
express layers) — both are preserved through an edit rather than lost, but a
bulged segment reads as straight in the text.

Every entity has a stable handle (`L1`, `C1`, `PL1`, ...). Editing is a *diff*:
matching names are updated in place (keeping their identity and undo
history), new names are added, and dropped names are deleted — so an edit
that changes one number moves exactly one entity.

This is the surface designed for AI agents. Instead of manipulating opaque
objects, an agent reads `window.sketchor.toCode()` and writes back with
`window.sketchor.applyCode(text)`, which returns line-level parse errors
(`[{ line, message }]`) if the text is invalid and leaves the drawing
untouched. Same grammar for humans and models.

The grammar reserves three keywords for the parametric layer, already
rejected with a clear message so files stay forward-compatible:

```
param width = 40           # named variable
constraint tangent L1 C1   # geometric relationship
dim L1 length = width      # driven/driving dimension
```

## File formats

Sketchor has no proprietary file format — everything is a standard interchange
format:

- **DXF** — read/write (`packages/core/src/dxf.ts` + `dxfExport.ts`). Reads
  LINE, CIRCLE, ARC, POINT, ELLIPSE, LWPOLYLINE/POLYLINE (including bulged
  arc segments), SPLINE, TEXT/MTEXT, and **INSERT** — block references are
  expanded with their insertion point, scale, rotation and row/column arrays,
  including blocks nested inside other blocks. Geometry drawn on layer `0`
  inside a block inherits the layer the block was placed on, as CAD expects.
- **SVG** — read/write, dimensionally accurate 1:1 world units
  (`packages/core/src/svg.ts`).
- **DWG** — read-only, via a GPL-3.0 WebAssembly build of GNU LibreDWG (see
  `apps/web/src/browser/dwgImport.ts` and `/NOTICE.md`). There is no DWG
  export.

Use the **Open** button (or `Ctrl+O`) to load any of the three; **Save**
(`Ctrl+S`) offers a choice of DXF or SVG. The File System Access API is used
in the browser and in Tauri's WebView2, with a download / file-input fallback
elsewhere. Opening a file that's already open in a tab switches to that tab
(and reloads it) instead of opening a duplicate.

### The file browser

The left panel browses a folder of drawings as geometry thumbnails, and
filters as you type (`Ctrl+F`). Reading and rendering previews runs on a
queue that yields to the browser between files, so opening a large library
fills in progressively instead of freezing the app — the drawing already open
stays editable throughout.

**It is built for folders of thousands.** Only the cards near the viewport
exist as elements; the rest are stand-in padding, so the scrollbar still
measures the whole folder while the page holds a few dozen nodes instead of
ten thousand. Row height and column count are measured from a real card rather
than hardcoded, because the cards are square and follow the panel's draggable
width. That does mean every item has to be the same height — long names and
the tag strip clip rather than wrap, and in a folder where anything is tagged
every card reserves the tag row. On the desktop the folder scan runs on a
blocking-pool thread, not the one pumping window events, and a spinner shows
while it works. The **list view** shows a small preview plus
Name / Modified / Size columns — click a column title to sort by it, click it
again to reverse. (The grid view has no headers, so it keeps a compact
name/date toggle.)

Files can be **tagged** (right-click one, or select several and use **Tag…**);
the tag chips along the top filter the list, and multiple active tags narrow
rather than widen. Tags persist in `localStorage`, keyed by full path on the
desktop build and by filename in the browser — the File System Access API's
handles aren't a durable identifier across sessions, so in the browser two
same-named files from different folders share tags.

**Dragging files out** of the panel copies them to another app — a chat's
upload box, a file input, Explorer, the desktop. Dragging an item that's part
of the current selection drags the whole selection; dragging an unselected one
drags just it.

Two mechanisms are attached to the drag, because drop targets read different
things: real `File` objects (what any *web* drop target reads, and what makes
a drag into a chat attach the drawing instead of pasting its name), plus
Chromium's `DownloadURL` protocol, which is what lets a drop onto the *OS*
write a file. `DownloadURL` carries only one file, so it's attached to
single-file drags only; a multi-file drag still works into web targets, and
**Export** writes a selection out directly.

On Windows, `native/dxf-thumbnailer/` is a Rust COM shell extension that makes
Explorer render a **preview of the geometry** — not just the app icon — as the
`.dxf` file thumbnail (and, when installed elevated, in the reading pane).
Install it per-user with `native/dxf-thumbnailer/install-thumbnailer.ps1`.

On macOS, `native/dxf-quicklook/` does the same for Finder: a Quick Look
thumbnail extension (`.appex`) that renders `.dxf` geometry onto the file icon.
It shares the DXF parser and fit-to-box projection with the Windows thumbnailer
via a common Rust crate (`native/dxf-parse/`), so the two previews match. It
ships inside `Sketchor.app` (embedded after `tauri build` by
`native/embed-quicklook-macos.sh`, since Tauri can't bundle an app extension
itself); see `native/dxf-quicklook/README.md`.

## Saving

A tab remembers the file it came from, whichever way it got there — the Open
dialog, the in-app file browser, or a double-click in Explorer — so `Ctrl+S`
writes straight back to that file with no prompt. The Save button's menu names
it (`Save to bracket.dxf`) so it's clear what's about to be overwritten, and
sits above **Save As DXF/SVG** (prompts, and rebinds the tab to the new file)
and **Save a Copy** (prompts, but leaves the tab on its original file).

A drawing that has no file yet says so — the menu reads *Not saved to a file
yet* and Save opens the location prompt, pre-filled with the tab's name.

Two write paths back the same behaviour: a File System Access handle where the
file was picked through a dialog, and the `write_drawing_file` Tauri command
where the desktop build only has a native path (its folder browser and the
`.dxf` file association both hand over paths, not handles). DWG is import-only,
so a DWG tab stays unbound and Save falls through to a prompt.

## Updates

The desktop app updates itself. It checks a few seconds after launch, and any
time you press the download button in the toolbar; when there's something
newer, a banner offers **Update now**, which downloads the installer with a
progress bar, verifies its signature, installs it and relaunches Sketchor.

Releases are signed with a minisign keypair. The public half is baked into
`tauri.conf.json`; the private half lives only in this machine's
`~/.sketchor-keys/` and in the repo's `TAURI_SIGNING_PRIVATE_KEY` Actions
secret, and `release.yml` uses it to sign the installer and publish the
`latest.json` the app polls. **Losing the private key means shipping a new
installer by hand**, since existing installs will reject anything signed with a
different key.

The web build has no installer to swap, so it falls back to the public GitHub
Releases API and offers the download page instead — the same fallback the
desktop app uses if `latest.json` can't be reached.

## Roadmap

1. **More geometry** — rectangles; trim/extend/offset. (Arcs and polylines are
   done: a polyline is one entity with optional per-segment arc bulge, so an
   imported spline or polyline selects as a single object rather than N
   segments.)
2. **Parametric constraints** — integrate `planegcs` (FreeCAD's 2D
   constraint solver, compiled to WASM, available on npm). Constraints
   (coincident, parallel, tangent, dimensions) become part of the document;
   a `solve` step runs after each command and emits `move/replace` commands.
   The `param`/`constraint`/`dim` keywords are already reserved in the sketch
   grammar so this layer is purely additive.
3. **AI assistant** — a chat panel backed by the Claude API with tool
   definitions that emit `Command[]` proposals ("draw a 40x20 slot centered
   on the origin"). Proposals render as dashed previews; the user accepts or
   rejects. The command log doubles as conversation context.
4. **Rendering scale-up** — swap the Canvas2D renderer for WebGPU behind the
   same `render()` interface once drawings get large.

## License

[GNU AGPL v3.0](LICENSE) or later.
