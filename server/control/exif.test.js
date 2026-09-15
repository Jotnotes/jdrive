'use strict';

// The EXIF reader, including the parts of it that exist because the file is
// hostile. Every fixture here is built byte by byte rather than checked in as a
// photograph: a test that depends on a JPEG somebody found proves that one JPEG
// works, and proves nothing about the count field being 60,000.

const assert = require('assert');
const exif = require('./exif');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

// ── A TIFF block, written the way a camera writes one ────────────────────────

const ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5;

function entry(tag, type, count, value) { return { tag, type, count, value }; }
const ascii = (tag, text) => entry(tag, ASCII, text.length + 1, Buffer.from(`${text}\0`, 'latin1'));
const short = (tag, n) => entry(tag, SHORT, 1, n);
const long = (tag, n) => entry(tag, LONG, 1, n);
const rational = (tag, pairs) => entry(tag, RATIONAL, pairs.length,
  Buffer.concat(pairs.map(([n, d]) => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32LE(d, 4); return b; })));

// Lays out IFD0, the Exif sub-directory and the GPS directory one after the
// other, then everything too big to sit inside an entry after those.
function buildTiff({ ifd0 = [], sub = [], gps = [] }) {
  const SUB_IFD = 0x8769;
  const GPS_IFD = 0x8825;
  const sizeOf = list => 2 + list.length * 12 + 4;

  const ifd0Entries = [...ifd0];
  const ifd0Start = 8;
  const subStart = ifd0Start + sizeOf([...ifd0Entries, ...(sub.length ? [1] : []), ...(gps.length ? [1] : [])]);
  const gpsStart = subStart + (sub.length ? sizeOf(sub) : 0);
  const heapStart = gpsStart + (gps.length ? sizeOf(gps) : 0);

  if (sub.length) ifd0Entries.push(long(SUB_IFD, subStart));
  if (gps.length) ifd0Entries.push(long(GPS_IFD, gpsStart));

  const heap = [];
  let heapAt = heapStart;

  const writeIfd = (list) => {
    const buf = Buffer.alloc(sizeOf(list));
    buf.writeUInt16LE(list.length, 0);
    list.forEach((e, i) => {
      const at = 2 + i * 12;
      buf.writeUInt16LE(e.tag, at);
      buf.writeUInt16LE(e.type, at + 2);
      buf.writeUInt32LE(e.count, at + 4);
      if (Buffer.isBuffer(e.value)) {
        if (e.value.length <= 4) e.value.copy(buf, at + 8);
        else { buf.writeUInt32LE(heapAt, at + 8); heap.push(e.value); heapAt += e.value.length; }
      } else if (e.type === SHORT) buf.writeUInt16LE(e.value, at + 8);
      else buf.writeUInt32LE(e.value, at + 8);
    });
    return buf;
  };

  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(ifd0Start, 4);

  const parts = [header, writeIfd(ifd0Entries)];
  if (sub.length) parts.push(writeIfd(sub));
  if (gps.length) parts.push(writeIfd(gps));
  return Buffer.concat([...parts, ...heap]);
}

function jpeg(tiff) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1, payload,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
  ]);
}

function png(tiff) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('eXIf', tiff),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const A_PHOTOGRAPH = jpeg(buildTiff({
  ifd0: [ascii(0x010f, 'Fujifilm'), ascii(0x0110, 'X100V'), short(0x0112, 6)],
  sub: [
    ascii(0x9003, '2026:03:14 15:22:07'),
    short(0x8827, 400),
    rational(0x829d, [[28, 10]]),
    rational(0x829a, [[1, 250]]),
    rational(0x920a, [[23, 1]]),
    long(0xa002, 6240),
    long(0xa003, 4160),
  ],
  gps: [
    ascii(0x0001, 'N'), rational(0x0002, [[51, 1], [30, 1], [26, 1]]),
    ascii(0x0003, 'W'), rational(0x0004, [[0, 1], [7, 1], [39, 1]]),
  ],
}));

// ── What it should read ─────────────────────────────────────────────────────

