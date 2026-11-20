; The setup of the native Sondra (Rust, GPUI), beside the Electron app — own name, own folder, own entry in
; Apps & Features, so both can be installed and nothing of the other is touched. Built by the workflow
; „Native“ (job app):
;
;   makensis -DVERSION=1.2.3 -DEXE=sondra.exe -DFFMPEG=ffmpeg-dir -DOUT=Sondra-Nativ-Setup.exe sondra.nsi
;
; What it does: for all users (Program Files, one elevation), the program, FFmpeg beside it (Sondra looks
; there first), the licence texts, a Start-menu entry, an entry in Apps & Features with its uninstaller, the
; ending .sondra-liste (the lists people send each other) and „Öffnen mit“ for media — Sondra is added to the
; list of programs an extension offers and takes over none. Silent with /S; /D=folder chooses the folder.
; Never signed here: the unsigned setup is what Windows SmartScreen asks about, and the Store package comes later.

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !error "-DVERSION=x.y.z is needed"
!endif
!ifndef EXE
  !error "-DEXE=path to sondra.exe is needed"
!endif
!ifndef FFMPEG
  !error "-DFFMPEG=folder with ffmpeg.exe and ffprobe.exe is needed"
!endif
!ifndef LICENSES
  !define LICENSES "..\..\desktop\lizenzen"
!endif
!ifndef OUT
  !define OUT "Sondra-Nativ-Setup.exe"
!endif

!define NAME "Sondra (nativ)"
!define FOLDER "Sondra Nativ"
!define KEY "SondraNativ"
!define ARP "Software\Microsoft\Windows\CurrentVersion\Uninstall\${KEY}"

Name "${NAME}"
OutFile "${OUT}"
InstallDir "$PROGRAMFILES64\${FOLDER}"
InstallDirRegKey HKLM "Software\${KEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
ShowInstDetails nevershow
BrandingText "Sondra ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1031 "ProductName" "Sondra (nativ)"
VIAddVersionKey /LANG=1031 "FileDescription" "Sondra, Setup der nativen Fassung"
VIAddVersionKey /LANG=1031 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1031 "LegalCopyright" "MIT-Lizenz"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "German"

; „Öffnen mit“: listed for the extension, taking none of them over.
!macro open_with EXT
  WriteRegStr HKLM "Software\Classes\${EXT}\OpenWithProgids" "Sondra.NativDatei" ""
  WriteRegStr HKLM "Software\Classes\Applications\sondra.exe\SupportedTypes" "${EXT}" ""
!macroend
!macro forget_open_with EXT
  DeleteRegValue HKLM "Software\Classes\${EXT}\OpenWithProgids" "Sondra.NativDatei"
!macroend
!macro each_extension MACRO
  !insertmacro ${MACRO} ".mp3"
  !insertmacro ${MACRO} ".wav"
  !insertmacro ${MACRO} ".flac"
  !insertmacro ${MACRO} ".ogg"
  !insertmacro ${MACRO} ".opus"
  !insertmacro ${MACRO} ".m4a"
  !insertmacro ${MACRO} ".aac"
  !insertmacro ${MACRO} ".mp4"
  !insertmacro ${MACRO} ".m4v"
  !insertmacro ${MACRO} ".mov"
  !insertmacro ${MACRO} ".webm"
  !insertmacro ${MACRO} ".mkv"
  !insertmacro ${MACRO} ".avi"
  !insertmacro ${MACRO} ".png"
  !insertmacro ${MACRO} ".jpg"
  !insertmacro ${MACRO} ".jpeg"
  !insertmacro ${MACRO} ".webp"
  !insertmacro ${MACRO} ".gif"
!macroend

; The program is 64-bit, so its entries go into the 64-bit view of the registry (the setup itself is 32-bit,
; and would otherwise write below WOW6432Node, where Apps & Features of a 64-bit program does not look).
Function .onInit
  SetRegView 64
FunctionEnd
Function un.onInit
  SetRegView 64
FunctionEnd

; An update runs this setup silently with /relaunch (see `updater.rs`): once it is in place, Sondra opens again.
!insertmacro GetParameters
!insertmacro GetOptions
Function .onInstSuccess
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/relaunch" $1
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\sondra.exe"'
  ${EndIf}
FunctionEnd

