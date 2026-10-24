// Spend and abuse limits, configuration and privacy of the counters.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { groundedReason } from '../src/agent/ideas.ts';
import { LIMIT_MESSAGE } from '../src/app.ts';
import { loadConfig, publicStatus, secretsOf } from '../src/config.ts';
import { LimitError, Meter, memoryMeterApi, visitorOf, type MeterApi } from '../src/lib/limits.ts';
import type { Env } from '../src/types.ts';
import { FAVS, fakeAi, fakeMeter, makeHarness, readEvents, watchWrites } from './helpers.ts';

const DAY = '2026-10-16';
const lim = (env: Partial<Env> = {}) => loadConfig(env as Env).limits;

const meter = (env: Partial<Env> = {}, api: MeterApi = memoryMeterApi(), visitor = 'ipA', day = DAY) => new Meter(api, lim(env), visitor, day);

test('meter: per-IP limit, then global limit, each with its own scope', async () => {
  const api = memoryMeterApi();
  const env = { LIMIT_IP_IDEAS: '2', LIMIT_GLOBAL_IDEAS: '3' };
  const a = meter(env, api, 'ipA');
  await a.take({ ideas: 1 });
  await a.take({ ideas: 1 });
  await assert.rejects(a.take({ ideas: 1 }), (e) => e instanceof LimitError && e.scope === 'ip' && e.counter === 'ideas');
  const b = meter(env, api, 'ipB');
  await b.take({ ideas: 1 }); // global 3 of 3
  await assert.rejects(b.take({ ideas: 1 }), (e) => e instanceof LimitError && e.scope === 'global', 'B is under its own 2, but the global 3 is used up');
  await assert.rejects(meter(env, api, 'ipC').take({ ideas: 1 }), (e) => e instanceof LimitError && e.scope === 'global');
});

test('meter: a take that would pass any cap is refused whole and changes nothing', async () => {
  const m = meter({ LIMIT_IP_TAVILY: '5' });
  await m.take({ tavily: 3 });
  await assert.rejects(m.take({ tavily: 3 }), LimitError);
  await assert.rejects(m.take({ ai: 1, neurons: 10_000_000 }), (e) => e instanceof LimitError && e.counter === 'neurons' && e.scope === 'ip');
  const u = await m.used();
  assert.deepEqual([u.ip.tavily, u.ip.ai, u.global.neurons], [3, undefined, undefined]);
  await m.take({ tavily: 2 });
  assert.equal((await m.used()).global.tavily, 5);
});

test('meter: the daily money cap can be reserved and given back, never below zero', async () => {
  const m = meter({ LIMIT_DAILY_CAP_USD: '10' });
  await m.take({ cents: 600 });
  await assert.rejects(m.take({ cents: 401 }), (e) => e instanceof LimitError && e.counter === 'cents' && e.scope === 'global');
  await m.take({ cents: 400 });
  await m.give({ cents: 400 });
  await m.take({ cents: 400 });
  await m.give({ cents: 99999 });
  assert.equal((await m.used()).global.cents, 0);
});

test('meter: counters are kept per visitor and per day; a new day starts empty and days never go back', async () => {
  const api = memoryMeterApi();
  const NEXT = '2026-10-17';
  await meter({}, api, 'v1').take({ channel3: 1 });
  await meter({}, api, 'v1').take({ channel3: 1 });
  assert.equal((await meter({}, api, 'v1').used()).ip.channel3, 2);
  assert.equal((await meter({}, api, 'v2').used()).ip.channel3, undefined);
  assert.deepEqual(await meter({}, api, 'v1', NEXT).used(), { ip: {}, global: {} });
  await meter({}, api, 'v1', NEXT).take({ channel3: 1 });
  await meter({}, api, 'v3', DAY).take({ channel3: 1 }); // a request stamped yesterday that arrives after the new day began
  assert.deepEqual((await meter({}, api, 'v1', NEXT).used()).global, { channel3: 2 });
});

