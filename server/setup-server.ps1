<#
  FortesDrive — instalação do servidor de armazenamento próprio.

  Este assistente é a versão usada pelo INSTALADOR DO CLIENTE DESKTOP: o
  instalador traz o pacote do servidor (gateway, Docker Compose e Dockerfile)
  nesta mesma pasta e abre este script numa janela própria, para o computador
  inteiro ficar pronto com um único download.

  O que ele faz, em ordem:
    1. confere se o Docker Desktop está instalado e funcionando;
    2. grava os arquivos do servidor (SeaweedFS + gateway) na pasta de trabalho;
    3. reaproveita ou cria o segredo de assinatura (.env);
    4. libera a porta 8790 (encerrando servidor anterior) e sobe os serviços,
       esperando o gateway responder;
    5. instala o túnel, abre a janela dele na pasta do servidor e explica a
       etapa manual do token;
    6. mostra o endereço e o segredo que devem ser colados no app;
    7. registra a subida automática com o Windows (servidor + túnel), ao ligar
       o computador e a cada entrada na sessão;
    8. guarda o endereço do túnel (ngrok-domain.txt), que é o que a subida
       automática usa — ninguém precisa digitar o endereço de novo.

  Nada aqui apaga arquivos já gravados: a pasta ./data do SeaweedFS e o .env
  existentes são mantidos.

  Para rodar de novo depois (por exemplo, depois de instalar o Docker e
  reiniciar o Windows), use o atalho "FortesDrive — configurar servidor" no
  menu Iniciar, ou rode este arquivo novamente.
#>
[CmdletBinding()]
param(
  # Pasta de trabalho do servidor. Padrão: Desktop\storage-server (a mesma
  # usada pelo instalador .bat, para reaproveitar dados e segredo existentes).
  [string]$Folder = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$pacote = $PSScriptRoot
# Pasta de trabalho do servidor: no Windows do dono isto resolve para
# C:\Users\<seu usuario>\Desktop\storage-server — a mesma pasta usada por todas
# as execuções, para reaproveitar dados, segredo e o endereço do túnel.
$pasta = if ($Folder) { $Folder } else { Join-Path $env:USERPROFILE 'Desktop\storage-server' }

# Endereço do túnel deste servidor. Fica gravado em ngrok-domain.txt e é ele que
# a subida automática usa ao ligar o Windows: ninguém digita o endereço de novo.
$dominioPadrao = 'uranometrical-nonequatorial-kiley.ngrok-free.dev'

function Passo($texto) {
  Write-Host ''
  Write-Host ('=== ' + $texto) -ForegroundColor Cyan
}

function Gravar($caminho, $conteudo) {
  $utf8SemBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($caminho, $conteudo, $utf8SemBom)
}

Write-Host ''
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host '  FortesDrive - servidor de armazenamento' -ForegroundColor Cyan
Write-Host '  instalacao junto com o cliente desktop' -ForegroundColor Cyan
Write-Host '=====================================================' -ForegroundColor Cyan

# ---------------------------------------------------------------------
#  1/6 Docker Desktop
# ---------------------------------------------------------------------
Passo '1/6 Verificando o Docker Desktop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'O Docker Desktop ainda nao esta instalado neste computador.' -ForegroundColor Yellow
  Write-Host 'Baixando o instalador oficial do Docker (nao precisa procurar no site)...'
  $instaladorDocker = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
  $baixouDocker = $false
  try {
    Invoke-WebRequest 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' -OutFile $instaladorDocker -UseBasicParsing -TimeoutSec 3600
    $baixouDocker = $true
  } catch {
    Write-Host ('[AVISO] Nao consegui baixar o instalador do Docker: ' + $_.Exception.Message) -ForegroundColor Yellow
  }
  if ($baixouDocker) {
    Write-Host 'Abrindo o instalador do Docker Desktop (mantenha a opcao do WSL 2 marcada)...' -ForegroundColor Cyan
    Start-Process -FilePath $instaladorDocker -Wait
  } else {
    Start-Process 'https://www.docker.com/products/docker-desktop'
  }
  Write-Host ''
  Write-Host 'Quando a instalacao do Docker Desktop terminar, abra o Docker Desktop' -ForegroundColor Cyan
  Write-Host 'uma vez, reinicie o Windows se ele pedir, e use de novo o atalho' -ForegroundColor Cyan
  Write-Host '"FortesDrive - configurar servidor" no menu Iniciar.' -ForegroundColor Cyan
  exit 2
}

# O Docker escreve o progresso dele no canal de erro do PowerShell. Quando esse
# texto e redirecionado, o PowerShell o transforma em erro de verdade e, com
# $ErrorActionPreference = 'Stop' (usado aqui para parar em falhas reais), isso
# encerraria o assistente no meio da instalacao. Por isso os comandos
# silenciosos do Docker passam por este atalho, com a preferencia local em
# 'Continue': quem decide se falhou e o codigo de saida.
function Invoke-DockerSilencioso {
  $antes = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & docker @args 2>&1 | Out-Null } finally { $ErrorActionPreference = $antes }
  return $LASTEXITCODE
}

