'use strict';

// What a hosting company is allowed to say about themselves, and what happens to
// it on the way out. Short, because what branding does to a page, a mail header
// and a stylesheet is proved over HTTP in the release audit; this is the shape of
// each value, checked directly, so a refusal cannot quietly become an acceptance.

const assert = require('assert');
const brand = require('./brand');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const refuses = input => assert.throws(() => brand.readable(input));

check('a name is one line of printable text, whatever arrives', () => {
  assert.strictEqual(brand.line('  Acme Files  ', 80), 'Acme Files');
  // The one that matters: a newline in a name is a second mail header.
  assert.ok(!brand.line(`Acme${String.fromCharCode(13, 10)}Bcc: someone@example.test`, 80).includes(String.fromCharCode(10)));
  assert.ok(!brand.printable(String.fromCharCode(0, 7, 27, 127)).length);
  assert.strictEqual(brand.line('x'.repeat(500), brand.NAME_MAX).length, brand.NAME_MAX);
});

check('an accent is a colour, and nothing that could be a second declaration', () => {
  assert.strictEqual(brand.readable({ accent: '#2f6f4f' }).accent, '#2f6f4f');
  assert.strictEqual(brand.readable({ accent: '#abc' }).accent, '#abc');
  assert.strictEqual(brand.readable({ accent: '' }).accent, '');
  refuses({ accent: 'red; } body { display: none' });
  refuses({ accent: 'url(https://elsewhere.example/beacon)' });
  refuses({ accent: 'rebeccapurple' });
});

check('a support address is somewhere to get help, never script', () => {
  assert.strictEqual(brand.readable({ supportUrl: 'https://help.example.test' }).supportUrl, 'https://help.example.test');
  assert.strictEqual(brand.readable({ supportUrl: 'mailto:help@example.test' }).supportUrl, 'mailto:help@example.test');
  refuses({ supportUrl: 'javascript:alert(1)' });
  refuses({ supportUrl: 'data:text/html,<script>alert(1)</script>' });
  refuses({ supportUrl: 'not a url at all' });
});

check('a name reaching the page is escaped, so it cannot be markup', () => {
  assert.strictEqual(brand.escapeHtml('</title><script>alert(1)</script>'),
    '&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(!brand.escapeHtml('a "quoted" name').includes('"'));
});

check('the script the shell is handed cannot be escaped from', () => {
  const written = brand.bootstrap({ name: '</script><script>alert(1)</script>' });
  assert.ok(!written.includes('</script>'));
  assert.ok(written.startsWith('window.__BRAND__ = {'));
  // And it is still JavaScript that produces the name it was given.
  const global = {};
  // eslint-disable-next-line no-new-func
  new Function('window', written)(global);
  assert.strictEqual(global.__BRAND__.name, '</script><script>alert(1)</script>');
});

check('what kind of image this is comes from the bytes, not from the claim', () => {
  assert.strictEqual(brand.imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  assert.strictEqual(brand.imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.strictEqual(brand.imageType(Buffer.from('GIF89a-----')), 'image/gif');
  assert.strictEqual(brand.imageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.strictEqual(brand.imageType(Buffer.from([0, 0, 1, 0, 1, 0])), 'image/x-icon');
  // An SVG is a document with script in it, and this box serves brand assets
  // from the origin that holds the session token.
  assert.strictEqual(brand.imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.strictEqual(brand.imageType(Buffer.from('just some text')), null);
  assert.strictEqual(brand.imageType(Buffer.alloc(0)), null);
  assert.strictEqual(brand.imageType('not bytes at all'), null);
});

check('an unbranded box says nothing about anybody', () => {
  const nothing = brand.shown(null);
  assert.strictEqual(nothing.name, '');
  assert.strictEqual(nothing.logo, null);
  assert.strictEqual(nothing.icon, null);
  assert.strictEqual(nothing.configured, false);
  // Both of our words, not just the product one: `jotnotes` is the name a
  // hosting company's customer must never be shown.
  const said = JSON.stringify(nothing).toLowerCase();
  for (const ours of ['jdrive', 'jotnotes', 'pocketdrive']) assert.ok(!said.includes(ours), ours);
});

check('a changed brand changes the address of its assets', () => {
  const before = brand.shown({ name: 'Acme', updated_at: '2026-09-02 10:00:00', logo_len: 400 });
  const after = brand.shown({ name: 'Acme', updated_at: '2026-09-02 11:00:00', logo_len: 900 });
  assert.notStrictEqual(before.logo, after.logo);
  assert.ok(before.logo.startsWith('/brand/logo?v='));
  assert.strictEqual(before.configured, true);
});

check('wallpaper is a box asset with a hundred times the logo budget', () => {
  assert.ok(brand.KINDS.includes('wallpaper'));
  assert.strictEqual(brand.LIMITS.wallpaper, brand.LIMITS.logo * 100);
  assert.strictEqual(brand.shown(null).wallpaper, null);
  const first = brand.shown({ wallpaper_len: 100, updated_at: '2026-09-08 10:00:00.001' });
  const replacement = brand.shown({ wallpaper_len: 100, updated_at: '2026-09-08 10:00:00.002' });
  assert.ok(first.wallpaper.startsWith('/brand/wallpaper?v='));
  assert.notStrictEqual(first.wallpaper, replacement.wallpaper);
  assert.notStrictEqual(first.version, brand.shown({ wallpaper_len: 101, updated_at: '2026-09-08 10:00:00.001' }).version);
});

console.log(`\n${passed} checks passed`);
