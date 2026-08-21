// A minimal, write-only ZIP archiver — streams a directory tree straight to
// an HTTP response as it's walked and compressed, without ever buffering a
// whole file (let alone a whole archive) in memory or on a temp file.
// Matches this project's existing preference for hand-rolling against
// Node's built-ins instead of adding a dependency (same instinct as
// docker.js's Engine API client and tailscale.js's CLI wrapper) — zlib
// already provides the hard part (DEFLATE); this is just the container
// format around it: local file headers, a central directory, and CRC32.
//
// Deliberately write-only (never needs to parse a ZIP back), which is the
// simpler half of the format. Not implemented: ZIP64 (so a single archive
// is capped well under 4GiB — see MAX_ZIP_SIZE), encryption, and per-file
// unix permissions/symlinks. Good enough for "download this folder,"
// which is all this is for.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// The ZIP32 format's offset/size fields are 32-bit, so the whole archive
// has to stay under 4GiB regardless of how large any individual file is.
// Checked up front (before any bytes are sent) against the *uncompressed*
// total as a conservative stand-in for final archive size, so an
// oversized folder fails with a clear error instead of silently producing
// a truncated/corrupt zip partway through streaming.
export const MAX_ZIP_SIZE = 3.5 * 1024 * 1024 * 1024;

export class ZipTooLargeError extends Error {}

// ---------- CRC32 (standard table-based algorithm) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc, buf) {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

// ---------- MS-DOS date/time (the format ZIP headers use) ----------

function toDosDateTime(date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const dosDate = (((Math.max(0, d.getFullYear() - 1980)) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { dosTime, dosDate };
}

// ---------- Directory walk ----------
// Mirrors files.js's own recursive-search walker: entry.isDirectory() or
// else treated as a file, same convention the shared-folder listing
// already uses. An empty directory gets its own zip entry (trailing "/",
// no data) so the folder structure survives extraction even where no file
// happens to be sitting inside it; a directory with contents doesn't need
// one since the file paths inside it recreate it on extract.
async function* walk(root, relDir = '') {
  const entries = await fsp.readdir(path.join(root, relDir), { withFileTypes: true });
  if (entries.length === 0 && relDir !== '') {
    yield { type: 'dir', relPath: relDir };
    return;
  }
  for (const entry of entries) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walk(root, relPath);
    } else {
      const absPath = path.join(root, relPath);
      let stat;
      try {
        stat = await fsp.stat(absPath);
      } catch {
        continue; // vanished between readdir and stat — skip rather than fail the whole archive
      }
      yield { type: 'file', relPath, absPath, size: stat.size, mtime: stat.mtime };
    }
  }
}

// Walks the whole tree up front (cheap — just readdir/stat, no file data
// read yet) so the size limit can be enforced, and a clear error returned,
// *before* any response headers commit this request to a 200 + streamed
// body. Callers that need to send that error as a normal JSON response
// should call this first and separately from streamPlannedZip below.
export async function planZip(rootAbsPath) {
  const entries = [];
  let totalSize = 0;
  for await (const entry of walk(rootAbsPath)) {
    entries.push(entry);
    if (entry.type === 'file') totalSize += entry.size;
  }
  if (totalSize > MAX_ZIP_SIZE) {
    const gib = (n) => (n / 1024 ** 3).toFixed(1);
    throw new ZipTooLargeError(
      `This folder is ${gib(totalSize)} GB — too large to zip in one download (limit ${gib(MAX_ZIP_SIZE)} GB). Try a subfolder or individual files instead.`
    );
  }
  return { entries, totalSize };
}

// ---------- Binary header builders (PKZIP APPNOTE.TXT layout) ----------

const SIG_LOCAL = 0x04034b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// Bit 3: sizes/CRC unknown at header-write time, written after the data in
// a data descriptor instead — lets this stream compress-and-send in one
// pass without knowing a file's compressed size in advance. Bit 11: UTF-8
// filenames, so non-ASCII names round-trip correctly.
const FLAG_STREAMED_UTF8 = (1 << 3) | (1 << 11);
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;
const VERSION_NEEDED = 20;

