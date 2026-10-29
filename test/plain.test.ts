// "Compare: same AI, no Qloo": the plain prompt, the reply parser, the "names a favourite" rule (the cases of the measured comparison it comes from,
// scratch/why-us/proof/m1.test.mjs) and POST /api/plain: one model call, the same input checks and caps as a run, nothing else called or stored.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMIT_MESSAGE } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { names, namesAny, needles, norm, parseGifts, plainPrompt, type Fav } from '../src/agent/plain.ts';
import type { Env } from '../src/types.ts';
import { chatBody, fakeAi, makeHarness } from './helpers.ts';

const f = (name: string, kind?: string): Fav => ({ name, kind });

test('plain M1 rule: matches', () => {
  assert.ok(names('Radiohead vinyl box set', f('Radiohead', 'group')));
  assert.ok(names('RADIOHEAD tour poster', f('Radiohead', 'group')));
  assert.ok(names('Miles Davis tribute poster', f('Miles Davis', 'person')));
  assert.ok(names('Davis signature trumpet mute', f('Miles Davis', 'person')), 'last name alone counts for people');
  assert.ok(names('Bjork - Vespertine LP', f('Björk', 'person')), 'accent-insensitive, plain text');
  assert.ok(names('Björk tote bag', f('Bjork', 'person')), 'accent-insensitive, other direction');
  assert.ok(names('BEYONCE tour hoodie', f('Beyoncé', 'person')));
  assert.ok(names('Beatles Abbey Road poster', f('The Beatles', 'group')), 'leading "the" is optional');
  assert.ok(names('The Beatles Anthology book', f('The Beatles', 'group')));
  assert.ok(names('Hobbit hole door replica', f('The Hobbit', 'title')));
  assert.ok(names('The Hobbit illustrated edition', f('The Hobbit', 'title')));
  assert.ok(names('Dune Spice Melange mug', f('Dune', 'title')));
  assert.ok(names('Pans Labyrinth art print', f("Pan's Labyrinth", 'title')), 'apostrophe dropped');
  assert.ok(names('Pan’s Labyrinth art print', f("Pan's Labyrinth", 'title')), 'curly apostrophe');
  assert.ok(names('Simon and Garfunkel box set', f('Simon & Garfunkel', 'group')), '& = and');
  assert.ok(names('Mug with a Kyoto skyline', f('Kyoto', 'place')));
  assert.ok(names('A. R. Rahman live album', f('A. R. Rahman', 'person')));
  assert.ok(names('Rahman concert ticket', f('A. R. Rahman', 'person')), 'last name of a person');
  assert.ok(names('Kuti Afrobeat vinyl', f('Fela Kuti', 'person')), 'a 4-letter last name counts');
});

test('plain M1 rule: non-matches', () => {
  assert.ok(!names('Davison guitar strap', f('Miles Davis', 'person')), 'whole words only');
  assert.ok(!names('Kind of Blue LP', f('Miles Davis', 'person')), 'known limit: albums are not detected');
  assert.ok(!names('Sand dunes photo print', f('Dune', 'title')), 'Dunes is not Dune');
  assert.ok(!names('Legolas figurine', f('Lego', 'brand')));
  assert.ok(!names('Li Ning running shoes', f('Jay Li', 'person')), 'a last name under 4 letters is not used alone');
  assert.ok(!names('Floyd Mayweather boxing gloves', f('Pink Floyd', 'group')), 'a group has no last-name needle');
  assert.ok(!names('Bunny slippers', f('Bad Bunny', 'group')));
  assert.ok(!names('', f('Kyoto', 'place')));
  assert.ok(!names('寿司セット', f('東京')) && !names('', f('東京')), 'a name with no Latin letter or digit has no needle, so it never matches');
});

test('plain M1 helpers', () => {
  assert.equal(norm('Chef’s Table & Co.'), 'chefs table and co');
  assert.deepEqual(needles(f('The Beatles', 'group')).sort(), ['beatles', 'the beatles']);
  assert.deepEqual(needles(f('Ludwig van Beethoven', 'person')).sort(), ['beethoven', 'ludwig van beethoven']);
  assert.ok(namesAny('a Nirvana shirt', [f('Kyoto', 'place'), f('Nirvana', 'group')]));
});

