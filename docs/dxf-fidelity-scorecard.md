# DXF fidelity scorecard (X-12)

Run `npm run dxf:scorecard` (needs Python + `pip install ezdxf`). It writes a
corpus of drawings with the AC1032 writer (R12 for one), then for each:

1. **ezdxf audit** — `tools/dxf-audit/audit.py` (errors and auto-fixes);
2. **Sketchor re-import** — `parseDxf` of the written text, diffed on entity
   signatures (type, name, layer, colour, linetype, lineweight, construction,
   fill), plus groups, constraints, params, block names/bodies and units;
3. **LibreCAD** and **ODA round-trip** — manual columns (see below).

The files land in `tools/dxf-audit/out/` (git-ignored) so they can be opened
in other CAD programs. The script exits non-zero on any problem.

## Last run (2026-10-09, after X-05/X-08/X-09/X-11)

| Drawing | What | ezdxf audit | Sketchor re-import |
|---|---|---|---|
| 01-lines-circles | lines, circles, names, layers | 0 errors | identical |
| 02-curves | arc, ellipse, spline, bulged polyline | 0 errors | identical |
| 03-cyrillic-text | Ukrainian text and layer names | 0 errors | identical |
| 04-style | true colours, linetypes, lineweights, construction, fill | 0 errors | identical |
| 05-blocks | nested block, attributes, insert | 0 errors | identical |
| 06-hatches | solid, pattern, gradient hatches | 0 errors | identical |
| 07-groups-constraints | nested groups, constraints, params | 0 errors | identical |
| 08-inches | inch drawing (INSUNITS 1) | 0 errors | identical |
| 09-many-layers | 200 layers | 0 errors | identical |
| 10-r12-flat | R12 flat geometry | 0 errors | identical (types only; R12 has no names) |
| 11-points-polys | point, closed polyline | 0 errors | identical |

The first run found one real defect: ezdxf auto-fixed "entity in group does not
have group as persistent reactor" for every grouped entity. AutoCAD wants each
member to list its groups in `102 {ACAD_REACTORS`; the writer now does.

## What is not covered yet

- **LibreCAD column** — LibreCAD is installed on the dev PC but has no
  scriptable open/screenshot path. Manual checklist per file in
  `tools/dxf-audit/out/`: open, no error dialog, layers/colours/linetypes
  match, groups listed, blocks present, text readable. Record results here.
- **ODA round-trip** (DXF to DWG to DXF) — needs `ODAFileConverter` (X-10,
  optional, not installed).
- **Corpus gaps** — dimensions (D-xx), leaders, MTEXT formatting, layouts and
  viewports, images and dynamic blocks have no drawing yet; add one per
  feature as each lands (the plan says X-03..X-12 land with each feature).
- The "LibreCAD's own export of the same drawings loses X, we lose 0" goal
  line needs the LibreCAD column first.

## Import coverage sweep (X-03)

`PROD_FILES` (local folder, see the git-ignored `docs/local-samples.md`; counts
only, nothing copied): 11,653 DXFs, 0 parse errors, 745,876 entities, about 13 s
total parse time. Unit source: 9,160 `$INSUNITS`, 2,098 `$MEASUREMENT`, 368
inferred, 21 none, 6 conflicting. Geometry types seen: LINE, ARC, CIRCLE,
SPLINE, LWPOLYLINE, ELLIPSE, POINT, POLYLINE, MTEXT, INSERT. Still reported
unsupported: DIMENSION (2 files), OLE2FRAME (1), ACIDBLOCKREFERENCE (1; kept as
foreign data), and about 9 files whose misaligned group codes produce garbage
record names (corrupt files). SOLID/TRACE/3DFACE (1 file) were the only
unsupported geometry type; they now import as closed outlines. Zero unsupported
geometry types remain, apart from DIMENSION, which the dimensions track owns.
