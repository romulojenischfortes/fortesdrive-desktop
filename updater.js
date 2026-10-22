const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { shell } = require("electron");

// Estados públicos do atualizador:
//   unsupported | idle | checking | current | available | downloading
//   downloaded | installing | error
// `errorKind` classifica a falha para a interface mostrar orientação útil:
//   network | integrity | signature | installer | generic
class DesktopUpdater {
  constructor(updater, app, engine, notify) {
    this.updater = updater; this.app = app; this.engine = engine; this.notify = notify;
    this.state = {
      status: app.isPackaged ? "idle" : "unsupported",
      currentVersion: app.getVersion(),
      version: null,
      percent: 0,
      error: "",
      errorKind: "",
      detail: "",
      installerPath: null,
      installerExists: false,
      signature: "unknown",
      // A atualização baixada é aplicada sozinha quando o aplicativo é fechado.
      autoInstallOnExit: true,
    };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.logger = console;

    updater.on("checking-for-update", () => this.patch({ status: "checking", error: "", errorKind: "", detail: "" }));
    updater.on("update-available", info => {
      this.patch({ status: "available", version: info.version, percent: 0, error: "", errorKind: "", detail: "" });
      notify("FortesDrive — Nova versão disponível", `A versão ${info.version} está sendo baixada automaticamente. Você será avisado quando estiver pronta.`);
      // Baixa sem depender de clique. Se falhar, volta para "disponível" para
      // tentar novamente na próxima verificação automática.
      this.download()
        .then(status => { if (status.status === "error") this.patch({ status: "available" }); })
        .catch(() => {});
    });
    updater.on("update-not-available", () => this.patch({ status: "current", error: "", errorKind: "", detail: "" }));
    updater.on("download-progress", progress => this.patch({ status: "downloading", percent: Math.round(progress.percent || 0) }));
    updater.on("update-downloaded", info => {
      const installerPath = this.findInstaller();
      this.patch({
        status: "downloaded",
        version: info.version,
        percent: 100,
        error: "",
        errorKind: "",
        detail: "",
        installerPath,
        installerExists: !!installerPath,
      });
      this.verifyUpdateSignature().catch(() => {});
      notify("FortesDrive — Atualização pronta", `A versão ${info.version} será instalada automaticamente quando você fechar o aplicativo.`);
    });
    updater.on("error", error => this.patch(this.classify(error)));
  }

  patch(change) { Object.assign(this.state, change); }
  getStatus() { return { ...this.state }; }

  /** true quando há uma atualização baixada aguardando ser aplicada. */
  hasPendingUpdate() { return this.state.status === "downloaded"; }

  classify(error) {
    const raw = String((error && error.message) || error || "Falha desconhecida");
    const lower = raw.toLowerCase();
    if (lower.includes("net::") || lower.includes("econn") || lower.includes("etimedout") ||
        lower.includes("getaddrinfo") || lower.includes("enotfound") || lower.includes("socket")) {
      return { status: "error", errorKind: "network", error: "Não foi possível alcançar o servidor de atualizações. Verifique a conexão e tente novamente.", detail: raw };
    }
    if (lower.includes("checksum") || lower.includes("sha512") || lower.includes("sha256")) {
      return { status: "error", errorKind: "integrity", error: "O arquivo baixado não confere com o esperado. A atualização foi cancelada por segurança — baixe novamente pela página oficial.", detail: raw };
    }
    if (lower.includes("signature") || lower.includes("signed") || lower.includes("publisher")) {
      return { status: "error", errorKind: "signature", error: "A assinatura digital do instalador não pôde ser validada. Baixe novamente pela página oficial do FortesDrive.", detail: raw };
    }
    return { status: "error", errorKind: "generic", error: "Não foi possível preparar a atualização: " + raw, detail: raw };
  }

