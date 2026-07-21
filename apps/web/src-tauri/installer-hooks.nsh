; Sketchor Explorer shell extensions -- NSIS installer hooks.
; -----------------------------------------------------------
; The .sketchor and .dxf thumbnail/preview handlers are COM in-proc servers
; (shell-ext\*.dll, staged by native/build-shell-extensions.ps1 and bundled as
; resources). These hooks register them at install time and unregister them at
; uninstall time, so users never have to run native/*/install*.ps1 themselves.
;
; regsvr32 calls each DLL's DllRegisterServer, which writes its keys under
; HKCU\Software\Classes -- succeeds without elevation for a per-user install.
;
; The DLLs are 64-bit, so they MUST be registered by the 64-bit regsvr32:
; the NSIS installer stub is 32-bit, so on x64 Windows we disable WOW64 file
; redirection first, otherwise $SYSDIR\regsvr32.exe would launch the 32-bit
; regsvr32 and land the COM registration in the Wow6432Node view that 64-bit
; Explorer never reads.

!include "x64.nsh"

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering Sketchor Explorer thumbnail handlers..."
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::Exec '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\shell-ext\sketchor_shell.dll"'
  Pop $0
  nsExec::Exec '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\shell-ext\dxf_thumbnailer.dll"'
  Pop $0
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
  ; SHCNE_ASSOCCHANGED (0x08000000): tell Explorer the file associations changed
  ; so it refreshes icons/thumbnails for .sketchor and .dxf without a reboot.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Unregistering Sketchor Explorer thumbnail handlers..."
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::Exec '"$SYSDIR\regsvr32.exe" /s /u "$INSTDIR\shell-ext\sketchor_shell.dll"'
  Pop $0
  nsExec::Exec '"$SYSDIR\regsvr32.exe" /s /u "$INSTDIR\shell-ext\dxf_thumbnailer.dll"'
  Pop $0
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
