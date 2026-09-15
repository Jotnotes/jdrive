'use strict';

// What a photograph says about itself.
//
// The box does not decode images, deliberately, and this does not change that:
// EXIF is a metadata block bolted to the front of a file, not the picture. What
// follows walks the TIFF directory inside that block and never touches a
// scanline, so the decoders that are historically the easiest way to be
// exploited by an uploaded file stay off this machine.
//
// Everything here treats the file as hostile, because it is: every number in it
// was chosen by whoever made it. A count says there are 60,000 entries; a value
// offset points past the end of the file, or back at itself; a string claims to
// be four gigabytes long. So every read is bounds-checked against the buffer, an
// offset that has already been visited is refused rather than followed, and the
// work is capped in three independent ways — entries per directory, directories
// per file, and bytes of string. A parser that trusts a length field is a parser
// that can be made to allocate whatever the sender likes.
//
// Not supported, and deliberately: HEIC and anything else that needs an
// ISO base-media parser to find its metadata. That is a container format with a
// box tree, and a box tree is exactly the kind of thing this file is being
// careful not to become.

const MAX_ENTRIES_PER_IFD = 512;
const MAX_IFDS = 8;
const MAX_STRING = 128;
// A camera writes its metadata at the front. Reading more than this to find it
// buys nothing and costs a big file being pulled through memory.
const READ_BYTES = 256 * 1024;

const TAGS = {
  0x010f: 'camera_make',
  0x0110: 'camera_model',
  0x0112: 'orientation',
  0x0131: 'software',
  0x0132: 'taken_at',        // DateTime, superseded by DateTimeOriginal below
  0x829a: 'exposure_seconds',
  0x829d: 'f_number',
  0x8827: 'iso',
  0x9003: 'taken_at',        // DateTimeOriginal, the one a photographer means
  0x920a: 'focal_length_mm',
  0xa002: 'width',
  0xa003: 'height',
  0xa434: 'lens',
};
const SUB_IFD = 0x8769;
const GPS_IFD = 0x8825;
const GPS = { 1: 'lat_ref', 2: 'lat', 3: 'lon_ref', 4: 'lon', 5: 'alt_ref', 6: 'alt' };

// Bytes per component, by TIFF type. A type this does not know is skipped
// rather than guessed at.
const WIDTHS = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

// The three containers this box reads a camera block out of, named once so the
// reader and the writer cannot drift apart about what a PNG looks like.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXIF_PREFIX = Buffer.from('Exif\0\0', 'latin1');
// XMP rides in the same three containers, under these names.
const XMP_PREFIX = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const XMP_EXTENDED_PREFIX = Buffer.from('http://ns.adobe.com/xmp/extension/\0', 'latin1');
const PNG_XMP_KEYWORD = Buffer.from('XML:com.adobe.xmp\0', 'latin1');
// The bits in a VP8X header that say an EXIF or an XMP chunk follows.
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

// What XMP is asked about, and the whole of it. This is a scan for names in a
// packet, not an XML parser: it decides a sentence in a sheet and which way a
// checkbox starts, and it must never be asked to decide anything else. A false
// positive costs a customer one glance at a label; the removal it offers is
// exact either way, and the original is kept whichever way they answer.
const XMP_LOCATION_NAMES = ['exif:GPSLatitude', 'exif:GPSLongitude', 'exif:GPSCoordinates',
  'Iptc4xmpExt:LocationShown', 'Iptc4xmpExt:LocationCreated'];
const XMP_CREDIT_NAMES = ['dc:creator', 'dc:rights', 'xmpRights:', 'photoshop:Credit',
  'photoshop:Source', 'plus:Licensor'];

function readExif(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  const block = findExifBlock(buffer);
  if (!block) return null;
  try {
    return walkTiff(block);
  } catch {
    // A malformed file is an ordinary event, not an error worth propagating:
    // the answer is that this file says nothing about itself.
    return null;
  }
}

