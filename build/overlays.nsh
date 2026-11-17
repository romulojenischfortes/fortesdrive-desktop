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
  ; Codigo de instalacao do servidor (opcional): gerado na pagina Armazenamento
  ; do app. Com ele o app cria o tunel Cloudflare e o endereco publico sozinho.
  Var FortesInstallCode
  Var FortesInstallCodeInput
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
  ; O papel e gravado na visao de registro de 64 bits; ler so a visao padrao
  ; fazia uma instalacao nova sobre um servidor existente voltar como cliente.
  SetRegView 64
  ReadRegStr $FortesMachineRole HKLM "Software\FortesDrive" "MachineRole"
  SetRegView lastused
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
  ${NSD_CreateLabel} 0 64u 100% 24u "Cliente: somente sincronizacao, sem dependencias extras. Servidor: configura o armazenamento neste computador. Pastas, arquivos e segredo existentes sao preservados."
  Pop $0

  ; Codigo de instalacao: e o caminho curto para o servidor ficar pronto sem
  ; abrir o painel da Cloudflare. Sem ele, o assistente pede o codigo ao abrir.
  ${NSD_CreateLabel} 0 90u 100% 10u "Código de instalação do servidor (opcional — gerado em Armazenamento, no app):"
  Pop $0
  ${NSD_CreateText} 0 102u -110u 14u "$FortesInstallCode"
  Pop $FortesInstallCodeInput
  ${NSD_CreateLabel} -106u 103u 106u 12u "8 caracteres"
  Pop $0
  ${NSD_CreateLabel} 0 120u 100% 24u "Somente no modo servidor. Com o código, o túnel Cloudflare e o endereço público são criados automaticamente; em branco, o assistente pergunta depois."
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
  ${NSD_GetText} $FortesInstallCodeInput $FortesInstallCode
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
    ${If} "$FortesMachineRole" == "client"
      ; O cliente abre já com a pasta escolhida, sincronizando essa pasta por
      ; inteiro: a mesma pasta vai na linha de comando, para o aplicativo
      ; aplicá-la antes da janela web (sem depender de o INI ser lido antes).
      Exec '"$INSTDIR\FortesDrive.exe" "--sync-folder=$FortesSyncDir"'
    ${EndIf}
    ${If} "$FortesMachineRole" == "server"
      ; Codigo de instalacao digitado aqui: o assistente do servidor le este
      ; arquivo e ja cria o tunel e o endereco publico pelo app, sem pedir nada.
      ClearErrors
      ${If} "$FortesInstallCode" != ""
        FileOpen $1 "$APPDATA\FortesDrive\codigo-instalacao.txt" w
        ${IfNot} ${Errors}
          FileWrite $1 "$FortesInstallCode"
          FileClose $1
        ${EndIf}
      ${EndIf}
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
; Verificacao pos-instalacao: confirma que os componentes desta versao chegaram
; ao disco. Qualquer ausencia aparece como alerta no fim do instalador e fica
; registrada em %APPDATA%\FortesDrive\verificacao-instalacao.log (sem segredos).
!macro FortesVerifyInstall
  StrCpy $R2 ""
  StrCpy $R3 0
  ${IfNot} ${FileExists} "$INSTDIR\FortesDrive.exe"
    StrCpy $R2 "$R2- Programa principal (FortesDrive.exe)$\r$\n"
    IntOp $R3 $R3 + 1
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\resources\server\gateway\server.js"
    StrCpy $R2 "$R2- Gateway do servidor$\r$\n"
    IntOp $R3 $R3 + 1
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\resources\server\gateway\nextcloud.js"
    StrCpy $R2 "$R2- Integracao com o Nextcloud$\r$\n"
    IntOp $R3 $R3 + 1
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\resources\server\gateway\Dockerfile"
    StrCpy $R2 "$R2- Imagem do gateway$\r$\n"
    IntOp $R3 $R3 + 1
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\resources\server\docker-compose.yml"
    StrCpy $R2 "$R2- Composicao do servidor$\r$\n"
    IntOp $R3 $R3 + 1
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\resources\server\setup-server.ps1"
    StrCpy $R2 "$R2- Assistente do servidor$\r$\n"
    IntOp $R3 $R3 + 1
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\resources\shell\FortesDriveOverlays.dll"
    StrCpy $R2 "$R2- Marcas do Explorador$\r$\n"
    IntOp $R3 $R3 + 1
  ${EndIf}

  ClearErrors
  CreateDirectory "$APPDATA\FortesDrive"
  FileOpen $0 "$APPDATA\FortesDrive\verificacao-instalacao.log" w
  ${IfNot} ${Errors}
    ${If} $R3 > 0
      FileWrite $0 "Resultado: $R3 componente(s) desta versao nao foram aplicados.$\r$\n$R2"
      FileClose $0
      MessageBox MB_ICONEXCLAMATION "A atualizacao nao foi aplicada por inteiro neste computador:$\r$\n$\r$\n$R2$\r$\nFeche o aplicativo e execute este instalador novamente. Sua conta, seus arquivos e a pasta configurada continuam intactos.$\r$\n$\r$\nRegistro: $APPDATA\FortesDrive\verificacao-instalacao.log"
    ${Else}
      FileWrite $0 "Resultado: todos os componentes desta versao foram aplicados.$\r$\n"
      FileClose $0
    ${EndIf}
  ${EndIf}
!macroend

; O servidor precisa subir com o Windows: sem isso, o computador reinicia e o
; armazenamento (gateway e tunel) fica fora do ar ate alguem abrir o programa.
; Vale tambem para atualizacoes, que nao passam pelas paginas do instalador.
!macro FortesRoleAutostart
  SetShellVarContext current
  ReadRegStr $R4 HKLM "Software\FortesDrive" "MachineRole"
  ${If} "$R4" == "server"
    CreateShortCut "$SMSTARTUP\FortesDrive.lnk" "$INSTDIR\FortesDrive.exe" "--background"
  ${Else}
    Delete "$SMSTARTUP\FortesDrive.lnk"
  ${EndIf}
!macroend

!macro customInstall
  SetRegView 64
  !insertmacro FortesWriteSyncFolder
  !insertmacro FortesRoleAutostart
  !insertmacro FortesVerifyInstall
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
  SetShellVarContext current
  Delete "$SMSTARTUP\FortesDrive.lnk"
  Delete "$SMPROGRAMS\FortesDrive - configurar servidor.lnk"
  !insertmacro UnregisterFortesOverlay 1 Synced
  !insertmacro UnregisterFortesOverlay 2 Pending
  !insertmacro UnregisterFortesOverlay 3 Error
  !insertmacro UnregisterFortesOverlay 4 Locked
!macroend