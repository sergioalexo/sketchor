# Third-party notices

## DWG import — GPL-3.0

Sketchor imports `.dwg` files using [`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web),
a WebAssembly build of [GNU LibreDWG](https://www.gnu.org/software/libredwg/),
compiled with DWG *writing* disabled (Sketchor never produces `.dwg` files —
only DXF and SVG). The wasm binary is vendored at `apps/web/public/wasm/`
and loaded at runtime by `apps/web/src/browser/dwgImport.ts`.

**This dependency is licensed GPL-3.0.** LibreDWG itself is GPL-3.0 (or
later); `@mlightcad/libredwg-web` inherits that license. This is a real
project-level licensing decision, not a formality:

- Distributing Sketchor's compiled application together with this wasm
  binary is very likely to place the *combined work* under GPL-3.0 terms —
  including the obligation to make corresponding source available to
  recipients. Whether that reaches Sketchor's own source specifically
  depends on how "combined work" is interpreted for a bundled wasm module,
  which is a real legal question, not something this note can settle.
- If Sketchor is meant to carry a different license (MIT, proprietary,
  etc.), that needs to be reconciled with this dependency before shipping
  a build that includes it — e.g. by making DWG import an optional,
  separately-distributed plugin, or by sourcing a non-GPL DWG reader
  instead.

This tradeoff was made deliberately (DWG has no open specification, and
the realistic alternatives are this GPL library or a paid commercial SDK)
but it should be revisited with actual legal input before a wide release,
not treated as settled by this note.

## STEP / IGES import — LGPL-2.1

Sketchor reads `.step`/`.stp` and `.iges`/`.igs` 3D models with
[`occt-import-js`](https://github.com/kovacsv/occt-import-js), a WebAssembly
build of [Open CASCADE Technology](https://dev.opencascade.org/) that
tessellates B-rep geometry into triangle meshes. Both are **LGPL-2.1**
(OCCT with its usual linking exception). The wasm binary is bundled from the
npm package at build time and loaded in a Web Worker
(`apps/web/src/model3d/occt.worker.ts`).

LGPL is materially different from the GPL note above: it permits use in a
differently-licensed application as long as the library itself stays
replaceable and its source (and license) is made available. Sketchor uses it
unmodified, dynamically loaded as a separate `.wasm` file, and ships this
notice — which is the usual way to satisfy those terms. Nothing here changes
Sketchor's own AGPL-3.0 license.

three.js (MIT) renders the result.
