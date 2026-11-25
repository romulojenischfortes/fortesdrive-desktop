"use strict";

/**
 * Identificação cirúrgica de diretórios temporários de cache de navegadores e
 * WebViews (Chrome, Edge, Brave, Opera, Vivaldi, Chromium, Electron, WebView2 e
 * Firefox), sem nunca ignorar pastas comuns do usuário (como "Documentos/cache").
 */

const CHROME_SCOPED_DIR = /^scoped_dir\d+_\d+$/i;
const CHROMIUM_TEMP_ENTRY = /^\.(?:com\.google\.chrome|org\.chromium\.chromium)\.[a-z0-9._-]+$/i;

// Diretórios internos do sistema operacional que existem em qualquer volume e
// devolvem acesso negado: são ignorados sem virar erro de sincronização quando
// o usuário escolhe a raiz de um disco como pasta.
const ROOT_OS_SYSTEM_DIRS = new Set([
  "$recycle.bin",
  "system volume information",
  "$winreagent",
  "config.msi",
  "msocache",
  "perflogs",
]);

// Diretórios técnicos exclusivos de motores Chromium/GPU/WebView (não colidem com pastas humanas).
const UNAMBIGUOUS_ENGINE_CACHE_DIRS = new Set([
  "gpucache",
  "dawncache",
  "dawnwebgpucache",
  "dawngraphitecache",
  "graphitedawncache",
  "grshadercache",
  "shadercache",
  "jumplisticonsmostvisited",
  "jumplisticonsrecentclosed",
]);

// Diretórios genéricos que SÓ são cache de navegador quando inseridos num perfil
// confirmado de navegador/WebView (pelo caminho ancestral ou irmãos do perfil).
const PROFILE_SCOPED_CACHE_DIRS = new Set([
  "cache",
  "cache_data",
  "code cache",
  "system cache",
  "media cache",
  "application cache",
  "dawn_cache",
  "blob_storage",
  "browsermetrics",
  "crashpad",
  "cache2",
  "startupcache",
  "jumplistcache",
  "shader-cache",
]);

const CHROMIUM_PROFILE_NAME = /^(?:default|profile \d+|guest profile|system profile)$/i;

const BROWSER_VENDOR_SEGMENTS = [
  ["google", "chrome"],
  ["microsoft", "edge"],
  ["bravesoftware", "brave-browser"],
  ["opera software"],
  ["vivaldi"],
  ["chromium"],
];

function normalizeSegments(relativePath) {
  return String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
}

