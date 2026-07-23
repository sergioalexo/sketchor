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
| Circle tool | `C` — click center, then a point on the circle |
| Select tool | `V` — click (Shift adds), drag to move, `Del` deletes |
| Pan | middle- or right-button drag |
| Zoom | mouse wheel (at cursor) |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |

Snapping is automatic: endpoints, midpoints, centers, quadrants, then grid.

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
```

Every entity has a stable handle (`L1`, `C1`, ...). Editing is a *diff*:
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

- **DXF** — read/write (`packages/core/src/dxf.ts` + `dxfExport.ts`).
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

On Windows, `native/dxf-thumbnailer/` is a Rust COM shell extension that makes
Explorer render a **preview of the geometry** — not just the app icon — as the
`.dxf` file thumbnail (and, when installed elevated, in the reading pane).
Install it per-user with `native/dxf-thumbnailer/install-thumbnailer.ps1`.

## Roadmap

1. **More geometry** — arcs, polylines, rectangles; trim/extend/offset.
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
