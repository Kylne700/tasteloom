// What a card shows of Qloo's data: the share of the link per favourite, the tags both carry, and the fixed sentences. All data here is invented.
import assert from 'node:assert/strict';
import test from 'node:test';
import { andList, plainReason, sharedReason, sharedTags, sharesOf } from '../src/agent/evidence.ts';
import { parseHits, parseInsights, parseTags, searchEntity } from '../src/adapters/qloo.ts';
import { qlooFake } from '../src/mocks/qloo-fake.ts';
import { sha256Hex } from '../src/lib/util.ts';
import { json, makeNet, makeSvc } from './helpers.ts';

test('sharesOf: whole percents that always add up to 100, in the order given', () => {
  assert.deepEqual(sharesOf([0.62, 0.38]), [62, 38]);
  assert.deepEqual(sharesOf([0.36, 0.35, 0.29]), [36, 35, 29]);
  assert.deepEqual(sharesOf([1, 1, 1]), [34, 33, 33], 'a tie goes to the earlier, stronger one');
  assert.deepEqual(sharesOf([0.5, 0.5]), [50, 50]);
  assert.deepEqual(sharesOf([2, 1]), [67, 33], 'only the ratio counts');
  assert.deepEqual(sharesOf([0.995, 0.005]), [100, 0]);
  assert.deepEqual(sharesOf([]), []);
  assert.deepEqual(sharesOf([0, -1, NaN]), [], 'nothing usable, nothing to show');
  assert.deepEqual(sharesOf([0.7, NaN, 0.3]), [70, 0, 30]);
  let seed = 7; // a small deterministic generator: the sum is 100 whatever the scores are
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let n = 0; n < 500; n++) {
    const scores = Array.from({ length: 2 + (n % 4) }, () => next() + 0.001);
    const r = sharesOf(scores);
    assert.equal(r.reduce((a, b) => a + b, 0), 100, scores.join());
    assert.ok(r.every((x) => Number.isInteger(x) && x >= 0));
  }
});

const tag = (name: unknown, kind: string) => ({ id: 'T-' + String(name), name, type: `urn:tag:${kind}` });

test('parseTags: only the kinds that name a quality, best kind first, no duplicates, clean short text', () => {
  const raw = [
    tag('Loyal', 'audience:qloo'), tag('Guitar', 'instrument:qloo'), tag('Retail', 'business_model:qloo'), tag('Rome', 'wikipedia_category:qloo'), // bookkeeping kinds
    tag('Calm', 'style:qloo'), tag('Jazz', 'genre:music'), tag('jazz', 'keyword:qloo'), tag('Classics', 'genre:media'), tag('Quiet', 'ambience:place'),
    tag('Hop', 'subgenre'), { name: 'No kind' }, { type: 'urn:tag:genre', name: 7 }, 'Jazz', null,
  ];
  assert.deepEqual(parseTags(raw), ['Classics', 'Jazz', 'Hop', 'Calm'], 'genres first, then the subgenre and the style; duplicates (any case) and other kinds are gone');
  assert.deepEqual(parseTags([tag('Mellow', 'theme:qloo'), tag('Jazz', 'genre:qloo')]), ['Jazz', 'Mellow'], 'the order is by kind, not as Qloo listed them');
  assert.deepEqual(parseTags(undefined), []);
  assert.deepEqual(parseTags({ name: 'x' }), []);
});

test('parseTags: a tag name that could carry a link, a price, markup or a whole sentence is dropped', () => {
  const hostile = ['see https://evil.example', 'www.evil.example', 'only $5', '<b>bold</b>', '{"a":1}', 'x'.repeat(41), 'a', '  ', 'Line\nbreak'];
  assert.deepEqual(parseTags(hostile.map((n) => tag(n, 'genre'))), ['Line break'], 'control characters become spaces, the rest is refused');
  assert.equal(parseTags(Array.from({ length: 100 }, (_, i) => tag(`Style ${i}`, 'style'))).length, 40, 'at most 40 per entity');
});

test('sharedTags: what both lists hold, in the first list’s order and spelling, at most four', () => {
  assert.deepEqual(sharedTags(['Jazz', 'Calm', 'Hop'], ['hop', 'JAZZ', 'Loud']), ['Jazz', 'Hop']);
  assert.deepEqual(sharedTags(['A', 'B', 'C', 'D', 'E', 'F'], ['f', 'e', 'd', 'c', 'b', 'a']), ['A', 'B', 'C', 'D']);
  assert.deepEqual(sharedTags(['A'], ['B']), []);
  assert.deepEqual(sharedTags(undefined, ['B']), []);
  assert.deepEqual(sharedTags(['A'], undefined), []);
});

