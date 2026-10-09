/** Pure URL detection/normalization for hyperlinks (headless, no Electron). Run: node tests/link-url.mjs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const m = await server.ssrLoadModule('/src/model/linkUrl.ts');
  const hit = (s) => { const r = m.urlEndingAt(s); return r && { url: s.slice(r.start, r.end), href: r.href }; };

  // Formats
  assert.deepEqual(hit('https://github.com/Kimtona'), { url: 'https://github.com/Kimtona', href: 'https://github.com/Kimtona' });
  assert.deepEqual(hit('see http://example.org/a?b=1&c=2#d'), { url: 'http://example.org/a?b=1&c=2#d', href: 'http://example.org/a?b=1&c=2#d' });
  assert.deepEqual(hit('go www.example.com/path'), { url: 'www.example.com/path', href: 'https://www.example.com/path' });
  // Trailing punctuation is not part of the URL
  for (const p of ['.', ',', ';', ':', '!', '?', '"', "'", '.)', '),', '."']) {
    const r = hit('https://a.com/x' + p);
    assert.equal(r?.url, 'https://a.com/x', 'trailing ' + p);
  }
  assert.equal(hit('(see https://a.com/x)')?.url, 'https://a.com/x', 'unbalanced closing bracket');
  assert.equal(hit('https://en.wikipedia.org/wiki/Foo_(bar)')?.url, 'https://en.wikipedia.org/wiki/Foo_(bar)', 'balanced parentheses stay');
  assert.equal(hit('(https://en.wikipedia.org/wiki/Foo_(bar)).')?.url, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  // Korean text: only the ASCII URL, and only when the caret is right after it
  assert.equal(hit('깃허브 https://github.com/Kimtona')?.url, 'https://github.com/Kimtona');
  assert.equal(hit('https://github.com/Kimtona를'), null, 'Hangul glued after the URL is ambiguous: no link');
  assert.equal(hit('정연이의 깃허브'), null);
  // Not URLs
  for (const s of ['', 'hello', 'example.com', 'ftp://x.com', 'javascript:alert(1)', 'https://', 'www.', 'a https:// b ']) assert.equal(hit(s), null, JSON.stringify(s));
  // Inline math placeholder before a URL does not break detection
  assert.equal(hit('￼https://a.com')?.url, 'https://a.com');

  // Pasted text
  assert.equal(m.pastedUrl(' https://a.com/x\n'), 'https://a.com/x');
  assert.equal(m.pastedUrl('www.a.com'), 'https://www.a.com');
  assert.equal(m.pastedUrl('see https://a.com'), null);
  assert.equal(m.pastedUrl('https://a.com and more'), null);
  assert.equal(m.pastedUrl('https://a.com.'), null, 'a sentence, not a bare URL');

  // Cmd+K field normalization / safety
  assert.equal(m.toHref('github.com/Kimtona'), 'https://github.com/Kimtona');
  assert.equal(m.toHref('  https://a.com '), 'https://a.com');
  assert.equal(m.toHref('http://localhost:5173/x'), 'http://localhost:5173/x');
  for (const bad of ['', 'hello', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'mailto:a@b.c', 'a b.com', 'https://']) assert.equal(m.toHref(bad), null, JSON.stringify(bad));
  console.log('PASS link URL detection and normalization');
} finally {
  await server.close();
}
