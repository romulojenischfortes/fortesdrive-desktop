<#
  FortesDrive — instalação do servidor de armazenamento próprio.

  Este assistente é a versão usada pelo INSTALADOR DO CLIENTE DESKTOP: o
  instalador traz o pacote do servidor (gateway, Docker Compose e Dockerfile)
  nesta mesma pasta e abre este script numa janela própria, para o computador
  inteiro ficar pronto com um único download.

  O que ele faz, em ordem:
    1. instala o Docker Desktop quando falta, abre ele e espera o login e o
       serviço responderem (o login é o que libera o download das imagens);
    2. grava os arquivos do servidor (gateway) na pasta de trabalho;
    3. reaproveita ou cria o segredo de assinatura (.env) e prepara a pasta de
       dados do Nextcloud, que é o que os volumes do Docker usam;
    4. libera a porta 8790 (encerrando servidor anterior) e sobe o Nextcloud e
       o gateway em contêineres, esperando os dois responderem;
    5. instala o cloudflared (túnel do Cloudflare) e pede o token do tunnel uma
       única vez, guardando o endereço público para as próximas subidas;
    6. mostra o endereço e o segredo que devem ser colados no app;
    7. registra a subida automática com o Windows (servidor + túnel), ao ligar
       o computador e a cada entrada na sessão;
    8. guarda o endereço público (cloudflare-hostname.txt), o token do tunnel
       (cloudflared-token.txt) e o caminho do cloudflared (cloudflared-path.txt),
       que é o que a subida automática e o aplicativo usam.

  Nada aqui apaga arquivos já gravados: a pasta ./data e o .env
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
$areaTrabalho = [Environment]::GetFolderPath('Desktop')
if (-not $areaTrabalho) { $areaTrabalho = Join-Path $env:USERPROFILE 'Desktop' }
$pasta = if ($Folder) { $Folder } else { Join-Path $areaTrabalho 'storage-server' }

# Endereço público do túnel deste servidor (o Public Hostname definido no painel
# da Cloudflare). Fica gravado em cloudflare-hostname.txt e é ele que o app usa;
# sem ele o túnel sobe no modo temporário (trycloudflare), que muda a cada subida.
$dominioPadrao = ''

function Passo($texto) {
  Write-Host ''
  Write-Host ('=== ' + $texto) -ForegroundColor Cyan
}

function Gravar($caminho, $conteudo) {
  $utf8SemBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($caminho, $conteudo, $utf8SemBom)
}

# O .env e os arquivos do tunel sao UTF-8, mas Get-Content no Windows PowerShell
# decodifica como ANSI: "Rômulo" voltava como "RÃ´mulo" e a pasta de dados
# apontava para um usuario que nao existe (o Docker recusava com "Access is
# denied", o servidor nao subia e o tunel respondia 502). Tudo aqui e lido e
# gravado em UTF-8.
function Ler-TextoUtf8($caminho) {
  if (-not (Test-Path -LiteralPath $caminho)) { return '' }
  return [System.IO.File]::ReadAllText($caminho, [System.Text.Encoding]::UTF8)
}

function Desfazer-CaminhoCorrompido($texto) {
  if (-not $texto) { return $texto }
  $bytes = [System.Text.Encoding]::GetEncoding(28591).GetBytes($texto)
  return [System.Text.Encoding]::UTF8.GetString($bytes)
}

# Conserta o caminho que uma instalacao anterior deixou corrompido e, quando
# nenhum candidato serve, usa a pasta padrao.
function Resolver-CaminhoPasta($valor, $padrao) {
  if (-not $valor) { return $padrao }
  $base = ([string]$valor).Trim().Trim('"')
  if (-not $base) { return $padrao }
  $candidatos = @($base, (Desfazer-CaminhoCorrompido $base), (Desfazer-CaminhoCorrompido (Desfazer-CaminhoCorrompido $base)))
  foreach ($candidato in $candidatos) { if ($candidato -and (Test-Path -LiteralPath $candidato)) { return $candidato } }
  foreach ($candidato in $candidatos) { if ($candidato -and (Test-Path -LiteralPath (Split-Path -Parent $candidato))) { return $candidato } }
  return $padrao
}

