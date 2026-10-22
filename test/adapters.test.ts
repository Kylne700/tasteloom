// Adapters parse documentation-shaped fixtures (synthetic data, no real catalog or person) and send the documented requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChannel3, searchProducts } from '../src/adapters/channel3.ts';
import { chat, parseChat } from '../src/adapters/ai.ts';
import { humanPayPalError, parseOrder, validOrderId } from '../src/adapters/paypal.ts';
import { GIFT_TYPES, INSIGHT_TYPES, insights, parseExplainability, parseInsights, parseSearch, searchEntity } from '../src/adapters/qloo.ts';
import { qlooFake } from '../src/mocks/qloo-fake.ts';
import { blurb, cleanSnippet, cleanTitle, experienceCards, extractUsdPrices, parseTavily, priceCheck } from '../src/adapters/tavily.ts';
import { HttpError, callJson, BudgetError } from '../src/lib/http.ts';
import { LimitError } from '../src/lib/limits.ts';
import { clip, httpsUrl, redact, toCents } from '../src/lib/util.ts';
import type { Card, Seed } from '../src/types.ts';
import { chatBody, chatReply, fakeAi, json, makeNet, makeSvc, toolCall } from './helpers.ts';

// ---- Channel3 ------------------------------------------------------------------------------------------------------

const offer = (price: unknown, extra: Record<string, unknown> = {}) => ({ url: 'https://www.Shop-A.example/p/1', domain: 'www.Shop-A.example', price: { price, currency: 'USD' }, availability: 'InStock', condition: 'new', ...extra });
const product = (id: string, title: string, offers: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  title,
  brands: [{ name: 'Acme' }],
  images: [{ url: 'https://img.example/side.jpg', is_main_image: false }, { url: 'https://img.example/main.jpg', is_main_image: true }],
  offers,
  ...extra,
});

test('channel3: picks the cheapest in-stock, new, USD offer under the cap and reports integer cents', () => {
  const cards = parseChannel3(
    { products: [product('1', 'Acme Kettle', [offer(49.99, { domain: 'a.example' }), offer(12.5, { domain: 'www.B.example', url: 'https://www.b.example/k' }), offer(80), offer(9.99, { price: { price: 9.99, currency: 'EUR' } }), offer(8, { availability: 'OutOfStock' }), offer(7, { condition: 'used' }), offer(6, { url: 'http://insecure.example/x' })])] },
    'i1',
    5000,
  );
  assert.equal(cards.length, 1);
  assert.deepEqual([cards[0]!.price_cents, cards[0]!.shop, cards[0]!.url, cards[0]!.image, cards[0]!.purchasable, cards[0]!.source, cards[0]!.ideaId], [1250, 'b.example', 'https://www.b.example/k', 'https://img.example/main.jpg', true, 'channel3', 'i1']);
  assert.match(cards[0]!.id, /^p[0-9a-f]{8}$/);
});

test('channel3: the docs example uses price.amount; both shapes are read', () => {
  const [c] = parseChannel3({ products: [product('2', 'Acme Mug', [{ url: 'https://shop.example/m', price: { amount: '19.99', currency: 'USD' } }])] }, 'i', 0);
  assert.equal(c!.price_cents, 1999);
  assert.equal(c!.shop, 'shop.example');
});

test('channel3: drops products with no usable offer, no title or an unreadable shape', () => {
  assert.deepEqual(parseChannel3({ products: [product('3', 'No offers', []), product('4', ' ', [offer(5)]), product('5', 'Too dear', [offer(500)]), null, 'x', { title: 7 }] }, 'i', 1000), []);
  for (const junk of [null, undefined, {}, [], 'text', { products: 'x' }, { products: {} }]) assert.deepEqual(parseChannel3(junk, 'i', 1000), []);
});

test('channel3: at most two cards per shop and the limit is respected', () => {
  const same = Array.from({ length: 5 }, (_, i) => product('s' + i, 'Acme thing ' + i, [offer(10 + i)]));
  assert.equal(parseChannel3({ products: same }, 'i', 0).length, 2);
  const varied = Array.from({ length: 5 }, (_, i) => product('v' + i, 'Acme thing ' + i, [offer(10 + i, { domain: `shop${i}.example`, url: `https://shop${i}.example/p` })]));
  assert.equal(parseChannel3({ products: varied }, 'i', 0, 3).length, 3);
});

