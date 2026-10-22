!macro RegisterFortesOverlay suffix label
  WriteRegStr HKLM "Software\Classes\CLSID\{9E76E330-7AB7-4AFE-B912-2A305BCD4F0${suffix}}" "" "FortesDrive ${label}"
  WriteRegStr HKLM "Software\Classes\CLSID\{9E76E330-7AB7-4AFE-B912-2A305BCD4F0${suffix}}\InprocServer32" "" "$INSTDIR\resources\shell\FortesDriveOverlays.dll"
  WriteRegStr HKLM "Software\Classes\CLSID\{9E76E330-7AB7-4AFE-B912-2A305BCD4F0${suffix}}\InprocServer32" "ThreadingModel" "Both"
  ; O Windows carrega apenas as primeiras marcas em ordem alfabética, e esse limite
  ; é compartilhado com outros aplicativos. O espaço no início coloca as marcas do
  ; FortesDrive na frente, e o registro antigo (sem o espaço) é removido.
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\FortesDrive ${label}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\ FortesDrive ${label}" "" "{9E76E330-7AB7-4AFE-B912-2A305BCD4F0${suffix}}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved" "{9E76E330-7AB7-4AFE-B912-2A305BCD4F0${suffix}}" "FortesDrive ${label}"
!macroend
!macro customInstall
  SetRegView 64
  !insertmacro RegisterFortesOverlay 1 Synced
  !insertmacro RegisterFortesOverlay 2 Pending
  !insertmacro RegisterFortesOverlay 3 Error
  ; O Explorador só carrega as marcas de ícones quando inicia. Reiniciá-lo aqui
  ; faz as marcas aparecerem nas pastas e nos arquivos logo após a instalação,
  ; sem precisar encerrar a sessão do Windows.
  nsExec::ExecToLog 'taskkill /F /IM explorer.exe'
  Sleep 1500
  Exec '"$WINDIR\explorer.exe"'
!macroend
!macro UnregisterFortesOverlay suffix label
  DeleteRegKey HKLM "Software\Classes\CLSID\{9E76E330-7AB7-4AFE-B912-2A305BCD4F0${suffix}}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\ FortesDrive ${label}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\FortesDrive ${label}"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Shell Extensions\Approved" "{9E76E330-7AB7-4AFE-B912-2A305BCD4F0${suffix}}"
!macroend
!macro customUnInstall
  SetRegView 64
  !insertmacro UnregisterFortesOverlay 1 Synced
  !insertmacro UnregisterFortesOverlay 2 Pending
  !insertmacro UnregisterFortesOverlay 3 Error
!macroend