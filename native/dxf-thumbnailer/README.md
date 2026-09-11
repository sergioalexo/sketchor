# dxf-thumbnailer

A Windows Explorer **thumbnail provider** for `.dxf` drawings and
`.step`/`.stp`/`.iges`/`.igs` 3D models — so they render as little previews
directly on their file icons in Explorer, the same way images do.

DXF is parsed and stroked here (`native/dxf-parse`). Models work in two
tiers (`src/model.rs`): the preview Sketchor itself rendered, mirrored to
`%LOCALAPPDATA%\Sketchor\thumbs\<sha256>.png` whenever the app renders one
(so Explorer shows the exact shaded isometric picture for any model you have
opened or browsed past), and otherwise — for STEP — a wireframe read straight
out of the file's B-rep edges by `native/step-wire`, assembly transforms
resolved, in milliseconds and without a geometry kernel. IGES has no text
fallback and gets the mirrored preview or the plain icon.

It's an in-process COM server (`IThumbnailProvider` + `IInitializeWithFile`)
written in Rust with `windows-rs`. It parses the DXF and rasterises it with
GDI, sharing the visual intent (dark background, light strokes, fit-to-box)
with Sketchor's in-app thumbnails. The DXF parser mirrors the TypeScript one
in `@sketchor/core` (`src/dxf.rs`).

## Install

Needs the Rust MSVC toolchain (`rustup`, `x86_64-pc-windows-msvc`).

```powershell
# from this folder
./install-thumbnailer.ps1
```

That builds the DLL, copies it to `%LOCALAPPDATA%\Sketchor\`, registers it
with `regsvr32`, and refreshes Explorer. Registration is per-user (writes
redirect to `HKCU\Software\Classes`), so no admin rights are needed. If
previews don't show up, re-run the script from an elevated PowerShell.

Then open a folder of `.dxf` files in Explorer and switch to **Large icons**.

### Uninstall

```powershell
./uninstall-thumbnailer.ps1
```

## How it registers

`DllRegisterServer` writes:

```
HKCR\CLSID\{6F9E2A31-7C4B-4D8E-9A1F-2B3C4D5E6F70}\InprocServer32  -> DLL path (Apartment)
HKCR\CLSID\{...}\DisableProcessIsolation = 1        (allows IInitializeWithFile)
HKCR\.dxf\ShellEx\{E357FCCD-A995-4576-B01F-234630154E96} -> the CLSID above
```

The `{E357FCCD-…}` GUID is Windows' `IThumbnailProvider` category.

## Status / caveats

- The crate **compiles cleanly** and exports the four required COM entry
  points (`DllGetClassObject`, `DllRegisterServer`, `DllUnregisterServer`,
  `DllCanUnloadNow`), verified with `dumpbin /exports`.
- The **visual output in Explorer has not been machine-verified** here — that
  needs a real interactive desktop and an Explorer restart. Treat the first
  run as a smoke test; if a preview looks off, the rasteriser lives entirely
  in `src/render.rs` and is easy to tweak.
- Explorer aggressively caches thumbnails. After changing the DLL, re-run the
  installer (it clears `thumbcache_*.db`) or run `cleanmgr`.
- Only `.dxf` (ASCII) is handled. Binary DXF and DWG are out of scope.