test('channel3: the relevance gate needs every distinctive word of the entity name, as whole words (plural allowed)', () => {
  const at = (id: string, title: string) => product(id, title, [offer(9, { domain: `${id}.example`, url: `https://${id}.example/p` })], { brands: [] });
  const list = { products: [at('a', 'Norwegian Wood Paperback'), at('b', 'Firewood Bundle Norwegian'), at('c', 'Norwegian Rug'), at('d', 'Wood Norwegians Poster'), at('e', 'Norwegian-Wood Vinyl')] };
  const titles = (g: Parameters<typeof parseChannel3>[4]) => parseChannel3(list, 'i', 0, 8, g).map((c) => c.title);
  assert.deepEqual(titles({ entity: 'Norwegian Wood' }), ['Norwegian Wood Paperback', 'Wood Norwegians Poster', 'Norwegian-Wood Vinyl']);
  assert.equal(titles(undefined).length, 5, 'without a gate nothing is filtered');
  // brand names count too
  assert.equal(parseChannel3({ products: [product('f', 'Notebook', [offer(10)])] }, 'i', 0, 8, { entity: 'Acme' }).length, 1);
});

test('channel3: the category gate keeps only the wanted catalog category', () => {
  const books = product('b1', 'Kafka Novel', [offer(10, { domain: 'a.example', url: 'https://a.example/1' })], { category: { slug: 'books', path: [{ slug: 'media' }, { slug: 'books' }] }, brands: [] });
  const wood = product('b2', 'Kafka Shelf', [offer(10, { domain: 'b.example', url: 'https://b.example/2' })], { category: { slug: 'furniture', path: [{ slug: 'home' }] }, brands: [] });
  const none = product('b3', 'Kafka Mystery', [offer(10, { domain: 'c.example', url: 'https://c.example/3' })], { brands: [] });
  assert.deepEqual(parseChannel3({ products: [books, wood, none] }, 'i', 0, 8, { entity: 'Kafka', category: 'books|literature' }).map((c) => c.title), ['Kafka Novel']);
});

test('channel3: for a brand entity a listed brand must match, so a book titled "Aesop\'s Fables" is not an Aesop product', () => {
  const at = (id: string, title: string, brands: string[]) => product(id, title, [offer(9, { domain: `${id}.example`, url: `https://${id}.example/p` })], { brands: brands.map((name) => ({ name })) });
  const list = { products: [at('a', "Aesop's Fables", ['Barnes & Noble']), at('b', 'AESOP Conditioner (100ml)', ['Aesop']), at('c', 'Aesop Mouthwash', []), at('d', 'Conditioner', ['Aesop']), at('e', 'Fables of Aesop', ['Dover Publications'])] };
  const titles = (brand: boolean) => parseChannel3(list, 'i', 0, 8, { entity: 'Aesop', brand }).map((c) => c.title);
  assert.deepEqual(titles(true), ['AESOP Conditioner (100ml)', 'Aesop Mouthwash', 'Conditioner']);
  assert.equal(titles(false).length, 5, 'other entity types keep the title-or-brand rule');
});

test('channel3: searchProducts sends the documented request, caches for 12 h and stamps the idea id', async () => {
  const { svc, net } = await makeSvc();
  const a = await searchProducts(svc, { query: 'Muji notebook', ideaId: 'i1', maxPriceCents: 4000, limit: 3 });
  const b = await searchProducts(svc, { query: 'muji notebook', ideaId: 'i9', maxPriceCents: 4000, limit: 3 });
  assert.equal(net.count('api.trychannel3.com'), 1, 'the second identical search is a cache hit');
  assert.equal(a.hit, false);
  assert.equal(b.hit, true);
  assert.ok(a.cards.length > 0 && a.cards.every((c) => c.ideaId === 'i1' && c.price_cents <= 4000));
  assert.ok(b.cards.every((c) => c.ideaId === 'i9'));
  const call = net.calls[0]!;
  assert.deepEqual([call.method, call.path, call.headers['x-api-key']], ['POST', '/v1/search', 'c3-test']);
  assert.deepEqual(call.body.filters, { price: { max_price: 40 } });
  assert.equal((await svc.meter.used()).global.channel3, 1);
});

test('channel3: with no key the adapter is off and spends nothing', async () => {
  const { svc, net } = await makeSvc({ CHANNEL3_API_KEY: '' });
  assert.deepEqual(await searchProducts(svc, { query: 'x', ideaId: 'i', maxPriceCents: 1000 }), { cards: [], hit: false });
  assert.equal(net.calls.length, 0);
});

