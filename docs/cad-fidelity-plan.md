# CAD Fidelity Plan — curves, blocks, hatching, dimensions, layouts, modern DXF, embeds, themes

**Goal:** make Sketchor clearly better than LibreCAD in four places a working drafter notices within an hour: **blocks, hatch patterns, dimension styles, and DXF write fidelity**. Along the way, finish the parametric roadmap, add true splines/ellipses, paper-space layouts, more preview formats (EPS + 3D), a drop-in **embeddable animated preview**, and **themes as plugins**.

Written 2026-09-28 against `main` @ `8bafb82` (v0.28.0). Intended to be executed item by item by another model/developer. Every item has an ID; reference it in commit messages (`B-04: block editor`) and tick it off in the progress log below.

### Progress log

| Date | Items | Notes |
|---|---|---|
| — | — | nothing started |

---

## 0. Rules for whoever executes this plan

Read these before touching anything. They come from this repo's history; most were learned the hard way.

1. **Read `CLAUDE.md` and `README.md` first.** The one architectural rule holds for every item here: the document changes *only* through serializable `Command`s on `CommandBus` (`packages/core/src/commands.ts`). Block definitions, hatch patterns, dim styles, layouts and themes-applied-to-a-document are all document data → all need commands with inverses.
2. **Pure core first.** Geometry, parsing, writing, evaluation go in `packages/core` as pure functions with a `*.test.ts` next to them. UI in `apps/web` only collects input and emits commands. `arcs.ts` / `intersect.ts` are the model to copy.
3. **New entity types are a landmine field.** Adding a type touches ~23 files. Compiler-enforced exhaustive `switch`es fail the build (good); `if/else` chains with a bare final `else` do *not* (bad — v0.6.0 had five of them assuming "arc"). Use the checklist in **Z-01** for every new type. Also update the Rust `.sketchor` reader (`native/sketchor-shell/src/model.rs`) so unknown/new types are skipped, not fatal.
4. **Don't run prettier.** There is no prettier config; running it reformats to 80 cols and produces huge diffs.
5. **Tests:** `npm test` (vitest, node env). Browser-only code opts in per file with `// @vitest-environment jsdom`. `npm run build` typechecks tests too — run it before every commit.
6. **Verify live** for anything visible: `npm run dev` (port 5173, launch config `sketchor`), drive it via `window.sketchor` + real pointer events. Re-screenshot before every canvas click (the topbar hint wraps and shifts layout per tool; after `resize_window` never reuse old coordinates).
7. **One commit per item**, subject `ID: summary`. Update this file's progress log in the same commit.
8. **Do not bump versions, tag, or release** unless the user asks. Other sessions release in parallel — if asked to release, `git pull` first, follow the release procedure in memory/README (four version files + `cargo update -p sketchor --offline`), never chain a tag push after `;`.
9. **Licensing:** the app is GPL-3.0 (LibreDWG). Don't copy AutoCAD's `acad.pat`/`acadiso.pat` or LibreCAD's pattern/`.lff` files verbatim — see H-03. MIT/BSD/Apache/LGPL deps are fine; record each in `NOTICE.md`.
10. When a decision below is marked **(decided)**, don't relitigate it. When marked **(open)**, pick the recommendation unless the user says otherwise, and note it in the log.

---

## 1. Where we are vs LibreCAD, and what "beat" means

| Area | Sketchor today | LibreCAD 2.2.x (verify on install) | Target — measurable |
|---|---|---|---|
| Splines / ellipses | Imported, then **tessellated** to 128–200-pt polylines; no tools | Native spline (degree 1–3, control pts) and ellipse/elliptic arc | Native NURBS + ellipse entities, fit-point *and* CV spline tools, exact DXF round-trip (knots/weights preserved bit-for-bit within 1e-9) |
| Blocks | INSERT **expanded** on import; groups only | Static blocks, block list, edit block, insert; attributes weak; no dynamic blocks | Live definitions + instances, block editor with live update, attributes w/ edit dialog, nested blocks, library panel from folders/DXFs, **dynamic blocks** (stretch/flip/visibility/lookup/array/rotate) **and parametric blocks** (constraints + named params) — LibreCAD has neither |
| Hatch | Solid colour fill on a closed polyline/circle | Pattern hatch from its own library, solid fill | Associative hatch with islands, ≥ 60 named patterns + `.pat` import, gradients, pattern-library panel with live previews, user/plugin patterns, exact pattern lines in DXF (other CAD shows identical hatch) |
| Dimensions | `dim` tool draws loose lines + text in a group | Dimension entities, one global dim setting set | `DimensionEntity` (9 kinds) that is also a driving constraint, **named dimension styles** with overrides, tolerances, alt units, leaders/multileaders, MTEXT, text styles, GD&T frames |
| Paper space | none (print = one sheet of model) | print preview only | Layouts with title-block blocks, multiple scaled viewports, per-viewport layer freeze, annotative scale, PDF plot per layout |
| DXF write | **R12 (AC1009)**, lines/circles/arcs/LWPOLYLINE, images → placeholder | libdxfrw, R2007-ish | **AC1032 (R2018)** default + R12 fallback: real BLOCK/INSERT/ATTRIB, HATCH with pattern data, DIMENSION + DIMSTYLE + anonymous `*D` blocks, MTEXT, LEADER/MULTILEADER, LTYPE, lineweights, true colour, LAYOUT/VIEWPORT, IMAGE/IMAGEDEF. **Passes `ezdxf audit` with zero errors** and opens clean in LibreCAD, ODA/Teigha viewer and (if available) AutoCAD/DWG TrueView |

**Scorecard (X-12)** is the proof: a corpus of drawings exercising each area, written by Sketchor, reopened by Sketchor/ezdxf/LibreCAD, with the numbers recorded in `docs/dxf-fidelity-scorecard.md`.

---

## 2. Build order and dependencies

```
Phase 0  Foundation       Z-01 entity-kind registry · Z-02 document v3 + tables · Z-03 theme tokens · X-01 DXF writer core · X-02 audit harness · Z-04 linetypes/lineweights
Phase 1  Curves           C-01..C-09  (ellipse, spline)                         needs Z-01
Phase 2  Blocks           B-01..B-10  (static blocks, attributes, library)      needs Z-01, Z-02, X-01
Phase 3  Hatching         H-01..H-10                                             needs Z-01, Z-02, X-01 (C for spline/ellipse edges)
Phase 4  Dims + annot.    D-01..D-12  (incl. T-42)                               needs Z-02, X-01, B-01 (dims write *D blocks)
Phase 5  Constraints      T-43..T-46, K-01..K-03                                 needs D (T-42 lands in D-02)
Phase 6  Dynamic blocks   B-20..B-27                                             needs B + Phase 5
Phase 7  Layouts          L-01..L-09                                             needs B (title blocks), D (annotative), X-01
Phase 8  Formats/previews F-01..F-10  (EPS, STL/OBJ/3MF/glTF/PLY/BREP/3DM)       independent — can run in parallel from Phase 1
Phase 9  Embed widget     E-01..E-10                                             needs Z-03, F (for formats it shows)
Phase 10 Themes plugins   TH-01..TH-08                                           needs Z-03 only — can run in parallel from Phase 1
Always   DXF              X-03..X-12 land *with* each feature, not at the end
```

Tracks that can run in parallel once Phase 0 is in: **Curves → Blocks → Dynamic blocks**, **Hatching**, **Dims → Constraints → Layouts**, **Formats → Embed**, **Themes**.

Sizes: S ≤ ½ day, M ≈ 1–2 days, L ≈ 3–5 days, XL > 1 week (split before starting).

---

## 3. Phase 0 — Foundation

### Z-01 · Entity-kind registry — **P0, L**
Seven new entity types are coming (`ellipse`, `spline`, `insert`, `hatch`, `dimension`, `mtext`, `leader`, later `viewport`). Adding each by hand across ~23 files is how the "bare `else` = arc" bugs happened.

- Create `packages/core/src/kinds/` with an `EntityKind<E>` interface: `bounds`, `transform(e, m)` (affine incl. mirror/non-uniform scale where meaningful, else `null` → caller explodes/approximates), `tessellate(e, tol)` → `Point[][]` (the universal fallback), `path(e)` → `Path` for `intersect.ts` (optional), `snaps(e)`, `grips(e)`, `hitDistance(e, p)`, `solverParams(e)` (optional).
- Register existing seven types by moving their existing code (no behaviour change). Generic consumers (`boundsOf`, box/lasso select, `entityPoints`, nearest-snap, PDF/SVG fallback rendering, thumbnails, nest `extractParts`) call the registry; anything without a specialisation falls back to `tessellate`. **A new kind then works "approximately everywhere" on day one** and gets exact handling where it matters.
- Keep TS exhaustive `switch`es where they add value (sketchtext, DXF writer) but add `assertNever` defaults so a missing case is a compile error, not a silent branch.
- Write `docs/new-entity-checklist.md`: every file/spot a new type must visit (list from `grep -rn "case \"image\"" packages apps`), including `native/sketchor-shell/src/model.rs`, `native/dxf-thumbnailer`, `plugin-sdk` read model, `clipboard.ts`, `sketchtext.ts`, `svg.ts`, `entitiesPdf.ts`, `grips.ts`, `stretch.ts`, `mirror.ts`, `snapping.ts`, `renderer.ts`, `Viewport.tsx` hitTest, `solver/model.ts`, `PropertiesPanel.tsx`.
- **Accept:** all 633+ tests pass unchanged; a throwaway test registers a dummy kind with only `tessellate` and it can be selected, snapped (nearest), exported to SVG/PDF and bounded.

