# Testing plan

A survey of what Sketchor's test suite covers today, what it doesn't, and the
test cases worth writing — ordered by how much a regression there would cost.

## Where things stand

`npm test` runs vitest over `packages/**/*.test.ts` and `apps/web/src/**/*.test.ts`
(`vitest.config.mts` aliases `@sketchor/core` and `@sketchor/plugin-sdk` to their
TypeScript sources, so tests exercise the same code the app builds).

Coverage is lopsided. Everything tested up to now is plugin-marketplace or
plugin-package code — manifest, signing, capabilityGuard, engine, pluginStore,
G-code parse, truck nesting — plus `pattern.ts`. The architectural core
(`SketchDocument`, `CommandBus`, `entities`, `sketchtext`, DXF/SVG import and
export, and every analysis module) had **zero** tests, and that is ~4,000 lines of
pure, framework-free, node-testable TypeScript.

Tiers 1–3 run on the plain `node` environment with one exception: `parseSvgText`
uses the browser's `DOMParser`, so `svg.test.ts` opts into jsdom with a
`// @vitest-environment jsdom` docblock (jsdom is a root devDependency; nothing
else in the suite needs it).

**Status:** Tiers 1 and 2 are implemented — `commands`, `document`, `entities`,
`sketchtext`, `dxf`, `dxfExport`, `svg`. Tiers 3–5 are still open.

### Defects these tests found

- **`SketchDocument.groupEntityIds` overflowed the stack on a group cycle.**
  Fixed with a `visited` set (Tier 1).
- **`parsePathD` looped forever on stray numbers after a `Z`.** `Z` consumes no
  arguments, so `M0 0 L10 0 Z 5 5` left the token index where it was and
  appended a point every pass — the process died of a heap OOM in about nine
  seconds. Reachable from any user-opened SVG. Fixed with a forward-progress
  guard (Tier 2).
- **A closed path gained a duplicate vertex on import.** Most exporters (ours
  included) write an explicit line back to the start *and* a `Z`, so the
  importer's single trailing-point trim left one behind, giving the shape a
  zero-length closing segment. It now drops every trailing duplicate (Tier 2).

---

## Tier 1 — The one architectural rule (critical) — DONE

CLAUDE.md's central rule is that every mutation goes through a `Command` and
every command derives its own inverse. Nothing verified that; an undo bug here
silently corrupts a user's drawing.

### `packages/core/src/commands.test.ts`

- Every command type applies correctly: `add-entity`, `delete-entities`,
  `move-entities`, `update-entity`, `transform-entities`, `group-entities`,
  `ungroup`, `add-constraint`, `remove-constraint`.
- **Round-trip property: `execute(c)` then `undo()` restores the document
  state, for every command type.** The single highest-value test in the repo —
  written table-driven so a new command type has to be added to it.
- `redo()` reproduces the post-command state, and recomputes the inverse so
  undo→redo→undo→redo cycles stay correct.
- `execute` clears the redo stack; `canUndo`/`canRedo` track correctly.
- `batch`: child inverses apply in reverse order (`unshift`); nested batches.
- Commands naming missing ids are no-ops with a coherent inverse: stale
  `delete-entities` id, `move-entities` on a deleted entity, `ungroup` of an
  unknown group, `remove-constraint` of an unknown constraint.
- `update-entity` on an id that doesn't exist yet inverts to a *delete*.
- `onChange` fires once per `execute`/`undo`/`redo`; the unsubscribe closure works.

Note: the round-trip comparison is order-insensitive (sorted by id). A
delete + undo re-inserts the entity at the end of the `Map`, so document
*order* is deliberately not part of the invariant.

### `packages/core/src/document.test.ts`

- `toJSON`/`fromJSON` round-trip with groups and constraints; `version: 2` is
  emitted; `fromJSON` tolerates missing `groups`/`constraints`.
- `revision` increments on every mutation (renderers dirty-check on it).
- `groupContaining`, `topLevelGroupOf` through a nested chain, and
  `topLevelGroupOf` with a parent cycle (it has a `seen` guard).