if ((Invoke-DockerSilencioso info) -ne 0) {
  Write-Host 'Abrindo o Docker Desktop e esperando ele ficar pronto...'
  $atalho = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $atalho) { Start-Process $atalho }
  $pronto = $false
  for ($i = 1; $i -le 36; $i++) {
    Start-Sleep -Seconds 5
    if ((Invoke-DockerSilencioso info) -eq 0) { $pronto = $true; break }
    Write-Host ('  aguardando o Docker... (' + ($i * 5) + 's)')
  }
  if (-not $pronto) {
    Write-Host '[ERRO] O Docker Desktop nao ficou pronto. Abra ele, reinicie o Windows se pedir,' -ForegroundColor Red
    Write-Host 'e rode de novo o atalho "FortesDrive - configurar servidor".' -ForegroundColor Red
    exit 2
  }
}
Write-Host 'Docker respondendo.' -ForegroundColor Green

# ---------------------------------------------------------------------
#  2/6 Arquivos do servidor (vem do proprio instalador)
# ---------------------------------------------------------------------
Passo ('2/6 Gravando os arquivos em ' + $pasta)
$origemCompose = Join-Path $pacote 'docker-compose.yml'
$origemGateway = Join-Path $pacote 'gateway\server.js'
$origemDockerfile = Join-Path $pacote 'gateway\Dockerfile'
foreach ($arquivo in @($origemCompose, $origemGateway, $origemDockerfile)) {
  if (-not (Test-Path $arquivo)) {
    Write-Host ('[ERRO] Pacote do servidor incompleto: faltou ' + $arquivo) -ForegroundColor Red
    exit 1
  }
}

New-Item -ItemType Directory -Force $pasta | Out-Null
New-Item -ItemType Directory -Force (Join-Path $pasta 'gateway') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $pasta 'data') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $pasta 'tmp') | Out-Null
Gravar (Join-Path $pasta 'docker-compose.yml') (Get-Content -Raw -LiteralPath $origemCompose)
Gravar (Join-Path $pasta 'gateway\server.js') (Get-Content -Raw -LiteralPath $origemGateway)
Gravar (Join-Path $pasta 'gateway\Dockerfile') (Get-Content -Raw -LiteralPath $origemDockerfile)
Write-Host 'Arquivos gravados.' -ForegroundColor Green

# ---------------------------------------------------------------------
#  3/6 Pasta raiz e segredo de assinatura (.env)
# ---------------------------------------------------------------------
# A unica escolha do instalador: onde ficam os seus arquivos neste computador.
# Portas (9333/8888/8790), token interno (STORAGE_SIGNING_SECRET) e servicos ja
# vem prontos de fabrica.
$configClienteRaiz = Join-Path $env:APPDATA 'FortesDrive\fortesdrive-native-v2.json'
$raiz = ''
if (Test-Path $configClienteRaiz) {
  try { $raiz = [string]((Get-Content -Raw -LiteralPath $configClienteRaiz) | ConvertFrom-Json).watchFolder } catch { $raiz = '' }
}
if (-not $raiz) { $raiz = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'FortesDrive' }
Write-Host ''
Write-Host ('Pasta raiz neste computador: ' + $raiz) -ForegroundColor Cyan
Write-Host 'Pressione Enter para manter, ou digite outro caminho (ex: D:\MeuDrive).'
$respostaRaiz = Read-Host 'Pasta raiz (Enter = manter)'
if ($respostaRaiz) { $raiz = $respostaRaiz.Trim().Trim('"') }
New-Item -ItemType Directory -Force $raiz | Out-Null
Write-Host ('Pasta raiz definida: ' + $raiz) -ForegroundColor Green

# O cliente de sincronizacao le essa pasta do proprio arquivo de configuracao:
# gravando aqui, o agente ja sobe sincronizando o lugar escolhido (as demais
# chaves do arquivo sao mantidas).
$dadosCliente = @{}
if (Test-Path $configClienteRaiz) {
  try {
    $lido = (Get-Content -Raw -LiteralPath $configClienteRaiz) | ConvertFrom-Json
    foreach ($prop in $lido.PSObject.Properties) { $dadosCliente[$prop.Name] = $prop.Value }
  } catch { $dadosCliente = @{} }
}
$dadosCliente['watchFolder'] = $raiz
New-Item -ItemType Directory -Force (Split-Path $configClienteRaiz) | Out-Null
Gravar $configClienteRaiz ($dadosCliente | ConvertTo-Json -Compress)
Write-Host 'Pasta gravada na configuracao do cliente de sincronizacao.' -ForegroundColor Green

# Os dados do SeaweedFS ficam no MESMO DISCO escolhido, em uma pasta propria —
# nunca dentro da pasta sincronizada, para o agente nao enviar os blocos
# internos do servidor para a nuvem.
$pastaDados = Join-Path $pasta 'data'
$discoRaiz = ''
if ($raiz -match '^([A-Za-z]):') { $discoRaiz = $Matches[1] + ':' }
$discoServidor = ''
if ($pasta -match '^([A-Za-z]):') { $discoServidor = $Matches[1] + ':' }
if ($discoRaiz -and $discoServidor -and ($discoRaiz -ne $discoServidor)) {
  $pastaDados = $discoRaiz + '\FortesDriveServer\data'
}