check('a photograph says what took it, when, and how', () => {
  const out = exif.readExif(A_PHOTOGRAPH);
  assert.ok(out, 'nothing was read from a file that has EXIF in it');
  assert.strictEqual(out.camera_make, 'Fujifilm');
  assert.strictEqual(out.camera_model, 'X100V');
  assert.strictEqual(out.orientation, 6);
  assert.strictEqual(out.taken_at, '2026-03-14 15:22:07');
  assert.strictEqual(out.iso, 400);
  assert.strictEqual(out.f_number, 2.8);
  assert.strictEqual(out.exposure_seconds, 0.004);
  assert.strictEqual(out.focal_length_mm, 23);
  assert.strictEqual(out.width, 6240);
  assert.strictEqual(out.height, 4160);
});

// Degrees, minutes and seconds, with the hemisphere deciding the sign. West and
// south are negative; getting that backwards puts the photograph in the wrong
// half of the world, which is worse than having no location at all.
check('a location is read, and the hemisphere decides the sign', () => {
  const out = exif.readExif(A_PHOTOGRAPH);
  assert.strictEqual(out.gps_lat, 51.507222);
  assert.strictEqual(out.gps_lon, -0.1275);
});

check('the same block inside a PNG reads the same way', () => {
  const out = exif.readExif(png(buildTiff({ ifd0: [ascii(0x010f, 'Nikon')] })));
  assert.strictEqual(out.camera_make, 'Nikon');
});

check('a file with no EXIF, and a file that is not an image, both say nothing', () => {
  assert.strictEqual(exif.readExif(png(Buffer.alloc(0))), null);
  assert.strictEqual(exif.readExif(Buffer.from('this is a text file, at some length')), null);
  assert.strictEqual(exif.readExif(Buffer.alloc(4)), null);
  assert.strictEqual(exif.readExif(null), null);
});

// ── The parts that exist because the file chose the numbers ──────────────────

check('a truncated file is not read past its end', () => {
  for (let cut = 2; cut < A_PHOTOGRAPH.length; cut += 7) {
    const out = exif.readExif(A_PHOTOGRAPH.slice(0, cut));
    assert.ok(out === null || typeof out === 'object', `a ${cut}-byte file threw`);
  }
});

// The count is two bytes and can say 65,535 in a directory that holds four.
check('a directory that claims more entries than the file holds is refused', () => {
  const block = buildTiff({ ifd0: [ascii(0x010f, 'Canon')] });
  block.writeUInt16LE(65535, 8);
  const out = exif.readExif(jpeg(block));
  assert.ok(out === null || out.camera_make === 'Canon' || out.camera_make === null);
});

// Without the visited-offset set this walks forever.
check('a directory that points at itself does not hang', () => {
  const block = buildTiff({ ifd0: [long(0x8769, 8)] });
  const started = Date.now();
  exif.readExif(jpeg(block));
  assert.ok(Date.now() - started < 1000, 'a self-referencing directory took too long');
});

check('a value offset that points outside the block is ignored', () => {
  const block = buildTiff({ ifd0: [ascii(0x010f, 'Leica Camera AG')] });
  // The make is long enough to live on the heap, so entry 0 carries an offset.
  block.writeUInt32LE(0xfffff000, 8 + 2 + 8);
  const out = exif.readExif(jpeg(block));
  assert.ok(out === null || out.camera_make === null);
});

check('a rational over zero is dropped rather than becoming infinity', () => {
  const out = exif.readExif(jpeg(buildTiff({ ifd0: [ascii(0x010f, 'Zero')], sub: [rational(0x829d, [[28, 0]])] })));
  assert.strictEqual(out.f_number, null);
});

check('a date that is not a date is dropped', () => {
  for (const bad of ['not a date at all', '0000:00:00 00:00:00', '2026:13:44 99:99:99', '2026-03-14']) {
    const out = exif.readExif(jpeg(buildTiff({ ifd0: [ascii(0x010f, 'X')], sub: [ascii(0x9003, bad)] })));
    assert.strictEqual(out.taken_at, null, `${bad} was accepted as a date`);
  }
});

// A camera writes ASCII with a trailing null. Anything else in there is somebody
// being interesting, and it ends up in a browser.
check('a name made of control characters comes back clean or empty', () => {
  const nasty = `Ac${String.fromCharCode(7)}me${String.fromCharCode(27)}[31m`;
  const out = exif.readExif(jpeg(buildTiff({ ifd0: [ascii(0x010f, nasty)] })));
  assert.ok(out === null || !/[\u0000-\u001f\u007f]/.test(out.camera_make || ''), 'a control character survived');
});

