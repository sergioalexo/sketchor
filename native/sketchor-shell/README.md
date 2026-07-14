# sketchor-shell

Windows Explorer shell extensions for Sketchor's native **`.sketchor`**
drawings. One Rust DLL (`windows-rs`) exposing two COM handlers:

- **Icon preview** — an `IThumbnailProvider` that renders the drawing onto
  the file's icon, the same way images get thumbnails.
- **Preview pane** — an `IPreviewHandler` that draws a large, live picture
  in Explorer's reading pane when a `.sketchor` file is selected.

Both parse the document with the same `.sketchor` JSON reader
(`src/model.rs`, mirroring `SketchDocument.toJSON()` in `@sketchor/core`)
and rasterise it with the same GDI code (`src/render.rs`, dark canvas /
light strokes / fit-to-box), so the icon and the pane always match. This is
the Sketchor-native counterpart to the `.dxf`-only `dxf-thumbnailer`.

## The `.sketchor` format

The on-disk file is exactly the JSON Sketchor saves:

```json
{
  "version": 1,
  "entities": [
    { "id": "e1", "type": "line",   "a": {"x":0,"y":0}, "b": {"x":100,"y":0} },
    { "id": "e2", "type": "circle", "center": {"x":50,"y":30}, "radius": 15 }
  ]
}
```

Unknown entity types and extra fields are ignored, so newer drawings still
thumbnail on an older shell.

## Install

Needs the Rust MSVC toolchain (`rustup`, `x86_64-pc-windows-msvc`).

```powershell
# from this folder — per-user (icon thumbnails):
./install.ps1

# for the preview PANE as well, run from an *elevated* PowerShell:
#   (right-click PowerShell -> Run as administrator)
./install.ps1
```

It builds the DLL, copies it and the file icon to `%LOCALAPPDATA%\Sketchor\`,
registers with `regsvr32`, sets a file-type icon, and refreshes Explorer.

- The **icon thumbnail** registers per-user — no admin needed (writes to
  `HKCU\Software\Classes`).
- The **preview pane** additionally needs an entry in the machine-wide
  `HKLM\...\PreviewHandlers` list, which only gets written when the script
  runs elevated. Non-elevated installs get thumbnails but not the pane.

Then open a folder of `.sketchor` files in Explorer, switch to **Large
icons**, and turn on the **Preview pane** (View menu / `Alt+P`).

### Uninstall

```powershell
./uninstall.ps1     # run elevated to also drop the machine-wide entry
```

## How it registers

`DllRegisterServer` writes (through `HKEY_CLASSES_ROOT`, which redirects to
`HKCU\Software\Classes` per-user, or `HKLM\Software\Classes` when elevated):

```
CLSID\{17697024-…}\InprocServer32          -> DLL (Apartment)   thumbnail provider
CLSID\{17697024-…}\DisableProcessIsolation = 1
CLSID\{B3B58581-…}\InprocServer32          -> DLL (Apartment)   preview handler
CLSID\{B3B58581-…}\AppID                    = {534A1E02-…}       (prevhost surrogate)
CLSID\{B3B58581-…}\DisableLowILProcessIsolation = 1
.sketchor            (default)              = Sketchor.Drawing   (ProgID)
Sketchor.Drawing\ShellEx\{E357FCCD-…}      = {17697024-…}       IThumbnailProvider
Sketchor.Drawing\ShellEx\{8895B1C6-…}      = {B3B58581-…}       IPreviewHandler
```

and, best-effort in HKLM (elevated only):

```
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\PreviewHandlers\{B3B58581-…} = "Sketchor Preview Handler"
```

The category GUIDs are Windows' well-known interface categories:
`{E357FCCD-…}` = `IThumbnailProvider`, `{8895B1C6-…}` = `IPreviewHandler`.

## Verify without Explorer

```powershell
cargo run --release --example render_sample -- "" out.png 256
```

renders the built-in sample document straight through the GDI rasteriser to
`out.png` — the exact pixels Explorer would show on the icon.

## Status / caveats

- Compiles cleanly and exports the four required COM entry points
  (`DllGetClassObject`, `DllRegisterServer`, `DllUnregisterServer`,
  `DllCanUnloadNow`), verified with `dumpbin /exports`. Rasteriser output
  verified via `render_sample`.
- **Not yet machine-verified live in Explorer** — that needs an interactive
  desktop, an Explorer restart, and (for the pane) an elevated install.
  Treat the first run as a smoke test; the whole picture is drawn in
  `src/render.rs` and is easy to tweak.
- Explorer aggressively caches thumbnails; the installer clears
  `thumbcache_*.db`. After changing the DLL, re-run the installer.
- Only the current `.sketchor` schema (lines + circles) draws; other entity
  kinds are skipped until `model.rs`/`render.rs` learn them.
```