test('meter: when the meter cannot be reached every take is refused (fail closed); give and used never throw', async () => {
  const down = async () => {
    throw new Error('meter unreachable');
  };
  for (const api of [undefined, { take: down, give: down, used: down }]) {
    const m = new Meter(api, lim(), 'ip', DAY);
    await assert.rejects(m.take({ channel3: 1 }), (e) => e instanceof LimitError && e.counter === 'channel3' && e.scope === 'global');
    await m.give({ cents: 100 });
    assert.deepEqual(await m.used(), { ip: {}, global: {} });
  }
});

test('meter: ensure only looks: it refuses what a take would refuse, reserves nothing, and stays quiet when the meter cannot be reached', async () => {
  const api = memoryMeterApi();
  const env = { LIMIT_IP_QLOO: '10', LIMIT_GLOBAL_QLOO: '12' };
  const m = meter(env, api);
  await m.take({ qloo: 3 });
  await m.ensure({ qloo: 7 });
  await assert.rejects(m.ensure({ qloo: 8 }), (e) => e instanceof LimitError && e.counter === 'qloo' && e.scope === 'ip');
  await meter(env, api, 'ipB').take({ qloo: 8 }); // global 11 of 12
  await assert.rejects(meter(env, api, 'ipC').ensure({ qloo: 2 }), (e) => e instanceof LimitError && e.counter === 'qloo' && e.scope === 'global');
  const u = await m.used();
  assert.deepEqual([u.ip.qloo, u.global.qloo], [3, 11], 'nothing was reserved');
  const down = async () => {
    throw new Error('meter unreachable');
  };
  await new Meter({ take: down, give: down, used: down }, lim(), 'ip', DAY).ensure({ qloo: 5 }); // the takes that follow still fail closed
});

test('meter: an IPv6 visitor is its /64; IPv4 is the address', () => {
  assert.equal(visitorOf('2001:db8:1:2::1'), '2001:db8:1:2');
  assert.equal(visitorOf('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2');
  assert.equal(visitorOf('2001:db8::7'), '2001:db8:0:0');
  assert.equal(visitorOf('::1'), '0:0:0:0');
  assert.equal(visitorOf('203.0.113.9'), '203.0.113.9');
  assert.equal(visitorOf('::ffff:203.0.113.9'), '::ffff:203.0.113.9');
});

// ---- configuration -----------------------------------------------------------------------------------------------

test('config: documented defaults', () => {
  const l = lim();
  assert.deepEqual([l.maxItems, l.minBudgetCents, l.maxBudgetCents, l.dailyCapCents], [6, 1000, 50000, 200000]);
  assert.deepEqual(l.ip, { ideas: 8, qloo: 60, ai: 80, neurons: 1500, tavily: 20, channel3: 24, orders: 8, returns: 20 });
  assert.deepEqual(l.global, { ideas: 100, qloo: 600, ai: 600, neurons: 8000, tavily: 25, channel3: 25, orders: 100, returns: 150 });
});

test('config: every cap is set in wrangler.jsonc (a deploy replaces dashboard vars) and equals the default in code', () => {
  const vars = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).vars as Record<string, string>;
  const d = lim();
  const names = [...Object.keys(d.ip).map((k) => `LIMIT_IP_${k.toUpperCase()}`), ...Object.keys(d.global).map((k) => `LIMIT_GLOBAL_${k.toUpperCase()}`), 'LIMIT_DAILY_CAP_USD', 'LIMIT_MAX_ITEMS', 'LIMIT_MAX_BUDGET_USD'];
  for (const n of names) assert.equal(typeof vars[n], 'string', `${n} is missing in wrangler.jsonc vars`);
  assert.deepEqual(Object.keys(vars).filter((n) => !names.includes(n)), [], 'a var that nothing reads');
  assert.deepEqual(lim(vars as Partial<Env>), d, 'the file and the defaults in src/config.ts disagree');
});

