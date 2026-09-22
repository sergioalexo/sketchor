# CLAUDE.md

Sketchor — parametric 2D CAD sketcher. Web-first (React + Vite + Canvas2D),
desktop via Tauri 2, designed for AI integration. `README.md` is thorough — read
it for features, file formats, controls, and the roadmap. This file captures what
isn't obvious from the README: how things are wired and how to build/run them.

## Repo layout (npm workspaces)

```
packages/core        framework-free document model, command bus, DXF/SVG/DWG IO, geometry analysis (pure TS)
apps/web             React UI + custom Canvas2D viewport
apps/web/src/model3d STEP/IGES viewer: OpenCascade wasm in a worker pool, three.js, IndexedDB cache
apps/web/src-tauri   Tauri 2 desktop shell (Rust); same UI as a native app
native/dxf-parse     dependency-free Rust DXF parser + fit-to-box projection (shared)
native/step-wire     dependency-free STEP wireframe extractor (B-rep edges + assembly transforms, no kernel)
native/dxf-thumbnailer   Windows Explorer thumbnail COM shell extension for DXF + STEP/IGES (Rust)
native/dxf-quicklook     macOS Finder Quick Look thumbnail extension (.appex; Rust FFI + Swift)
```

## The one architectural rule

The document is **only ever mutated through serializable `Command` values**
(`add-entity`, `move-entities`, `add-constraint`, `batch`, …). `CommandBus`
(`packages/core/src/commands.ts`) applies them, derives inverses for undo/redo,
and notifies subscribers. Tools, the future constraint solver, and the future AI
assistant are all just command producers — none get privileged access. Anything
that changes the drawing must go through a Command.

AI-facing surface: the two-way sketch text (`packages/core/src/sketchtext.ts`),
reachable at runtime as `window.sketchor.toCode()` / `applyCode(text)`.
`param`/`constraint`/`dim` keywords are reserved for the not-yet-built
parametric layer (`packages/core/src/constraints.ts` is a data-model scaffold; no
solver yet).

## Build & run

```bash
npm install
npm run dev        # web app at http://localhost:5173
npm run build      # build @sketchor/core then @sketchor/web
npm run desktop    # Tauri dev window (needs Rust toolchain)
```

Rust: if `cargo` isn't on PATH in a shell, `source "$HOME/.cargo/env"` first.

### Desktop release build (macOS, local)

The committed config sets `createUpdaterArtifacts: true`, which needs the
minisign signing key. For a local build without the key, disable it:

```bash
cd apps/web
npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
# -> apps/web/src-tauri/target/release/bundle/macos/Sketchor.app
```

`tauri.conf.json` is cross-platform. Windows-only bundle settings (NSIS target,
the `.dll` resource, the PowerShell `beforeBuildCommand`) live in
`tauri.windows.conf.json`, which Tauri auto-merges on Windows. macOS-specific
Info.plist keys live in `apps/web/src-tauri/Info.plist` (Tauri merges it).

The Rust shell (`src-tauri/src/main.rs`) is fully cross-platform: it emits opened
files to the UI (DXF/SVG as text, DWG and STEP/IGES as base64) and exposes
`list_drawings_in_dir` / `read_drawing_file` / `write_drawing_file` commands.

## 3D model tabs (`apps/web/src/model3d/`)