// What the XMP packet in this file says about itself, or null when there is
// none. Only two questions are asked of it, because only two of them change
// what a customer is told: does it name where they stood, and does it name who
// made the picture. Those pull in opposite directions — one is a reason to
// remove the packet and the other is a reason to keep it — so the answer is
// shown rather than acted on.
function readXmp(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const packet = findXmpPacket(buffer);
  if (!packet) return null;
  if (!packet.readable) return { readable: false, location: false, credit: false };
  const text = packet.bytes.toString('latin1');
  return {
    readable: true,
    location: XMP_LOCATION_NAMES.some(name => text.includes(name)),
    credit: XMP_CREDIT_NAMES.some(name => text.includes(name)),
  };
}

function findXmpPacket(buffer) {
  switch (containerOf(buffer)) {
    case 'jpeg': return jpegXmp(buffer);
    case 'png': return pngXmp(buffer);
    case 'webp': return webpXmp(buffer);
    default: return null;
  }
}

// An APP1 segment like EXIF, under a different name. Extended XMP is a
// continuation of the same packet and answers to the same question.
function jpegXmp(buffer) {
  let at = 2;
  while (at + 4 <= buffer.length) {
    if (buffer[at] !== 0xff) return null;
    const marker = buffer[at + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const length = buffer.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buffer.length) return null;
    if (marker === 0xe1) {
      const payload = buffer.subarray(at + 4, at + 2 + length);
      for (const prefix of [XMP_PREFIX, XMP_EXTENDED_PREFIX]) {
        if (payload.subarray(0, prefix.length).equals(prefix)) {
          return { bytes: payload.subarray(prefix.length), readable: true };
        }
      }
    }
    at += 2 + length;
  }
  return null;
}

// An iTXt chunk under a reserved keyword. This one does not stop at IDAT the
// way the EXIF reader does, because editors routinely write XMP after the
// picture data, and a packet nobody looked for is one nobody can label.
function pngXmp(buffer) {
  let at = 8;
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.slice(at + 4, at + 8).toString('latin1');
    const start = at + 8;
    if (length > buffer.length || start + length > buffer.length) return null;
    if (type === 'iTXt' && buffer.subarray(start, start + PNG_XMP_KEYWORD.length).equals(PNG_XMP_KEYWORD)) {
      const after = start + PNG_XMP_KEYWORD.length;
      // The byte after the keyword says whether the text is deflated. The spec
      // says XMP never is; a file that does it anyway gets an honest shrug
      // rather than a confident answer read out of compressed bytes.
      return { bytes: buffer.subarray(after, start + length), readable: buffer[after] === 0 };
    }
    if (type === 'IEND') return null;
    at = start + length + 4;
  }
  return null;
}

function webpXmp(buffer) {
  let at = 12;
  while (at + 8 <= buffer.length) {
    const type = buffer.slice(at, at + 4).toString('latin1');
    const length = buffer.readUInt32LE(at + 4);
    const start = at + 8;
    if (length > buffer.length || start + length > buffer.length) return null;
    if (type === 'XMP ') return { bytes: buffer.subarray(start, start + length), readable: true };
    at = start + length + (length % 2);
  }
  return null;
}

// Where the EXIF block sits in each container this understands. Each of these
// walks a chain of lengths written by whoever made the file, so each one checks
// that a step actually moves forward and stays inside the buffer.
function findExifBlock(buffer) {
  switch (containerOf(buffer)) {
    case 'jpeg': return jpegExif(buffer);
    case 'png': return pngExif(buffer);
    case 'webp': return webpExif(buffer);
    default: return null;
  }
}

// What a file is, is what its first bytes say. Callers must not decide this
// from a name or from a type a client declared: a photograph does not stop
// carrying GPS because whatever uploaded it called itself octet-stream.
function containerOf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function jpegExif(buffer) {
  let at = 2;
  while (at + 4 <= buffer.length) {
    if (buffer[at] !== 0xff) return null;
    const marker = buffer[at + 1];
    // Start of scan: the picture itself begins here and there is no more
    // metadata to find.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = buffer.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buffer.length) return null;
    if (marker === 0xe1 && buffer.slice(at + 4, at + 10).toString('latin1') === 'Exif\0\0') {
      return buffer.slice(at + 10, at + 2 + length);
    }
    at += 2 + length;
  }
  return null;
}

