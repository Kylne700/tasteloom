// Qloo Taste AI (hackathon API). Calls follow the public docs (docs.qloo.com), parsed defensively:
//   GET /search?query=<text>&types=urn:entity:<type>            -> { success, duration, results: [ { entity_id, name, types, ... } ] }
//   GET /v2/insights?filter.type=urn:entity:<type>
//       &signal.interests.entities=<id,id>&feature.explainability=true&take=<n>
//                                                               -> { success, results: { entities: [ { entity_id, name, types, query: { affinity, explainability } } ], duration } }
// NOT VERIFIED without a key: exact entity field names and the explainability shape (docs say "which seed entities contributed, normalized 0-1").
// `npm run contract:qloo` prints the real shape once QLOO_API_KEY exists. While the key is missing, src/mocks/qloo-fake.ts answers with
// the same shapes and the UI shows a "demo data" badge. Qloo response data is never stored in this repository.
import { QLOO_BASE } from '../config.ts';
import { cached, callJson, type Svc } from '../lib/http.ts';
import { asObject } from '../lib/json.ts';
import type { Candidate, Seed } from '../types.ts';

/** Valid `filter.type` values for /v2/insights (from the docs). */
export const INSIGHT_TYPES = ['artist', 'book', 'brand', 'destination', 'movie', 'person', 'place', 'podcast', 'tv_show', 'video_game'] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];
/** Types that make sense as gift sources. */
export const GIFT_TYPES: InsightType[] = ['brand', 'book', 'artist', 'video_game', 'place', 'destination'];

const shortType = (u: unknown): string => String(u ?? '').replace(/^urn:entity:/, '');

function entityList(json: unknown): Record<string, unknown>[] {
  const r = asObject(json)?.results;
  const list = Array.isArray(r) ? r : Array.isArray(asObject(r)?.entities) ? (asObject(r)!.entities as unknown[]) : [];
  return list.map(asObject).filter((x): x is Record<string, unknown> => !!x);
}

function entityId(e: Record<string, unknown>): string {
  return String(e.entity_id ?? e.id ?? '');
}

function entityType(e: Record<string, unknown>, prefer?: string): string {
  const types = Array.isArray(e.types) ? e.types.map(shortType) : e.type ? [shortType(e.type)] : [];
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

/** Explainability can be a map {seedId: score}, an array of {entity_id|id|name, score|weight}, or nested in either. Unknown ids are dropped. */
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
