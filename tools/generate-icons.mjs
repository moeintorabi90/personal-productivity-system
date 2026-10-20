// Generates the PNG app icons from the same geometry as apps/web/public/icons/icon.svg.
// Dependency-free (node:zlib). Run: node tools/generate-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUT = new URL("../apps/web/public/icons/", import.meta.url);
const BG = [0x2f, 0x6b, 0x57];
const FG = [0xff, 0xff, 0xff];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Coverage (0..1) of the rounded square background and the check mark at a point in 512-space. */
function sample(x, y, { rounded, scale }) {
  const r = rounded ? 112 : 0;
  const cx = Math.min(Math.max(x, r), 512 - r);
  const cy = Math.min(Math.max(y, r), 512 - r);
  const inBg = x >= 0 && x <= 512 && y >= 0 && y <= 512 && Math.hypot(x - cx, y - cy) <= r + 1e-9 ? 1 : 0;
  // Check mark scaled around the centre (maskable icons keep it inside the safe zone).
  const sx = (v) => 256 + (v - 256) * scale;
  const d = Math.min(
    distToSegment(x, y, sx(146), sx(266), sx(218), sx(338)),
    distToSegment(x, y, sx(218), sx(338), sx(366), sx(174)),
  );
  const fg = d <= 24 * scale ? 1 : 0;
  return { bg: inBg, fg };
}

function render(size, options) {
  const ss = 4; // supersampling for smooth edges
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let i = 0; i < ss; i++) {
        for (let j = 0; j < ss; j++) {
          const x = ((px + (i + 0.5) / ss) / size) * 512;
          const y = ((py + (j + 0.5) / ss) / size) * 512;
          const s = sample(x, y, options);
          bg += s.bg;
          fg += s.fg && s.bg ? 1 : 0;
        }
      }
      const n = ss * ss;
      const a = bg / n;
      const f = bg ? fg / bg : 0;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const outputs = [
  ["icon-192.png", 192, { rounded: true, scale: 1 }],
  ["icon-512.png", 512, { rounded: true, scale: 1 }],
  ["icon-maskable-512.png", 512, { rounded: false, scale: 0.75 }],
  ["apple-touch-icon.png", 180, { rounded: false, scale: 0.85 }],
];
for (const [name, size, options] of outputs) {
  writeFileSync(new URL(name, OUT), render(size, options));
  console.log(`wrote ${name}`);
}
