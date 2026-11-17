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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(file, args, cwd) {
  return new Promise(resolve => {
    execFile(file, args, { cwd, windowsHide: true, timeout: 180000, maxBuffer: 1 << 20 }, error => resolve(!error));
  });
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok;
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
 * continua vivo com a janela principal oculta na bandeja. Se o túnel cair, ele
 * volta sozinho algumas vezes e, se não voltar, o estado e o erro aparecem na
 * bandeja e no painel.
 *
 * Lê três arquivos que o assistente do servidor grava na pasta do servidor:
 * cloudflare-hostname.txt (endereço público), cloudflared-token.txt (token do
 * tunnel nomeado) e cloudflared-path.txt (onde o cloudflared.exe ficou).
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
    };
  }

  getStatus() { return { ...this.state }; }

  update(patch) {
    Object.assign(this.state, patch);
    this.onState(this.getStatus());
  }

  async init() {
    const raw = await fs.readFile(this.file, "utf8").catch(() => "");
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

  async setEnabled(enabled) {
    this.state.enabled = enabled === true;
    await this.save();
    if (!this.state.enabled) { await this.stop(); return this.getStatus(); }
    this.app?.setLoginItemSettings?.({ openAtLogin: true, args: ["--background"] });
    await this.removeLegacyTask();
    void this.start();
    return this.getStatus();
  }

  async setServerRoot(root) {
    if (!(await exists(root))) throw new Error("Escolha uma pasta que exista no computador.");
    this.state.serverRoot = root;
    await this.save();
    await this.readTunnelFiles();
    if (this.state.enabled) await this.restart();
    return this.getStatus();
  }

  async restart() {
    await this.stop();
    // Reiniciar precisa valer de verdade: encerra também um túnel que a tarefa
    // do Windows deixou no ar, para não continuar no estado antigo.
    await this.killStray();
    void this.start();
    return this.getStatus();
  }

  async start({ attempts = 0 } = {}) {
    if (!this.state.enabled || this.child) return this.getStatus();
    clearTimeout(this.retry);
    this.state.attempts = attempts;
    this.update({ status: "starting", error: "", url: "" });
    if (!(await this.ensureServer())) return this.getStatus();
    if (!this.state.enabled) return this.getStatus();
    await this.readTunnelFiles();

    // O assistente do servidor já pode ter deixado o túnel no ar (tarefa do
    // Windows): nesse caso ele é usado como está, sem abrir um segundo agente.
    const plan = tunnelPlan({ token: this.token, hostname: this.state.hostname, port: PORT });
    if (plan.url && (await answers(plan.url + "/health"))) {
      this.update({ status: "online", url: plan.url, error: "", attempts: 0 });
      return this.getStatus();
    }
    await this.launch(plan);
    return this.getStatus();
  }

  async ensureServer() {
    if (await answers(`http://127.0.0.1:${PORT}/health`)) return true;
    if (!(await exists(path.join(this.state.serverRoot, "docker-compose.yml")))) {
      return this.fail("A pasta raiz do servidor não foi encontrada neste computador. Escolha a pasta onde o servidor foi instalado.");
    }
    this.update({ status: "starting", error: "Iniciando o servidor local..." });
    await run("docker", ["compose", "up", "-d"], this.state.serverRoot);
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      if (!this.state.enabled) return false;
      if (await answers(`http://127.0.0.1:${PORT}/health`)) { this.update({ error: "" }); return true; }
    }
    return this.fail("O servidor local não respondeu na porta 8790. Abra o Docker Desktop e reinicie o túnel.");
  }

  async launch(plan) {
    const exe = await this.findCloudflared();
    if (!exe) {
      return this.fail('O cloudflared não está instalado neste computador. Use o atalho "FortesDrive — configurar servidor" do menu Iniciar.');
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

    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (this.child !== child) return this.getStatus();
      // Túnel rápido: o cloudflared anuncia o endereço publicado no log e ele
      // muda a cada subida — é esse o endereço a conferir.
      const quick = plan.mode === "quick" ? (this.log.match(QUICK_URL) || [])[0] : "";
      const url = plan.mode === "named" ? plan.url : quick;
      if (url && (await answers(url + "/health"))) {
        this.update({ status: "online", url, mode: plan.mode, error: "", attempts: 0 });
        return this.getStatus();
      }
    }
    this.child = null;
    await this.kill(child);
    this.schedule();
    return this.getStatus();
  }

  async exited(child) {
    if (this.child !== child) return;
    this.child = null;
    // Um agente anterior (tarefa antiga do assistente) publicando o mesmo túnel:
    // encerra o processo duplicado e sobe o túnel de novo.
    if (!this.killedStray && /already|in use|conflict|failed to start|unable to|connection refused/i.test(this.tail)) {
      this.killedStray = true;
      await this.killStray();
      return void this.start({ attempts: this.state.attempts });
    }
    this.killedStray = false;
    this.schedule();
  }

  schedule() {
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
    return false;
  }

  async stop() {
    clearTimeout(this.retry);
    const child = this.child;
    this.child = null;
    if (child) await this.kill(child);
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