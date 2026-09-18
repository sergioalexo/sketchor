# Builds the patched occt-import-js wasm (see README.md in this folder).
# Usage: powershell -File build.ps1   (needs cmake + ninja on PATH; emsdk in ./emsdk)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not (Test-Path "src\occt\src")) { throw "src/occt is empty - see README.md (clone the pinned OCCT commit first)" }
if (-not (Test-Path "emsdk\upstream\emscripten")) { throw "emsdk not installed - see README.md" }

# emsdk_env.ps1 puts emcc/emcmake on PATH for this process only - and only
# after `emsdk activate`, so be explicit for a fresh checkout too.
& "$here\emsdk\emsdk_env.ps1" | Out-Null
$env:EMSDK = "$here\emsdk"
$env:PATH = "$here\emsdk\upstream\emscripten;$here\emsdk;$env:PATH"

python "$here\patch_importer.py"
if ($LASTEXITCODE -ne 0) { throw "patch failed" }

$build = "$here\build"
emcmake cmake -S "$here\src" -B $build -G Ninja -DCMAKE_NINJA_FORCE_RESPONSE_FILE=ON -DEMSCRIPTEN=1 -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { throw "configure failed" }
cmake --build $build --parallel
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$out = "$here\..\..\apps\web\vendor\occt-import-js"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$build\Release\occt-import-js.wasm" $out -Force
# The glue is UMD (module.exports / global). Vite only pre-bundles CommonJS
# from node_modules, so give it a real ES module: in module scope neither
# `exports` nor `define` exist, the UMD tail is skipped, and the factory is
# left in `occtimportjs` for the default export.
$glue = Get-Content "$build\Release\occt-import-js.js" -Raw
$glue = $glue.TrimEnd() + "`nexport default occtimportjs;`n"
[IO.File]::WriteAllText("$out\occt-import-js.mjs", $glue)
Get-ChildItem $out
Write-Host "Done."
