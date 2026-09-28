# Large STEP files + Z/Y up-axis toggle — implementation plan

Handoff plan (2026-09-28). Two independent work items: **S-xx** (a large
STEP file fails to open) and **U-xx** (a Z-up / Y-up toggle in the 3D viewer).
Read `CLAUDE.md` → "3D model tabs" first; everything here builds on that
pipeline. Follow the repo's testing rules in `CLAUDE.md` → "Testing".

## The file that fails

`K:\Job Drawings\24408\24408A\SALES CAD\24408-A MASTER.STEP`

- SolidWorks 2023, `SwSTEP 2.0`, AP203 (`CONFIG_CONTROL_DESIGN`), inches.
- ~748,000 lines — roughly 60–70 MB. The largest file tested so far was 11 MB.
- 112 `NEXT_ASSEMBLY_USAGE_OCCURRENCE`, many `MANIFOLD_SOLID_BREP`s from
  patterns (`LPattern2[79]` …). Entity ids are written out of order (normal
  for SolidWorks).
- Pure ASCII (checked), so the UTF-8 read in `read_drawing_file` is *not*
  the failure — but see S-03, that path is still wrong for big files.
- **Y-up** (SolidWorks' default). The viewer assumes Z-up
  (`model3d/modelScene.ts:10`), so even once it opens it lies on its back.

Do **not** copy this file into the repo (it's company data, and the repo is
public; auto mode also blocks copying from `K:`). Open it in place.

---

## Part S — make large STEP files open

### S-00 Reproduce and measure (do this first, it picks the fixes)

1. `npm run dev` (port 5173; preview launch config `"sketchor"`).
2. In the browser pane, open the file through the app's Open (Ctrl+O) file
   picker, or read it and call `window.sketchor.openModel(name, arrayBuffer)`.
3. Record: the exact error text shown in the tab, wall time until
   failure/success, and peak wasm heap. For the heap, temporarily log
   `HEAP8.length` (or `wasmMemory.buffer.byteLength`) in `occt.worker.ts`
   after `ReadStepFile` and in a `catch`. Remove the logging afterwards.
4. Also run the text-level extractor on it:
   `cargo run --release --example verify_shell_thumb -- "<file>" out.png`
   in `native/dxf-thumbnailer` (it falls back to `native/step-wire`). If
   step-wire reads it, the file is valid and the problem is our pipeline.
5. Write the findings at the top of this doc's progress log (below).

Expected outcomes and which items they select:

| Symptom | Cause | Items |
|---|---|---|
| "import worker crashed" / `RuntimeError: memory access out of bounds` / `Aborted(OOM)` | wasm heap hit the 4 GB cap (`occt-import-js.mjs` is built with `MAXIMUM_MEMORY=4294967296`) | S-01, S-02, S-04, S-05 |
| Tab spins for minutes | just slow | S-04, S-06 |
| "not a readable STEP/IGES file" | OCCT rejected it | S-05, then investigate the entity OCCT chokes on |
| Opens in the browser but not from the desktop file browser / double-click | IPC path | S-03 |
| Opens fine but IndexedDB `putCachedModel` throws (QuotaExceeded / DataCloneError) | cache | S-07 |

### S-01 Surface the real error

`stepImport.ts:98-104` turns a worker crash into `"import worker crashed"`;
`occt.worker.ts:95` wraps OCCT exceptions. Make the message say what
happened and how big the file was, e.g.
`"Ran out of memory reading 24408-A MASTER.STEP (64 MB). …"`.
- Pass the byte length along with the job so the main thread can name it.
- Detect OOM by message (`/OOM|out of memory|memory access out of bounds|Cannot enlarge memory/i`).
- Make sure a crashed worker's queued/in-flight siblings are not affected
  (the current retire + `pump()` is right; add a test if you touch it).

### S-02 Cut peak memory in the worker

In `occt.worker.ts` `handle()`:
- After `ReadStepFile` returns, drop references to `bytes`/`req.buffer`
  before `buildModel` (the input is copied into the wasm heap; the JS copy
  is dead weight).
- `buildModel` (`model3d/buildModel.ts`) merges everything into one buffer —
  check that it doesn't hold the full `OcctResult` *and* the merged arrays
  longer than needed; null out `result.meshes[i]` as each is consumed.
- **Size-adaptive tessellation**: `TESSELLATION` is fixed at
  `linearDeflection 0.002` (bbox ratio) / `angularDeflection 0.5`. For
  inputs above ~30 MB use a coarser setting (e.g. 0.005 / 0.8). Put the
  threshold choice in a pure exported function `tessellationFor(byteLength)`
  with a unit test. Include the chosen level in the cache key
  (`modelCache.ts` `keyOf`) or bump `LAYOUT_VERSION`, so a coarse model is
  never served as a fine one later.

If S-00 shows OCCT's *read* alone exceeds 4 GB, S-02 isn't enough — go to
S-05 (fallback) and note it here; a wasm64/Memory64 rebuild of
occt-import-js is a separate, larger project (see
`native/occt-import-js-build/README.md`) — **don't start it without asking**.

### S-03 Desktop: send model bytes as binary, not base64/text

Two wasteful paths today:
- `src-tauri/src/main.rs` `emit_file` base64-encodes the whole file into
  one `open-model` event (~90 MB string for this file);
  `desktopBridge.ts:47` `atob`s it into another copy.
- `FileExplorerPanel.tsx:86-91` `readEntryBytes` for a desktop `path` entry
  goes through `read_drawing_file` (`read_to_string`, i.e. a UTF-8 string
  over JSON IPC) then `TextEncoder`s it back. That also **fails outright on
  any STEP with non-UTF-8 bytes** (Latin-1 names from SolidWorks), even
  though this particular file is ASCII.

Fix:
- New command `read_file_bytes(path) -> tauri::ipc::Response` returning
  `std::fs::read(path)` as raw bytes (arrives as `ArrayBuffer` in JS). Run it
  in `spawn_blocking` like `list_drawings_in_dir`.
- `readEntryBytes`: for `entry.path`, invoke `read_file_bytes` instead of the
  text path.
- `emit_file`: for models (and DWG), emit only `{ name, dir, path }`; the
  frontend (`desktopBridge.ts` `open-model` / `open-dwg` handlers) then calls
  `read_file_bytes(path)`. Keep accepting `base64` in the handler for one
  release for safety.
- Register the command in the `invoke_handler`, and add it to the
  capabilities/permissions file if the project uses one for commands.
- Add a Rust unit test next to the existing `write_thumbnail_cache` tests
  (non-UTF-8 bytes round-trip unchanged).
- The content hash must stay identical to the Ctrl+O path (it's the cache
  key) — raw bytes guarantee that.

### S-04 Progress for big files

The loading overlay (`useOpenLoads`) shows a phase only. Add elapsed time
and, above ~20 MB, a line like "Large file (64 MB) — this can take a few
minutes". `ModelLoad` already has `startedAt`; add `bytes`.

### S-05 Fallback: wireframe when OCCT fails

`native/step-wire` already extracts B-rep edges with assembly transforms in
~100 ms for 11 MB. Today it only runs inside the Explorer DLL. Options,
pick the cheaper:
- (a) Desktop only: a Tauri command `step_wireframe(path) -> Vec<f32>`
  (line-segment pairs) calling the `step-wire` crate (path dependency), and
  a model tab mode that renders those segments as `LineSegments`, with a
  banner "Wireframe preview — full model could not be read (reason)".
  Selection/measure disabled in that mode.
- (b) Web + desktop: port is too big — don't.

Go with (a). It needs a `Model3D` variant or a separate `DocSession` field
(e.g. `modelWire`) — prefer the separate field so `Model3D` consumers
(topology, picking, cache) don't have to handle a mesh-less model.

### S-06 Don't let a thumbnail parse compete with the open

Opening a 60 MB file from the file browser can also queue its *thumbnail*
parse. `loadModel` de-duplicates by hash, so that's one parse — good. But
the file browser may start thumbnails of *other* big files in the same
folder, each in its own worker, each up to 4 GB. Add a size cap for
thumbnail jobs (skip OCCT thumbnails above ~30 MB; show the step-wire
Explorer PNG if `%LOCALAPPDATA%\Sketchor\thumbs` has one, else a generic
icon), and while an `"open"` job > 30 MB is running, don't spawn extra
workers for thumbnails.

### S-07 Cache robustness

`putCachedModel` is awaited before posting the result
(`occt.worker.ts:108`). If it throws for a huge model, the user gets an
error for a model that parsed fine. Wrap it: on failure, log and still post
the model (uncached).

### S-08 Tests

- `tessellationFor` thresholds (pure).
- Error-message mapping for OOM / generic crash (pure function, extract it).
- `step-wire` / `read_file_bytes` Rust tests as above.
- Per CLAUDE.md, any parser touched must handle empty, truncated and
  malformed input without throwing or hanging.
- **Do not commit the 24408 file or anything derived from it.** If a large
  fixture is needed, generate one in the test (repeat a small STEP body's
  solids N times with fresh entity ids) — and keep such a test out of the
  default `npm test` run if it's slow.

---

## Part U — Z-up / Y-up toggle

### Decisions (made; change here if the user disagrees)

- **Transform the model, not the camera.** Rotate the model +90° about X
  (Y-up → Z-up: `(x, y, z) → (x, -z, y)`). View presets (Top/Front/Iso) keep
  their on-screen meaning, and `viewUp` in `modelScene.ts` stays as is.
- **Measurements read in the displayed frame**: after switching to Y-up,
  ΔZ is the on-screen height. (User was asked; default is "as displayed".)
- **Default per file from the STEP header**, overridable per file by the
  button, remembered per file hash.

### U-01 Pure core: `upAxis.ts` (model3d, tested)

```ts
export type UpAxis = "z" | "y";
/** From the first few KB of a STEP file: FILE_NAME's originating system. */
export function detectUpAxis(headerText: string): UpAxis;
/** Matrix4 elements (column-major, three.js order) that map file → display. */
export function upAxisMatrix(up: UpAxis): number[];
```
- `detectUpAxis`: `"y"` when the FILE_NAME originating-system / preprocessor
  strings match `/SolidWorks|SwSTEP/i` (also consider `/Inventor/i` — verify
  against a real Inventor export before adding; if none available, leave it
  out and note it). Anything else, IGES, or unparseable → `"z"`.
  Must never throw on empty/truncated/garbage input.
- Tests: SolidWorks header → y, Onshape header → z, empty → z, truncated
  header → z; matrix maps (0,1,0) → (0,0,1) and is orthonormal.

### U-02 Store the per-file choice

- `viewerStore.ts`: add `upAxis: UpAxis` and `setUpAxis(up)`; reset in the
  same place `modelHash` resets (line ~87).
- Persist overrides in `localStorage` under `sketchor.modelUpAxis.v1`
  (map hash → "z"|"y"), wrapped in try/catch — matches the codebase's
  manual-localStorage convention (see `keybindings.ts`). Only store when the
  user overrides; otherwise use detection.
- Detection needs the header: in `loadModel` (`stepImport.ts`) decode the
  first 4 KB of the buffer with `TextDecoder` **before** it's transferred
  to the worker, and put the detected axis on the `Model3D` (new optional
  field `detectedUp`). Adding a field to `Model3D` → bump `LAYOUT_VERSION`
  in `modelCache.ts`, and check `modelArrays`/structured-clone still work.

### U-03 Apply it in the viewer

`ModelViewport.tsx`:
- Put the matrix on the model's root group (`modelScene.ts` builds `group`
  with `mesh, edges`); set `group.matrixAutoUpdate = false` and
  `group.matrix.fromArray(upAxisMatrix(up))`, then `updateMatrixWorld`.
