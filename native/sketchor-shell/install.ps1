<#
.SYNOPSIS
  Builds and registers the Sketchor Explorer shell extensions so Windows
  Explorer shows icon thumbnails AND a reading-pane preview for .sketchor
  drawings.

.DESCRIPTION
  1. Builds the crate in release mode (needs the Rust MSVC toolchain).
  2. Copies the DLL and the file-type icon to a stable per-user location
     (registration records the DLL path, so it must not move afterwards).
  3. Registers the COM server with regsvr32.
       - Thumbnail (icon) provider: works per-user, no admin needed
         (HKEY_CLASSES_ROOT writes redirect to HKCU\Software\Classes).
       - Preview-pane handler: the extra machine-wide "PreviewHandlers"
         list entry only takes effect when this script runs ELEVATED.
         Run from an admin PowerShell to get the preview pane too.
  4. Registers a DefaultIcon for .sketchor files.
  5. Clears the Explorer thumbnail cache and restarts Explorer.

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

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator)
}

if (-not $SkipBuild) {
  Write-Host "Building sketchor-shell (release)..."
  Push-Location $crateDir
  try {
    & cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
  } finally {
    Pop-Location
  }
}

$built = Join-Path $crateDir "target\release\sketchor_shell.dll"
if (-not (Test-Path $built)) { throw "DLL not found at $built" }

$installDir = Join-Path $env:LOCALAPPDATA "Sketchor"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$installed = Join-Path $installDir "sketchor_shell.dll"

# Unregister an older copy first (ignore errors), then replace the file.
if (Test-Path $installed) {
  Start-Process regsvr32.exe -ArgumentList "/s /u `"$installed`"" -Wait -ErrorAction SilentlyContinue
}
Copy-Item $built $installed -Force
Write-Host "Installed DLL to $installed"

# Copy the file-type icon next to the DLL and register it.
$iconSrc = Join-Path $crateDir "..\..\apps\web\src-tauri\icons\icon.ico"
$iconDst = Join-Path $installDir "sketchor.ico"
if (Test-Path $iconSrc) {
  Copy-Item $iconSrc $iconDst -Force
  $progIcon = "HKCU:\Software\Classes\Sketchor.Drawing\DefaultIcon"
  New-Item -Path $progIcon -Force | Out-Null
  Set-ItemProperty -Path $progIcon -Name "(default)" -Value "$iconDst,0"
  Write-Host "Registered file icon $iconDst"
} else {
  Write-Warning "Icon not found at $iconSrc - skipping DefaultIcon."
}

# Register via a child process so the exit code is captured reliably
# (`& regsvr32 /s` does not always surface $LASTEXITCODE).
$reg = Start-Process regsvr32.exe -ArgumentList "/s `"$installed`"" -PassThru -Wait
if ($reg.ExitCode -ne 0) {
  throw ("regsvr32 failed with exit code $($reg.ExitCode) " +
    "(5 = access denied). Registration did NOT complete.")
}
Write-Host "Registered COM server (thumbnail + preview handler)."

# The registration writes to HKCU\Software\Classes; confirm the thumbnail
# handler key actually landed. This catches a silent DllRegisterServer
# failure that would otherwise leave Explorer showing only the DefaultIcon.
$thumbKey = "HKCU:\Software\Classes\.sketchor\ShellEx\{E357FCCD-A995-4576-B01F-234630154E96}"
if (-not (Test-Path $thumbKey)) {
  throw "Thumbnail handler key missing after registration: $thumbKey"
}
Write-Host "Verified thumbnail handler registration."

if (Test-Admin) {
  Write-Host "Elevated: preview-pane handler registered machine-wide."
} else {
  Write-Warning ("Not elevated: the ICON THUMBNAIL is installed (per-user), but the " +
    "PREVIEW PANE needs the machine-wide handler list. Re-run this script from an " +
    "elevated PowerShell to enable the preview pane.")
}

if (-not $NoRestart) {
  Write-Host "Clearing thumbnail cache and restarting Explorer..."
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Remove-Item "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db" -Force -ErrorAction SilentlyContinue
  Start-Process explorer.exe
}

Write-Host "Done. Open a folder of .sketchor files in Explorer (Large icons + preview pane on)."
