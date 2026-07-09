<#
.SYNOPSIS
  Removes the Sketchor .dxf association written by register-dxf.ps1.
#>
$progId = "Sketchor.dxf"
$classes = "HKCU:\Software\Classes"

Remove-Item -Path "$classes\$progId" -Recurse -Force -ErrorAction SilentlyContinue

$owp = "$classes\.dxf\OpenWithProgids"
if (Test-Path $owp) {
  Remove-ItemProperty -Path $owp -Name $progId -ErrorAction SilentlyContinue
}

# If Sketchor was the default, clear it (leaves .dxf without a forced default).
$def = (Get-ItemProperty -Path "$classes\.dxf" -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
if ($def -eq $progId) {
  Remove-ItemProperty -Path "$classes\.dxf" -Name "(default)" -ErrorAction SilentlyContinue
}

Write-Host "Sketchor .dxf association removed."
