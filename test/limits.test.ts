// Spend and abuse limits, configuration and privacy of the counters.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMIT_MESSAGE } from '../src/app.ts';
import { loadConfig, publicStatus, secretsOf } from '../src/config.ts';
import { LimitError, Meter } from '../src/lib/limits.ts';
import { memoryStore, type Store } from '../src/lib/store.ts';
import type { Env } from '../src/types.ts';
import { FAVS, makeHarness, readEvents } from './helpers.ts';

const DAY = '2026-10-16';
const lim = (env: Partial<Env> = {}) => loadConfig(env as Env).limits;

test('meter: per-IP limit, then global limit, each with its own scope', async () => {
  const store = memoryStore();
  const limits = lim({ LIMIT_IP_IDEAS: '2', LIMIT_GLOBAL_IDEAS: '3' });
  const a = await Meter.load(store, limits, 'ipA', DAY);
  a.take('ideas');
  a.take('ideas');
  assert.throws(() => a.take('ideas'), (e) => e instanceof LimitError && e.scope === 'ip' && e.counter === 'ideas');
  await a.flush();
  const b = await Meter.load(store, limits, 'ipB', DAY);
  b.take('ideas'); // global 3 of 3
  await b.flush();
  assert.throws(() => b.take('ideas'), (e) => e instanceof LimitError && e.scope === 'global', 'B is under its own 2, but the global 3 is used up');
  const c = await Meter.load(store, limits, 'ipC', DAY);
  assert.throws(() => c.take('ideas'), (e) => e instanceof LimitError && e.scope === 'global');
});

test('meter: a call that would cross the limit is refused whole and changes nothing', async () => {
  const m = await Meter.load(memoryStore(), lim({ LIMIT_IP_TAVILY: '5' }), 'ip', DAY);
  m.take('tavily', 3);
  assert.throws(() => m.take('tavily', 3), LimitError);
  assert.equal(m.used().ip.tavily, 3);
  m.take('tavily', 2);
  assert.equal(m.used().global.tavily, 5);
});

test('meter: the daily money cap can be reserved and given back, never below zero', async () => {
  const m = await Meter.load(memoryStore(), lim({ LIMIT_DAILY_CAP_USD: '10' }), 'ip', DAY);
  m.takeCents(600);
  assert.throws(() => m.takeCents(401), (e) => e instanceof LimitError && e.counter === 'cents' && e.scope === 'global');
  m.takeCents(400);
  m.refundCents(400);
  m.takeCents(400);
  m.refundCents(99999);
  assert.equal(m.used().global.cents, 0);
});

test('meter: counters persist per day, are written once, and keep no raw IP', async () => {
  const writes: string[] = [];
  const inner = memoryStore();
  const store: Store = { ...inner, put: async (k, v, t) => (writes.push(k), inner.put(k, v, t)) };
  const limits = lim();
  const m = await Meter.load(store, limits, 'hashed-ip', DAY);
  await m.flush();
  assert.equal(writes.length, 0, 'nothing counted, nothing written');
  m.take('channel3');
  m.take('channel3');
  await m.flush();
  await m.flush();
  assert.deepEqual(writes.sort(), [`lim:${DAY}:g`, `lim:${DAY}:i:hashed-ip`]);
  assert.equal((await Meter.load(store, limits, 'hashed-ip', DAY)).used().ip.channel3, 2);
  assert.equal((await Meter.load(store, limits, 'hashed-ip', '2026-10-17')).used().global.channel3, undefined, 'a new day starts empty');
  assert.equal((await Meter.load(store, limits, 'other', DAY)).used().ip.channel3, undefined);
});

test('meter: a failing store never breaks the request', async () => {
  const broken: Store = { get: async () => null, put: async () => Promise.reject(new Error('KV write quota')), delete: async () => {} };
  const m = await Meter.load(broken, lim(), 'ip', DAY);
  m.take('ideas');
  await m.flush();
});

// ---- configuration -----------------------------------------------------------------------------------------------

test('config: documented defaults', () => {
  const l = lim();
  assert.deepEqual([l.maxItems, l.minBudgetCents, l.maxBudgetCents, l.dailyCapCents], [6, 1000, 50000, 200000]);
  assert.deepEqual([l.ip.ideas, l.ip.nebius, l.ip.tavily, l.ip.channel3, l.ip.orders], [8, 80, 40, 40, 8]);
  assert.deepEqual([l.global.ideas, l.global.nebius, l.global.tavily, l.global.channel3, l.global.orders], [100, 600, 100, 60, 100]);
});