// ---- Tavily --------------------------------------------------------------------------------------------------------

test('tavily: parseTavily keeps only https results with a title and bounds the text', () => {
  const r = parseTavily({ results: [{ title: 'A page', url: 'https://a.example/x', content: 'c'.repeat(900), raw_content: 'r'.repeat(9000) }, { title: 'Plain http', url: 'http://b.example' }, { url: 'https://c.example' }, { title: 'No url' }, null, 7] });
  assert.equal(r.length, 1);
  assert.ok(r[0]!.content.length <= 300 && r[0]!.raw!.length === 6000);
  assert.deepEqual(parseTavily({ results: 'x' }), []);
  assert.deepEqual(parseTavily(undefined), []);
});

test('tavily: snippets lose markdown, links and images', () => {
  assert.equal(cleanSnippet('# Title ![img](https://i.example/a.png) Visit [our site](https://x.example) now: https://y.example/z **bold** `code` | cell'), 'Title Visit our site now: bold code cell'.replace(/ +/g, ' '));
  assert.ok(cleanSnippet('word '.repeat(100), 50).length <= 50);
});

test('tavily: experience titles lose site names and promo parts, blurbs keep whole sentences about the place', () => {
  assert.equal(cleanTitle('Kew Gardens Tickets 2026 | Book Now', 'kewgardenslondon.com'), 'Kew Gardens Tickets 2026');
  assert.equal(cleanTitle('Gift Tickets & Bundles | Kew Gardens Experience Gifts | The Kew Shop', 'shop.kew.org'), 'Gift Tickets & Bundles · Kew Gardens Experience Gifts');
  assert.equal(cleanTitle('Kew Gardens, London | Gift Tours, Tickets & Excursions (2026) - Tinggly', 'tinggly.com'), 'Kew Gardens, London · Gift Tours, Tickets & Excursions (2026)');
  assert.equal(cleanTitle('Tinggly', 'tinggly.com'), 'Tinggly', 'a title that is only the site name is kept, not emptied');
  assert.equal(cleanTitle('Well-known pre-wrapped gift', 'shop.example'), 'Well-known pre-wrapped gift', 'hyphens inside words are not separators');
  const need = ['kew', 'gardens'];
  const [page] = parseTavily({ results: [{ title: 't', url: 'https://x.example/', content: '# Gift tickets\n\nTreat someone to a day out at Kew. From shows to exhibitions to flexible ticket…' }] });
  assert.equal(page!.content.startsWith('Gift tickets. Treat'), true, 'a heading becomes its own sentence');
  assert.equal(blurb(page!.content, need), 'Treat someone to a day out at Kew.');
  assert.equal(blurb('Small-group London walking tour. A 3 hour cooking class for 2-6 people.', need), '', 'no sentence names the place: no blurb');
  assert.ok(blurb('Kew Gardens ' + 'x'.repeat(300), need, 80).length <= 80);
});

test('tavily: USD amounts become unique integer cents', () => {
  assert.deepEqual(extractUsdPrices('From $12, was $ 15.50, now $1,299.00 or $12 again; €5, 40 dollars, $0, $99999999'), [1200, 1550, 129900]);
  assert.deepEqual(extractUsdPrices('no prices here'), []);
});

test('tavily: experienceCards makes link-only cards about the place and never a purchasable one', async () => {
  const net = makeNet();
  net.intercept = (path, init) =>
    path === '/search'
      ? json({
          results: [
            { title: 'Kew Gardens tickets and tours', url: 'https://www.tours.example/kew', content: 'Kew Gardens day entry. From $24.' },
            { title: 'Kew Gardens tickets and tours', url: 'https://tours.example/kew?x=1', content: 'duplicate page' },
            { title: 'Kew Gardens on video', url: 'https://www.youtube.com/watch?v=1', content: 'Kew Gardens' },
            { title: 'Unrelated page', url: 'https://other.example/', content: 'Nothing about the place.' },
            { title: 'Kew Gardens class', url: 'http://insecure.example/kew', content: 'Kew Gardens' },
            { title: 'Kew Gardens botanical class', url: 'https://classes.example/kew', content: 'Learn at Kew Gardens' },
          ],
        })
      : undefined;
  const { svc } = await makeSvc({}, net);
  const { cards } = await experienceCards(svc, { name: 'Kew Gardens', ideaId: 'i7' });
  assert.deepEqual(cards.map((c) => c.shop), ['tours.example', 'classes.example']);
  assert.ok(cards.every((c) => !c.purchasable && c.price_cents === 0 && c.source === 'tavily' && c.ideaId === 'i7' && /^x[0-9a-f]{8}$/.test(c.id)));
  assert.ok(cards.every((c) => !/https?:|\[|\]/.test(c.snippet ?? '')));
});