  // Procura o instalador já baixado no cache do electron-updater.
  findInstaller() {
    const parent = path.dirname(this.app.getPath("userData"));
    try {
      for (const entry of fs.readdirSync(parent)) {
        if (!entry.toLowerCase().endsWith("-updater")) continue;
        const pending = path.join(parent, entry, "pending");
        let files = [];
        try { files = fs.readdirSync(pending); } catch (e) { continue; }
        const exe = files.find(file => file.toLowerCase().endsWith(".exe"));
        if (exe) return path.join(pending, exe);
      }
    } catch (error) {
      console.error("Falha ao localizar o instalador baixado:", error.message);
    }
    return null;
  }

  async check() {
    if (!this.app.isPackaged) return this.getStatus();
    if (["checking", "downloading", "installing"].includes(this.state.status)) return this.getStatus();
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.patch(this.classify(error));
    }
    return this.getStatus();
  }

  async download() {
    if (this.state.status !== "available") throw new Error("Verifique as atualizações antes de baixar.");
    this.patch({ status: "downloading", percent: 0, error: "", errorKind: "" });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.patch(this.classify(error));
    }
    return this.getStatus();
  }

  /**
   * Verifica a assinatura Authenticode do instalador baixado.
   * Resultado: valid | unsigned | invalid | unknown
   */
  async verifyUpdateSignature() {
    const file = this.state.installerPath || this.findInstaller();
    if (!file) {
      this.patch({ installerPath: null, installerExists: false, signature: "unknown" });
      return this.getStatus();
    }
    const exists = fs.existsSync(file);
    this.patch({ installerPath: file, installerExists: exists });
    if (!exists || process.platform !== "win32") return this.getStatus();

    const status = await new Promise((resolve) => {
      execFile(
        "powershell",
        ["-NoProfile", "-Command", "(Get-AuthenticodeSignature -LiteralPath $env:FD_UPD_FILE).Status"],
        { env: { ...process.env, FD_UPD_FILE: file }, windowsHide: true, timeout: 20000 },
        (error, stdout) => resolve(error ? "unknown" : String(stdout || "").trim())
      );
    });
    const signature = status === "Valid" ? "valid" : status === "NotSigned" ? "unsigned" : status === "unknown" ? "unknown" : "invalid";
    this.patch({ signature });
    return this.getStatus();
  }

  /**
   * Abre o instalador pelo Windows com elevação (UAC).
   *
   * O instalador do FortesDrive é instalado "para todos os usuários" porque
   * precisa registrar as marcas do Explorador de Arquivos. Sem essa elevação, o
   * Windows bloqueava a abertura — o download terminava e nada aparecia na tela.
   * Pedir a permissão explicitamente faz a janela do instalador abrir de fato.
   */
  launchElevated(file) {
    if (process.platform !== "win32") {
      return shell.openPath(file).then(result => (result ? { ok: false, detail: result } : { ok: true }));
    }
    return new Promise((resolve) => {
      execFile(
        "powershell",
        ["-NoProfile", "-Command", "Start-Process -FilePath $env:FD_UPD_FILE -Verb RunAs"],
        { env: { ...process.env, FD_UPD_FILE: file }, windowsHide: true, timeout: 60000 },
        (error, stdout, stderr) => {
          if (!error) return resolve({ ok: true });
          resolve({ ok: false, detail: String(stderr || error.message || "").trim() });
        }
      );
    });
  }

  /** Inicia a instalação abrindo o instalador do Windows (com permissão de administrador). */
  async install() {
    if (this.state.status !== "downloaded") throw new Error("A atualização ainda não está pronta.");
    if (this.engine.state.syncing) throw new Error("Aguarde a sincronização terminar antes de reiniciar.");

    const file = this.state.installerPath || this.findInstaller();
    this.patch({ status: "installing", error: "", errorKind: "" });

    if (file && fs.existsSync(file)) {
      const sig = await this.verifyUpdateSignature();
      if (sig.signature === "invalid") {
        this.patch({
          status: "downloaded",
          errorKind: "signature",
          error: "A assinatura digital deste instalador não é válida. Por segurança ele não será aberto: baixe novamente pela página oficial do FortesDrive.",
        });
        return this.getStatus();
      }

      const launched = await this.launchElevated(file);
      if (launched.ok) {
        this.notify("FortesDrive", "Instalador aberto. Autorize a permissão do Windows para concluir a atualização.");
        // O aplicativo precisa liberar os arquivos para o instalador substituí-los.
        this.app.isQuitting = true;
        setTimeout(() => this.app.quit(), 2000).unref?.();
        return this.getStatus();
      }

      // A elevação falhou (permissão cancelada, por exemplo): volta ao estado
      // anterior e abre o caminho manual em vez de deixar a tela presa.
      this.app.isQuitting = false;
      this.patch(this.launchFailedState(launched.detail));
      return this.getStatus();
    }

    // Sem instalador localizado: comportamento padrão do electron-updater.
    try {
      this.app.isQuitting = true;
      // isSilent = false → o instalador abre visivelmente.
      this.updater.quitAndInstall(false, true);
    } catch (error) {
      this.app.isQuitting = false;
      this.patch(this.launchFailedState(error.message));
      return this.getStatus();
    }
    // Se o aplicativo continuar em execução, o instalador não abriu sozinho:
    // libera o caminho manual em vez de deixar a tela travada em "Reiniciando".
    const timer = setTimeout(() => {
      this.patch({
        status: "downloaded",
        errorKind: "installer",
        error: "O instalador não abriu automaticamente. Use “Abrir instalador” para concluir a atualização.",
      });
    }, 8000);
    timer.unref?.();
    return this.getStatus();
  }

  launchFailedState(detail) {
    const raw = String(detail || "");
    const cancelled = /cancel|cancelad|negad|denied|1223/i.test(raw);
    return {
      status: "downloaded",
      errorKind: "installer",
      error: cancelled
        ? "A permissão de administrador do Windows foi cancelada. Clique em “Abrir instalador” e autorize a permissão para concluir."
        : "O Windows não permitiu abrir o instalador automaticamente. Clique em “Abrir instalador” ou baixe novamente pela página oficial.",
      detail: raw,
    };
  }

  /** Abre o instalador baixado diretamente pelo Windows. */
  async launchInstaller() {
    const file = this.state.installerPath || this.findInstaller();
    if (!file || !fs.existsSync(file)) {
      this.patch({
        status: "downloaded",
        errorKind: "installer",
        installerPath: null,
        installerExists: false,
        error: "O instalador baixado não foi encontrado neste computador. Verifique as atualizações novamente para baixá-lo outra vez.",
      });
      return this.getStatus();
    }
    const signature = await this.verifyUpdateSignature();
    if (signature.signature === "invalid") {
      this.patch({
        status: "downloaded",
        errorKind: "signature",
        error: "A assinatura digital deste instalador não é válida. Por segurança ele não será aberto: baixe novamente pela página oficial do FortesDrive.",
      });
      return this.getStatus();
    }
    const launched = await this.launchElevated(file);
    if (!launched.ok) {
      this.patch(this.launchFailedState(launched.detail));
      return this.getStatus();
    }
    this.patch({ error: "", errorKind: "", detail: "" });
    return this.getStatus();
  }

  start() {
    if (!this.app.isPackaged) return;
    const check = () => this.check().catch(error => this.patch(this.classify(error)));
    check();
    // Verifica logo depois de abrir e a cada 30 minutos: uma versão publicada
    // é percebida e baixada sem que ninguém precise clicar em nada.
    this.soon = setTimeout(check, 2 * 60 * 1000);
    this.soon.unref?.();
    this.timer = setInterval(check, 30 * 60 * 1000);
    this.timer.unref?.();
  }
}

module.exports = { DesktopUpdater };