- Everything that reads positions must go through the same matrix:
  - **Picking** (`picking.ts`) gets a world→pixel projector from the viewer
    — include the group's matrix in that projector (vertex/edge positions
    come from topology tables in *file* space).
  - Raycasts against the mesh already respect `matrixWorld`; check the
    box-prefilter uses world-space boxes (`Box3.applyMatrix4`).
  - **Overlays** (selected edge/vertex `LineSegments`/`Points`): add them
    to the same group, or transform their positions.
  - **Measure** (`measure.ts`, pure): distances and angles are invariant;
    ΔX/ΔY/ΔZ and the returned `segment` must be in display space. Transform
    the points before calling `measureSelection` (or give it the matrix) —
    keep `measure.ts` pure and add a test that ΔZ of a Y-up model equals the
    file's ΔY.
  - Face normals/centroids shown anywhere (Structure panel, readout):
    transform normals with the rotation only.
- After toggling: bump `fitRequest` so the view refits.

### U-04 The button + shortcut

- Toolbar button in `ModelViewport.tsx` (`.model-toolbar`, ~line 789;
  follow the existing `ToolbarButton`/`ICONS` pattern and add an icon):
  label "Z up" / "Y up" showing the current state, `testId="model-up-axis"`,
  title "File was exported Y-up? Toggle which axis is up".
