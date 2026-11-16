const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = 8790;
const DEFAULT_DOMAIN = "uranometrical-nonequatorial-kiley.ngrok-free.dev";
const DEFAULT_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || "", "Desktop", "storage-server");
const MAX_ATTEMPTS = 6;
const LEGACY_TASK = "FortesDrive - servidor de armazenamento";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(file, args, cwd) {
  return new Promise(resolve => {
    execFile(file, args, { cwd, windowsHide: true, timeout: 180000, maxBuffer: 1 << 20 }, error => resolve(!error));
  });
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function answers(url, headers) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch { return false; }
}

/**
 * Servidor e túnel do modo Servidor, gerenciados pelo próprio aplicativo.
 *
 * O gateway é conferido na porta 8790 e o comando do ngrok
 * (ngrok http --domain=... 8790) roda a partir da pasta raiz do servidor, sem
 * janela de CMD: o processo é filho do aplicativo e continua vivo com a janela
 * principal oculta na bandeja. Se o túnel cair, ele volta sozinho algumas
 * vezes e, se não voltar, o estado e o erro aparecem na bandeja e no painel.
 */
class ServerTunnel {
  constructor({ userDataDir, app, onState }) {
    this.file = path.join(userDataDir, "server-tunnel.json");
    this.app = app;
    this.onState = onState || (() => {});
    this.child = null;
    this.retry = null;
    this.tail = "";
    this.killedStray = false;
    this.state = {
      enabled: false,
      status: "stopped",
      serverRoot: DEFAULT_ROOT,
      domain: DEFAULT_DOMAIN,
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
    await this.readDomain();
    // Reafirma o inicio com o Windows para quem já tinha o túnel ligado.
    if (this.state.enabled) this.app?.setLoginItemSettings?.({ openAtLogin: true, args: ["--background"] });
    return this.getStatus();
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ enabled: this.state.enabled, serverRoot: this.state.serverRoot }), "utf8");
  }

  /** O endereço gravado pelo assistente do servidor é a fonte do domínio. */
  async readDomain() {
    const saved = (await fs.readFile(path.join(this.state.serverRoot, "ngrok-domain.txt"), "utf8").catch(() => "")).trim();
    if (saved) this.state.domain = saved;
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
    await this.readDomain();
    if (this.state.enabled) await this.restart();
    return this.getStatus();
  }

  async restart() {
    await this.stop();
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
    await this.launch();
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

  async launch() {
    const exe = await this.findNgrok();
    if (!exe) {
      return this.fail('O ngrok não está instalado neste computador. Use o atalho "FortesDrive — configurar servidor" do menu Iniciar.');
    }
    // O comando do túnel roda a partir da pasta raiz do servidor.
    const child = spawn(exe, ["http", `--domain=${this.state.domain}`, String(PORT)], {
      cwd: this.state.serverRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.tail = "";
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", data => { this.tail = (this.tail + String(data)).slice(-400); });
    child.on("error", error => {
      if (this.child !== child) return;
      this.child = null;
      this.fail(error.message);
    });
    child.on("exit", () => this.exited(child));

    const url = `https://${this.state.domain}`;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (this.child !== child) return this.getStatus();
      if (await answers(url + "/health", { "ngrok-skip-browser-warning": "1" })) {
        this.update({ status: "online", url, error: "", attempts: 0 });
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
    // Mesmo endereço já publicado por outro ngrok (por exemplo, a tarefa antiga
    // do assistente): encerra o processo duplicado e sobe o túnel de novo.
    if (!this.killedStray && /already online|ERR_NGROK_334|failed to start tunnel/i.test(this.tail)) {
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
    if (process.platform === "win32") await run("taskkill", ["/IM", "ngrok.exe", "/F"]);
  }

  /** A tarefa agendada do assistente antigo disputaria o mesmo endereço público. */
  async removeLegacyTask() {
    if (process.platform === "win32") await run("schtasks", ["/Delete", "/TN", LEGACY_TASK, "/F"]);
  }

  async findNgrok() {
    const recorded = (await fs.readFile(path.join(this.state.serverRoot, "ngrok-path.txt"), "utf8").catch(() => "")).trim();
    const candidates = [
      recorded,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ngrok", "ngrok.exe"),
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, "ngrok.exe"),
      "C:\\ngrok\\ngrok.exe",
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "ngrok", "ngrok.exe"),
    ].filter(Boolean);
    for (const candidate of candidates) if (await exists(candidate)) return candidate;
    return new Promise(resolve => {
      execFile("where", ["ngrok"], { windowsHide: true }, (error, stdout) => {
        resolve(error ? null : String(stdout).split(/\r?\n/)[0].trim() || null);
      });
    });
  }
}

module.exports = { ServerTunnel, DEFAULT_DOMAIN, DEFAULT_ROOT };