function buildLocalHeader(nameBuf, mtime, method) {
  const { dosTime, dosDate } = toDosDateTime(mtime);
  const buf = Buffer.alloc(30 + nameBuf.length);
  buf.writeUInt32LE(SIG_LOCAL, 0);
  buf.writeUInt16LE(VERSION_NEEDED, 4);
  buf.writeUInt16LE(FLAG_STREAMED_UTF8, 6);
  buf.writeUInt16LE(method, 8);
  buf.writeUInt16LE(dosTime, 10);
  buf.writeUInt16LE(dosDate, 12);
  buf.writeUInt32LE(0, 14); // crc-32 — placeholder, real value in the data descriptor
  buf.writeUInt32LE(0, 18); // compressed size — placeholder
  buf.writeUInt32LE(0, 22); // uncompressed size — placeholder
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28); // extra field length
  nameBuf.copy(buf, 30);
  return buf;
}

function buildDataDescriptor(crc, compressedSize, uncompressedSize) {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(SIG_DATA_DESCRIPTOR, 0);
  buf.writeUInt32LE(crc, 4);
  buf.writeUInt32LE(compressedSize, 8);
  buf.writeUInt32LE(uncompressedSize, 12);
  return buf;
}

function buildCentralRecord(rec, nameBuf) {
  const { dosTime, dosDate } = toDosDateTime(rec.mtime);
  const buf = Buffer.alloc(46 + nameBuf.length);
  buf.writeUInt32LE(SIG_CENTRAL, 0);
  buf.writeUInt16LE(VERSION_NEEDED, 4); // version made by
  buf.writeUInt16LE(VERSION_NEEDED, 6); // version needed to extract
  buf.writeUInt16LE(FLAG_STREAMED_UTF8, 8);
  buf.writeUInt16LE(rec.method, 10);
  buf.writeUInt16LE(dosTime, 12);
  buf.writeUInt16LE(dosDate, 14);
  buf.writeUInt32LE(rec.crc, 16);
  buf.writeUInt32LE(rec.compressedSize, 20);
  buf.writeUInt32LE(rec.uncompressedSize, 24);
  buf.writeUInt16LE(nameBuf.length, 28);
  buf.writeUInt16LE(0, 30); // extra field length
  buf.writeUInt16LE(0, 32); // file comment length
  buf.writeUInt16LE(0, 34); // disk number start
  buf.writeUInt16LE(0, 36); // internal file attributes
  buf.writeUInt32LE(rec.isDir ? 0x10 : 0, 38); // external file attributes (DOS directory bit)
  buf.writeUInt32LE(rec.localHeaderOffset, 42);
  nameBuf.copy(buf, 46);
  return buf;
}

function buildEocd(recordCount, centralDirSize, centralDirOffset) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(SIG_EOCD, 0);
  buf.writeUInt16LE(0, 4); // disk number
  buf.writeUInt16LE(0, 6); // disk where central directory starts
  buf.writeUInt16LE(recordCount, 8);
  buf.writeUInt16LE(recordCount, 10);
  buf.writeUInt32LE(centralDirSize, 12);
  buf.writeUInt32LE(centralDirOffset, 16);
  buf.writeUInt16LE(0, 20); // comment length
  return buf;
}

// ---------- Streaming write ----------

function writeToStream(stream, buf) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buf, (err) => {
      if (err) reject(err);
    });
    if (ok) resolve();
    else stream.once('drain', resolve);
  });
}