- `groupEntityIds` flattens nested groups and skips members that no longer exist.
- **`groupEntityIds` with a member cycle (g1 -> g2 -> g1).** This used to throw
  `RangeError: Maximum call stack size exceeded` — `topLevelGroupOf` guarded
  against cycles but `groupEntityIds` did not. Group ids arrive as `Command`
  values, so a plugin or a hand-edited file could trigger it. Fixed alongside
  this test with a `visited` guard.

### `packages/core/src/entities.test.ts`

- `translated` / `rotated` / `transformed` for all five entity types, including
  that they preserve `id`, `name`, `layer`, `color`, `fill`.
- `rotated` on an arc rotates `startAngle`/`endAngle` and leaves `radius` alone;
  `transformed` scales `radius`; polyline `bulges` survive both rotation and
  uniform scale unchanged (both documented invariants).
- `transformed` composition order (scale, then rotate, then translate) about a
  non-origin pivot.
- `polylineSegments`: open vs `closed` segment counts, bulge index alignment,
  the wrap-around segment, and an absent `bulges` array.
- `polylineLength`: bulged segments contribute arc length, not chord length
  (a semicircular bulge of 1 gives pi*r).
- `entityPoints` for a circle (four quadrants) and an arc (two endpoints);
  `centroidOfEntities([])` is the origin.
- `newEntityId` uniqueness across rapid calls.

### `packages/core/src/sketchtext.test.ts`

This is the AI-facing surface — `window.sketchor.applyCode` runs on it.

- Round-trip: `parseCode(toCode(doc))` reproduces every entity type's geometry.
- `assignNames`: explicit `name` wins; unnamed entities get L1/C1/A1/P1/PL1 in
  insertion order; **collision skipping** (an entity explicitly named `L2`
  pushes the next unnamed line to `L3`).
- `nextEntityName` returns the first free slot.
- `fmt`: 4-decimal rounding, and `-0` normalised to `0`.
- Parser rejections with the right line number: reserved keywords
  (`param`/`constraint`/`dim`), unknown statements, malformed rows with a
  helpful "expected:" message, duplicate names, non-positive circle/arc radii,
  polylines with fewer than two points.
- Parser acceptances: `#` comments, blank lines, the header, signed and
  scientific-notation numbers, the `cw` arc suffix, the `closed` polyline suffix.
- `diffToCommands`: unchanged code produces **zero** commands (an idle code panel
  must not dirty the document); a geometry edit produces `update-entity` keeping
  the same id; a new name adds; a removed name produces one `delete-entities`.
- `diffToCommands` preserves `layer` and a polyline's `bulges` across an edit.
- The documented lossiness: a bulged polyline round-tripped through code comes
  back straightened — pinned so the loss stays deliberate.

---

## Tier 2 — File IO (high; this is where data loss lives) — DONE

### `packages/core/src/dxfExport.test.ts` (+ round-trip against `dxf.ts`)

Note on precision: coordinates are rounded to six decimals *in file units*, so
the error back in millimetres scales with the declared unit — half a micron for
a millimetre file, ~1.5e-4 mm once the numbers are written as feet. The
round-trip tests assert against that bound rather than a fixed epsilon.

- `entitiesToDxf` -> `parseDxf` round-trip preserves geometry and layers for
  every entity type.
- **The `scale` + `insUnits` pairing**: exporting as inches
  (`insUnits=1, scale=1/25.4`) and re-importing yields the original millimetre
  coordinates. The doc comment warns that a mismatch silently produces a file
  25.4x the wrong size — exactly the bug a test should own.
- HEADER `$EXTMIN`/`$EXTMAX` match `boundsOf`; the TABLES/LAYER section lists
  every layer in use, exactly once.
- An empty entity list still produces a parseable DXF.

### `packages/core/src/dxf.test.ts`

864 lines, the most complex file in the repo.

- `$INSUNITS` scaling: in/ft/cm/m/mm files all land as mm; unspecified (0) or
  unmapped codes are left unscaled.
- LWPOLYLINE with bulges: correct per-segment `bulges` indices, `closed` from
  group code 70.