// Removing metadata, in each container the reader above can find some in. A
// writer that covers fewer containers than the reader is a promise that holds
// for a JPEG and fails silently for the photograph beside it, so these three
// are exactly the three containerOf understands.
//
// Which kinds go is the caller's decision and never this module's. The camera
// block and the XMP packet are not the same kind of thing: one is written by a
// machine that was never asked, the other usually by the person who made the
// picture, and it carries their credit and their licence as often as it carries
// their coordinates. Encoded picture bytes and every segment not asked for
// survive. A file this cannot walk is refused rather than returned: bytes
// nobody could parse are bytes nobody can swear are clean.
function strip(buffer, wanted) {
  const drop = { exif: !!(wanted && wanted.exif), xmp: !!(wanted && wanted.xmp) };
  if (!drop.exif && !drop.xmp) return buffer;
  switch (containerOf(buffer)) {
    case 'jpeg': return stripJpeg(buffer, drop);
    case 'png': return stripPng(buffer, drop);
    case 'webp': return stripWebp(buffer, drop);
    default: return buffer;
  }
}

// What a file still carries, asked at the level of "is the segment there" and
// not "can it be parsed". A caller checking its own work needs presence, since
// a block this cannot read is still a block that travels with the file.
function carries(buffer) {
  return { exif: findExifBlock(buffer) !== null, xmp: findXmpPacket(buffer) !== null };
}

// The camera block alone, which is what most callers want.
function stripExif(buffer) { return strip(buffer, { exif: true }); }

// Which of the two an APP1 segment is carrying, or neither.
function app1Kind(payload) {
  if (payload.subarray(0, EXIF_PREFIX.length).equals(EXIF_PREFIX)) return 'exif';
  for (const prefix of [XMP_PREFIX, XMP_EXTENDED_PREFIX]) {
    if (payload.subarray(0, prefix.length).equals(prefix)) return 'xmp';
  }
  return null;
}

function stripJpeg(buffer, drop) {
  const pieces = [];
  let at = 2;
  let kept = 0;
  while (at < buffer.length) {
    const start = at;
    if (buffer[at++] !== 0xff) throw new Error('Malformed JPEG marker');
    while (buffer[at] === 0xff) at++;
    const marker = buffer[at++];
    if (marker === 0xda || marker === 0xd9) {
      pieces.push(buffer.subarray(kept));
      return Buffer.concat(pieces);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > buffer.length) throw new Error('Truncated JPEG segment');
    const length = buffer.readUInt16BE(at);
    if (length < 2 || at + length > buffer.length) throw new Error('Invalid JPEG segment length');
    if (marker === 0xe1) {
      const kind = app1Kind(buffer.subarray(at + 2, at + length));
      if (kind && drop[kind]) {
        pieces.push(buffer.subarray(kept, start));
        kept = at + length;
      }
    }
    at += length;
  }
  throw new Error('JPEG has no scan or end marker');
}

// A PNG is a chain of chunks, each one a length, a type, its data and a
// checksum. Dropping a chunk means dropping all four parts of it, and nothing
// else in the file measures the whole, so nothing else needs rewriting. Every
// match goes, including one written after the picture data.
function stripPng(buffer, drop) {
  const pieces = [];
  let at = 8;
  let kept = 0;
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.subarray(at + 4, at + 8).toString('latin1');
    const end = at + 8 + length + 4;
    if (length > buffer.length || end > buffer.length) throw new Error('Invalid PNG chunk length');
    const isXmp = type === 'iTXt'
      && buffer.subarray(at + 8, at + 8 + PNG_XMP_KEYWORD.length).equals(PNG_XMP_KEYWORD);
    if ((type === 'eXIf' && drop.exif) || (isXmp && drop.xmp)) {
      pieces.push(buffer.subarray(kept, at));
      kept = end;
    }
    if (type === 'IEND') {
      pieces.push(buffer.subarray(kept));
      return Buffer.concat(pieces);
    }
    at = end;
  }
  throw new Error('PNG has no end marker');
}