test('the two fixed sentences say only what Qloo’s data gives', () => {
  assert.equal(andList([]), '');
  assert.equal(andList(['a']), 'a');
  assert.equal(andList(['a', 'b']), 'a and b');
  assert.equal(andList(['a', 'b', 'c']), 'a, b and c');
  assert.equal(plainReason('Nujabes', 'Oia'), 'Qloo links Nujabes to Oia.');
  assert.equal(sharedReason('Nujabes', 'Oia', ['Calm', 'Jazz']), 'Qloo tags both Nujabes and Oia as Calm and Jazz.');
});

test('qloo: search hits and insight entities carry their tags, apart from the seed; none when there are none', () => {
  const hit = { entity_id: 'E1', name: 'Nujabes', types: ['urn:entity:artist'], tags: [tag('Jazz', 'genre:music'), tag('Loyal', 'audience:qloo')] };
  assert.deepEqual(parseHits({ results: [hit] }, 'artist'), [{ seed: { id: 'E1', name: 'Nujabes', type: 'artist' }, tags: ['Jazz'] }]);
  assert.deepEqual(parseHits({ results: [{ entity_id: 'E2', name: 'Bare', types: ['urn:entity:brand'] }] })[0]!.tags, []);
  const seeds = [{ id: 'S1', name: 'Nujabes', type: 'artist' }];
  const [a, b] = parseInsights({ results: { entities: [{ entity_id: 'B1', name: 'Hario', subtype: 'urn:entity:brand', tags: [tag('Jazz', 'genre:music')], query: { explainability: { S1: 0.7 } } }, { entity_id: 'B2', name: 'Plain', subtype: 'urn:entity:brand' }] } }, seeds, 'brand');
  assert.deepEqual(a!.tags, ['Jazz']);
  assert.equal('tags' in b!, false, 'no empty tags array on a candidate that has none');
});

test('qloo: searchEntity hands the tags of the first hit to the caller, and an answer cached before tags existed is not served', async () => {
  const { svc } = await makeSvc({ QLOO_API_KEY: 'qloo-test-key', DEV_CACHE: '1' }, makeNet());
  let live = 0;
  svc.fetch = async () => (live++, json({ results: [{ entity_id: 'E1', name: 'Nujabes', types: ['urn:entity:artist'], tags: [tag('Jazz', 'genre:music')] }, { entity_id: 'E2', name: 'Other', types: ['urn:entity:artist'], tags: [tag('Rock', 'genre')] }] }));
  const params = new URLSearchParams({ query: 'Nujabes', take: '3', types: 'urn:entity:artist' }).toString();
  const oldKey = `c:qloo:${(await sha256Hex(JSON.stringify({ search: params }))).slice(0, 32)}`;
  await svc.store.put(oldKey, JSON.stringify({ v: { seeds: [{ id: 'STALE', name: 'Nujabes', type: 'artist' }], via: 'live' } }), 3600);
  const r = await searchEntity(svc, { query: 'Nujabes', type: 'artist' });
  assert.deepEqual([r.seed?.id, r.tags, live], ['E1', ['Jazz'], 1], 'the old entry (no tags) is left alone and the answer comes from the service');
  const again = await searchEntity(svc, { query: 'Nujabes', type: 'artist' });
  assert.deepEqual([again.seed?.id, again.tags, again.via, live], ['E1', ['Jazz'], 'cache', 1], 'the new entry keeps the tags');
});

test('qloo fake: invented tags in Qloo’s shape, the same on both endpoints, so the real parser reads them', async () => {
  const s = (await (await qlooFake('https://hackathon.api.qloo.com/search?query=Nujabes&types=urn:entity:artist')).json()) as { results: { entity_id: string; tags: { id: string; name: string; type: string }[] }[] };
  assert.ok(s.results[0]!.tags.length >= 2 && s.results[0]!.tags.every((t) => t.id && t.name && t.type.startsWith('urn:tag:')));
  const i = (await (await qlooFake(`https://hackathon.api.qloo.com/v2/insights?filter.type=urn:entity:destination&signal.interests.entities=${s.results[0]!.entity_id}&feature.explainability=true&take=8`)).json()) as { results: { entities: { name: string; tags: { name: string }[] }[] } };
  const seedTags = new Set(s.results[0]!.tags.map((t) => t.name));
  const kyoto = i.results.entities.find((e) => e.name === 'Kyoto')!;
  assert.ok(kyoto.tags.some((t) => seedTags.has(t.name)), 'Nujabes and Kyoto are both about Japan and calm in the demo data');
});
