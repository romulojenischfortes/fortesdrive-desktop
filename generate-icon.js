/**
 * generate-icon.js — gera um ícone PNG 512x512 para o electron-builder.
 *
 * O electron-builder converte automaticamente este PNG em .ico (Windows)
 * e .icns (macOS) no momento do build. Não precisa de dependências externas.
 *
 * Se build/icon.png já existir (por exemplo, baixado de uma fonte externa),
 * o script apenas confirma que o arquivo está presente.
 *
 * Uso: node generate-icon.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 512;
const OUT_DIR = path.join(__dirname, "build");
const OUT_FILE = path.join(OUT_DIR, "icon.png");

// Se já existe um ícone baixado/gerado externamente, usa ele
if (fs.existsSync(OUT_FILE) && fs.statSync(OUT_FILE).size > 1000) {
  console.log("Icon already present: build/icon.png (" + fs.statSync(OUT_FILE).size + " bytes)");
  process.exit(0);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function createPNG(width, height, pixelFn) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const off = y * (rowLen + 1) + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = createPNG(SIZE, SIZE, (x, y, w, h) => {
  const cx = w / 2, cy = h / 2;
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let r = 5, g = 10, b = 20, a = 255;

  const margin = w * 0.06;
  const radius = w * 0.18;
  if (x < margin || x > w - margin || y < margin || y > h - margin) {
    a = 0;
  } else {
    const ix = x - margin, iy = y - margin;
    const iw = w - 2 * margin, ih = h - 2 * margin;
    let inCorner = false;
    const corners = [[radius, radius], [iw - radius, radius], [radius, ih - radius], [iw - radius, ih - radius]];
    for (const [crx, cry] of corners) {
      if ((ix < radius || ix > iw - radius) && (iy < radius || iy > ih - radius) &&
          Math.sqrt((ix - crx) ** 2 + (iy - cry) ** 2) > radius) {
        inCorner = true; break;
      }
    }
    if (inCorner) { a = 0; }
    else {
      const t = (y - margin) / (h - 2 * margin);
      r = Math.round(5 + t * 6); g = Math.round(10 + t * 8); b = Math.round(20 + t * 15);
    }
  }
  if (a === 0) return [r, g, b, a];

  const cloudY = cy - h * 0.04, cloudH = h * 0.28, cloudX = cx, cloudW = w * 0.52;
  const circles = [
    { x: cloudX - cloudW * 0.28, y: cloudY, r: cloudH * 0.55 },
    { x: cloudX, y: cloudY - cloudH * 0.15, r: cloudH * 0.7 },
    { x: cloudX + cloudW * 0.28, y: cloudY, r: cloudH * 0.55 },
  ];
  for (const c of circles) {
    if (Math.sqrt((x - c.x) ** 2 + (y - c.y) ** 2) < c.r) {
      const t = Math.max(0, Math.min(1, (y - (cloudY - cloudH)) / (cloudH * 2)));
      r = Math.round(31 + t * 10); g = Math.round(148 - t * 20); b = Math.round(172 + t * 20);
      break;
    }
  }

  const arrowR = w * 0.32;
  if (Math.abs(dist - arrowR) < w * 0.018) {
    const angle = Math.atan2(dy, dx);
    if ((angle > -Math.PI * 0.85 && angle < -Math.PI * 0.15) ||
        (angle > Math.PI * 0.15 && angle < Math.PI * 0.85)) {
      r = 31; g = 148; b = 172;
    }
  }
  return [r, g, b, a];
});

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, png);
console.log("Icon generated: build/icon.png (" + SIZE + "x" + SIZE + ", " + png.length + " bytes)");