test('plain parser: the first JSON array of ideas, four at most, whatever surrounds it', () => {
  const one = '[{"gift":"Vinyl","reason":"a"},{"gift":"Mug","reason":"b"}]';
  assert.deepEqual(parseGifts(one).map((x) => x.gift), ['Vinyl', 'Mug']);
  assert.equal(parseGifts('<think>[{"gift":"no"}]</think>\n\n' + one).length, 2, 'thinking text is dropped');
  assert.equal(parseGifts('```json\n' + one + '\n```').length, 2, 'code fence');
  assert.equal(parseGifts('Here: ' + one + ' Enjoy [1].').length, 2, 'text around');
  const five = '[' + Array.from({ length: 5 }, (_, i) => `{"gift":"g${i}","reason":"r"}`).join(',') + ']';
  assert.equal(parseGifts(five).length, 4, 'first 4 only');
  assert.equal(parseGifts('[{"gift":"a","reason":"has ] and [ inside"}]').length, 1, 'brackets inside strings');
  assert.deepEqual(parseGifts('no json here'), []);
  assert.deepEqual(parseGifts('[{"gift":"a", broken'), []);
  assert.deepEqual(parseGifts('[{"gift":""},{"nogift":1}]'), [], 'empty gifts do not count');
  assert.deepEqual(parseGifts('[{"gift":"  Mug  ","reason":null}]'), [{ gift: 'Mug', reason: '' }], 'trimmed, a missing reason is empty');
});

// ---- the prompt ---------------------------------------------------------------------------------------------------------

const PLAIN =
  'I need gift ideas for someone. They love: {F}. My budget per gift is {B}. Suggest 4 different gift ideas. Reply with JSON only, no other text: [{"gift": "<the item itself>", "reason": "<why they would like it>"}]';
const promptFor = (favs: string, budget: string) => PLAIN.replace('{F}', () => favs).replace('{B}', () => budget);

test('plain prompt: the measured comparison’s plain-arm text, with the typed favourites (labelled by type) and the budget', () => {
  const favorites = [{ text: 'Miles Davis', type: 'person' }, { text: 'Kyoto', type: 'destination' }, { text: 'Muji' }];
  assert.equal(plainPrompt({ favorites, budget_cents: 5000 }), promptFor('Miles Davis (person), Kyoto (place), Muji', '$50'));
  assert.equal(plainPrompt({ favorites, budget_cents: 4999 }), promptFor('Miles Davis (person), Kyoto (place), Muji', '$49.99'));
  assert.equal(plainPrompt({ favorites: [{ text: 'Dune', type: 'movie' }, { text: 'Nujabes', type: 'artist' }, { text: 'Alien', type: 'tv_show' }], budget_cents: 12050 }), promptFor('Dune (film), Nujabes (artist), Alien (TV show)', '$120.50'));
});

test('plain prompt: a typed name is text, never a slot or a replacement pattern', () => {
  const p = plainPrompt({ favorites: [{ text: '${budget}' }, { text: 'AC/DC $& $1 $`' }, { text: '{favorites}' }], budget_cents: 5000 });
  assert.equal(p, promptFor('${budget}, AC/DC $& $1 $`, {favorites}', '$50'));
});

// ---- the route ----------------------------------------------------------------------------------------------------------

const env = (e: Record<string, unknown>) => e as Partial<Env>;
const BODY = { favorites: [{ text: 'Miles Davis', type: 'person' }, { text: 'Kyoto', type: 'destination' }, { text: 'Muji' }], budget_usd: 50 };
const post = (h: ReturnType<typeof makeHarness>, body: unknown = BODY, ip?: string) =>
  h.req('/api/plain', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) }, body: JSON.stringify(body) });
const answer = (...gifts: string[]) => chatBody({ content: '```json\n' + JSON.stringify(gifts.map((gift) => ({ gift, reason: ' because ' }))) + '\n```\nEnjoy!' }, 'stop', 3);

test('plain: one call to the model Tasteloom writes with, the plain prompt and nothing else; the ideas that name a favourite are tagged', async () => {
  const ai = fakeAi(() => answer('Miles Davis tribute poster', 'Scented candle set', 'Kyoto tea set', 'Cosy throw blanket', 'Fifth idea is dropped'));
  const h = makeHarness(env({ AI: ai, QLOO_API_KEY: 'q-test' }));
  const res = await post(h);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ideas: [
      { gift: 'Miles Davis tribute poster', reason: 'because', named: true },
      { gift: 'Scented candle set', reason: 'because', named: false },
      { gift: 'Kyoto tea set', reason: 'because', named: true },
      { gift: 'Cosy throw blanket', reason: 'because', named: false },
    ],
    mock: false,
  });
  assert.equal(ai.runs.length, 1);
  const run = ai.runs[0]!;
  assert.equal(run.model, loadConfig(h.env).models.writer);
  assert.deepEqual(run.input.messages, [
    { role: 'system', content: 'You are a helpful assistant.\n/no_think' },
    { role: 'user', content: promptFor('Miles Davis (person), Kyoto (place), Muji', '$50') },
  ]);
  assert.deepEqual([run.input.temperature, run.input.max_tokens, run.input.tools], [0.2, 1500, undefined]);
  assert.equal(h.net.calls.length, 0, 'no Qloo, shop or web call, although a Qloo key is set');
  assert.equal(h.kv._m.size, 0, 'nothing is stored');
});

