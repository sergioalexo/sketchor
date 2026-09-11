; Sketchor Explorer shell extension -- NSIS installer hooks.
; -----------------------------------------------------------
; The .dxf / .step / .iges thumbnail handler is a COM in-proc server
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
;
; Two things learned the hard way (0.14.2):
;
; 1. Explorer keeps the DLL mapped once it has drawn a thumbnail, so an
;    update cannot overwrite it -- the installer silently kept the old file
;    and re-registered *that*. A mapped DLL can still be RENAMED, so the
;    pre-install hook parks the old one as .old (deleted on reboot) and the
;    fresh copy lands at the real name. Explorer picks it up once it drops
;    the idle old module (DllCanUnloadNow) or at the next sign-in.
;
; 2. Windows 11 Explorer only consults a thumbnail handler for an extension
;    if HKLM\Software\Classes\<ext>\ShellEx\{E357FCCD-...} exists -- even
;    though the handler and the value it resolves to may live in HKCU. A
;    per-user installer can't write HKLM, so the post-install hook asks for
;    elevation ONCE (a UAC prompt) to create those keys; declining just
;    leaves Explorer showing icons, and the app offers the same step later
;    (see `enable_explorer_previews` in src/main.rs). Silent installs -- the
;    in-app updater -- never prompt.

!include "x64.nsh"
!include "LogicLib.nsh"

!define SHELLEX_THUMB "{E357FCCD-A995-4576-B01F-234630154E96}"
!define SKETCHOR_THUMB_CLSID "{6F9E2A31-7C4B-4D8E-9A1F-2B3C4D5E6F70}"

!macro NSIS_HOOK_PREINSTALL
  ; Park a DLL Explorer may still have loaded so File can write the new one.
  ${If} ${FileExists} "$INSTDIR\shell-ext\dxf_thumbnailer.dll"
    Delete "$INSTDIR\shell-ext\dxf_thumbnailer.dll.old"
    Rename "$INSTDIR\shell-ext\dxf_thumbnailer.dll" "$INSTDIR\shell-ext\dxf_thumbnailer.dll.old"
    Delete /REBOOTOK "$INSTDIR\shell-ext\dxf_thumbnailer.dll.old"
  ${EndIf}
!macroend

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

  ; Machine-wide "this extension has a thumbnail handler" markers (see note 2).
  ; One UAC prompt, only when interactive and only if they're not there yet.
  ${IfNot} ${Silent}
    ClearErrors
    ReadRegStr $1 HKLM "Software\Classes\.step\ShellEx\${SHELLEX_THUMB}" ""
    ${If} ${Errors}
      DetailPrint "Enabling Explorer previews for 3D models (administrator approval)..."
      ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c reg add "HKLM\Software\Classes\.step\ShellEx\${SHELLEX_THUMB}" /ve /d "${SKETCHOR_THUMB_CLSID}" /f & reg add "HKLM\Software\Classes\.stp\ShellEx\${SHELLEX_THUMB}" /ve /d "${SKETCHOR_THUMB_CLSID}" /f & reg add "HKLM\Software\Classes\.iges\ShellEx\${SHELLEX_THUMB}" /ve /d "${SKETCHOR_THUMB_CLSID}" /f & reg add "HKLM\Software\Classes\.igs\ShellEx\${SHELLEX_THUMB}" /ve /d "${SKETCHOR_THUMB_CLSID}" /f & reg add "HKLM\Software\Classes\.dxf\ShellEx\${SHELLEX_THUMB}" /ve /d "${SKETCHOR_THUMB_CLSID}" /f' SW_HIDE
      ClearErrors
    ${EndIf}
  ${EndIf}

  ; SHCNE_ASSOCCHANGED (0x08000000): tell Explorer the file association changed
  ; so it refreshes icons/thumbnails without a reboot.
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
  ; The HKLM marker keys stay: removing them needs elevation, and a marker
  ; for a CLSID that no longer exists is inert (Explorer shows the icon).
  Delete "$INSTDIR\shell-ext\dxf_thumbnailer.dll.old"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
