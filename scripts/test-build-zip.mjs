// Strict, dependency-free ZIP reader/writer for offline test artifacts.
// Reads a bounded central directory before extracting known entries by offset.
// Never interprets archive member names as filesystem destinations.
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, createInflateRaw } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const MAX_ARCHIVE = 500 * 1024 * 1024;
const MAX_UNPACKED = 750 * 1024 * 1024;
const MAX_MEMBER = 300 * 1024 * 1024;
const table = Uint32Array.from({ length: 256 }, (_, i) => {
  let crc = i;
  for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function nextCrc(crc, bytes) {
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function readAt(handle, size, position) {
  const buffer = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const { bytesRead } = await handle.read(buffer, done, size - done, position + done);
    if (!bytesRead) throw new Error('Truncated ZIP structure');
    done += bytesRead;
  }
  return buffer;
}

export async function zipEntries(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    assert(size > 21 && size <= MAX_ARCHIVE, 'ZIP is empty or oversized');
    const tailSize = Math.min(size, 65557);
    const tail = await readAt(file, tailSize, size - tailSize);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
        end = i;
        break;
      }
    }
    assert(end >= 0, 'ZIP end-of-central-directory missing');
    assert(tail.readUInt16LE(end + 4) === 0 && tail.readUInt16LE(end + 6) === 0, 'Multi-disk ZIP not allowed');
    const count = tail.readUInt16LE(end + 10);
    assert(count === tail.readUInt16LE(end + 8) && count < 1000, 'Invalid ZIP entry count');
    const directoryBytes = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    assert(directoryBytes !== 0xffffffff && directoryOffset !== 0xffffffff && count !== 65535, 'ZIP64 not supported');
    assert(directoryBytes < 256 * 1024 && directoryOffset + directoryBytes <= size - tailSize + end, 'Unsafe ZIP directory');
    const directory = await readAt(file, directoryBytes, directoryOffset);
    const entries = new Map();
    let cursor = 0;
    let total = 0;
    for (let i = 0; i < count; i++) {
      assert(cursor + 46 <= directory.length && directory.readUInt32LE(cursor) === CENTRAL, 'Malformed ZIP central entry');
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      const crc = directory.readUInt32LE(cursor + 16);
      const packed = directory.readUInt32LE(cursor + 20);
      const unpacked = directory.readUInt32LE(cursor + 24);
      const nameLen = directory.readUInt16LE(cursor + 28);
      const extraLen = directory.readUInt16LE(cursor + 30);
      const commentLen = directory.readUInt16LE(cursor + 32);
      const unixMode = directory.readUInt32LE(cursor + 38) >>> 16;
      const mode = unixMode & 0o170000;
      const localOffset = directory.readUInt32LE(cursor + 42);
      assert(cursor + 46 + nameLen + extraLen + commentLen <= directory.length, 'Malformed ZIP filename');
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
      assert(name && !name.includes('\0') && !name.includes('\\') && !name.startsWith('/') &&
        name.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Unsafe ZIP member name');
      assert(!entries.has(name), `Duplicate ZIP member: ${name}`);
      assert(!(flags & 1) && (flags & ~(0x0808)) === 0, `Unsafe ZIP flags: ${name}`);
      assert(method === 0 || method === 8, `Unsupported ZIP compression: ${name}`);
      assert(mode === 0 || mode === 0o100000, `Unsafe ZIP member type: ${name}`);
      assert(unpacked > 0 && unpacked <= MAX_MEMBER && packed > 0 && packed <= MAX_ARCHIVE, `Oversized ZIP member: ${name}`);
      assert(localOffset + 30 < directoryOffset, `Invalid ZIP member offset: ${name}`);
      total += unpacked;
      assert(total <= MAX_UNPACKED, 'ZIP uncompressed size exceeds limit');
      entries.set(name, { name, flags, method, crc, packed, unpacked, localOffset, unixMode });
      cursor += 46 + nameLen + extraLen + commentLen;
    }
    assert(cursor === directory.length, 'Unexpected ZIP central directory data');
    return entries;
  } finally {
    await file.close();
  }
}

