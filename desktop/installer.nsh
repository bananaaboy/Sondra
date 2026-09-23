; Added to the installer electron-builder generates (nsis.include).
;
; electron-builder writes the Apps & Features entry without InstallLocation.
; Windows' own certification checks and the Microsoft Store expect it, so it is
; written here, into the same key. The uninstaller removes the whole key.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
!macroend
