<#
.SYNOPSIS
  Unregisters and removes the Sketchor DXF thumbnail provider.
#>
$installed = Join-Path $env:LOCALAPPDATA "Sketchor\dxf_thumbnailer.dll"
if (Test-Path $installed) {
  & regsvr32.exe /s /u "$installed"
  Write-Host "Unregistered $installed"
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Remove-Item "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\thumbcache_*.db" -Force -ErrorAction SilentlyContinue
  Start-Process explorer.exe
  Remove-Item $installed -Force -ErrorAction SilentlyContinue
  Write-Host "Removed."
} else {
  Write-Host "Nothing to remove ($installed not found)."
}