check('a string is not allowed to be longer than the cap', () => {
  const out = exif.readExif(jpeg(buildTiff({ ifd0: [ascii(0x010f, 'M'.repeat(4000))] })));
  assert.ok(!out || !out.camera_make || out.camera_make.length <= exif.MAX_STRING);
});

check('a coordinate outside the world is dropped', () => {
  const out = exif.readExif(jpeg(buildTiff({
    ifd0: [ascii(0x010f, 'X')],
    gps: [ascii(0x0001, 'N'), rational(0x0002, [[910, 1], [0, 1], [0, 1]])],
  })));
  assert.strictEqual(out.gps_lat, null);
});

check('stripping removes repeated EXIF blocks while preserving XMP and scan bytes', () => {
  const block = jpeg(buildTiff({ ifd0: [ascii(0x010f, 'Camera')] }));
  const end = block.indexOf(Buffer.from([0xff, 0xda]));
  const app1 = block.subarray(2, end);
  const xmp = Buffer.from([0xff, 0xe1, 0, 5, 88, 77, 80]);
  const scan = Buffer.from([0xff, 0xda, 0, 2, 1, 2, 0xff, 0, 3, 0xff, 0xd9]);
  const clean = Buffer.concat([Buffer.from([0xff, 0xd8]), xmp, scan]);
  const input = Buffer.concat([clean.subarray(0, 2), app1, xmp, app1, scan]);
  assert.deepStrictEqual(exif.stripExif(input), clean);
  assert.deepStrictEqual(exif.stripExif(clean), clean);
  assert.strictEqual(exif.readExif(exif.stripExif(input)), null);
});

check('stripping refuses truncated or invalid JPEG headers', () => {
  for (const bytes of [[255,216,255,225,0,1], [255,216,255,225,255,255], [255,216,0]]) {
    assert.throws(() => exif.stripExif(Buffer.from(bytes)));
  }
  const text = Buffer.from('untouched');
  assert.strictEqual(exif.stripExif(text), text);
});

// ── The other two containers ────────────────────────────────────────────────
//
// The reader finds a camera block in a JPEG, a PNG and a WebP. Until these, the
// writer only cleaned the first of the three, so the sheet's promise held for
// one photograph and quietly failed for the one beside it.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pngChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
};

const webpChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
};

const riff = chunks => {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
};

const WHERE_THEY_STOOD = {
  ifd0: [ascii(0x010f, 'Leica')],
  gps: [ascii(0x0001, 'N'), rational(0x0002, [[51, 1], [30, 1], [26, 1]]),
    ascii(0x0003, 'W'), rational(0x0004, [[0, 1], [7, 1], [39, 1]])],
};

check('a PNG loses every eXIf chunk, including one written after the picture', () => {
  const tiff = buildTiff(WHERE_THEY_STOOD);
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(13))];
  const clean = Buffer.concat([...parts, pngChunk('IDAT', Buffer.from('picture')), pngChunk('IEND', Buffer.alloc(0))]);
  const dirty = Buffer.concat([...parts, pngChunk('eXIf', tiff), pngChunk('IDAT', Buffer.from('picture')),
    pngChunk('eXIf', tiff), pngChunk('IEND', Buffer.alloc(0))]);

  // The fixture has to carry something, or removing it proves nothing.
  assert.strictEqual(exif.readExif(dirty).gps_lat, 51.507222);
  assert.deepStrictEqual(exif.stripExif(dirty), clean);
  assert.strictEqual(exif.readExif(exif.stripExif(dirty)), null);
  assert.deepStrictEqual(exif.stripExif(clean), clean);
});

check('a WebP loses its EXIF chunk, and its header stops advertising one', () => {
  const flags = Buffer.alloc(10);
  flags[0] = 0x08 | 0x10; // this file has EXIF, and it has alpha
  const dirty = riff([webpChunk('VP8X', flags), webpChunk('VP8 ', Buffer.from('picture')),
    webpChunk('EXIF', buildTiff(WHERE_THEY_STOOD))]);
  assert.strictEqual(exif.readExif(dirty).camera_make, 'Leica');

  const out = exif.stripExif(dirty);
  assert.strictEqual(exif.readExif(out), null);
  assert.strictEqual(out.readUInt32LE(4), out.length - 8, 'the total size was not corrected');
  assert.strictEqual(out[20] & 0x08, 0, 'the header still advertises an EXIF chunk');
  assert.strictEqual(out[20] & 0x10, 0x10, 'clearing that bit disturbed another');
  assert.ok(out.includes(Buffer.from('picture')), 'the picture went with it');

  const clean = riff([webpChunk('VP8 ', Buffer.from('picture'))]);
  assert.strictEqual(exif.stripExif(clean), clean);
});

