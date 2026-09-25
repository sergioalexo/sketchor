# Polylines + Sheet Metal Nest fixes — plan

Status: planned (2026-09-25). Item IDs are stable — reference them in commits.
`P-xx` = polyline fidelity, `NF-xx` = nesting fixes. Follows on from
`sheet-metal-nesting-plan.md` (N-xx) — this is a bug-and-usability pass on
top of it, not a new engine.

## What the user reported

1. Polylines don't look like real polylines: Sketchor shows **many points**
   where another CAD program opening the same file shows **far fewer**.
2. Nesting: can't add a **whole file** as a part.
3. Nesting: selecting some lines, adding them, then adding another selection
   **deletes the first one**.
4. Nesting: the nest **failed**, and so did Print report.
5. Nesting should put the result **on the workspace** and **print a PDF**,
   the way the Truck Load Planner does.

## Root causes found in the code

### Polylines (1)

Every curve that isn't a line, circle, arc or bulged polyline is
**tessellated on import and the original curve is thrown away**:

| Source | Where | What it becomes |
|---|---|---|
| DXF `SPLINE` | `packages/core/src/dxf.ts` `splinePoints()` | polyline of `min(200, max(16, 12 × controlPoints))` points |
| DXF `ELLIPSE` | `dxf.ts` `ellipseToLines()` | polyline of up to 128 points |
| SVG `C/S/Q/T` curves | `svg.ts` path parser | straight segments (curve lost entirely, with a warning) |

So a spline another program draws from 6 control points arrives as a
~72-point polyline. It then:

- shows a **grip on every vertex** when selected (`grips.ts` → `polyline`
  returns one grip per point), which is the "so many points" the user sees;
- **exports** as a 72-vertex `LWPOLYLINE` (`dxfExport.ts`), so the file
  gets heavier every round-trip and other programs now also see the dots;
- feeds 72+ vertices per curve into nesting's NFP maths (see NF-05).

Also lossy today: the sketch-code view drops polyline bulges (pinned by a
test as intended), and the native thumbnailer (`native/dxf-parse`) flattens
curves on its own — both need checking once curves are real.

### Nest parts disappearing (3) — confirmed bug

The panel (`nestPlugin.ts` `PANEL_HTML`) keeps its **own copy** of the whole
persisted state from `init`, including `workingParts` (empty at that
point). Every edit on the Sheets or Settings tab calls `persist()`, which
posts `{type:"persist", state}` — and the plugin does
`state = asState(msg.state)`, **replacing its `workingParts` with the
panel's stale copy**. So: add parts → change spacing, kerf, a sheet size,
anything → the parts list is wiped on the next refresh.

### Nest "failed" + no report (4)

Most likely a knock-on of the bug above: with `workingParts` wiped, Nest
answers "Add one or more parts first.", no `lastNest` is stored, and Print
answers "Nothing to print — nest some parts first." Two other ways to fail
that need handling regardless:

- DXF lines that *almost* meet (gap larger than `joinEntities`' tolerance)
  never close, so `extractParts` finds no part → "Select one or more closed
  shapes first." with no hint which gap is open.
- Dense tessellated curves (above) multiply the NFP work per rotation; on
  "Any" rotation a spline-heavy part can make a search time out or throw,
  and the thrown message is shown raw.

## Plan

### Phase 1 — Nest bugs (ship first, small)

- **NF-01 Stop the panel wiping parts.** The panel never sends
  `workingParts`; the plugin's `persist` handler merges only the
  settings/stock fields into its own state. Test: add a part, persist a
  settings change, the part survives. *(Confirmed root cause of report 3.)*
- **NF-02 Adding is always additive.** A new selection that shares entities
  with an existing part **updates** that part instead of creating a
  near-duplicate; everything else is appended. Panel shows "Added 2 ·
  updated 1". Parts already in the list get a subtle highlight on the
  canvas so it's obvious what's in the job.
- **NF-03 Open-contour help.** When a selection has open chains, say how
  many and mark the open ends on the canvas (same violet markers as the
  crossings detector). Add a **Join tolerance** setting (default = current
  `JOIN_TOL`, allow up to e.g. 0.5 mm) so real-world DXFs with small gaps
  close.
- **NF-04 Never fail silently.** Every "nest" exit path posts a specific,
  human reason: which part is bigger than every sheet, which part has no
  closed outline, instance cap hit, search cancelled/timed out. Per-part
  problems show on that part's row, not just in the summary.

### Phase 2 — Real polylines (P-xx)

- **P-01 `spline` entity type.** Keep the curve as data —
  `{controlPoints, knots, weights?, degree, fitPoints?, closed}` — and
  tessellate **only for drawing/hit-testing**, adaptively by screen
  tolerance, so it's smooth at any zoom. Follow CLAUDE.md's "new entity
  type" checklist (transforms, sketch code, DXF + SVG round-trips, the five
  if/else chains noted in v0.6.0, renderer, snapping, box select, grips).
