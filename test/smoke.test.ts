import test from 'node:test';
import { makeHarness, readEvents, FAVS } from './helpers.ts';

test('smoke: ideas stream', async () => {
  const h = makeHarness();
  const res = await h.post('/api/ideas', { favorites: FAVS, budget_usd: 120 });
  console.log('status', res.status);
  const ev = await readEvents(res);
  for (const e of ev) console.log(JSON.stringify(e).slice(0, 230));
  console.log('calls', h.net.calls.map((c) => c.host).join(','));
});
