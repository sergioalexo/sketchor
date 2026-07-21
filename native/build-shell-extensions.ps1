<#
.SYNOPSIS
  Builds the two Sketchor Explorer shell-extension DLLs and stages them where
  the Tauri bundler picks them up as installer resources.

.DESCRIPTION
  Run automatically by `tauri build` via the `beforeBuildCommand` hook in
  tauri.conf.json (before the Rust app is compiled, so tauri-build sees the
  staged DLLs when it validates bundle.resources), so a packaged Sketchor
  installer *ships* the thumbnail
  handlers and registers them itself (see apps/web/src-tauri/installer-hooks.nsh).
  End users no longer run native/*/install*.ps1 by hand.

  Can also be run standalone to refresh the staged copies. Paths are resolved
  from $PSScriptRoot, so the working directory does not matter.

.PARAMETER SkipBuild
  Stage the already-built release DLLs without rebuilding (needs a prior build).
#>
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"

# $PSScriptRoot = <repo>\native ; stage into the Tauri app's src-tauri tree.
$repoRoot = Split-Path $PSScriptRoot -Parent
$stageDir = Join-Path $repoRoot "apps\web\src-tauri\shell-ext"

$crates = @(
  @{ Name = "sketchor-shell";  Dll = "sketchor_shell.dll" },
  @{ Name = "dxf-thumbnailer"; Dll = "dxf_thumbnailer.dll" }
)

New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

foreach ($c in $crates) {
  $crateDir = Join-Path $PSScriptRoot $c.Name

  if (-not $SkipBuild) {
    Write-Host "Building $($c.Name) (release)..."
    Push-Location $crateDir
    try {
      & cargo build --release
      if ($LASTEXITCODE -ne 0) { throw "cargo build failed for $($c.Name)" }
    } finally {
      Pop-Location
    }
  }

  $built = Join-Path $crateDir "target\release\$($c.Dll)"
  if (-not (Test-Path $built)) {
    throw "DLL not found at $built (run without -SkipBuild first)."
  }
  Copy-Item $built (Join-Path $stageDir $c.Dll) -Force
  Write-Host "Staged $($c.Dll) -> $stageDir"
}

Write-Host "Shell-extension DLLs staged for bundling."