test('tavily: a price is "confirmed" only by an exact match on a page of the same shop about the same product', async () => {
  const { svc } = await makeSvc();
  const mk = (shop: string, price_cents: number): Card => ({ id: 'p1', ideaId: 'i', title: 'Hario V60 Ceramic Dripper', price_cents, currency: 'USD', shop, url: `https://${shop}/p`, purchasable: true, source: 'channel3' });
  const net = makeNet();
  const page = (price: string) => ({ results: [{ title: 'Hario V60 Ceramic Dripper', url: 'https://tours-0.example/hario-v60-ceramic-dripper', content: 'text', raw_content: `Buy now ${price} free shipping` }] });
  const run = async (shop: string, cents: number, body: unknown) => {
    const x = await makeSvc({}, Object.assign(net, { intercept: () => json(body) }));
    return priceCheck(x.svc, mk(shop, cents));
  };
  assert.deepEqual((await run('tours-0.example', 2400, page('$24.00')))?.state, 'confirmed');
  assert.deepEqual(await run('tours-0.example', 2500, page('$24.00')), { state: 'unknown' }, 'a different price is not a mismatch claim, just unknown');
  assert.deepEqual(await run('other.example', 2400, page('$24.00')), { state: 'unknown' }, 'a page from another site never counts');
  const at = (url: string) => ({ results: [{ title: 'Hario V60 Ceramic Dripper', url, content: 'text', raw_content: 'Buy now $24.00 free shipping' }] });
  assert.deepEqual(await run('tours-0.example', 2400, at('https://nottours-0.example/hario-v60-ceramic-dripper')), { state: 'unknown' }, 'a host that only ends with the shop name is another site');
  assert.deepEqual((await run('tours-0.example', 2400, at('https://www.tours-0.example/hario-v60-ceramic-dripper')))?.state, 'confirmed');
  assert.deepEqual((await run('tours-0.example', 2400, at('https://store.tours-0.example/hario-v60-ceramic-dripper')))?.state, 'confirmed', 'a subdomain of the shop counts');
  assert.deepEqual(await run('tours-0.example', 2400, { results: [{ title: 'Unrelated garden tools', url: 'https://tours-0.example/garden', content: '$24.00', raw_content: '$24.00' }] }), { state: 'unknown' });
  assert.ok(svc);
});

// ---- Qloo ----------------------------------------------------------------------------------------------------------

const seeds: Seed[] = [
  { id: 'S1', name: 'Nujabes', type: 'artist' },
  { id: 'S2', name: 'Kafka on the Shore', type: 'book' },
];

test('qloo: /search results with urn types become seeds, preferring the requested type', () => {
  const r = parseSearch({ success: true, results: [{ entity_id: 'E1', name: ' Nujabes ', types: ['urn:entity:person', 'urn:entity:artist'] }, { entity_id: 'E2', name: '' }, { name: 'No id' }, 5] }, 'artist');
  assert.deepEqual(r, [{ id: 'E1', name: 'Nujabes', type: 'artist' }]);
  assert.equal(parseSearch({ results: { entities: [{ id: 'E9', name: 'Alt', type: 'urn:entity:brand' }] } })[0]!.type, 'brand');
  assert.deepEqual(parseSearch(null), []);
});

test('qloo: explainability in every plausible shape maps to known seeds only, strongest first', () => {
  const shapes: unknown[] = [
    { S1: 0.9, S2: 0.3, GHOST: 0.99 },
    [{ entity_id: 'S1', score: 0.9 }, { name: 'kafka on the shore', weight: 0.3 }, { id: 'GHOST', score: 1 }],
    { seeds: [{ entity: { entity_id: 'S1' }, contribution: 0.9 }, { entity: { name: 'Kafka on the Shore' }, affinity: 0.3 }] },
  ];
  for (const s of shapes) assert.deepEqual(parseExplainability(s, seeds), [{ seedId: 'S1', score: 0.9 }, { seedId: 'S2', score: 0.3 }]);
  assert.deepEqual(parseExplainability({ S1: 0, S2: -1, X: 'a' }, seeds), []);
  assert.deepEqual(parseExplainability(undefined, seeds), []);
  assert.deepEqual(parseExplainability({ a: { b: { c: { d: { e: { f: { S1: 1 } } } } } } }, seeds), [], 'depth is bounded');
});