// A WebP is RIFF: a total size in the header, then chunks padded to an even
// length. Removing one means correcting that total, and clearing the bit in the
// VP8X header that advertises it. A header still promising a chunk that is gone
// is a file some decoders refuse, which would make removal look like corruption.
function stripWebp(buffer, drop) {
  const pieces = [];
  let at = 12;
  let kept = 0;
  let cleared = 0;
  while (at + 8 <= buffer.length) {
    const type = buffer.subarray(at, at + 4).toString('latin1');
    const length = buffer.readUInt32LE(at + 4);
    const dataEnd = at + 8 + length;
    if (length > buffer.length || dataEnd > buffer.length) throw new Error('Invalid WebP chunk length');
    const end = Math.min(dataEnd + (length % 2), buffer.length);
    const flag = type === 'EXIF' ? VP8X_EXIF_FLAG : type === 'XMP ' ? VP8X_XMP_FLAG : 0;
    if ((type === 'EXIF' && drop.exif) || (type === 'XMP ' && drop.xmp)) {
      pieces.push(buffer.subarray(kept, at));
      kept = end;
      cleared |= flag;
    }
    at = end;
  }
  if (!cleared) return buffer;
  pieces.push(buffer.subarray(kept));
  const out = Buffer.concat(pieces);
  out.writeUInt32LE(out.length - 8, 4);
  if (out.subarray(12, 16).toString('latin1') === 'VP8X' && out.length > 20) out[20] &= ~cleared;
  return out;
}

function pngExif(buffer) {
  let at = 8;
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.slice(at + 4, at + 8).toString('latin1');
    const start = at + 8;
    if (length > buffer.length || start + length > buffer.length) return null;
    if (type === 'eXIf') return buffer.slice(start, start + length);
    if (type === 'IDAT' || type === 'IEND') return null;
    at = start + length + 4;
  }
  return null;
}

function webpExif(buffer) {
  let at = 12;
  while (at + 8 <= buffer.length) {
    const type = buffer.slice(at, at + 4).toString('latin1');
    const length = buffer.readUInt32LE(at + 4);
    const start = at + 8;
    if (length > buffer.length || start + length > buffer.length) return null;
    if (type === 'EXIF') {
      const chunk = buffer.slice(start, start + length);
      // Some encoders leave the JPEG-style prefix on the chunk.
      return chunk.slice(0, 6).toString('latin1') === 'Exif\0\0' ? chunk.slice(6) : chunk;
    }
    at = start + length + (length % 2);
  }
  return null;
}

function walkTiff(tiff) {
  if (tiff.length < 8) return null;
  const order = tiff.slice(0, 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const u16 = at => (at + 2 <= tiff.length ? (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at)) : null);
  const u32 = at => (at + 4 <= tiff.length ? (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at)) : null);
  const i32 = at => (at + 4 <= tiff.length ? (little ? tiff.readInt32LE(at) : tiff.readInt32BE(at)) : null);
  if (u16(2) !== 42) return null;

  const found = {};
  const gps = {};
  const seen = new Set();
  let directories = 0;

  const read = (offset, into) => {
    if (offset == null || offset < 8 || offset + 2 > tiff.length) return;
    if (seen.has(offset) || directories >= MAX_IFDS) return;
    seen.add(offset);
    directories += 1;
    const count = u16(offset);
    if (count == null) return;
    const entries = Math.min(count, MAX_ENTRIES_PER_IFD);
    for (let i = 0; i < entries; i += 1) {
      const at = offset + 2 + i * 12;
      if (at + 12 > tiff.length) return;
      const tag = u16(at);
      const type = u16(at + 2);
      const length = u32(at + 4);
      const width = WIDTHS[type];
      if (!width || length == null) continue;
      const bytes = width * length;
      // Four bytes or fewer live in the entry; anything larger is an offset,
      // and that offset is a number the file chose.
      const valueAt = bytes <= 4 ? at + 8 : u32(at + 8);
      if (valueAt == null || valueAt < 0 || valueAt + Math.min(bytes, MAX_STRING * 4) > tiff.length + 4) continue;
      if (valueAt + bytes > tiff.length) continue;

      if (tag === SUB_IFD) { read(u32(bytes <= 4 ? at + 8 : valueAt), found); continue; }
      if (tag === GPS_IFD) { read(u32(bytes <= 4 ? at + 8 : valueAt), gps); continue; }

      const name = into === gps ? GPS[tag] : TAGS[tag];
      if (!name) continue;
      const value = readValue({ tiff, type, length, valueAt, u16, u32, i32 });
      if (value === null || value === undefined) continue;
      // DateTimeOriginal wins over DateTime, and neither overwrites the other's
      // slot once something real is in it.
      if (name === 'taken_at' && into.taken_at && tag !== 0x9003) continue;
      into[name] = value;
    }
  };

  read(u32(4), found);

  const out = {
    camera_make: text(found.camera_make),
    camera_model: text(found.camera_model),
    lens: text(found.lens),
    software: text(found.software),
    taken_at: exifDate(found.taken_at),
    orientation: whole(found.orientation, 1, 8),
    width: whole(found.width, 1, 1e6),
    height: whole(found.height, 1, 1e6),
    iso: whole(found.iso, 1, 4000000),
    f_number: decimal(found.f_number, 0, 1000),
    exposure_seconds: decimal(found.exposure_seconds, 0, 100000),
    focal_length_mm: decimal(found.focal_length_mm, 0, 100000),
    ...coordinates(gps),
  };
  return Object.values(out).some(v => v !== null) ? out : null;
}

