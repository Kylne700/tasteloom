// Fake Qloo server for demos and tests while QLOO_API_KEY is missing. It answers in the shapes the live API was seen to use on
// 2026-10-22 (see the header of adapters/qloo.ts; `npm run contract:qloo` re-checks them), so the real parser runs unchanged:
// /search -> { results: [ { name, entity_id, types, properties, popularity, disambiguation, tags } ] } and /v2/insights ->
// { success, results: { entities: [ { type: 'urn:entity', subtype, query: { affinity, measurements, explainability: { 'signal.interests.entities':
// [ { entity_id, score } ] } } } ] }, query: { explainability: { 'signal.interests.entities': { effect_on_top3_recs, ... } } } }.
// The data is invented demo data, not Qloo output: well-known works and places, each with a few theme tags (sent as Qloo-shaped tag objects).
// Entities that share tags with the favourites rank higher and the explainability weights follow the shared tags, so "because they love X"
// reads plausibly; the top favourite shares a tag with the entity except when no favourite shares any (then Qloo's link stands alone).
import { fnv, sleep, titleCase } from '../lib/util.ts';

const CATALOG: Record<string, [name: string, tags: string][]> = {
  brand: [
    ['Muji', 'japan design calm stationery'], ['Moleskine', 'stationery reading travel'], ['Leuchtturm1917', 'stationery reading craft'],
    ['Field Notes', 'stationery craft nature'], ['Hario', 'coffee japan craft'], ['Fellow', 'coffee design'], ['Lodge', 'cozy nature craft'],
    ['Aesop', 'design calm'], ['Kinto', 'japan coffee design'], ['Peak Design', 'travel nature design'],
  ],
  book: [
    ['Kafka on the Shore', 'japan reading music'], ['Piranesi', 'reading art calm'], ['The Overstory', 'nature reading'],
    ['Braiding Sweetgrass', 'nature calm reading'], ['The Housekeeper and the Professor', 'japan reading calm'], ['Station Eleven', 'reading music travel'],
    ['Klara and the Sun', 'reading calm'], ['A Gentleman in Moscow', 'reading travel cozy'],
  ],
  video_game: [
    ['Stardew Valley', 'cozy games nature craft'], ['Hades', 'games art music'], ['Hollow Knight', 'games art'], ['Celeste', 'games music calm'],
    ['Outer Wilds', 'games nature'], ['Journey', 'games calm art music'], ['Animal Crossing: New Horizons', 'cozy games nature'],
  ],
  artist: [
    ['Nujabes', 'japan music calm'], ['Khruangbin', 'music travel'], ['Bill Evans', 'music calm'], ['Joe Hisaishi', 'japan music film'],
    ['Nils Frahm', 'music calm'], ['Norah Jones', 'music cozy'], ['Ryuichi Sakamoto', 'japan music calm'], ['Bonobo', 'music travel'],
  ],
  place: [
    ['teamLab Planets', 'japan art'], ['Ghibli Museum', 'japan film art'], ['Shakespeare and Company', 'reading travel'],
    ['Kew Gardens', 'nature calm'], ['The Morgan Library', 'reading art'], ['Powell’s Books', 'reading cozy'],
  ],
  destination: [
    ['Kyoto', 'japan calm nature'], ['Lisbon', 'travel coffee'], ['Hokkaido', 'japan nature'], ['Edinburgh', 'reading travel'],
    ['Oaxaca', 'craft travel'], ['Reykjavik', 'nature travel'],
  ],
  movie: [
    ['Spirited Away', 'japan film art'], ['Perfect Days', 'japan film calm'], ['Paterson', 'reading film calm'],
    ['Lost in Translation', 'japan film travel'], ['Amelie', 'film travel coffee'],
  ],
  tv_show: [['Midnight Diner', 'japan cozy'], ['Terrace House', 'japan'], ['The Great British Bake Off', 'cozy craft']],
  podcast: [['Radiolab', 'calm'], ['99% Invisible', 'design']],
  person: [['Haruki Murakami', 'japan reading music'], ['Hayao Miyazaki', 'japan film art']],
};
const VOCAB = ['japan', 'coffee', 'cozy', 'calm', 'music', 'reading', 'stationery', 'nature', 'design', 'travel', 'craft', 'art', 'film', 'games'];

