/*
 * Minimal zip reader — central directory + stored/deflate entries. Zero-dependency by construction: the ZIP
 * container format is just binary offsets (fixed by the spec — the magic numbers below aren't a design
 * choice), and decompression uses Node's own builtin zlib (inflateRawSync for the DEFLATE method), so no
 * third-party package is needed at all. Confirmed against a real 3MB Sigma rules release zip this session.
 */
"use strict";
const zlib = require("zlib");

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record found)");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("corrupt zip (bad central directory entry)");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({
      name,
      size: uncompressedSize,
      data() {
        if (buf.readUInt32LE(localHeaderOffset) !== SIG_LOCAL) throw new Error(`corrupt zip (bad local header for ${name})`);
        const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
        const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
        const start = localHeaderOffset + 30 + localNameLen + localExtraLen;
        const raw = buf.subarray(start, start + compressedSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error(`unsupported zip compression method ${method} for ${name}`);
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

module.exports = { readZip };