test('qloo: /v2/insights entities carry their explainability', () => {
  const c = parseInsights(
    { success: true, results: { entities: [{ entity_id: 'B1', name: 'Hario', types: ['urn:entity:brand'], query: { affinity: 0.8, explainability: { S1: 0.7 } } }, { entity_id: 'B2', name: 'Plain', types: ['urn:entity:brand'] }, { name: 'no id' }] } },
    seeds,
    'brand',
  );
  assert.deepEqual(c.map((x) => [x.id, x.type, x.explained, x.because]), [['B1', 'brand', true, [{ seedId: 'S1', score: 0.7 }]], ['B2', 'brand', false, []]]);
});

test('qloo: the shapes seen live parse (synthetic stand-ins): kind in subtype, scores in an array under the signal key, no success flag on search', () => {
  const hit = { name: 'Nujabes', entity_id: '00000000-0000-0000-0000-000000000001', types: ['urn:entity:artist'], properties: { short_description: 'x' }, popularity: 0.9, disambiguation: 'd', tags: [{ name: 't', tag_id: 'u', type: 'v', value: 'w' }] };
  assert.deepEqual(parseSearch({ results: [hit] }, 'artist'), [{ id: hit.entity_id, name: 'Nujabes', type: 'artist' }]);
  const live = {
    success: true,
    results: { entities: [{ name: 'Hario', entity_id: 'B1', type: 'urn:entity', subtype: 'urn:entity:brand', query: { affinity: 0.8, measurements: { audience_growth: 0 }, explainability: { 'signal.interests.entities': [{ entity_id: 'S2', score: 0.4 }, { entity_id: 'S1', score: 0.6 }, { entity_id: 'GHOST', score: 0.9 }] } } }] },
    query: { explainability: { 'signal.interests.entities': { effect_on_top3_recs: [{ entity_id: 'S1', avg_score: 0.5 }], effect_on_all_recs: [{ entity_id: 'S2', avg_score: 0.5 }] } } },
  };
  const [c] = parseInsights(live, seeds, 'brand');
  assert.deepEqual([c!.type, c!.because], ['brand', [{ seedId: 'S1', score: 0.6 }, { seedId: 'S2', score: 0.4 }]]);
  assert.equal(parseInsights(live, seeds, 'book')[0]!.type, 'brand', 'the entity’s own kind wins over the asked-for type');
});

test('qloo fake: answers in the shapes seen live, so the parser is tested on them', async () => {
  const s = (await (await qlooFake('https://hackathon.api.qloo.com/search?query=Nujabes&types=urn:entity:artist')).json()) as { results: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(s), ['results'], 'search has no success flag');
  assert.deepEqual(s.results[0]!.types, ['urn:entity:artist']);
  const i = (await (await qlooFake('https://hackathon.api.qloo.com/v2/insights?filter.type=urn:entity:brand&signal.interests.entities=A,B&feature.explainability=true&take=3')).json()) as {
    results: { entities: { type: string; subtype: string; query: { explainability: Record<string, { entity_id: string; score: number }[]> } }[] };
    query: { explainability: Record<string, Record<string, unknown>> };
  };
  const e = i.results.entities[0]!;
  assert.deepEqual([e.type, e.subtype], ['urn:entity', 'urn:entity:brand']);
  assert.ok(Array.isArray(e.query.explainability['signal.interests.entities']) && e.query.explainability['signal.interests.entities']![0]!.entity_id);
  assert.ok(i.query.explainability['signal.interests.entities']!.effect_on_top3_recs, 'the overall block is present');
});

test('qloo: documented insight types are all lowercase and gift types are a subset', () => {
  assert.ok(GIFT_TYPES.every((t) => (INSIGHT_TYPES as readonly string[]).includes(t)));
  assert.ok(INSIGHT_TYPES.every((t) => /^[a-z_]+$/.test(t)));
});