// The one that matters when somebody teaches the reader a fourth container: a
// format it can read out of and the writer cannot clean is a leak that ships.
check('every container the reader understands is one the writer can clean', () => {
  const tiff = buildTiff(WHERE_THEY_STOOD);
  const containers = [
    ['JPEG', jpeg(tiff)],
    ['PNG', png(tiff)],
    ['WebP', riff([webpChunk('VP8 ', Buffer.from('picture')), webpChunk('EXIF', tiff)])],
  ];
  for (const [name, carrying] of containers) {
    assert.ok(exif.readExif(carrying), `${name}: the fixture carries nothing to remove`);
    assert.strictEqual(exif.readExif(exif.stripExif(carrying)), null, `${name}: the camera block survived`);
  }
});

check('a PNG or WebP this cannot walk is refused rather than published', () => {
  const noEnd = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(13))]);
  assert.throws(() => exif.stripExif(noEnd), /PNG has no end marker/);

  const runaway = Buffer.concat([PNG_SIGNATURE, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('eXIf', 'latin1')]);
  assert.throws(() => exif.stripExif(runaway), /Invalid PNG chunk length/);

  const lying = riff([webpChunk('EXIF', Buffer.alloc(4))]);
  lying.writeUInt32LE(0xfffffff0, 16);
  assert.throws(() => exif.stripExif(lying), /Invalid WebP chunk length/);
});

// ── The other packet ────────────────────────────────────────────────────────
//
// XMP rides in the same three containers and is not the same kind of thing. A
// camera writes EXIF without being asked; a person usually writes XMP, and it
// carries their credit and their licence as often as their coordinates. So the
// two are read separately and removed separately, and these check that asking
// for one never takes the other.

const A_PACKET = Buffer.from(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description'
  + ' dc:creator="Ada Lovelace" exif:GPSLatitude="51,30.44N"/></rdf:RDF></x:xmpmeta>', 'latin1');
const A_QUIET_PACKET = Buffer.from(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description'
  + ' xmp:CreatorTool="Darkroom"/></rdf:RDF></x:xmpmeta>', 'latin1');

const app1 = (signature, payload) => {
  const body = Buffer.concat([Buffer.from(signature, 'latin1'), payload]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};

// A JPEG carrying whichever of the two are asked for, in the order a camera and
// then an editor would have written them.
const jpegWith = ({ tiff = null, packet = null }) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  ...(tiff ? [app1('Exif\0\0', tiff)] : []),
  ...(packet ? [app1('http://ns.adobe.com/xap/1.0/\0', packet)] : []),
  Buffer.from([0xff, 0xda, 0x00, 0x02]),
]);

const iTXt = (packet, compressed = false) => pngChunk('iTXt', Buffer.concat([
  Buffer.from('XML:com.adobe.xmp\0', 'latin1'),
  Buffer.from([compressed ? 1 : 0, 0]), // compression flag, then method
  Buffer.from([0, 0]),                  // language tag, translated keyword
  packet,
]));