### Z-02 · Document v3 + named tables — **P0, M**
`toJSON()` is `{version: 2, entities, groups, constraints}`. Add **tables**: `blocks`, `dimStyles`, `textStyles`, `linetypes`, `hatchPatterns` (only those used/customised — library patterns are referenced by name), `layouts`, plus `settings` (`$INSUNITS`, current dimstyle/textstyle, `LTSCALE`, `annotationScale`). Layers already exist in the store — move their persisted form into the document tables here too (keep the store API).
- New commands with inverses: `put-table-record {table, record}` / `delete-table-record {table, name}` / `rename-table-record` (renames rewrite references in one batch).
- `fromJSON` migrates v1/v2 → v3. Rust `model.rs` must ignore unknown top-level keys and unknown entity types.
- **Accept:** round-trip tests; v2 fixture files load unchanged; undo/redo of table edits.

### Z-03 · Theme tokens (renderer + 3D + UI) — **P0, S/M**
`renderer.ts` has a hard-coded `COLORS` object (`bg #17181c`, `entity #e8e9ec`, …); `styles.css` already uses `--bg/--panel/--text/--accent…` on `:root`. Unify:
- `packages/core/src/theme.ts`: `ThemeTokens` type = `{ ui: {bg, panel, border, text, textDim, accent, accentSoft, danger, …}, canvas: {bg, gridMinor, gridMajor, axis, entity, selected, preview, snap, hover, measure, reference, …}, model3d: {bg, grid, edge, faceDefault, highlight, hover}, code: {keyword, number, comment, error}, fonts?: {ui, mono} }` + `DEFAULT_DARK` (today's values, byte-identical) + a new `DEFAULT_LIGHT`.
- `apps/web/src/theme/themeStore.ts` (zustand, `localStorage` `sketchor.theme.v1`, manual load/save per repo convention) applies `ui.*` as CSS variables on `document.documentElement` and exposes `canvas.*` to `renderer.ts` (replace every `COLORS.x` read); `ModelViewport` reads `model3d.*`. Entities with explicit `color` keep it; *default* entity colour becomes a token (DXF colour 7 = "black on white, white on black" — do the same inversion on light themes).
- Topbar/settings: Dark / Light / System.
- **Accept:** screenshot diff of dark theme vs before = identical; light theme usable (grid visible, selection readable, 3D viewer readable).

### X-01 · Modern DXF writer core (AC1032) — **P0, L**
Rewrite `dxfExport.ts` into `packages/core/src/dxfw/`:
- `DxfWriter` with a **handle allocator** (hex handles, `$HANDSEED`), owner pointers (`330`), subclass markers (`100 AcDbEntity`, `AcDbLine`, …), `5` handles on everything.
- Sections: `HEADER` (`$ACADVER AC1032`, `$INSUNITS`, `$MEASUREMENT`, `$EXTMIN/MAX`, `$LTSCALE`, `$DIMSTYLE`, `$TEXTSTYLE`, `$CLAYER`, `$HANDSEED`), `CLASSES`, `TABLES` (VPORT, LTYPE, LAYER, STYLE, VIEW, UCS, APPID incl. `SKETCHOR`, DIMSTYLE, BLOCK_RECORD), `BLOCKS` (`*Model_Space`, `*Paper_Space` + user blocks), `ENTITIES`, `OBJECTS` (root dictionary, `ACAD_GROUP`, `ACAD_LAYOUT` with `Model`/`Layout1`, `ACAD_MLEADERSTYLE`, `ACAD_PLOTSETTINGS` as needed).
- Entity writers for today's types: LINE, CIRCLE, ARC, POINT, LWPOLYLINE (bulges, closed, constant width), TEXT (with `STYLE` reference), IMAGE + IMAGEDEF + IMAGEDEF_REACTOR (writes the PNG next to the DXF as `<name>_img1.png`; ask for a folder handle on web, native path on desktop — replaces today's placeholder box).
- Per-entity: layer, true colour (`420`) when it isn't an ACI match else `62`, linetype (`6`), lineweight (`370`), `SKETCHOR` XDATA (`1001 SKETCHOR`) carrying the entity's stable `name` and anything else Sketchor needs to round-trip (constraints go into an `OBJECTS` XRECORD under a `SKETCHOR` dictionary).
- **Default version (decided 2026-09-28):** save back in the version the file was opened as (record it on import); new documents default to 2018.
- Keep the **R12 writer** as `format: "r12"` (laser/CNC shops still want it; flatten blocks/hatch/dims to geometry there). Export dialog: "DXF 2018 (recommended)" / "DXF R12 (simple geometry, for CAM)".
- **Accept:** golden-file tests; X-02 audit passes; the exported file reopens in Sketchor with identical entities/layers/names; opens in LibreCAD.