Passo '3/6 Segredo de assinatura'
$envFile = Join-Path $pasta '.env'
$linhas = @()
if (Test-Path $envFile) { $linhas = @(Get-Content -LiteralPath $envFile) }
$atual = ($linhas | Where-Object { $_ -match '^\s*STORAGE_SIGNING_SECRET\s*=\s*\S' } | ForEach-Object { ($_ -split '=', 2)[1].Trim() } | Select-Object -First 1)
if ($atual -and $atual.Length -ge 16) {
  $segredo = $atual
  Write-Host 'Segredo que ja existia foi reaproveitado.' -ForegroundColor Green
} else {
  $bytes = New-Object 'byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $segredo = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $outras = @($linhas | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*STORAGE_SIGNING_SECRET\s*=' })
  Gravar $envFile ((@('STORAGE_SIGNING_SECRET=' + $segredo) + $outras) -join "`r`n")
  Write-Host 'Segredo novo criado no arquivo .env.' -ForegroundColor Green
}

# A pasta de dados do servidor fica registrada no .env, e ela que o Docker monta
# (variavel FD_DATA_DIR do docker-compose.yml). Pode ser trocada a mao, no
# proprio .env, por qualquer caminho — inclusive outro disco.
$linhasEnv = @(Get-Content -LiteralPath $envFile | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*FD_DATA_DIR\s*=' })
Gravar $envFile ((@('FD_DATA_DIR=' + $pastaDados) + $linhasEnv) -join "`r`n")
Write-Host ('Pasta dos dados do armazenamento: ' + $pastaDados) -ForegroundColor Green

# ---------------------------------------------------------------------
#  4/6 Sobe os servicos
# ---------------------------------------------------------------------
Passo '4/6 Subindo o servidor (a primeira vez leva alguns minutos)'

# Um servidor anterior — de outra pasta, de uma versao antiga ou aberto a mao —
# pode estar preso na porta 8790, e ai o Docker recusa a subida com
# "port is already allocated". Este passo encerra o servidor antigo antes de
# subir o novo. Nada e apagado: os dados continuam em ./data e o segredo no .env.
function Liberar-Porta8790 {
  Push-Location $pasta
  Invoke-DockerSilencioso compose down --remove-orphans | Out-Null
  Pop-Location

  # Nomes usados por instalacoes antigas do servidor.
  foreach ($nome in @('master', 'volume1', 'volume2', 'filer', 'gateway', 'caddy', 'seaweedfs')) {
    Invoke-DockerSilencioso rm -f $nome | Out-Null
  }

  $encerrados = 0
  foreach ($id in @(docker ps -aq --filter 'publish=8790')) {
    Invoke-DockerSilencioso rm -f $id | Out-Null
    $encerrados += 1
  }

  # Gateway antigo aberto fora do Docker (mesmo programa, mesma porta).
  foreach ($id in @(Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -match '^node' -and $proc.CommandLine -match 'server\.js') {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
      Write-Host 'Encerrando um servidor FortesDrive antigo que estava aberto fora do Docker.' -ForegroundColor Yellow
      $encerrados += 1
    }
  }

  return $encerrados
}

$encerrados = Liberar-Porta8790
if ($encerrados -gt 0) {
  Write-Host ('Servidor anterior encerrado para liberar a porta 8790 (' + $encerrados + ' item(ns)).') -ForegroundColor Green
}

Push-Location $pasta
docker compose up -d --build
$subiu = ($LASTEXITCODE -eq 0)
Pop-Location

# Se a porta estava presa por algo que so apareceu agora, libera de novo e
# tenta uma segunda vez, em vez de desistir na primeira tentativa.
if (-not $subiu) {
  Write-Host ''
  Write-Host 'A subida falhou. Liberando a porta 8790 de novo e tentando uma segunda vez...' -ForegroundColor Yellow
  Liberar-Porta8790 | Out-Null
  Start-Sleep -Seconds 3
  Push-Location $pasta
  docker compose up -d --build
  $subiu = ($LASTEXITCODE -eq 0)
  Pop-Location
}

if (-not $subiu) {
  Write-Host '[ERRO] O docker compose falhou. Ultimas mensagens do gateway:' -ForegroundColor Red
  Push-Location $pasta
  docker compose logs --tail 40 gateway
  Pop-Location
  $dono = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($dono) {
    $proc = Get-Process -Id $dono.OwningProcess -ErrorAction SilentlyContinue
    $nomeProc = if ($proc) { $proc.ProcessName } else { 'desconhecido' }
    Write-Host ''
    Write-Host ('A porta 8790 continua ocupada por: ' + $nomeProc + ' (id ' + $dono.OwningProcess + ').') -ForegroundColor Red
    Write-Host 'Feche esse programa e use de novo o atalho "FortesDrive - configurar servidor"' -ForegroundColor Red
    Write-Host 'no menu Iniciar.' -ForegroundColor Red
  }
  exit 1
}

# ---------------------------------------------------------------------
#  5/6 Teste de saude + tunel para a internet
# ---------------------------------------------------------------------
Passo '5/6 Conferindo o servidor, o tunel e o inicio automatico'
$versao = ''
$localOk = $false
for ($i = 1; $i -le 30; $i++) {
  try {
    $r = Invoke-RestMethod 'http://localhost:8790/health' -TimeoutSec 10
    if ($r.ok) { $localOk = $true; $versao = $r.version; break }
  } catch { }
  Start-Sleep -Seconds 5
}
if ($localOk) {
  Write-Host ('Gateway ' + $versao + ' respondendo no computador (porta 8790).') -ForegroundColor Green
} else {
  Write-Host '[AVISO] O gateway ainda nao respondeu. Detalhes: docker compose logs gateway' -ForegroundColor Yellow
}

$arquivoDominio = Join-Path $pasta 'ngrok-domain.txt'
$dominio = [string]$env:FD_DOMAIN
if (-not $dominio -and (Test-Path $arquivoDominio)) {
  $dominio = (Get-Content -Raw -LiteralPath $arquivoDominio).Trim()
}
if (-not $dominio) { $dominio = $dominioPadrao }
# Grava o endereco: e este arquivo que a subida automatica le ao ligar o Windows.
Gravar $arquivoDominio $dominio
Write-Host ('Endereco do tunel guardado para as proximas subidas: ' + $dominio) -ForegroundColor Green

function Achar-Ngrok {
  $cmd = Get-Command ngrok -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidatos = @(
    (Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.exe'),
    (Join-Path $env:USERPROFILE 'ngrok.exe'),
    'C:\ngrok\ngrok.exe',
    (Join-Path $env:ProgramFiles 'ngrok\ngrok.exe')
  )
  foreach ($p in $candidatos) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

# O pacote do ngrok fica guardado dentro do proprio FortesDrive (nao depende do
# site de terceiros). A copia do app tem a impressao digital conferida antes de
# ser usada; o endereco oficial do ngrok fica como alternativa.
$fontesNgrok = @(
  @{ Url = 'https://fortesdrive.base44.app/storage-server/ngrok.zip'; Sha256 = '438bad3dbefd7e244be9dfae3889dcf99073b515845b66ab5617e4887bc24636' },
  @{ Url = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip'; Sha256 = '' }
)

function Instalar-Ngrok($pastaDestino) {
  $zip = Join-Path $env:TEMP 'ngrok-fortesdrive.zip'
  foreach ($fonte in $fontesNgrok) {
    try {
      Invoke-WebRequest $fonte.Url -OutFile $zip -UseBasicParsing -TimeoutSec 900
      if ($fonte.Sha256) {
        $obtido = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
        if ($obtido -ne $fonte.Sha256) { throw 'o pacote baixado nao passou na verificacao de integridade' }
      }
      Expand-Archive -LiteralPath $zip -DestinationPath $pastaDestino -Force
      $exe = Join-Path $pastaDestino 'ngrok.exe'
      if (Test-Path $exe) { Write-Host ('  ngrok pronto em ' + $exe) -ForegroundColor Green; return $exe }
      throw 'o pacote nao continha o ngrok.exe'
    } catch {
      Write-Host ('  [AVISO] ' + $_.Exception.Message) -ForegroundColor Yellow
    }
  }
  return $null
}

$ngrok = Achar-Ngrok
if (-not $ngrok) {
  Write-Host 'ngrok nao encontrado: instalando a partir dos arquivos do FortesDrive...'
  $destino = Join-Path $env:LOCALAPPDATA 'ngrok'
  New-Item -ItemType Directory -Force $destino | Out-Null
  $ngrok = Instalar-Ngrok $destino
}
if ($ngrok) {
  Write-Host ('ngrok instalado: ' + $ngrok) -ForegroundColor Green
  Gravar (Join-Path $pasta 'ngrok-path.txt') $ngrok
} else {
  Write-Host '[AVISO] Nao consegui instalar o ngrok automaticamente.' -ForegroundColor Yellow
  Write-Host 'Baixe em https://ngrok.com/download e use o caminho do ngrok.exe nos passos abaixo.'
}

# O token do ngrok e pessoal e nunca fica guardado neste assistente: ele e
# pedido uma vez (digitacao oculta) e registrado na configuracao do proprio
# ngrok. Se a configuracao ja existir, o tunel sobe sem perguntar nada.
function Tem-TokenNgrok {
  $config = Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.yml'
  return (Test-Path $config) -and ((Get-Content -Raw -LiteralPath $config) -match 'authtoken\s*:')
}

# O token do ngrok e pessoal: fica ligado a conta de quem criou o tunel e por
# isso nunca vem dentro do instalador. Ele e pedido UMA vez aqui, no proprio
# assistente, e registrado na configuracao do ngrok (que passa a subir o tunel
# sozinho com o Windows). A digitacao e oculta e o token nao e gravado em log,
# nem mostrado no resumo final.
function Registrar-TokenNgrok($exe) {
  Write-Host ''
  Write-Host 'O tunel precisa do token da SUA conta ngrok (o cadastro e gratuito).' -ForegroundColor Cyan
  Write-Host 'Abri a pagina do token no navegador. Copie o token que aparece la e cole aqui.'
  Write-Host 'A digitacao fica oculta e o token nao e guardado por este assistente'
  Write-Host 'nem aparece no resumo final.'
  Write-Host ''
  try { Start-Process 'https://dashboard.ngrok.com/get-started/your-authtoken' } catch { }
  $oculto = Read-Host 'Token do ngrok (Enter vazio = deixar para depois)' -AsSecureString
  $ponteiro = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($oculto)
  try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ponteiro) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ponteiro) }
  if (-not $token) { return $false }

  $antes = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $exe config add-authtoken $token 2>&1 | Out-Null } finally { $ErrorActionPreference = $antes }
  $token = $null
  if (Tem-TokenNgrok) {
    return $true
  }
  Write-Host '[AVISO] O token nao foi aceito. Confira se copiou o token inteiro.' -ForegroundColor Yellow
  return $false
}

