// Ideas that differ: nothing the person typed comes back as an idea, and one run's ideas spread over types and over the favourites Qloo links them to.
// The Qloo answers are invented, in the shape of the docs (src/adapters/qloo.ts); real Qloo output is never committed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { templateReason } from '../src/agent/ideas.ts';
import type { FetchFn } from '../src/types.ts';
import { chatReply, FAVS, json, makeHarness, readEvents, taskOf, toolCall } from './helpers.ts';

const DONE = () => chatReply({ content: 'DONE' });
const calls = (...c: ReturnType<typeof toolCall>[]) => chatReply({ content: null, tool_calls: c }, 'tool_calls');
const model =
  (tasks: Record<string, (n: number, body: any) => Response>): FetchFn =>
  async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return (tasks[taskOf(init)] ?? DONE)(body.messages.filter((m: any) => m.role === 'assistant').length + 1, body);
  };
const modelDown: FetchFn = async () => json({ error: 'overloaded' }, 503);

const NUJ = 'S-NUJABES';
const MUJI = 'S-MUJI';
const KAFKA = 'S-KAFKA';
const SEEDS: Record<string, { id: string; name: string; type: string }> = {
  nujabes: { id: NUJ, name: 'Nujabes', type: 'artist' },
  muji: { id: MUJI, name: 'Muji', type: 'brand' },
  'kafka on the shore': { id: KAFKA, name: 'Kafka on the Shore', type: 'book' },
};

interface Row {
  id: string;
  name: string;
  lead: string; // the favourite Qloo links the result to most strongly
}
/** What insights returns per type. As the live API does, every result is linked to every favourite sent; the first of each type is led by Nujabes, the run that showed the problem. */
const ROWS: Record<string, Row[]> = {
  brand: [{ id: 'B-AUREL', name: 'Aurel', lead: NUJ }, { id: 'B-BRISK', name: 'Brisk', lead: NUJ }, { id: 'B-CORVO', name: 'Corvo', lead: MUJI }, { id: 'B-DUNMORE', name: 'Dunmore', lead: KAFKA }],
  book: [{ id: 'K-FABLE', name: 'Fable Hill', lead: NUJ }, { id: 'K-GLASS', name: 'Glass Orchard', lead: KAFKA }],
  artist: [{ id: 'A-HALDEN', name: 'Halden', lead: NUJ }, { id: 'A-AMBER', name: 'Amber Quill', lead: MUJI }],
  place: [{ id: 'P-JUNO', name: 'Juno Park', lead: NUJ }, { id: 'P-KESTREL', name: 'Kestrel Cafe', lead: KAFKA }],
};
/** The person's own words coming back as results: the matched favourite under another name, the same name under another id, and a favourite Qloo cannot find. */
const TYPED_IDS = [MUJI, 'B-MUJI2', 'B-HARIO'];
const WITH_TYPED: Record<string, Row[]> = {
  ...ROWS,
  brand: [{ id: MUJI, name: 'Muji Co', lead: NUJ }, { id: 'B-MUJI2', name: 'Muji', lead: NUJ }, { id: 'B-HARIO', name: 'Hario', lead: NUJ }, ...ROWS.brand!],
};
const FAVS4 = [...FAVS, { text: 'Hario' }];

function qloo(rows = ROWS) {
  const asked: URL[] = []; // the insights requests
  const fetch: FetchFn = async (input) => {
    const u = new URL(input);
    if (u.pathname === '/search') {
      const hit = SEEDS[u.searchParams.get('query')!.toLowerCase()];
      return json({ results: hit ? [{ name: hit.name, entity_id: hit.id, types: [`urn:entity:${hit.type}`] }] : [] });
    }
    asked.push(u);
    const sent = u.searchParams.get('signal.interests.entities')!.split(',');
    const type = u.searchParams.get('filter.type')!.replace('urn:entity:', '');
    const entities = (rows[type] ?? []).slice(0, Number(u.searchParams.get('take'))).map((r) => ({
      name: r.name,
      entity_id: r.id,
      type: 'urn:entity',
      subtype: `urn:entity:${type}`,
      query: { explainability: { 'signal.interests.entities': sent.map((id) => ({ entity_id: id, score: id === r.lead ? 0.5 : 0.1 })) } },
    }));
    return json({ success: true, results: { entities } });
  };
  return { fetch, asked };
}

/** The app on invented Qloo answers, a scripted model and a catalog that files every item under books and vinyl (the default fake sends no category, so book and artist ideas would never pass the gate). */
function setup(q: ReturnType<typeof qloo>, ai: FetchFn, prices = [12.5, 24, 39.99]) {
  const h = makeHarness({}, { mocks: { qloo: q.fetch, ai } });
  h.net.intercept = (path, init) => {
    if (path !== '/v1/search') return undefined;
    const name = String(JSON.parse(String(init?.body)).query);
    const slug = name.replace(/\W+/g, '-');
    return json({
      products: prices.map((price, k) => ({
        id: `t-${slug}-${k}`,
        title: `${name} item ${k}`,
        brands: [{ name }],
        category: { slug: 'books', path: [{ slug: 'vinyl' }] },
        offers: [{ url: `https://buy.example/${slug}/${k}`, domain: `shop-${k}.example`, price: { price, currency: 'USD' }, availability: 'InStock', condition: 'new' }],
      })),
    });
  };
  return h;
}