export async function extractZipEntry(archive, entry, target) {
  const file = await open(archive, 'r');
  try {
    const local = await readAt(file, 30, entry.localOffset);
    assert(local.readUInt32LE(0) === LOCAL, `Missing local ZIP header for ${entry.name}`);
    assert(local.readUInt16LE(6) === entry.flags && local.readUInt16LE(8) === entry.method,
      `ZIP header mismatch for ${entry.name}`);
    const nameLen = local.readUInt16LE(26);
    const extraLen = local.readUInt16LE(28);
    const name = (await readAt(file, nameLen, entry.localOffset + 30)).toString('utf8');
    assert(name === entry.name, `ZIP filename mismatch: ${entry.name}`);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const { size } = await file.stat();
    assert(start + entry.packed <= size && start + entry.packed > start, `Invalid ZIP data region: ${entry.name}`);
    let count = 0;
    let crc = 0xffffffff;
    const guard = new Transform({
      transform(chunk, _, done) {
        count += chunk.length;
        if (count > entry.unpacked) return done(new Error(`ZIP expansion mismatch: ${entry.name}`));
        crc = nextCrc(crc, chunk);
        done(null, chunk);
      },
    });
    const reader = createReadStream(archive, { start, end: start + entry.packed - 1 });
    const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
    if (entry.method === 8) await pipeline(reader, createInflateRaw(), guard, output);
    else await pipeline(reader, guard, output);
    assert(count === entry.unpacked && ((crc ^ 0xffffffff) >>> 0) === entry.crc,
      `ZIP member content checksum mismatch: ${entry.name}`);
  } finally {
    await file.close();
  }
}

// Deterministic DOS timestamp: January 1, 2026 at midnight.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
function header(type, name, crc, compressed, uncompressed, offset, executable) {
  const central = type === 'central';
  const b = Buffer.alloc(central ? 46 + Buffer.byteLength(name) : 30 + Buffer.byteLength(name));
  b.writeUInt32LE(central ? CENTRAL : LOCAL, 0);
  if (central) b.writeUInt16LE(0x0314, 4);
  b.writeUInt16LE(20, central ? 6 : 4);
  b.writeUInt16LE(0x0808, central ? 8 : 6);
  b.writeUInt16LE(8, central ? 10 : 8);
  b.writeUInt16LE(0, central ? 12 : 10);
  b.writeUInt16LE(DOS_DATE, central ? 14 : 12);
  b.writeUInt32LE(crc, central ? 16 : 14);
  b.writeUInt32LE(compressed, central ? 20 : 18);
  b.writeUInt32LE(uncompressed, central ? 24 : 22);
  b.writeUInt16LE(Buffer.byteLength(name), central ? 28 : 26);
  if (central) {
    b.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    b.writeUInt32LE(offset, 42);
  }
  b.write(name, central ? 46 : 30, 'utf8');
  return b;
}

export async function writeZip(archive, members) {
  const output = await open(archive, 'wx');
  let position = 0;
  const central = [];
  try {
    const append = async (bytes) => {
      if (position + bytes.length >= 0xffffffff) throw new Error('ZIP exceeds ZIP32 limit');
      let written = 0;
      while (written < bytes.length) {
        const next = await output.write(bytes, written, bytes.length - written, position + written);
        written += next.bytesWritten;
      }
      position += bytes.length;
    };
    for (const { name, file, text, executable = false } of members) {
      assert(name && !name.startsWith('/') && !name.split('/').includes('..'), 'Unsafe output ZIP filename');
      const offset = position;
      await append(header('local', name, 0, 0, 0, 0, executable));
      let crc = 0xffffffff;
      let unpacked = 0;
      let packed = 0;
      const tracker = new Transform({
        transform(chunk, _, done) {
          unpacked += chunk.length;
          crc = nextCrc(crc, chunk);
          done(null, chunk);
        },
      });
      const writer = new Writable({
        async write(chunk, _, done) {
          try { await append(chunk); packed += chunk.length; done(); }
          catch (error) { done(error); }
        },
      });
      if (file) await pipeline(createReadStream(file), tracker, createDeflateRaw({ level: 9 }), writer);
      else await pipeline(Readable.from([Buffer.from(text ?? '', 'utf8')]), tracker, createDeflateRaw({ level: 9 }), writer);
      assert(unpacked > 0 && unpacked <= MAX_MEMBER, `Invalid output ZIP member size: ${name}`);
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(DESCRIPTOR, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed, 8);
      descriptor.writeUInt32LE(unpacked, 12);
      await append(descriptor);
      central.push(header('central', name, crc, packed, unpacked, offset, executable));
    }
    const centralOffset = position;
    for (const record of central) await append(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(position - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    await append(end);
    assert(position <= MAX_ARCHIVE, 'Output ZIP exceeds size limit');
  } catch (error) {
    await output.close();
    throw error;
  }
  await output.close();
}

export async function readZipEntry(archive, name) {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'ism-zip-read-'));
  try {
    const entry = (await zipEntries(archive)).get(name);
    assert(entry, `ZIP missing ${name}`);
    const target = join(dir, 'entry');
    await extractZipEntry(archive, entry, target);
    return await readFile(target);
  } finally { await rm(dir, { force: true, recursive: true }); }
}
