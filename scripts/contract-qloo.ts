// Contract check for Qloo: at most 5 live requests, made through the same adapter code the app uses, to confirm that real
// answers parse into seeds, candidates and explainability links. Prints structure only, never keys.
// Exit code: 0 pass, 1 mismatch or error, 2 key missing (nothing was called).
import { insights, searchEntity } from '../src/adapters/qloo.ts';
import { loadConfig } from '../src/config.ts';
import type { Svc } from '../src/lib/http.ts';
import { Meter, memoryMeterApi } from '../src/lib/limits.ts';
import { memoryStore } from '../src/lib/store.ts';
import type { Env, FetchFn } from '../src/types.ts';
import { loadEnvLocal } from './lib/env.mjs';
import { recordingFetch } from './lib/shape.mjs';

export const MAX_CALLS = 5; // 2 searches + 3 insight lookups

export async function makeSvc(env: Partial<Env>, fetchFn: FetchFn, maxCalls = MAX_CALLS): Promise<Svc> {
  const cfg = loadConfig(env as Env);
  return { cfg, fetch: fetchFn, store: memoryStore(), meter: new Meter(memoryMeterApi(), cfg.limits, 'contract', 'contract'), sub: { left: maxCalls }, mocks: {} }; // sub.left is the hard stop
}

/** The checks, as [name, passed] pairs, plus the error text if a call threw. */
export async function qlooContract(svc: Svc): Promise<{ checks: [string, boolean][]; failure: string }> {
  const checks: [string, boolean][] = [];
  try {
    const artist = await searchEntity(svc, { query: 'Nujabes', type: 'artist' });
    const brand = await searchEntity(svc, { query: 'Muji', type: 'brand' });
    checks.push(['search resolves an artist', !!artist.seed], ['search resolves a brand', !!brand.seed], ['answers come from the live API', artist.via === 'live']);
    const seeds = [artist.seed, brand.seed].filter((s): s is NonNullable<typeof s> => !!s);
    if (seeds.length) {
      const found: Record<string, Awaited<ReturnType<typeof insights>>['cands']> = {};
      for (const type of ['brand', 'book', 'place']) found[type] = (await insights(svc, { type, seeds, take: 4 })).cands;
      for (const [type, cands] of Object.entries(found)) checks.push([`insights returns ${type} candidates`, cands.length > 0]);
      const all = Object.values(found).flat();
      checks.push(['explainability links at least one candidate to a loved thing', all.some((c) => c.because.length > 0)]);
      checks.push(['every explainability link names a seed we sent', all.every((c) => c.because.every((b) => seeds.some((s) => s.id === b.seedId)))]);
    }
  } catch (e) {
    return { checks, failure: e instanceof Error ? e.message : String(e) };
  }
  return { checks, failure: '' };
}

if (import.meta.main) {
  const env = loadEnvLocal(['QLOO_API_KEY']);
  if (!env.QLOO_API_KEY) {
    console.log('contract:qloo: KEY MISSING. QLOO_API_KEY is not set in tasteagent/.env.local, so no request was made.');
    console.log('The app runs on documented-shape demo data until the key appears; add the key and run this again.');
    process.exit(2);
  }
  const seen: string[] = [];
  const { checks, failure } = await qlooContract(await makeSvc({ QLOO_API_KEY: env.QLOO_API_KEY }, recordingFetch(seen)));
  console.log(`contract:qloo: ${seen.length} request(s) of at most ${MAX_CALLS}`);
  for (const s of seen) console.log('  ' + s);
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (failure) console.log('  ERROR  ' + failure.slice(0, 300));
  const pass = !failure && checks.length >= 7 && checks.every(([, ok]) => ok);
  console.log(`contract:qloo: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}