- Legacy `POLYLINE`/`VERTEX`/`SEQEND` stitching.
- ARC angle convention (degrees, CCW); CIRCLE / LINE / POINT basics.
- ELLIPSE flattening; SPLINE via de Boor (a known cubic with clamped uniform
  knots), including a rational/weighted case.
- TEXT/MTEXT lowered to strokes via `font.ts`; `cleanMtext` strips formatting.
- INSERT/BLOCK: insertion point, rotation, x/y scale; nested blocks; and the
  `MAX_BLOCK_DEPTH` cutoff on a self-referencing block (a hang guard).
- `DxfImportReport`: unsupported types listed and deduped; `KNOWN_IGNORED` types
  never surface as warnings.
- Robustness: empty, truncated, CRLF, unknown sections — return a result, never
  throw.
- `boundsOf`: arcs use `arcExtentPoints` (an arc bulging past its endpoints
  bounds correctly); an empty list gives `null`.

### `packages/core/src/svg.test.ts`

- `entitiesToSvgDocument` -> `parseSvgText` round-trip. Note what this actually
  guarantees: import undoes the Y flip but cannot recover the viewBox origin, so
  a round-trip preserves shape and size *exactly* and lands the drawing
  translated by a fixed offset (`padding - minX`, `-(maxY + padding)`). The
  module docstring's "round-trips exactly" means dimensionally, not positionally.
- Export is a rendering, so some records degrade on the way back and the tests
  pin that deliberately: a point returns as a small circle, an arc and a bulged
  polyline segment return as tessellated polylines.
- `parseTransform`: `translate`, `scale`, `rotate`, `matrix`, and a composed
  chain; `matScale` for stroke/radius scaling.
- `arcEndpointToCenter`: SVG `A` to centre/angles across all four
  large-arc x sweep combinations.
- `parsePathD`: `M/L/H/V/C/Q/A/Z`, relative variants, implicit repeated
  coordinates, subpaths; unsupported commands warn rather than throw.
- `escapeXml` on names/layers containing `&<>"`.

---

## Tier 3 — Analysis and geometry (medium-high, cheapest to write)

### `geometry.test.ts`
`closestPointOnSegment` on a zero-length segment; `distToSegment` past both ends;
`shortestTurn`/`reduceToHalfTurn` at their inclusive boundaries (+/-pi, +/-pi/2);
`arcSweep` with equal start and end (a full turn, matching DXF); `angleInSweep`
epsilon behaviour; `bulgeToArc` for zero/tiny/negative bulge and coincident
points (null); `arcExtentPoints` picking up only the quadrants actually swept.

### `heal.test.ts` (high — mutating fixes, real geometry risk)
- `scanForIssues`: a near-coincident cluster of three or more endpoints; a
  dangling end; a T-junction against a segment interior; `crossLayer` off
  suppressing cross-layer pairs and on allowing them.
- `linearEps` / `angularEpsDeg` just inside vs just outside tolerance.
- `fixMerge` snaps endpoints to `issue.location`; a line collapsing to zero
  length becomes a delete; the `seen` guard when both ends of one line land in
  the same cluster.
- `fixJoin` replaces two collinear lines with one spanning the far ends, keeping
  `name`/`layer`; falls back to merge when the cluster isn't exactly two entities.
- `fixTJunction` splits the target into two lines meeting at `projected`.
- **Idempotence: `fixAllIssues` applied as a batch leaves `scanForIssues` empty**,
  and a second pass doesn't oscillate. The highest-value test in this file.
- Undo of a heal `batch` restores the document exactly (ties back to Tier 1).

### `duplicates.test.ts`
Stacked circles inside/outside tolerance; differing radii not merged; collinear
overlapping lines detected but collinear-disjoint ones not; transitive clustering
(A~B, B~C gives one group); `fixDuplicate` keeps `entityIds[0]`; label pluralisation.

### `crossings.test.ts`
An X crossing is reported; a shared-endpoint corner is not (the eps guard);
parallel and collinear-overlapping lines give null; a T-touch exactly at an
endpoint is excluded; issue ids are stable.

### `regions.test.ts`
A circle and a closed polyline are each their own region; four lines chained
endpoint-to-endpoint form a loop and an open chain does not; a vertex shared by
three or more edges excludes those edges (the documented limitation);
bulge/arc segments tessellate; `pointInPolygon` on edges and vertices;
`regionContainingPoint` returns the innermost (smallest-area) hit.

