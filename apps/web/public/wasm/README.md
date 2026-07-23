# wasm/libredwg-web.wasm

Vendored from `@mlightcad/libredwg-web`'s `wasm/libredwg-web.wasm`, copied
here (rather than imported relative to `node_modules`) so it resolves to a
stable URL through a production Vite build regardless of deployment base
path. See `apps/web/src/browser/dwgImport.ts`.

**GPL-3.0.** This binary is compiled from GNU LibreDWG. See `/NOTICE.md` at
the repo root for what that means for this project.

If you bump the `@mlightcad/libredwg-web` dependency version, re-copy this
file from the new package's `wasm/libredwg-web.wasm`.

**Known redundancy:** the production build also emits a second, unused copy
of this file under `dist/assets/` (~9.5MB). That's Rollup's static
`new URL("libredwg-web.wasm", import.meta.url)` asset detection firing on
the package's own glue code — it bundles the file unconditionally just
because the pattern appears in source, even though `dwgImport.ts` always
passes an explicit `wasmDir` that redirects loading here instead. Avoiding
it would need a custom Vite plugin to strip that reference from a
third-party package; not worth it for an installer-size optimization.
