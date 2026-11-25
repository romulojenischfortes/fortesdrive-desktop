@echo off
chcp 65001 >nul 2>nul
setlocal
title FortesDrive - recuperar servidor e uploads
set "FD_REPAIR_SELF=%~f0"
set "FD_REPAIR_DIR=%~1"
set "FD_REPAIR_MODE=%~2"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=[IO.File]::ReadAllText($env:FD_REPAIR_SELF,[Text.Encoding]::UTF8); $m='#FD'+'REPAIR#'; $i=$c.IndexOf($m); iex $c.Substring($i+$m.Length)"
set "FD_REPAIR_CODE=%ERRORLEVEL%"
if /I "%FD_REPAIR_MODE%"=="patch-only" exit /b %FD_REPAIR_CODE%
if /I "%FD_REPAIR_MODE%"=="automatic" exit /b %FD_REPAIR_CODE%
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
  $automatic = $env:FD_REPAIR_MODE -eq 'automatic'
  if (-not $patchOnly) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Abra o Docker Desktop antes de executar a atualizacao.' }
    Invoke-DockerRepair info
    if (-not $folder) {
      $ids = @(& docker ps -aq --filter 'label=com.docker.compose.service=gateway')
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
  $handlerPattern = [regex]::new('(?ms)^async function handleUpload\(req, res, key(?:, url)?\) \{.*?^\}\s*(?=(?:function streamFile|async function handleDownload)\()')
  if ($handlerPattern.Matches($source).Count -ne 1) { throw 'Nao foi possivel localizar a rotina de upload com seguranca. Nada foi alterado.' }
  $versionPattern = [regex]::new("const VERSION = '[^']+';")
  if ($versionPattern.Matches($source).Count -ne 1) { throw 'Versao do servidor ausente. Nada foi alterado.' }
  $version = if ($source -match 'function uploadToFiler\(') { '1.1.1' } else { '2.4.0' }
  if (-not $patchOnly -and -not $automatic) {
    Write-Host ('Servidor localizado em: ' + $folder) -ForegroundColor Cyan
    $confirm = Read-Host 'Pausar os envios e aplicar a correcao neste servidor? [s/N]'
    if ($confirm -notmatch '^(s|sim)$') { Write-Host 'Cancelado. Nada foi alterado.'; exit 0 }
  }
  # --- Pasta de dados do Docker -----------------------------------------
  # New-Item nao aceita -LiteralPath: esse comando interrompia o reparo
  # antes de iniciar o gateway. CreateDirectory trata o caminho literalmente.
  $envFile = Join-Path $folder '.env'
  $composeFile = Join-Path $folder 'docker-compose.yml'
  $textoEnv = if (Test-Path -LiteralPath $envFile) { [IO.File]::ReadAllText($envFile, [Text.Encoding]::UTF8) } else { '' }
  $linhasEnv = @($textoEnv -split "\r?\n")
  $valorDados = ($linhasEnv | Where-Object { $_ -match '^\s*FD_DATA_DIR\s*=\s*\S' } | ForEach-Object { ($_ -split '=', 2)[1] } | Select-Object -First 1)
  $composeTexto = [IO.File]::ReadAllText($composeFile, [Text.Encoding]::UTF8)
  $padraoDados = [regex]::new('(?m)^(?<indent>[ \t]*)-[ \t]+(?<source>.+?):/data["'']?[ \t]*\r?$')
  # A pasta de dados pertence ao servico do gateway. O redis monta uma pasta que
  # tambem se chama /data, porem DENTRO dessa raiz: olhar o arquivo inteiro
  # encontraria duas montagens (e o reparo pararia sem motivo) ou apontaria o
  # cache do redis para a raiz dos arquivos. O trecho do gateway e isolado antes.
  $inicioGateway = [regex]::Match($composeTexto, '(?ms)^  gateway:[ \t]*\r?\n')
  $restoCompose = if ($inicioGateway.Success) { $composeTexto.Substring($inicioGateway.Index + $inicioGateway.Length) } else { '' }
  $fimGateway = if ($inicioGateway.Success) { [regex]::Match($restoCompose, '(?m)^  \S') } else { $null }
  $tamanhoGateway = if (-not $inicioGateway.Success) { $composeTexto.Length } elseif ($fimGateway.Success) { $fimGateway.Index } else { $restoCompose.Length }
  $trechoDados = if ($inicioGateway.Success) { $restoCompose.Substring(0, $tamanhoGateway) } else { $composeTexto }
  $montagens = $padraoDados.Matches($trechoDados)
  if ($montagens.Count -gt 1) { throw 'Mais de uma pasta /data foi encontrada no servico do gateway. Os dados foram preservados.' }
  $origemDados = if ($montagens.Count -eq 1) { $montagens[0].Groups['source'].Value.Trim().Trim('"').Trim("'") } else { '' }
  $pastaDados = Join-Path $folder 'data'
  $arquivoDados = Join-Path $folder 'data-dir.txt'
  $salvo = if (Test-Path -LiteralPath $arquivoDados) { [IO.File]::ReadAllText($arquivoDados, [Text.Encoding]::UTF8).Trim() } else { '' }
  if ($origemDados -and $origemDados -notmatch '^\$\{' -and $origemDados -ne './data') { $pastaDados = $origemDados }
  elseif ($valorDados) { $pastaDados = $valorDados }
  elseif ($salvo) { $pastaDados = $salvo }
  $pastaDados = ([string]$pastaDados).Trim().Trim('"').Trim("'")
  if (-not [IO.Path]::IsPathRooted($pastaDados)) { $pastaDados = Join-Path $folder $pastaDados }
  if (-not (Test-Path -LiteralPath $pastaDados)) {
    $corrigido = [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding(28591).GetBytes($pastaDados))
    if (Test-Path -LiteralPath $corrigido) { $pastaDados = $corrigido }
  }
  [IO.Directory]::CreateDirectory($pastaDados) | Out-Null
  $utf8 = New-Object Text.UTF8Encoding($false)
  if ($montagens.Count -eq 1) {
    # As aspas envolvem o volume INTEIRO, nunca so a origem antes de :/data.
    $caminhoDocker = ($pastaDados -replace '\\', '/').TrimEnd('/').Replace("'", "''")
    $trechoNovo = $padraoDados.Replace($trechoDados, [Text.RegularExpressions.MatchEvaluator]{ param($m)
      $m.Groups['indent'].Value + "- '" + $caminhoDocker + ":/data'"
    })
    $composeNovo = if ($inicioGateway.Success) {
      $composeTexto.Substring(0, $inicioGateway.Index + $inicioGateway.Length) + $trechoNovo + $restoCompose.Substring($tamanhoGateway)
    } else { $trechoNovo }
    if ($composeNovo -ne $composeTexto) {
      Copy-Item -LiteralPath $composeFile -Destination ($composeFile + '.before-startup.bak') -Force
      [IO.File]::WriteAllText($composeFile, $composeNovo, $utf8)
    }
    $semDados = @($linhasEnv | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*FD_DATA_DIR\s*=' })
    [IO.File]::WriteAllText($envFile, ($semDados -join "`r`n"), $utf8)
    [IO.File]::WriteAllText($arquivoDados, $pastaDados, $utf8)
  }
  Write-Host ('Pasta dos dados: ' + $pastaDados) -ForegroundColor Cyan
  $handler = @'
async function handleUpload(req, res, key, url) {
  const declared = String(req.headers['x-fd-sha256'] || '').toLowerCase();
  const lengthHeader = req.headers['content-length'];
  const contentLength = lengthHeader == null ? null : Number(lengthHeader);
  const sizeHeader = req.headers['x-fd-size'];
  const declaredSize = sizeHeader == null ? null : Number(sizeHeader);
  const parts = Number(url?.searchParams.get('parts') || 0);
  const partIndex = Number(url?.searchParams.get('part') ?? -1);
  const finalize = url?.searchParams.get('finalize') === '1';
  const chunked = Number.isInteger(parts) && parts > 1;
  // Em um gateway antigo (sem o módulo do Nextcloud) `nextcloud` não existe: o
  // teste abaixo é seguro ali também — é esta a rotina que o reparo distribui.
  const backend = typeof nextcloud !== 'undefined' && nextcloud ? nextcloud : null;

  const chunkDir = path.join(TMP_DIR, '.chunks');
  const chunkPathFor = (session, index) => path.join(session, String(index).padStart(5, '0') + '.part');

  async function storeChunk(session, index) {
    await fsp.mkdir(session, { recursive: true });
    const { pipeline } = require('node:stream/promises');
    const output = fs.createWriteStream(chunkPathFor(session, index), { flags: 'w', highWaterMark: 1024 * 1024 });
    await pipeline(req, output);
  }

  async function assembleChunks(session, count, target) {
    const { pipeline } = require('node:stream/promises');
    const hash = crypto.createHash('sha256');
    let total = 0;
    const source = (async function* () {
      for (let index = 0; index < count; index += 1) {
        const chunkFile = chunkPathFor(session, index);
        const exists = await fsp.stat(chunkFile).catch(() => null);
        if (!exists) {
          throw Object.assign(new Error('Faltou o bloco ' + (index + 1) + ' de ' + count + '; envie novamente.'), { status: 409 });
        }
        const stream = fs.createReadStream(chunkFile, { highWaterMark: 4 * 1024 * 1024 });
        for await (const chunk of stream) {
          hash.update(chunk);
          total += chunk.length;
          yield chunk;
        }
      }
    })();
    await pipeline(source, fs.createWriteStream(target, { flags: 'wx', highWaterMark: 4 * 1024 * 1024 }));
    return { digest: hash.digest('hex'), written: total };
  }

  async function publishObject(target, digest) {
    if (!backend) {
      const finalPath = objectPath(key);
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      await fsp.rename(target, finalPath);
      return 'disk';
    }
    await backend.putFile(key, target, digest);
    return 'nextcloud';
  }

  if (!/^[a-f0-9]{64}$/.test(declared)) {
    req.resume();
    return sendJson(res, 422, { error: 'Informe o checksum SHA-256 em x-fd-sha256.' });
  }
  if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) {
    req.resume();
    return sendJson(res, 400, { error: 'Tamanho informado inválido.' });
  }
  if (declaredSize !== null && declaredSize > MAX_UPLOAD_BYTES) {
    req.resume();
    return sendJson(res, 413, { error: 'Arquivo acima do limite configurado no servidor.' });
  }
  if (!chunked && contentLength !== null && (!/^\d+$/.test(String(lengthHeader)) || !Number.isSafeInteger(contentLength))) {
    return sendJson(res, 400, { error: 'Tamanho informado inválido.' });
  }
  if (!chunked && contentLength !== null && contentLength > MAX_UPLOAD_BYTES) {
    return sendJson(res, 413, { error: 'Arquivo acima do limite configurado no servidor.' });
  }
  req.socket?.setNoDelay?.(true);

  // ── Um bloco do arquivo: guarda e responde rápido. ──
  if (chunked && !finalize) {
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= parts) {
      req.resume();
      return sendJson(res, 400, { error: 'Bloco inválido.' });
    }
    if (!(await acquireUploadSlot())) {
      req.resume();
      return sendJson(res, 429, { error: 'O servidor está ocupado com outros envios. Tente novamente em instantes.' });
    }
    const session = path.join(chunkDir, crypto.createHash('sha256').update(key).digest('hex').slice(0, 32));
    try {
      await storeChunk(session, partIndex);
      return sendJson(res, 200, { ok: true, key, partial: true, part: partIndex, parts });
    } catch (error) {
      console.error('[gateway] falha no bloco ' + partIndex + ' de ' + key + ': ' + error.message);
      if (!res.destroyed) sendJson(res, 500, { error: 'Não foi possível guardar este bloco: ' + error.message });
      return;
    } finally {
      releaseUploadSlot();
    }
  }

  if (!(await acquireUploadSlot())) {
    req.resume();
    return sendJson(res, 429, { error: 'O servidor está ocupado com outros envios. Tente novamente em instantes.' });
  }

  const tempPath = path.join(TMP_DIR, crypto.randomUUID() + '.part');
  const sessionDir = chunked ? path.join(chunkDir, crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)) : null;
  try {
    // ── Montagem: junta os blocos, confere o conteúdo e publica. ──
    if (chunked) {
      req.resume();
      const { digest, written } = await assembleChunks(sessionDir, parts, tempPath);
      if (declaredSize !== null && written !== declaredSize) {
        throw Object.assign(new Error('O conteúdo recebido não corresponde ao tamanho informado.'), { status: 422 });
      }
      if (digest !== declared) {
        throw Object.assign(new Error('Checksum divergente: o arquivo chegou corrompido e não foi gravado.'), { status: 422 });
      }
      const published = await publishObject(tempPath, digest);
      await fsp.rm(sessionDir, { recursive: true, force: true });
      return sendJson(res, 200, { ok: true, key, size: written, checksum: digest, backend: published, chunks: parts });
    }

    const finalPath = backend ? null : objectPath(key);
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
    else await backend.putFile(key, tempPath, digest);
    sendJson(res, 200, { ok: true, key, size: written, checksum: digest, backend: backend ? 'nextcloud' : 'disk' });
  } catch (error) {
    if (!req.destroyed) req.resume();
    if (sessionDir) await fsp.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    console.error('[gateway] falha no envio de ' + key + ': ' + error.message);
    if (!res.destroyed) sendJson(res, error.status || (backend ? 502 : 500), { error: error.message });
  } finally {
    releaseUploadSlot();
    await fsp.rm(tempPath, { force: true });
  }
}
'@
  $updated = $handlerPattern.Replace($source, [Text.RegularExpressions.MatchEvaluator]{ param($match) $handler + "`r`n`r`n" })
  $updated = $versionPattern.Replace($updated, "const VERSION = '$version';")
  # Gateways anteriores recebiam apenas tres argumentos; os blocos precisam da URL.
  $updated = $updated.Replace('return await handleUpload(req, res, key);', 'return await handleUpload(req, res, key, url);')
  $backup = $gateway + '.before-411-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak'
  Copy-Item -LiteralPath $gateway -Destination $backup
  [IO.File]::WriteAllText($gateway, $updated, (New-Object Text.UTF8Encoding($false)))
  if ($patchOnly) { Write-Host ('Rotina de upload atualizada para ' + $version); exit 0 }
  Push-Location $folder
  try {
    Invoke-DockerRepair compose config --quiet
    Invoke-DockerRepair compose build --no-cache gateway
    $restarted = $true
    # Tambem inicia o armazenamento de instalacoes antigas quando ele parou.
    Invoke-DockerRepair compose up -d --force-recreate gateway
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
  if ($folder -and (Test-Path -LiteralPath (Join-Path $folder 'docker-compose.yml'))) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location $folder
    try { & docker compose ps -a; & docker compose logs --tail 60 gateway } finally { Pop-Location; $ErrorActionPreference = $previous }
  }
  if ($backup -and (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $backup -Destination $gateway -Force
    Write-Host 'O arquivo anterior do servidor foi restaurado. Nenhum dado foi apagado.' -ForegroundColor Yellow
    if ($restarted) {
      Push-Location $folder
      try { Invoke-DockerRepair compose build gateway; Invoke-DockerRepair compose up -d --force-recreate gateway }
      catch { Write-Host 'Nao foi possivel reiniciar o gateway anterior. Abra o Docker Desktop e execute a atualizacao novamente.' -ForegroundColor Yellow }
      finally { Pop-Location }
    }
  }
  exit 1
}