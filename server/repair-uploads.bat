@echo off
chcp 65001 >nul 2>nul
setlocal
title FortesDrive - corrigir uploads 411
set "FD_REPAIR_SELF=%~f0"
set "FD_REPAIR_DIR=%~1"
set "FD_REPAIR_MODE=%~2"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText($env:FD_REPAIR_SELF,[Text.Encoding]::UTF8); $m='#FD'+'REPAIR#'; $i=$c.IndexOf($m); iex $c.Substring($i+$m.Length)"
set "FD_REPAIR_CODE=%ERRORLEVEL%"
if /I "%FD_REPAIR_MODE%"=="patch-only" exit /b %FD_REPAIR_CODE%
echo.
pause
exit /b %FD_REPAIR_CODE%
#FDREPAIR#
$ErrorActionPreference = 'Stop'
$gateway = $null
$backup = $null
$restarted = $false
function Invoke-DockerRepair {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & docker @args | Out-Host; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
  if ($code -ne 0) { throw ('O Docker recusou a atualizacao (codigo ' + $code + ').') }
}
try {
  Write-Host 'FortesDrive - correcao dos uploads 411' -ForegroundColor Cyan
  Write-Host 'Mantem os dados, o .env, os volumes e o tunel. Reinicia apenas o gateway.'
  $folder = [string]$env:FD_REPAIR_DIR
  $patchOnly = $env:FD_REPAIR_MODE -eq 'patch-only'
  if (-not $patchOnly) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Abra o Docker Desktop antes de executar a atualizacao.' }
    Invoke-DockerRepair info
    if (-not $folder) {
      $ids = @(& docker ps -q --filter 'publish=8790' --filter 'label=com.docker.compose.service=gateway')
      if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel identificar o servidor em execucao.' }
      if ($ids.Count -eq 1) {
        $detected = (& docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' $ids[0])
        if ($LASTEXITCODE -eq 0 -and $detected -and (Test-Path -LiteralPath (Join-Path $detected 'gateway\server.js'))) { $folder = $detected }
      }
    }
  }
  if (-not $folder) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $candidate = Join-Path $desktop 'storage-server'
    if (Test-Path -LiteralPath (Join-Path $candidate 'gateway\server.js')) { $folder = $candidate }
  }
  if (-not $folder -and -not $patchOnly) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Selecione a pasta do servidor FortesDrive (storage-server)'
    if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $folder = $dialog.SelectedPath }
    $dialog.Dispose()
  }
  if (-not $folder) { throw 'Nenhuma pasta de servidor foi selecionada.' }
  $folder = (Resolve-Path -LiteralPath $folder).Path
  $gateway = Join-Path $folder 'gateway\server.js'
  if (-not (Test-Path -LiteralPath $gateway) -or -not (Test-Path -LiteralPath (Join-Path $folder 'docker-compose.yml'))) { throw 'Esta pasta nao contem um servidor FortesDrive reconhecido. Nada foi alterado.' }
  $source = [IO.File]::ReadAllText($gateway, [Text.Encoding]::UTF8)
  if ($source -notmatch 'FortesDrive' -or $source -notmatch 'MAX_UPLOAD_BYTES' -or $source -notmatch 'acquireUploadSlot') { throw 'Versao do gateway nao reconhecida. Nada foi alterado.' }
  $handlerPattern = [regex]::new('(?ms)^async function handleUpload\(req, res, key\) \{.*?^\}\s*(?=(?:function streamFile|async function handleDownload)\()')
  if ($handlerPattern.Matches($source).Count -ne 1) { throw 'Nao foi possivel localizar a rotina de upload com seguranca. Nada foi alterado.' }
  $versionPattern = [regex]::new("const VERSION = '[^']+';")
  if ($versionPattern.Matches($source).Count -ne 1) { throw 'Versao do servidor ausente. Nada foi alterado.' }
  $version = if ($source -match 'function uploadToFiler\(') { '1.1.1' } else { '2.0.2' }
  if (-not $patchOnly) {
    Write-Host ('Servidor localizado em: ' + $folder) -ForegroundColor Cyan
    $confirm = Read-Host 'Pausar os envios e aplicar a correcao neste servidor? [s/N]'
    if ($confirm -notmatch '^(s|sim)$') { Write-Host 'Cancelado. Nada foi alterado.'; exit 0 }
  }
  # --- Pasta de dados do Docker -----------------------------------------
  # O caminho era gravado no .env, e o Docker le esse arquivo com a codificacao
  # do Windows: "C:\Users\Rômulo\..." chegava como "C:\Users\RÃ´mulo\...". O
  # daemon tentava criar essa pasta, recusava com "Access is denied", o servidor
  # nao subia e o tunel respondia 502. Aqui o caminho e consertado, a pasta e
  # criada agora e ele passa a ficar no proprio docker-compose.yml (UTF-8).
  $envFile = Join-Path $folder '.env'
  $composeFile = Join-Path $folder 'docker-compose.yml'
  $textoEnv = if (Test-Path -LiteralPath $envFile) { [IO.File]::ReadAllText($envFile, [Text.Encoding]::UTF8) } else { '' }
  $linhasEnv = @($textoEnv -split "\r?\n")
  $valorDados = ($linhasEnv | Where-Object { $_ -match '^\s*FD_DATA_DIR\s*=\s*\S' } | ForEach-Object { ($_ -split '=', 2)[1] } | Select-Object -First 1)
  $pastaDados = Join-Path $folder 'data'
  if ($valorDados) {
    $base = ([string]$valorDados).Trim().Trim('"')
    $corrigido = if ($base) { [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding(28591).GetBytes($base)) } else { '' }
    if ($base -and (Test-Path -LiteralPath $base)) { $pastaDados = $base }
    elseif ($corrigido -and (Test-Path -LiteralPath $corrigido)) { $pastaDados = $corrigido }
    elseif ($base -and (Test-Path -LiteralPath (Split-Path -Parent $base))) { $pastaDados = $base }
  }
  New-Item -ItemType Directory -Force -LiteralPath $pastaDados | Out-Null
  # Pasta padrao: o proprio compose monta ./data, sem passar caminho nenhum
  # pelo .env. Pasta fora daqui: vai escrita no compose, que e UTF-8.
  if ($pastaDados -ne (Join-Path $folder 'data')) {
    $composeTexto = [IO.File]::ReadAllText($composeFile, [Text.Encoding]::UTF8)
    $marcadorDados = '${FD_DATA_DIR:-./data}'
    if ($composeTexto.Contains($marcadorDados)) {
      [IO.File]::WriteAllText($composeFile, $composeTexto.Replace($marcadorDados, ('"' + ($pastaDados -replace '\\', '/').TrimEnd('/') + '"')), (New-Object Text.UTF8Encoding($false)))
    }
  }
  if ($valorDados) {
    $semDados = @($linhasEnv | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*FD_DATA_DIR\s*=' })
    [IO.File]::WriteAllText($envFile, ($semDados -join "`r`n"), (New-Object Text.UTF8Encoding($false)))
  }
  Write-Host ('Pasta dos dados: ' + $pastaDados) -ForegroundColor Cyan
  $handler = @'
async function handleUpload(req, res, key) {
  const declared = String(req.headers['x-fd-sha256'] || '').toLowerCase();
  const lengthHeader = req.headers['content-length'];
  const contentLength = lengthHeader == null ? null : Number(lengthHeader);

  if (!/^[a-f0-9]{64}$/.test(declared)) {
    return sendJson(res, 422, { error: 'Informe o checksum SHA-256 em x-fd-sha256.' });
  }
  if (contentLength !== null && (!/^\d+$/.test(String(lengthHeader)) || !Number.isSafeInteger(contentLength))) {
    return sendJson(res, 400, { error: 'Tamanho informado inválido.' });
  }
  if (contentLength !== null && contentLength > MAX_UPLOAD_BYTES) {
    return sendJson(res, 413, { error: 'Arquivo acima do limite configurado no servidor.' });
  }
  req.socket?.setNoDelay?.(true);
  if (!(await acquireUploadSlot())) {
    return sendJson(res, 429, { error: 'O servidor está ocupado com outros envios. Tente novamente em instantes.' });
  }

  const tempPath = path.join(TMP_DIR, crypto.randomUUID() + '.part');
  try {
    const finalPath = typeof uploadToFiler === 'function' ? null : objectPath(key);
    if (finalPath) await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    const hash = crypto.createHash('sha256');
    let written = 0;
    const output = fs.createWriteStream(tempPath, { flags: 'wx', highWaterMark: 1024 * 1024 });
    const { pipeline } = require('node:stream/promises');
    // Túneis podem entregar o corpo em chunks, sem Content-Length. Contamos
    // os bytes em fluxo e mantemos o limite e o SHA-256, inclusive para vazios.
    const input = (async function* () {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        written += chunk.length;
        if (written > MAX_UPLOAD_BYTES) {
          throw Object.assign(new Error('Arquivo acima do limite configurado no servidor.'), { status: 413 });
        }
        if (contentLength !== null && written > contentLength) {
          throw Object.assign(new Error('O conteúdo recebido não corresponde ao tamanho informado.'), { status: 422 });
        }
        hash.update(chunk);
        yield chunk;
      }
    })();
    await pipeline(input, output);
    const digest = hash.digest('hex');
    if (contentLength !== null && written !== contentLength) {
      throw Object.assign(new Error('O conteúdo recebido não corresponde ao tamanho informado.'), { status: 422 });
    }
    if (digest !== declared) {
      throw Object.assign(new Error('Checksum divergente: o arquivo chegou corrompido e não foi gravado.'), { status: 422 });
    }
    if (finalPath) await fsp.rename(tempPath, finalPath);
    else await uploadToFiler(key, tempPath, written, req.headers['content-type']);
    sendJson(res, 200, { ok: true, key, size: written, checksum: digest });
  } catch (error) {
    if (!req.destroyed) req.resume();
    console.error('[gateway] falha no envio de ' + key + ': ' + error.message);
    if (!res.destroyed) sendJson(res, error.status || (typeof uploadToFiler === 'function' ? 502 : 500), { error: error.message });
  } finally {
    releaseUploadSlot();
    await fsp.rm(tempPath, { force: true });
  }
}
'@
  $updated = $handlerPattern.Replace($source, [Text.RegularExpressions.MatchEvaluator]{ param($match) $handler + "`r`n`r`n" })
  $updated = $versionPattern.Replace($updated, "const VERSION = '$version';")
  $backup = $gateway + '.before-411-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak'
  Copy-Item -LiteralPath $gateway -Destination $backup
  [IO.File]::WriteAllText($gateway, $updated, (New-Object Text.UTF8Encoding($false)))
  if ($patchOnly) { Write-Host ('Rotina de upload atualizada para ' + $version); exit 0 }
  Push-Location $folder
  try {
    Invoke-DockerRepair compose build --no-cache gateway
    $restarted = $true
    Invoke-DockerRepair compose up -d --no-deps --force-recreate gateway
  } finally { Pop-Location }
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $health = Invoke-RestMethod 'http://127.0.0.1:8790/health' -TimeoutSec 5
      if ($health.ok -and $health.version -eq $version) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw 'O gateway corrigido nao confirmou a versao esperada.' }
  Write-Host ('Gateway ' + $version + ' ativo. Correcao instalada; retome os envios no FortesDrive.') -ForegroundColor Green
  Write-Host ('Pasta dos dados usada pelo servidor: ' + $pastaDados) -ForegroundColor Green
  Write-Host 'Dados, configuracao e tunel preservados.' -ForegroundColor Green
  exit 0
} catch {
  Write-Host ('[ERRO] ' + $_.Exception.Message) -ForegroundColor Red
  if ($backup -and (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $backup -Destination $gateway -Force
    Write-Host 'O arquivo anterior do servidor foi restaurado. Nenhum dado foi apagado.' -ForegroundColor Yellow
    if ($restarted) {
      Push-Location $folder
      try { Invoke-DockerRepair compose build gateway; Invoke-DockerRepair compose up -d --no-deps --force-recreate gateway }
      catch { Write-Host 'Nao foi possivel reiniciar o gateway anterior. Abra o Docker Desktop e execute a atualizacao novamente.' -ForegroundColor Yellow }
      finally { Pop-Location }
    }
  }
  exit 1
}