test('config: overrides apply, junk falls back to the default', () => {
  const l = lim({ LIMIT_MAX_ITEMS: '3', LIMIT_MAX_BUDGET_USD: '120', LIMIT_DAILY_CAP_USD: '12.5', LIMIT_IP_IDEAS: 'lots', LIMIT_GLOBAL_IDEAS: '-4', LIMIT_IP_TAVILY: '' });
  assert.deepEqual([l.maxItems, l.maxBudgetCents, l.dailyCapCents, l.ip.ideas, l.global.ideas, l.ip.tavily], [3, 12000, 1250, 8, 100, 40]);
});

test('config: Qloo and Nebius switch from mock to live by themselves when a key appears; FORCE_MOCK overrides', () => {
  const none = loadConfig({} as Env);
  assert.deepEqual([none.qloo, none.nebius, none.tavily, none.channel3, none.paypal], ['mock', 'mock', 'off', 'off', 'off']);
  const keyed = loadConfig({ QLOO_API_KEY: 'q-key', NEBIUS_API_KEY: ' n-key ', TAVILY_API_KEY: 't', CHANNEL3_API_KEY: 'c', PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's' } as Env);
  assert.deepEqual([keyed.qloo, keyed.nebius, keyed.tavily, keyed.channel3, keyed.paypal, keyed.keys.nebius], ['live', 'live', 'live', 'live', 'live', 'n-key']);
  assert.deepEqual(publicStatus(keyed).mocks, []);
  assert.deepEqual(publicStatus(loadConfig({ QLOO_API_KEY: 'q-key', NEBIUS_API_KEY: 'n-key', FORCE_MOCK: 'qloo, nebius' } as Env)).mocks, ['qloo', 'nebius']);
  assert.equal(loadConfig({ PAYPAL_CLIENT_ID: 'only-id' } as Env).paypal, 'off');
  assert.equal(loadConfig({ QLOO_API_KEY: '   ' } as Env).qloo, 'mock');
});

test('config: the public status carries modes and budget bounds, never a key', () => {
  const env = { QLOO_API_KEY: 'q-secret-111', NEBIUS_API_KEY: 'n-secret-222', TAVILY_API_KEY: 't-secret-333', CHANNEL3_API_KEY: 'c-secret-444', PAYPAL_CLIENT_ID: 'id-secret-555', PAYPAL_CLIENT_SECRET: 's-secret-666' } as Env;
  const cfg = loadConfig(env);
  const text = JSON.stringify(publicStatus(cfg));
  for (const k of secretsOf(cfg)) assert.ok(k && !text.includes(k));
  assert.deepEqual(publicStatus(cfg).budget, { min_cents: 1000, max_cents: 50000, max_items: 6 });
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

test('ideas: when Channel3 is over its daily limit the run ends with a clear limit error, not a crash', async () => {
  const h = makeHarness({ LIMIT_GLOBAL_CHANNEL3: '0' });
  const ev = await readEvents(await ideas(h));
  const last = ev.at(-1)!;
  assert.equal(last.t, 'error');
  assert.equal((last as any).code, 'limit');
  assert.equal(h.net.count('api.trychannel3.com'), 0, 'no billed call was made');
});

test('status: usage counts live Channel3 and Tavily calls only; the Qloo and Nebius demo data cost nothing', async () => {
  const h = makeHarness();
  await readEvents(await ideas(h));
  const s = (await (await h.req('/api/status')).json()) as any;
  assert.equal(s.usage.ideas, 1);
  assert.ok(s.usage.channel3 >= 4 && s.usage.tavily >= 1, JSON.stringify(s.usage));
  assert.equal(s.usage.nebius, undefined);
  assert.equal(s.usage.channel3, h.net.count('api.trychannel3.com'));
  assert.equal(s.usage.tavily, h.net.count('api.tavily.com'));
  assert.deepEqual(s.mocks, ['qloo', 'nebius']);
});

test('privacy: KV holds hashed counters, the session and cache entries, and nothing the visitor typed or their IP', async () => {
  const h = makeHarness();
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
  assert.ok([...h.kv._m.keys()].every((k) => /^(lim:|s:|c:|o:|chk:)/.test(k)), [...h.kv._m.keys()].join(' '));
});
