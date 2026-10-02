; Added to the installer electron-builder generates (nsis.include).
;
; electron-builder writes the Apps & Features entry without InstallLocation.
; Windows' own certification checks and the Microsoft Store expect it, so it is
; written here, into the same key. The uninstaller removes the whole key.
;
; „Öffnen mit“: Sondra is listed for media files without taking any of them
; over. electron-builder's own fileAssociations would write each extension's
; default class; this only adds Sondra to the extension's OpenWithProgids and
; to the application's SupportedTypes, which is what puts it in the Explorer's
; „Öffnen mit“ list and nowhere else. Dropping a file on the icon needs
; nothing registered — Windows passes the path on the command line.

!macro sondraOpenWith EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "Sondra.Datei" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}" ""
!macroend

!macro sondraForget EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "Sondra.Datei"
!macroend

!macro sondraEachExtension MACRO
  !insertmacro ${MACRO} ".mp3"
  !insertmacro ${MACRO} ".wav"
  !insertmacro ${MACRO} ".flac"
  !insertmacro ${MACRO} ".ogg"
  !insertmacro ${MACRO} ".opus"
  !insertmacro ${MACRO} ".m4a"
  !insertmacro ${MACRO} ".aac"
  !insertmacro ${MACRO} ".aif"
  !insertmacro ${MACRO} ".aiff"
  !insertmacro ${MACRO} ".wma"
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
  !insertmacro ${MACRO} ".mid"
  !insertmacro ${MACRO} ".midi"
!macroend

; electron-builder picks "Program Files" for a 64-bit build only when it is
; x64; an arm64-only setup would land in "Program Files (x86)", where 32-bit
; programs live. The documented way round it: offer the right folder as if a
; previous install had left it there — unless one really did.
; Not while electron-builder runs the installer on the build machine to
; write out the uninstaller (BUILD_UNINSTALLER): that is no installation.
!macro preInit
  !ifdef APP_ARM64
  !ifndef APP_64
  !ifndef BUILD_UNINSTALLER
    SetRegView 64
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 == ""
      WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\${APP_FILENAME}"
    ${EndIf}
  !endif
  !endif
  !endif
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"

  WriteRegStr SHELL_CONTEXT "Software\Classes\Sondra.Datei" "" "Mediendatei (Sondra)"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Sondra.Datei\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Sondra.Datei\shell\open" "FriendlyAppName" "Sondra Studio"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Sondra.Datei\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Sondra Studio"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro sondraEachExtension sondraOpenWith
  ; Up to 1.0.12 the shortcuts were called "Sondra". An update keeps the old
  ; ones (so pins survive a version change), which would leave both names in
  ; the Start menu; the old ones go.
  Delete "$SMPROGRAMS\Sondra.lnk"
  Delete "$DESKTOP\Sondra.lnk"
  ; Tell the Explorer, so the menu has Sondra without a sign-out.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro sondraEachExtension sondraForget
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Sondra.Datei"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