test('qloo: requests follow the documented URLs and parameters', async () => {
  const seen: { url: string; key: string | undefined }[] = [];
  const { svc } = await makeSvc({ QLOO_API_KEY: 'qloo-test-key' }, makeNet());
  svc.fetch = async (url, init) => {
    seen.push({ url, key: (init?.headers as Record<string, string>)['X-Api-Key'] });
    return json(url.includes('/search') ? { results: [{ entity_id: 'E1', name: 'Nujabes', types: ['urn:entity:artist'] }] } : { results: { entities: [] } });
  };
  assert.equal(svc.cfg.qloo, 'live');
  const s = await searchEntity(svc, { query: 'Nujabes', type: 'artist' });
  assert.equal(s.seed?.id, 'E1');
  await searchEntity(svc, { query: 'x', type: 'not-a-type' });
  await insights(svc, { type: 'book', seeds, take: 4 });
  const u = (i: number) => new URL(seen[i]!.url);
  assert.equal(u(0).origin + u(0).pathname, 'https://hackathon.api.qloo.com/search');
  assert.equal(u(0).searchParams.get('types'), 'urn:entity:artist');
  assert.equal(u(1).searchParams.get('types'), null, 'an unknown type hint is dropped, not sent');
  assert.equal(u(2).pathname, '/v2/insights');
  assert.deepEqual([u(2).searchParams.get('filter.type'), u(2).searchParams.get('signal.interests.entities'), u(2).searchParams.get('feature.explainability'), u(2).searchParams.get('take')], ['urn:entity:book', 'S1,S2', 'true', '4']);
  assert.ok(seen.every((x) => x.key === 'qloo-test-key'));
});

// ---- the model (Workers AI) --------------------------------------------------------------------------------------------------------