- **P-02 Grips show the real handles.** Spline: its control (or fit)
  points. Polyline: its real vertices — which after P-01/P-03 are few.
- **P-03 "Simplify polyline" + fit arcs.** For files that *already* contain
  dense `LWPOLYLINE`s (other programs' exports): Douglas–Peucker to a
  tolerance, then fit runs of points to arcs (stored as bulges). Offered as
  a command on the selection and as an import option ("Simplify dense
  polylines"), with the before/after vertex count in the import report.
- **P-04 DXF export writes what came in.** A spline exports as `SPLINE`,
  not a 72-vertex `LWPOLYLINE`. Round-trip test: import → export → import
  gives the same control points; vertex/entity counts match the source.
- **P-05 Ellipses and SVG curves.** `ELLIPSE` → either a real `ellipse`
  entity or a bulge-arc approximation (4–8 arcs, not 128 points); SVG
  `C/S/Q/T` → spline (cubic Bézier is exactly a degree-3 spline) instead of
  a straight line.
- **P-06 Display audit.** Check the native thumbnailer, the file-browser
  thumbnails, sketch code and print/PDF all show the same curve.
  Acceptance: the user's own file opens with the **same vertex/control-point
  count as the program they compare against**.

### Phase 3 — Whole files + workspace view + PDF (like the Load Planner)

- **NF-05 Nest on simplified geometry.** Parts are flattened from the real
  curves at the nester's chord tolerance, then simplified (P-03's
  Douglas–Peucker) before NFP — fewer vertices, faster and steadier search.
  Output still uses the original entities (N-02 transform-per-instance).
- **NF-06 Add whole files.** "Add files…" button (multi-select DXF / DWG /
  SVG / `.sketchor`), plus "Send to Nest" from the file browser's
  multi-select bar, plus "Add everything on this layer / drawing". Each
  file becomes **one part** named after the file (all closed loops →
  outer + holes, N-01 rules), quantity editable. File parts aren't on the
  canvas, so `WorkingPartEntry` becomes a union:
  `{kind:"doc", sourceIds}` | `{kind:"file", name, entities}` (entities
  stored in plugin storage). Needs a small SDK capability for picking files
  from a plugin (`ui.openFiles`, host API bump, additive).
- **NF-07 Result on the workspace.** After Nest: sheets drawn side by side
  (as now), parts numbered, a summary block on the canvas, and the view
  **zooms to fit the result**. Option to put the nest in a **new tab**
  ("Nest – <job>") so the source drawing stays clean.
- **NF-08 Print / PDF like the Load Planner.** Job name + notes fields,
  the same autosave-folder control (`ui.printFolder` / `ui.pickPrintFolder`),
  and the report rendered **from the Nest layers on the canvas** ("one
  drawing, three renderings", as the planner does), so a manual drag after
  nesting shows up in the PDF too. Cover page + one page per sheet with the
  numbered part table (already built in N-30 — reuse it).

## Order and size

| Order | Items | Size | Why this order |
|---|---|---|---|
| 1 | NF-01, NF-02, NF-04 | S | Confirmed data-loss bug; unblocks Nest + Print today |
| 2 | NF-03 | S | Most likely remaining "failed" cause on real DXFs |
| 3 | P-03, P-02 | M | Fixes existing dense files and grip clutter without a new entity type |
| 4 | P-01, P-04, P-05, P-06 | L | Real splines end to end |
| 5 | NF-05 … NF-08 | M | Whole-file nesting and the Load-Planner-style output |

## Open questions for the user

1. Send one DXF that shows the "too many points" problem, and name the
   program you compare it in — that becomes the P-06 acceptance test.
2. Nest result: in the **same drawing** (current behaviour) or a **new tab**?
3. Whole-file parts: should every closed loop in a file be one part (outer +
   holes), or should a file with several separate shapes become several parts?