test('config: overrides apply, junk falls back to the default', () => {
  const l = lim({ LIMIT_MAX_ITEMS: '3', LIMIT_MAX_BUDGET_USD: '120', LIMIT_DAILY_CAP_USD: '12.5', LIMIT_IP_IDEAS: 'lots', LIMIT_GLOBAL_IDEAS: '-4', LIMIT_IP_TAVILY: '' });
  assert.deepEqual([l.maxItems, l.maxBudgetCents, l.dailyCapCents, l.ip.ideas, l.global.ideas, l.ip.tavily], [3, 12000, 1250, 8, 100, 20]);
});

test('config: Qloo and the model switch from mock to live by themselves when the key or the AI binding appears; FORCE_MOCK overrides', () => {
  const ai = fakeAi();
  const none = loadConfig({} as Env);
  assert.deepEqual([none.qloo, none.ai, none.tavily, none.channel3, none.paypal], ['mock', 'mock', 'off', 'off', 'off']);
  const keyed = loadConfig({ QLOO_API_KEY: 'q-key', AI: ai, TAVILY_API_KEY: 't', CHANNEL3_API_KEY: 'c', PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's' } as Env);
  assert.deepEqual([keyed.qloo, keyed.ai, keyed.tavily, keyed.channel3, keyed.paypal], ['live', 'live', 'live', 'live', 'live']);
  assert.deepEqual(publicStatus(keyed).mocks, []);
  assert.deepEqual(publicStatus(loadConfig({ QLOO_API_KEY: 'q-key', AI: ai, FORCE_MOCK: 'qloo, ai' } as Env)).mocks, ['qloo', 'ai']);
  assert.equal(loadConfig({ PAYPAL_CLIENT_ID: 'only-id' } as Env).paypal, 'off');
  assert.equal(loadConfig({ QLOO_API_KEY: '   ' } as Env).qloo, 'mock');
});

test('config: the public status carries modes and budget bounds, never a key', () => {
  const env = { QLOO_API_KEY: 'q-secret-111', AI: fakeAi(), TAVILY_API_KEY: 't-secret-333', CHANNEL3_API_KEY: 'c-secret-444', PAYPAL_CLIENT_ID: 'id-secret-555', PAYPAL_CLIENT_SECRET: 's-secret-666' } as Env;
  const cfg = loadConfig(env);
  const text = JSON.stringify(publicStatus(cfg));
  for (const k of secretsOf(cfg)) assert.ok(k && !text.includes(k));
  assert.deepEqual(publicStatus(cfg).budget, { min_cents: 1000, max_cents: 50000, max_items: 6 });
});

test('config: deploy-time --var values arrive as strings and set the shared Channel3 and Tavily caps, which the public status shows', () => {
  const dflt = publicStatus(loadConfig({} as Env)).caps;
  assert.deepEqual([dflt.channel3, dflt.tavily], [25, 25]);
  const set = publicStatus(loadConfig({ LIMIT_GLOBAL_CHANNEL3: '56', LIMIT_GLOBAL_TAVILY: '40' } as Env)).caps;
  assert.deepEqual([set.channel3, set.tavily], [56, 40]);
});

// ---- through the HTTP layer ------------------------------------------------------------------------------------------