A STEP/IGES file opens as a *view-only* tab: `DocSession.model` is set (with
`modelLoading`/`modelError` while it isn't yet) and `App.tsx` swaps the
`Viewport` for the lazily-loaded `ModelViewport`. Nothing goes through the
command bus — there is no document behind a model tab and nothing to save.

The pipeline is built for one fact measured on real Onshape exports:
**reading the STEP dominates and tessellation density barely matters**
(0.7 MB → ~0.7 s, 3 MB/1,700 parts → ~3 s, 6 MB/3,000 parts → ~4.5 s in
wasm). Those numbers are with **Sketchor's own build of occt-import-js**
(`apps/web/vendor/occt-import-js/`, reproducible from
`native/occt-import-js-build/`): the upstream npm package looked up every
face's colour with a linear scan of all labels, O(faces × parts), which
made the same files take 28 s and 93 s. Don't reinstall the npm package —
the worker imports the vendored `.mjs`/`.wasm` directly. So:

- `occt.worker.ts` runs occt-import-js; `stepImport.ts` is a pool of up to
  three workers with a queue where *opens* preempt *thumbnails*, and requests
  for identical bytes share one parse.
- `buildModel.ts` (pure, tested) merges every mesh into **one** vertex/index
  buffer plus a part table of ranges, and bakes vertex colours. Hiding works
  on those ranges — two draw calls for any assembly, and picking is
  box-prefiltered + `drawRange`-scoped raycasts.
- `topology.ts` (pure, tested) recovers the **B-rep** from the tessellation:
  `brep_faces` tags give faces; a welded triangle edge shared by two
  *different* faces is a B-rep edge; those segments chain into edges (a
  junction or an open end ends a chain), each chain is fitted to a line,
  circle or arc, and chain endpoints become vertices. Faces carry
  area/perimeter/centroid/normal/planarity, parts carry area and volume.
  Everything is flat typed arrays (`FaceTable`/`EdgeTable`/`VertexTable`),
  so a model still structured-clones out of the worker and into IndexedDB.
- `modelCache.ts` persists models and thumbnails in IndexedDB keyed by
  `LAYOUT_VERSION:sha256(bytes)`; bump `LAYOUT_VERSION` whenever `Model3D` or
  the extraction changes. LRU-evicted past 768 MB.
- `modelThumbnail.ts` renders the file-browser's isometric PNG through one
  shared offscreen WebGL context (browsers cap live contexts).
- Z is up. View presets live in `modelScene.ts`.
- **Selection is Onshape's**: a click picks the topology under the cursor —
  vertex, then edge, then the face the ray hit (`picking.ts`, pure: the
  viewer passes a world→pixel projector, so the search is testable without a
  camera). Shift/Ctrl adds, up to 8. `measure.ts` (pure, tested) turns the
  selection into the bottom-right readout: one pick gives length, diameter,
  area or volume, two give distance and angle. `viewerStore.ts` (zustand)
  holds selection/hover/hidden so the canvas and the Structure panel drive
  the same state; `StructurePanel.tsx` is the assembly tree, which replaces
  the Layers panel in a model tab (layers mean nothing to a STEP file).
  Highlighting: faces/parts repaint the shared colour attribute, edges and
  vertices go into overlay `LineSegments`/`Points` with `depthTest: false`.
- **Measure tool** (M): a second, free-point measurement for anywhere a
  topology pick can't reach. `measure3d.ts` (pure, tested) snaps a raycast
  hit to the hit part's B-rep vertices/edges within a pixel tolerance the
  viewer converts to world units at the hit depth; the viewer draws the
  result as a screen-space SVG overlay re-projected in an `afterRender`
  hook, not via React state per frame.
- **Explorer previews** (Windows): every rendered thumbnail is also mirrored
  via the `write_thumbnail_cache` command to `%LOCALAPPDATA%\Sketchor\thumbs\<sha256>.png`; `native/dxf-thumbnailer` (`src/model.rs`) hashes the file
  and serves that PNG, else falls back to `native/step-wire` — a text-level
  B-rep edge extractor that resolves NAUO/CDSR/ITEM_DEFINED_TRANSFORMATION
  placements and MAPPED_ITEMs (both rep_1/rep_2 orderings seen in the wild
  are handled by matching against the child's representations). The DLL
  registers `.dxf .step .stp .iges .igs` (`EXTENSIONS` in lib.rs). Verify
  end-to-end with `cargo run --release --example verify_shell_thumb -- file.step out.png`;
  the shell caches by path+mtime, so test a fresh copy after changing a sidecar.
- **Two Explorer gotchas that cost a release (0.14.2):** (1) Explorer keeps
  the DLL mapped, so an installer can't overwrite it — the NSIS pre-install
  hook renames it to `.old` first; `DllCanUnloadNow` counts live instances so
  Explorer can drop the idle old module. (2) **Windows 11 Explorer only
  consults a thumbnail handler for an extension if
  `HKLM\Software\Classes\<ext>\ShellEx\{E357FCCD-…}` exists** (value may even
  be empty; the CLSID resolves from HKCU). `IShellItemImageFactory` and the
  `LocalThumbnailCache` service from any other process do NOT have this
  rule, which is why every probe passed while Explorer showed icons. DXF
  only worked on the dev PC because eDrawings had left that key. The
  per-user installer asks for elevation once (skipped when silent), and
  `desktop/explorerPreviews.ts` asks at launch when the markers are missing
  (on by default; declines respected for a week; never mid-update) via the
  `explorer_previews_status` / `enable_explorer_previews` commands — one
  `regedit /s` import of a generated .reg file, so the UAC dialog reads
  "Registry Editor". To see what Explorer
  actually asks the DLL, create an empty `%LOCALAPPDATA%\Sketchor\thumb-debug.log`
  — every request is appended (opt-in trace in lib.rs).

Debug: `window.sketchor.openModel(name, arrayBuffer)` / `getModel()`.

## Tools (`apps/web/src/tools/`)

Drawing tools are state machines on the framework in `tools/tool.ts`
(`Tool`: `prompt/busy/anchor/cancel/pick/doubleClick?/key?/preview`), one
instance each in `tools/index.ts`; `Viewport.tsx` decodes input (object
snap → ortho/polar tracking → typed coordinates → touch deferral) and hands
the tool finished `Pick`s, draws `preview()` dashed, and shows `prompt()`
in the status bar. Tools not yet migrated (select, measure, text, image,
fill, straighten, dim, pan) still run as `case`s in `Viewport.tsx`'s
pointer handlers — `getTool()` returns null for those. Migrating one means
moving its case into a class and deleting its `interaction` kind.

Typed input has two front ends and one back end: the floating coordinate
box (digits open it) and the docked command line (`tools/commandLine.ts`
parses, `tools/CommandBar.tsx` types, `runCommand` in `Viewport.tsx`
executes). Both commit through `commitTypedText`, which asks the tool to
read the string itself (`typed()` — an angle for rotate, a factor for
scale) before resolving it as a coordinate against the tool's anchor, or
against the **relative zero** (the last point any tool placed) when the
tool has none.

Where a point lands is a pipeline, and its order is load-bearing:
object snap (`viewport/snapping.ts`) → ortho/polar from the tool's anchor
(`tools/tracking.ts`) → object snap tracking (`viewport/objectTracking.ts`,
T-20) → raw cursor. A feature snap the cursor actually touched always wins,
as in AutoCAD; tracking only replaces the fall-through result. Hovering a
feature point acquires it (three deep, newest first), and `trackAlignment`
returns the projection — or, when two acquired alignments cross near the
cursor, their intersection. All three stages are pure and tested;
`resolvePick` in `Viewport.tsx` is the only place that sequences them.

Selection lives in `packages/core` too, so the rules are testable without a
canvas: `boxSelect.ts` (window/crossing rectangles), `polygonSelect.ts`
(lasso polygons, fence strokes, entity outlines, path thinning) and
`selectFilter.ts` (select-similar and Quick Select). `Viewport.tsx` only
supplies the gesture and the candidate list. Every selection path — click,
box, lasso, fence, Ctrl+A, select-similar — goes through
`selectableEntities()` in `state/store.ts`, which drops hidden **and locked**
layers; a new path that calls `doc.all()` directly is a bug (it would let a
click grab geometry the user locked).

Geometry the editing tools stand on, all in `packages/core` and tested:
`intersect.ts` (entity → `Path` of segment/arc curves, `intersectCurves`,
`trimAt`/`splitAt`/`extendTo`, `entityFromPath`), `fillet.ts`, `offset.ts`
(signed left-offset per curve + re-joining; the join heuristics — drop
inverted legs, drop anti-parallel slot walls, bridge collinear seams —
are the 95 % case, not a full self-intersection cleanup). Tools in
`tools/editTools.ts` only pick and commit `delete + add` batches.

Rules for a new tool (roadmap T-00):
1. Geometry math is a pure function in `packages/core` with a test
   (`arcs.ts` is the model). The tool only collects picks and calls it.
2. Emit `Command`s through `ctx.execute`/`ctx.commit` — never mutate entities.
3. `anchor()` is what relative typed input (`@dx,dy`, a bare length) and
   ortho/polar measure from; return null for a pick that must not be
   constrained (a 3-point arc's on-arc pick).
4. Tool-local keys go in `key()`, which runs before the global bindings —
   but only consume a key while `busy()`, or you steal a tool shortcut
   (polyline's A/T/L are only live mid-polyline; the arc tool cycles modes
   with Tab for the same reason). Digits, `@`, `-`, `.` open the typed
   coordinate box (`typedInput.ts`) and are never tool keys.
5. `cancel()` must leave the tool idle; Esc calls it, then falls back to
   the select tool as before.

`docs/sketching-tools-roadmap.md` is the backlog (T-xx ids); its progress
log at the top says what's done.

## Touch (`apps/web/src/touchMode.ts`)

Gestures work everywhere, regardless of the setting: in the 2D viewport one
finger is the tool (its pointerdown is *deferred* until the finger moves,
lifts, or is joined — a pinch always starts with one finger down, and the
tools act on pointerdown), two fingers pan/pinch-zoom from any tool and keep
a half-drawn entity like a middle-drag pan does, double-tap fits. The 3D
viewer's touch handling is OrbitControls plus tap/double-tap/long-press.
**Touch mode** is only layout: a persisted preference (default: the
`pointer: coarse` media query, toggle in the topbar) that puts `.app.touch`
on the root — the tool rail moves to the bottom as big labelled buttons, and
so does the model toolbar. A "pan" tool exists so one finger can pan too.

## Testing

```bash
npm test                                        # vitest, whole workspace
npx vitest run packages/core/src/dxf.test.ts    # one file
npx vitest                                      # watch
```

Tests live next to the code they cover (`foo.ts` -> `foo.test.ts`), never in a
separate tree. `vitest.config.mts` aliases `@sketchor/core` and
`@sketchor/plugin-sdk` to their TypeScript *sources*, so tests exercise exactly
what the app builds; both tsconfigs are `include: ["src"]`, so `npm run build`
typechecks the tests too.

The environment is `node`. Code touching a browser API opts in per file with a
`// @vitest-environment jsdom` docblock on line 1 — only `svg.test.ts` does, for
`DOMParser`. Don't switch the global environment to accommodate one test.

`docs/testing-plan.md` is the running survey: what is covered, what isn't, and
which tier each gap sits in. Update its status when you close one out.

### What a new feature has to cover

- **A new `Command` type** must be added to the `CASES` table in
  `commands.test.ts`. That table drives the execute/undo/redo round-trip across
  every command type, and a command missing from it is a command whose inverse
  nothing checks — the one failure mode that corrupts a drawing silently.
- **A new entity field** (e.g. `LineEntity.infinite`) has to be considered in
  `renderer.ts`, `intersect.ts`'s `pathOf`, both exporters, and `sketchtext.ts`'s
  `diffToCommands` (the DSL can't express it, so an edit must carry it over).
- **A new entity type** needs `translated`/`rotated`/`transformed` preserving
  id/name/layer/colour/fill, a sketch-code round-trip (`toCode` -> `parseCode` ->
  `diffToCommands` updating in place with the same id), and DXF + SVG round-trips.
- **Any change to an IO module** (`dxf`, `dxfExport`, `svg`) needs a *round-trip*
  test, not a golden string: write it, read it back, compare geometry. Assert on
  file text only for what a round-trip can't see — header variables, the layer
  table, the numeric formatting convention.
- **A scan-and-fix module** (`heal`, `duplicates`, ...) needs the idempotence
  property: apply every fix, rescan, get nothing, and a second pass must not
  oscillate. Also assert that undoing the fix batch restores the document.
- **Anything parsing a user-supplied file** must be tested against empty,
  truncated and structurally malformed input. It has to return a result — never
  throw, never fail to terminate. Both defects this suite has uncovered so far
  were this shape — an unbounded loop in an SVG path, a stack overflow on a
  group cycle — and neither was reachable from the UI's happy path.

### Conventions

- Open each test file with a short docblock saying *why this code is worth
  testing* — what breaks in a user's drawing if it regresses, not what the
  functions are named.
- Compare document state order-insensitively (sort by id). Undoing a delete
  re-inserts the entity at the end of the `Map`, so insertion order is not an
  invariant; identity and content are.
- Prefer a property to a literal: "every point moved by the same offset", "the
  curve is unchanged", "the rescan is empty". Literals are for pinning a format
  (a DXF group code, an SVG attribute), not geometry.
- Give `toBeCloseTo` a precision you can justify. DXF coordinates round to six
  decimals *in file units*, so the millimetre tolerance depends on the drawing's
  declared unit — assert against that bound rather than guessing an epsilon.
- When a test pins behaviour that is lossy or surprising (sketch code drops
  polyline bulges; SVG export renders a point as a dot; a clockwise DXF arc comes
  back counterclockwise), say so in the test name and a comment, so the next
  reader knows it is intended and not a bug to "fix".

## Native geometry-thumbnail extensions

Both platforms preview DXF geometry on the file icon, sharing one renderer:

- `native/dxf-parse` is the single source of truth: `parse(&str) -> Vec<Shape>`
  (Line + Circle; arcs/polylines flattened to segments) and
  `project(shapes, size, pad)` (fit-to-box, Y-flip). Colors match everywhere:
  background `#1E1F22`, stroke `#C7D0DC`/`#dfe1e5`, ~10% padding.
- **Windows** (`native/dxf-thumbnailer`): a Rust COM `IThumbnailProvider` DLL,
  built/staged by `native/build-shell-extensions.ps1`, installed per-user via
  `install-thumbnailer.ps1`. Standalone crate; path-depends on `dxf-parse`.
- **macOS** (`native/dxf-quicklook`): a `QLThumbnailProvider` `.appex`. Rust FFI
  (`ffi/`, a `staticlib` over `dxf-parse`) does parse+project; Swift
  (`Sources/`) strokes with Core Graphics. Built **without Xcode** (swiftc +
  codesign) by `build-quicklook-macos.sh`; see `native/dxf-quicklook/README.md`.

### macOS Quick Look: build → embed → test

Tauri can't bundle an `.appex`, so it's embedded after `tauri build`:

```bash
native/dxf-quicklook/build-quicklook-macos.sh              # -> build/DxfThumbnail.appex
native/embed-quicklook-macos.sh /path/to/Sketchor.app     # inject + re-sign
```

Gotchas that cost real time:
- **Not testable via `tauri dev`.** Quick Look only discovers an extension inside
  a Launch-Services-registered app — so build, embed, put the app in
  `/Applications`, launch once.
- **Exact-UTI match required.** macOS has no built-in DXF type; the host app
  exports `com.sketchor.dxf` (`src-tauri/Info.plist`) and the extension lists that
  exact string in `QLSupportedContentTypes`. Verify with
  `mdls -name kMDItemContentType file.dxf`.
- **Retina:** the drawing context is `maximumSize × scale` pixels. `DxfRender`
  sizes from `ctx.width`/`ctx.height` and flattens the CTM so it fills the whole
  thumbnail (getting this wrong renders it small in the bottom-left corner).
- **Stale extension:** after re-embedding, `qlmanage -r && qlmanage -r cache`,
  then `pkill -f DxfThumbnail; killall quicklookd Finder` — macOS caches the old
  extension binary otherwise.
- Inspect the renderer without registering anything:
  `native/dxf-quicklook/render-sample.sh drawing.dxf out.png 512`.

Status: macOS support is arm64-only and ad-hoc signed. Universal (`lipo`) build,
Developer ID signing + notarization, and a spacebar `QLPreviewProvider` are
follow-ups. The Windows crate can only be compiled on a Windows target — verify
`dxf-thumbnailer` there (CI `release.yml`) after touching `dxf-parse`.
