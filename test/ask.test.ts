// "Ask them without spoiling it": the reply link codec (untrusted input), and the guards behind the README's claims about the /ask page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { INSIGHT_TYPES } from '../src/adapters/qloo.ts';
import { parseIdeasInput } from '../src/agent/ideas.ts';
import { cleanText, decodeLoves, encodeLoves, MAX, MAX_FRAGMENT, MAX_TEXT, TYPES } from '../public/loves.js';

type Item = { text: string; type: string };
const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
/** A fragment made by hand, the way a stranger could craft one: "loves=" + base64url of any bytes. */
const raw = (bytes: Uint8Array | string) => 'loves=' + Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');
const json = (v: unknown) => raw(JSON.stringify(v));
const ok = (f: string): Item[] => {
  const r = decodeLoves(f);
  assert.equal(r.ok, true, f.slice(0, 60));
  return r.items;
};

test('round trip: Latin, Hebrew, Japanese and emoji favourites come back exactly, with their type hints', () => {
  const sets: Item[][] = [
    [{ text: 'Nujabes', type: 'artist' }, { text: 'Kafka on the Shore', type: 'book' }, { text: 'Muji', type: '' }],
    [{ text: 'עומר אדם', type: 'artist' }, { text: 'הפועל תל אביב', type: '' }, { text: 'שלום, עולם', type: 'book' }],
    [{ text: '宮崎駿', type: 'person' }, { text: '千と千尋の神隠し', type: 'movie' }, { text: 'ラーメン', type: '' }, { text: '京都', type: 'destination' }],
    [{ text: '🎸 Rock', type: '' }, { text: '👩‍🚀 Space', type: 'tv_show' }, { text: '🇮🇱', type: 'destination' }, { text: 'Zoë café', type: '' }, { text: 'العربية', type: '' }],
  ];
  for (const items of sets) {
    const f = encodeLoves(items);
    assert.match(f, /^loves=[A-Za-z0-9_-]+$/, 'base64url only: no +, / or = padding');
    assert.deepEqual(ok(f), items);
    assert.ok(f.length <= MAX_FRAGMENT);
  }
});

test('the largest answer the page can make still fits under the fragment cap (computed, not assumed)', () => {
  // 3-byte characters are the most expensive per UTF-16 unit; quotes and backslashes grow in JSON, but only to 2 bytes
  const longest = [...TYPES].map(([v]) => v).sort((a, b) => b.length - a.length)[0]!;
  let worst = 0;
  for (const c of ['語', '€', 'ש', '"', '\\', 'é', 'a']) {
    const items = Array.from({ length: MAX }, (_, i) => ({ text: c.repeat(MAX_TEXT - 1) + String.fromCharCode(0x4e00 + i), type: longest }));
    const f = encodeLoves(items);
    worst = Math.max(worst, f.length);
    assert.deepEqual(ok(f), items.map((x) => ({ text: x.text, type: x.type })));
  }
  const astral = Array.from({ length: MAX }, (_, i) => ({ text: '😀'.repeat(39) + String.fromCodePoint(0x1f600 + i + 1), type: longest }));
  worst = Math.max(worst, encodeLoves(astral).length);
  assert.ok(worst <= MAX_FRAGMENT, `worst case ${worst} characters, cap ${MAX_FRAGMENT}`);
  assert.ok(worst > MAX_FRAGMENT / 2, 'the cap is not absurdly loose');
});

test('size limits: at most 5 items, each at most 80 characters after trimming, the whole fragment at most 2048', () => {
  const item = (n: number, i = 0) => ({ text: 'x'.repeat(n - 1) + String(i % 10), type: '' });
  assert.equal(ok(json(Array.from({ length: 5 }, (_, i) => item(80, i)))).length, 5);
  assert.equal(decodeLoves(json(Array.from({ length: 6 }, (_, i) => item(10, i)))).ok, false, 'six items');
  assert.equal(decodeLoves(json([item(81)])).ok, false, '81 characters');
  assert.equal(ok(json([{ text: '   ' + 'y'.repeat(80) + '   ' }]))[0]!.text.length, 80, 'spaces around do not count');
  assert.equal(decodeLoves(json([])).ok, false, 'no items');
  const big = json([{ text: 'a', pad: 'z'.repeat(MAX_FRAGMENT) }]);
  assert.ok(big.length > MAX_FRAGMENT);
  assert.equal(decodeLoves(big).ok, false, 'a fragment over the cap is refused before it is decoded');
  assert.equal(decodeLoves(raw('x'.repeat(5000))).ok, false);
});

test('malformed input is refused whole, and never throws', () => {
  const bad: unknown[] = [
    undefined, null, 42, {}, '', 'loves=', 'loves', 'love=' + Buffer.from('[{"text":"a"}]').toString('base64url'), ' ' + json([{ text: 'a' }]), '#' + json([{ text: 'a' }]),
    'loves=!!!', 'loves=abc def', 'loves=A', 'loves=eyJ0ZXh0IjoiYSJ9==', 'loves=' + 'A'.repeat(10) + '+/',
    raw(new Uint8Array([0xff, 0xfe, 0xfd])), raw('{'), raw('not json'), raw('null'), raw('"loves"'), raw('7'), raw('{"text":"a"}'),
    json(['a', 'b', 'c']), json([null]), json([[]]), json([['a', 'artist']]), json([{}]), json([{ text: 7 }]), json([{ text: null }]), json([{ text: ['a'] }]), json([{ text: '' }]), json([{ text: ' \t\n ' }]),
    json([{ text: 'a', type: null }]), json([{ text: 'a', type: 5 }]), json([{ text: 'a', type: ['book'] }]),
  ];
  for (const f of bad) assert.deepEqual(decodeLoves(f as string), { ok: false }, String(f).slice(0, 50));
});

