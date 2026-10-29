// Ideas that differ: nothing the person typed comes back as an idea, and one run's ideas spread over types and over the favourites Qloo links them to.
// The Qloo answers are invented, in the shape of the docs (src/adapters/qloo.ts); real Qloo output is never committed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MEGA, templateReason } from '../src/agent/ideas.ts';
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
  pop?: number; // Qloo's popularity percentile, when the answer carries one
  plain?: boolean; // no explainability in the answer: no usable link to any favourite
  tags?: string[]; // the tags Qloo gives the result; by default those of its lead favourite, so the two have something in common
}
/** Invented tags in the shape Qloo uses ({ id, name, type: 'urn:tag:<kind>:qloo' }). */
const tagObj = (name: string) => ({ id: `T-${name}`, name, type: 'urn:tag:style:qloo' });
const SEED_TAGS: Record<string, string[]> = { [NUJ]: ['Jazz Hop', 'Mellow'], [MUJI]: ['Minimalist', 'Mellow'], [KAFKA]: ['Dreamlike'] };
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
      return json({ results: hit ? [{ name: hit.name, entity_id: hit.id, types: [`urn:entity:${hit.type}`], tags: (SEED_TAGS[hit.id] ?? []).map(tagObj) }] : [] });
    }
    asked.push(u);
    const sent = u.searchParams.get('signal.interests.entities')!.split(',');
    const type = u.searchParams.get('filter.type')!.replace('urn:entity:', '');
    const entities = (rows[type] ?? []).slice(0, Number(u.searchParams.get('take'))).map((r) => ({
      name: r.name,
      entity_id: r.id,
      type: 'urn:entity',
      subtype: `urn:entity:${type}`,
      ...(r.pop === undefined ? {} : { popularity: r.pop }),
      tags: (r.tags ?? SEED_TAGS[r.lead] ?? []).map(tagObj),
      ...(r.plain ? {} : { query: { explainability: { 'signal.interests.entities': sent.map((id) => ({ entity_id: id, score: id === r.lead ? 0.5 : 0.1 })) } } }),
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

test('spread: a model reason is kept only if it names the favourite Qloo links most strongly and uses a tag Qloo gives both', async () => {
  const h = setup(
    qloo(),
    model({
      reasons: (_n, body) => {
        const ideas = JSON.parse(body.messages[1].content).ideas as { id: string; because: string[]; in_common: string[] }[];
        const write = (i: { because: string[]; in_common: string[] }, k: number) =>
          [
            `A lovely present, because they love ${i.because[0]} and share a ${i.in_common[0]} spirit.`, // names the strongest favourite and a shared tag: kept
            `A lovely present, because they love ${i.because[0]} so much.`, // no shared tag
            `A lovely present, because they love ${i.because[1]} and share a ${i.in_common[0]} spirit.`, // names only the second favourite
          ][k % 3]!;
        return chatReply({ content: JSON.stringify({ reasons: Object.fromEntries(ideas.map((i, k) => [i.id, write(i, k)])) }) });
      },
    }),
  );
  const ev = await go(h);
  const reasons = ev.find((e) => e.t === 'reasons').reasons;
  const ideas = ideasOf(ev);
  assert.ok(ideas.length >= 4 && ideas.every((i) => i.because.length >= 2 && i.shared?.length), 'every idea has two favourites and a shared tag');
  ideas.forEach((i, k) => assert.equal(reasons[i.id], k % 3 ? templateReason(i) : `A lovely present, because they love ${i.because[0]} and share a ${i.shared[0]} spirit.`, i.title));
  assert.ok(ideas.some((_, k) => k % 3 === 0) && ideas.some((_, k) => k % 3 === 1), 'both a kept and a replaced reason were tested');
});

// ---- what Qloo's data says on the card -------------------------------------------------------------------------------------

test('evidence: each idea carries Qloo’s split of the link and the tags both it and its strongest favourite have', async () => {
  const h = setup(qloo(), modelDown);
  const ideas = ideasOf(await go(h));
  assert.ok(ideas.length >= 4);
  for (const i of ideas) {
    // the fixture gives every favourite 0.1 and the lead 0.5: 71.4%, 14.3%, 14.3%; the odd percent goes to the largest remainder
    assert.deepEqual(i.shares, [72, 14, 14], `${i.title}: Qloo's split of the link, adding up to 100`);
    assert.equal(i.shares.length, i.because.length);
    const lead = i.because[0] === 'Nujabes' ? NUJ : i.because[0] === 'Muji' ? MUJI : KAFKA;
    assert.deepEqual(i.shared, SEED_TAGS[lead], `${i.title}: the tags both ${i.because[0]} and ${i.entity.name} have`);
  }
});

test('evidence: no split when Qloo names one favourite, and no shared tags when the two have none; the page gets no other tag', async () => {
  const h = setup(qloo(), modelDown);
  // a one-favourite answer: ask Qloo about a single search result by typing one favourite plus two that Qloo cannot find
  const ev = await go(h, [FAVS[1]!, { text: 'Zzyzx' }, { text: 'Qqq' }]);
  const ideas = ideasOf(ev);
  assert.ok(ideas.length >= 3 && ideas.every((i) => i.because.length === 1 && i.because[0] === 'Nujabes'));
  assert.ok(ideas.every((i) => i.shares === undefined), 'a split of one favourite is not shown');
  assert.ok(ideas.every((i) => i.shared?.every((t: string) => SEED_TAGS[NUJ]!.includes(t))));
  const taste = ev.filter((e) => e.t === 'taste').at(-1);
  assert.ok(taste.seeds.every((s: any) => Object.keys(s).sort().join() === 'id,name,type'), 'the tags stay off the seeds the page receives');
});

test('evidence: when Qloo’s data gives a favourite and an idea nothing in common, the reason says only that Qloo links them, whatever a model writes', async () => {
  const noCommon = (rows: Row[]) => rows.map((r) => ({ ...r, tags: ['Unrelated Thing'] }));
  const rows = { brand: noCommon(ROWS.brand!), book: noCommon(ROWS.book!), artist: noCommon(ROWS.artist!), place: noCommon(ROWS.place!) };
  let calls = 0;
  const h = setup(
    qloo(rows),
    model({
      // the old behaviour: a model asked for every idea names the strongest favourite and invents what they share; this reason would have been kept
      reasons: (_n, body) => {
        calls++;
        const ideas = JSON.parse(body.messages[1].content).ideas as { id: string; because: string[] }[];
        return chatReply({ content: JSON.stringify({ reasons: Object.fromEntries(ideas.map((i) => [i.id, `Because they love ${i.because[0]}, both share the same quiet, dreamlike mood.`])) }) });
      },
    }),
  );
  const ev = await go(h);
  const reasons = ev.find((e) => e.t === 'reasons').reasons;
  const ideas = ideasOf(ev);
  assert.ok(ideas.length >= 4 && ideas.every((i) => i.because.length >= 2 && !i.shared));
  for (const i of ideas) assert.equal(reasons[i.id], `Qloo links ${i.because[0]} to ${i.entity.name}.`, i.title);
  assert.equal(calls, 0, 'with nothing in common anywhere, the reasons model is not even asked');
});

test('evidence: an idea with nothing in common keeps the plain line even when the model answers for it; the ones with tags are written as before', async () => {
  const rows = { ...ROWS, brand: [{ ...ROWS.brand![0]!, tags: ['Unrelated Thing'] }, ...ROWS.brand!.slice(1)] }; // Aurel (led by Nujabes) has no tag in common
  const h = setup(
    qloo(rows),
    model({
      reasons: (_n, body) => {
        const ideas = JSON.parse(body.messages[1].content).ideas as { id: string; entity: string; because: string[]; in_common?: string[] }[];
        assert.ok(ideas.every((i) => i.in_common?.length), 'only ideas with shared tags are put to the model');
        // it also answers for ideas it was not asked about, naming the strongest favourite and inventing a shared quality
        const all = Object.fromEntries(['i1', 'i2', 'i3', 'i4', 'i5', 'i6'].map((id) => [id, `Because they love ${ideas[0]?.because[0] ?? 'Nujabes'}, both share a hushed, dreamlike mood.`]));
        for (const i of ideas) all[i.id] = `Because they love ${i.because[0]}, ${i.entity} has the same ${i.in_common![0]} feel.`;
        return chatReply({ content: JSON.stringify({ reasons: all }) });
      },
    }),
  );
  const ev = await go(h);
  const reasons = ev.find((e) => e.t === 'reasons').reasons;
  const ideas = ideasOf(ev);
  const aurel = ideas.find((i) => i.entity.name === 'Aurel');
  assert.ok(aurel, 'the idea without tags in common is in the run');
  assert.equal(reasons[aurel.id], 'Qloo links Nujabes to Aurel.');
  for (const i of ideas.filter((x) => x !== aurel)) assert.equal(reasons[i.id], `Because they love ${i.because[0]}, ${i.entity.name} has the same ${i.shared[0]} feel.`, i.title);
});

// ---- very popular names ----------------------------------------------------------------------------------------------------
// Qloo's strongest links go to household names, so different people got the same entity. Inside one type, the very popular are left
// out while a less popular one with a usable link exists; a type is never left empty.

const BIG = 0.9999;
const SMALL = 0.2;
const names = (a: any): string[] => a.candidates.map((c: any) => c.name).sort();
const INSIGHTS = (types = ['brand', 'book', 'artist', 'place']) => types.map((t) => toolCall('qloo_insights', { target_type: t }, `i-${t}`));
const withBrands = (brand: Row[]) => ({ ...ROWS, brand });
/** The brands the model is offered by qloo_insights, and the ideas of the run. */
async function offeredBrands(rows: Record<string, Row[]>) {
  let offered: string[] = [];
  const h = setup(qloo(rows), model({ ideas: turns(LOOK_ALL, () => INSIGHTS(), (a) => ((offered = names(a['i-brand'])), [])) }));
  const ideas = ideasOf(await go(h));
  return { ideas, offered };
}

test('popularity: a very popular entity is not offered while a less popular one with a usable link exists', async () => {
  assert.ok(BIG >= MEGA && SMALL < MEGA);
  const rows = withBrands([{ id: 'B-AUREL', name: 'Aurel', lead: NUJ, pop: BIG }, { id: 'B-BRISK', name: 'Brisk', lead: NUJ, pop: SMALL }, { id: 'B-CORVO', name: 'Corvo', lead: MUJI, pop: MEGA }, { id: 'B-DUNMORE', name: 'Dunmore', lead: KAFKA, pop: MEGA - 0.0005 }]); // the cut-off itself is a household name, just under it is not
  const r = await offeredBrands(rows);
  assert.deepEqual(r.offered, ['Brisk', 'Dunmore']);
  assert.ok(r.ideas.length >= 4 && r.ideas.filter((i) => i.entity.type === 'brand').every((i) => ['Brisk', 'Dunmore'].includes(i.entity.name)), r.ideas.map((i) => i.entity.name).join());
  const down = ideasOf(await go(setup(qloo(rows), modelDown))); // the fixed pipeline reads the same list
  assert.ok(down.length >= 4 && down.filter((i) => i.entity.type === 'brand').every((i) => ['Brisk', 'Dunmore'].includes(i.entity.name)), down.map((i) => i.entity.name).join());
});

test('popularity: when every candidate of a type is very popular, the type keeps them all and still makes ideas', async () => {
  const rows = withBrands(ROWS.brand!.map((r) => ({ ...r, pop: BIG })));
  const r = await offeredBrands(rows);
  assert.deepEqual(r.offered, ['Aurel', 'Brisk', 'Corvo', 'Dunmore']);
  assert.ok(r.ideas.length >= 4);
  assert.ok(ideasOf(await go(setup(qloo(rows), modelDown))).some((i) => i.entity.type === 'brand'), 'the fixed pipeline still has a brand to choose');
});

test('popularity: a typed favourite is dropped first; when it was the only less popular one, the very popular stay', async () => {
  const rows = withBrands([{ id: MUJI, name: 'Muji Co', lead: NUJ, pop: SMALL }, { id: 'B-AUREL', name: 'Aurel', lead: NUJ, pop: BIG }, { id: 'B-CORVO', name: 'Corvo', lead: MUJI, pop: BIG }]);
  const r = await offeredBrands(rows);
  assert.deepEqual(r.offered, ['Aurel', 'Corvo']);
  noTyped(r.ideas);
});

test('popularity: when the only less popular candidate turns out to be a favourite found by a later search, the household names come back', async () => {
  const rows = withBrands([{ id: MUJI, name: 'Muji Co', lead: NUJ, pop: SMALL }, ...ROWS.brand!.map((r) => ({ ...r, pop: BIG }))]);
  const h = setup(qloo(rows), model({ ideas: turns(() => [look('Nujabes', 'artist'), look('Kafka on the Shore', 'book')], () => [toolCall('qloo_insights', { target_type: 'brand' }, 'ins')], () => [look('Muji')]) }));
  const ideas = ideasOf(await go(h));
  assert.ok(ideas.some((i) => i.entity.type === 'brand'), ideas.map((i) => i.entity.type).join());
  noTyped(ideas);
});

test('popularity: a less popular candidate with no usable link does not justify dropping the very popular ones', async () => {
  const rows = withBrands([{ id: 'B-AUREL', name: 'Aurel', lead: NUJ, pop: BIG }, { id: 'B-BRISK', name: 'Brisk', lead: NUJ, pop: SMALL, plain: true }]);
  assert.deepEqual((await offeredBrands(rows)).offered, ['Aurel', 'Brisk']);
});

// ---- the tools tier survives refusals --------------------------------------------------------------------------------------
// Every refused call used to count as a strike and three ended the tier: the model never got to correct itself.

test('tools tier: four spread refusals in one turn are not strikes; the model corrects itself and the tier stays tools', async () => {
  const h = setup(
    qloo(),
    model({
      ideas: turns(
        LOOK_ALL,
        () => INSIGHTS(),
        () => ['B-AUREL', 'B-BRISK', 'K-FABLE', 'A-HALDEN', 'P-JUNO', 'B-CORVO'].map((id) => find(id, id)), // five led by Nujabes, one by Muji: only the first and the last fit
        () => [find('K-GLASS', 'Glass Orchard'), find('A-AMBER', 'Amber Quill'), find('P-KESTREL', 'Kestrel Cafe')],
      ),
    }),
  );
  const ev = await go(h);
  const ideas = ideasOf(ev);
  assert.equal(ev.at(-1).tier, 'tools');
  assert.equal(ideas.length, 5);
  assert.ok(leads(ideas).size >= 2 && most(ideas) <= 2, ideas.map((i) => i.entity.name).join());
});

test('tools tier: qloo_insights called in the same turn as the searches waits for them instead of failing for lack of seeds', async () => {
  const q = qloo();
  const h = setup(q, model({ ideas: turns(() => [...LOOK_ALL(), ...INSIGHTS()], () => [find('B-CORVO', 'Corvo'), find('K-GLASS', 'Glass Orchard'), find('A-AMBER', 'Amber Quill'), find('P-KESTREL', 'Kestrel Cafe')]) }));
  const ev = await go(h);
  assert.equal(ev.at(-1).tier, 'tools');
  assert.equal(ideasOf(ev).length, 4);
  assert.equal(q.asked.length, 4, 'one insights request per type');
  for (const u of q.asked) assert.deepEqual(u.searchParams.get('signal.interests.entities')!.split(',').sort(), [KAFKA, MUJI, NUJ]);
});

test('tools tier: three calls with ids Qloo never returned still end the tier (an invented id is a strike, a refusal is not)', async () => {
  const h = setup(qloo(), model({ ideas: turns(LOOK_ALL, () => INSIGHTS(), () => ['X-1', 'X-2', 'X-3'].map((id) => find(id, id))) }));
  const ev = await go(h);
  assert.equal(ev.at(-1).tier, 'pipeline');
  assert.ok(ideasOf(ev).length >= 4);
});

// ---- one place or trip per run ---------------------------------------------------------------------------------------------

const TRIPS: Record<string, Row[]> = { ...ROWS, destination: [{ id: 'D-OSLO', name: 'Oslo', lead: MUJI }, { id: 'D-PORTO', name: 'Porto', lead: KAFKA }] };
const trips = (ideas: any[]) => ideas.filter((i) => i.entity.type === 'place' || i.entity.type === 'destination');
/** The default fake web search answers every place with the same links, so a second place would never get cards of its own: give each its own. */
const ownLinks = (h: ReturnType<typeof setup>) => {
  const before = h.net.intercept!;
  h.net.intercept = (path, init) => {
    if (path !== '/search') return before(path, init);
    const q = String(JSON.parse(String(init?.body)).query);
    return json({ results: [0, 1, 2].map((k) => ({ title: `${q.slice(0, 40)} page ${k}`, url: `https://tours-${k}.example/${q.replace(/\W+/g, '-')}`, content: `About ${q.slice(0, 30)}. Tickets from $${20 + k}.`, raw_content: `# ${q}\nPrice $${20 + k}.00` })) });
  };
  return h;
};

test('trips: the tools tier refuses a second place or destination while other candidates are available', async () => {
  let refused: any[] = [];
  const h = ownLinks(setup(
    qloo(TRIPS),
    model({
      ideas: turns(
        LOOK_ALL,
        () => INSIGHTS(['brand', 'book', 'artist', 'place', 'destination']),
        () => [find('P-JUNO', 'Juno Park'), find('P-KESTREL', 'Kestrel Cafe'), find('D-OSLO', 'Oslo'), find('K-GLASS', 'Glass Orchard')],
        (a) => ((refused = [a['f-P-KESTREL'], a['f-D-OSLO']]), [find('B-CORVO', 'Corvo'), find('A-AMBER', 'Amber Quill')]),
      ),
    }),
  ));
  const ideas = ideasOf(await go(h));
  for (const r of refused) assert.match(r?.error ?? JSON.stringify(r), /at most 1 place or trip.*for example [^()]+ \([A-Z]-[A-Z]+\)/, 'the refusal says what would fit');
  assert.equal(refused.length, 2);
  assert.ok(ideas.length >= 4 && trips(ideas).length === 1, ideas.map((i) => i.entity.type).join());
});

test('trips: a model that picks two places gets at most one of them', async () => {
  const h = ownLinks(setup(qloo(), model({ picks: picks((cands) => ['Juno Park', 'Kestrel Cafe', 'Aurel', 'Glass Orchard', 'Amber Quill'].map((name) => cands.find((c) => c.name === name)).filter((c) => !!c)) })));
  const ideas = ideasOf(await go(h));
  assert.ok(ideas.length >= 4 && trips(ideas).length === 1, ideas.map((i) => i.entity.name).join());
});

test('trips: a pool with only places still makes the minimum number of ideas (the rule is soft)', async () => {
  const onlyPlaces: Record<string, Row[]> = { place: [1, 2, 3, 4, 5].map((k) => ({ id: `P-${k}`, name: `Plaza ${k}`, lead: [NUJ, MUJI, KAFKA][k % 3]! })) };
  for (const ai of [modelDown, model({ picks: picks((cands, n) => cands.slice(0, n)) })]) {
    const ideas = ideasOf(await go(ownLinks(setup(qloo(onlyPlaces), ai))));
    assert.ok(ideas.length >= 4 && ideas.every((i) => i.entity.type === 'place'), `${ideas.length} ideas`);
  }
});
