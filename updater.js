class DesktopUpdater {
  constructor(updater, app, engine, notify) {
    this.updater = updater; this.app = app; this.engine = engine;
    this.state = { status: app.isPackaged ? "idle" : "unsupported", currentVersion: app.getVersion(), version: null, percent: 0, error: "" };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.logger = console;
    updater.on("checking-for-update", () => this.patch({ status: "checking", error: "" }));
    updater.on("update-available", info => this.patch({ status: "available", version: info.version }));
    updater.on("update-not-available", () => this.patch({ status: "current" }));
    updater.on("download-progress", progress => this.patch({ status: "downloading", percent: Math.round(progress.percent) }));
    updater.on("update-downloaded", info => {
      this.patch({ status: "downloaded", version: info.version, percent: 100 });
      notify("FortesDrive", "Atualização pronta. Abra o aplicativo e clique em Reiniciar e atualizar.");
    });
    updater.on("error", error => this.patch({ status: "error", error: "Não foi possível atualizar: " + error.message }));
  }
  patch(change) { Object.assign(this.state, change); }
  getStatus() { return { ...this.state }; }
  async check() {
    if (!this.app.isPackaged || ["checking", "downloading", "downloaded", "installing"].includes(this.state.status)) return this.getStatus();
    await this.updater.checkForUpdates();
    return this.getStatus();
  }
  async download() {
    if (this.state.status !== "available") throw new Error("Verifique as atualizações antes de baixar.");
    this.patch({ status: "downloading", percent: 0, error: "" });
    await this.updater.downloadUpdate();
    return this.getStatus();
  }
  install() {
    if (this.state.status !== "downloaded") throw new Error("A atualização ainda não está pronta.");
    if (this.engine.state.syncing) throw new Error("Aguarde a sincronização terminar antes de reiniciar.");
    this.patch({ status: "installing" });
    this.app.isQuitting = true;
    this.updater.quitAndInstall(true, true);
    return this.getStatus();
  }
  start() {
    if (!this.app.isPackaged) return;
    const check = () => this.check().catch(error => this.patch({ status: "error", error: error.message }));
    check(); this.timer = setInterval(check, 60 * 60 * 1000); this.timer.unref?.();
  }
}
module.exports = { DesktopUpdater };