- Rebindable action in `keybindings.ts`: `{ id: "view.toggleUpAxis",
  label: "3D: toggle Z-up / Y-up", group: "View" }` (check an existing group
  name for the 3D viewer and use it), default binding unbound or `Shift+U`
  — check it doesn't collide with existing bindings (`Shift+U` etc. are
  used in 2D; model tabs have their own key handler, verify scope).
- Works in touch mode (toolbar tiles).

### U-05 Thumbnails

- `modelThumbnail.ts`: render with the detected/overridden axis, and
  include the axis in the thumbnail cache key so toggling regenerates it.
  On desktop, re-mirror to `%LOCALAPPDATA%\Sketchor\thumbs\<sha256>.png`
  via `write_thumbnail_cache` after a toggle.
- `native/step-wire` (Explorer fallback): apply the same header detection
  in Rust (same regex, same tests) so Explorer's wireframe preview is
  upright too. Only needed for files that don't yet have an app-rendered PNG.

### U-06 Docs

- Update `CLAUDE.md` → "3D model tabs": replace "Z is up." with the new
  rule (detect from header, per-file override, transform lives on the model
  group, picking/measure go through it).
- Add the feature to `README.md`'s 3D viewer section.
- `docs/testing-plan.md`: mark what's covered.

---

## Order of work

