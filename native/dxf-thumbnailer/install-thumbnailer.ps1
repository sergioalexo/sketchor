<#
.SYNOPSIS
  Builds and registers the Sketchor DXF thumbnail provider so Windows
  Explorer shows previews for .dxf files.

.DESCRIPTION
  1. Builds the crate in release mode (needs the Rust MSVC toolchain).
  2. Copies the DLL to a stable per-user location (registration records
     the DLL path, so it must not move afterwards).
  3. Registers it with regsvr32. The provider writes to HKEY_CLASSES_ROOT,
     which redirects to HKCU\Software\Classes when run without elevation,
     so no administrator rights are required for a per-user install.
  4. Clears the Explorer thumbnail cache and restarts Explorer so the new
     previews appear.

.PARAMETER SkipBuild
  Register the already-built DLL without rebuilding.

.PARAMETER NoRestart
  Do not clear the cache / restart Explorer (do it yourself later).
#>
param(
  [switch]$SkipBuild,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$crateDir = $PSScriptRoot

if (-not $SkipBuild) {
  Write-Host "Building dxf-thumbnailer (release)..."
  Push-Location $crateDir
  try {
    & cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
  } finally {
    Pop-Location
  }
}

$built = Join-Path $crateDir "target\release\dxf_thumbnailer.dll"
if (-not (Test-Path $built)) { throw "DLL not found at $built" }

$installDir = Join-Path $env:LOCALAPPDATA "Sketchor"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$installed = Join-Path $installDir "dxf_thumbnailer.dll"

# Unregister an older copy first (ignore errors), then replace the file.
if (Test-Path $installed) {
  & regsvr32.exe /s /u "$installed" 2>$null
}
Copy-Item $built $installed -Force
Write-Host "Installed to $installed"

& regsvr32.exe /s "$installed"
if ($LASTEXITCODE -ne 0) {
  Write-Warning "regsvr32 returned $LASTEXITCODE. Try running this script elevated if previews do not appear."
} else {
  Write-Host "Registered DXF thumbnail provider."
}

if (-not $NoRestart) {
  Write-Host "Clearing thumbnail cache and restarting Explorer..."
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Remove-Item "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db" -Force -ErrorAction SilentlyContinue
  Start-Process explorer.exe
}

Write-Host "Done. Open a folder of .dxf files in Explorer (Large icons view) to see previews."