### `boxSelect.test.ts`
`window` requires full containment and `crossing` accepts a touch, for all five
entity types; a circle whose ring crosses the box but whose centre is outside;
degenerate/empty bounds never qualify.

### `connectivity.test.ts`
A closed rectangle yields no free-endpoint ids; opening one corner flags the two
lines; the tolerance boundary.

### `font.test.ts`
`textToStrokes` honours `height` scaling, advance width, and rotation about the
insertion point; lowercase is upper-cased; unknown glyphs are skipped without
throwing; the empty string gives no strokes.

### `groups.test.ts`
`resolveSelection` returns the top-level group normally but the entity itself
when that group is "entered"; an ungrouped entity returns itself;
`wholeGroupSelected` returns an id only for an exact whole-group selection.

---

## Tier 4 — Web app, pure helpers (medium; still node-testable)

- **`viewport/view.test.ts`** — `worldToScreen`/`screenToWorld` are exact inverses
  (Y flip included); `zoomAt` keeps the world point under the cursor fixed and
  clamps at 0.001/1000 without drifting the origin; `fitToBounds` centres,
  respects padding, and survives a zero-size bounds; `gridStep` walks the
  1/2/5x10^n ladder across decades and below scale 1.
- **`units.test.ts`** — `formatLength`/`formatArea` for all five units (the area
  factor is squared, easy to get wrong); 3-place rounding and `-0` to `0`;
  `displayUnitToDxfCode` <-> `dxfCodeToDisplayUnit` round-trip; unmapped DXF
  codes give null; `loadDisplayUnit` returns null when `localStorage` throws or
  holds garbage.
- **`viewport/snapping.test.ts`** — every `SnapKind` wins when it should
  (endpoint over on-line, midpoint, centre, quadrant, intersection, origin, grid
  fallback); `excludeIds` skips the entity being dragged; the snap radius scales
  with `view.scale`; priority between two equidistant candidates.
- **`plugins/host/registry|install|hostMethods`** — `withStatus` marks
  installed/update-available; `installFromRegistry` rejects a bad signature or an
  unknown key; `assertCommands` rejects non-command payloads (a sandbox
  boundary — arguably high on security grounds); `dispatchCall` on an unknown
  method; plugin storage keys are namespaced so one plugin can't read another's.
- **`browser/thumbnail.test.ts`** — `isDrawingFile` extension matching; `fileToSvg`
  dispatches by extension and doesn't throw on malformed content.

---

## Tier 5 — Rust and CI (medium importance, cheap)

- **`native/dxf-parse`** — the single source of truth for both the Windows
  thumbnailer and the macOS Quick Look extension, with no `#[test]` anywhere,
  and `samples/gasket.dxf` already sitting there as a fixture. Cases: `parse`
  yields the expected Line/Circle counts; arcs and polylines flatten to
  segments; `project` fits to box with ~10% padding, applies the Y-flip, and
  survives a zero-extent drawing without dividing by zero; garbage input returns
  an empty vec rather than panicking. This is the code that can't be debugged
  interactively (see CLAUDE.md's Quick Look gotchas), so tests pay off fastest here.
- **CI** — `.github/workflows/release.yml` never runs `npm test`. A `test.yml` on
  push/PR running `npm test`, `cargo test -p dxf-parse` and `tsc --noEmit` is what
  makes everything above load-bearing; untested-in-CI tests rot.

---

## Deliberately deferred (needs new infrastructure)

`state/store.ts` (906 lines), `io/drawingFile.ts`, `uiManager.ts`,
`updateService.ts` and the `.tsx` components need jsdom plus
`localStorage`/`fetch`/File System Access API mocks, and `store.ts` is a
module-level singleton with a session proxy that is awkward to reset between
tests. There is genuinely test-worthy pure logic buried in there —
`measurementText`, `computeStraightenTransform`, `uniqueOverlayLayerName`,
`isNewer` (semver compare), `hiddenLayerSet` — but the right move is to extract
those into a pure module first rather than stand up jsdom for them.