/** What the tools answered so far, by call id. */
const answers = (body: any): Record<string, any> => Object.fromEntries(body.messages.filter((m: any) => m.role === 'tool').map((m: any) => [m.tool_call_id, JSON.parse(m.content)]));
/** The tools-tier model: one list of calls per turn (written with the answers so far); with no list left, or an empty one, it says DONE. */
const turns = (...t: ((a: Record<string, any>) => ReturnType<typeof toolCall>[])[]) => (n: number, body: any) => {
  const next = t[n - 1]?.(answers(body));
  return next?.length ? calls(...next) : DONE();
};
const look = (query: string, type?: string) => toolCall('qloo_search', type ? { query, type } : { query }, `s-${query}`);
const LOOK_ALL = () => [look('Nujabes', 'artist'), look('Muji'), look('Kafka on the Shore', 'book')];
const find = (id: string, name: string) => toolCall('find_products', { entity_id: id, query: name }, `f-${id}`);
/** A picks answer: the model's choice from the candidates it was shown. */
const picks = (choose: (cands: any[], n: number) => { id: string; name: string; query?: string }[]) => (_n: number, body: any) => {
  const { candidates, number_of_picks } = JSON.parse(body.messages[1].content);
  return chatReply({ content: JSON.stringify({ picks: choose(candidates, number_of_picks).map((c) => ({ entity_id: c.id, query: c.query ?? c.name })) }) });
};

const go = async (h: ReturnType<typeof makeHarness>, favorites: { text: string; type?: string }[] = FAVS) => (await readEvents(await h.post('/api/ideas', { favorites, budget_usd: 120 }))) as any[];
const ideasOf = (ev: any[]) => ev.filter((e) => e.t === 'idea').map((e) => e.idea);
/** The most ideas of one type. */
const most = (ideas: any[]) => {
  const n = new Map<string, number>();
  for (const i of ideas) n.set(i.entity.type, (n.get(i.entity.type) ?? 0) + 1);
  return Math.max(0, ...n.values());
};
/** The favourites the ideas cite first (Qloo's strongest link). */
const leads = (ideas: any[]) => new Set(ideas.map((i) => i.because[0]));
const noTyped = (ideas: any[]) => {
  for (const i of ideas) assert.ok(!TYPED_IDS.includes(i.entity.id) && !/^(muji|hario)$/i.test(i.entity.name), `${i.entity.name} (${i.entity.id}) is something the person typed`);
};

// ---- typed favourites ------------------------------------------------------------------------------------------------------

test('spread: nothing the person typed comes back as an idea, even from an insights call made before every favourite was searched', async () => {
  let offered: string[] = [];
  const h = setup(
    qloo(WITH_TYPED),
    model({
      ideas: turns(
        () => [look('Nujabes', 'artist'), look('Kafka on the Shore', 'book'), look('Hario')], // Qloo knows no Hario
        () => [toolCall('qloo_insights', { target_type: 'brand', seed_ids: [NUJ] }, 'ins'), look('Muji')], // a subset of the favourites, and Muji still being searched
        (a) => {
          offered = a.ins.candidates.map((c: any) => c.id);
          return [find('B-AUREL', 'Aurel'), ...TYPED_IDS.map((id) => find(id, 'Muji'))]; // the model also asks for the typed ones
        },
      ),
    }),
  );
  const ev = await go(h, FAVS4);
  assert.equal(ev.at(-1).t, 'done', JSON.stringify(ev.at(-1)));
  assert.ok(!offered.includes('B-MUJI2') && !offered.includes('B-HARIO'), `qloo_insights offered ${offered}`);
  const ideas = ideasOf(ev);
  assert.ok(ideas.length >= 4, `${ideas.length} ideas`);
  noTyped(ideas);
});

test('spread: with the model down, a favourite typed under another id or not found by Qloo is not an idea either', async () => {
  const h = setup(qloo(WITH_TYPED), modelDown);
  const ev = await go(h, FAVS4);
  assert.deepEqual([ev.at(-1).t, ev.at(-1).tier], ['done', 'template']);
  const ideas = ideasOf(ev);
  assert.ok(ideas.length >= 4, `${ideas.length} ideas`);
  noTyped(ideas);
});

test('spread: every insights request carries every favourite Qloo matched, whatever ids the model sends', async () => {
  const q = qloo();
  const h = setup(q, model({ ideas: turns(LOOK_ALL, () => [toolCall('qloo_insights', { target_type: 'brand', seed_ids: [NUJ] }, 'ins')]) }));
  await go(h);
  assert.ok(q.asked.length >= 2, `${q.asked.length} insights requests`);
  for (const u of q.asked) assert.deepEqual(u.searchParams.get('signal.interests.entities')!.split(',').sort(), [KAFKA, MUJI, NUJ]);
});

// ---- spread over types -----------------------------------------------------------------------------------------------------

