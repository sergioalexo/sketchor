# Sheet Metal Nesting — plan

Status: in progress (2026-09-25). Item IDs `N-xx` are stable — reference them in commits/issues.

Done: **N-01–N-04** (`fa1e422`), **N-10/11/13** (`a7ef44e`), **N-20/21/22** (`155eb65`),
**N-12** (`d0989a1`), **N-30/31** — the true-shape engine is built and wired into a
working 4-tab panel; canvas output now lives on four layers (`Nest Sheet`/`Nest
Parts`/`Nest Holes`/`Nest Labels`) so DXF export (all sheets, stacked like the
canvas, or one sheet in local coordinates) and the PDF/print report (cover summary,
one page per sheet with a numbered part table, parts ordered-vs-placed) read the
exact same entities as the drawing — no separate re-derivation. Remaining:
**N-40–44** (G-code) and **N-14** (time-budgeted Quick/Normal/Thorough search —
every pass so far is one deterministic placement, not that search layered on top
of it).

Goal: select parts, enter quantities, nest them true-shape onto any number of sheets drawn from a library of standard sizes, with per-part rotation freedom (locked / 90° / any), part-in-part filling of large cut-outs, and output as a printed/PDF report (cutting time, utilisation, scrap), DXF, and G-code.

## What already exists

| Piece | Where | State |
|---|---|---|
| Nesting engine | `packages/plugin-nest/src/nest.ts` | Bottom-left-fill on bounding-box candidates; holes ignored; one sheet size; one global rotation mode; 400-instance cap |
| Nest panel | `apps/web/src/plugins/builtins/nestPlugin.ts` | Sheet presets, spacing, "Nest" layer output |
| G-code | `packages/plugin-gcode/src/parse.ts` | Reader only — no writer |
| PDF | `packages/core/src/pdf.ts`, `entitiesPdf.ts` (`PdfBuilder`, `drawEntitiesToPdf`) | Tested, used by the truck planner |
| DXF out | `packages/core/src/dxfExport.ts` (`entitiesToDxf`) | Works |
| Print | `sketchor.ui.print(html, {fileName, pdf})` | On-page preview + PDF autosave to a folder |

Decision: **upgrade `plugin-nest` in place** into "Sheet Metal Nest" rather than adding a second nesting plugin. Keep `nestParts()` as a thin compatibility wrapper so existing tests stay green; migrate persisted state.

## Phase 0 — Foundations

- **N-01 Part extraction with holes.** From the selection, build `{outer, holes[], sourceIds, name}`. A closed shape inside another selected closed shape becomes its **hole**. Open line/arc chains get joined via existing `joinExplode.ts`.
- **N-02 Keep true arcs.** The engine works on flattened polygons (chord tolerance 0.05 mm), but the result stores only a **transform (rotation + translation) per instance**, applied to the original geometry — so DXF/PDF/G-code output keep real arcs/bulges.
- **N-03 Robust polygon ops.** Add `clipper2-js` (Boost license — fine for the public repo) for spacing offsets, Minkowski sums and clean-up, rather than stretching `offset.ts`.
- **N-04 SDK `ui.saveFile(name, data, filters)`.** Plugins have `filesystem.writeFile` but no save dialog. Additive `HOST_API_VERSION` bump; File System Access in the browser, native dialog in Tauri.

## Phase 1 — Engine (`packages/plugin-nest`)

- **N-10 True-shape nesting (no-fit polygons).** Replace bbox candidates with NFP (Minkowski difference) + inner-fit polygon of the sheet, placing on NFP vertices by gravity — the SVGnest/Deepnest approach. NFP cache keyed by (part A, rotation A, part B, rotation B).
- **N-11 Per-part rotation.** Locked `[0]` · 90° `[0,90,180,270]` · Any = step N° (default 15°, down to 1°) plus the part's minimum-bounding-box angle · optional *mirror allowed* flag.
- **N-12 Part-in-part.** After placing a part with holes, each hole (offset inward by spacing) becomes a free region; small parts try holes first. Per-part "allow inside holes" flag + minimum-hole-size threshold.
- **N-13 Multi-sheet stock inventory.** Job stock rows `{size, material, thickness, qty available | ∞, cost}`. When a sheet fills, open the next from inventory; after nesting, re-nest the last sheet on the smallest stock size that fits.
- **N-14 Search.** Quick / Normal / Thorough time budgets: multiple orderings/rotations (GA-lite), keep best, progress messages + cancel. Runs in the plugin worker. Raise the 400-instance cap with a perf test.
- **N-15 Tests.** No overlap + inside-sheet invariants (randomised), hole-fill case, locked rotation respected, inventory limits, unplaced reporting.