# Janela do Windows para escolher uma pasta (com botao de criar pasta nova).
# Quando a janela nao pode ser aberta, cai na digitacao do caminho — o
# instalador nunca trava por causa disso.
function Escolher-Pasta($titulo, $inicial) {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $janela = New-Object System.Windows.Forms.Form
    $janela.TopMost = $true
    $janela.ShowInTaskbar = $false
    $janela.WindowState = 'Minimized'
    $janela.FormBorderStyle = 'None'
    $dialogo = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialogo.Description = $titulo
    $dialogo.ShowNewFolderButton = $true
    if ($inicial -and (Test-Path -LiteralPath $inicial)) { $dialogo.SelectedPath = $inicial }
    $escolha = $dialogo.ShowDialog($janela)
    $escolhida = $dialogo.SelectedPath
    $dialogo.Dispose()
    $janela.Dispose()
    if ($escolha -eq [System.Windows.Forms.DialogResult]::OK -and $escolhida) { return $escolhida.TrimEnd('\') }
  } catch {
    Write-Host ('[AVISO] A janela de pastas nao abriu: ' + $_.Exception.Message) -ForegroundColor Yellow
  }
  Write-Host $titulo
  $digitada = Read-Host ('Caminho da pasta (Enter = ' + $inicial + ')')
  if ($digitada) { return $digitada.Trim().Trim('"').TrimEnd('\') }
  return $inicial
}

Write-Host ''
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host '  FortesDrive - servidor de armazenamento' -ForegroundColor Cyan
Write-Host '  instalacao junto com o cliente desktop' -ForegroundColor Cyan
Write-Host '=====================================================' -ForegroundColor Cyan

# ---------------------------------------------------------------------
#  1/6 Docker Desktop
# ---------------------------------------------------------------------
Passo '1/6 Preparando o Docker Desktop'

# O comando pode nao aparecer no PATH desta janela logo depois de instalar:
# por isso o caminho do programa e procurado tambem na mao.
function Achar-Docker {
  # O PATH desta janela nao conhece um Docker recem-instalado: atualiza antes,
  # para os comandos "docker ..." do resto do assistente funcionarem tambem.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $comando = Get-Command docker -ErrorAction SilentlyContinue
  if ($comando) { return $comando.Source }
  foreach ($candidato in @(
      (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'),
      (Join-Path $env:LOCALAPPDATA 'Docker\Docker\resources\bin\docker.exe')
    )) {
    if (Test-Path -LiteralPath $candidato) { return $candidato }
  }
  return $null
}

# Abre a janela do Docker Desktop: e nela que o usuario aceita os termos, entra
# com a conta e ve o servico ficar pronto.
function Abrir-DockerDesktop {
  foreach ($candidato in @(
      (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
      (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
    )) {
    if (Test-Path -LiteralPath $candidato) {
      Start-Process -FilePath $candidato
      return $true
    }
  }
  return $false
}

$script:dockerCli = Achar-Docker

if (-not $script:dockerCli) {
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
    Write-Host 'Instalando o Docker Desktop (pode levar alguns minutos)...' -ForegroundColor Cyan
    Start-Process -FilePath $instaladorDocker -ArgumentList 'install', '--accept-license' -Wait
    $script:dockerCli = Achar-Docker
    if (-not $script:dockerCli) {
      # Instalacao silenciosa sem caminho: abre o assistente, para o usuario
      # resolver o WSL 2 e o reinicio quando o Docker pedir.
      Write-Host 'Abrindo o assistente do Docker Desktop (mantenha a opcao do WSL 2 marcada)...' -ForegroundColor Cyan
      Start-Process -FilePath $instaladorDocker -Wait
      $script:dockerCli = Achar-Docker
    }
  } else {
    Start-Process 'https://www.docker.com/products/docker-desktop'
  }
  if (-not $script:dockerCli) {
    Write-Host '[ERRO] O Docker Desktop nao ficou instalado. Rode o instalador dele,' -ForegroundColor Red
    Write-Host 'reinicie o Windows se ele pedir e use de novo o atalho' -ForegroundColor Red
    Write-Host '"FortesDrive - configurar servidor" no menu Iniciar.' -ForegroundColor Red
    exit 2
  }
  Write-Host 'Docker Desktop instalado.' -ForegroundColor Green
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
  try { & $script:dockerCli @args 2>&1 | Out-Null } finally { $ErrorActionPreference = $antes }
  return $LASTEXITCODE
}

# Mesma ideia, devolvendo o codigo junto com o texto: e assim que o limite de
# downloads do Docker Hub (que aparece quando nao ha login) fica reconhecido.
function Invoke-DockerComSaida {
  $antes = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $codigo = 1
  $saida = ''
  try {
    $saida = (& $script:dockerCli @args 2>&1 | Out-String)
    $codigo = $LASTEXITCODE
  } finally { $ErrorActionPreference = $antes }
  return @{ codigo = $codigo; saida = $saida }
}

# Espera o SERVICO do Docker responder (o login e outra coisa: o Docker
# funciona sem conta, mas e a conta que libera o download das imagens).
function Esperar-DockerPronto($segundos) {
  $voltas = [int][math]::Ceiling($segundos / 5)
  for ($i = 1; $i -le $voltas; $i++) {
    Start-Sleep -Seconds 5
    if ((Invoke-DockerSilencioso info) -eq 0) { return $true }
    if ($i % 6 -eq 0) { Write-Host ('  ainda aguardando o Docker... (' + ($i * 5) + 's)') }
  }
  return $false
}

if ((Invoke-DockerSilencioso info) -ne 0) {
  Write-Host ''
  Write-Host 'Abrindo o Docker Desktop...' -ForegroundColor Cyan
  if (-not (Abrir-DockerDesktop)) {
    Write-Host '[ERRO] Nao encontrei o Docker Desktop para abrir. Abra ele pelo menu Iniciar' -ForegroundColor Red
    Write-Host 'e rode de novo o atalho "FortesDrive - configurar servidor".' -ForegroundColor Red
    exit 2
  }
  Write-Host ''
  Write-Host '  Na janela do Docker Desktop que abriu:' -ForegroundColor Yellow
  Write-Host '    1. aceite os termos de uso, se ele pedir;' -ForegroundColor Yellow
  Write-Host '    2. entre com a sua conta Docker (ou crie uma gratuita): sem login o' -ForegroundColor Yellow
  Write-Host '       Docker Hub limita o download das imagens do Nextcloud;' -ForegroundColor Yellow
  Write-Host '    3. espere aparecer que o Docker esta rodando e volte para esta janela.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'A instalacao continua sozinha assim que o Docker responder.' -ForegroundColor Cyan
  while (-not (Esperar-DockerPronto 300)) {
    $tentar = Read-Host 'O Docker ainda nao respondeu. Tentar de novo? [S/n]'
    if ($tentar -match '^(n|nao|não)$') {
      Write-Host '[ERRO] O Docker Desktop nao ficou pronto. Abra ele, reinicie o Windows se pedir,' -ForegroundColor Red
      Write-Host 'e rode de novo o atalho "FortesDrive - configurar servidor".' -ForegroundColor Red
      exit 2
    }
    Abrir-DockerDesktop | Out-Null
  }
}
Write-Host 'Docker respondendo.' -ForegroundColor Green

# ---------------------------------------------------------------------
#  2/6 Arquivos do servidor (vem do proprio instalador)
# ---------------------------------------------------------------------
Passo ('2/6 Gravando os arquivos em ' + $pasta)
$origemCompose = Join-Path $pacote 'docker-compose.yml'
$origemGateway = Join-Path $pacote 'gateway\server.js'
$origemNextcloud = Join-Path $pacote 'gateway\nextcloud.js'
$origemDockerfile = Join-Path $pacote 'gateway\Dockerfile'
foreach ($arquivo in @($origemCompose, $origemGateway, $origemNextcloud, $origemDockerfile)) {
  if (-not (Test-Path $arquivo)) {
    Write-Host ('[ERRO] Pacote do servidor incompleto: faltou ' + $arquivo) -ForegroundColor Red
    exit 1
  }
}

New-Item -ItemType Directory -Force $pasta | Out-Null
New-Item -ItemType Directory -Force (Join-Path $pasta 'gateway') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $pasta 'data') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $pasta 'tmp') | Out-Null
$composeAtual = Join-Path $pasta 'docker-compose.yml'
$legado = (Test-Path $composeAtual) -and ((Get-Content -Raw -LiteralPath $composeAtual) -match '(?i)seaweedfs')
if ($legado) {
  # Migracao de binarios exige processo proprio: nunca troca o backend existente.
  Write-Host 'Armazenamento existente preservado, sem migracao nem troca de volumes.' -ForegroundColor Green
  $reparoUpload = Join-Path $pacote 'repair-uploads.bat'
  if (-not (Test-Path -LiteralPath $reparoUpload)) { throw 'Pacote de correcao de upload ausente. O armazenamento existente foi preservado.' }
  & $reparoUpload $pasta 'patch-only'
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel atualizar os uploads do servidor existente. Os dados foram preservados.' }
} else {
  Gravar $composeAtual ([System.IO.File]::ReadAllText($origemCompose, [System.Text.Encoding]::UTF8))
  Gravar (Join-Path $pasta 'gateway\server.js') ([System.IO.File]::ReadAllText($origemGateway, [System.Text.Encoding]::UTF8))
  Gravar (Join-Path $pasta 'gateway\nextcloud.js') ([System.IO.File]::ReadAllText($origemNextcloud, [System.Text.Encoding]::UTF8))
  Gravar (Join-Path $pasta 'gateway\Dockerfile') ([System.IO.File]::ReadAllText($origemDockerfile, [System.Text.Encoding]::UTF8))
}
Write-Host 'Arquivos gravados.' -ForegroundColor Green

# ---------------------------------------------------------------------
#  3/6 Pasta raiz e segredo de assinatura (.env)
# ---------------------------------------------------------------------
# A unica escolha do instalador: onde ficam os seus arquivos neste computador.
# Portas (9333/8888/8790), token interno (STORAGE_SIGNING_SECRET) e servicos ja
# vem prontos de fabrica.
$configClienteRaiz = Join-Path $env:APPDATA 'FortesDrive\fortesdrive-native-v2.json'
$pastaPadrao = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'FortesDrive'

# O arquivo do cliente é UTF-8. Lido com Get-Content -Raw (que no Windows
# PowerShell decodifica como ANSI), "Rômulo" voltaria como "RÃ´mulo" e a pasta
# apontaria para um usuário que não existe — por isso a leitura explícita.
function Ler-JsonUtf8($caminho) {
  if (-not (Test-Path $caminho)) { return $null }
  try { return ([System.IO.File]::ReadAllText($caminho, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json } catch { return $null }
}

$raiz = ''
$configPendente = Join-Path (Split-Path $configClienteRaiz) 'fortesdrive-setup.json'
$configLida = Ler-JsonUtf8 $configPendente
if (-not $configLida -or -not $configLida.watchFolder) { $configLida = Ler-JsonUtf8 $configClienteRaiz }
if ($configLida -and $configLida.watchFolder) { $raiz = [string]$configLida.watchFolder }

# Conserta a pasta que uma instalação anterior deixou com o nome do usuário
# corrompido (C:\Users\RÃ´mulo\... -> C:\Users\Rômulo\...).
if ($raiz -match '^[A-Za-z]:\\Users\\[^\\]+') { $raiz = $raiz -replace '^[A-Za-z]:\\Users\\[^\\]+', $env:USERPROFILE }

if (-not $raiz) { $raiz = $pastaPadrao }
Write-Host ''
Write-Host ('Pasta de sincronizacao atual neste computador: ' + $raiz) -ForegroundColor Cyan
# O usuario escolhe onde os arquivos ficam (janela de pastas do Windows). A
# pasta e criada aqui, no perfil de quem esta instalando.
if (-not $configLida -or -not $configLida.watchFolder) {
  $escolhida = Escolher-Pasta 'Escolha a pasta onde seus arquivos serao salvos e sincronizados' $raiz
  if ($escolhida) { $raiz = $escolhida }
}

# Caminho que não pode ser usado (usuário inexistente, disco removido) não
# interrompe a instalação: cai na pasta padrão e segue.
try {
  New-Item -ItemType Directory -Force $raiz | Out-Null
} catch {
  Write-Host ('[AVISO] Nao consegui usar a pasta "' + $raiz + '". Usando ' + $pastaPadrao) -ForegroundColor Yellow
  $raiz = $pastaPadrao
  New-Item -ItemType Directory -Force $raiz | Out-Null
}
Write-Host ('Pasta raiz definida: ' + $raiz) -ForegroundColor Green

# Entrega separada: nunca regrava o banco de manifestos de um cliente aberto.
# O cliente aplica a raiz em memoria e reinicia o monitoramento, mesmo se ja
# estiver na bandeja. O pedido so e removido depois de aplicado com sucesso.
New-Item -ItemType Directory -Force (Split-Path $configPendente) | Out-Null
Gravar $configPendente (@{ watchFolder = $raiz; machineRole = 'server' } | ConvertTo-Json -Compress)
Write-Host 'Pasta entregue ao cliente de sincronizacao.' -ForegroundColor Green

# Os arquivos ficam no MESMO DISCO escolhido, em uma pasta propria — nunca
# dentro da pasta sincronizada, para o agente nao reenviar para a nuvem o que o
# servidor ja guarda.
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
$linhas = @((Ler-TextoUtf8 $envFile) -split "\r?\n" | Where-Object { $_ -ne '' })
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

# Preserva a pasta ja escolhida e o segredo, inclusive na primeira instalacao.
$dadosExistentes = ($linhas | Where-Object { $_ -match '^\s*FD_DATA_DIR\s*=\s*\S' } | ForEach-Object { ($_ -split '=', 2)[1] } | Select-Object -First 1)
if (-not $dadosExistentes) { $dadosExistentes = (Ler-TextoUtf8 (Join-Path $pasta 'data-dir.txt')).Trim() }
$pastaDados = Resolver-CaminhoPasta $dadosExistentes $pastaDados
# New-Item nao tem parametro LiteralPath. A API cria sem interpretar curingas.
[IO.Directory]::CreateDirectory($pastaDados) | Out-Null
$linhasEnv = @($linhas | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*(STORAGE_SIGNING_SECRET|FD_DATA_DIR|MAX_UPLOAD_BYTES|MAX_CONCURRENT_UPLOADS|RATE_LIMIT_PER_MINUTE|NEXTCLOUD_ADMIN_USER|NEXTCLOUD_ADMIN_PASSWORD|NEXTCLOUD_DB_PASSWORD|NEXTCLOUD_DB_ROOT_PASSWORD|NEXTCLOUD_APP_PASSWORD)\s*=' })

# --- Nextcloud: credenciais do armazenamento ---------------------------
# A conta do Nextcloud é a dona dos arquivos e é ela que o gateway usa por
# WebDAV. Estes valores valem na PRIMEIRA subida (é quando o Nextcloud cria a
# conta e o banco); depois disso eles precisam continuar iguais, por isso um
# valor que já existe é sempre reaproveitado.
function Manter-Ou-Gerar($nome, $tamanho) {
  $existente = ($linhas | Where-Object { $_ -match ('^\s*' + $nome + '\s*=\s*\S') } | ForEach-Object { ($_ -split '=', 2)[1].Trim() } | Select-Object -First 1)
  if ($existente) { return $existente }
  $bytes = New-Object 'byte[]' $tamanho
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
}

$usuarioNextcloud = Manter-Ou-Gerar 'NEXTCLOUD_ADMIN_USER' 0
if (-not $usuarioNextcloud) { $usuarioNextcloud = 'fortesdrive' }
$senhaNextcloud = Manter-Ou-Gerar 'NEXTCLOUD_ADMIN_PASSWORD' 18
# O gateway entra no Nextcloud por WebDAV com esta mesma conta, então a senha de
# aplicativo é a senha da conta — não existe um segundo cadastro para manter.
$senhaAppNextcloud = $senhaNextcloud
$senhaBanco = Manter-Ou-Gerar 'NEXTCLOUD_DB_PASSWORD' 18
$senhaBancoRaiz = Manter-Ou-Gerar 'NEXTCLOUD_DB_ROOT_PASSWORD' 18

$linhasEnv = @(
  ('STORAGE_SIGNING_SECRET=' + $segredo),
  'MAX_CONCURRENT_UPLOADS=30',
  'RATE_LIMIT_PER_MINUTE=1800',
  ('NEXTCLOUD_ADMIN_USER=' + $usuarioNextcloud),
  ('NEXTCLOUD_ADMIN_PASSWORD=' + $senhaNextcloud),
  ('NEXTCLOUD_APP_PASSWORD=' + $senhaAppNextcloud),
  ('NEXTCLOUD_DB_PASSWORD=' + $senhaBanco),
  ('NEXTCLOUD_DB_ROOT_PASSWORD=' + $senhaBancoRaiz),
  # A pasta escolhida vale para todos os serviços (Nextcloud, banco, redis e
  # gateway): o Compose lê esta variável do .env em cada volume.
  ('FD_DATA_DIR=' + ($pastaDados -replace '\\', '/'))
) + $linhasEnv
Gravar (Join-Path $pasta 'data-dir.txt') $pastaDados
$pastaDadosPadrao = Join-Path $pasta 'data'
# A pasta dos dados vai no .env (FD_DATA_DIR) e vale para todos os serviços.
# Nenhum volume precisa ser editado à mão no Compose, e uma pasta escolhida em
# outro disco continua sendo respeitada nas próximas execuções.
if (-not (Ler-TextoUtf8 $composeAtual).Contains('FD_DATA_DIR') -and -not $legado) {
  Write-Host '[AVISO] O Compose do servidor nao usa FD_DATA_DIR: confira a pasta dos dados antes de subir.' -ForegroundColor Yellow
}
Gravar $envFile ($linhasEnv -join "`r`n")
Write-Host ('Pasta dos dados do armazenamento: ' + $pastaDados) -ForegroundColor Green

# ---------------------------------------------------------------------
#  4/6 Sobe os servicos
# ---------------------------------------------------------------------
Passo '4/6 Subindo o servidor e o Nextcloud (a primeira vez baixa as imagens e leva alguns minutos)'

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
$subida = Invoke-DockerComSaida compose up -d --build
Pop-Location
$subiu = ($subida.codigo -eq 0)

# Se a porta estava presa por algo que so apareceu agora, libera de novo e
# tenta uma segunda vez, em vez de desistir na primeira tentativa.
if (-not $subiu -and $subida.saida -notmatch '(?i)toomanyrequests|rate limit|unauthorized|pull access denied') {
  Write-Host ''
  Write-Host 'A subida falhou. Liberando a porta 8790 de novo e tentando uma segunda vez...' -ForegroundColor Yellow
  Liberar-Porta8790 | Out-Null
  Start-Sleep -Seconds 3
  Push-Location $pasta
  $subida = Invoke-DockerComSaida compose up -d --build
  Pop-Location
  $subiu = ($subida.codigo -eq 0)
}

# O Docker funciona sem conta, mas o Docker Hub limita os downloads de quem nao
# esta logado: nesse caso o proprio Docker Desktop resolve, com o login.
if (-not $subiu -and $subida.saida -match '(?i)toomanyrequests|rate limit|unauthorized|pull access denied') {
  Write-Host ''
  Write-Host 'O Docker Hub recusou o download das imagens (limite de quem nao esta logado).' -ForegroundColor Yellow
  Write-Host 'Abra o Docker Desktop, entre com a sua conta Docker e volte para esta janela.' -ForegroundColor Yellow
  Abrir-DockerDesktop | Out-Null
  Read-Host 'Pressione Enter depois de entrar no Docker Desktop'
  Push-Location $pasta
  $subida = Invoke-DockerComSaida compose up -d --build
  Pop-Location
  $subiu = ($subida.codigo -eq 0)
}

if (-not $subiu) {
  Write-Host '[ERRO] O docker compose falhou. Ultimas mensagens recebidas:' -ForegroundColor Red
  if ($subida.saida) {
    @($subida.saida -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 25) | ForEach-Object { Write-Host ('  ' + $_) }
  }
  Write-Host 'Mensagens do gateway:' -ForegroundColor Red
  Push-Location $pasta
  docker compose logs --tail 40 gateway
  Pop-Location
  Write-Host 'Se aparecer "Access is denied" ao preparar a pasta de dados, libere essa pasta no Docker Desktop' -ForegroundColor Yellow
  Write-Host '(Settings > Resources > File sharing) ou escolha a pasta de dados em outro disco e rode de novo este atalho.' -ForegroundColor Yellow
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
  Write-Host '[ERRO] O servidor local nao iniciou. O tunel nao sera tratado como servidor pronto.' -ForegroundColor Red
  Push-Location $pasta
  try { docker compose ps -a; docker compose logs --tail 60 gateway } finally { Pop-Location }
  exit 1
}

# --- O armazenamento grava de verdade? ---------------------------------
# Responder em /health só diz que o gateway está de pé. Aqui o teste é um envio
# real de poucos bytes, assinado do mesmo jeito que o app assina: é isso que
# prova que o arquivo chega ao disco deste computador. Se não gravar, o serviço
# é recriado antes de o assistente seguir.
function Testar-Armazenamento {
  $chave = 'u/teste-instalador/' + [guid]::NewGuid().ToString() + '.txt'
  $conteudo = [System.Text.Encoding]::UTF8.GetBytes('teste ' + (Get-Date).ToString('s'))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $digest = ([System.BitConverter]::ToString($sha.ComputeHash($conteudo))).Replace('-', '').ToLower()
  $expira = [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) + 300
  $hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($segredo))
  $alvo = 'put' + "`n" + $chave + "`n" + $expira
  $assinatura = ([System.BitConverter]::ToString($hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($alvo)))).Replace('-', '').ToLower()
  $caminho = ($chave.Split('/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
  $url = 'http://127.0.0.1:8790/v1/objects/' + $caminho + '?op=put&expires=' + $expira + '&sig=' + $assinatura
  try {
    $r = Invoke-WebRequest -Uri $url -Method Put -Body $conteudo -ContentType 'text/plain' -Headers @{ 'x-fd-sha256' = $digest } -UseBasicParsing -TimeoutSec 180
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300 -and $r.Content -match '"ok":true')
  } catch {
    return $false
  }
}

$armazenaOk = $false
if ($localOk) {
  # Na primeira subida o Nextcloud leva alguns minutos para instalar e criar a
  # conta: o envio de teste é repetido com paciencia antes de acusar falha.
  Write-Host 'Conferindo o armazenamento com um envio de teste (o Nextcloud pode levar alguns minutos na primeira vez)...'
  for ($i = 1; $i -le 48; $i++) {
    if (Testar-Armazenamento) { $armazenaOk = $true; break }
    Write-Host ('  aguardando o Nextcloud... (' + ($i * 5) + 's)')
    Start-Sleep -Seconds 5
  }
  if (-not $armazenaOk) {
    Write-Host '[AVISO] O gateway respondeu, mas a pasta de dados nao aceitou a gravacao. Recriando o servico...' -ForegroundColor Yellow
    Push-Location $pasta
    Invoke-DockerSilencioso compose up -d --force-recreate gateway | Out-Null
    Invoke-DockerSilencioso compose up -d | Out-Null
    Pop-Location
    for ($i = 1; $i -le 18; $i++) {
      Start-Sleep -Seconds 5
      if (Testar-Armazenamento) { $armazenaOk = $true; break }
      Write-Host ('  aguardando o armazenamento... (' + ($i * 5) + 's)')
    }
  }
  if ($armazenaOk) {
    Write-Host 'Armazenamento respondendo: um arquivo de teste foi gravado e conferido.' -ForegroundColor Green
  } else {
    Write-Host '[ERRO] O armazenamento continua sem gravar. Ultimas mensagens do gateway:' -ForegroundColor Red
    Push-Location $pasta
    docker compose logs --tail 60 gateway
    Pop-Location
    Write-Host ('Se a pasta de dados (' + $pastaDados + ') estiver em outro disco, confira se ele esta ligado') -ForegroundColor Yellow
    Write-Host 'e compartilhado no Docker Desktop (Settings > Resources > File sharing).' -ForegroundColor Yellow
  }
}

$arquivoHost = Join-Path $pasta 'cloudflare-hostname.txt'
$arquivoTokenCf = Join-Path $pasta 'cloudflared-token.txt'
$arquivoExeCf = Join-Path $pasta 'cloudflared-path.txt'

# Endereco publico do tunel: o Public Hostname configurado no painel da
# Cloudflare para este tunnel (por exemplo drive.seudominio.com).
$hostPublico = [string]$env:FD_HOSTNAME
if (-not $hostPublico -and (Test-Path -LiteralPath $arquivoHost)) { $hostPublico = (Ler-TextoUtf8 $arquivoHost).Trim() }
$hostPublico = ($hostPublico -replace '^\s*https?://', '').Trim().TrimEnd('/').ToLower()
if (-not $hostPublico -and $dominioPadrao) { $hostPublico = $dominioPadrao }

function Achar-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidatos = @(
    (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe'),
    (Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe'),
    (Join-Path $env:USERPROFILE 'cloudflared.exe')
  )
  foreach ($p in $candidatos) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
  return $null
}

# O cloudflared e o binario oficial do Cloudflare. A copia fica na pasta do
# usuario e o caminho e guardado para as proximas subidas (inclusive a do
# aplicativo, que rele esse arquivo ao ligar o Windows).
function Instalar-Cloudflared {
  $destino = Join-Path $env:LOCALAPPDATA 'cloudflared'
  New-Item -ItemType Directory -Force $destino | Out-Null
  $exe = Join-Path $destino 'cloudflared.exe'
  try {
    Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe -UseBasicParsing -TimeoutSec 900
    if (-not (Test-Path -LiteralPath $exe)) { throw 'o download nao gerou o cloudflared.exe' }
    Write-Host ('  cloudflared pronto em ' + $exe) -ForegroundColor Green
    return $exe
  } catch {
    Write-Host ('  [AVISO] ' + $_.Exception.Message) -ForegroundColor Yellow
    return $null
  }
}

$cloudflared = Achar-Cloudflared
if (-not $cloudflared) {
  Write-Host 'cloudflared nao encontrado: baixando o binario oficial do Cloudflare...'
  $cloudflared = Instalar-Cloudflared
}
if ($cloudflared) {
  Write-Host ('cloudflared instalado: ' + $cloudflared) -ForegroundColor Green
  Gravar $arquivoExeCf $cloudflared
} else {
  Write-Host '[AVISO] Nao consegui instalar o cloudflared automaticamente.' -ForegroundColor Yellow
  Write-Host 'Baixe em https://github.com/cloudflare/cloudflared/releases e rode de novo este atalho.'
}

# O token do tunnel e pessoal: fica ligado a conta Cloudflare de quem criou o
# tunel e por isso nunca vem dentro do instalador. Ele e pedido UMA vez aqui
# (digitacao oculta), guardado em cloudflared-token.txt e reaproveitado depois.
$tokenTunel = ''
if (Test-Path -LiteralPath $arquivoTokenCf) { $tokenTunel = (Ler-TextoUtf8 $arquivoTokenCf).Trim() }

function Registrar-TokenCloudflare {
  Write-Host ''
  Write-Host 'O tunel precisa do token do tunnel da SUA conta Cloudflare (o plano gratuito serve).' -ForegroundColor Cyan
  Write-Host 'No painel: Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared.'
  Write-Host 'Copie o token do comando mostrado e adicione um Public Hostname apontando para'
  Write-Host 'http://localhost:8790. A digitacao fica oculta e o token nao aparece no resumo final.'
  Write-Host ''
  try { Start-Process 'https://one.dash.cloudflare.com/' } catch { }
  $oculto = Read-Host 'Token do tunnel Cloudflare (Enter vazio = tunel temporario, sem conta)' -AsSecureString
  $ponteiro = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($oculto)
  try { $digitado = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ponteiro) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ponteiro) }
  return $digitado
}

if (-not $tokenTunel) { $tokenTunel = Registrar-TokenCloudflare }
if ($tokenTunel) {
  Gravar $arquivoTokenCf $tokenTunel
  Write-Host ('Token do tunnel guardado em ' + $arquivoTokenCf) -ForegroundColor Green
  if (-not $hostPublico) {
    Write-Host ''
    Write-Host 'Informe o endereco publico do tunnel (Public Hostname no painel da Cloudflare).' -ForegroundColor Cyan
    $hostPublico = (Read-Host 'Endereco publico (ex.: drive.seudominio.com)').Trim().ToLower()
  }
  if ($hostPublico) {
    Gravar $arquivoHost $hostPublico
    Write-Host ('Endereco publico guardado para as proximas subidas: https://' + $hostPublico) -ForegroundColor Green
  }
}

# O arquivo abrir-tunel.cmd guarda o comando exato, para subir o tunel de novo
# com dois cliques quando precisar (o token fica no arquivo ao lado dele).
$arquivoTunel = Join-Path $pasta 'abrir-tunel.cmd'
if ($cloudflared -and $tokenTunel) {
  Gravar $arquivoTunel ((@(
    '@echo off',
    'title FortesDrive - tunel do servidor (Cloudflare)',
    'cd /d "%~dp0"',
    'echo Endereco publico: https://' + $hostPublico,
    'echo Deixe esta janela aberta enquanto quiser o servidor na internet.',
    'echo.',
    'set /p FD_TOKEN=<"%~dp0cloudflared-token.txt"',
    '"' + $cloudflared + '" tunnel --no-autoupdate run --token %FD_TOKEN%'
  )) -join "`r`n")
} elseif ($cloudflared) {
  Gravar $arquivoTunel ((@(
    '@echo off',
    'title FortesDrive - tunel temporario do servidor (Cloudflare)',
    'cd /d "%~dp0"',
    'echo TUNEL TEMPORARIO: copie o endereco https abaixo para STORAGE_SERVER_URL.',
    'echo.',
    '"' + $cloudflared + '" tunnel --no-autoupdate --url http://127.0.0.1:8790'
  )) -join "`r`n")
}

$publicoOk = $false
$urlPublica = if ($hostPublico) { 'https://' + $hostPublico } else { '' }

if ($cloudflared -and $tokenTunel -and $hostPublico) {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Write-Host ('Subindo o tunel Cloudflare (porta 8790 -> ' + $hostPublico + ') ...')
  Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--no-autoupdate', 'run', '--token', $tokenTunel) -WindowStyle Hidden | Out-Null
  for ($i = 1; $i -le 18; $i++) {
    Start-Sleep -Seconds 5
    try {
      $r = Invoke-RestMethod ($urlPublica + '/health') -TimeoutSec 15
      if ($r.ok) { $publicoOk = $true; break }
    } catch { }
  }
  if ($publicoOk) {
    Write-Host ('Endereco publico respondendo: ' + $urlPublica) -ForegroundColor Green
  } else {
    Write-Host '[AVISO] O endereco publico ainda nao respondeu.' -ForegroundColor Yellow
    Write-Host 'No painel da Cloudflare confira o Public Hostname do tunnel: ele precisa apontar' -ForegroundColor Yellow
    Write-Host 'para http://localhost:8790, e o tunnel precisa aparecer como Healthy.' -ForegroundColor Yellow
  }
} elseif ($cloudflared) {
  # Sem token: tunel rapido do Cloudflare, sem conta. O endereco muda a cada
  # subida e por isso serve para conferir, nao para uso diario.
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  $logTunel = Join-Path $pasta 'tunel-cloudflare.log'
  Write-Host 'Subindo um tunel temporario do Cloudflare (sem conta)...' -ForegroundColor Cyan
  Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8790') -WindowStyle Hidden -RedirectStandardOutput $logTunel -RedirectStandardError ($logTunel + '.err') | Out-Null
  $urlTemp = ''
  for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 5
    $textoLog = ((Ler-TextoUtf8 $logTunel) + "`n" + (Ler-TextoUtf8 ($logTunel + '.err')))
    $achado = [regex]::Match($textoLog, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($achado.Success) { $urlTemp = $achado.Value; break }
  }
  if ($urlTemp) {
    Gravar (Join-Path $pasta 'cloudflare-temp-url.txt') $urlTemp
    try { $r = Invoke-RestMethod ($urlTemp + '/health') -TimeoutSec 15; if ($r.ok) { $publicoOk = $true } } catch { }
    Write-Host ('Endereco temporario: ' + $urlTemp) -ForegroundColor Yellow
    Write-Host 'Cole este endereco em STORAGE_SERVER_URL (pagina Secrets): ele muda a cada subida.' -ForegroundColor Yellow
    Write-Host 'Para um endereco fixo, crie um tunnel nomeado no painel da Cloudflare e rode' -ForegroundColor Yellow
    Write-Host 'de novo o atalho "FortesDrive - configurar servidor" para guardar o token.' -ForegroundColor Yellow
  } else {
    Write-Host '[AVISO] O tunel temporario nao publicou um endereco. Veja tunel-cloudflare.log.' -ForegroundColor Yellow
  }
} else {
  Write-Host ''
  Write-Host 'CONFIGURACAO DO TUNEL (Cloudflare): pendente' -ForegroundColor Yellow
  Write-Host '  1) Crie a conta gratuita em https://one.dash.cloudflare.com'
  Write-Host '  2) Em Zero Trust > Networks > Tunnels, crie um tunnel "Cloudflared".'
  Write-Host '  3) No tunnel, adicione um Public Hostname apontando para http://localhost:8790'
  Write-Host '     (a porta 8790 e a unica que deve ser publicada: so ela confere a assinatura).'
  Write-Host '  4) Rode de novo o atalho "FortesDrive - configurar servidor" e cole o token.'
  Write-Host '  5) Copie o endereco https do tunnel para o segredo STORAGE_SERVER_URL no app'
  Write-Host '     (pagina Secrets) e clique em "Verificar conexao".'
}

# ---------------------------------------------------------------------
#  Inicio automatico com o Windows
# ---------------------------------------------------------------------
# Duas coisas deixam o servidor pronto sem ninguem abrir nada: o Docker Desktop
# configurado para subir sozinho e a tarefa agendada que garante os servicos
# (gateway) e abre o tunel escondido. A tarefa tem dois gatilhos: ao
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
  (gateway) e abre o tunel Cloudflare guardado em cloudflared-token.txt. Nada aqui
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
  if ($subiu) {
    Anotar 'Inicializacao solicitada; verificando o gateway.'
    # "Subiu" nao garante que o servico esta rodando: se ele tiver parado
    # (disco, permissao, reinicio do Docker), nada e gravado. Aqui ele e
    # recriado quando nao estiver entre os servicos em execucao.
    $rodando = @(& docker compose ps --services --filter 'status=running' 2>$null)
    if ($rodando -notcontains 'gateway') {
      Anotar 'O gateway nao estava rodando: recriando.'
      & docker compose up -d --force-recreate gateway 2>&1 | Out-Null
    }
  }
  else { Anotar 'docker compose up falhou: veja docker compose logs gateway.' }
  Pop-Location
} else {
  Anotar 'O Docker nao ficou pronto a tempo; servidor indisponivel.'
}

$localOk = $false
if ($dockerOk) {
  for ($i = 1; $i -le 24; $i++) {
    try {
      $health = Invoke-RestMethod 'http://127.0.0.1:8790/health' -TimeoutSec 5
      if ($health.ok) { $localOk = $true; break }
    } catch { }
    Start-Sleep -Seconds 5
  }
}
if (-not $localOk) { Anotar 'Gateway sem resposta na porta 8790. Tunel nao iniciado por esta tarefa.'; exit 1 }
Anotar 'Gateway confirmado na porta 8790.'

# 3) Tunel para a internet (Cloudflare).
$arquivoHost = Join-Path $pasta 'cloudflare-hostname.txt'
$arquivoToken = Join-Path $pasta 'cloudflared-token.txt'
$arquivoExe = Join-Path $pasta 'cloudflared-path.txt'
$hostPublico = if (Test-Path $arquivoHost) { (Get-Content -Raw -LiteralPath $arquivoHost).Trim() } else { '' }
$exeCloudflared = if (Test-Path $arquivoExe) { (Get-Content -Raw -LiteralPath $arquivoExe).Trim() } else { '' }
if (-not $exeCloudflared -or -not (Test-Path $exeCloudflared)) {
  $cmdCf = Get-Command cloudflared -ErrorAction SilentlyContinue
  $exeCloudflared = if ($cmdCf) { $cmdCf.Source } else { Join-Path $env:LOCALAPPDATA 'cloudflared\cloudflared.exe' }
}
$tokenTunel = if (Test-Path $arquivoToken) { (Get-Content -Raw -LiteralPath $arquivoToken).Trim() } else { '' }

if (-not (Test-Path $exeCloudflared)) {
  Anotar 'cloudflared nao encontrado: tunel nao iniciado.'
} elseif (-not $tokenTunel) {
  Anotar 'Token do tunnel Cloudflare nao configurado: tunel nao iniciado.'
} else {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  # O aplicativo FortesDrive tambem gerencia este tunel quando a subida
  # automatica esta ligada: os dois usam os mesmos arquivos e o mesmo tunnel.
  $tunel = Start-Process -FilePath $exeCloudflared -ArgumentList @('tunnel', '--no-autoupdate', 'run', '--token', $tokenTunel) -WindowStyle Hidden -PassThru
  Anotar ('Tunel Cloudflare aberto: https://' + $hostPublico + ' -> porta 8790')
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
if ($localOk -and $publicoOk -and $armazenaOk) {
  Write-Host '  TUDO PRONTO: o servidor responde no computador e na internet.' -ForegroundColor Green
} elseif ($localOk -and -not $armazenaOk) {
  Write-Host '  O gateway responde, mas a pasta de dados nao aceita gravacao: veja as mensagens acima.' -ForegroundColor Red
} elseif ($localOk) {
  Write-Host '  Servidor local OK. Falta o token do tunnel Cloudflare (acima) para o tunel subir.' -ForegroundColor Yellow
} else {
  Write-Host '  O servidor ainda nao respondeu. Detalhes:' -ForegroundColor Red
  Write-Host ('  cd ' + $pasta)
  Write-Host '  docker compose logs gateway'
}
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Dashboard do FortesDrive (abra no navegador para comecar a usar):' -ForegroundColor Cyan
Write-Host '  https://fortesdrive.base44.app/drive'
Write-Host 'Na pagina Armazenamento, clique em "Verificar conexao".' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Endereco do servidor (segredo STORAGE_SERVER_URL):' -ForegroundColor Cyan
if ($urlPublica) {
  Write-Host ('  ' + $urlPublica)
} elseif (Test-Path (Join-Path $pasta 'cloudflare-temp-url.txt')) {
  Write-Host ('  ' + (Ler-TextoUtf8 (Join-Path $pasta 'cloudflare-temp-url.txt')).Trim()) -ForegroundColor Yellow
  Write-Host '  (tunel temporario: este endereco muda a cada subida)' -ForegroundColor Yellow
} else {
  Write-Host '  [pendente] conclua a configuracao do tunel Cloudflare (instrucoes acima)' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Segredo do servidor (segredo STORAGE_SIGNING_SECRET):' -ForegroundColor Cyan
Write-Host ('  ' + $segredo)
Write-Host ''
Write-Host 'Nextcloud (armazenamento dos arquivos):' -ForegroundColor Cyan
Write-Host ('  conta: ' + $usuarioNextcloud)
Write-Host ('  senha: ' + $senhaNextcloud)
Write-Host '  A interface web do Nextcloud fica apenas neste computador.'
Write-Host '  Os segredos do Nextcloud ficam no .env e sao reaproveitados nas proximas execucoes.'
Write-Host ''
Write-Host 'Se os segredos do app estiverem diferentes destes dois valores,' -ForegroundColor Yellow
Write-Host 'atualize-os na pagina Secrets e clique em "Verificar conexao" de novo.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Pasta de trabalho do servidor:' -ForegroundColor Cyan
Write-Host ('  ' + $pasta)
Write-Host 'Pasta raiz dos seus arquivos neste computador:' -ForegroundColor Cyan
Write-Host ('  ' + $raiz)
Write-Host 'Pasta dos dados do Nextcloud (usada pelos containers, anotada em data-dir.txt):' -ForegroundColor Cyan
Write-Host ('  ' + $pastaDados)
Write-Host 'Inicio automatico com o Windows:' -ForegroundColor Cyan
Write-Host ('  tarefa "' + $nomeTarefa + '" — sobe ao ligar o Windows e a cada entrada na sessao.')
Write-Host ('  registro de cada subida em ' + (Join-Path $pasta 'iniciar-servidor.log'))
Write-Host ''

# Arquivo opcional na raiz real: passa pelo mesmo sincronizador dos documentos.
# Um envio de teste do gateway nao comprova a sincronizacao da conta.
$criarVerificacao = Read-Host 'Criar um arquivo de verificacao na pasta raiz e sincronizar? [s/N]'
if ($criarVerificacao -match '^(s|sim)$') {
  $nomeVerificacao = 'FortesDrive-verificacao-' + [guid]::NewGuid().ToString() + '.txt'
  $arquivoVerificacao = Join-Path $raiz $nomeVerificacao
  Gravar $arquivoVerificacao ('Verificacao da sincronizacao FortesDrive. Criado em ' + (Get-Date).ToString('s'))
  Write-Host ('Arquivo criado no computador: ' + $arquivoVerificacao) -ForegroundColor Green
  Write-Host 'Aguardando o cliente enviar e confirmar este arquivo na sua conta.' -ForegroundColor Cyan
}

# Abre sempre, inclusive se houver uma instancia na bandeja: o evento de
# segunda instancia aplica a pasta escolhida e solicita uma reconciliacao.
$exeCliente = $null
$candidatosCliente = @(
  (Join-Path $pacote '..\..\FortesDrive.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\FortesDrive\FortesDrive.exe'),
  (Join-Path $env:ProgramFiles 'FortesDrive\FortesDrive.exe')
)
foreach ($candidato in $candidatosCliente) {
  if (Test-Path -LiteralPath $candidato) { $exeCliente = (Resolve-Path -LiteralPath $candidato).Path; break }
}
if ($exeCliente) {
  Start-Process -FilePath $exeCliente -ArgumentList '--configuration-complete'
  Write-Host 'FortesDrive aberto. Entre na sua conta para iniciar a sincronizacao bilateral.' -ForegroundColor Green
} else {
  Write-Host '[AVISO] Cliente nao encontrado. Abra o FortesDrive pelo menu Iniciar.' -ForegroundColor Yellow
}

# Fim da instalacao: o dashboard e onde este servidor aparece conectado.
try {
  Start-Process 'https://fortesdrive.base44.app/drive'
  Write-Host 'Dashboard aberto no navegador: entre na sua conta e comece a usar o FortesDrive.' -ForegroundColor Green
} catch {
  Write-Host 'Abra o dashboard no navegador: https://fortesdrive.base44.app/drive' -ForegroundColor Yellow
}

exit 0