async function writeDirEntry(stream, entry, offset) {
  const nameBuf = Buffer.from(entry.relPath + '/', 'utf-8');
  const localHeaderOffset = offset.bytes;
  // Nothing to stream and the size is already known (0), so this skips
  // the placeholder/data-descriptor dance files need.
  const { dosTime, dosDate } = toDosDateTime(new Date());
  const buf = Buffer.alloc(30 + nameBuf.length);
  buf.writeUInt32LE(SIG_LOCAL, 0);
  buf.writeUInt16LE(VERSION_NEEDED, 4);
  buf.writeUInt16LE(1 << 11, 6); // UTF-8 flag only — sizes are real, no streamed-data-descriptor bit needed
  buf.writeUInt16LE(METHOD_STORE, 8);
  buf.writeUInt16LE(dosTime, 10);
  buf.writeUInt16LE(dosDate, 12);
  buf.writeUInt32LE(0, 14);
  buf.writeUInt32LE(0, 18);
  buf.writeUInt32LE(0, 22);
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28);
  nameBuf.copy(buf, 30);

  await writeToStream(stream, buf);
  offset.bytes += buf.length;

  return {
    relPath: entry.relPath + '/',
    isDir: true,
    method: METHOD_STORE,
    crc: 0,
    compressedSize: 0,
    uncompressedSize: 0,
    localHeaderOffset,
    mtime: new Date(),
  };
}

async function streamFileEntry(stream, entry) {
  const nameBuf = Buffer.from(entry.relPath, 'utf-8');
  const header = buildLocalHeader(nameBuf, entry.mtime, METHOD_DEFLATE);

  const src = fs.createReadStream(entry.absPath);
  const deflater = zlib.createDeflateRaw();
  // .pipe() doesn't propagate errors between streams the way pipeline()
  // does, but pipeline() itself doesn't compose well with also consuming
  // the tail end manually below — so errors are wired through by hand.
  src.on('error', (err) => deflater.destroy(err));
  src.pipe(deflater);

  let crc = 0xffffffff;
  let uncompressedSize = 0;
  src.on('data', (chunk) => {
    crc = crc32Update(crc, chunk);
    uncompressedSize += chunk.length;
  });

  return { header, deflater, getResult: () => ({ crc: (crc ^ 0xffffffff) >>> 0, uncompressedSize }) };
}

// ---------- Streaming ----------

// Streams an already-planned entry list into `destStream`. Split out from
// planZip so a caller with response headers to manage (a size-limit
// rejection needs to become a normal JSON error, not a half-sent archive)
// can check the size *before* committing to a 200 and a streamed body,
// then hand the same entries here instead of walking the tree twice.
export async function streamPlannedZip(destStream, entries) {
  const offset = { bytes: 0 };
  const centralRecords = [];

  for (const entry of entries) {
    if (entry.type === 'dir') {
      centralRecords.push(await writeDirEntry(destStream, entry, offset));
      continue;
    }

    const nameBuf = Buffer.from(entry.relPath, 'utf-8');
    const localHeaderOffset = offset.bytes;
    const header = buildLocalHeader(nameBuf, entry.mtime, METHOD_DEFLATE);
    await writeToStream(destStream, header);
    offset.bytes += header.length;

    const { deflater, getResult } = await streamFileEntry(destStream, entry);
    let compressedSize = 0;
    for await (const chunk of deflater) {
      compressedSize += chunk.length;
      await writeToStream(destStream, chunk);
      offset.bytes += chunk.length;
    }
    const { crc, uncompressedSize } = getResult();

    const descriptor = buildDataDescriptor(crc, compressedSize, uncompressedSize);
    await writeToStream(destStream, descriptor);
    offset.bytes += descriptor.length;

    centralRecords.push({
      relPath: entry.relPath,
      isDir: false,
      method: METHOD_DEFLATE,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      mtime: entry.mtime,
    });
  }

  const centralDirStart = offset.bytes;
  for (const rec of centralRecords) {
    const nameBuf = Buffer.from(rec.relPath, 'utf-8');
    const buf = buildCentralRecord(rec, nameBuf);
    await writeToStream(destStream, buf);
    offset.bytes += buf.length;
  }
  const centralDirSize = offset.bytes - centralDirStart;

  await writeToStream(destStream, buildEocd(centralRecords.length, centralDirSize, centralDirStart));
}

// Convenience wrapper for callers with no headers to manage — plans and
// streams in one call. (The HTTP route uses planZip + streamPlannedZip
// directly instead, so it can turn a too-large-to-zip result into a
// normal JSON error rather than a broken response.)
export async function streamFolderZip(destStream, rootAbsPath) {
  const { entries } = await planZip(rootAbsPath);
  await streamPlannedZip(destStream, entries);
}