const pngWith = ({ tiff = null, packet = null, compressed = false }) => Buffer.concat([
  PNG_SIGNATURE,
  pngChunk('IHDR', Buffer.alloc(13)),
  ...(tiff ? [pngChunk('eXIf', tiff)] : []),
  pngChunk('IDAT', Buffer.from('picture')),
  ...(packet ? [iTXt(packet, compressed)] : []),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const webpWith = ({ tiff = null, packet = null, flags = 0 }) => riff([
  webpChunk('VP8X', (() => { const b = Buffer.alloc(10); b[0] = flags; return b; })()),
  webpChunk('VP8 ', Buffer.from('picture')),
  ...(tiff ? [webpChunk('EXIF', tiff)] : []),
  ...(packet ? [webpChunk('XMP ', packet)] : []),
]);

check('the packet is read out of all three containers, and says what it names', () => {
  const tiff = buildTiff(WHERE_THEY_STOOD);
  for (const [name, carrying] of [
    ['JPEG', jpegWith({ tiff, packet: A_PACKET })],
    ['PNG', pngWith({ tiff, packet: A_PACKET })],
    ['WebP', webpWith({ tiff, packet: A_PACKET, flags: 0x08 | 0x04 })],
  ]) {
    const said = exif.readXmp(carrying);
    assert.ok(said, `${name}: no packet found`);
    assert.strictEqual(said.readable, true, `${name}: should be readable`);
    assert.strictEqual(said.location, true, `${name}: the packet names a location`);
    assert.strictEqual(said.credit, true, `${name}: the packet names a person`);
  }
  const quiet = exif.readXmp(jpegWith({ packet: A_QUIET_PACKET }));
  assert.deepStrictEqual(quiet, { readable: true, location: false, credit: false });
  assert.strictEqual(exif.readXmp(jpegWith({ tiff })), null, 'a file with no packet has none');
});

check('a compressed packet is a shrug, not a confident answer', () => {
  const said = exif.readXmp(pngWith({ packet: A_PACKET, compressed: true }));
  assert.deepStrictEqual(said, { readable: false, location: false, credit: false });
});

check('asking for one never takes the other, in any of the three', () => {
  const tiff = buildTiff(WHERE_THEY_STOOD);
  const containers = [
    ['JPEG', jpegWith({ tiff, packet: A_PACKET })],
    ['PNG', pngWith({ tiff, packet: A_PACKET })],
    ['WebP', webpWith({ tiff, packet: A_PACKET, flags: 0x08 | 0x04 })],
  ];
  for (const [name, both] of containers) {
    assert.deepStrictEqual(exif.carries(both), { exif: true, xmp: true }, `${name}: the fixture carries both`);

    const cameraGone = exif.strip(both, { exif: true });
    assert.deepStrictEqual(exif.carries(cameraGone), { exif: false, xmp: true },
      `${name}: removing the camera block took the packet with it`);
    assert.ok(exif.readXmp(cameraGone).credit, `${name}: the credit line did not survive`);

    const packetGone = exif.strip(both, { xmp: true });
    assert.deepStrictEqual(exif.carries(packetGone), { exif: true, xmp: false },
      `${name}: removing the packet took the camera block with it`);
    assert.strictEqual(exif.readExif(packetGone).gps_lat, 51.507222, `${name}: the camera block did not survive`);

    const bothGone = exif.strip(both, { exif: true, xmp: true });
    assert.deepStrictEqual(exif.carries(bothGone), { exif: false, xmp: false }, `${name}: something was left`);
    assert.ok(bothGone.includes(Buffer.from('picture')) || name === 'JPEG', `${name}: the picture went with it`);

    assert.strictEqual(exif.strip(both, {}), both, `${name}: asking for neither is not an edit`);
  }
});

check('a WebP header stops advertising whichever chunk went, and no more', () => {
  const tiff = buildTiff(WHERE_THEY_STOOD);
  const both = webpWith({ tiff, packet: A_PACKET, flags: 0x08 | 0x04 | 0x10 });

  const packetGone = exif.strip(both, { xmp: true });
  assert.strictEqual(packetGone[20] & 0x04, 0, 'it still advertises XMP');
  assert.strictEqual(packetGone[20] & 0x08, 0x08, 'it stopped advertising EXIF, which stayed');
  assert.strictEqual(packetGone[20] & 0x10, 0x10, 'it forgot about the alpha channel');
  assert.strictEqual(packetGone.readUInt32LE(4), packetGone.length - 8, 'the total size was not corrected');

  const bothGone = exif.strip(both, { exif: true, xmp: true });
  assert.strictEqual(bothGone[20] & (0x08 | 0x04), 0, 'a bit outlived its chunk');
  assert.strictEqual(bothGone[20] & 0x10, 0x10, 'clearing those disturbed another');
  assert.strictEqual(bothGone.readUInt32LE(4), bothGone.length - 8, 'the total size was not corrected');
});

check('an extended packet is the same packet and answers the same way', () => {
  const extended = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1('http://ns.adobe.com/xmp/extension/\0', A_PACKET),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
  ]);
  assert.ok(exif.readXmp(extended).location);
  assert.deepStrictEqual(exif.carries(exif.strip(extended, { xmp: true })), { exif: false, xmp: false });
});

console.log(`\n${passed} checks passed`);
