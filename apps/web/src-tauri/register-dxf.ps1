<#
.SYNOPSIS
  Registers Sketchor as a handler for .dxf files for the current user.

.DESCRIPTION
  Writes a ProgId under HKCU\Software\Classes and adds it to the .dxf
  "Open with" list. No administrator rights required. This is a dev/manual
  alternative to the NSIS installer, which registers the association
  automatically via the fileAssociations config in tauri.conf.json.

.PARAMETER ExePath
  Path to Sketchor.exe. Defaults to the release build output.

.PARAMETER SetDefault
  Also make Sketchor the default app for .dxf (otherwise it is only added
  to the "Open with" menu).

.EXAMPLE
  .\register-dxf.ps1 -ExePath "C:\Program Files\Sketchor\Sketchor.exe" -SetDefault
#>
param(
  [string]$ExePath = "$PSScriptRoot\target\release\sketchor.exe",
  [switch]$SetDefault
)

if (-not (Test-Path $ExePath)) {
  Write-Error "Sketchor.exe not found at '$ExePath'. Build it first (npm run tauri build) or pass -ExePath."
  exit 1
}
$ExePath = (Resolve-Path $ExePath).Path

$progId = "Sketchor.dxf"
$classes = "HKCU:\Software\Classes"

New-Item -Path "$classes\$progId\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$classes\$progId" -Name "(default)" -Value "DXF Drawing"
Set-ItemProperty -Path "$classes\$progId\DefaultIcon" -Name "(default)" -Value "`"$ExePath`",0"
Set-ItemProperty -Path "$classes\$progId\shell\open\command" -Name "(default)" -Value "`"$ExePath`" `"%1`""

# Add to the .dxf "Open with" list without hijacking the current default.
New-Item -Path "$classes\.dxf\OpenWithProgids" -Force | Out-Null
Set-ItemProperty -Path "$classes\.dxf\OpenWithProgids" -Name $progId -Value ([byte[]]@()) -Type Binary

if ($SetDefault) {
  Set-ItemProperty -Path "$classes\.dxf" -Name "(default)" -Value $progId
  Write-Host "Sketchor set as the DEFAULT handler for .dxf."
} else {
  Write-Host "Sketchor added to the 'Open with' menu for .dxf. Use -SetDefault to make it the default."
}

Write-Host "Registered: $ExePath"
Write-Host "You may need to sign out/in or restart Explorer for the change to show everywhere."
