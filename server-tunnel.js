const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = 8790;
const MAX_ATTEMPTS = 6;
const LEGACY_TASK = "FortesDrive - servidor de armazenamento";
const DEFAULT_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || "", "Desktop", "storage-server");
// Túnel rápido do Cloudflare (sem conta): o endereço muda a cada subida.
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
// Hostname público fixo do servidor: o Public Hostname do tunnel Cloudflare
// desta instalação. Vale quando a pasta do servidor ainda não tem o arquivo
// cloudflare-hostname.txt, para o app nunca cair num endereço temporário.
const FIXED_HOSTNAME = "nuvem.fortesdrive.dpdns.org";
// Espera máxima pela publicação do endereço depois de abrir o túnel.
const LAUNCH_TIMEOUT_MS = 60000;
// Tempo máximo de cada teste do diagnóstico (local e público).
const PROBE_TIMEOUT_MS = 8000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(file, args, cwd, timeout = 180000) {
  return new Promise(resolve => {
    execFile(file, args, { cwd, windowsHide: true, timeout, maxBuffer: 1 << 20 }, error => resolve(!error));
  });
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => null);
    return response.ok && body?.ok === true;
  } catch { return false; }
}

/** Endereço público digitado no assistente: só o nome do host, sem esquema nem barra. */
function normalizeHost(value) {
  return String(value || "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

// Túnel antigo e o endereço do próprio app: nenhum dos dois é o servidor de
// armazenamento, e publicar um deles faria todo envio falhar. O FortesDrive usa
// o Cloudflare Tunnel com o hostname fixo acima.
const LEGACY_TUNNEL_HOST = /(^|\.)n[g]rok(-free)?\.(dev|io|app)$/i;
const APP_DOMAIN_HOST = /(^|\.)base44\.app$/i;
// Nome DNS puro: rótulos sem começar/terminar em hífen, com pelo menos um ponto.
const HOSTNAME_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * O valor serve como Public Hostname do túnel? Devolve o motivo da recusa ou
 * uma string vazia quando está bom — assim a mensagem na tela diz o que
 * corrigir em vez de só "endereço inválido".
 */
function hostnameProblem(value) {
  const host = normalizeHost(value);
  if (!host) return "Informe o endereço público do túnel (o Public Hostname da Cloudflare).";
  if (LEGACY_TUNNEL_HOST.test(host)) {
    return "Este é um endereço de túnel antigo, que o FortesDrive não usa mais. O servidor usa o Cloudflare Tunnel com o hostname fixo " + FIXED_HOSTNAME + ".";
  }
  if (APP_DOMAIN_HOST.test(host)) {
    return "Este é o endereço do próprio app FortesDrive, não o do seu servidor. Crie o Public Hostname do túnel num domínio que esteja na sua conta Cloudflare.";
  }
  if (!HOSTNAME_SHAPE.test(host)) {
    return "Endereço inválido: informe apenas o nome do host, sem esquema, sem caminho e sem barra no final (exemplo: drive.seudominio.com).";
  }
  return "";
}

/**
 * Comando do cloudflared. Com token, o Cloudflare entrega o túnel nomeado (o
 * hostname público é definido no painel da Cloudflare e não muda). Sem token, o
 * túnel rápido devolve um endereço trycloudflare.com que muda a cada subida.
 */
function tunnelPlan({ token, hostname, port = PORT }) {
  const host = normalizeHost(hostname);
  if (token) {
    return {
      mode: "named",
      args: ["tunnel", "--no-autoupdate", "run", "--token", token],
      url: host ? "https://" + host : "",
      host,
    };
  }
  return {
    mode: "quick",
    args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:" + port],
    url: "",
    host,
  };
}

/**
 * Servidor e túnel do modo Servidor, gerenciados pelo próprio aplicativo.
 *
 * O gateway é conferido na porta 8790 e o cloudflared roda a partir da pasta
 * raiz do servidor, sem janela de CMD: o processo é filho do aplicativo e
 * continua vivo com a janela principal oculta na bandeja.
 *
 * As ações (iniciar, parar, reiniciar, diagnosticar) devolvem sempre um
 * resultado com o mesmo formato — { ok, action, message, state } — para o painel
 * mostrar uma confirmação clara em vez de só um ícone girando, e nunca declarar
 * "conectado" antes de o endereço público responder o gateway.
 */
class ServerTunnel {
  constructor({ userDataDir, app, onState }) {
    this.file = path.join(userDataDir, "server-tunnel.json");
    this.app = app;
    this.onState = onState || (() => {});
    this.child = null;
    this.retry = null;
    this.tail = "";
    this.log = "";
    this.killedStray = false;
    this.busy = "";
    // Já existe uma escolha salva (ligada ou desligada) pelo usuário. Sem esse
    // registro, esta é a primeira abertura na função de servidor.
    this.configured = false;
    // Subida manual: o túnel roda mesmo com a subida automática desativada,
    // até o usuário parar ou fechar o aplicativo.
    this.manual = false;
    this.state = {
      enabled: false,
      status: "stopped",
      serverRoot: DEFAULT_ROOT,
      hostname: "",
      mode: "",
      url: "",
      port: PORT,
      attempts: 0,
      error: "",
      busy: "",
      lastAction: null,
      diagnosis: null,
    };
  }

  getStatus() { return { ...this.state }; }

  update(patch) {
    Object.assign(this.state, patch);
    this.onState(this.getStatus());
  }

  /** Uma operação por vez: o painel desabilita as outras enquanto isso. */
  begin(kind) {
    if (this.busy) return false;
    this.busy = kind;
    this.update({ busy: kind });
    return true;
  }

  end() {
    this.busy = "";
    this.update({ busy: "" });
  }

  busyReply(kind) {
    return { ok: false, action: kind, message: "Aguarde a operação em andamento terminar.", state: this.getStatus() };
  }

  /** Confirmação persistente: é o que o painel mostra até a próxima ação. */
  finish(kind, ok, message) {
    this.update({ lastAction: { kind, ok, message, at: new Date().toISOString() } });
    return { ok, action: kind, message, state: this.getStatus() };
  }

  async init() {
    const raw = await fs.readFile(this.file, "utf8").catch(() => "");
    this.configured = raw.trim().length > 0;
    try {
      const saved = JSON.parse(raw || "{}");
      if (saved.serverRoot) this.state.serverRoot = saved.serverRoot;
      this.state.enabled = saved.enabled === true;
    } catch { /* arquivo ilegivel: volta ao padrao */ }
    await this.readTunnelFiles();
    // Reafirma o inicio com o Windows para quem já tinha o túnel ligado.
    if (this.state.enabled) this.app?.setLoginItemSettings?.({ openAtLogin: true, args: ["--background"] });
    return this.getStatus();
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ enabled: this.state.enabled, serverRoot: this.state.serverRoot }), "utf8");
  }

  /** Endereço e token gravados pelo assistente do servidor. */
  async readTunnelFiles() {
    const host = await fs.readFile(path.join(this.state.serverRoot, "cloudflare-hostname.txt"), "utf8").catch(() => "");
    this.state.hostname = normalizeHost(host) || FIXED_HOSTNAME;
    this.token = (await fs.readFile(path.join(this.state.serverRoot, "cloudflared-token.txt"), "utf8").catch(() => "")).trim();
    this.state.mode = this.token ? "named" : "quick";
  }

  // ── Subida automática com o Windows (preferência, não conexão) ─────────
  async setEnabled(enabled) {
    if (!this.begin("autostart")) return this.busyReply("autostart");
    try {
      const want = enabled === true;
      this.state.enabled = want;
      await this.save();
      if (!want) {
        this.manual = false;
        await this.stop();
        await this.killStray();
        return this.finish("autostart", true, "Subida automática desativada. O túnel foi encerrado e continua parado até você iniciar de novo.");
      }
      this.app?.setLoginItemSettings?.({ openAtLogin: true, args: ["--background"] });
      await this.removeLegacyTask();
      this.manual = true;
      void this.start({ force: true });
      return this.finish("autostart", true, "Subida automática ativada: o servidor e o túnel sobem junto com o Windows.");
    } catch (error) {
      return this.finish("autostart", false, "Não foi possível salvar a subida automática: " + error.message);
    } finally {
      this.end();
    }
  }

  async setServerRoot(root) {
    if (!this.begin("root")) return this.busyReply("root");
    const wasRunning = Boolean(this.child) || ["online", "starting", "reconnecting"].includes(this.state.status);
    try {
      if (!(await exists(root))) throw new Error("Escolha uma pasta que exista no computador.");
      this.state.serverRoot = root;
      await this.save();
      await this.readTunnelFiles();
      if (wasRunning || this.state.enabled || this.manual) {
        await this.stop();
        void this.start({ force: true });
      }
      return this.finish("root", true, "Pasta do servidor atualizada.");
    } catch (error) {
      return this.finish("root", false, error.message);
    } finally {
      this.end();
    }
  }

  // ── Ações do painel ────────────────────────────────────────────────────
  async startTunnel() {
    if (!this.begin("start")) return this.busyReply("start");
    try {
      this.manual = true;
      if (this.state.status === "online" && this.child) {
        return this.finish("start", true, "O túnel já está conectado em " + this.state.url + ".");
      }
      const result = await this.start({ force: true });
      return this.finish("start", result.ok, result.message);
    } catch (error) {
      this.update({ status: "error", error: error.message, url: "" });
      return this.finish("start", false, "Não foi possível iniciar o túnel: " + error.message);
    } finally {
      this.end();
    }
  }

  async stopTunnel() {
    if (!this.begin("stop")) return this.busyReply("stop");
    try {
      this.manual = false;
      const wasRunning = Boolean(this.child) || ["online", "starting", "reconnecting", "error"].includes(this.state.status);
      await this.stop();
      await this.killStray();
      return this.finish(
        "stop",
        true,
        wasRunning
          ? "Túnel encerrado. O endereço público fica fora do ar até você iniciar de novo."
          : "O túnel já estava parado."
      );
    } catch (error) {
      return this.finish("stop", false, "Não foi possível parar o túnel: " + error.message);
    } finally {
      this.end();
    }
  }

  async restartTunnel() {
    if (!this.begin("restart")) return this.busyReply("restart");
    try {
      this.manual = true;
      this.update({ status: "starting", error: "", url: "" });
      await this.stop();
      // Reiniciar precisa valer de verdade: encerra também um túnel que a tarefa
      // do Windows deixou no ar, para não continuar no estado antigo.
      await this.killStray();
      const result = await this.start({ force: true });
      return this.finish("restart", result.ok, result.message);
    } catch (error) {
      this.update({ status: "error", error: error.message, url: "" });
      return this.finish("restart", false, "Não foi possível reiniciar o túnel: " + error.message);
    } finally {
      this.end();
    }
  }

  /** Compatibilidade: a bandeja e chamadas antigas usam este nome. */
  restart() { return this.restartTunnel(); }

  // ── Diagnóstico: gateway local e acesso público, separados ─────────────
  async diagnose() {
    if (!this.begin("diagnose")) return this.busyReply("diagnose");
    try {
      const local = await this.probeLocal();
      const publicUrl = this.state.url || (this.state.mode === "named" && this.state.hostname ? "https://" + this.state.hostname : "");
      const pub = await this.probePublic(publicUrl);
      const exe = await this.findCloudflared();
      const diagnosis = {
        at: new Date().toISOString(),
        url: pub.url || null,
        local,
        public: pub,
        tunnel: {
          status: this.state.status,
          mode: this.state.mode,
          hostname: this.state.hostname,
          error: this.state.error || "",
          cloudflared: Boolean(exe),
        },
        summary: this.summarize(local, pub),
        advice: this.adviceFor(local, pub, Boolean(exe)),
      };
      this.update({ diagnosis });
      return this.finish("diagnose", local.ok && pub.ok, diagnosis.summary);
    } catch (error) {
      return this.finish("diagnose", false, "Não foi possível concluir o diagnóstico: " + error.message);
    } finally {
      this.end();
    }
  }

  /** O gateway responde na porta 8790 deste computador? */
  async probeLocal() {
    const at = new Date().toISOString();
    const started = Date.now();
    try {
      const response = await fetch("http://127.0.0.1:" + PORT + "/health", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const raw = await response.text().catch(() => "");
      let body = null;
      try { body = JSON.parse(raw); } catch { /* corpo não é JSON */ }
      const latencyMs = Date.now() - started;
      if (response.ok && body?.ok === true) {
        const storage = body.storage || {};
        const writable = storage.writable !== false;
        return {
          ok: writable,
          at,
          latencyMs,
          status: response.status,
          version: body.version || null,
          message: writable
            ? "O gateway respondeu no computador (versão " + (body.version || "?") + ")."
            : "O gateway respondeu, mas o armazenamento não aceitou gravação (" + (storage.reason || "motivo não informado") + ").",
        };
      }
      return {
        ok: false,
        at,
        latencyMs,
        status: response.status,
        version: null,
        message: response.status === 404
          ? "A porta 8790 respondeu, mas não é o gateway FortesDrive (rota /health não encontrada)."
          : "A porta 8790 respondeu " + response.status + " em /health e não é o gateway FortesDrive.",
      };
    } catch (error) {
      return {
        ok: false,
        at,
        latencyMs: Date.now() - started,
        status: 0,
        version: null,
        message: error?.name === "TimeoutError"
          ? "O gateway não respondeu em 8 segundos na porta 8790."
          : "Não há gateway respondendo na porta 8790 deste computador (" + (error?.message || "falha de rede") + ").",
      };
    }
  }

  /** O endereço público entrega o gateway FortesDrive? */
  async probePublic(url) {
    const at = new Date().toISOString();
    if (!url) {
      return { ok: false, at, url: null, latencyMs: 0, status: 0, message: "O túnel ainda não publicou um endereço público." };
    }
    const started = Date.now();
    try {
      const response = await fetch(url + "/health", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const raw = await response.text().catch(() => "");
      let body = null;
      try { body = JSON.parse(raw); } catch { /* corpo não é JSON */ }
      const latencyMs = Date.now() - started;
      if (response.ok && body?.ok === true) {
        return {
          ok: true, at, url, latencyMs, status: response.status,
          message: "O endereço público responde o gateway FortesDrive (versão " + (body.version || "?") + ").",
        };
      }
      const fromCloudflare = Boolean(response.headers.get("cf-ray")) || response.status >= 500;
      return {
        ok: false, at, url, latencyMs, status: response.status,
        message: fromCloudflare
          ? "A borda do Cloudflare respondeu " + response.status + " em vez do servidor: o túnel existe, mas não está entregando a porta 8790."
          : "O endereço respondeu " + response.status + " em /health e não é o gateway FortesDrive.",
      };
    } catch (error) {
      return {
        ok: false, at, url, latencyMs: Date.now() - started, status: 0,
        message: error?.name === "TimeoutError"
          ? "O endereço público não respondeu em 8 segundos."
          : "Não foi possível alcançar o endereço público a partir deste computador: " + (error?.message || "falha de rede") + ".",
      };
    }
  }

  summarize(local, pub) {
    if (local.ok && pub.ok) return "Gateway e acesso público respondendo.";
    if (!local.ok && !pub.ok) return "Nada respondendo: o gateway local e o acesso público falharam.";
    if (local.ok) return "Gateway local OK, acesso público com falha.";
    return "Gateway local com falha; o acesso público respondeu " + (pub.status || "sem resposta") + ".";
  }

  adviceFor(local, pub, hasCloudflared) {
    if (local.ok && pub.ok) return ["Nada a corrigir: o gateway e o acesso público estão respondendo."];
    const advice = [];
    if (!local.ok) {
      advice.push("O gateway não está respondendo na porta 8790 deste computador.");
      advice.push('Abra o atalho "FortesDrive - configurar servidor" no menu Iniciar para subir o Docker e o gateway, e faça o diagnóstico de novo.');
    } else {
      advice.push("O gateway responde neste computador, então a falha está no túnel do Cloudflare.");
      if (pub.status >= 500 || /Cloudflare/.test(pub.message)) {
        advice.push("O conector do túnel está ativo, mas não entrega o gateway: no Docker ele precisa apontar para http://gateway:8790. Com localhost ali, o conector procura o gateway dentro do próprio contêiner e o endereço responde 502.");
      }
      advice.push("Clique em Reiniciar túnel para subir de novo o serviço do túnel no Docker.");
      advice.push("No painel da Cloudflare (Zero Trust > Networks > Tunnels), confira se o Public Hostname do túnel aponta para http://gateway:8790 e se o tunnel aparece como Healthy.");
    }
    if (!hasCloudflared && this.state.mode === "quick") {
      advice.push('O cloudflared não foi encontrado: rode o atalho "FortesDrive - configurar servidor" do menu Iniciar.');
    }
    if (this.state.mode === "quick") {
      advice.push("O túnel atual é temporário: o endereço muda a cada subida. Guarde o token do túnel nomeado pelo atalho de configuração para ter endereço fixo.");
    }
    return advice;
  }

  // O Docker não dispara child.exit: vigia também o túnel nomeado, não só o binário.
  watchConnection() {
    if (this.monitor || this.state.mode !== 'named') return;
    this.monitor = setInterval(() => {
      this.checkConnection().catch(error => this.update({ status: 'error', error: error.message, url: '' }));
    }, 30000);
    this.monitor.unref?.();
  }

  async checkConnection() {
    if ((!this.state.enabled && !this.manual) || this.busy || this.starting || this.checking) return;
    this.checking = true;
    const epoch = this.connectionEpoch || 0;
    try {
      const pub = await this.probePublic('https://' + this.state.hostname);
      if (epoch !== (this.connectionEpoch || 0)) return;
      if (pub.ok) {
        this.connectionFailures = 0; this.nextRecoveryAt = 0;
        this.update({ status: 'online', url: pub.url, error: '', attempts: 0 });
        return;
      }
      this.connectionFailures = (this.connectionFailures || 0) + 1;
      this.update({ status: 'reconnecting', url: '', error: pub.message });
      if (this.connectionFailures < 2 || Date.now() < (this.nextRecoveryAt || 0)) return;
      this.nextRecoveryAt = Date.now() + 120000;
      await this.start({ force: true });
    } finally { this.checking = false; }
  }

  // Uma única inicialização, inclusive na abertura automática do modo servidor.
  start(options = {}) {
    if (this.starting) return this.starting;
    this.starting = this.startOnce(options).finally(() => { this.starting = null; });
    return this.starting;
  }

  // ── Máquina de estados do túnel ────────────────────────────────────────
  async startOnce({ attempts = 0, force = false } = {}) {
    const epoch = this.connectionEpoch || 0;
    if (!this.state.enabled && !this.manual && !force) {
      return { ok: false, message: "A subida automática está desativada." };
    }
    if (this.child) {
      return this.state.status === "online"
        ? { ok: true, message: "O túnel já está conectado em " + this.state.url + "." }
        : { ok: false, message: "O túnel já está sendo iniciado." };
    }
    clearTimeout(this.retry);
    this.state.attempts = attempts;
    this.update({ status: "starting", error: "", url: "" });

    // O token é lido antes de subir os serviços: é ele que diz se o túnel do
    // Docker (perfil "tunnel" do Compose) entra junto.
    await this.readTunnelFiles();
    if (epoch !== (this.connectionEpoch || 0)) return { ok: false, message: 'Inicialização cancelada.' };
    this.watchConnection();
    const server = await this.ensureServer();
    if (epoch !== (this.connectionEpoch || 0)) return { ok: false, message: 'Inicialização cancelada.' };
    if (!server.ok) return server;
    if (!this.state.enabled && !this.manual) {
      return { ok: false, message: "A subida automática foi desativada." };
    }
    await this.readTunnelFiles();

    // O assistente do servidor já pode ter deixado o túnel no ar: nesse caso ele
    // é usado como está, sem abrir um segundo conector.
    const plan = tunnelPlan({ token: this.token, hostname: this.state.hostname, port: PORT });
    const online = plan.url && (await answers(plan.url + '/health'));
    if (epoch !== (this.connectionEpoch || 0)) return { ok: false, message: 'Inicialização cancelada.' };
    if (online) {
      this.update({ status: "online", url: plan.url, error: "", attempts: 0 });
      return { ok: true, message: "Túnel conectado e validado em " + plan.url + "." };
    }
    // Túnel nomeado roda no Docker: o serviço cloudflared do Compose entrega o
    // endereço ao gateway por http://gateway:8790, dentro da rede dos contêineres.
    if (plan.mode === "named") return this.startContainer(plan, epoch);
    return this.launch(plan);
  }

  /** Comando do Docker Compose na pasta do servidor (o túnel é um serviço dele). */
  compose(args) {
    return run("docker", ["compose", ...args], this.state.serverRoot);
  }

  /** Sobe o serviço do túnel no Docker e espera o endereço público responder. */
  async startContainer(plan, epoch = this.connectionEpoch || 0) {
    this.update({ status: "starting", error: "", url: "" });
    const args = ["--profile", "tunnel", "up", "-d", "--no-deps", "cloudflared"];
    args.splice(args.length - 1, 0, '--force-recreate');
    const started = await this.compose(args);
    if (epoch !== (this.connectionEpoch || 0)) return { ok: false, message: 'Inicialização cancelada.' };
    if (!started) {
      return this.fail('Não foi possível subir o túnel no Docker. Abra o Docker Desktop e confira "docker compose logs cloudflared" na pasta do servidor.');
    }
    for (let i = 0; i < LAUNCH_TIMEOUT_MS / 1000; i++) {
      await sleep(1000);
      if (!this.state.enabled && !this.manual) return { ok: false, message: "A subida automática foi desativada." };
      const online = await answers(plan.url + '/health');
      if (epoch !== (this.connectionEpoch || 0)) return { ok: false, message: 'Inicialização cancelada.' };
      if (online) {
        this.update({ status: "online", url: plan.url, mode: "named", error: "", attempts: 0 });
        return { ok: true, message: "Túnel conectado e validado em " + plan.url + "." };
      }
    }
    return this.fail(
      "O túnel subiu no Docker, mas " + plan.url + " não respondeu em " + LAUNCH_TIMEOUT_MS / 1000 +
        ' segundos. Confira "docker compose logs cloudflared" e se o Public Hostname aponta para http://gateway:8790.'
    );
  }

  // Atualizações silenciosas entregavam o pacote novo, mas o Docker usava a cópia antiga.
  async updateGatewayIfNeeded(version) {
    if (process.platform !== 'win32' || !this.app?.isPackaged || !['2.0.2', '2.1.0', '2.2.2', '2.3.0'].includes(version)) return true;
    const repair = path.join(process.resourcesPath, 'server', 'repair-uploads.bat');
    if (!(await exists(repair))) return false;
    this.update({ status: 'starting', error: 'Aplicando a atualização do servidor, preservando os arquivos...' });
    return run('cmd.exe', ['/d', '/s', '/c', `call "${repair}" "${this.state.serverRoot}" automatic`], this.state.serverRoot, 10 * 60 * 1000);
  }

  async ensureServer() {
    const local = await this.probeLocal();
    if (local.version && !(await this.updateGatewayIfNeeded(local.version))) {
      return this.fail('A atualização do servidor não foi aplicada. Seus dados foram preservados; use "FortesDrive - configurar servidor" para concluir.');
    }
    if (await answers(`http://127.0.0.1:${PORT}/health`)) return { ok: true };
    if (!(await exists(path.join(this.state.serverRoot, "docker-compose.yml")))) {
      return this.fail("A pasta raiz do servidor não foi encontrada neste computador. Escolha a pasta onde o servidor foi instalado.");
    }
    this.update({ status: "starting", error: "Iniciando o servidor local..." });
    // Sem token o perfil "tunnel" fica de fora: o resto do servidor sobe normal.
    await this.compose([...(this.token ? ["--profile", "tunnel"] : []), "up", "-d"]);
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      if (!this.state.enabled && !this.manual) return { ok: false, message: "A subida automática foi desativada." };
      if (await answers(`http://127.0.0.1:${PORT}/health`)) { this.update({ error: "" }); return { ok: true }; }
    }
    return this.fail("O servidor local não respondeu na porta 8790. Abra o Docker Desktop e inicie o túnel de novo.");
  }

  async launch(plan) {
    const exe = await this.findCloudflared();
    if (!exe) {
      return this.fail('O cloudflared não está instalado neste computador. Use o atalho "FortesDrive - configurar servidor" do menu Iniciar.');
    }
    if (plan.mode === "named") {
      const problema = hostnameProblem(plan.host);
      if (problema) return this.fail(problema);
    }

    // O comando do túnel roda a partir da pasta raiz do servidor.
    const child = spawn(exe, plan.args, {
      cwd: this.state.serverRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.tail = "";
    this.log = "";
    child.stdout?.on("data", data => { this.log = (this.log + String(data)).slice(-4000); });
    child.stderr?.on("data", data => { this.tail = (this.tail + String(data)).slice(-400); this.log = (this.log + String(data)).slice(-4000); });
    child.on("error", error => {
      if (this.child !== child) return;
      this.child = null;
      this.fail(error.message);
    });
    child.on("exit", () => this.exited(child));

    for (let i = 0; i < LAUNCH_TIMEOUT_MS / 1000; i++) {
      await sleep(1000);
      if (this.child !== child) {
        return { ok: false, message: this.state.error || "O túnel encerrou antes de conectar." };
      }
      // Túnel rápido: o cloudflared anuncia o endereço publicado no log e ele
      // muda a cada subida — é esse o endereço a conferir.
      const quick = plan.mode === "quick" ? (this.log.match(QUICK_URL) || [])[0] : "";
      const url = plan.mode === "named" ? plan.url : quick;
      if (url && (await answers(url + "/health"))) {
        this.update({ status: "online", url, mode: plan.mode, error: "", attempts: 0 });
        return {
          ok: true,
          message: plan.mode === "named"
            ? "Túnel conectado e validado em " + url + "."
            : "Túnel temporário conectado em " + url + " (o endereço muda a cada subida).",
        };
      }
    }
    this.child = null;
    await this.kill(child);
    const last = this.tail.trim().split(/\r?\n/).pop();
    this.update({ status: "error", error: last || "O túnel não respondeu no endereço público.", url: "" });
    this.schedule();
    return {
      ok: false,
      message: "O túnel abriu, mas " + (plan.url || "o endereço público") + " não respondeu em " + LAUNCH_TIMEOUT_MS / 1000 + " segundos." +
        (last ? " Última mensagem: " + last : ""),
    };
  }

  async exited(child) {
    if (this.child !== child) return;
    this.child = null;
    // Um agente anterior (tarefa antiga do assistente) publicando o mesmo túnel:
    // encerra o processo duplicado e sobe o túnel de novo.
    if (!this.killedStray && /already|in use|conflict|failed to start|unable to/i.test(this.tail)) {
      this.killedStray = true;
      await this.killStray();
      return void this.start({ attempts: this.state.attempts });
    }
    this.killedStray = false;
    this.schedule();
  }

  schedule() {
    if (!this.state.enabled && !this.manual) return;
    const attempts = this.state.attempts + 1;
    if (attempts > MAX_ATTEMPTS) {
      const last = this.tail.trim().split(/\r?\n/).pop();
      return this.fail(last || "O túnel encerrou inesperadamente.");
    }
    this.update({ status: "reconnecting", attempts, url: "" });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.start({ attempts }).catch(() => {}); }, Math.min(30000, 5000 * attempts));
  }

  fail(message) {
    this.update({ status: "error", error: message, url: "" });
    return { ok: false, message };
  }

  async stop() {
    this.connectionEpoch = (this.connectionEpoch || 0) + 1;
    clearInterval(this.monitor); this.monitor = null;
    this.connectionFailures = 0; this.nextRecoveryAt = 0;
    clearTimeout(this.retry);
    const child = this.child;
    this.child = null;
    if (child) await this.kill(child);
    // Túnel nomeado: quem para é o serviço do Docker (o Compose não o reinicia
    // sozinho depois de um stop).
    if (this.state.mode === "named" && (await exists(path.join(this.state.serverRoot, "docker-compose.yml")))) {
      await this.compose(["--profile", "tunnel", "stop", "cloudflared"]);
    }
    this.update({ status: "stopped", error: "", url: "", attempts: 0 });
    return this.getStatus();
  }

  async kill(child) {
    if (!child || child.killed || !child.pid) return;
    if (process.platform === "win32") await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill();
  }

  async killStray() {
    if (process.platform === "win32") await run("taskkill", ["/IM", "cloudflared.exe", "/F"]);
  }

  /** A tarefa agendada do assistente antigo disputaria o mesmo endereço público. */
  async removeLegacyTask() {
    if (process.platform === "win32") await run("schtasks", ["/Delete", "/TN", LEGACY_TASK, "/F"]);
  }

  async findCloudflared() {
    const recorded = (await fs.readFile(path.join(this.state.serverRoot, "cloudflared-path.txt"), "utf8").catch(() => "")).trim();
    const candidates = [
      recorded,
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "cloudflared", "cloudflared.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "cloudflared", "cloudflared.exe"),
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, "cloudflared.exe"),
    ].filter(Boolean);
    for (const candidate of candidates) if (await exists(candidate)) return candidate;
    return new Promise(resolve => {
      execFile("where", ["cloudflared"], { windowsHide: true }, (error, stdout) => {
        resolve(error ? null : String(stdout).split(/\r?\n/)[0].trim() || null);
      });
    });
  }
}

module.exports = {
  ServerTunnel, PORT, DEFAULT_ROOT, QUICK_URL, FIXED_HOSTNAME, normalizeHost, tunnelPlan,
  hostnameProblem, LEGACY_TUNNEL_HOST, APP_DOMAIN_HOST,
};