const ideas = (h: ReturnType<typeof makeHarness>, ip?: string) =>
  h.req('/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) }, body: JSON.stringify({ favorites: FAVS, budget_usd: 120 }) });

test('ideas: the per-IP daily limit answers 429, another IP is unaffected until the global limit', async () => {
  const h = makeHarness({ LIMIT_IP_IDEAS: '2', LIMIT_GLOBAL_IDEAS: '3' });
  for (let i = 0; i < 2; i++) await readEvents(await ideas(h, '203.0.113.1'));
  const refused = await ideas(h, '203.0.113.1');
  assert.equal(refused.status, 429);
  const e = ((await refused.json()) as any).error;
  assert.equal(e.code, 'limit');
  assert.equal(e.message, LIMIT_MESSAGE.ip);
  assert.equal((await ideas(h, '203.0.113.2')).status, 200); // global 3 of 3
  const global = await ideas(h, '203.0.113.3');
  assert.equal(global.status, 429);
  assert.equal(((await global.json()) as any).error.message, LIMIT_MESSAGE.global);
});

test('ideas: when Channel3 is over its daily limit the run still gives its Qloo ideas with their reasons, no buy buttons, and says shop search is paused', async () => {
  const h = makeHarness({ LIMIT_GLOBAL_CHANNEL3: '0' });
  const ev = await readEvents(await ideas(h));
  const done = ev.at(-1) as any;
  assert.equal(done.t, 'done', JSON.stringify(done));
  assert.deepEqual(done.limited, ['channel3']);
  const shown = ev.filter((e) => e.t === 'idea') as any[];
  assert.ok(shown.length >= 4, `${shown.length} ideas`);
  const products = shown.filter((e) => e.idea.kind === 'product');
  assert.ok(products.length >= 1 && products.every((e) => e.cards.length === 0 && e.idea.cardIds.length === 0 && e.idea.paused === 'channel3'), 'product ideas come without cards, flagged paused');
  assert.ok(shown.filter((e) => e.idea.kind === 'experience').every((e) => e.cards.length >= 1 && !e.idea.paused), 'place ideas keep their Tavily links');
  const reasons = (ev.find((e) => e.t === 'reasons') as any).reasons;
  for (const { idea } of shown) assert.ok(groundedReason(reasons[idea.id], idea), `${idea.title}: ${reasons[idea.id]}`);
  assert.equal(h.net.count('api.trychannel3.com'), 0, 'no billed call was made');
  assert.ok(!ev.some((e) => e.t === 'error'));
  const stored = JSON.parse(h.kv._m.get(`s:${(ev[0] as any).session}`)!);
  assert.ok(stored.cards.every((c: any) => !c.purchasable), 'nothing can be bought, so nothing buyable is stored');
});

test('ideas: when Channel3 runs out in the middle of a run, the ideas found so far keep their buy buttons and the rest come without', async () => {
  const h = makeHarness({ LIMIT_GLOBAL_CHANNEL3: '2' });
  const ev = await readEvents(await ideas(h));
  assert.deepEqual([(ev.at(-1) as any).t, (ev.at(-1) as any).limited], ['done', ['channel3']]);
  const products = (ev.filter((e) => e.t === 'idea') as any[]).filter((e) => e.idea.kind === 'product');
  assert.ok(products.some((e) => e.cards.some((c: any) => c.purchasable)), 'the searches that were allowed kept their buy buttons');
  assert.ok(products.some((e) => e.idea.paused === 'channel3' && e.cards.length === 0), 'the ones after the cap came without');
  assert.equal(h.net.count('api.trychannel3.com'), 2, 'exactly the allowed searches were made');
});

test('ideas: when Tavily is over its daily limit the run goes on without it: the cards that would have used it say so, and the done event names what was refused', async () => {
  const h = makeHarness({ LIMIT_GLOBAL_TAVILY: '0' });
  const ev = await readEvents(await ideas(h));
  const done = ev.at(-1) as any;
  assert.equal(done.t, 'done');
  assert.ok(done.ideas >= 1, 'ideas still came out');
  assert.deepEqual(done.limited, ['tavily']);
  assert.equal(h.net.count('api.tavily.com'), 0, 'no billed call was made');
  const checks = ev.filter((e) => e.t === 'check') as any[];
  assert.ok(checks.length >= 1 && checks.every((c) => c.state === 'paused'), 'each price check that would have run says it is paused');
  const places = (ev.filter((e) => e.t === 'idea') as any[]).filter((e) => e.idea.kind === 'experience');
  assert.ok(places.length >= 1 && places.every((e) => e.cards.length === 0 && e.idea.paused === 'tavily'), 'place ideas come without links, flagged paused');
  assert.ok((ev.filter((e) => e.t === 'idea') as any[]).some((e) => e.cards.some((c: any) => c.purchasable)), 'the buy buttons are unaffected');
});

test('ideas: a run the Qloo allowance cannot finish is refused before it starts, with no Qloo call and no run counted; demo data is never blocked', async () => {
  const h = makeHarness({ QLOO_API_KEY: 'q-test', LIMIT_IP_QLOO: '7' }); // 3 favourites and the 5 gift types need 8 calls
  const res = await ideas(h);
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as any).error.code, 'limit');
  assert.equal(h.net.calls.length, 0, 'nothing upstream was called');
  assert.ok(!((await (await h.req('/api/status')).json()) as any).usage.ideas, 'the refused run was not counted');
  const demo = makeHarness({ LIMIT_IP_QLOO: '7' }); // Qloo on demo data costs no Qloo call
  assert.equal(((await readEvents(await ideas(demo))).at(-1) as any).t, 'done');
});

