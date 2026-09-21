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
| Polyline tool | `W` — click each vertex; `A` makes the next leg an arc (through-point, then end), `T` a tangent arc, `L` back to straight; `Enter` or double-click finishes, `C` closes the shape, `Backspace` undoes a vertex |
| Circle tool | `C` — click center, then a point on the circle (or type the radius); `Tab` cycles center-diameter, two-point, three-point and tangent-tangent-radius (type the radius, click two entities) |
| Rectangle tool | `R` — two corners; `Tab` cycles center + corner and three-point (rotated) |
| Polygon / Slot tools | Polygon: type the number of sides, center + vertex (`Tab`: circumscribed — across flats — or by edge). Slot: two centres then the width, or `Tab` for an arc slot (center, start, end, width) |
| Arc tool | `A` — three-point (start, end, point on the arc); `Tab` cycles to center-start-end and tangent-continuation |
| Move / Copy / Rotate / Scale / Mirror | `Shift+M` / `Shift+D` / `Shift+R` / `Shift+S` / `Shift+I` — select first (or click the object), then follow the status-bar prompt: base point and destination, pivot and angle (typed or two directions), base and factor or reference length, two axis points. `Ctrl`-click the last point to copy instead of modify (mirror: to delete the source) |
| Trim / Split | `Shift+T` click the piece to remove (everything visible cuts); `Shift`-click near an end to extend it to the next boundary · `Shift+B` click where to cut |
| Fillet / Chamfer / Offset | `Shift+F` type a radius (0 = sharp corner join), click two lines on the halves to keep, or click a polyline corner (`Enter` rounds every corner of the selected polylines) · Chamfer: type a distance, two lines · `Shift+O` type a distance, click the entity, click the side |
| Typed coordinates | while drawing, type `100` (length toward the cursor), `100<45`, `50,20`, `@50,20` — units like `4in`, `2'6"` accepted |
| Ortho / polar | `F8` / `F10` (or the status-bar toggles); `Shift` held is temporary ortho |
| Select tool | `V` — click (Shift adds), drag to move, `Del` deletes |
| Measure tool | `M` — see below |
| Pan | middle- or right-button drag, the Pan tool, or two fingers |
| Zoom | mouse wheel (at cursor), or pinch |
| Save / Save As | `Ctrl+S` overwrites the tab's own file; the Save menu names that file and offers Save As / Save a Copy |
| Close tab | `Ctrl+W` (desktop only — browsers reserve it for their own tab) |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |
| Copy / Cut / Paste | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` (at the cursor) / `Ctrl+Shift+V` (in place) / `Ctrl+D` (duplicate) — the clipboard holds readable sketch code, so a copy pastes into a chat or editor too |
| Nudge | arrow keys move the selection one grid step; `Shift` = ten |
| Select all / invert | `Ctrl+A` / `Ctrl+I` |
| Join / Explode | `J` chains the selected lines and arcs into one polyline (closed when the ends meet); `Ctrl+E` explodes selected polylines back into lines and arcs |
| Divide | Divide tool: type a count (or a spacing like `25mm`), click an entity — points mark the divisions |
| Zoom window / previous | `Z` then two corners / `Shift+Z` |

Snapping is automatic, in priority order: **the origin**, endpoints, centers,
quadrants, **intersections** (any two curves), nodes, and — measured from the
point you just placed — **perpendicular** feet and **tangent** points; then
midpoints; then the nearest point **along** a line, arc or circle; then a
line's **extension** past its end (with a dashed guide); then the grid. The
**SNAP** button in the status bar switches kinds on and off.

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
- **STEP / IGES** — 3D models, **view-only**, in their own tab. Read by
  OpenCascade compiled to WebAssembly (Sketchor's own build of
  `occt-import-js`, LGPL — see `/NOTICE.md` and
  `native/occt-import-js-build/`) and drawn with three.js. A 3,000-part
  assembly opens in a few seconds. See *3D models* below.

Use the **Open** button (or `Ctrl+O`) to load any of these; **Save**
(`Ctrl+S`) offers a choice of DXF or SVG. The File System Access API is used
in the browser and in Tauri's WebView2, with a download / file-input fallback
elsewhere. Opening a file that's already open in a tab switches to that tab
(and reloads it) instead of opening a duplicate.

### 3D models (STEP / IGES)

Opening a `.step`/`.stp` (or `.iges`/`.igs`) file gives a 3D viewer tab
instead of a drawing: shaded parts in the colours the file carries, B-rep
edges drawn as dark outlines, orbit with the left mouse button, pan with the
right or middle, wheel to zoom toward the cursor. Click a part to select it
(its name shows in the corner readout), double-click to frame it, `H` hides
the selected part and `Shift+H` shows everything again; `E` toggles edges,
`F` fits, and `1`–`4` jump to isometric / top / front / right. The **Parts**
button opens the assembly tree, with a filter and per-part hide/show. With
a part selected, the readout shows its bounding-box size.

**Measure** (`M`, or the toolbar button): click or tap two points on the
model to get the straight-line distance plus ΔX / ΔY / ΔZ. Each point snaps
to the nearest corner (B-rep vertex) or edge under the cursor, so aiming
roughly at a corner measures the corner; the readout says which kind of
point each end landed on. The measurement stays attached to the geometry
while you orbit; `Esc` clears it, then leaves the tool.

On a touch screen: one finger orbits, two fingers pinch-zoom and pan, tap
selects, double-tap frames, and a long-press hides the part under your
finger (Show all brings it back). Buttons grow to finger size, and on a
narrow stage the parts tree docks as a bottom sheet.

### Touch mode

The hand button in the top bar turns on **touch mode**: the drawing tools
move to a row of big labelled buttons along the bottom of the screen (where
a thumb can reach them), and the 3D viewer's buttons do the same. It's on
by default on devices that report a touch pointer and remembered either
way. Independently of the setting, the 2D canvas understands fingers: one
finger works the current tool (tap = click, drag = drag), two fingers pan
and pinch-zoom from any tool without losing a half-drawn line, and a
double-tap fits the drawing (or the tapped entity). The **Pan** tool makes
one finger pan instead.

The file browser lists model files next to drawings and previews each one as
an **isometric thumbnail**.

What to expect for speed: reading a STEP file is the slow part (it's a B-rep
that has to be tessellated — a few hundred KB opens in about a second, a
3 MB assembly of ~1,700 parts in under half a minute, a 10 MB one in a
couple of minutes) and it runs in a pool of background workers, so the app
stays responsive and several previews load in parallel. The result is
**cached** (IndexedDB, keyed by a hash of the file's bytes, up to ~768 MB)
along with the thumbnail, so any file you have looked at once — opened, or
merely browsed past — comes back instantly afterwards.

On Windows, **Explorer shows previews for model files too**, through the
same shell extension that previews DXF: for any model Sketchor has rendered
once (opened, or browsed past) it's the exact shaded isometric picture;
for a STEP file it has never seen, a wireframe read straight from the file's
edges — assembly placements resolved — so the icon still shows the shape.
Opening the file upgrades the icon to the shaded version. Windows needs a
one-time administrator approval before Explorer will consult the handler
for a file type: the installer asks for it, and if that was skipped (or the
update arrived silently) Sketchor asks at its next launch — one "Registry
Editor" prompt, then never again. Declining is respected for a week.

There is no SAT or Parasolid support: those are proprietary kernels with no
open-source reader. Export STEP from the source CAD instead (Onshape does).

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
so a DWG tab stays unbound and Save falls through to a prompt. A 3D model tab
has nothing to save at all — Save just says so.

## Updates

The desktop app updates itself, without being asked. It checks a few seconds
after launch, and any time you press the download button in the toolbar; when
there's something newer it downloads the installer with a progress bar in the
banner, verifies its signature, installs it and relaunches into the new
version. Uncheck **Update automatically** in the toolbar's update popover to go
back to being asked first.

Installing closes Sketchor, so the automatic install only goes ahead while
every tab is saved. With unsaved work open the download finishes and then
waits, and the banner offers **Restart now** once you've saved — the update is
already on disk, so that restart is immediate.

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
