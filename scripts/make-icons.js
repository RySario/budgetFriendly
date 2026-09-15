'use strict';
/* Generates the PWA icons as real PNGs with no dependencies — zlib is built in.
   Run with: npm run make-icons  (already run; re-run after changing the design). */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

// --- minimal PNG encoder ---------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // Each scanline is prefixed with its filter type byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the icon ---------------------------------------------------------------

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Deep slate ground with a blue→violet diagonal wash, three ascending bars and
 * a rising line — a budget that is going somewhere.
 * @param {number} size
 * @param {boolean} maskable  full-bleed background with the glyph inset for
 *                            Android's safe zone
 */
function drawIcon(size, maskable = false) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = maskable ? 0 : size * 0.22;

  const put = (x, y, r, g, b, a = 255) => {
    const i = (y * size + x) * 4;
    if (a === 255) {
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      return;
    }
    // Source-over onto whatever is already there.
    const t = a / 255;
    rgba[i] = Math.round(lerp(rgba[i], r, t));
    rgba[i + 1] = Math.round(lerp(rgba[i + 1], g, t));
    rgba[i + 2] = Math.round(lerp(rgba[i + 2], b, t));
    rgba[i + 3] = Math.max(rgba[i + 3], Math.round(a));
  };

  const insideRounded = (x, y) => {
    if (radius === 0) return true;
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };

  // Background gradient.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!insideRounded(x + 0.5, y + 0.5)) continue;
      const t = (x / size) * 0.55 + (y / size) * 0.45;
      put(x, y,
        Math.round(lerp(30, 99, t)),
        Math.round(lerp(64, 63, t)),
        Math.round(lerp(175, 214, t)));
    }
  }

  // Bars, inset for the maskable safe zone.
  const pad = maskable ? size * 0.28 : size * 0.24;
  const inner = size - pad * 2;
  const barW = inner * 0.19;
  const gap = (inner - barW * 3) / 2;
  const heights = [0.38, 0.62, 0.9];

  heights.forEach((h, idx) => {
    const x0 = Math.round(pad + idx * (barW + gap));
    const x1 = Math.round(x0 + barW);
    const y1 = Math.round(pad + inner);
    const y0 = Math.round(y1 - inner * h);
    const r = barW * 0.32;

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        // Round only the top corners.
        const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
        const cy = Math.max(y + 0.5, y0 + r);
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r ** 2) continue;
        put(x, y, 255, 255, 255, idx === 2 ? 255 : 215);
      }
    }
  });

  return encodePNG(size, size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });

const targets = [
  ['icon-180.png', 180, false],
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
];

for (const [name, size, maskable] of targets) {
  const png = drawIcon(size, maskable);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
}