test('ideas: when the session cannot be saved (KV write quota) the run ends with the plain limit message, not "internal"', async () => {
  const h = makeHarness();
  watchWrites(h, /^s:/);
  const last = (await readEvents(await ideas(h))).at(-1) as any;
  assert.deepEqual([last.t, last.code, last.message], ['error', 'limit', LIMIT_MESSAGE.global]);
});

test('status: usage counts live Channel3 and Tavily calls only; the Qloo and model demo data cost nothing', async () => {
  const h = makeHarness();
  await readEvents(await ideas(h));
  const s = (await (await h.req('/api/status')).json()) as any;
  assert.equal(s.usage.ideas, 1);
  assert.ok(s.usage.channel3 >= 4 && s.usage.tavily >= 1, JSON.stringify(s.usage));
  assert.equal(s.usage.ai, undefined);
  assert.equal(s.usage.channel3, h.net.count('api.trychannel3.com'));
  assert.equal(s.usage.tavily, h.net.count('api.tavily.com'));
  assert.deepEqual(s.mocks, ['qloo', 'ai']);
});

test('privacy: KV holds the session and cache entries, the meter hashed counters, and neither holds what the visitor typed or their IP', async () => {
  const api = memoryMeterApi();
  const seen: unknown[] = [];
  const spy: MeterApi = { take: (...a) => (seen.push(a), api.take(...a)), give: (...a) => (seen.push(a), api.give(...a)), used: (...a) => (seen.push(a), api.used(...a)) };
  const h = makeHarness({ METER: fakeMeter(spy) });
  const typed = ['Zyxwvu Quuxplorg', 'Flurbonic Vrelts', 'Glorptastic Mnemmons'];
  const res = await h.req('/api/ideas', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.77' },
    body: JSON.stringify({ favorites: typed.map((text) => ({ text })), budget_usd: 120 }),
  });
  const ev = await readEvents(res);
  assert.ok(ev.some((e) => e.t === 'done'), JSON.stringify(ev.at(-1)));
  const blob = [...h.kv._m.entries()].map(([k, v]) => k + '\n' + v).join('\n').toLowerCase();
  assert.ok(h.kv._m.size > 0);
  for (const t of typed) assert.ok(!blob.includes(t.toLowerCase()), `stored: ${t}`);
  assert.ok(!blob.includes('198.51.100.77'));
  assert.ok([...h.kv._m.keys()].every((k) => /^(s:|c:|o:|chk:)/.test(k)), [...h.kv._m.keys()].join(' '));
  const sent = JSON.stringify(seen).toLowerCase();
  assert.ok(seen.length > 0 && seen.every((a) => /^[0-9a-f]{16}$/.test((a as string[])[1]!)), 'the meter sees a 16-hex visitor hash');
  for (const t of [...typed, '198.51.100.77']) assert.ok(!sent.includes(t.toLowerCase()), `sent to the meter: ${t}`);
});