const idOf = (name: string, type: string) => 'MOCK' + fnv(name.toLowerCase() + type).toString(16).toUpperCase().padStart(8, '0');
/** id -> tags for catalog entities; anything else (a favourite the user typed) gets two stable pseudo-random tags */
const KNOWN = new Map<string, Set<string>>();
for (const [type, list] of Object.entries(CATALOG)) for (const [name, tags] of list) KNOWN.set(idOf(name, type), new Set(tags.split(' ')));
const tagsOfId = (id: string) => KNOWN.get(id) ?? new Set([VOCAB[fnv(id) % VOCAB.length]!, VOCAB[fnv(id + 'b') % VOCAB.length]!]);
/** invented tags in the shape Qloo uses: { id, name, type: 'urn:tag:<kind>:qloo' } (the real ones come in many kinds; the fake sends one kind that the parser keeps) */
const tagObjects = (words: Iterable<string>) => [...words].map((w) => ({ id: 'MOCKTAG' + fnv(w).toString(16).toUpperCase(), name: titleCase(w), type: 'urn:tag:theme:qloo' }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const shortType = (u: string | null) => (u ?? '').replace(/^urn:entity:/, '').split(',')[0] ?? '';

export function makeQlooFake(opts: { delayMs?: number } = {}) {
  return async function qlooFake(input: string, _init?: RequestInit): Promise<Response> {
    if (opts.delayMs) await sleep(opts.delayMs); // paces the demo so the step list is readable
    return answer(input);
  };
}
export const qlooFake = makeQlooFake();

function answer(input: string): Response {
  const url = new URL(input);
  if (url.pathname === '/search') {
    const query = (url.searchParams.get('query') ?? '').trim();
    if (!query) return json({ results: [] });
    const asked = shortType(url.searchParams.get('types'));
    const q = query.toLowerCase();
    // a typed name resolves to the catalog entity it equals or contains ("Hario V60" -> Hario), like Qloo's entity matching
    const known = (asked ? [asked] : Object.keys(CATALOG)).flatMap((t) =>
      (CATALOG[t] ?? []).filter(([n]) => n.toLowerCase() === q || (n.length >= 4 && q.includes(n.toLowerCase()))).map(([n]) => ({ t, n })),
    )[0];
    const type = known?.t ?? (asked || 'brand');
    const name = known?.n ?? titleCase(query);
    return json({
      results: [{ name, entity_id: idOf(name, type), types: [`urn:entity:${type}`], properties: { short_description: 'demo data' }, popularity: 0.5, disambiguation: 'demo data', tags: tagObjects(tagsOfId(idOf(name, type))) }],
    });
  }
  if (url.pathname === '/v2/insights') {
    const type = shortType(url.searchParams.get('filter.type'));
    const list = CATALOG[type];
    if (!list || !list.length) return json({ success: false, message: 'invalid filter.type' }, 400);
    const seeds = (url.searchParams.get('signal.interests.entities') ?? '').split(',').filter(Boolean);
    const take = Math.min(Number(url.searchParams.get('take')) || 8, 12);
    const salt = seeds.join('|');
    const ranked = list
      .map(([name, tags]) => {
        const id = idOf(name, type);
        const mine = new Set(tags.split(' '));
        const shared = seeds.map((s) => ({ s, n: [...tagsOfId(s)].filter((t) => mine.has(t)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
        return { name, id, shared, total: shared.reduce((a, b) => a + b.n, 0), k: fnv(salt + name) };
      })
      .sort((a, b) => b.total - a.total || a.k - b.k)
      .slice(0, take);
    const entities = ranked.map(({ name, id, shared, total, k }) => {
      // explainability: weights over the favourites that share the most themes with this entity, normalized to sum 1
      const use = shared.length ? shared.slice(0, 3) : seeds.slice(k % Math.max(seeds.length, 1)).slice(0, 1).map((s) => ({ s, n: 1 }));
      const sum = use.reduce((a, b) => a + b.n, 0) || 1;
      const links = use.map((u) => ({ entity_id: u.s, score: Math.round((u.n / sum) * 100) / 100 }));
      return {
        name,
        entity_id: id,
        type: 'urn:entity',
        subtype: `urn:entity:${type}`,
        properties: { short_description: 'demo data' },
        popularity: 0.5,
        tags: tagObjects(tagsOfId(id)),
        query: { affinity: Math.min(0.97, Math.round((0.5 + 0.06 * total) * 100) / 100), measurements: { audience_growth: 0 }, explainability: { 'signal.interests.entities': links } },
        disambiguation: 'demo data',
        external: {},
      };
    });
    // the live answer also sums the seeds' effect over the top results; the parser ignores it, so the fake keeps it to prove that
    const effect = seeds.map((s) => ({ entity_id: s, avg_score: Math.round(100 / seeds.length) / 100 }));
    const overall = { effect_on_top3_recs: effect, effect_on_top5_recs: effect, effect_on_top10_recs: effect, effect_on_all_recs: effect };
    return json({ success: true, results: { entities }, query: { explainability: { 'signal.interests.entities': overall } } });
  }
  return json({ success: false, message: 'not found' }, 404);
}
