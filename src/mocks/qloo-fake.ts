// Fake Qloo server for demos and tests while QLOO_API_KEY is missing. It answers with the documented response shapes
// ({success, duration, results} for /search; {success, results:{entities, duration}} for /v2/insights, each entity with
// query.explainability as a map seed-id -> score), so the real parser in adapters/qloo.ts runs unchanged.
// The data is invented demo data: names of well-known works and places, picked deterministically from the request.
import { fnv, sleep, titleCase } from '../lib/util.ts';

const CATALOG: Record<string, string[]> = {
  brand: ['Muji', 'Moleskine', 'Leuchtturm1917', 'Field Notes', 'Hario', 'Fellow', 'Lodge', 'Aesop', 'Kinto', 'Peak Design'],
  book: ['Kafka on the Shore', 'Piranesi', 'The Overstory', 'Braiding Sweetgrass', 'Norwegian Wood', 'Station Eleven', 'Klara and the Sun', 'A Gentleman in Moscow'],
  video_game: ['Stardew Valley', 'Hades', 'Hollow Knight', 'Celeste', 'Outer Wilds', 'Journey', 'Animal Crossing: New Horizons'],
  artist: ['Nujabes', 'Khruangbin', 'Bill Evans', 'Joe Hisaishi', 'Nils Frahm', 'Norah Jones', 'Hiromi', 'Bonobo'],
  place: ['teamLab Planets', 'Ghibli Museum', 'Shakespeare and Company', 'Kew Gardens', 'The Morgan Library', 'Powell’s Books'],
  destination: ['Kyoto', 'Lisbon', 'Hokkaido', 'Edinburgh', 'Oaxaca', 'Reykjavik'],
  movie: ['Spirited Away', 'Perfect Days', 'Paterson', 'Lost in Translation', 'Amelie'],
  tv_show: ['Midnight Diner', 'Terrace House', 'The Great British Bake Off'],
  podcast: ['Radiolab', '99% Invisible'],
  person: ['Haruki Murakami', 'Hayao Miyazaki'],
};

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
    if (!query) return json({ success: true, duration: 3, results: [] });
    const asked = shortType(url.searchParams.get('types'));
    // known names resolve to their catalog type and spelling; anything else becomes a brand (or the asked type) with a title-cased name
    const known = (asked ? [asked] : Object.keys(CATALOG)).flatMap((t) => (CATALOG[t] ?? []).filter((n) => n.toLowerCase() === query.toLowerCase()).map((n) => ({ t, n })))[0];
    const type = known?.t ?? (asked || 'brand');
    const name = known?.n ?? titleCase(query);
    const id = 'MOCK' + fnv(name.toLowerCase() + type).toString(16).toUpperCase().padStart(8, '0');
    return json({
      success: true,
      duration: 7,
      results: [{ entity_id: id, name, types: [`urn:entity:${type}`], popularity: 0.5, disambiguation: 'demo data' }],
    });
  }
  if (url.pathname === '/v2/insights') {
    const type = shortType(url.searchParams.get('filter.type'));
    const list = CATALOG[type];
    if (!list || !list.length) return json({ success: false, message: 'invalid filter.type' }, 400);
    const seeds = (url.searchParams.get('signal.interests.entities') ?? '').split(',').filter(Boolean);
    const take = Math.min(Number(url.searchParams.get('take')) || 8, 12);
    const salt = seeds.join('|');
    const picked = [...list].map((n) => ({ n, k: fnv(salt + n) })).sort((a, b) => a.k - b.k).slice(0, take);
    const entities = picked.map(({ n, k }, rank) => {
      // explainability: weights over a few of the seeds, normalized to sum 1
      const chosen = seeds.filter((s) => fnv(s + n) % 3 !== 0);
      const use = (chosen.length ? chosen : seeds).slice(0, 3);
      const w = use.map((s) => 1 + (fnv(n + s) % 5));
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      const explainability: Record<string, number> = {};
      use.forEach((s, i) => (explainability[s] = Math.round((w[i]! / sum) * 100) / 100));
      return {
        entity_id: 'MOCK' + fnv(n.toLowerCase() + type).toString(16).toUpperCase().padStart(8, '0'),
        name: n,
        types: [`urn:entity:${type}`],
        query: { affinity: Math.round((0.95 - rank * 0.04) * 100) / 100, explainability },
      };
    });
    return json({ success: true, results: { entities, duration: 12 } });
  }
  return json({ success: false, message: 'not found' }, 404);
}
