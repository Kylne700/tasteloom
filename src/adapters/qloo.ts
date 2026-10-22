// Qloo Taste AI (hackathon API, https://hackathon.api.qloo.com). Calls follow the public docs (docs.qloo.com). Shapes seen live on 2026-10-22:
//   GET /search?query=<text>&types=urn:entity:<type>&take=3
//       -> { results: [ { name, entity_id, types: ['urn:entity:<type>'], properties, popularity, disambiguation, tags } ] }   (no success flag)
//   GET /v2/insights?filter.type=urn:entity:<type>&signal.interests.entities=<id,id>&feature.explainability=true&take=<n>
//       -> { success, results: { entities: [ { name, entity_id, type: 'urn:entity', subtype: 'urn:entity:<type>', properties, popularity, tags,
//            query: { affinity, measurements, explainability: { 'signal.interests.entities': [ { entity_id, score } ] } } } ] },
//            query: { explainability: { 'signal.interests.entities': { effect_on_top3_recs, ... } } } }
// Answers are large (8-15 KB for 3 search hits, about 70 KB for 4 insight entities); only ids, names, types and the per-entity scores are read.
// `npm run contract:qloo` re-checks this against the live API. src/mocks/qloo-fake.ts answers in the same shapes with invented data.
// Qloo output is never committed; a parsed result may sit in KV for at most 24 hours (Qloo's terms).
import { QLOO_BASE } from '../config.ts';
import { cached, callJson, type Svc } from '../lib/http.ts';
import { asObject } from '../lib/json.ts';
import type { Candidate, Seed } from '../types.ts';

/** Valid `filter.type` values for /v2/insights (from the docs). */
export const INSIGHT_TYPES = ['artist', 'book', 'brand', 'destination', 'movie', 'person', 'place', 'podcast', 'tv_show', 'video_game'] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];
/** Types that make sense as gift sources (games, films and shows still work as favourites, they are just not shopped for). */
export const GIFT_TYPES: InsightType[] = ['brand', 'book', 'artist', 'place', 'destination'];

const shortType = (u: unknown): string => String(u ?? '').replace(/^urn:entity:/, '');

function entityList(json: unknown): Record<string, unknown>[] {
  const r = asObject(json)?.results;
  const list = Array.isArray(r) ? r : Array.isArray(asObject(r)?.entities) ? (asObject(r)!.entities as unknown[]) : [];
  return list.map(asObject).filter((x): x is Record<string, unknown> => !!x);
}

function entityId(e: Record<string, unknown>): string {
  return String(e.entity_id ?? e.id ?? '');
}

/** Search hits list `types: ['urn:entity:artist']`; insight entities say `type: 'urn:entity'` and name the kind in `subtype`. */
function entityType(e: Record<string, unknown>, prefer?: string): string {
  const types = [...(Array.isArray(e.types) ? e.types : []), e.subtype, e.type].map(shortType).filter((t) => t && !t.startsWith('urn:'));
  return prefer && types.includes(prefer) ? prefer : (types[0] ?? prefer ?? 'unknown');
}

export function parseSearch(json: unknown, wantedType?: string): Seed[] {
  const out: Seed[] = [];
  for (const e of entityList(json)) {
    const id = entityId(e);
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (id && name) out.push({ id, name: name.slice(0, 80), type: entityType(e, wantedType) });
  }
  return out;
}

/**
 * Live shape: `{ 'signal.interests.entities': [ { entity_id, score } ] }` (scores add up to about 1 over the seeds). A map {seedId: score}
 * and other nestings are accepted too. Ids that are not one of our seeds are dropped.
 */
export function parseExplainability(x: unknown, seeds: Seed[]): { seedId: string; score: number }[] {
  const byId = new Map(seeds.map((s) => [s.id, s]));
  const byName = new Map(seeds.map((s) => [s.name.toLowerCase(), s]));
  const best = new Map<string, number>();
  const add = (key: unknown, score: unknown) => {
    const k = String(key);
    const s = byId.get(k) ?? byName.get(k.toLowerCase());
    const n = Number(score);
    if (s && Number.isFinite(n) && n > 0) best.set(s.id, Math.max(best.get(s.id) ?? 0, n));
  };
  const walk = (v: unknown, depth: number) => {
    if (v == null || depth > 5) return;
    if (Array.isArray(v)) {
      for (const it of v) {
        const o = asObject(it);
        if (!o) continue;
        const idLike = o.entity_id ?? o.id ?? o.name ?? asObject(o.entity)?.entity_id ?? asObject(o.entity)?.name;
        const scoreLike = o.score ?? o.weight ?? o.contribution ?? o.value ?? o.affinity;
        if (idLike !== undefined && scoreLike !== undefined) add(idLike, scoreLike);
        else walk(o, depth + 1);
      }
      return;
    }
    const o = asObject(v);
    if (!o) return;
    for (const [k, val] of Object.entries(o)) {
      if (typeof val === 'number') add(k, val);
      else walk(val, depth + 1);
    }
  };
  walk(x, 0);
  return [...best].map(([seedId, score]) => ({ seedId, score })).sort((a, b) => b.score - a.score);
}

export function parseInsights(json: unknown, seeds: Seed[], type: string): Candidate[] {
  const out: Candidate[] = [];
  for (const e of entityList(json)) {
    const id = entityId(e);
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!id || !name) continue;
    const q = asObject(e.query);
    const raw = q?.explainability ?? e.explainability;
    const because = parseExplainability(raw, seeds);
    out.push({ id, name: name.slice(0, 80), type: entityType(e, type), because, explained: because.length > 0 });
  }
  return out;
}

export async function searchEntity(svc: Svc, q: { query: string; type?: string }): Promise<{ seed: Seed | null; via: 'live' | 'mock' | 'cache' }> {
  const type = q.type && (INSIGHT_TYPES as readonly string[]).includes(q.type) ? q.type : undefined;
  const params = new URLSearchParams({ query: q.query.slice(0, 100), take: '3' });
  if (type) params.set('types', `urn:entity:${type}`);
  const run = async () => {
    const r = await callJson(svc, 'qloo', `${QLOO_BASE}/search?${params}`, { headers: { 'X-Api-Key': svc.cfg.keys.qloo ?? 'mock', Accept: 'application/json' } }, 15000);
    return { seeds: parseSearch(r.json, type), via: r.via };
  };
  const { value, hit } = await cached(svc, 'qloo', { search: params.toString() }, 24 * 3600, run);
  return { seed: value.seeds[0] ?? null, via: hit ? 'cache' : value.via };
}

export async function insights(svc: Svc, q: { type: string; seeds: Seed[]; take?: number }): Promise<{ cands: Candidate[]; via: 'live' | 'mock' | 'cache' }> {
  const params = new URLSearchParams({
    'filter.type': `urn:entity:${q.type}`,
    'signal.interests.entities': q.seeds.map((s) => s.id).join(','),
    'feature.explainability': 'true',
    take: String(q.take ?? 8),
  });
  const run = async () => {
    const r = await callJson(svc, 'qloo', `${QLOO_BASE}/v2/insights?${params}`, { headers: { 'X-Api-Key': svc.cfg.keys.qloo ?? 'mock', Accept: 'application/json' } }, 20000);
    return { cands: parseInsights(r.json, q.seeds, q.type), via: r.via };
  };
  const { value, hit } = await cached(svc, 'qloo', { insights: params.toString() }, 24 * 3600, run);
  return { cands: value.cands, via: hit ? 'cache' : value.via };
}
