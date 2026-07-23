; Sketchor Explorer shell extension -- NSIS installer hooks.
; -----------------------------------------------------------
; The .dxf thumbnail/preview handler is a COM in-proc server
; (shell-ext\dxf_thumbnailer.dll, staged by native/build-shell-extensions.ps1
; and bundled as a resource). These hooks register it at install time and
; unregister it at uninstall time, so users never have to run
; native/dxf-thumbnailer/install*.ps1 themselves.
;
; regsvr32 calls the DLL's DllRegisterServer, which writes its keys under
; HKCU\Software\Classes -- succeeds without elevation for a per-user install.
;
; The DLL is 64-bit, so it MUST be registered by the 64-bit regsvr32:
; the NSIS installer stub is 32-bit, so on x64 Windows we disable WOW64 file
; redirection first, otherwise $SYSDIR\regsvr32.exe would launch the 32-bit
; regsvr32 and land the COM registration in the Wow6432Node view that 64-bit
; Explorer never reads.

!include "x64.nsh"

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering Sketchor Explorer thumbnail handler..."
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::Exec '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\shell-ext\dxf_thumbnailer.dll"'
  Pop $0
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
  ; SHCNE_ASSOCCHANGED (0x08000000): tell Explorer the file association changed
  ; so it refreshes icons/thumbnails for .dxf without a reboot.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Unregistering Sketchor Explorer thumbnail handler..."
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::Exec '"$SYSDIR\regsvr32.exe" /s /u "$INSTDIR\shell-ext\dxf_thumbnailer.dll"'
  Pop $0
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