## Phase 2 — Panel + canvas output

- **N-20 Panel, 4 tabs.**
  - *Parts*: thumbnail, name, size, area, **qty**, rotation dropdown (Locked / 90° / Any), mirror, in-holes; "Add selection".
  - *Sheets*: standard-size library (same "Manage sizes…" pattern as the truck planner). Seeds: 48×96, 60×120, 48×120 in; 1250×2500, 1500×3000 mm; each with material + thickness. Job picks stock quantities from it.
  - *Settings*: spacing, edge margin, kerf, search mode, gravity direction.
  - *Results*: per-sheet cards + unplaced-parts warning; buttons for DXF / PDF / Print / G-code.
- **N-21 Canvas layout.** Sheets stacked on the `Nest` layer, titled ("Sheet 2/5 – 60×120 10ga A36"), numbered parts, each sheet grouped. Reports reflect the computed nest (truck-planner convention); a **Check nest** action flags overlaps after manual drags.
- **N-22 Metrics (`metrics.ts`, tested).**
  - *Utilisation* = net part area (outer − holes) ÷ sheet area, per sheet and job total.
  - *Scrap* split into **reusable remnant** (clean rectangle past the last part, above a minimum size) vs **true scrap** — area, weight (area × thickness × density) and cost.
  - *Cutting time* = cut length ÷ feed + pierces × pierce time + rapid length ÷ rapid speed, from an editable **cut table** (material, thickness, feed, pierce time, kerf). Seed values are **marked as estimates** — machine values win. Once Phase 4 lands, time comes from the real toolpath so report and program agree.

## Phase 3 — Report, PDF, DXF

- **N-30 PDF / print** via `PdfBuilder` + `drawEntitiesToPdf`: cover summary (job, sheets by size, total utilisation, scrap, cutting time, cost) · one page per sheet (drawing with part numbers + part/qty/rotation/area table) · parts summary (ordered vs placed). Same HTML + PDF to `ui.print`, so autosave works for free.
- **N-31 DXF export** per sheet or all sheets in one file; layers `SHEET`, `PARTS`, `HOLES`, `LABELS`, optional `TOOLPATH`; `$INSUNITS` set. Saved through N-04.

## Phase 4 — G-code (writer in `packages/plugin-gcode`)

- **N-40 Toolpath ordering.** Holes before outer, innermost-first for part-in-part, nearest-neighbour between parts; kerf compensation baked into the path (not G41/G42) so any controller works.
- **N-41 Lead-in / lead-out.** Line or arc, default on the longest straight edge from the scrap side; G2/G3 emitted from original bulges.
- **N-42 Post-processor profiles.** Generic laser, generic plasma, LinuxCNC, Mach3/4 — templates for header/footer, torch on/off, pierce dwell (G4), G20/G21, comment style. Editable and persisted.
- **N-43 Output + preview.** One `.nc` per sheet; toolpath preview on the canvas with dashed rapids.
- **N-44 Round-trip test.** Emit → parse with the existing `gcodeToEntities` → compare to the nest within tolerance.

## Phase 5 — Later

Common-line cutting · remnant library (save offcuts as stock) · micro-joints/tabs · save/reopen nest job file · part priority / due dates.

## Risks

- NFP robustness with arcs and slivers → flatten with fixed tolerance, Clipper clean-up, randomised overlap tests.
- "Any angle" cost explodes → step limit, NFP cache, time budget.
- Seed cut table won't match the real machine → marked as estimate, editable.

## Order of work

N-01 → N-02 → N-03 → N-10 → N-11 → N-13 → N-20/21/22 → N-12 → N-30/31 → N-40–44.

## Open questions (needed before Phase 4)

1. Laser, plasma or waterjet? (lead-ins, pierce handling, seed cut table)
2. Which controller/post dialect? (first real profile)
3. Default units — inches + US sheet sizes, or mm?
