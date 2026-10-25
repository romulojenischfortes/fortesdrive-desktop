const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * As marcas de sincronização no Explorador são uma extensão registrada no
 * Windows pelo instalador. O Explorador lê esse registro apenas quando inicia
 * e carrega no máximo 15 marcas de ícones (compartilhadas com outros
 * aplicativos, em ordem alfabética). Aqui lemos o registro para dizer ao
 * usuário exatamente o que falta e reiniciamos o Explorador, que é o que faz
 * as marcas aparecerem sem precisar encerrar a sessão do Windows.
 */
const OVERLAYS_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers";
const STATES = [
  { suffix: "1", label: "Synced" },
  { suffix: "2", label: "Pending" },
  { suffix: "3", label: "Error" },
  { suffix: "4", label: "Locked" },
];
const WINDOWS_SLOT_LIMIT = 15;
const MARKER = "ShellIconOverlayIdentifiers\\";
const OWNER_TAG = "FortesDrive ";

function clsid(suffix) {
  return "{9E76E330-7AB7-4AFE-B912-2A305BCD4F0" + suffix + "}";
}

function query(args) {
  return new Promise((resolve) => {
    execFile("reg.exe", args, { windowsHide: true, timeout: 15000 }, (error, stdout) =>
      resolve({ ok: !error, stdout: String(stdout || "") })
    );
  });
}

/** Nomes das marcas registradas, na ordem em que o Windows as carrega. */
function parseOverlayNames(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.toUpperCase().startsWith("HKEY_"))
    .map((line) => {
      const at = line.indexOf(MARKER);
      return at < 0 ? "" : line.slice(at + MARKER.length);
    })
    .filter(Boolean);
}

/** Valor REG_SZ de uma consulta do reg.exe. */
function parseRegValue(stdout) {
  const match = String(stdout || "").match(/REG_SZ\s+(.+?)\s*$/m);
  return match ? match[1].trim() : "";
}

/** Comandos que registram as quatro marcas apontando para o DLL instalado. */
function registerCommands(dllPath) {
  const lines = [];
  for (const { suffix, label } of STATES) {
    const key = "HKLM\\Software\\Classes\\CLSID\\" + clsid(suffix);
    lines.push(`reg add "${key}" /ve /d "FortesDrive ${label}" /f`);
    lines.push(`reg add "${key}\\InprocServer32" /ve /d "${dllPath}" /f`);
    lines.push(`reg add "${key}\\InprocServer32" /v ThreadingModel /d Both /f`);
    lines.push(`reg add "${OVERLAYS_KEY}\\ FortesDrive ${label}" /ve /d "${clsid(suffix)}" /f`);
    lines.push(`reg add "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Approved" /v "${clsid(suffix)}" /d "FortesDrive ${label}" /f`);
  }
  return lines;
}

async function readBadgeSetup() {
  if (process.platform !== "win32") return { supported: false };
  const [overlays, root, dll] = await Promise.all([
    query(["query", OVERLAYS_KEY]),
    query(["query", "HKCU\\Software\\FortesDrive", "/v", "SyncRoot"]),
    query(["query", "HKLM\\SOFTWARE\\Classes\\CLSID\\" + clsid("1") + "\\InprocServer32", "/ve"]),
  ]);
  const names = parseOverlayNames(overlays.stdout);
  const first = names.findIndex((name) => name.includes(OWNER_TAG.trim()) && name.includes("FortesDrive"));
  const dllPath = parseRegValue(dll.stdout);
  return {
    supported: true,
    registered: names.filter((name) => name.includes("FortesDrive")).length,
    complete: names.filter((name) => name.includes("FortesDrive")).length === STATES.length,
    position: first < 0 ? 0 : first + 1,
    // Acima do 15º lugar o Explorador ignora a marca.
    loaded: first >= 0 && first < WINDOWS_SLOT_LIMIT,
    slotsBefore: first < 0 ? [] : names.slice(0, first).slice(0, WINDOWS_SLOT_LIMIT),
    slotLimit: WINDOWS_SLOT_LIMIT,
    dllPath,
    dllExists: !!dllPath && fs.existsSync(dllPath),
    root: parseRegValue(root.stdout),
  };
}

async function restartExplorer() {
  await new Promise((resolve) => {
    execFile("taskkill.exe", ["/F", "/IM", "explorer.exe"], { windowsHide: true, timeout: 15000 }, () => resolve());
  });
  try {
    spawn(path.join(process.env.WINDIR || "C:\\Windows", "explorer.exe"), [], { detached: true, stdio: "ignore" }).unref();
  } catch (error) {
    // Sem reiniciar, o Windows reabre o Explorador sozinho na próxima ação.
  }
}

/** Registra as marcas quando faltarem e reinicia o Explorador para carregá-las. */
async function repairBadges({ app } = {}) {
  if (process.platform !== "win32") return { supported: false };
  const before = await readBadgeSetup();
  if (app && (!before.complete || !before.dllExists)) {
    const dllPath = before.dllPath || path.join(path.dirname(app.getPath("exe")), "resources", "shell", "FortesDriveOverlays.dll");
    const script = path.join(app.getPath("temp"), "fortesdrive-marcas.cmd");
    await fs.promises.writeFile(script, ["@echo off", ...registerCommands(dllPath)].join("\r\n") + "\r\n");
    await new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", `Start-Process -Verb RunAs -Wait -FilePath "${script}"`],
        { windowsHide: true, timeout: 120000 },
        () => resolve()
      );
    });
  }
  await restartExplorer();
  return readBadgeSetup();
}

module.exports = { readBadgeSetup, repairBadges, parseOverlayNames, parseRegValue, registerCommands, restartExplorer };