test('spread: a model that picks three entities of one type gets at most two of them', async () => {
  const h = setup(qloo(), model({ picks: picks((cands) => ['Aurel', 'Corvo', 'Dunmore'].map((name) => cands.find((c) => c.name === name))) })); // three brands, led by three different favourites
  const ev = await go(h);
  const ideas = ideasOf(ev);
  assert.ok(ideas.length >= 4, `${ideas.length} ideas`);
  assert.ok(most(ideas) <= 2, ideas.map((i) => i.entity.type).join());
});

test('spread: the tools tier refuses a third find_products for one type while other types are available', async () => {
  let refused: any;
  const h = setup(
    qloo(),
    model({
      ideas: turns(
        LOOK_ALL,
        () => ['brand', 'book', 'artist', 'place'].map((t) => toolCall('qloo_insights', { target_type: t }, `i-${t}`)),
        () => [find('B-AUREL', 'Aurel'), find('B-CORVO', 'Corvo'), find('B-DUNMORE', 'Dunmore')], // three brands in one turn, led by three different favourites
        (a) => ((refused = a['f-B-DUNMORE']), []),
      ),
    }),
  );
  const ideas = ideasOf(await go(h));
  assert.match(refused?.error ?? JSON.stringify(refused), /too alike/);
  assert.ok(ideas.length >= 4 && most(ideas) <= 2, ideas.map((i) => i.entity.type).join());
});

// ---- spread over the favourites --------------------------------------------------------------------------------------------

for (const [tier, ai] of [
  ['pipeline', model({ picks: picks((cands, n) => cands.filter((c) => c.because[0] === 'Nujabes').slice(0, n)) })], // the model takes what Qloo links to Nujabes most strongly
  ['fallback', modelDown],
] as const) {
  test(`spread: ${tier}: when Qloo links the candidates to several favourites, the ideas cite at least two of them`, async () => {
    const ideas = ideasOf(await go(setup(qloo(), ai)));
    assert.ok(ideas.length >= 4, `${ideas.length} ideas`);
    assert.ok(leads(ideas).size >= 2, [...leads(ideas)].join());
    assert.ok(most(ideas) <= 2, ideas.map((i) => i.entity.type).join());
  });
}

test('spread: the tools tier refuses a second find_products led by the same favourite while other favourites lead other candidates', async () => {
  let refused: any;
  const h = setup(
    qloo(),
    model({
      ideas: turns(
        LOOK_ALL,
        () => ['brand', 'book', 'artist', 'place'].map((t) => toolCall('qloo_insights', { target_type: t }, `i-${t}`)),
        () => [find('B-AUREL', 'Aurel'), find('B-BRISK', 'Brisk')], // both led by Nujabes
        (a) => ((refused = a['f-B-BRISK']), []),
      ),
    }),
  );
  const ideas = ideasOf(await go(h));
  assert.match(refused?.error ?? JSON.stringify(refused), /too alike/);
  assert.ok(ideas.length >= 4 && leads(ideas).size >= 2, [...leads(ideas)].join());
});

// ---- the queries and the reasons -------------------------------------------------------------------------------------------

test('spread: a search without the entity name is replaced by the plain name search, which the catalog gate can match', async () => {
  const h = setup(qloo(), model({ picks: picks((cands, n) => cands.slice(0, n).map((c) => ({ ...c, query: 'a nice gift' }))) }));
  const ev = await go(h);
  assert.equal(ev.at(-1).t, 'done', JSON.stringify(ev.at(-1)));
  assert.ok(ideasOf(ev).length >= 4);
  assert.ok(h.net.calls.filter((c) => c.host === 'api.trychannel3.com').every((c) => !/nice gift/.test(c.body.query)));
});

test('spread: a catalog search that finds one matching item still makes an idea', async () => {
  const h = setup(qloo(), modelDown, [24]);
  const ev = await go(h);
  assert.equal(ev.at(-1).t, 'done', JSON.stringify(ev.at(-1)));
  const products = ideasOf(ev).filter((i) => i.kind === 'product');
  assert.ok(products.length >= 3, `${products.length} product ideas`);
  assert.ok(products.every((i) => i.cardIds.length === 1));
});

test('spread: a model reason is kept only if it names the favourite Qloo links most strongly', async () => {
  const h = setup(
    qloo(),
    model({
      reasons: (_n, body) => {
        const ideas = JSON.parse(body.messages[1].content).ideas as { id: string; because: string[] }[];
        return chatReply({ content: JSON.stringify({ reasons: Object.fromEntries(ideas.map((i, k) => [i.id, `A lovely present, because they love ${i.because[k % 2]} so much.`])) }) }); // odd ones name only the second favourite
      },
    }),
  );
  const ev = await go(h);
  const reasons = ev.find((e) => e.t === 'reasons').reasons;
  const ideas = ideasOf(ev);
  assert.ok(ideas.length >= 4 && ideas.every((i) => i.because.length >= 2));
  ideas.forEach((i, k) => assert.equal(reasons[i.id], k % 2 ? templateReason(i) : `A lovely present, because they love ${i.because[0]} so much.`));
});