test('ai: OpenAI-style tool calls are parsed, with arguments as a JSON string', () => {
  const r = parseChat({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [toolCall('qloo_search', { query: 'Nujabes' }, 'c1'), toolCall('qloo_search', '{not json', 'c2'), { id: 'c3', function: { name: 'find_products', arguments: { query: 'x' } } }, { function: {} }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
  assert.deepEqual(r.calls.map((c) => [c.id, c.name, c.args]), [['c1', 'qloo_search', { query: 'Nujabes' }], ['c2', 'qloo_search', undefined], ['c3', 'find_products', { query: 'x' }]]);
  assert.deepEqual([r.finish, r.usage, r.content], ['tool_calls', { prompt: 12, completion: 3 }, '']);
});

test('ai: think blocks are dropped and tool calls written as text are still found', () => {
  const a = parseChat({ choices: [{ message: { content: '<think>I should look this up</think>\nChecking.\n<tool_call>{"name":"qloo_search","arguments":{"query":"Muji"}}</tool_call>' } }] });
  assert.deepEqual(a.calls.map((c) => [c.name, c.args]), [['qloo_search', { query: 'Muji' }]]);
  assert.equal(a.content, 'Checking.');
  const b = parseChat({ choices: [{ message: { content: '<TOOLCALL>[{"name":"find_products","arguments":"{\\"query\\":\\"a\\"}"},{"function":{"name":"qloo_search","parameters":{"query":"b"}}}]</TOOLCALL>' } }] });
  assert.deepEqual(b.calls.map((c) => [c.name, c.args]), [['find_products', { query: 'a' }], ['qloo_search', { query: 'b' }]]);
});

test('ai: content in parts, empty and garbage answers do not throw', () => {
  assert.equal(parseChat({ choices: [{ message: { content: [{ text: 'DO' }, { text: 'NE' }] } }] }).content, 'DONE');
  for (const junk of [null, undefined, {}, { choices: [] }, { choices: [null] }, 'x']) {
    const r = parseChat(junk);
    assert.deepEqual([r.content, r.calls.length], ['', 0]);
  }
});

test('ai: chat runs the model on the binding with tools and a named tool choice, and no key travels', async () => {
  const ai = fakeAi(() => chatBody({ content: 'hello' }, 'stop', 2.5));
  const { svc, net } = await makeSvc({ AI: ai });
  assert.equal(svc.cfg.ai, 'live');
  const tool = { type: 'function' as const, function: { name: 'create_order', description: 'd', parameters: { type: 'object' } } };
  const r = await chat(svc, { model: '@cf/test/model', messages: [{ role: 'user', content: 'hi' }], tools: [tool], toolChoice: { name: 'create_order' }, maxTokens: 321 });
  assert.equal(r.content, 'hello');
  assert.deepEqual([r.via, r.usage], ['live', { prompt: 10, completion: 5, neurons: 2.5 }]);
  const { model, input } = ai.runs[0]!;
  assert.equal(model, '@cf/test/model');
  assert.deepEqual([input.model, input.tool_choice, input.tools.length, input.max_tokens, input.messages.length], [undefined, { type: 'function', function: { name: 'create_order' } }, 1, 321, 1]);
  assert.equal(net.calls.length, 0, 'the binding is not the internet');
  const u = (await svc.meter.used()).ip as Record<string, number>;
  assert.deepEqual([u.ai, u.neurons], [1, 3]);
});

test('ai: an assistant turn with only tool calls goes out with empty text, not null; Qwen3 gets its no-think switch, other models do not', async () => {
  const ai = fakeAi();
  const { svc } = await makeSvc({ AI: ai });
  const turn = [{ role: 'system' as const, content: 'Be brief. [task:ideas]' }, { role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content: null, tool_calls: [toolCall('qloo_search', { query: 'x' })] }, { role: 'tool' as const, tool_call_id: 'call_1', content: '{}' }];
  await chat(svc, { model: '@cf/qwen/qwen3-30b-a3b-fp8', messages: turn });
  await chat(svc, { model: '@cf/mistralai/mistral-small-3.1-24b-instruct', messages: turn });
  const [qwen, other] = ai.runs.map((r) => r.input.messages as { role: string; content: unknown }[]);
  assert.deepEqual([qwen![2]!.content, other![2]!.content], ['', '']);
  assert.equal(qwen![0]!.content, 'Be brief. [task:ideas]\n/no_think');
  assert.equal(other![0]!.content, 'Be brief. [task:ideas]');
  assert.equal(turn[2]!.content, null, 'the caller\'s history is not changed');
});

test('ai: one retry on a refusal or a failure, then the error stands', async () => {
  let n = 0;
  const flaky = fakeAi(() => {
    if (++n === 1) throw new Error('InferenceUpstreamError: capacity temporarily exceeded');
    return chatBody({ content: 'ok' });
  });
  const { svc } = await makeSvc({ AI: flaky });
  assert.equal((await chat(svc, { model: 'm', messages: [] })).content, 'ok');
  assert.equal(flaky.runs.length, 2);
  const down = fakeAi(() => {
    throw new Error('boom');
  });
  const t = await makeSvc({ AI: down });
  await assert.rejects(chat(t.svc, { model: 'm', messages: [] }), (e) => e instanceof HttpError && e.status === 502);
  assert.equal(down.runs.length, 2);
});

test('ai: the older answer shape (response and flat tool_calls) is read too', () => {
  const r = parseChat({ response: 'Looking.', tool_calls: [{ name: 'qloo_search', arguments: { query: 'Muji' } }], usage: { prompt_tokens: 7, completion_tokens: 2, neurons: 1.5 } });
  assert.deepEqual([r.content, r.calls.map((c) => [c.name, c.args]), r.usage], ['Looking.', [['qloo_search', { query: 'Muji' }]], { prompt: 7, completion: 2, neurons: 1.5 }]);
});

// ---- PayPal --------------------------------------------------------------------------------------------------------

test('paypal: an order view is read from the Orders v2 shape', () => {
  const v = parseOrder({ id: 'ORD123456789', status: 'COMPLETED', purchase_units: [{ amount: { currency_code: 'USD', value: '36.50' }, payments: { captures: [{ id: 'CAP1', status: 'COMPLETED' }] } }] });
  assert.deepEqual(v, { id: 'ORD123456789', status: 'COMPLETED', total_cents: 3650, currency: 'USD', captureId: 'CAP1', captureStatus: 'COMPLETED' });
  assert.deepEqual([parseOrder({}).status, parseOrder(null).total_cents, parseOrder({ purchase_units: [] }).currency], ['UNKNOWN', null, '']);
});

test('paypal: order ids are checked before they go into a URL, and errors are phrased for buyers', () => {
  for (const ok of ['5O190127TN364715T', 'ABCDEFGH12']) assert.ok(validOrderId(ok));
  for (const bad of ['', 'short', '../../x', 'ABC DEF GHI', 'A'.repeat(31), 12345678, null]) assert.ok(!validOrderId(bad), String(bad));
  assert.match(humanPayPalError(new Error('paypal HTTP 422: ORDER_NOT_APPROVED')), /not approved/);
  assert.match(humanPayPalError(new Error('INSTRUMENT_DECLINED')), /declined/);
  assert.match(humanPayPalError(new Error('boom {"debug_id":"x"}')), /did not give a reason/);
  assert.doesNotMatch(humanPayPalError(new Error('boom {"debug_id":"x"}')), /debug_id/);
});

// ---- shared HTTP and util ------------------------------------------------------------------------------------------

test('http: a secret echoed by an upstream or a failing connection never reaches an error message', async () => {
  const { svc } = await makeSvc({ TAVILY_API_KEY: 'tvly-SECRET-123456' });
  svc.fetch = async () => json({ detail: 'bad token tvly-SECRET-123456' }, 401);
  await assert.rejects(callJson(svc, 'tavily', 'https://api.tavily.com/search', {}), (e) => e instanceof HttpError && !e.message.includes('tvly-SECRET-123456') && e.message.includes('[key]'));
  svc.fetch = async () => {
    throw new Error('connect failed for tvly-SECRET-123456');
  };
  await assert.rejects(callJson(svc, 'tavily', 'https://api.tavily.com/search', {}), (e) => e instanceof HttpError && e.status === 0 && !e.message.includes('SECRET'));
});

test('http: billed services spend the counter first and the subrequest budget; mocks spend nothing', async () => {
  const { svc } = await makeSvc({ LIMIT_GLOBAL_TAVILY: '2' });
  svc.sub.left = 3;
  await callJson(svc, 'tavily', 'https://api.tavily.com/search', {});
  await callJson(svc, 'channel3', 'https://api.trychannel3.com/v1/search', {});
  const u = (await svc.meter.used()).global;
  assert.deepEqual([svc.sub.left, u.tavily, u.channel3], [1, 1, 1]);
  svc.mocks.qloo = async () => json({});
  await callJson(svc, 'qloo', 'https://hackathon.api.qloo.com/search', {});
  assert.equal(svc.sub.left, 1);
  await callJson(svc, 'paypal', 'https://api-m.sandbox.paypal.com/v1/oauth2/token', {}); // paypal is not metered but still a subrequest
  await assert.rejects(callJson(svc, 'paypal', 'https://api-m.sandbox.paypal.com/x', {}), (e) => e instanceof BudgetError);
  svc.sub.left = 5;
  await callJson(svc, 'tavily', 'https://api.tavily.com/search', {});
  await assert.rejects(callJson(svc, 'tavily', 'https://api.tavily.com/search', {}), (e) => e instanceof LimitError && e.scope === 'global');
  assert.equal(svc.sub.left, 4, 'a refused call does not use a subrequest');
});

test('util: cents, urls and redaction', () => {
  assert.deepEqual(['12.34', '$1,234.50', 19.99, 0.1, '0', -3, 'abc', 1e9, null].map(toCents), [1234, 123450, 1999, 10, null, null, null, null, null]);
  assert.deepEqual(['https://a.example/x', 'http://a.example', 'javascript:alert(1)', '//a.example', '', 5].map(httpsUrl), ['https://a.example/x', undefined, undefined, undefined, undefined, undefined]);
  assert.equal(redact('key abc12345 and short xyz', ['abc12345', 'xyz', undefined]), 'key [key] and short xyz');
});

test('clip: short text is untouched; long text ends cleanly, never on a separator, a cut word or ".…"', () => {
  assert.equal(clip('  a   b \n c ', 20), 'a b c');
  const long = 'Gift tickets are perfect for sharing the wonder of Kew Gardens with loved ones. These tickets are flexible';
  assert.equal(clip(long, 81), 'Gift tickets are perfect for sharing the wonder of Kew Gardens with loved ones.');
  assert.equal(clip('Kew Gardens, London | Gift Tours, Tickets & Excursions (2026) - Book Now Online', 66), 'Kew Gardens, London | Gift Tours, Tickets & Excursions (2026)…');
  assert.equal(clip('alpha beta gamma delta epsilon', 14), 'alpha beta…');
  assert.equal(clip('supercalifragilistic expialidocious', 12), 'supercalifr…');
  for (const t of [long, 'x'.repeat(300), '- - - - - - - - - - -', 'a b c d e f g h i j k l m n']) for (const n of [5, 10, 33, 80]) assert.ok(clip(t, n).length <= n, `${n} ${t.slice(0, 12)}`);
});