function hasBrowserAncestorContext(lowerParts, upToIndex) {
  for (let i = 0; i < upToIndex; i++) {
    const seg = lowerParts[i];
    if (CHROME_SCOPED_DIR.test(seg)) return true;
    if (seg === "ebwebview" || seg === "user data") return true;
    if (seg === "partitions" && i + 1 < upToIndex) return true;
    if (seg === "profiles" && i >= 1 && (lowerParts[i - 1] === "firefox" || lowerParts[i - 1] === "mozilla")) return true;
    if (CHROMIUM_PROFILE_NAME.test(seg) && i >= 1 && (lowerParts[i - 1] === "user data" || lowerParts[i - 1] === "ebwebview" || CHROME_SCOPED_DIR.test(lowerParts[i - 1]))) {
      return true;
    }
    for (const seq of BROWSER_VENDOR_SEGMENTS) {
      if (i + seq.length <= upToIndex && seq.every((item, offset) => lowerParts[i + offset] === item)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Avalia pelos irmãos já lidos em `readdir` (custo zero de disco) se a pasta pai
 * é raiz de um perfil Chromium/Electron/WebView2 ou Firefox.
 */
function hasBrowserProfileSiblings(siblingNamesLower) {
  if (!siblingNamesLower || !siblingNamesLower.size) return false;
  // Perfil Chromium / Electron / WebView2
  if (
    siblingNamesLower.has("gpucache") ||
    siblingNamesLower.has("dawncache") ||
    siblingNamesLower.has("dawnwebgpucache") ||
    siblingNamesLower.has("grshadercache") ||
    siblingNamesLower.has("local state") ||
    (siblingNamesLower.has("preferences") && (siblingNamesLower.has("network") || siblingNamesLower.has("local storage") || siblingNamesLower.has("session storage")))
  ) {
    return true;
  }
  // Perfil Firefox
  if (siblingNamesLower.has("prefs.js") && (siblingNamesLower.has("places.sqlite") || siblingNamesLower.has("compatibility.ini"))) {
    return true;
  }
  return false;
}

/**
 * Se `relativePath` for (ou estiver dentro de) um diretório temporário de cache
 * de navegador conhecido, devolve o caminho relativo do diretório raiz desse
 * cache e a justificativa; caso contrário, devolve `null`.
 */
function classifyBrowserCachePath(relativePath, siblingNamesLower = null) {
  const parts = normalizeSegments(relativePath);
  if (!parts.length) return null;
  const lower = parts.map((p) => p.toLowerCase());

  if (ROOT_OS_SYSTEM_DIRS.has(lower[0])) {
    return {
      rootPath: parts[0],
      kind: "os_system",
      reason: "Diretório protegido do sistema operacional ignorado automaticamente",
    };
  }

  for (let i = 0; i < parts.length; i++) {
    const seg = lower[i];
    const orig = parts[i];

    // 1. Diretório temporário efêmero do Chromium/WebDriver (scoped_dir123_456)
    if (CHROME_SCOPED_DIR.test(orig) || CHROMIUM_TEMP_ENTRY.test(orig)) {
      return {
        rootPath: parts.slice(0, i + 1).join("/"),
        reason: "Diretório temporário de cache do navegador ignorado automaticamente",
      };
    }

    // 2. Diretórios exclusivos de engine/GPU do navegador
    if (UNAMBIGUOUS_ENGINE_CACHE_DIRS.has(seg)) {
      return {
        rootPath: parts.slice(0, i + 1).join("/"),
        reason: "Diretório temporário de cache do navegador ignorado automaticamente",
      };
    }

    // 3. Cache_Data dentro de Cache / System Cache / Media Cache
    if (seg === "cache_data" && i >= 1 && (lower[i - 1] === "cache" || lower[i - 1] === "system cache" || lower[i - 1] === "media cache")) {
      return {
        rootPath: parts.slice(0, i).join("/"),
        reason: "Diretório temporário de cache do navegador ignorado automaticamente",
      };
    }

    // 4. Service Worker CacheStorage / ScriptCache
    if ((seg === "cachestorage" || seg === "scriptcache") && i >= 1 && lower[i - 1] === "service worker") {
      return {
        rootPath: parts.slice(0, i + 1).join("/"),
        reason: "Diretório temporário de cache do navegador ignorado automaticamente",
      };
    }

    // 5. Windows INetCache / Temporary Internet Files
    if ((seg === "inetcache" || seg === "temporary internet files") && i >= 1 && lower[i - 1] === "windows") {
      return {
        rootPath: parts.slice(0, i + 1).join("/"),
        reason: "Diretório temporário de cache do navegador ignorado automaticamente",
      };
    }

    // 6. Firefox storage/to-be-removed
    if (seg === "to-be-removed" && i >= 1 && lower[i - 1] === "storage" && hasBrowserAncestorContext(lower, i)) {
      return {
        rootPath: parts.slice(0, i + 1).join("/"),
        reason: "Diretório temporário de cache do navegador ignorado automaticamente",
      };
    }

    // 7. Pastas de cache dependentes de contexto de perfil do navegador
    if (PROFILE_SCOPED_CACHE_DIRS.has(seg)) {
      const inBrowserTree = hasBrowserAncestorContext(lower, i);
      const inProfileBySiblings = i === parts.length - 1 && hasBrowserProfileSiblings(siblingNamesLower);
      if (inBrowserTree || inProfileBySiblings) {
        return {
          rootPath: parts.slice(0, i + 1).join("/"),
          reason: "Diretório temporário de cache do navegador ignorado automaticamente",
        };
      }
    }
  }

  return null;
}

function isKnownBrowserCachePath(relativePath, siblingNamesLower = null) {
  return classifyBrowserCachePath(relativePath, siblingNamesLower) !== null;
}

module.exports = {
  classifyBrowserCachePath,
  isKnownBrowserCachePath,
  hasBrowserProfileSiblings,
  CHROME_SCOPED_DIR,
};