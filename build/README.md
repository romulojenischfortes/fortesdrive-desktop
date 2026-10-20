# FortesDrive Desktop — Build

Cliente desktop Electron com sincronização bidirecional nativa.

## Pré-requisitos

- Node.js 18+
- Windows 10+ (para build Windows) ou macOS 11+ (para build macOS)
- Ícone em `build/icon.png` (512x512) — já incluído; o electron-builder
  gera `.ico` e `.icns` automaticamente a partir dele

## Build local

```bash
cd desktop
npm install

# Gera o ícone se não existir (opcional — já vem incluído)
node generate-icon.js

# Windows — gera release/FortesDrive Setup 1.1.0.exe (NSIS)
npm run dist:win

# macOS — gera release/FortesDrive-1.1.0.dmg
npm run dist:mac

# Ambos
npm run dist:all
```

Os instaladores ficam em `desktop/release/`.

## CI / Automação (GitHub Actions)

Crie `.github/workflows/build-desktop.yml` no repositório para compilar
automaticamente a cada push:

```yaml
name: Build Desktop Installers
on:
  push:
    branches: [main]
    paths: ['desktop/**']
  workflow_dispatch:
jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
        working-directory: desktop
      - run: npm run dist:win
        working-directory: desktop
      - uses: actions/upload-artifact@v4
        with:
          name: FortesDrive-Windows-Setup
          path: desktop/release/*Setup*.exe
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
        working-directory: desktop
      - run: npm run dist:mac
        working-directory: desktop
      - uses: actions/upload-artifact@v4
        with:
          name: FortesDrive-macOS-DMG
          path: desktop/release/*.dmg
```

Os artefatos ficam disponíveis para download na aba Actions do repositório.

## Como funciona

1. `main.js` abre o app web FortesDrive numa janela Electron e configura o tray.
2. `sync-engine.js` observa o diretório raiz com chokidar (debounce 800ms).
3. `preload.js` expõe `window.fortesDrive` ao renderer com operações de arquivo nativas.
4. `useLocalSync` (hook React) assina mudanças locais (IPC) e da nuvem (SDK subscribe)
   para disparar a reconciliação instantânea via `runDesktopSync`.
5. `runDesktopSync` executa o plano de reconciliação: upload, download, mover,
   excluir (lixeira), detectar conflitos e preservar ambas as cópias.
6. `native-files.js` faz leitura/escrita atômica com verificação SHA-256.

## Sincronização bidirecional

- **PC → Nuvem**: chokidar detecta mudanças locais → debounce 800ms → IPC →
  `runDesktopSync` → upload via `UploadPrivateFile` (stored privately) →
  `processSyncOperation` cria versão com SHA-256.
- **Nuvem → PC**: `base44.entities.File.subscribe` detecta mudanças remotas →
  400ms debounce → `runDesktopSync` → download via signed URL →
  escrita atômica (temp file + rename) com verificação SHA-256.
- **Movimento**: detectado por identidade (inode) — renomear move, não exclui+cria.
- **Conflitos**: edições concorrentes preservam ambas as cópias com sufixo `.conflito-`.
- **Exclusão**: nuvem→PC vai para a lixeira do sistema; PC→nuvem marca como DELETED.

## Marcas no Explorador do Windows (1.3+)

O instalador Windows compila a extensão nativa `shell/overlays.cpp` e a registra para o Explorador 64-bit.
O registro exige instalação para todos os usuários, com autorização de administrador.
Após instalar/atualizar, encerre a sessão do Windows e entre novamente para carregar a extensão.
Nenhuma extensão de outro aplicativo é removida e nenhuma proteção do Windows é desativada.

- Verde/check: conteúdo confirmado na nuvem.
- Relógio: pendente, novo ou alterado desde a última confirmação.
- Vermelho: falha de sincronização; pastas propagam o pior estado dos descendentes.

O estado é salvo localmente em `.fortesdrive/shell-status.tsv`, que nunca é sincronizado.
A extensão só lê esse estado e os atributos dos arquivos, sem chamadas à internet.
O Windows tem um limite global de sobreposições; outros provedores podem ocupar os slots disponíveis.
A remoção do aplicativo remove somente os três registros FortesDrive.

O build executa testes nativos que verificam as três marcas, arquivos alterados, nomes Unicode,
exclusão de caminhos fora da raiz, recursos de ícone e falhas de leitura.
A exibição final no Explorador deve ser validada em um Windows com o instalador em execução.

## Assinatura digital (Windows)

O instalador é assinado automaticamente quando estes segredos existem no repositório:

- `WINDOWS_CERTIFICATE` — certificado `.pfx` codificado em Base64
- `WINDOWS_CERTIFICATE_PASSWORD` — senha do certificado

Sem esses segredos o build continua funcionando, mas publica o instalador **sem assinatura** e o
texto da versão informa isso claramente, junto com o SHA-256 do arquivo. A assinatura identifica
quem publicou o programa; ela não elimina o aviso do Windows de imediato — a reputação é
construída ao longo do tempo, publicando sempre pelo mesmo canal oficial.

## Atualizações

O painel "Atualizações do aplicativo" distingue cada situação: verificando, versão atual,
nova versão disponível, baixando, baixada, instalando e erro (rede, integridade, assinatura ou
instalador que não abriu). Quando o instalador é baixado, o painel mostra o resultado da
verificação da assinatura Authenticode e oferece o botão "Abrir instalador", que executa o
arquivo diretamente pelo Windows caso o reinício automático não funcione.