test('unknown type hints are refused; the known ones (and none) pass', () => {
  for (const type of ['gadget', 'Book', 'BOOK', ' book', 'artist ', '__proto__', 'constructor', 'toString', '<script>', 'x'.repeat(500)]) {
    assert.equal(decodeLoves(json([{ text: 'a', type }])).ok, false, type);
  }
  for (const [type] of TYPES) assert.equal(ok(json([{ text: 'a', type }]))[0]!.type, type);
  assert.equal(ok(json([{ text: 'a' }]))[0]!.type, '', 'no type key means any type');
});

test('the type list matches what the server accepts', () => {
  assert.deepEqual(TYPES.map(([v]) => v).filter(Boolean).sort(), [...INSIGHT_TYPES].sort());
});

test('control characters, bidi marks and lone surrogates are removed; duplicates are refused', () => {
  assert.equal(cleanText('a\u0000b\tc\nd\u007fe\u0085f\u202eg\u2066h\ud800i'), 'a b c d e f g h i');
  assert.equal(ok(json([{ text: '  Nu\u0000ja\u200dbes\r\n ', type: 'artist' }]))[0]!.text, 'Nu ja\u200dbes', 'a control character becomes a space; a zero-width joiner (emoji need it) is kept');
  assert.equal(decodeLoves(json([{ text: '\u0000\u0007\u202e' }])).ok, false, 'nothing left after cleaning');
  assert.equal(decodeLoves(json([{ text: 'Muji' }, { text: ' muji ' }])).ok, false, 'case-insensitive duplicate');
  assert.equal(decodeLoves(json([{ text: 'a\u0000b' }, { text: 'a b' }])).ok, false, 'equal after cleaning');
});

test('a decoded reply is something the server accepts as it is (3 to 5 favourites, the same text and type hints)', () => {
  const items: Item[] = [{ text: 'עומר אדם', type: 'artist' }, { text: '宮崎駿', type: '' }, { text: '🎸 Rock', type: 'brand' }];
  const r = parseIdeasInput({ favorites: ok(encodeLoves(items)), budget_usd: 100 }, { minBudgetCents: 1000, maxBudgetCents: 50000 });
  assert.ok(r.ok);
  assert.deepEqual(r.value.favorites.map((f) => [f.text, f.type ?? '']), items.map((x) => [x.text, x.type]));
});

// ---- the /ask page: what the README says about it ------------------------------------------------------------------------
const askHtml = read('public/ask.html');
const askFiles = ['public/ask.js', 'public/favs.js', 'public/linkrow.js']; // everything that writes words on the /ask page

test('ask.html: language, title, viewport, skip link, landmarks, live region; no inline code; nothing from another origin', () => {
  assert.match(askHtml, /<html lang="en">/);
  assert.match(askHtml, /<title>[^<]{9,}<\/title>/);
  assert.match(askHtml, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(askHtml, /<a class="skip" href="#main">/);
  assert.match(askHtml, /<main id="main" tabindex="-1">/);
  assert.match(askHtml, /<nav [^>]*aria-label="[^"]+"/);
  assert.match(askHtml, /<footer\b/);
  assert.match(askHtml, /role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/);
  assert.match(askHtml, /<noscript>/);
  assert.doesNotMatch(askHtml, /<style\b|\sstyle=|\son[a-z]+=/i);
  assert.deepEqual(askHtml.match(/<script\b[^>]*>/g), ['<script type="module" src="/ask.js">']);
  assert.ok(!/<script\b[^>]*>\s*[^<\s]/.test(askHtml), 'inline script body');
  for (const m of askHtml.matchAll(/\b(?:src|href)="([^"]*)"/g)) assert.match(m[1]!, /^(\/|#)/, `external reference ${m[1]}`);
});

test('ask.html: nothing in the title, description, footer or copy gives the gift away, and no chat preview can', () => {
  assert.doesNotMatch(askHtml, /\bgifts?\b|paypal|sandbox/i);
  for (const f of askFiles) assert.doesNotMatch(read(f), /\bgifts?\b|paypal|sandbox/i, f);
});

test('the /ask page makes no request and keeps nothing: it imports no module that can', () => {
  const allowed = new Set(['./dom.js', './favs.js', './linkrow.js', './loves.js']);
  const files = new Set(['public/ask.js']);
  for (const f of files) {
    for (const m of read(f).matchAll(/\bfrom '(\.\/[^']+)'/g)) {
      assert.ok(allowed.has(m[1]!), `${f} imports ${m[1]}`);
      files.add('public/' + m[1]!.slice(2));
    }
  }
  assert.ok(files.size >= 4);
  for (const f of files) assert.doesNotMatch(read(f), /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|sessionStorage|localStorage|indexedDB|document\.cookie|\.submit\(/, f);
});