function readValue({ tiff, type, length, valueAt, u16, u32, i32 }) {
  if (type === 2) {
    const end = Math.min(valueAt + Math.min(length, MAX_STRING), tiff.length);
    return tiff.slice(valueAt, end).toString('latin1');
  }
  if (type === 1 || type === 6 || type === 7) return tiff[valueAt];
  if (type === 3 || type === 8) return u16(valueAt);
  if (type === 4 || type === 9) return u32(valueAt);
  if (type === 5 || type === 10) {
    // A coordinate is three rationals in a row — degrees, minutes, seconds — so
    // more than one component is read and handed back as a list. Capped, because
    // the count came out of the file.
    const parts = [];
    for (let i = 0; i < Math.min(length, 8); i += 1) {
      const at = valueAt + i * 8;
      if (at + 8 > tiff.length) break;
      const numerator = type === 5 ? u32(at) : i32(at);
      const denominator = type === 5 ? u32(at + 4) : i32(at + 4);
      if (!denominator) { parts.push(null); continue; }
      parts.push(numerator / denominator);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : parts;
  }
  if (type === 11) return null;
  return null;
}

// Degrees, minutes and seconds into one number, with the hemisphere applied.
// A coordinate that does not survive this is dropped rather than approximated:
// a wrong location on a photograph is worse than none.
function coordinates(gps) {
  const pair = (parts, ref, positive) => {
    if (!Array.isArray(parts) || parts.length < 1) return null;
    const [d = 0, m = 0, s = 0] = parts;
    if (![d, m, s].every(n => Number.isFinite(n))) return null;
    const size = d + m / 60 + s / 3600;
    if (!Number.isFinite(size)) return null;
    // The reference arrives as the camera wrote it, which is "N" followed by a
    // null. Comparing that to "N" is false, and a false there silently moves the
    // photograph into the other hemisphere — so it is cleaned first, by the same
    // function every other string here goes through.
    const sign = (text(ref) || '').toUpperCase() === positive ? 1 : -1;
    return Math.round(size * sign * 1e6) / 1e6;
  };
  const lat = pair(gps.lat, gps.lat_ref, 'N');
  const lon = pair(gps.lon, gps.lon_ref, 'E');
  return {
    gps_lat: lat !== null && Math.abs(lat) <= 90 ? lat : null,
    gps_lon: lon !== null && Math.abs(lon) <= 180 ? lon : null,
    gps_altitude_m: decimal(gps.alt, -12000, 100000),
  };
}

// Printable, trimmed, and short. A camera writes ASCII with a trailing null;
// anything else in there is somebody being interesting.
function text(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/\u0000[\s\S]*$/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, MAX_STRING) : null;
}

// EXIF writes 2026:03:14 15:22:07, in the camera's own local time with nothing
// saying which one. It is stored and shown exactly as the camera wrote it: the
// alternative is inventing a zone, and a photograph taken at four in the
// afternoon should not read as one in the morning because a server is in Utah.
function exifDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 1826 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59) return null;
  return `${y}-${mo}-${d} ${h}:${mi}:${s || '00'}`;
}

function whole(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function decimal(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 1e6) / 1e6;
}

module.exports = { containerOf, carries, strip, stripExif, readExif, readXmp, READ_BYTES, MAX_STRING, MAX_ENTRIES_PER_IFD, MAX_IFDS };
