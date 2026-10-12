// Renders the original PulseFlow mark (rounded tile + pulse line) to PNG without external tools.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'apps/desktop/assets');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * t;
const PULSE = [
  [0.14, 0.56],
  [0.36, 0.56],
  [0.45, 0.3],
  [0.56, 0.76],
  [0.64, 0.46],
  [0.7, 0.56],
  [0.86, 0.56],
];
function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size, { tile = true } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          let cr = 0,
            cg = 0,
            cb = 0,
            ca = 0;
          if (tile) {
            const rad = 0.22;
            const qx = Math.max(Math.abs(u - 0.5) - (0.5 - rad - 0.02), 0);
            const qy = Math.max(Math.abs(v - 0.5) - (0.5 - rad - 0.02), 0);
            if (Math.hypot(qx, qy) <= rad) {
              const t = (u + v) / 2;
              cr = mix(16, 11, t);
              cg = mix(23, 15, t);
              cb = mix(34, 22, t);
              ca = 255;
            }
          }
          let d = Infinity;
          for (let i = 0; i < PULSE.length - 1; i++) d = Math.min(d, distToSegment(u, v, PULSE[i], PULSE[i + 1]));
          const width = tile ? 0.045 : 0.09;
          if (d <= width) {
            const t = Math.max(0, Math.min(1, (u - 0.14) / 0.72));
            cr = mix(34, 59, t);
            cg = mix(211, 130, t);
            cb = mix(238, 246, t);
            ca = 255;
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      buf[o] = r / n;
      buf[o + 1] = g / n;
      buf[o + 2] = b / n;
      buf[o + 3] = a / n;
    }
  }
  return png(size, buf);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), render(512));
fs.writeFileSync(path.join(outDir, 'tray.png'), render(32));
fs.writeFileSync(path.join(root, 'apps/desktop/src/renderer/public/favicon.png'), render(64));
console.log(`icons written to ${outDir}`);
