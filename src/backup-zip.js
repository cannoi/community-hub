'use strict';
/** Minimal ZIP (store + deflate) pack/unpack — zero dependencies. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

function packDirToZip(srcDir, destZip) {
  const files = walk(srcDir);
  const locals = [];
  const centrals = [];
  let offset = 0;
  const chunks = [];
  for (const rel of files) {
    const data = fs.readFileSync(path.join(srcDir, rel));
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    let comp = data;
    let method = 0;
    try {
      const def = zlib.deflateRawSync(data, { level: 6 });
      if (def.length < data.length) { comp = def; method = 8; }
    } catch { /* store */ }
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, comp,
    ]);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    chunks.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  fs.writeFileSync(destZip, Buffer.concat([...chunks, central, end]), { mode: 0o600 });
  return { path: destZip, files: files.length, bytes: fs.statSync(destZip).size };
}

function unpackZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  fs.mkdirSync(destDir, { recursive: true });
  let i = 0;
  let count = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const uncompSize = buf.readUInt32LE(i + 22);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    if (name.includes('..') || path.isAbsolute(name)) throw new Error('Unsafe path in zip: ' + name);
    const start = i + 30 + nameLen + extraLen;
    const comp = buf.slice(start, start + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('Unsupported compression method ' + method);
    if (data.length !== uncompSize && uncompSize !== 0) {
      // some writers leave uncomp 0; accept if inflate ok
    }
    const out = path.join(destDir, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data, name.startsWith('keys/') ? { mode: 0o600 } : undefined);
    count++;
    i = start + compSize;
  }
  if (!count) throw new Error('No files in zip or not a valid zip');
  return { files: count };
}

module.exports = { packDirToZip, unpackZip, walk };
