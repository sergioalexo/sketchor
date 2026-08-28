# dxf-quicklook

A macOS **Quick Look thumbnail extension** for `.dxf` files — so DXF drawings
render as little geometry previews on their Finder icons, the macOS counterpart
of `native/dxf-thumbnailer/` on Windows.

It's a `QLThumbnailProvider` app extension (`.appex`). Parsing the DXF and
fitting it to the thumbnail box happen in shared Rust (`native/dxf-parse`, the
same crate the Windows thumbnailer uses) exposed over a small C ABI
(`ffi/`); the Swift side (`Sources/`) only strokes the projected lines and
circles with Core Graphics, matching the Windows rasteriser's dark background
(`#1E1F22`) and light strokes (`#C7D0DC`).

Because the geometry model is shared, macOS previews match Windows exactly:
lines and circles, with arcs and polylines flattened to line segments.

## Layout

```
ffi/                    Rust staticlib: C ABI over dxf-parse (dxf_project / dxf_projection_free)
Sources/bridging.h      C declarations, imported into Swift
Sources/DxfRender.swift Core Graphics drawing shared by the extension and the sample tool
Sources/ThumbnailProvider.swift  the QLThumbnailProvider itself
Sources/render_sample.swift      dev tool: render a DXF to PNG without registering
Info.plist              NSExtension config + QLSupportedContentTypes
ext.entitlements        app-sandbox entitlements
build-quicklook-macos.sh   builds DxfThumbnail.appex (no Xcode needed)
render-sample.sh           builds + runs the sample renderer
```

## Build

Needs the Rust toolchain plus Swift/`codesign` from the Command Line Tools
(full Xcode is **not** required):

```bash
./build-quicklook-macos.sh            # -> build/DxfThumbnail.appex (ad-hoc signed)
./build-quicklook-macos.sh --sign "Developer ID Application: …"   # for distribution
```

Currently arm64 only; a universal build (`lipo` arm64 + x86_64) is a follow-up.

## Inspect the output without registering

```bash
./render-sample.sh                         # built-in sample -> sample.png
./render-sample.sh drawing.dxf out.png 512 # a real file at 512px
```

## Install / test in Finder

The extension is delivered inside `Sketchor.app`, not standalone — macOS only
discovers app extensions through a host app registered with Launch Services. So:

```bash
# after `tauri build` produced Sketchor.app:
../embed-quicklook-macos.sh /path/to/Sketchor.app
```

That copies the `.appex` into `Sketchor.app/Contents/PlugIns/`, signs it, and
re-signs the app. Then move the app to `/Applications` (registers it), and:

```bash
pluginkit -mAvvv -p com.apple.quicklook.thumbnail | grep -i sketchor   # discovered?
mdls -name kMDItemContentType drawing.dxf   # must print com.sketchor.dxf
qlmanage -r && qlmanage -r cache            # reset Quick Look caches
qlmanage -t -s 512 -o /tmp drawing.dxf      # render one directly
```

Then open a folder of `.dxf` in Finder's gallery or icon view.

## The exact-UTI requirement

macOS has no built-in Uniform Type Identifier for DXF, and Quick Look only
routes a file to this extension if the UTI in `QLSupportedContentTypes` (Info.plist)
**exactly** matches the file's resolved type — a parent like `public.data` is not
enough. The host app exports `com.sketchor.dxf` for `.dxf`
(`apps/web/src-tauri/Info.plist`), and the extension lists that same string.

If another installed app already claims `.dxf` with a different UTI, Launch
Services may resolve `.dxf` to that one instead — check with `mdls` and add the
reported UTI to `QLSupportedContentTypes`.

## Status / caveats

- The Rust→FFI→Core Graphics render path is verified (see `render-sample.sh`);
  the Finder/Quick Look end of it requires a built, embedded, Launch-Services-
  registered app to exercise.
- Distribution additionally needs Developer ID signing + notarization (separate
  from the minisign updater keys) and a rebuilt DMG after embedding.
- Only `.dxf` is handled; SVG already gets some native Quick Look rendering, and
  DWG is out of scope.
