import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
// Geometric icon drawn locally; no proprietary assets, image packages, or remote resources.
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}
export async function createIcons(directory) {
  await mkdir(directory, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const stride = 1 + size * 4;
    const pixels = Buffer.alloc(stride * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = (x + .5) / size, ny = (y + .5) / size;
      const inRound = Math.hypot(Math.max(.20 - nx, 0, nx - .80), Math.max(.20 - ny, 0, ny - .80)) <= .18;
      const shaft = nx > .445 && nx < .555 && ny > .22 && ny < .60;
      const arrow = ny > .43 && ny < .68 && Math.abs(nx - .5) < (.68 - ny) && Math.abs(Math.abs(nx - .5) - (.61 - ny)) < .075;
      const tray = ny > .73 && ny < .80 && nx > .28 && nx < .72;
      const color = shaft || arrow || tray ? [245, 250, 246, 255] : [33, 104, 75, inRound ? 255 : 0];
      pixels.set(color, y * stride + 1 + x * 4);
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
    await writeFile(path.join(directory, `icon${size}.png`), png);
  }
}
