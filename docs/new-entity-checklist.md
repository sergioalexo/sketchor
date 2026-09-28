# Adding a new entity type — checklist

Since Z-01 every entity `type` is one registered `EntityKind`
(`packages/core/src/kinds/`). Generic code asks the registry instead of
switching on `type`, so a new kind works *approximately everywhere* the day it
registers, and exactly wherever it supplies its own method.

## The short version

1. Add the interface to `packages/core/src/entities.ts` and to the `Entity`
   union. The build now fails in every exhaustive `switch` — that is the point.
2. Write `kinds/<name>.ts` exporting an `EntityKind` and register it from
   `kinds/builtin.ts` (or, for plugin kinds, `registerKind` at load).
   **Only `tessellate(e, tol)` is required.** It returns runs of points
   (closed shapes repeat their first point).
3. Give it what makes it exact, in this order of value: `bounds`, `transform`
   (affine; return `null` if the result isn't expressible), `path` (curves for
   `intersect.ts`), `snaps`, `hitDistance`, `grips`/`applyGrip`.
4. Fix the compile errors (list below), then the run-time-only sites (second
   list) that no compiler will find.
5. Tests — see the bottom.

## What the registry already covers (no per-type code needed)

| Consumer | Uses |
|---|---|
| `boundsOf` (dxf.ts), fit, thumbnails | `bounds` → tessellation |
| `entityPoints` (centroids, snapping anchors) | tessellation vertices |
| `translated` / `rotated` / `transformed` (entities.ts) | `transform` |
| `mirrored` (mirror.ts), pattern (pattern.ts), nest `mirrorX` | `transform` |
| `stretchEntity` | any tessellated point in the box → whole entity moves |
| window/crossing select (boxSelect.ts), lasso/fence (`outlineOf`) | tessellation |
| click hit test (`Viewport.tsx` → `kindHitDistance`), group-member pick (`editTools.ts`) | `hitDistance` → distance to tessellation |
| snapping (`viewport/snapping.ts`) | `snaps` (feature + midpoint), `path` (intersection, nearest, perpendicular, tangent, extension) |
| grips (`gripsOf` / `applyGrip`) | `grips` → one centre move-grip |
| canvas drawing (`renderer.ts drawEntity`) | tessellation at ½ px |
| SVG export + thumbnail SVG (`svg.ts`, `dxf.ts entitiesToSvg`), PDF (`entitiesPdf.ts`), R12 DXF (`dxfExport.ts`) | tessellation → polylines |

## Sites that still need a deliberate decision per type

Places that need a decision (a `switch` with no `default` fails the build; a
`default` that falls back to the registry compiles — read the fallback and
decide whether it is good enough; `if/else` chains such as `sketchtext.ts` and
`clipboard.ts` are invisible to the compiler):

- `packages/core/src/sketchtext.ts` — the sketch-code DSL: `toCode`, `parseCode`,
  `diffToCommands` (an edit must carry over fields the DSL cannot express).
- `packages/core/src/dxf.ts` — import, and the block-insert mapping switch (default leaves the entity unmoved).
- `packages/core/src/dxfExport.ts` — the R12 writer's `entityDxf` (default = tessellated polyline).
- `packages/core/src/svg.ts` — import shapes; export `paint()` (closed/fill rules).
- `packages/core/src/entitiesPdf.ts` — `paintOf` (closed/fill rules).
- `packages/core/src/clipboard.ts` — copy/paste serialisation.
- `packages/core/src/solver/model.ts` — `paramCount`, `pushValues`, `pointOf`,
  `withValues` (default = no parameters, so the solver ignores it), and
  `solver/residuals.ts` if constraints should reach it.
- `packages/core/src/constraintBuilder.ts` (`attachPoints`),
  `constraintDisplay.ts` (`entityAnchor`, `pointRefAt`), `grips.ts`
  (`gripPointRef`) — where a constraint may attach.
- `packages/core/src/pattern.ts` (`centerOf`), `stretch.ts`, `mirror.ts`.
- `packages/plugin-nest/src/materialize.ts` and nest `extractParts` — nest
  works from tessellation; check a new kind produces a sensible part.
- `apps/web/src/properties/PropertiesPanel.tsx` — `Geometry` editor (default = none).
- `apps/web/src/state/store.ts` `entityMeasurement`; `apps/web/src/tools/*`.
- Plugin read model: `packages/plugin-sdk` (`entityPoints` etc.) and the two
  first-party plugins that serialise entities by hand:
  `plugins/builtins/svgExportPlugin.ts`, `patternPlugin.ts`.

Not compiler-visible — grep for `type === "image"` / `case "image"` and read
every hit; an `if/else` chain whose last `else` silently means "polyline" is
how v0.6.0 shipped five bugs:

```bash
grep -rn 'case "image"\|type === "image"' packages apps --include=*.ts --include=*.tsx
```

Persistence and native readers:

- `.sketchor` documents are JSON: `SketchDocument.toJSON/fromJSON` carry the
  entity as-is. A reader that meets an unknown `type` must skip it, not fail.
  (There is no native `.sketchor` reader in this repo today; if one is added —
  e.g. a shell/thumbnail extension — it must ignore unknown top-level keys and
  unknown entity types.)
- `native/dxf-thumbnailer` and `native/dxf-quicklook` read **DXF**, not
  `.sketchor`; a new kind only matters there if it is written to DXF (F-04).
- `entitiesToDxf` R12 flattens unknown kinds to polylines; the AC1032 writer
  (X-01) needs a real entity writer per kind.

## Tests a new kind must add (from CLAUDE.md, restated)

- `commands.test.ts` `CASES` table only if it adds a new **Command** type.
- `translated`/`rotated`/`transformed` preserving id/name/layer/colour/fill.
- A sketch-code round trip (`toCode` → `parseCode` → `diffToCommands`, same id).
- DXF and SVG round trips (write, read back, compare geometry).
- A tessellation test: bounds contain the tessellation and the exact bounds
  exceed it by no more than the tolerance (see `kinds/registry.test.ts`).
- If it supplies `transform`: agrees with the tessellation of the same map
  applied point-wise, and returns `null` for maps it cannot express.
