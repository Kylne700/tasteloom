// The real meter Durable Object under wrangler dev (no billed call can happen: every billed cap is 0): 10 parallel idea runs
// from one visitor with LIMIT_IP_IDEAS=3 must give exactly 3 runs and 7 refusals. Usage: node scripts/meter-race.mjs
import { startDev } from './lib/server.mjs';
const zero = Object.fromEntries(['QLOO', 'AI', 'NEURONS', 'TAVILY', 'CHANNEL3'].flatMap((k) => [[`LIMIT_IP_${k}`, '0'], [`LIMIT_GLOBAL_${k}`, '0']]));
const srv = await startDev({ port: 8795, persist: '.wrangler/race-state', fresh: true, vars: { LIMIT_IP_IDEAS: '3', ...zero }, log: '/tmp/ta-meter-race.log' });
try {
  const body = JSON.stringify({ favorites: [{ text: 'Studio Ghibli' }, { text: 'Muji' }, { text: 'Haruki Murakami' }], budget_usd: 120 });
  const res = await Promise.all(Array.from({ length: 10 }, () => fetch(srv.base + '/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json' }, body })));
  const codes = res.map((r) => r.status);
  const ends = await Promise.all(res.map(async (r) => (r.status === 200 ? JSON.parse((await r.text()).trim().split('\n').at(-1)).code ?? 'done' : (await r.json()).error.code)));
  const status = await (await fetch(srv.base + '/api/status')).json();
  const h = (await fetch(srv.base + '/api/status')).headers;
  console.log(JSON.stringify({ ok: codes.filter((c) => c === 200).length, refused: codes.filter((c) => c === 429).length, other: codes.filter((c) => c !== 200 && c !== 429), ends: [...new Set(ends)], usage: status.usage, csp: h.get('content-security-policy'), nosniff: h.get('x-content-type-options') }));
  const t = await fetch(srv.base + '/api/ideas', { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
  console.log('text/plain post:', t.status);
} finally {
  srv.stop();
}
