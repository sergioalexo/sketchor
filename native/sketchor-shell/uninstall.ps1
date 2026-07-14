<#
.SYNOPSIS
  Unregisters and removes the Sketchor Explorer shell extensions.

.DESCRIPTION
  Run elevated to also remove the machine-wide preview-handler list entry
  that an elevated install created.
#>
$installDir = Join-Path $env:LOCALAPPDATA "Sketchor"
$installed = Join-Path $installDir "sketchor_shell.dll"

if (Test-Path $installed) {
  & regsvr32.exe /s /u "$installed"
  Write-Host "Unregistered $installed"
  Remove-Item $installed -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "DLL not found at $installed (already removed?)."
}

# Remove the DefaultIcon / ProgID we set via PowerShell.
Remove-Item "HKCU:\Software\Classes\Sketchor.Drawing" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $installDir "sketchor.ico") -Force -ErrorAction SilentlyContinue

Write-Host "Clearing thumbnail cache and restarting Explorer..."
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db" -Force -ErrorAction SilentlyContinue
Start-Process explorer.exe
Write-Host "Removed."
