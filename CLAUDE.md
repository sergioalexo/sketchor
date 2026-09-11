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
(0.7 MB → ~1 s, 3 MB/1,700 parts → ~27 s, 11 MB/3,400 parts → ~130 s in
wasm). So:

- `occt.worker.ts` runs occt-import-js; `stepImport.ts` is a pool of up to
  three workers with a queue where *opens* preempt *thumbnails*, and requests
  for identical bytes share one parse.
- `buildModel.ts` (pure, tested) merges every mesh into **one** vertex/index
  buffer plus a part table of ranges, bakes vertex colours, and extracts
  B-rep edges (welded triangle edges shared by two *different* faces).
  Selection/hide in the viewer work on those ranges — two draw calls for any
  assembly, and picking is box-prefiltered + `drawRange`-scoped raycasts.
- `modelCache.ts` persists models and thumbnails in IndexedDB keyed by
  `LAYOUT_VERSION:sha256(bytes)`; bump `LAYOUT_VERSION` whenever `Model3D` or
  the extraction changes. LRU-evicted past 768 MB.
- `modelThumbnail.ts` renders the file-browser's isometric PNG through one
  shared offscreen WebGL context (browsers cap live contexts).
- Z is up. View presets live in `modelScene.ts`.
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
