; Pasta escolhida pelo usuario para os arquivos sincronizados.
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; O desinstalador e compilado com este mesmo arquivo e nao usa estas variaveis.
!ifndef BUILD_UNINSTALLER
  Var FortesSyncDir
  Var FortesSyncDirInput
  Var FortesSyncDirBrowse
  ; Papel deste computador: servidor (guarda os arquivos da nuvem) ou cliente.
  Var FortesMachineRole
  Var FortesRoleClient
  Var FortesRoleServer
!endif

; Pagina extra do instalador (depois da pasta de instalacao): aqui o usuario
; escolhe onde os arquivos serao salvos e sincronizados entre este computador e
; a nuvem. A pasta e criada na instalacao e entregue ao aplicativo.
; O desinstalador e compilado com este mesmo arquivo e nao tem paginas: sem
; esta condicao o NSIS acusaria as funcoes abaixo como nao usadas.
!ifndef BUILD_UNINSTALLER
  !macro customPageAfterChangeDir
    Page custom FortesRolePageCreate FortesRolePageLeave
    Page custom FortesSyncPageCreate FortesSyncPageLeave
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
; Primeira pergunta do instalador: este computador e o servidor (onde ficam os
; arquivos da nuvem) ou um cliente (ramal/instancia)? No servidor nada e
; alterado — a pasta e o armazenamento que ja existem continuam iguais. No
; cliente, as configuracoes basicas (pasta de sincronizacao e papel da maquina)
; sao aplicadas nos passos seguintes.
Function FortesRolePageCreate
  SetShellVarContext current
  ReadRegStr $FortesMachineRole HKLM "Software\FortesDrive" "MachineRole"
  ${If} "$FortesMachineRole" != "server"
    StrCpy $FortesMachineRole "client"
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} "$0" == "error"
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 22u "Este computador vai ser o servidor da nuvem ou um cliente (ramal/instancia)?"
  Pop $0
  ${NSD_CreateRadioButton} 0 28u 100% 12u "Cliente (ramal/instancia) — este computador sincroniza com a nuvem"
  Pop $FortesRoleClient
  ${NSD_CreateRadioButton} 0 44u 100% 12u "Servidor — instala o armazenamento e sincroniza a pasta raiz"
  Pop $FortesRoleServer
  ${If} "$FortesMachineRole" == "server"
    ${NSD_Check} $FortesRoleServer
  ${Else}
    ${NSD_Check} $FortesRoleClient
  ${EndIf}
  ${NSD_CreateLabel} 0 64u 100% 40u "Cliente: somente sincronizacao, sem dependencias extras. Servidor: configura o armazenamento neste computador. Pastas, arquivos e segredo existentes sao preservados."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function FortesRolePageLeave
  ${NSD_GetState} $FortesRoleServer $0
  ${If} $0 == 1
    StrCpy $FortesMachineRole "server"
  ${Else}
    StrCpy $FortesMachineRole "client"
  ${EndIf}
FunctionEnd

Function FortesSyncPageCreate
  SetShellVarContext current

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
  ; Atualizacao silenciosa nao troca papel nem pasta e nao abre assistentes.
  ${IfNot} ${Silent}
    SetShellVarContext current
    System::Call 'Kernel32::SetEnvironmentVariable(t "FD_SYNC", t "$FortesSyncDir")'
    System::Call 'Kernel32::SetEnvironmentVariable(t "FD_ROLE", t "$FortesMachineRole")'
    nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$pasta = Join-Path $$env:APPDATA $\'FortesDrive$\'; New-Item -ItemType Directory -Force -Path $$pasta | Out-Null; $$config = @{ machineRole = $$env:FD_ROLE }; if ($$env:FD_SYNC) { New-Item -ItemType Directory -Force -Path $$env:FD_SYNC | Out-Null; $$config.watchFolder = $$env:FD_SYNC }; $$config | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $$pasta $\'fortesdrive-setup.json$\') -Encoding UTF8"`
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "Nao foi possivel salvar a configuracao de instalacao."
      Abort
    ${EndIf}
    WriteRegStr HKLM "Software\FortesDrive" "MachineRole" "$FortesMachineRole"
    ${If} "$FortesMachineRole" == "server"
      CreateShortCut "$SMPROGRAMS\FortesDrive - configurar servidor.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\server\setup-server.ps1"'
      ; Executado apenas no modo servidor, usando o pacote incluido no .exe.
      ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\server\setup-server.ps1"' $0
      ${If} $0 != 0
        MessageBox MB_ICONEXCLAMATION "Configuracao do servidor pendente. Use FortesDrive - configurar servidor no menu Iniciar para concluir. Seus arquivos foram preservados."
      ${EndIf}
    ${EndIf}
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