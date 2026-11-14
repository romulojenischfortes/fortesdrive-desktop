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
    ; Aqui o electron-builder ja adicionou os plugins NSIS (StdUtils/nsDialogs).
    !insertmacro FortesInstallerPageFunctions
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
; Nao compilar funcoes durante o include: StdUtils ainda nao foi carregado.
!macro FortesInstallerPageFunctions
; Primeira pergunta do instalador: este computador e o servidor (onde ficam os
; arquivos da nuvem) ou um cliente (ramal/instancia)? No servidor nada e
; alterado — a pasta e o armazenamento que ja existem continuam iguais. No
; cliente, as configuracoes basicas (pasta de sincronizacao e papel da maquina)
; sao aplicadas nos passos seguintes.
Function FortesRolePageCreate
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Tipo de instalação" "Escolha Cliente ou Servidor."
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
  ; Somente atualizacoes automaticas e o modo servidor pulam esta pagina.
  ; Um arquivo antigo de configuracao NAO comprova que a pasta foi escolhida.
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  ${If} "$FortesMachineRole" == "server"
    Abort
  ${EndIf}
  SetShellVarContext current
  !insertmacro MUI_HEADER_TEXT "Pasta de download e sincronização" "Escolha onde os arquivos da sua conta serão salvos neste computador."
  nsDialogs::Create 1018
  Pop $0
  ${If} "$0" == "error"
    MessageBox MB_ICONSTOP "Não foi possível abrir a escolha da pasta. Execute o instalador novamente."
    Quit
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 28u "Escolha uma pasta para baixar e sincronizar seus arquivos. Esta escolha é obrigatória e é diferente da pasta de instalação do programa."
  Pop $0
  ${NSD_CreateText} 0 36u -84u 14u "$FortesSyncDir"
  Pop $FortesSyncDirInput
  ${NSD_CreateButton} -80u 35u 80u 16u "Escolher pasta..."
  Pop $FortesSyncDirBrowse
  ${NSD_OnClick} $FortesSyncDirBrowse FortesSyncBrowse
  ${NSD_CreateLabel} 0 62u 100% 42u "Arquivos baixados da nuvem serão salvos aqui. Alterações feitas nesta pasta serão sincronizadas com a sua conta depois do login. A pasta será criada se não existir."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function FortesSyncBrowse
  ${NSD_GetText} $FortesSyncDirInput $R0
  ${If} "$R0" == ""
    StrCpy $R0 "$DOCUMENTS"
  ${EndIf}
  nsDialogs::SelectFolderDialog "Escolha a pasta de download e sincronização" "$R0"
  Pop $0
  ${If} "$0" != "error"
  ${AndIf} "$0" != ""
    ${NSD_SetText} $FortesSyncDirInput "$0"
  ${EndIf}
FunctionEnd

Function FortesSyncPageLeave
  ${NSD_GetText} $FortesSyncDirInput $FortesSyncDir
  ${If} "$FortesSyncDir" == ""
    MessageBox MB_ICONEXCLAMATION "Escolha a pasta de download e sincronização para continuar."
    Abort
  ${EndIf}
  System::Call 'shlwapi::PathIsRelativeW(w "$FortesSyncDir") i .r0'
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Informe o caminho completo da pasta ou use Escolher pasta."
    Abort
  ${EndIf}
  ClearErrors
  CreateDirectory "$FortesSyncDir"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Não foi possível criar ou acessar a pasta escolhida. Escolha outra pasta."
    Abort
  ${EndIf}
  ; Verifica gravacao antes de permitir que a instalacao prossiga.
  ClearErrors
  GetTempFileName $R1 "$FortesSyncDir"
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "Não foi possível gravar na pasta escolhida. Escolha uma pasta com permissão de gravação."
    Abort
  ${EndIf}
  Delete "$R1"
FunctionEnd
!macroend
!macro customInit
  ; Primeira instalacao silenciosa nao pode ignorar a escolha obrigatoria.
  ${If} ${Silent}
  ${AndIfNot} ${isUpdated}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
!endif

; Entrega a escolha ao cliente usando somente o Windows/NSIS, sem PowerShell.
; O INI UTF-16 preserva acentos e e consumido antes de abrir o aplicativo web.
!macro FortesWriteSyncFolder
  ; Atualizacao automatica preserva a pasta e nao reconfigura o servidor.
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    SetShellVarContext current
    ${If} "$FortesMachineRole" == "client"
    ${AndIf} "$FortesSyncDir" == ""
      MessageBox MB_ICONSTOP "A instalação do cliente exige uma pasta de download e sincronização."
      Abort
    ${EndIf}
    ClearErrors
    CreateDirectory "$APPDATA\FortesDrive"
    FileOpen $0 "$APPDATA\FortesDrive\fortesdrive-setup.ini" w
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "Não foi possível salvar a pasta escolhida. Execute o instalador novamente."
      Abort
    ${EndIf}
    ; BOM UTF-16LE: WriteINIStr passa a gravar Unicode pelo Windows.
    FileWriteByte $0 255
    FileWriteByte $0 254
    FileClose $0
    ClearErrors
    WriteINIStr "$APPDATA\FortesDrive\fortesdrive-setup.ini" "Sync" "machineRole" "$FortesMachineRole"
    ${If} "$FortesMachineRole" == "client"
      WriteINIStr "$APPDATA\FortesDrive\fortesdrive-setup.ini" "Sync" "watchFolder" "$FortesSyncDir"
    ${EndIf}
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "Não foi possível salvar a configuração de sincronização. Execute o instalador novamente."
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