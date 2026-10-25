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
    4. sobe os serviços e espera o gateway responder;
    5. instala o túnel e explica a etapa manual do token;
    6. mostra o endereço e o segredo que devem ser colados no app.

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
$pasta = if ($Folder) { $Folder } else { Join-Path $env:USERPROFILE 'Desktop\storage-server' }

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

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Abrindo o Docker Desktop e esperando ele ficar pronto...'
  $atalho = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $atalho) { Start-Process $atalho }
  $pronto = $false
  for ($i = 1; $i -le 36; $i++) {
    Start-Sleep -Seconds 5
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { $pronto = $true; break }
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
#  3/6 Segredo de assinatura (.env)
# ---------------------------------------------------------------------
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

# ---------------------------------------------------------------------
#  4/6 Sobe os servicos
# ---------------------------------------------------------------------
Passo '4/6 Subindo o servidor (a primeira vez leva alguns minutos)'
Push-Location $pasta
docker compose down --remove-orphans *> $null
docker compose up -d --build
$subiu = ($LASTEXITCODE -eq 0)
Pop-Location
if (-not $subiu) {
  Write-Host '[ERRO] O docker compose falhou. Ultimas mensagens do gateway:' -ForegroundColor Red
  Push-Location $pasta
  docker compose logs --tail 40 gateway
  Pop-Location
  exit 1
}

# ---------------------------------------------------------------------
#  5/6 Teste de saude + tunel para a internet
# ---------------------------------------------------------------------
Passo '5/6 Conferindo o servidor e tratando o tunel'
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

$dominio = [string]$env:FD_DOMAIN
if (-not $dominio) {
  $arquivoDominio = Join-Path $pasta 'ngrok-domain.txt'
  if (Test-Path $arquivoDominio) { $dominio = (Get-Content -Raw -LiteralPath $arquivoDominio).Trim() }
}

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

# O token do ngrok e pessoal e nunca fica guardado neste assistente. Se a
# configuracao ja existir, o tunel sobe agora; se ainda nao existir, o script
# explica exatamente o que falta.
function Tem-TokenNgrok {
  $config = Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.yml'
  return (Test-Path $config) -and ((Get-Content -Raw -LiteralPath $config) -match 'authtoken\s*:')
}

$publicoOk = $false
if ($ngrok -and $dominio -and (Tem-TokenNgrok)) {
  Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Write-Host ('Abrindo o tunel (porta 8790 -> ' + $dominio + ') ...')
  Start-Process -FilePath $ngrok -ArgumentList @('http', ('--domain=' + $dominio), '8790') -WindowStyle Minimized
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
  Write-Host '  3) Reserve um endereco fixo (Dominios) e suba o tunel para o GATEWAY:'
  Write-Host ('       ' + $exeNgrok + ' http --domain=SEU-ENDERECO.ngrok-free.dev 8790')
  Write-Host '     O tunel deve apontar sempre para a porta 8790 (gateway).'
  Write-Host '     A porta 8888 (SeaweedFS direto) nao pede autenticacao e nao deve ser exposta.'
  Write-Host '  4) Copie o endereco https que o ngrok mostrar para o segredo STORAGE_SERVER_URL'
  Write-Host '     no app (pagina Secrets) e clique em "Verificar conexao".'
  Write-Host ('  5) Para reaproveitar nas proximas execucoes, grave o endereco em ' + (Join-Path $pasta 'ngrok-domain.txt'))
}

# ---------------------------------------------------------------------
#  6/6 Resumo
# ---------------------------------------------------------------------
Write-Host ''
Write-Host '=====================================================' -ForegroundColor Cyan
if ($localOk -and $publicoOk) {
  Write-Host '  TUDO PRONTO: o servidor responde no computador e na internet.' -ForegroundColor Green
} elseif ($localOk) {
  Write-Host '  Servidor local OK. Falta a etapa manual do ngrok (instrucoes acima).' -ForegroundColor Yellow
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
Write-Host ''

exit 0