1. S-00 (reproduce) — record findings below.
2. U-01 … U-04 can proceed in parallel with S; they don't depend on it.
3. S-01, S-03, S-07 (cheap, always worth it).
4. S-02 / S-04 / S-06 per S-00's findings; S-05 if OCCT still can't read it.
5. U-05, U-06, S-08 wrap-up.
6. `npm test` and `npm run build` must pass; verify live in the dev server
   with the real 24408 file (open, toggle Y-up, measure an edge, check the
   Top view looks down on the model). On desktop, verify double-click and
   the in-app file browser both open it.

Don't release/tag — other sessions release in parallel; leave versioning
to the user (see the release procedure in the user's notes / README).

## Progress log

- 2026-09-28 — plan written; nothing implemented. Root cause of the
  failure not yet confirmed (S-00 pending).

- 2026-09-28 — S-00 done. **The failure is not OOM and not slowness —
  it's a content-extraction bug, and the decision table above doesn't
  cover it.** Repro: served the file from its K:\ folder over a throwaway
  local HTTP server (CORS-enabled `http.server`, not copied into the repo
  or committed anywhere) and fed it to `window.sketchor.openModel` in the
  dev server tab.

  - Error shown: **"the file contains no solid or surface geometry to
    show"** (`occt.worker.ts` `model.parts.length === 0` branch) — not
    "import worker crashed", not "not a readable STEP/IGES file".
  - Wall time to fail: **~13–15 s**, not minutes.
  - Peak wasm heap (logged temporarily, `HEAP8.length` right after
    `ReadStepFile` returns): **2,147,483,648 bytes (2 GiB)** — well under
    the 4 GiB `MAXIMUM_MEMORY` cap. `ReadStepFile` returns
    `success: true`. So OCCT itself found **zero shapes** to tessellate;
    this isn't memory pressure.
  - Tried coarsening tessellation (`absolute_value` deflection instead of
    `bounding_box_ratio`) as a quick test — same "no solid geometry"
    result, same ~13–15 s. Rules out a deflection/tessellation-parameter
    cause. (Change was temporary, not committed — `occt.worker.ts` is back
    to its original `TESSELLATION`.)
  - Cross-checked with the *other*, independent STEP reader in this repo:
    `native/step-wire`'s `step_wire::parse` (a from-scratch text parser,
    nothing shared with OCCT) **also returns 0 segments**, in 1.3 s
    (`cargo run --release --example render_step`). Two unrelated
    implementations failing the same way on the same file is a strong
    signal the problem is in the file's content/structure, not in either
    reader's size handling.
  - The file itself looks structurally ordinary, not truncated: properly
    closed (`ENDSEC;` / `END-ISO-10303-21;` present), and has plenty of
    the entities both readers need — 1338 `MANIFOLD_SOLID_BREP`, 1338
    `CLOSED_SHELL`, 464 `SHAPE_REPRESENTATION`, 100
    `SHAPE_DEFINITION_REPRESENTATION`, 70
    `ADVANCED_BREP_SHAPE_REPRESENTATION`, 213 `PRODUCT_DEFINITION_SHAPE`,
    112 `NEXT_ASSEMBLY_USAGE_OCCURRENCE` / `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`,
    zero `MAPPED_ITEM`/`REPRESENTATION_MAP` (every pattern instance is a
    full geometry copy, not an instanced reference — consistent with the
    file's size). AP203/`CONFIG_CONTROL_DESIGN`, SolidWorks 2023, as
    already noted above.
  - **What this means for the rest of the plan**: S-01 (surface the real
    error), S-03 (binary IPC), S-04 (progress), S-07 (cache robustness)
    are still worth doing regardless. But S-02 (memory/tessellation cuts)
    and S-05 (wireframe fallback *because OCCT can't read it*) were scoped
    for an OOM/reject failure this file doesn't actually have — S-05's
    fallback is still worth building since step-wire independently also
    can't currently extract this file either, but as a *product* feature
    that degrades gracefully, not as a fix. **Not yet found**: why two
    independent STEP readers both recover zero geometry from a
    structurally normal-looking assembly. Next step would be isolating a
    minimal reproducible subset (e.g. a script that pulls one
    `MANIFOLD_SOLID_BREP`'s transitive entity closure — geometry, its
    `SHAPE_DEFINITION_REPRESENTATION`/`PRODUCT_DEFINITION` chain, header —
    into a standalone `.step` file and seeing whether *that* opens) to
    find what specifically both readers choke on; not done yet, and it's
    a bigger investigation than "reproduce and measure" — flagging for
    the user before continuing.
- 2026-09-28 — Root-cause investigation, continued (user asked to keep going).
  **Found and fixed the `step-wire` half of it.** `parse_entities` tokenized
  the whole file correctly (737,180/737,180 entities, verified with a
  temporary debug example), but every *classification* step
  (`PRODUCT_DEFINITION_SHAPE` → PD, `SHAPE_DEFINITION_REPRESENTATION` → its
  representation, `NEXT_ASSEMBLY_USAGE_OCCURRENCE` → parent/child,
  `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`, `SHAPE_REPRESENTATION_RELATIONSHIP`)
  came back with **zero** entries. Root cause: `find_type()`
  (`native/step-wire/src/lib.rs`) required the entity's argument list to
  open *immediately* after its name (`bytes[at + name.len()] == '('`) — no
  whitespace tolerance. This file (and apparently SolidWorks exports
  generally) write `TYPE (args)` with a space before the parenthesis, which
  is legal EXPRESS syntax; every hand-authored test fixture in this crate
  happened to use `TYPE(args)` with no space, so the bug was never
  exercised. Fixed by skipping ASCII whitespace between the name and `(`
  before checking for it (`native/step-wire/src/lib.rs`, ~3 lines). After
  the fix: `pds_def=213 nauo=112 cdsr=112`, one clean root, 133 placed
  instances, **254,946 wireframe segments**, rendered and visually
  confirmed as real geometry (a curved decking/frame assembly, matching
  the file's own name). Added a regression test
  (`tolerates_a_space_before_the_argument_list`) using the existing
  `cube()` fixture with `TYPE ( args )` spacing; all 11 tests pass; no new
  clippy warnings. This fixes the *existing* Explorer-thumbnail fallback
  (`native/dxf-thumbnailer` → `native/step-wire`) for this whole class of
  file, not just something S-05 would add.

  **The wasm/OCCT side is still unresolved** and needs a different,
  bigger next step. Ruled out: OOM (2 GiB/4 GiB), tessellation deflection
  parameters (tried `absolute_value` too, same result), and shape
  enumeration returning empty — traced into the vendored
  `occt-import-js` C++ source (`native/occt-import-js-build/src/occt-import-js/src/importer-xcaf.cpp`):
  `ImporterXcaf::LoadFile` explicitly returns `ImportFailed` when
  `shapeTool->GetFreeShapes()` is empty, and we observed `success: true`
  from JS, so that list is *not* empty — OCCT does find at least one root
  product. Sketchor's own `LabelIndex` patch (`patch_importer.py`) only
  touches name/colour *lookups*, not which shapes get meshed, so it's an
  unlikely culprit. That leaves the actual tessellation
  (`BRepMesh_IncrementalMesh`, inside `XcafShapeMesh::EnumerateFaces`'s
  `TopExp_Explorer` walk) or the mesh→JS serialization in
  `js-interface.cpp` as the remaining suspects — both upstream, unpatched
  OCCT/occt-import-js code. Confirming which needs an **instrumented
  rebuild** of the vendored wasm (add a debug print in
  `importer-xcaf.cpp`, rebuild via `native/occt-import-js-build/build.ps1`
  — the cached `build/` tree and `emsdk/` are present locally, so this
  should be an incremental rebuild of one translation unit, not the full
  ~10 min from-scratch build). That's a materially bigger, slower step
  than anything done so far — it touches the actual wasm binary the whole
  app depends on — so pausing here to check with the user before doing
  it, in the same spirit as this doc's existing note not to start a
  wasm64 rebuild without asking.

  Also worth double-checking once inside that rebuild: `occt.worker.ts`
  always passes `linearUnit: "millimeter"` to `ReadStepFile` regardless of
  the source file's own declared unit (this file is inches per its
  header). That's very likely fine — OCCT should read the file's own
  `LENGTH_UNIT`/`(CONVERSION_BASED_UNIT ...)` and convert into the target
  unit — but it's an unverified assumption worth a five-minute check
  before spending time elsewhere, since it's the one parameter Sketchor's
  own code chooses per-call rather than something upstream/fixed.

  Repo state: `native/step-wire/src/lib.rs` has the real fix + test,
  committed nowhere yet (uncommitted in the working tree). No debug
  scaffolding left behind (the temporary `debug_stats`/`debug_parse`
  functions and example were added, used, and removed in this session).
  Nothing was copied from K:\ — the C++ investigation only read files
  already present in `native/occt-import-js-build/src/`.

- 2026-09-28 — **Root cause found and fixed on the wasm/OCCT side too**
  (user asked to go ahead with the instrumented rebuild). Added temporary
  `EM_ASM` debug prints at each decision point in
  `importer-xcaf.cpp`/`importer-utils.cpp`, rebuilt incrementally (a few
  seconds each time — the cached `build/`/`emsdk/` made this cheap, not
  the ~10 min from-scratch build), and traced it step by step:
  - `ImporterXcaf::LoadFile`'s `GetFreeShapes` check: not empty (1 free
    top-level product found) — ruled out.
  - `XcafRootNode::GetChildren`: found that one free child,
    `TriangulateShape` on its whole-assembly compound succeeded
    (`IsDone=1`, bbox avgSize≈5674mm, linDeflection≈11.3mm) — ruled out.
  - Recursing into the tree: the root's one child had 20 sub-components
    (`XcafNode::GetChildren`), each correctly classified `IsMeshNode()`
    (leaf), each with real solids (4 to 138 per leaf, 969–2841 faces) —
    structure all correct.
  - **The actual bug**: `XcafNode::EnumerateMeshes` fetches its own shape
    fresh via `shapeTool->GetShape(label)` and enumerates it directly —
    every single leaf came back with **0 of 969–2841 faces having
    triangulation**, despite `TriangulateShape` having already run (once)
    on the top-level assembly compound. Triangulating the root's compound
    does not reliably leave triangulation reachable from each leaf's own
    independent `GetShape()` call on this file (58 MB, no
    `MAPPED_ITEM`/`REPRESENTATION_MAP` — every occurrence a separate
    geometry copy, per S-00's original findings) — this is exactly why
    changing tessellation parameters earlier made no difference: the
    leaves were never being (re-)triangulated at all, regardless of
    deflection settings.
  - **Fix**: call `TriangulateShape (shape, params)` in
    `XcafNode::EnumerateMeshes` too, on the leaf's own shape, right before
    enumerating it (threading `params`/`ImportParams` through `XcafNode`,
    same pattern as the existing `LabelIndex`/`index` threading).
    `BRepMesh_IncrementalMesh` checks and skips a shape that's already
    correctly meshed, so this costs nothing on files where the root-level
    triangulation already propagated down (i.e. every file that worked
    before). Result on the real file: **1,366 parts, 546,061 triangles**
    — opens correctly, bounding box 7647.666 × 457.2 × 8909.426 mm.
  - **Made it permanent correctly**: `native/occt-import-js-build/src/`
    (the checked-out upstream + patched sources) is git-ignored — editing
    the live checkout would not have persisted the fix. The real,
    version-controlled fix lives in `native/occt-import-js-build/patch_importer.py`
    (`TRIANGULATE_LEAF_FIX`, 4 new replacement entries, applied after the
    existing `LabelIndex` patch since they operate on text it already
    produced). Verified this is correct without an expensive full re-clone:
    simulated the new replacement rules in Python against the exact
    pre-fix text (captured earlier in this session) and confirmed the
    output matches the manually-edited, browser-verified working version
    byte-for-byte, for both call sites (`XcafRootNode::GetChildren` and
    `XcafNode::GetChildren` share the one `make_shared<XcafNode>(...)`
    pattern the rule fixes).
  - **Verification of the final state**: restored the upstream checkout
    to pristine (`git checkout` inside the nested `occt-import-js` clone,
    which has its own `.git`), re-ran `patch_importer.py` fresh (no manual
    edits, no debug code), rebuilt, and re-tested in the browser — same
    result (1,366 parts / 546,061 triangles), clean console (no stray
    debug output, no errors). `npm test` — 858/858 pass. Vendored
    `apps/web/vendor/occt-import-js/{.wasm,.mjs}` are updated and
    committed-ready (binary diff is tiny, +39 bytes wasm / +18 bytes glue
    — consistent with a few added lines of C++).
  - **Both bugs are now understood and fixed**: `step-wire`'s whitespace
    intolerance (native fallback / Explorer thumbnails) and OCCT's
    leaf-triangulation gap (the main wasm import pipeline). Neither was
    about file size, memory, or a corrupt/invalid STEP file — both were
    latent bugs in how each reader's *assembly traversal* handles a file
    shaped like this one (huge, flat, fully-duplicated-geometry
    SolidWorks export with `NAME (args)` spacing). The file itself was
    valid all along.
  - Not yet done: the `occt.worker.ts` `linearUnit: "millimeter"`
    hardcoding question (flagged above) — now moot for *this* bug, but
    still an open, unverified assumption worth a five-minute look
    separately. Also not done: S-01 through S-08 and Part U of this plan
    are all still pending — this session only closed out S-00's root
    cause. The Y-up/Z-up mismatch (Part U) is still live: the model opens
    correctly now but lies on its back until U-01…U-04 land.

  - Unrelated bug noticed in passing, not part of this plan: `native/dxf-thumbnailer`'s
    `examples/verify_shell_thumb.rs` fails with `SHCreateItemFromParsingName:
    ... cannot find file specified` for *any* file on a mapped network
    drive (K: here is `\\shape-jbsvr-01\cad-server`). Likely cause:
    `canonicalize()` turns the path into `\\?\UNC\server\share\...` and
    the code only strips the `\\?\` prefix (line ~34), leaving
    `UNC\server\share\...` — not a valid path (needs the leading `\\`).
    Worked around here by using the `render_step` example instead (reads
    the file directly via `std::fs`, no shell API). Doesn't block
    anything above since Explorer itself resolves paths differently, but
    worth a fix if anyone tries to verify a thumbnail for a file on a
    network share with this tool again.
