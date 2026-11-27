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

/** Normalise an archive entry name; returns null for entries that must be skipped. Throws on path traversal. */
function safeEntryName(raw) {
  let name = String(raw).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!name || name.endsWith('/')) return null; // directory entry
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new Error('Unsafe path in zip: ' + raw);
  return name;
}

/** Read the central directory (supports data-descriptor zips written by 7-Zip, Windows, Android, macOS, ...). */
function readCentralDirectory(fd, size) {
  const tailLen = Math.min(size, 22 + 65535);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const total = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('ZIP64 archives are not supported; re-create the backup ZIP with the Hub');
  if (cdOff + cdSize > size) throw new Error('Corrupt zip: central directory out of range');
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOff);
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compSize = cd.readUInt32LE(p + 20);
    const uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOff = cd.readUInt32LE(p + 42);
    const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (flags & 1) throw new Error('Encrypted zip entries are not supported: ' + name);
    entries.push({ name, method, crc, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function unpackZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const fd = fs.openSync(zipPath, 'r');
  let count = 0;
  try {
    const size = fs.fstatSync(fd).size;
    const entries = readCentralDirectory(fd, size);
    if (!entries) return unpackZipSequential(zipPath, destDir); // no central directory: legacy / truncated archive
    for (const e of entries) {
      const name = safeEntryName(e.name);
      if (!name) continue;
      const hdr = Buffer.alloc(30);
      fs.readSync(fd, hdr, 0, 30, e.localOff);
      if (hdr.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt zip: bad local header for ' + name);
      const start = e.localOff + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28);
      if (start + e.compSize > size) throw new Error('Corrupt zip: truncated data for ' + name);
      const comp = Buffer.alloc(e.compSize);
      if (e.compSize) fs.readSync(fd, comp, 0, e.compSize, start);
      let data;
      if (e.method === 0) data = comp;
      else if (e.method === 8) data = zlib.inflateRawSync(comp);
      else throw new Error('Unsupported compression method ' + e.method + ' for ' + name);
      if (data.length !== e.uncompSize) throw new Error('Corrupt zip: size mismatch for ' + name);
      if (e.crc && crc32(data) !== e.crc) throw new Error('Corrupt zip: CRC mismatch for ' + name);
      const out = path.join(destDir, name);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data, name.startsWith('keys/') ? { mode: 0o600 } : undefined);
      count++;
    }
  } finally { fs.closeSync(fd); }
  if (!count) throw new Error('No files in zip or not a valid zip');
  return { files: count };
}

/** Fallback for archives without a readable central directory (only works for zips without data descriptors). */
function unpackZipSequential(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  let i = 0;
  let count = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = safeEntryName(buf.slice(i + 30, i + 30 + nameLen).toString('utf8'));
    const start = i + 30 + nameLen + extraLen;
    const comp = buf.slice(start, start + compSize);
    i = start + compSize;
    if (!name) continue;
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('Unsupported compression method ' + method);
    const out = path.join(destDir, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data, name.startsWith('keys/') ? { mode: 0o600 } : undefined);
    count++;
  }
  if (!count) throw new Error('No files in zip or not a valid zip');
  return { files: count };
}

module.exports = { packDirToZip, unpackZip, walk };
