// One-off generator for the customer-portal PWA's placeholder icons. Run
// manually (`npm run icons:generate`) whenever the mark or palette changes;
// output is committed under frontend/icons/, not regenerated at boot — same
// convention as docs/brain/build-brain.mjs.
//
// Stdlib-only (Buffer + zlib): no image library exists in this project's
// dependency budget (CLAUDE.md §1), and hand-rolling a raw PNG encoder here
// is lighter than adding one. Every icon is drawn as a flat background with
// a centered circular "coin" motif using pure per-pixel distance-from-center
// math — no font/path rasterization needed for a placeholder mark.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '../frontend/icons');

const BG = [0x0f, 0x17, 0x2a]; // --color-bg-sidebar
const FG = [0xb4, 0x50, 0x09]; // --color-warning (closest existing "gold" tone)

// --- CRC-32, PNG's per-chunk checksum ---
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// `radiusRatio` is the coin's radius as a fraction of `size`. Kept small for
// the maskable variant so Android's squircle/circle mask never clips it —
// the standard maskable "safe zone" is the inner ~80% diameter (radius 0.4).
function drawIcon(size, radiusRatio) {
    const raw = Buffer.alloc(size * (1 + size * 3)); // filter byte + RGB per row
    const cx = size / 2;
    const cy = size / 2;
    const r = size * radiusRatio;
    let offset = 0;
    for (let y = 0; y < size; y++) {
        raw[offset++] = 0; // filter: None
        for (let x = 0; x < size; x++) {
            const dx = x + 0.5 - cx;
            const dy = y + 0.5 - cy;
            const inCircle = dx * dx + dy * dy <= r * r;
            const [r8, g8, b8] = inCircle ? FG : BG;
            raw[offset++] = r8;
            raw[offset++] = g8;
            raw[offset++] = b8;
        }
    }
    return raw;
}

// Color type 2 (RGB, no alpha) throughout — every one of these icons is
// meant to be fully opaque, which also sidesteps iOS filling a transparent
// apple-touch-icon with black.
function encodePng(size, radiusRatio) {
    const raw = drawIcon(size, radiusRatio);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // color type: RGB
    ihdr[10] = 0; // compression method
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // interlace method

    const idat = deflateSync(raw);

    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
    { file: 'icon-192.png', size: 192, radiusRatio: 0.42 },
    { file: 'icon-512.png', size: 512, radiusRatio: 0.42 },
    { file: 'icon-512-maskable.png', size: 512, radiusRatio: 0.36 },
    { file: 'apple-touch-icon.png', size: 180, radiusRatio: 0.42 }
];

for (const { file, size, radiusRatio } of targets) {
    writeFileSync(path.join(OUT_DIR, file), encodePng(size, radiusRatio));
    console.log(`wrote ${file} (${size}x${size})`);
}