Section "Sondra" SecMain
  SetShellVarContext all
  SetOutPath "$INSTDIR"
  File "/oname=sondra.exe" "${EXE}"
  File "${FFMPEG}\ffmpeg.exe"
  File "${FFMPEG}\ffprobe.exe"
  SetOutPath "$INSTDIR\Lizenzen"
  File "${LICENSES}\*.txt"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Deinstallieren.exe"

  CreateDirectory "$SMPROGRAMS\${FOLDER}"
  CreateShortCut "$SMPROGRAMS\${FOLDER}\${NAME}.lnk" "$INSTDIR\sondra.exe" "" "$INSTDIR\sondra.exe" 0

  ; Apps & Features, with the folder (the store and Windows' own checks look for it).
  WriteRegStr HKLM "${ARP}" "DisplayName" "${NAME}"
  WriteRegStr HKLM "${ARP}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${ARP}" "Publisher" "Lizge"
  WriteRegStr HKLM "${ARP}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${ARP}" "DisplayIcon" "$INSTDIR\sondra.exe"
  WriteRegStr HKLM "${ARP}" "UninstallString" '"$INSTDIR\Deinstallieren.exe"'
  WriteRegStr HKLM "${ARP}" "QuietUninstallString" '"$INSTDIR\Deinstallieren.exe" /S'
  WriteRegDWORD HKLM "${ARP}" "NoModify" 1
  WriteRegDWORD HKLM "${ARP}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${ARP}" "EstimatedSize" "$0"
  WriteRegStr HKLM "Software\${KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\${KEY}" "Version" "${VERSION}"

  ; The lists people send each other: the ending is Sondra's alone.
  WriteRegStr HKLM "Software\Classes\.sondra-liste" "" "Sondra.NativListe"
  WriteRegStr HKLM "Software\Classes\Sondra.NativListe" "" "Sondra-Merkliste"
  WriteRegStr HKLM "Software\Classes\Sondra.NativListe\DefaultIcon" "" "$INSTDIR\sondra.exe,0"
  WriteRegStr HKLM "Software\Classes\Sondra.NativListe\shell\open\command" "" '"$INSTDIR\sondra.exe" "%1"'

  ; The projects (`.sondra`): Sondra's too, but only where nobody has taken the ending yet — the Electron app, if it
  ; is installed beside this one, owns it and keeps it.
  ReadRegStr $0 HKLM "Software\Classes\.sondra" ""
  ${If} $0 == ""
    WriteRegStr HKLM "Software\Classes\.sondra" "" "Sondra.NativProjekt"
  ${EndIf}
  WriteRegStr HKLM "Software\Classes\Sondra.NativProjekt" "" "Sondra-Projekt"
  WriteRegStr HKLM "Software\Classes\Sondra.NativProjekt\DefaultIcon" "" "$INSTDIR\sondra.exe,0"
  WriteRegStr HKLM "Software\Classes\Sondra.NativProjekt\shell\open\command" "" '"$INSTDIR\sondra.exe" "%1"'

  ; Media: only offered under „Öffnen mit“.
  WriteRegStr HKLM "Software\Classes\Sondra.NativDatei" "" "Datei für Sondra"
  WriteRegStr HKLM "Software\Classes\Sondra.NativDatei\shell\open\command" "" '"$INSTDIR\sondra.exe" "%1"'
  WriteRegStr HKLM "Software\Classes\Applications\sondra.exe" "FriendlyAppName" "Sondra"
  WriteRegStr HKLM "Software\Classes\Applications\sondra.exe\shell\open\command" "" '"$INSTDIR\sondra.exe" "%1"'
  !insertmacro each_extension open_with
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  Delete "$SMPROGRAMS\${FOLDER}\${NAME}.lnk"
  RMDir "$SMPROGRAMS\${FOLDER}"
  Delete "$INSTDIR\sondra.exe"
  Delete "$INSTDIR\ffmpeg.exe"
  Delete "$INSTDIR\ffprobe.exe"
  Delete "$INSTDIR\Lizenzen\*.txt"
  RMDir "$INSTDIR\Lizenzen"
  Delete "$INSTDIR\Deinstallieren.exe"
  RMDir "$INSTDIR"

  !insertmacro each_extension forget_open_with
  DeleteRegKey HKLM "Software\Classes\Applications\sondra.exe"
  DeleteRegKey HKLM "Software\Classes\Sondra.NativDatei"
  DeleteRegKey HKLM "Software\Classes\Sondra.NativListe"
  DeleteRegKey HKLM "Software\Classes\Sondra.NativProjekt"
  ReadRegStr $0 HKLM "Software\Classes\.sondra" ""
  ${If} $0 == "Sondra.NativProjekt"
    DeleteRegKey HKLM "Software\Classes\.sondra"
  ${EndIf}
  ; The ending only if it is still ours (another program may have taken it since).
  ReadRegStr $0 HKLM "Software\Classes\.sondra-liste" ""
  ${If} $0 == "Sondra.NativListe"
    DeleteRegKey HKLM "Software\Classes\.sondra-liste"
  ${EndIf}
  DeleteRegKey HKLM "${ARP}"
  DeleteRegKey HKLM "Software\${KEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; What Sondra keeps of the person (lists, settings in %APPDATA%\Sondra) stays: it is theirs.
SectionEnd