# --- ngrok como Servico do Windows -----------------------------------
# O ngrok.yml e o arquivo de configuracao do proprio ngrok: guarda o authtoken
# (pessoal, colocado acima com "ngrok config add-authtoken") e o tunel fixo
# deste servidor. E esse arquivo que o Servico do Windows usa.
function Arquivo-ConfigNgrok {
  return (Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.yml')
}

# Garante, no ngrok.yml, o tunel fixo do FortesDrive: http -> porta 8790 no
# dominio reservado, sem depender de nenhum comando na linha de comando.
function Garantir-ConfigNgrok($dominio) {
  $arquivo = Arquivo-ConfigNgrok
  New-Item -ItemType Directory -Force (Split-Path $arquivo) | Out-Null
  if (-not (Test-Path $arquivo)) { Gravar $arquivo ("version: `"3`"" + "`r`n") }
  $texto = Get-Content -Raw -LiteralPath $arquivo
  if ($texto -match '(?m)^tunnels:') {
    Write-Host 'O ngrok.yml ja tinha tuneis definidos; mantidos como estao.' -ForegroundColor Green
    return $true
  }
  $bloco = @(
    'tunnels:',
    '  fortesdrive:',
    '    proto: http',
    '    addr: 8790',
    ('    domain: ' + $dominio)
  ) -join "`r`n"
  Gravar $arquivo (($texto.TrimEnd() + "`r`n") + $bloco + "`r`n")
  Write-Host 'Tunel fixo gravado no ngrok.yml: http -> porta 8790 no dominio reservado.' -ForegroundColor Green
  return $true
}

function ServicoNgrok {
  return (Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'ngrok' -or $_.DisplayName -match 'ngrok' } | Select-Object -First 1)
}

# Registra o tunel como Servico do Windows: roda em segundo plano, sem janela
# nenhuma, e sobe junto com o computador. O install/uninstall precisa de
# administrador; quando nao der, quem chamou cai no atalho antigo.
function Instalar-ServicoNgrok($exe) {
  $config = Arquivo-ConfigNgrok
  $antes = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $exe service stop 2>&1 | Out-Null
    & $exe service uninstall 2>&1 | Out-Null
    & $exe service install ('--config=' + $config) 2>&1 | Out-Null
    & $exe service start 2>&1 | Out-Null
  } finally { $ErrorActionPreference = $antes }

  for ($i = 1; $i -le 10; $i++) {
    $servico = ServicoNgrok
    if ($servico -and $servico.Status -eq 'Running') { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

# A janela do tunel e aberta VISIVEL, na pasta do servidor: e ali que se confere
# o endereco publicado e se acompanha o trafego. O arquivo abrir-tunel.cmd guarda
# o comando exato, para subir o tunel de novo com dois cliques quando precisar.
$arquivoTunel = Join-Path $pasta 'abrir-tunel.cmd'
if ($ngrok -and $dominio) {
  Gravar $arquivoTunel ((@(
    '@echo off',
    'title FortesDrive - tunel do servidor',
    'cd /d "%~dp0"',
    'echo Endereco publico: https://' + $dominio,
    'echo Deixe esta janela aberta enquanto quiser o servidor na internet.',
    'echo.',
    '"' + $ngrok + '" http --domain=' + $dominio + ' 8790'
  )) -join "`r`n")
}

$publicoOk = $false

# Faltando o token, o assistente pede agora — uma unica vez. Depois disso o
# endereco e a credencial ficam guardados e a subida automatica do Windows
# levanta o tunel sem ninguem digitar nada de novo.
if ($ngrok -and $dominio -and -not (Tem-TokenNgrok)) {
  if (Registrar-TokenNgrok $ngrok) {
    Write-Host 'Token registrado: o tunel entra no ar agora.' -ForegroundColor Green
  } else {
    Write-Host ''
    Write-Host '[AVISO] Sem o token o tunel nao sobe.' -ForegroundColor Yellow
    Write-Host 'Quando tiver o token em maos, use outra vez o atalho' -ForegroundColor Yellow
    Write-Host '"FortesDrive - configurar servidor" no menu Iniciar: ele pede o token e sobe o tunel.' -ForegroundColor Yellow
  }
}

if ($ngrok -and $dominio -and (Tem-TokenNgrok)) {
  Garantir-ConfigNgrok $dominio | Out-Null
  Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Write-Host ('Registrando o tunel como Servico do Windows (porta 8790 -> ' + $dominio + ') ...')
  if (Instalar-ServicoNgrok $ngrok) {
    Write-Host 'Servico do Windows no ar: o tunel roda em segundo plano e sobe junto com o Windows.' -ForegroundColor Green
  } else {
    Write-Host '[AVISO] O Servico do Windows nao pode ser registrado (ele exige administrador).' -ForegroundColor Yellow
    Write-Host 'O tunel continua subindo com o Windows pela tarefa agendada, numa janela escondida.' -ForegroundColor Yellow
    Write-Host 'Para usar o servico nativo, rode este instalador como administrador.' -ForegroundColor Yellow
    Start-Process -FilePath 'cmd.exe' -WorkingDirectory $pasta -ArgumentList @('/k', 'abrir-tunel.cmd')
  }
  for ($i = 1; $i -le 18; $i++) {
    try {
      $r = Invoke-RestMethod ('https://' + $dominio + '/health') -Headers @{ 'ngrok-skip-browser-warning' = '1' } -TimeoutSec 15
      if ($r.ok) { $publicoOk = $true; break }
    } catch { }
    Start-Sleep -Seconds 5
  }
  if ($publicoOk) {
    Write-Host ('Endereco publico respondendo: https://' + $dominio) -ForegroundColor Green
  } else {
    Write-Host '[AVISO] O endereco publico ainda nao respondeu. Veja a janela do ngrok.' -ForegroundColor Yellow
  }
} else {
  $exeNgrok = if ($ngrok) { $ngrok } else { 'ngrok' }
  Write-Host ''
  Write-Host 'CONFIGURACAO DO TUNEL (ngrok): etapa manual pendente' -ForegroundColor Yellow
  Write-Host '  O ngrok ja esta instalado. O token e pessoal e nao pode ficar no instalador.'
  Write-Host '  1) Crie a conta em https://dashboard.ngrok.com e copie o seu token.'
  Write-Host '  2) Registre o token:'
  Write-Host ('       ' + $exeNgrok + ' config add-authtoken SEU_TOKEN')
  Write-Host ('  3) O endereco deste servidor ja esta guardado: ' + $dominio)
  Write-Host '     Para subir o tunel para o GATEWAY, o comando e:'
  Write-Host ('       ' + $exeNgrok + ' http --domain=' + $dominio + ' 8790')
  Write-Host '     O tunel deve apontar sempre para a porta 8790 (gateway).'
  Write-Host '     A porta 8888 (SeaweedFS direto) nao pede autenticacao e nao deve ser exposta.'
  Write-Host '  4) Copie o endereco https que o ngrok mostrar para o segredo STORAGE_SERVER_URL'
  Write-Host '     no app (pagina Secrets) e clique em "Verificar conexao".'
  Write-Host ('     O endereco ja ficou guardado em ' + (Join-Path $pasta 'ngrok-domain.txt') + ' e a subida automatica usa esse arquivo.')
}

# ---------------------------------------------------------------------
#  Inicio automatico com o Windows
# ---------------------------------------------------------------------
# Duas coisas deixam o servidor pronto sem ninguem abrir nada: o Docker Desktop
# configurado para subir sozinho e a tarefa agendada que garante os servicos
# (SeaweedFS + gateway) e abre o tunel escondido. A tarefa tem dois gatilhos: ao
# ligar o Windows e a cada entrada na sessao. O Docker Desktop depende de uma
# sessao do Windows, entao quando o computador liga sem ninguem entrar, tudo sobe
# na primeira entrada (StartWhenAvailable). Nada e apagado pela tarefa. Cada
# execucao deixa uma linha em iniciar-servidor.log, na pasta do servidor — e ali
# que se descobre o que faltou quando algo nao sobe junto com o Windows.
$scriptInicio = Join-Path $pasta 'iniciar-servidor.ps1'
Gravar $scriptInicio @'
<#
  FortesDrive - subida automatica do servidor de armazenamento.

  Rodado pela tarefa agendada "FortesDrive - servidor de armazenamento" ao ligar
  o Windows e a cada entrada na sessao: sobe o Docker, garante os servicos
  (SeaweedFS + gateway) e abre o tunel guardado em ngrok-domain.txt. Nada aqui
  apaga dados e
  nenhum segredo e escrito: o .env existente e usado como esta.

  Para conferir depois: iniciar-servidor.log, nesta mesma pasta.
#>
$ErrorActionPreference = 'Continue'
$pasta = $PSScriptRoot
$log = Join-Path $pasta 'iniciar-servidor.log'

function Anotar($texto) {
  Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + '  ' + $texto) -Encoding UTF8
}

Anotar '--- Windows ligado / entrada na sessao: subindo o servidor ---'

# 1) Docker no ar (abre o Docker Desktop quando preciso e espera ate 3 minutos).
$dockerOk = $false
for ($i = 1; $i -le 36; $i++) {
  & docker info 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $dockerOk = $true; break }
  if ($i -eq 1) {
    $atalho = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $atalho) { Start-Process $atalho; Anotar 'Docker Desktop foi aberto.' }
  }
  Start-Sleep -Seconds 5
}

# 2) Servicos do servidor (os containers voltam sozinhos; isto garante).
if ($dockerOk) {
  Anotar 'Docker respondendo.'
  Push-Location $pasta
  & docker compose up -d 2>&1 | Out-Null
  $subiu = ($LASTEXITCODE -eq 0)
  Pop-Location
  if ($subiu) { Anotar 'Servidor de armazenamento no ar (SeaweedFS + gateway).' }
  else { Anotar 'docker compose up falhou: veja docker compose logs gateway.' }
} else {
  Anotar 'O Docker nao ficou pronto a tempo; tentando o tunel mesmo assim.'
}

# 3) Tunel para a internet.
$arquivoDominio = Join-Path $pasta 'ngrok-domain.txt'
$dominio = if (Test-Path $arquivoDominio) { (Get-Content -Raw -LiteralPath $arquivoDominio).Trim() } else { '' }
$arquivoExe = Join-Path $pasta 'ngrok-path.txt'
$exeNgrok = if (Test-Path $arquivoExe) { (Get-Content -Raw -LiteralPath $arquivoExe).Trim() } else { '' }
if (-not $exeNgrok -or -not (Test-Path $exeNgrok)) {
  $cmdNgrok = Get-Command ngrok -ErrorAction SilentlyContinue
  $exeNgrok = if ($cmdNgrok) { $cmdNgrok.Source } else { Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.exe' }
}
$configNgrok = Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.yml'
$temToken = (Test-Path $configNgrok) -and ((Get-Content -Raw -LiteralPath $configNgrok) -match 'authtoken\s*:')

$servicoNgrokWindows = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'ngrok' -or $_.DisplayName -match 'ngrok' } | Select-Object -First 1
if ($servicoNgrokWindows) {
  # O tunel agora e um Servico do Windows: ele sobe sozinho com o computador.
  Anotar ('Tunel entregue ao Servico do Windows "' + $servicoNgrokWindows.Name + '" (' + $servicoNgrokWindows.Status + ').')
} elseif (-not $dominio) {
  Anotar 'Sem ngrok-domain.txt: tunel nao iniciado.'
} elseif (-not (Test-Path $exeNgrok)) {
  Anotar 'ngrok.exe nao encontrado: tunel nao iniciado.'
} elseif (-not $temToken) {
  Anotar 'Token do ngrok nao configurado: tunel nao iniciado.'
} else {
  Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  $tunel = Start-Process -FilePath $exeNgrok -ArgumentList @('http', ('--domain=' + $dominio), '8790') -WindowStyle Hidden -PassThru
  Anotar ('Tunel aberto: https://' + $dominio + ' -> porta 8790')
  # Fica vivo junto com o tunel: assim o Windows nao encerra o processo.
  $tunel.WaitForExit()
  Anotar 'Tunel encerrado.'
}
'@

# O Docker Desktop precisa subir sozinho: sem ele a tarefa nao teria o que
# iniciar. A opcao fica no arquivo de configuracao do proprio Docker; as outras
# chaves sao mantidas como estao e uma copia de seguranca fica guardada ao lado.
function Habilitar-DockerNoInicio {
  $arquivo = Join-Path $env:APPDATA 'Docker\settings-store.json'
  if (-not (Test-Path $arquivo)) { $arquivo = Join-Path $env:APPDATA 'Docker\settings.json' }
  if (-not (Test-Path $arquivo)) {
    Write-Host '[AVISO] Nao encontrei as configuracoes do Docker Desktop.' -ForegroundColor Yellow
    Write-Host 'Abra o Docker Desktop, entre em Settings > General e marque para ele subir com o Windows.' -ForegroundColor Yellow
    return
  }
  $texto = Get-Content -Raw -LiteralPath $arquivo
  if ($texto -match '"(autoStart|AutoStart)"\s*:\s*true') {
    Write-Host 'O Docker Desktop ja estava configurado para subir sozinho.' -ForegroundColor Green
    return
  }
  Copy-Item -LiteralPath $arquivo -Destination ($arquivo + '.fortesdrive.bak') -Force
  $novo = $texto
  if ($texto -match '"(autoStart|AutoStart)"\s*:\s*false') {
    $novo = $texto -replace '"(autoStart|AutoStart)"\s*:\s*false', '"autoStart": true'
  } elseif ($texto -match '^\s*\{\s*\}\s*$') {
    $novo = '{ "autoStart": true }'
  } elseif ($texto -match '^\s*\{') {
    $novo = $texto -replace '^\s*\{', "{`r`n  `"autoStart`": true,"
  }
  if ($novo -eq $texto) {
    Write-Host '[AVISO] Nao consegui alterar sozinho a configuracao do Docker Desktop.' -ForegroundColor Yellow
    Write-Host 'Abra o Docker Desktop, entre em Settings > General e marque para ele subir com o Windows.' -ForegroundColor Yellow
    return
  }
  Gravar $arquivo $novo
  Write-Host 'Docker Desktop configurado para subir sozinho com o Windows.' -ForegroundColor Green
}

Habilitar-DockerNoInicio

$nomeTarefa = 'FortesDrive - servidor de armazenamento'

# Registra a tarefa que sobe o servidor e o tunel sozinha. Os dois gatilhos
# cobrem os dois jeitos de o computador ser ligado: ao iniciar o Windows e a
# cada entrada na sessao. O gatilho de inicio do Windows exige administrador;
# quando ele nao pode ser criado, a tarefa fica com a entrada na sessao, que e
# o momento em que existe alguem usando o computador (o Docker Desktop depende
# de uma sessao aberta).
function Registrar-Tarefa($gatilhos, $descricao) {
  $acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptInicio + '"')
  $ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $nomeTarefa -Action $acao -Trigger $gatilhos -Settings $ajustes -Description $descricao -Force | Out-Null
}

Stop-ScheduledTask -TaskName $nomeTarefa -ErrorAction SilentlyContinue
try {
  Registrar-Tarefa @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)) 'Sobe o servidor de armazenamento FortesDrive e o tunel ao ligar o Windows e a cada entrada na sessao.'
  Write-Host 'Inicio automatico registrado: ao ligar o Windows e a cada entrada na sessao.' -ForegroundColor Green
} catch {
  Write-Host ('[AVISO] Nao consegui registrar o gatilho de ligar o Windows: ' + $_.Exception.Message) -ForegroundColor Yellow
  try {
    Registrar-Tarefa @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)) 'Sobe o servidor de armazenamento FortesDrive e o tunel a cada entrada na sessao.'
    Write-Host 'Inicio automatico registrado ao entrar na sessao do Windows.' -ForegroundColor Green
    Write-Host 'Para subir tambem quando o computador liga, rode de novo este atalho como administrador.' -ForegroundColor Yellow
  } catch {
    Write-Host ('[AVISO] Nao consegui registrar o inicio automatico: ' + $_.Exception.Message) -ForegroundColor Yellow
    Write-Host 'Rode de novo este atalho com "Executar como administrador" para registrar.' -ForegroundColor Yellow
  }
}

