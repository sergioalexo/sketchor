# occt-import-js, Sketchor build

`apps/web/vendor/occt-import-js/` is Sketchor's own build of
[occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade
7.6.1 compiled to WebAssembly, LGPL-2.1 — see `NOTICE.md`). The npm package
is not used. This folder holds everything needed to reproduce it.

## Why a fork

Upstream resolves the name and colour of every mesh **and every face** with
`XCAFDoc_ShapeTool::Search`, which walks all top-level labels of the
document (and, for a face, registers a brand-new sub-shape label each
time). That's O(faces × parts) and dominates the import of any assembly.
`patch_importer.py` replaces it with one index built after transfer
(`LabelIndex` in `importer-xcaf.cpp`, exact shape match with a
location-agnostic TShape fallback). Release is also built `-O2` instead of
upstream's `-Oz` (about 25% faster on small files; wasm 7.6 → 12 MB).

Measured on real Onshape exports, same output (mesh count, names, colours,
triangles, hierarchy) from both builds:

| file                  | upstream 0.0.23 | this build |
|-----------------------|----------------:|-----------:|
| 0.7 MB, 127 parts     |          0.92 s |     0.66 s |
| 3.2 MB, 1,659 parts   |         29.0 s  |     3.0 s  |
| 6.0 MB, 3,012 parts   |         93.1 s  |     4.4 s  |

## Rebuilding (Windows)

One-time setup:

```powershell
scoop install cmake ninja            # or any cmake + ninja on PATH
cd native/occt-import-js-build
git clone --depth 1 https://github.com/kovacsv/occt-import-js src
# The OCCT submodule points at git.dev.opencascade.org, which no longer
# resolves; fetch the pinned commit from the GitHub mirror instead:
git -C src ls-tree HEAD occt        # -> the pinned commit
git clone --filter=blob:none --no-checkout https://github.com/Open-Cascade-SAS/OCCT.git src/occt
git -C src/occt checkout <pinned commit>
git clone --depth 1 https://github.com/emscripten-core/emsdk.git emsdk
emsdk\emsdk.bat install 3.1.69      # the version upstream pins
emsdk\emsdk.bat activate 3.1.69
```

Then:

```powershell
powershell -File build.ps1
```

`build.ps1` applies `patch_importer.py` (idempotent), switches Release to
`-O2`, configures with Ninja + response files (the include list overflows
the Windows command-line limit otherwise), builds with all cores (~10 min
on 20 cores, ~4,800 translation units), and copies the result to
`apps/web/vendor/occt-import-js/` — the `.wasm` and the glue re-emitted as
an ES module (`.mjs`, `export default occtimportjs`) so Vite can import it
from outside `node_modules`.

`src/`, `emsdk/` and `build/` are git-ignored (several GB).

## Updating upstream

Re-clone `src`, re-run. If `patch_importer.py` reports a pattern it can't
find, upstream changed `importer-xcaf.cpp` — re-apply the idea by hand:
build `LabelIndex` once in `ImporterXcaf::LoadFile`, make `XcafFace` and
`XcafShapeMesh` look shapes up there instead of calling `Search`.