test('plain: the last-name needle needs the type "person"; typed as anything else only the full name counts (fewer tags, never more)', async () => {
  const ai = fakeAi(() => answer('Davis signature trumpet mute'));
  const h = makeHarness(env({ AI: ai }));
  const tag = async (type: string) => ((await (await post(h, { favorites: [{ text: 'Miles Davis', type }, { text: 'Kyoto' }, { text: 'Muji' }], budget_usd: 50 })).json()) as any).ideas[0].named;
  assert.equal(await tag('person'), true);
  assert.equal(await tag('artist'), false);
});

test('plain: the input is checked like a run (3 to 5 favourites, a budget in range, JSON) and a refused request costs no call and no count', async () => {
  const ai = fakeAi(() => answer('Scented candle set'));
  const h = makeHarness(env({ AI: ai, LIMIT_IP_PLAIN: '1' }));
  for (const body of [{ favorites: BODY.favorites.slice(0, 2), budget_usd: 50 }, { ...BODY, budget_usd: 5 }, { ...BODY, budget_usd: 1e6 }, { budget_usd: 50 }, { favorites: 'x', budget_usd: 50 }]) {
    const res = await post(h, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(((await res.json()) as any).error.code, 'bad_input');
  }
  assert.equal((await h.req('/api/plain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
  assert.equal((await h.req('/api/plain', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(BODY) })).status, 415);
  assert.equal(ai.runs.length, 0);
  assert.equal((await post(h)).status, 200, 'the one allowed call is still there');
  assert.equal(ai.runs.length, 1);
});

test('plain: a per-visitor cap (8 by default) and a daily cap for everyone (40) answer 429 before any model call', async () => {
  assert.deepEqual([loadConfig({} as Env).limits.ip.plain, loadConfig({} as Env).limits.global.plain], [8, 40]);
  const ai = fakeAi(() => answer('Scented candle set'));
  const h = makeHarness(env({ AI: ai, LIMIT_IP_PLAIN: '2', LIMIT_GLOBAL_PLAIN: '3' }));
  for (let i = 0; i < 2; i++) assert.equal((await post(h, BODY, '203.0.113.1')).status, 200);
  const mine = await post(h, BODY, '203.0.113.1');
  assert.equal(mine.status, 429);
  assert.deepEqual(((await mine.json()) as any).error, { code: 'limit', message: LIMIT_MESSAGE.ip });
  assert.equal((await post(h, BODY, '203.0.113.2')).status, 200, 'another visitor is not affected until the global cap');
  const all = await post(h, BODY, '203.0.113.3');
  assert.equal(all.status, 429);
  assert.deepEqual(((await all.json()) as any).error, { code: 'limit', message: LIMIT_MESSAGE.global });
  assert.equal(ai.runs.length, 3, 'only the allowed clicks reached the model');
  const usage = ((await (await h.req('/api/status')).json()) as any).usage;
  assert.equal(usage.plain, 3);
});

test('plain: the model’s own daily caps still apply on top (a spent AI allowance answers 429, no call)', async () => {
  const ai = fakeAi(() => answer('Scented candle set'));
  const h = makeHarness(env({ AI: ai, LIMIT_IP_AI: '0' }));
  const res = await post(h);
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as any).error.code, 'limit');
  assert.equal(ai.runs.length, 0);
});

test('plain: an answer with no readable idea is an upstream failure, shown without the model’s text, and is not asked again', async () => {
  const ai = fakeAi(() => chatBody({ content: 'Sorry, I cannot help with Miles Davis.' }));
  const h = makeHarness(env({ AI: ai }));
  const res = await post(h);
  assert.equal(res.status, 502);
  const text = JSON.stringify(await res.json());
  assert.match(text, /"code":"upstream"/);
  assert.doesNotMatch(text, /Miles Davis|Sorry/);
  assert.equal(ai.runs.length, 1);
});

test('plain: with no AI binding the built-in stand-in answers (marked as demo data), two ideas name a favourite, and no billed service is called', async () => {
  const h = makeHarness(env({ QLOO_API_KEY: 'q-test' }));
  const res = await post(h);
  assert.equal(res.status, 200);
  const out = (await res.json()) as { ideas: { gift: string; named: boolean }[]; mock: boolean };
  assert.equal(out.mock, true);
  assert.equal(out.ideas.length, 4);
  assert.deepEqual(out.ideas.map((i) => i.named), [true, true, false, false]);
  assert.match(out.ideas[0]!.gift, /Miles Davis/);
  assert.match(out.ideas[1]!.gift, /Kyoto/);
  assert.equal(h.net.calls.length, 0);
});

test('plain: what the visitor typed is not stored and not in the public status', async () => {
  const ai = fakeAi(() => answer('Scented candle set'));
  const h = makeHarness(env({ AI: ai }));
  await post(h);
  assert.equal(h.kv._m.size, 0);
  assert.doesNotMatch(await (await h.req('/api/status')).text(), /Miles Davis|Kyoto|Muji/);
});