# ---------------------------------------------------------------------
#  6/6 Resumo
# ---------------------------------------------------------------------
Write-Host ''
Write-Host '=====================================================' -ForegroundColor Cyan
if ($localOk -and $publicoOk) {
  Write-Host '  TUDO PRONTO: o servidor responde no computador e na internet.' -ForegroundColor Green
} elseif ($localOk) {
  Write-Host '  Servidor local OK. Falta registrar o token do ngrok (acima) para o tunel subir.' -ForegroundColor Yellow
} else {
  Write-Host '  O servidor ainda nao respondeu. Detalhes:' -ForegroundColor Red
  Write-Host ('  cd ' + $pasta)
  Write-Host '  docker compose logs gateway'
}
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'No app (pagina Armazenamento), clique em "Verificar conexao".' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Endereco do servidor (segredo STORAGE_SERVER_URL):' -ForegroundColor Cyan
if ($dominio) {
  Write-Host ('  https://' + $dominio)
} else {
  Write-Host '  [pendente] conclua a configuracao manual do ngrok (instrucoes acima)' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Segredo do servidor (segredo STORAGE_SIGNING_SECRET):' -ForegroundColor Cyan
Write-Host ('  ' + $segredo)
Write-Host ''
Write-Host 'Se os segredos do app estiverem diferentes destes dois valores,' -ForegroundColor Yellow
Write-Host 'atualize-os na pagina Secrets e clique em "Verificar conexao" de novo.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Pasta de trabalho do servidor:' -ForegroundColor Cyan
Write-Host ('  ' + $pasta)
Write-Host 'Pasta raiz dos seus arquivos neste computador:' -ForegroundColor Cyan
Write-Host ('  ' + $raiz)
Write-Host 'Pasta dos dados do armazenamento (trocavel no .env):' -ForegroundColor Cyan
Write-Host ('  ' + $pastaDados)
Write-Host 'Inicio automatico com o Windows:' -ForegroundColor Cyan
Write-Host ('  tarefa "' + $nomeTarefa + '" — sobe ao ligar o Windows e a cada entrada na sessao.')
Write-Host ('  registro de cada subida em ' + (Join-Path $pasta 'iniciar-servidor.log'))
Write-Host ''

exit 0