### X-02 · DXF audit harness — **P0, S**
- `tools/dxf-audit/audit.py` using **ezdxf** (MIT, `pip install ezdxf`): `doc = ezdxf.readfile(p); auditor = doc.audit()` → JSON `{errors, fixes, entityCounts}`. `npm run dxf:audit -- <files>`; skipped with a warning if Python/ezdxf absent (don't add Python to CI).
- `packages/core/src/dxfw/fixtures/` — writer output for a fixed set of documents, regenerated by `npm run dxf:golden` and diffed in vitest.
- Optional: if `ODAFileConverter.exe` is installed, `tools/dxf-audit/oda.ps1` converts DXF→DWG→DXF and reports failures (the strictest free validator available).

### Z-04 · Linetypes + lineweights (was T-36) — **P1, M**
Replace `dashed: boolean` with `linetype?: string` (name into the `linetypes` table: CONTINUOUS, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE + ISO `ACAD_ISO02W100`… authored clean-room from the ISO 128 descriptions) and `lineweight?: number` (mm, standard set 0.00–2.11). Layer defaults; `BYLAYER`/`BYBLOCK`. Keep reading `dashed: true` as `linetype: "DASHED"` + construction flag (split construction into its own `construction?: boolean` — it currently piggybacks on `dashed`). Renderer draws pattern in world units × `LTSCALE` with a screen-size LOD fallback. DXF `LTYPE` table + import. `.lin` file import.

---

## 4. Phase 1 — True splines and ellipses (supersedes T-30, T-31, P-01, P-04..06)

### C-01 · `EllipseEntity` — **P1, M**
`{center, majorAxis: Point /*vector, DXF convention*/, ratio: number /*minor/major, 0<r≤1*/, start: number, end: number /*parametric, radians; full = 0..2π*/}`. Kind implementation: exact bounds (closed form), `path()` → new `Curve` kind `"ellipse"` in `intersect.ts` (line–ellipse closed form; ellipse–other via subdivision + Newton), nearest point (Newton on param), quadrant/center/end snaps, grips (center, 2 axis ends, 2 arc ends), transform (affine → new ellipse via SVD of the 2×2; circles under non-uniform scale finally become ellipses instead of today's warning), solver params (cx, cy, major len, angle, ratio [+ start,end] = 5/7).

### C-02 · `SplineEntity` (NURBS) — **P1, L**
`{degree: 1..3 (read up to 11), controlPoints: Point[], knots: number[], weights?: number[], fitPoints?: Point[], startTangent?, endTangent?, closed, periodic}`. Store **both** fit and control data when the source has both (DXF does); editing fit points re-solves control points by global interpolation (chord-length params, Piegl & Tiller A9.1), editing CVs drops fit data (as AutoCAD does).
- `packages/core/src/nurbs.ts` (pure, heavily tested): de Boor eval, derivatives, knot insertion, degree elevation, split at param, reverse, closest point (projection + Newton), arc-length table, adaptive tessellation by chord tolerance (`tessellate(e, tol)` — screen-space tolerance from the renderer, 0.01 mm for export), bounds from CV hull then refine, curve–line/curve–curve intersection by Bézier-clipping or recursive subdivision on the Bézier decomposition.
- Curves in `intersect.ts` gain `"nurbs"`; trim/split/extend work via split-at-param (extend = linear/tangent extension, like AutoCAD).
- Offset of a spline = sample offset points + fit a new spline with error ≤ tolerance (document it's approximate, same as every CAD).
- Solver params: CV coordinates (2n), point-on-spline residual via a param variable per constraint.

### C-03 · Import as real entities — **P1, S**
`dxf.ts`: ELLIPSE → `ellipse`, SPLINE → `spline` (keep today's tessellation path behind `importOptions.curves: "exact" | "polyline"`, default exact). SVG `<ellipse>` and `A` commands with rx≠ry → ellipse; cubic/quadratic Béziers → degree-3/2 splines (a Bézier *is* a NURBS with a clamped knot vector — no approximation). Removes P-01/P-04/P-05/P-06's "200-point polyline with 200 grips" complaint.

### C-04 · Export — **P1, S**
DXF 2018: `ELLIPSE`, `SPLINE` (70 flags, 71 degree, 72/73/74 counts, 40 knots, 41 weights, 10 CVs, 11 fit points, 12/13 tangents). R12: tessellate. SVG: ellipse → `<ellipse>`/`A`; spline → exact cubic Béziers via knot insertion (degree ≤ 3, non-rational) else tessellate. PDF: same Bézier conversion (`PdfBuilder` gains `curveTo`). Sketch code: `ellipse E1 at (x,y) major (dx,dy) ratio r [from a to b]`, `spline S1 degree 3 fit (..),(..) ` / `cv (..),(..) [knots …] [weights …]`.

### C-05 · Ellipse tool — **P1, S**
Tool class in `drawTools.ts`: Tab cycles *axis-end* (two axis ends + other half-axis), *center* (center, axis end, half-axis), *elliptical arc* (then start/end angles). Typed input for axis lengths. Isometric circle mode later.

### C-06 · Spline tools — **P1, M**
`SPL`: Tab cycles *fit points* (click points, Enter; `T` sets start/end tangent; typed tolerance) and *control vertices*. Live preview. Command-line aliases `spl`, `el`.

### C-07 · Spline/ellipse editing — **P1, M**
Grips: fit-point or CV grips (toggle in properties: "Show CVs"), tangent handles at ends; properties panel shows degree, closed, fit tolerance, "Convert to CVs", "Add/remove point", "Rebuild (n CVs)", "Refine", "Convert to polyline (tolerance)". `SPLINEDIT`-equivalent actions in the command line. **Convert polyline → spline** (fit through vertices) and the reverse.

### C-08 · Everything else learns curves — **P1, M**
Via Z-01 most of this is automatic; verify and specialise: fillet between line and spline/ellipse (numeric solve for tangent point), offset, join (spline + spline → one spline when G0-continuous, else polyline with spline legs is *not* supported → keep separate and report), explode (spline → polyline at tolerance with arcs fitted by `simplify.ts`), stretch, mirror, measure (arc length via table), area of closed curves (Green's theorem on the NURBS, exact for polynomial), nest `extractParts` (tessellate at 0.01 mm), G-code writer (arc-fit via `simplify.ts`).

### C-09 · Constraints on curves — **P2, M**
Point-on-curve, tangent (line–ellipse, line–spline, arc–spline endpoint G1), coincident to spline ends, equal-major-axis, horizontal/vertical ellipse axis. Adds residuals in `solver/residuals.ts` with a per-constraint parameter for the foot point.

---

## 5. Phase 2 — Blocks as live definitions (supersedes T-34)

Design **(decided)**: AutoCAD model. A `BlockDefinition` lives in the document's `blocks` table; an `insert` entity references it by name. Definitions are the source of truth; instances are rendered by evaluating the definition. Editing a definition updates every instance live. Groups stay as they are (ad-hoc, anonymous, per-document) — blocks are named and reusable.

### B-01 · Data model + evaluation — **P1, L**
- `BlockDefinition { name, basePoint, entities: Entity[] /*own ids, local coords*/, constraints?: Constraint[], attributeDefs: AttributeDef[], description?, units?, explodable: boolean, scaleUniformly: boolean, dynamic?: DynamicSpec /*Phase 6*/, preview?: string /*cached SVG*/ }`.
- `InsertEntity { type:"insert", block, insert, scale:{x,y}, rotation, attributes: Record<tag, string>, array?: {cols, rows, colSpacing, rowSpacing}, params?: Record<string, number|string> /*Phase 6*/ }`.
- `packages/core/src/blocks/evaluate.ts`: `evaluateInsert(doc, insert) → Entity[]` in world coords (transform = translate·rotate·scale·(−basePoint); non-uniform scale of arcs/circles → ellipses via C-01; nested inserts recurse with the existing `MAX_BLOCK_DEPTH = 8` + cycle detection). Memoised by `(blockName, definitionRevision, paramsHash)`; transforms applied per instance.
- Layer `0` / `BYBLOCK` colour/linetype inside a definition inherit from the insert (real CAD behaviour — the importer already does this for layer).
- Kind implementation for `insert`: bounds/hit/snap/tessellate by evaluating; **snaps reach inside instances** (endpoints of the block's lines are snappable, as in AutoCAD); selection selects the instance as a whole.

### B-02 · Commands — **P1, M**
`define-block` (from selection: entities removed from model space, one `insert` added at the picked base point — AutoCAD's "convert to block", optionally "retain"), `update-block` (replace definition body — inverse is the old body), `rename-block`, `delete-block` (refuses while referenced unless `purge`), `explode-insert` (instance → evaluated entities, attributes → text). All undoable; one undo step each.

### B-03 · Block creation UX — **P1, S**
`B` / Ctrl+Shift+B "Create block": dialog with name, base point pick, "convert selection / retain / delete", description, attribute defs found in selection. Command line `block`, `b`.

### B-04 · Block editor (in-place, live) — **P1, L**
Double-click an insert (or `bedit NAME`) → **block edit mode**: the canvas shows the definition in local coordinates in a tinted workspace (or, option "Edit in place", in context with everything else faded, AutoCAD's REFEDIT). Every tool works. Edits are `update-block` commands so every instance re-renders **live while editing** (other instances visible when in-place). Toolbar shows "Editing block ‹name› · Save / Discard / Base point". Undo inside the editor is scoped to the edit session and collapses to one `update-block` on Save.

### B-05 · Attributes — **P1, M**
`AttributeDef { tag, prompt, default, at, height, rotation, textStyle, flags: {invisible, constant, verify, preset, multiline}, fieldExpr? }` authored in the block editor (tool "Attribute definition"). On insert, a prompt dialog asks for values (skippable with defaults). Double-click an attribute → edit dialog listing all tags (ATTEDIT). **Attribute extraction**: "Export attributes → CSV" of all inserts (tag table: block, handle, position, each tag) — LibreCAD can't do this; title blocks and parts lists depend on it. Fields: `{{filename}}`, `{{date}}`, `{{layout}}`, `{{sheet}}/{{sheets}}`, `{{scale}}` evaluated at render time (Phase 7 uses these).

### B-06 · Block library panel — **P1, M**
A panel (Ctrl+3) with three sources: *This drawing* (definitions, instance counts, thumbnails from the cached `preview`), *Folders* (every DXF/`.sketchor` in chosen folders — the file browser's scanning + thumbnail cache reused; each file = one block, or each file's own blocks listed underneath), *Favourites*. Drag onto canvas → insert at the drop point with snapping, or click → the insert tool (scale/rotation typed or picked). Search, tags (reuse the file-browser tag store). "Redefine from file" for updated library parts.

### B-07 · Import keeps blocks — **P1, M**
`dxf.ts` collects BLOCKS into `BlockDefinition`s and INSERT into `insert` entities (flag `importOptions.blocks: "keep" | "explode"`, default keep). ATTDEF/ATTRIB become attribute defs/values. Anonymous `*U`/`*D`/`*X`/`*T` blocks: `*D` (dimension) → handled by D-10, `*X` (hatch) ignored, `*U` (dynamic block representations) → B-27. MINSERT → `array`. Explorer thumbnailer + file browser keep working (they evaluate).

### B-08 · Export writes real blocks — **P1, M**
DXF 2018: BLOCK_RECORD + BLOCK/ENDBLK with base point, entities in the block with correct owner handles, INSERT (41/42/43 scale, 50 rotation, 66 attribs-follow flag, 70/71/44/45 array), ATTDEF inside, ATTRIB + SEQEND after the insert. R12: blocks allowed in R12 too (BLOCKS section, INSERT without handles) — keep them unless "Flatten for CAM" is on. SVG: `<symbol>`/`<use>` (lossless, and much smaller files).

### B-09 · Management — **P2, S**
Purge unused (blocks, layers, styles, linetypes; dialog with counts), rename, "Select all instances", "Replace block A with B", "Count" (BCOUNT table, printable), nested-block tree in properties.

### B-10 · Block-aware editing — **P2, M**
Properties panel for an insert (block name dropdown to swap, scale X/Y/uniform lock, rotation, attribute values, array). Grips: insertion point, rotation grip, attribute text grips. Mirror of an insert = negative X scale (not explode). Stretch moves inserts whose insertion point is inside. Nest plugin: an insert is one part (evaluate + extract).

---

## 6. Phase 3 — Hatching with a pattern library (supersedes T-32)

### H-01 · `HatchEntity` — **P1, M**
`{type:"hatch", loops: HatchLoop[] /*each: edges of line/arc/ellipse/spline, or a bulged polyline; flags outer/external/derived*/, fill: {kind:"pattern", name, scale, angle, origin, double?} | {kind:"solid", color} | {kind:"gradient", name: "LINEAR"|"CYLINDER"|"SPHERICAL"|…, colors:[c1,c2?], angle, centered, shift}, style: "normal"|"outer"|"ignore", associative: boolean, sources?: EntityId[], backgroundColor?, transparency?}`. Migration: today's `fill?: string` on closed shapes stays readable and renders as before, and a command "Convert fills to hatches" upgrades them.

### H-02 · Pattern engine — **P1, L**
`packages/core/src/hatch/`:
- `pat.ts`: parse/write the `.pat` format (`*NAME, desc` then `angle, x0,y0, dx,dy [, dash…]` lines) — the de-facto standard every CAD reads.
- `fillLines.ts`: for each pattern line family, generate the infinite family of parallel lines covering the region's bounds (rotated by angle, scaled, offset by origin), intersect each with the loop edges (reuse `intersect.ts`, incl. arcs/ellipses/splines), sort crossings along the line, apply even-odd per `style` (normal = alternate islands, outer = only outermost area, ignore = outer boundary only), then apply the dash pattern with phase continuous along the line. Output: `Float32Array` of segment endpoints + dots.
- Cache per hatch keyed by `(loops revision, fill)`; **density guard**: if more than ~200k segments at the current zoom, render the pattern's average tone as a tint (and say so in the status bar) instead of hanging the UI — a LibreCAD pain point. Worker offload for > 20k segments.
- Exact in world units (patterns scale with `LTSCALE`/annotation scale when the hatch is annotative).

### H-03 · Built-in pattern library — **P1, M**
Ship `packages/core/src/hatch/library/*.pat` **authored clean-room** (licence rule 9): ANSI31–38, AR-* architectural (brick, block, concrete, sand, roof, parquet, herringbone, shakes, rshake), ISO 02W100-series line hatches, ISO materials from ISO 128-50 (general, metal, insulation, earth, gravel, water, wood across/along grain, glass, rubber, plastic), GOST 2.306 (the user base includes Slavic users — steel, non-metal, wood, stone, concrete, glass, liquid, soil), DIN/JIS basics, plus geometric (grid, dots, cross, honeycomb, stars, zigzag, checker, triangles, escher). **≥ 60 patterns.** Names that match AutoCAD's well-known names (ANSI31, AR-CONC, …) must look the same so DXFs exchange cleanly, but the numeric definitions are re-derived from the public standards, not copied from `acad.pat`. Each has a category, description, default scale for mm and inch drawings.

### H-04 · Hatch tool + boundary detection — **P1, M**
`H`: pick-points mode (click inside → `regions.ts` finds the smallest enclosing closed region **including nested islands**, extend `regions.ts` to return loop trees and to use curves not just segments, with a gap tolerance like AutoCAD's `HPGAPTOL`) and select-objects mode. Live preview under the cursor before click (the region highlight + pattern). Floating panel (replaces `FillPanel.tsx`): pattern picker with previews, scale, angle, origin (pick), style, associativity, gradient editor, "Match properties" (inherit from existing hatch), "Separate hatches" for multi-click. Keep the old solid-fill quick path as the "Solid" pattern.

### H-05 · Associativity — **P1, M**
`sources` records boundary entity ids. Bus middleware (after the solver): when a source entity changes, recompute that hatch's loops in the **same undo entry** (mirror of how the solver joins moves). If boundary becomes open → hatch keeps last loops, marked "boundary lost" (red outline in properties) — never silently deleted. Grips on the hatch loops edit the loop directly (and drop associativity, as AutoCAD does).

### H-06 · Pattern library panel + user patterns — **P1, M**
Browser of all patterns (built-in + imported + plugin-contributed) by category with live swatches rendered by the same engine; import `.pat` files (multi-pattern files split), duplicate & edit a pattern in a small editor (line families table + live preview + "draw a tile" mode that generates `.pat` lines from drawn lines in a unit tile — **a pattern designer LibreCAD doesn't have**), export `.pat`. Stored in the doc's `hatchPatterns` table only when used (so a DXF/`.sketchor` carries its custom patterns). Plugin contribution `contributes.hatchPatterns: [{file: "materials.pat", category}]` — data-only, no code.

### H-07 · Gradients + transparency — **P2, S**
The nine AutoCAD gradient kinds rendered with canvas gradients/SVG gradients/PDF shading (type 2/3). Per-hatch transparency + background colour.

### H-08 · Hatch editing ops — **P2, S**
Edit hatch dialog (double-click), recreate boundary (hatch → polylines), trim hatch with trim tool (loops re-computed), explode (pattern → lines, grouped), set origin by pick, "send hatch behind boundaries" draw order (introduces a simple `drawOrder` on entities, needed anyway).

### H-09 · DXF import/export — **P1, M**
Import HATCH: all four edge types (line/arc/ellipse/spline), polyline boundaries with bulges, pattern definition lines (code 53/43/44/45/46/79/49) so a pattern Sketchor doesn't have still renders exactly, solid, gradient (450–470), seed points, associativity (330 source handles → `sources`). Export the same, always **writing the pattern definition lines** (other CAD reproduces the hatch even without the `.pat`). R12: explode to lines. SVG: `<pattern>`-less — clip-path + generated lines (exact), solid/gradient native. PDF: clip path + lines.

### H-10 · Performance + print — **P2, S**
Hatch segments drawn as one `Path2D` per hatch per zoom band; PDF/SVG export uses clip paths so files stay small. Benchmark: 500 hatches of ANSI31 on a 1 m² region at scale 1 — pan/zoom ≥ 50 fps on this PC; add a perf test that asserts generation time for a fixed fixture.

---

## 7. Phase 4 — Dimension styles + annotations (absorbs T-42, T-33)

### D-01 · Text styles + fonts — **P1, M**
`TextStyle { name, font: "sketchor-stroke" | "shx:<name>" | "ttf:<family>", height /*0 = variable*/, widthFactor, oblique, backwards, upsideDown }` in the `textStyles` table. Rendering: today's canvas sans font for TTF families (system fonts in the browser); the existing stroke font (`font.ts`) remains for engraving/CAM output; **opentype.js** (MIT) to convert TTF glyphs to geometry for "explode text" and for exact SVG/PDF/DXF-R12 output. SHX: map common names (`txt`, `simplex`, `romans`, `isocp`) to stroke fonts shipped as clean-room `.lff`-like JSON; `TEXT` gains `style`, `halign/valign` (DXF 72/73), `widthFactor`, `oblique`.

### D-02 · `DimensionEntity` + driving dimensions (**T-42**) — **P1, XL → split D-02a/b/c**
- **a · Entity**: `{type:"dimension", kind:"linear"|"aligned"|"angular2l"|"angular3p"|"radial"|"diametric"|"arclength"|"ordinate"|"jogged", refs: PointRef[] /*associative, via constraint PointRefs*/, defPoints: Point[] /*fallback & DXF*/, textPos?, textOverride?: string /*"<>" = measured*/, style: string, overrides?: Partial<DimStyle>, driving: boolean, expression?: string /*T-45*/}`. Geometry layout extends `dimension.ts` for every kind (it only does linear today).
- **b · Driving**: a driving dimension *is* a `distance`/`angle`/`radius` constraint in the solver (one source of truth — no separate constraint record). Double-click the value → typed box (T-08 box) → solver moves geometry. `driving:false` = reference dimension shown in parentheses. Over-constraining prompts "Make it a reference dimension?" (Onshape/SolidWorks behaviour).
- **c · Tools**: `DIM` smart dimension (Onshape-style: select one line → length; two lines → angle or distance; circle → diameter; arc → radius; point+line → distance) plus explicit `DLI`, `DAL`, `DAN`, `DRA`, `DDI`, `DAR`, `DOR`, `DJO`. **Baseline** and **continue** dimensioning (DBA/DCO), **quick dimension** (QDIM: select geometry → a chain of dims). Replaces today's line+text `dim` tool; a migration command converts old grouped dims into entities where it can recognise them.

### D-03 · Dimension styles — **P1, L**
`DimStyle` with the DXF DIMVARS that matter, grouped like AutoCAD's dialog: *Lines* (DIMCLRD, DIMDLE, DIMDLI, DIMEXE, DIMEXO, DIMLWD/E, suppress ext 1/2, fixed-length ext lines), *Symbols & arrows* (DIMBLK/1/2 from ≥ 20 arrowheads: closed filled, closed blank, open, open 30°, dot, dot small, architectural tick, oblique, integral, datum triangle, none, origin indicator… and **any block** as an arrowhead; DIMASZ, center marks DIMCEN, arc-length symbol, jog angle), *Text* (DIMTXSTY, DIMTXT, DIMCLRT, DIMGAP, DIMTAD/DIMJUST/DIMTIH/DIMTOH, frame, fill), *Fit* (DIMATFIT, DIMTIX, DIMSOXD, DIMTMOVE, **DIMSCALE**, annotative), *Primary units* (DIMLUNIT decimal/engineering/architectural/fractional, DIMDEC, DIMRND, DIMDSEP, DIMPOST prefix/suffix, DIMLFAC, DIMZIN zero suppression, DIMAUNIT/DIMADEC), *Alternate units* (DIMALT, DIMALTF, DIMALTD, placement), *Tolerances* (DIMTOL/DIMLIM, symmetric/deviation/limits/basic, DIMTP/DIMTM, DIMTFAC, DIMTOLJ).
- Style manager dialog: list, **live preview drawing** (all 9 kinds rendered with the style), New from…, Modify, Override (per-dimension overrides shown as a diff), Compare two styles (diff table — AutoCAD has this, LibreCAD doesn't), Set current, import styles from another DXF/`.sketchor`.
- **Child styles** (radial/angular/diameter sub-styles like AutoCAD's `STANDARD$2`).
- Built-in presets: ISO-25, ANSI, DIN, JIS, GOST 2.307, Architectural (ft-in, ticks) — authored from the standards.
- Every change to a style re-renders all dimensions using it (one command, one undo).

### D-04 · MTEXT — **P1, M**
`MTextEntity { at, width, attachment (1–9), text /*with MTEXT codes: \P, \L…\l, \O, \C, \H, \f, \S stacked fractions, \~, {…}*/, style, height, rotation, lineSpacing, columns?, background? }`. In-place rich editor (contentEditable subset → MTEXT codes), bullets/numbered lists, stacked fractions `1/2` → stacked, symbols menu (Ø ± ° ≈ ≤ ≥ △ ⌀ ⌴ ⌵ ⏥ ☐). Word-wrap layout engine in core (measured by a pluggable text-metrics function; node tests use the stroke font metrics). Today's MTEXT import (strips codes) is upgraded to keep formatting.

### D-05 · Leaders and multileaders — **P1, M**
`LeaderEntity` (MULTILEADER semantics): leader lines (straight/spline), landing, arrowhead (from D-03's set), content = MTEXT | block with attributes (balloons: circle/hexagon/triangle with number — for parts lists) | none; `MLeaderStyle` table. Tools: add leader, add/remove leader lines, align leaders, collect (stack balloons). Auto-numbered balloons tied to block attribute (item number) — feeds a **parts list table** later.

### D-06 · GD&T and symbols — **P2, M**
Feature control frames (TOLERANCE entity): symbol picker (all 14 characteristic symbols), tolerance values with Ø / modifiers (Ⓜ Ⓛ Ⓢ Ⓕ Ⓟ Ⓣ Ⓤ), up to 3 datums, composite frames; datum feature symbols; surface finish (ISO 1302) and weld symbols as shipped dynamic blocks (Phase 6).

### D-07 · Center marks and centerlines — **P2, S**
Associative center mark (circle/arc) and centerline (two lines) entities with CENTER linetype, following their geometry.

### D-08 · Annotative scaling — **P1, M**
`annotative: boolean` on text/mtext/dims/leaders/hatches/blocks; document `annotationScale` list (1:1, 1:2, 1:5, 1:10, 1:20, 1:50, 1:100, 2:1, 1"=1'-0", …). Paper height × scale = model height. Model space renders at the current annotation scale; each viewport (Phase 7) renders at its own scale. An object can support several scales (per-scale text position overrides).

### D-09 · Dimension editing — **P1, S**
Grips (text, dim line position, ext line origins), text move with/without leader, "reset text position", flip arrows, `DIMSPACE` (equal spacing), `DIMBREAK` (break ext lines at crossings), `DIMJOGLINE`, "reassociate" to geometry, update to current style, oblique ext lines.

### D-10 · DXF: DIMSTYLE + DIMENSION + MTEXT + LEADER — **P1, L**
Export: DIMSTYLE table records (all vars from D-03, handles, `ACAD_DSTYLE_*` XDATA overrides for per-dimension overrides), DIMENSION entities (70 type flags, 10–16 def points, 1 override text, 3 style name) **plus the anonymous `*D<n>` block** containing the rendered lines/arrows/text — every reader that doesn't recompute dimensions (most, including LibreCAD for many kinds) shows exactly our rendering. MTEXT with codes. MULTILEADER + MLEADERSTYLE (OBJECTS) with a LEADER fallback for R12/R2000 readers. TOLERANCE. Import: all of the above, preferring re-computation from def points + style, falling back to the `*D` block geometry when the style can't be resolved. Round-trip test: our DIMSTYLE → ezdxf reads every var identically.

### D-11 · SVG/PDF/print — **P1, S**
Dims/mtext/leaders render through the same core layout → PDF/SVG/print match the canvas exactly (the "one drawing, three renderings" rule in CLAUDE.md).

### D-12 · Tables (optional) — **P3, M**
TABLE entity for parts lists/revision tables fed from attribute extraction (B-05); DXF ACAD_TABLE export with a block fallback.

---

## 8. Phase 5 — Complete the constraint roadmap

Uses the existing solver (`packages/core/src/solver/`). T-42 lands in **D-02**.

### T-43 · Inference / auto-constraints while drawing — **P1, M**
As specified in `sketching-tools-roadmap.md`: when a snap fired while placing a point (endpoint → coincident, midpoint → midpoint, on-curve → point-on-curve, ortho/polar 0/90 → horizontal/vertical, tangent snap → tangent, perpendicular snap → perpendicular, parallel guide → parallel), add that constraint in the same batch as the geometry. Glyph preview at the cursor before the click; status-bar toggle **AUTOCON** (default on in "Sketch" mode, off in "Drafting" mode — see K-03); hold Ctrl (rebindable via `keybindings.ts` Mouse group) to suppress for one click.

### T-44 · DOF colouring + conflicts panel — **P2, S**
Per-entity state from the solver's Jacobian: under-defined (theme token `constraint.under`, default blue), fully defined (`constraint.full`, default entity colour/black), over/conflicting (`constraint.conflict`, red). Constraint panel "Conflicts" section with "delete this one"/"make reference" buttons. Toggle in View menu (drafters hate blue geometry).

### T-45 · Parameters and expressions — **P1, M**
`param width = 100 mm` in the DSL; **Variables panel** (name, expression, value, unit, comment); dimension values and every numeric field in the properties panel accept expressions (`width/2 + 5`, `sqrt(a^2+b^2)`, `pi`, unit-aware `2in + 5mm`). `packages/core/src/expr.ts`: tokenizer + Pratt parser + evaluator, no `eval`, dependency graph with cycle detection. Params are a document table (`params`) — commands `put-param`/`delete-param`; changing a param re-solves in one undo entry. DXF: stored in the `SKETCHOR` dictionary (+ written to `USERR1..5`-free custom properties `$CUSTOMPROPERTY` for display in other CAD).

### T-46 · Associative tools — **P2, M**
Mirror → symmetric constraints (option), Offset → offset constraint (per-segment distance + parallel), Fillet → tangent + coincident + radius (driving dim optional), Pattern → linear/circular pattern constraints with count/spacing params (T-45), Trim keeps coincident-to-cutting-edge.

### K-01 · Constraint + dimension coverage for new kinds — **P2, M**
Ellipse/spline (C-09), inserts (fix/coincident on an insert's base point, rotation as angle constraint — lets you constrain *placement* of blocks), text anchor constraints.

### K-02 · Solver scale + robustness — **P2, M**
Decompose the sketch into independent connected components and solve each separately (a 2 000-entity drawing with 20 constrained sketches shouldn't solve as one system); cache Jacobian sparsity; benchmark test (500 constraints solves < 50 ms). Regression suite of classic tricky sketches (the "flip" cases: tangent arc choosing the wrong side, angle 180° ambiguity) — solver must stay on the branch nearest the current geometry.

### K-03 · Sketch vs drafting mode — **P3, S**
A per-document preference: *Drafting* (AutoCAD feel: no auto-constraints, dims are annotations by default) vs *Sketch* (Onshape feel: auto-constraints on, dims driving by default). Just defaults for T-43/D-02 — no separate code paths.

---

## 9. Phase 6 — Dynamic and parametric blocks

LibreCAD has no dynamic blocks at all. We do both AutoCAD's action model (compatibility and familiarity) **and** a constraint-driven model (simpler to author and strictly more powerful) — they share one evaluation pipeline.

### B-20 · Dynamic spec + evaluator — **P1, L**
`DynamicSpec { params: BlockParam[], actions: BlockAction[], visibilityStates?: {name, visible: EntityId[]}[], lookup?: LookupTable[], constraintParams?: string[] }`.
- Params (AutoCAD names): `point`, `linear` (with value set: list / increment + min/max), `polar`, `xy`, `rotation`, `alignment`, `flip`, `visibility`, `lookup`, `basepoint`.
- Actions: `move`, `stretch` (frame + selection set), `polar-stretch`, `scale`, `rotate`, `flip`, `array` (by distance along a linear param), `lookup`.
- `evaluateDynamic(def, values) → Entity[]` pure: apply actions in the definition's order to a copy of the body; for **parametric blocks**, set the named params (T-45) and run the solver on the body (definition constraints). Cache by `(block, rev, valuesHash)`; the solver path is fast because K-02 decomposes.
- Instances keep `params` values; grips on the insert are the params' grips (arrow for linear, circle for rotation, flip arrow, visibility dropdown ▼, lookup ▼) and dragging a grip snaps to the value set.

### B-21 · Authoring in the block editor — **P1, L**
Block editor gains an "Authoring" palette: add parameter (click points), attach action (pick param → pick frame/selection), visibility states manager (create state, toggle object visibility per state), lookup table editor (grid of param values ↔ lookup value names), "Test block" window (AutoCAD's BTESTBLOCK — a sandbox insert to try grips without saving). Parametric route: add constraints + dims in the editor, mark dims as "block parameter" → they become instance params automatically.

### B-22 · Instance UX — **P1, M**
Properties panel shows a "Custom" section with each param (number with value set, dropdown for visibility/lookup, flip toggle). Multi-select instances edits them all. "Reset block" restores defaults. `select similar` distinguishes by param values optionally.

### B-23 · Shipped dynamic block library — **P2, M**
Authored with our tools, clean-room: doors (width, swing flip, hinge side, visibility: single/double/sliding), windows, bolts/nuts/washers (lookup M3–M24 + imperial), sheet-metal hole/slot/tab features, section/elevation markers, north arrow, title blocks (A4–A0, ANSI A–E; attributes + fields), revision triangles, surface-finish/weld symbols (D-06), structural shapes (W/HSS/angle/channel lookup tables), furniture basics. Lives under the Block library panel's "Sketchor library" source; installable as plugins too (TH/B plugin data contributions).

### B-24 · Plugin contribution: blocks — **P2, S**
`contributes.blocks: [{file: "doors.dxf" | "doors.sketchor", category}]` — data-only like patterns and themes; shows in the library panel.

### B-25 · DXF export of dynamic blocks — **P1, M**
Real AutoCAD stores dynamic blocks as a definition + an anonymous `*U<n>` representation per distinct state + `AcDbDynamicBlockReference`/`AcDbEvalGraph` objects we cannot produce faithfully. **(decided)** Write: the base definition as a normal block, each instance's evaluated geometry as an anonymous `*U<n>` block referenced by its INSERT (so every reader, including LibreCAD and AutoCAD, shows the right geometry), and our spec + param values as XDATA/XRECORD under `SKETCHOR` so **Sketchor re-opens it as a live dynamic block**. Document honestly that AutoCAD will see a static block.

### B-26 · DXF import of AutoCAD dynamic blocks — **P2, L**
Read `*U` anonymous blocks as the instance's current geometry (always correct). Best-effort: parse `AcDbEvalGraph` + `AcDbBlockLinearParameter`/`AcDbBlockStretchAction`/`AcDbBlockVisibilityParameter`/`AcDbBlockFlipParameter`/`AcDbBlockLookupParameter` objects from OBJECTS into our `DynamicSpec` (visibility states and linear-stretch/flip cover most real-world door/window/fastener blocks). Anything unrecognised → static block, with a line in the import report.

### B-27 · Tests — **P1, S**
Evaluator unit tests per action; a fixture set of dynamic blocks created by us and (if the user can supply) by AutoCAD; round-trip Sketchor→DXF→Sketchor preserves specs and values.

---

## 10. Phase 7 — Paper space, layouts and viewports

### L-01 · Layout model — **P1, M**
`Layout { name, order, paper: {size: "A4"|…|"ANSI D"|custom, w, h, units, orientation}, margins, plotSettings: {scaleLineweights, plotStyle?: "monochrome"|"grayscale"|"as displayed", center, plotArea}, entities: EntityId[] /*paper-space entities*/ }` in the `layouts` table. Every entity gets an implicit `space` (model by default); paper-space entities live in the layout's list. Commands: `add-layout`, `rename-layout`, `delete-layout`, `reorder-layouts`, `move-to-space`.

### L-02 · Layout tabs UI — **P1, M**
Bottom tab strip per document tab: **Model | Layout1 | +**. A layout renders the sheet (paper colour from theme, shadow, printable-area dashed rect) in paper units. Every draw/annotate tool works in paper space. Page setup dialog (size list + custom, orientation, margins, plot style). Right-click: rename, duplicate, move, delete, "from template" (a `.sketchor` or DXF with a layout).

### L-03 · `ViewportEntity` — **P1, L**
`{type:"viewport", center, width, height /*paper units*/, clip?: loop /*polygonal/any closed entity*/, viewCenter /*model*/, scale /*paper per model*/, rotation?, locked, frozenLayers: string[], layerOverrides?: {layer: {color?, linetype?, lineweight?}}, annotationScale?, visualStyle?: "wireframe" }`.
- Renderer: for each viewport, `ctx.save(); clip; transform model→paper; draw model entities (culled by the viewport's model window, frozen layers skipped); ctx.restore()`. Model-space selection/hover never leaks through. PDF/SVG export: clip path + transformed model geometry (reuse `drawEntitiesToPdf`).
- Tools: "Viewport" (rectangle / polygonal / from object), "Viewports: 1/2/3/4 layout" presets.
- **Model space through a viewport**: double-click inside → MSPACE (viewport border highlighted, everything else dimmed), pan/zoom changes the viewport's view unless `locked`; edits hit the model. Double-click outside → PSPACE. Status bar: viewport scale dropdown (standard scales + custom), lock toggle.
- Per-viewport layer freeze from the Layers panel (extra column "VP freeze" when in a layout).

### L-04 · Title blocks + fields — **P1, S**
Insert a title block (B-23 dynamic blocks) in a layout; attribute fields `{{sheet}}`, `{{sheets}}`, `{{layout}}`, `{{scale}}` (of the viewport under it / main viewport), `{{date}}`, `{{filename}}`, `{{param:width}}` (T-45) evaluate live. Sheet-set-lite: a "Sheets" dialog to edit common attributes (project, client, drawn by) across all layouts at once.

### L-05 · Annotative scale per viewport — **P1, M**
Viewports render annotative objects (D-08) at their own scale; objects not supporting that scale are hidden in that viewport (AutoCAD `ANNOALLVISIBLE` toggle). "Add current scale" to selected objects.

### L-06 · Plot / PDF per layout — **P1, M**
Print/PDF from a layout is 1:1 on paper (existing `PdfBuilder` + printHtml preview + autosave folder flow). "Publish": all (or selected) layouts → one multi-page PDF, filed via the autosave folder. Lineweights printed at true mm widths (Z-04); monochrome/grayscale plot styles; hatches + gradients via H-09's PDF path. Model-space print stays as today.

### L-07 · DXF LAYOUT/VIEWPORT round-trip — **P1, L**
Export: `*Paper_Space` (first layout) and `*Paper_Space0..n` BLOCK_RECORDs, LAYOUT objects in `ACAD_LAYOUT` with PLOTSETTINGS fields (paper size name, units, margins, scale), VIEWPORT entities (the overall paper viewport id 1 + ours, 10/11/12/13/40/41/45 view, 331 frozen layers, 341 clip boundary, 90 status flags incl. locked), paper-space entities with `67 1`. Import: the same (today `VIEWPORT` is in `KNOWN_IGNORED` — that goes away), layouts appear as tabs.

### L-08 · Layout from model (convenience) — **P2, S**
"Create layout" wizard: pick paper, title block, scale (or "fit"), one-click viewport around the current model extents or the selection — the fast path for the laser-shop user who today just prints the model.

### L-09 · Sheet templates as plugins — **P3, S**
`contributes.layoutTemplates: [{file, title}]` — company title blocks distributed like themes.

---

## 11. DXF fidelity items that don't belong to one feature

- **X-03 · Import coverage sweep — P1, M.** Re-run the 11,234-file `K:/01 PROD FILES` scan (node + esbuild bundle of core, read in place — see memory; auto-mode forbids copying K: files into the repo) after each phase; record entity-type counts that are still reported unsupported. Target: zero unsupported *geometry* types (PROXY objects excepted).
- **X-04 · Colours — P1, S.** ACI ↔ RGB table (all 256, exact AutoCAD values), true colour 420, colour books (430) read-only, BYLAYER/BYBLOCK semantics everywhere, layer colour/linetype/lineweight/plot flag/on/freeze/lock written correctly (today every layer is written with colour 7).
- **X-05 · Groups — P2, S.** Sketchor groups → DXF `GROUP` objects (named, selectable) in `ACAD_GROUP`; import GROUP back.
- **X-06 · Units + extents — P1, S.** `$INSUNITS`, `$MEASUREMENT`, `$LUNITS/$LUPREC/$AUNITS`, `$EXTMIN/$EXTMAX` including blocks/paper space, `$LIMMIN/$LIMMAX`. Keep the unit-detection guarantees from v0.26 (a Sketchor file must never be read in the wrong unit anywhere).
- **X-07 · Text encoding — P1, S.** UTF-8 everywhere for AC1021+, `\U+XXXX` escapes for R12 (Cyrillic labels must survive — the user writes Ukrainian), `$DWGCODEPAGE` ANSI_1252/1251 on import of old files.
- **X-08 · XDATA/round-trip of Sketchor-only data — P1, S.** Entity names, constraints, params, dynamic specs, construction flag, groups → `SKETCHOR` APPID XDATA/XRECORDs. Sketchor → DXF → Sketchor must be **lossless** for everything representable (test: `toJSON` equality after round-trip, ids aside).
- **X-09 · Preserve unknown data — P2, M.** Keep unsupported entities/objects from an imported DXF (raw group-code records, attached to the document as opaque "foreign" records) and write them back unchanged on export, with handles remapped — so opening and saving a colleague's DXF doesn't silently lose their PROXY/3D/unknown objects. This is a big fidelity win over LibreCAD (libdxfrw drops what it doesn't model).
- **X-10 · DWG — P3.** LibreDWG write is disabled in the npm build; `ODAFileConverter` (free, closed, user-installed) can be offered on desktop as "Save as DWG via ODA converter (if installed)". Don't bundle it.
- **X-11 · Binary DXF read — P3, S.** Today it warns; implement the binary reader (simple sentinel + typed group values) since the parser is record-based anyway.
- **X-12 · Fidelity scorecard — P1, M.** `docs/dxf-fidelity-scorecard.md` + `tools/dxf-audit/scorecard.ts`: a corpus of ~30 test drawings (curves, nested/attributed/dynamic blocks, every hatch style + gradient, every dimension kind with 3 styles, MTEXT formatting, leaders, 2 layouts with 3 viewports, Cyrillic text, linetypes, lineweights, true colours, images). For each: ezdxf audit errors, Sketchor re-import diff, LibreCAD open result (manual checklist until automatable: open, screenshot, compare), ODA round-trip. Run at the end of each phase; the goal line is "all green; LibreCAD's own export of the same drawings loses X, we lose 0".

---

## 12. Phase 8 — More formats with previews (EPS, DXF, 3D)

All new formats go through the existing machinery: file-browser thumbnails (`browser/thumbnail.ts` for 2D, `modelThumbnail.ts` for 3D + IndexedDB cache), Tauri file associations + `open-*` events, Explorer thumbnails (`native/dxf-thumbnailer`, `EXTENSIONS` in lib.rs — remember the HKLM `ShellEx` marker rule from CLAUDE.md for each new extension), and the macOS Quick Look extension.

### F-01 · EPS import — **P1, L**
No Ghostscript (AGPL, huge). **(decided)** A restricted PostScript interpreter in `packages/core/src/eps/`:
- Tokenizer (numbers, names, strings incl. hex/ascii85 skipping, procedures `{}`, arrays), operand/dict/graphics-state stacks, `def`/`bind`/`load`/`exch`/`dup`/`pop`/`index`/`roll`/arithmetic/`if`/`ifelse`/`for`/`repeat`, `gsave`/`grestore`, `concat`/`translate`/`scale`/`rotate`/`setmatrix`, path ops (`moveto`/`lineto`/`curveto`/`rmoveto`/`rlineto`/`rcurveto`/`arc`/`arcn`/`closepath`/`newpath`/`rectfill`/`rectstroke`), paint ops (`stroke`/`fill`/`eofill` → polylines with bulges/splines + hatch-solid fills from C-02/H-01), colour ops, `setlinewidth`, `setdash`. Text: `show` with the current font → text entity at the position (no glyph outlines).
- Covers what CAD (AutoCAD/LibreCAD/Inkscape/Illustrator "Save as EPS" with "compatible" settings) produces. Illustrator's heavy prologs (`AI*` procsets) mostly just define shorthands (`/m {moveto} def`) which the interpreter handles. Hard stop on unsupported operators → import report lists them; fallback preview from the **EPS binary header's TIFF/WMF preview** (DOS EPS header `C5D0D3C6`) or `%%BoundingBox` placeholder.
- Units: points → mm; honour `%%BoundingBox`/`%%HiResBoundingBox`.
- **Accept:** fixtures exported from Inkscape, LibreCAD, Illustrator (user-supplied if possible) import with correct geometry and scale.

### F-02 · EPS export — **P1, S**
`entitiesToEps` beside `entitiesToSvgDocument` / PDF: DSC-conformant header, `%%BoundingBox`, one stroke/fill per entity, Bézier curves for arcs/splines, hatch fills as clipped lines, colours, line widths from lineweights. Optional TIFF preview header for old DTP apps (off by default).

### F-03 · EPS thumbnails everywhere — **P1, S**
File browser via F-01's renderer (worker); Explorer: Rust side reads the DOS-EPS TIFF preview when present, else a Rust port of just the path subset (or the app-rendered PNG sidecar tier that STEP already uses — preferred, zero new parser). Register `.eps`/`.ai` (AI files ≥ 9 are PDF-based → route to a PDF path later; AI ≤ 8 are EPS).

### F-04 · DXF preview upgrades — **P1, S**
With blocks/hatches/dims now real, thumbnails (TS `dxfToSvg` + Rust `native/dxf-parse`) must render them: Rust gets INSERT evaluation (it currently mirrors TS rendering — port B-01's evaluate for static blocks), HATCH solid fills + pattern lines (port H-02's line generator, or draw hatch as a tinted fill in thumbnails — acceptable), DIMENSION via its `*D` block (free once blocks work). Thumbnail parity test: TS and Rust render the same fixture to within a pixel tolerance.

### F-05 · Mesh 3D formats — **P1, M**
STL (ascii + binary), OBJ (+MTL colours), 3MF, glTF/GLB, PLY via three.js loaders (MIT; already a dependency) in the model worker → the existing `Model3D` pipeline (`buildModel.ts`). No B-rep: `topology.ts` gets a **mesh mode** — faces = connected regions of near-coplanar/smooth triangles (dihedral threshold 20°), edges = sharp edges between them, fitted to lines/arcs as today, so picking/measure mostly works. `LAYOUT_VERSION` bump. File associations + thumbnails + Explorer PNG sidecars (tier 1) for all.

### F-06 · BREP and 3DM — **P2, M**
`.brep` via occt-import-js `ReadBrepFile` (our vendored build already includes it — check exports). `.3dm` via **rhino3dm** wasm (MIT) → meshes (+ curves as wireframe). Lazy-loaded chunks only.

### F-07 · 2D from 3D — **P2, L**
"Section / project to 2D": pick a plane (face or view preset) in a model tab → projected silhouette/visible edges (from `topology.ts` edges + a z-buffer hidden-line pass) into a new 2D tab as lines/arcs; for sheet-metal parts, "flat face outline to DXF" (the single most-requested operation for laser shops). Keep scope to planar-face outlines first.

### F-08 · PDF import (vector) — **P3, L**
pdf.js (Apache-2.0) operator list → same path pipeline as EPS (the operators are nearly identical). Big usability win (vendors send PDFs), deferred because EPS path covers the interpreter design first.

### F-09 · Format registry — **P1, S**
One table `io/formats.ts`: extension → kind (2D/3D), importer, exporter, thumbnailer, mime, association flag — drive the file browser filters, Open dialog accept list, Tauri `fileAssociations` (generate the JSON snippet from it in a check script), Explorer `EXTENSIONS`, and the embed widget (E-02). Today these lists are duplicated in 5+ places.

### F-10 · Large-file behaviour — **P2, S**
Coordinate with `docs/large-step-and-up-axis-plan.md` (S-xx/U-xx): binary reads (`read_drawing_file` uses `read_to_string`, breaks non-UTF-8), size warnings, progress for every importer.

---

## 13. Phase 9 — Embeddable animated preview ("Sketchor Embed")

**Goal:** any website shows a Sketchor-rendered preview of a DXF/SVG/.sketchor/EPS/STEP/STL/… by adding one script tag — **no rebuild of the host site**. It animates on demand like the reference site the user named (forgexus.com — its preview is JS-rendered and couldn't be inspected from here; confirm the exact feel with the user or by looking at it in the browser before E-05): press play → the object starts moving smoothly; moving the mouse adds a subtle "flow" (parallax/tilt that eases, never snaps). A faint Sketchor logo sits in the corner, and a button opens the full view.

### E-01 · Package + renderer extraction — **P1, L**
- New workspace `packages/embed` (`@sketchor/embed`), Vite library build → `sketchor-embed.js` (single ES module + IIFE build), **≤ 120 kB gzipped for 2D**; three.js and occt wasm are lazy chunks fetched only for 3D files.
- Extract the Canvas2D drawing code from `apps/web/src/viewport/renderer.ts` into a pure `packages/core/src/render2d/` (`drawEntities(ctx, entities, view, theme, opts)`) with no store/React imports; the app's renderer becomes a thin wrapper. Same for the 3D scene setup (`modelScene.ts` pieces) into `packages/embed/src/three/`. **One renderer, three consumers** (app, embed, thumbnails).

### E-02 · Web component API — **P1, M**
```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@sketchor/embed@1/dist/sketchor-embed.js"></script>
<sketchor-view src="/files/bracket.dxf" autoplay motion="float" theme="auto" background="transparent" controls="minimal" full-url="auto"></sketchor-view>
```
- Custom element with **Shadow DOM** (host-page CSS can't break it, ours can't leak), sized by the host (`width/height` attributes or CSS, `aspect-ratio` default 4/3).
- Attributes: `src`, `format` (override detection), `autoplay`, `motion` (`none|float|turntable|draw|orbit`), `intensity` (0–1), `theme` (`auto|dark|light|<theme id or URL to theme JSON>` — TH-01 format), `background`, `controls` (`none|minimal|full`), `logo` (`on|off` — off only for self-hosted/licensed use; default on), `full-url` (`auto` = sketchor.sergioalexo.com/app?open=`src`, or a custom URL, or `none`), `layers`, `layout` (paper-space layout name), `fit-padding`.
- JS API: `el.play()`, `pause()`, `reset()`, `fit()`, `el.load(urlOrBlobOrText)`, events `load`, `error`, `play`, `pause`.
- **Auto-upgrade mode**: `<script … data-auto>` turns every `<a href="*.dxf|.step|…" data-sketchor>` / `<img data-sketchor-src>` on the page into a preview — the "connect Sketchor to any website" case with zero markup changes beyond one attribute.
- Also an **iframe endpoint** `https://sketchor.sergioalexo.com/embed?src=…&motion=…` for CMSs that strip scripts, and an **oEmbed** endpoint on the site (`/oembed?url=`) so Notion/WordPress/Discourse auto-embed a pasted link.

### E-03 · Loading — **P1, M**
`fetch(src)` (host must allow CORS for cross-origin files — document it; same-origin always works), size limit attribute (default 25 MB), format sniff (magic bytes + extension via F-09), parse in a Worker (core parsers are pure), progressive: show a skeleton + tiny spinner, then fade the drawing in. Errors render a small inline card (never a blank box). Cache parsed results in IndexedDB keyed by URL+ETag.

### E-04 · Idle look — **P1, S**
Before play: static fitted view with a soft vignette and the drawing's own colours or theme; a round **play** button centered (appears on hover/focus; always visible on touch), Sketchor logo bottom-right at ~35 % opacity (60 % on hover, links to the Sketchor site with `rel="noopener"`), and a **"⤢ Full view"** button top-right.

### E-05 · Motion engine — **P1, M**
`packages/embed/src/motion/`:
- All motion is driven by **critically damped springs** (`x'' = -k(x - target) - 2√k·x'`) integrated per frame with a clamped dt, so every change of target eases in/out naturally — no linear tweens, no jumps.
- **2D "float"**: gentle Lissajous drift of the view (±1.5 % translation, ±0.8° rotation, ±1 % zoom at 0.05–0.08 Hz, incommensurate periods so it never visibly loops) + pointer **parallax/tilt**: the canvas is rendered on a layer with CSS `perspective` and `rotateX/rotateY` up to ±6° toward the pointer, plus layers (by DXF layer or depth order) offset by small different amounts → the "flow" depth effect. Pointer leaves → springs back to the drift.
- **2D "draw"**: strokes trace in along their length (per-entity dash-offset animation in draw order, total 2–3 s, eased), then hands over to float. Hatches fade in after their boundaries.
- **3D "turntable"/"orbit"**: slow yaw (≈ 12°/s) with a small pitch oscillation; pointer position biases yaw/pitch through the same springs (move right → it swings toward you, release → it settles back into the turntable). Drag = real orbit (OrbitControls), release → inertia then blend back into auto-rotation after 2 s idle.
- Press **play** → motion intensity ramps 0 → 1 over ~600 ms (spring), **pause** ramps down (the object glides to rest rather than stopping dead).
- Respect `prefers-reduced-motion` (autoplay off, no tilt; play still available), pause when off-screen (`IntersectionObserver`) and when the tab is hidden, cap at the display's rAF rate, DPR-aware canvas sizing with a DPR cap of 2 for perf.

### E-06 · Full view — **P1, S**
Button opens (a) an in-page full-screen overlay (Fullscreen API with a fixed-overlay fallback) with pan/zoom/orbit, layer toggles, measure (2D point-to-point, 3D selection readout from `measure.ts`), and (b) an "Open in Sketchor" link (`full-url`) that loads the same `src` in the web app (`/app?open=<url>` — add that route handling to the app: fetch, import, read-only banner "Opened from <host>" + Save a copy).

### E-07 · Theming of the embed — **P2, S**
Uses TH-01 theme JSON (the `canvas` + `model3d` + `embed` token groups); `theme="auto"` follows `prefers-color-scheme` and the host page's `color-scheme`. Host can set CSS custom properties on the element (`--sketchor-accent`, `--sketchor-bg`) that override tokens — styled through `::part()` for button shapes.

### E-08 · Distribution — **P1, S**
Publish `@sketchor/embed` to npm (jsDelivr/unpkg serve it automatically — the "no rebuild" path) and mirror the built file on the Sketchor site (`/embed/v1/sketchor-embed.js`, immutable versioned paths + a `v1` alias). Semver: the element's attribute API is the contract. Licence **(decided 2026-09-28)**: the app is GPL-3.0, but `@sketchor/embed` is **MIT** (only Sketchor-authored code — no LibreDWG) so commercial sites can use it. Keep DWG and any GPL dependency out of the embed bundle.

### E-09 · Site integration + docs page — **P2, S**
In the `sketchor-site` repo (Next 16, see memory): a `/embed` docs page with a live configurator (pick a sample file, motion, theme → copy the snippet), and replace the landing page's static screenshots with live `<sketchor-view>` elements. WordPress: a tiny shortcode plugin later (P3).

### E-10 · Tests — **P1, S**
Motion math unit tests (spring converges, no overshoot for critical damping, dt clamping); a Playwright-free smoke test page `packages/embed/demo/index.html` verified live via the browser pane (load each sample format, play/pause, pointer moves, reduced-motion emulation, full view).

---

## 14. Phase 10 — Themes as plugins

### TH-01 · Theme file format — **P1, S**
`*.sketchor-theme.json` (or a plugin contribution): `{ "$schema": "https://sketchor.sergioalexo.com/schemas/theme-1.json", id, name, author, version, base: "dark"|"light", tokens: Partial<ThemeTokens> /*Z-03*/, preview?: {…} }`. JSON Schema published in `packages/core/src/theme.schema.json` + a validator (`validateTheme`, tested) that **only accepts colour values** (hex/rgb/hsl/named, no `url()`, no `var()` to unknown names, no CSS strings) and a whitelisted font list (system + bundled) — so a theme can't exfiltrate data or inject CSS. Missing tokens fall back to `base`.

### TH-02 · Plugin contribution — **P1, S**
`contributes.themes: [{ id, title, file: "themes/nord.json" }]` in the plugin manifest (`packages/core/src/plugin/manifest.ts` + validator + tests). Themes are **data-only**: the host reads the JSON from the bundle, validates it, never starts a worker for a theme-only plugin. Signing **(decided 2026-09-28)**: **unsigned theme-only bundles are allowed** (validated JSON, no `main`) behind a clear "unsigned theme" label, because they can't run code — keeps the barrier to sharing themes at zero. Plugins with code still require signatures.

### TH-03 · Theme picker + live preview — **P1, S**
Settings → Appearance: grid of theme cards (each card renders a mini canvas + mini UI using that theme's tokens), hover = live preview on the real app, click = apply. Per-document-tab override not needed. System dark/light pairing: user picks a dark theme and a light theme, "Follow system" switches between them.

### TH-04 · Theme editor — **P1, M**
Start from the current theme → grouped token list with colour pickers, contrast checker on text/background pairs and entity/canvas pairs (WCAG ratio shown, warn < 4.5 for text, < 3 for geometry), live app preview, "Export theme" → downloads `.sketchor-theme.json`, "Package as plugin" → a zip with a generated manifest (unsigned theme-only bundle, TH-02).

### TH-05 · Install paths — **P1, S**
Drag-drop a `.sketchor-theme.json` or plugin zip onto the app; Plugins panel "Install from file"; desktop file association for `.sketchor-theme` (double-click installs, with a confirm dialog showing the preview card); `sketchor://install-theme?url=` deep link from the website gallery (desktop only, confirm dialog).

### TH-06 · Built-in themes — **P2, S**
Sketchor Dark (today), Sketchor Light, High Contrast (accessibility), Classic CAD (black canvas, ACI-bright entities), Blueprint (blue paper, white lines), Paper (white canvas, black ink — pairs with print preview), plus 2–3 community-style (Nord, Solarized, Monokai) authored from their public palettes (MIT palettes; credit in NOTICE.md).

### TH-07 · Theme gallery on the site — **P3, M**
`sketchor-site` `/themes`: cards rendered with the embed widget (E-07) using each theme, download + "Open in Sketchor" deep link; submissions via GitHub PR to a `themes/` folder in a public repo (no backend needed).

### TH-08 · Themes cover everything — **P1, S**
Audit every hard-coded colour: `grep -rn "#[0-9a-fA-F]\{3,6\}" apps/web/src --include=*.ts --include=*.tsx` outside theme files → tokens (panels, popovers, constraint glyphs, DOF colours T-44, measure overlays, 3D viewer, print preview chrome, plugin panel iframes get the tokens posted as CSS variables via the existing panel RPC so plugin UIs match the theme — a small host-API addition, `ui.theme` + `theme-changed` event, bump `HOST_API_VERSION` minor).

---

## 15. Suggested execution tracks (for handing out)

| Track | Items (in order) | Notes |
|---|---|---|
| **A · Foundation** | Z-01, Z-02, X-01, X-02, Z-03, Z-04, X-04, X-06, X-07 | Must land first; everything else rebases on it. |
| **B · Curves** | C-01 → C-09, C-03/C-04 early | Pure core math is most of it — ideal for test-driven work. |
| **C · Blocks** | B-01 → B-10, then B-20 → B-27 after Track E's T-45 | Dynamic blocks depend on params + solver. |
| **D · Hatching** | H-01 → H-10 | Needs C-01/C-02 only for curve edges — can start with line/arc edges. |
| **E · Annotation + constraints** | D-01 → D-11, then T-43, T-44, T-45, T-46, K-01, K-02, K-03 | D-02 is T-42. |
| **F · Layouts** | L-01 → L-09 | After B-01..B-05 and D-08. |
| **G · Formats** | F-09, F-01, F-02, F-03, F-05, F-04, F-06, F-07, F-10, F-08 | Independent. |
| **H · Embed** | E-01 → E-10 | After Z-03 and F-09. |
| **I · Themes** | TH-01 → TH-08 | After Z-03; small, good warm-up track. |
| **X · Fidelity** | X-03, X-05, X-08, X-09, X-11, X-12 continuously | Scorecard after each phase. |

**Recommended first handoff batch:** Z-01, Z-02, X-01, X-02, Z-03 (foundation), then TH-01..TH-03 as a quick visible win, then C-01..C-04.

---

## 16. Definition of done (every item)

1. Pure logic in `packages/core` with vitest coverage including degenerate cases (zero-length, coincident, tangent, empty region, cyclic block reference, unknown pattern, malformed DXF group codes).
2. Every document change is a `Command` with an inverse; one undo step per user action.
3. New entity/table data round-trips through `.sketchor` JSON, sketch code (where expressible), DXF 2018 (lossless via XDATA), SVG/PDF (visually exact), and degrades sensibly in DXF R12.
4. `npm test` and `npm run build` green; X-02 audit clean for any DXF-touching item; golden files updated deliberately.
5. Verified live in the dev server; screenshot in the commit/PR description when visual.
6. Rust readers (`native/sketchor-shell`, `native/dxf-parse`/thumbnailer) don't crash on the new data (skip or render).
7. `README.md` feature list + this file's progress log updated; `CLAUDE.md` updated when an item adds a new subsystem or a rule future work must know.

---

## 17. Open questions for the user (answer before the relevant phase)

1. ~~Embed licence (E-08)~~ — **decided 2026-09-28: MIT.**
2. ~~Unsigned theme-only plugins (TH-02)~~ — **decided 2026-09-28: allowed, labelled "unsigned theme".**
3. ~~Default DXF export (X-01)~~ — **decided 2026-09-28: write back in the source version; new files → 2018; R12 stays available for CAM.**
4. **EPS inputs**: which programs produce the EPS files you receive (Illustrator, CorelDRAW, CAD)? Samples would let F-01 be tested against reality.
5. **Reference animation**: confirm the forgexus.com effect (couldn't be inspected — the page is script-rendered). Is it a 3D model turntable with pointer tilt, a 2D image parallax, or both?
6. **Standards priority** for hatch/dim presets: ISO + ANSI + GOST enough, or also DIN/JIS/AS?
