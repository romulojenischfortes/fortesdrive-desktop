; Pasta escolhida pelo usuario para os arquivos sincronizados.
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; O desinstalador e compilado com este mesmo arquivo e nao usa estas variaveis.
!ifndef BUILD_UNINSTALLER
  Var FortesSyncDir
  Var FortesSyncDirInput
  Var FortesSyncDirBrowse
!endif

; Pagina extra do instalador (depois da pasta de instalacao): aqui o usuario
; escolhe onde os arquivos serao salvos e sincronizados entre este computador e
; a nuvem. A pasta e criada na instalacao e entregue ao aplicativo.
; O desinstalador e compilado com este mesmo arquivo e nao tem paginas: sem
; esta condicao o NSIS acusaria as funcoes abaixo como nao usadas.
!ifndef BUILD_UNINSTALLER
  !macro customPageAfterChangeDir
    Page custom FortesSyncPageCreate FortesSyncPageLeave
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
Function FortesSyncPageCreate
  ; Ja existe uma pasta escolhida (atualizacao ou reinstalacao): mantem a do
  ; usuario e nao mostra a pergunta de novo.
  IfFileExists "$APPDATA\FortesDrive\fortesdrive-native-v2.json" 0 fortes_criar_pagina
    Abort
  fortes_criar_pagina:

  StrCpy $FortesSyncDir "$DOCUMENTS\FortesDrive"
  nsDialogs::Create 1018
  Pop $0
  ${If} "$0" == "error"
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 26u "Escolha a pasta onde seus arquivos serão salvos e sincronizados entre este computador e a nuvem. Ela será criada se ainda não existir."
  Pop $0
  ${NSD_CreateText} 0 32u -56u 12u "$FortesSyncDir"
  Pop $FortesSyncDirInput
  ${NSD_CreateButton} -52u 31u 52u 14u "Escolher pasta..."
  Pop $FortesSyncDirBrowse
  ${NSD_OnClick} $FortesSyncDirBrowse FortesSyncBrowse

  nsDialogs::Show
FunctionEnd

Function FortesSyncBrowse
  ${NSD_GetText} $FortesSyncDirInput $R0
  nsDialogs::SelectFolderDialog "Escolha a pasta dos seus arquivos" "$R0"
  Pop $0
  ${If} "$0" != "error"
    ${NSD_SetText} $FortesSyncDirInput "$0"
  ${EndIf}
FunctionEnd

Function FortesSyncPageLeave
  ${NSD_GetText} $FortesSyncDirInput $FortesSyncDir
  ${If} "$FortesSyncDir" == ""
    MessageBox MB_ICONEXCLAMATION "Escolha a pasta onde seus arquivos serão salvos."
    Abort
  ${EndIf}
FunctionEnd
!endif

; Cria a pasta escolhida e deixa o pedido pronto para o aplicativo aplicar
; (na primeira abertura e, se ele ja estiver na bandeja do Windows, na hora).
; O arquivo e gravado em UTF-8 pelo PowerShell, porque o caminho leva o nome do
; usuario deste computador e pode ter acentos.
!macro FortesWriteSyncFolder
  ${If} "$FortesSyncDir" != ""
    System::Call 'Kernel32::SetEnvironmentVariable(t "FD_SYNC", t "$FortesSyncDir")'
    nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$pasta = Join-Path $$env:APPDATA $\'FortesDrive$\'; New-Item -ItemType Directory -Force -LiteralPath $$pasta | Out-Null; New-Item -ItemType Directory -Force -LiteralPath $$env:FD_SYNC | Out-Null; @{ watchFolder = $$env:FD_SYNC } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $$pasta $\'fortesdrive-setup.json$\') -Encoding UTF8"`
    Pop $0
    Pop $1
  ${EndIf}
!macroend

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
  !insertmacro FortesWriteSyncFolder
  !insertmacro RegisterFortesOverlay 1 Synced
  !insertmacro RegisterFortesOverlay 2 Pending
  !insertmacro RegisterFortesOverlay 3 Error
  !insertmacro RegisterFortesOverlay 4 Locked
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
  !insertmacro UnregisterFortesOverlay 4 Locked
!macroend