// Security review regressions (evidence/security-review.md): spend caps that hold, fail closed and cover every billed
// service, plus the small web and privacy fixes. Each test failed on the code before the review.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMIT_MESSAGE } from '../src/app.ts';
import { chat } from '../src/adapters/ai.ts';
import { runLoop, toolSpec } from '../src/agent/loop.ts';
import { loadConfig } from '../src/config.ts';
import { callJson, HttpError } from '../src/lib/http.ts';
import { LimitError } from '../src/lib/limits.ts';
import type { Env } from '../src/types.ts';
import { chatBody, chatReply, FAVS, fakeAi, fakeKV, json, makeHarness, makeNet, makeSvc, readEvents, toolCall } from './helpers.ts';

const C3 = 'api.trychannel3.com';
const ideas = (h: ReturnType<typeof makeHarness>, ip?: string, body: unknown = { favorites: FAVS, budget_usd: 120 }) =>
  h.req('/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) }, body: JSON.stringify(body) });
const env = (e: Record<string, unknown>) => e as Partial<Env>;

// ---- spend caps -------------------------------------------------------------------------------------------------------

test('meter: when the counters cannot be reached or written, billed calls are refused (fail closed) and the example still works', async () => {
  const kv = fakeKV();
  const put = kv.put.bind(kv);
  kv.put = (async (k: string, v: string, o?: KVNamespacePutOptions) => {
    if (k.startsWith('lim:')) throw new Error('KV write limit reached');
    return put(k, v, o);
  }) as typeof kv.put;
  const down = async () => {
    throw new Error('meter unreachable');
  };
  const deadMeter = { idFromName: () => ({}), get: () => ({ take: down, give: down, used: down }) };
  for (const METER of [deadMeter, undefined]) {
    const h = makeHarness(env({ KV: kv, METER, LIMIT_GLOBAL_CHANNEL3: '1' }));
    for (let i = 0; i < 2; i++) {
      const res = await ideas(h);
      if (res.headers.get('content-type')?.includes('ndjson')) await readEvents(res);
      else {
        assert.equal(res.status, 429);
        assert.deepEqual(((await res.json()) as any).error, { code: 'limit', message: LIMIT_MESSAGE.global });
      }
    }
    assert.equal(h.net.count(C3), 0, `live Channel3 calls with ${METER ? 'an unreachable' : 'no'} meter`);
    assert.equal((await h.req('/api/status')).status, 200);
    const sample = await readEvents(await h.post('/api/sample', {}));
    assert.equal(sample.at(-1)!.t, 'done');
  }
});

test('meter: parallel runs of one visitor share one allowance (no lost updates)', async () => {
  const h = makeHarness(env({ LIMIT_IP_CHANNEL3: '2' }));
  // different budgets give different Channel3 queries, so no run is served from another run's cache
  await Promise.all([120, 121, 122, 123].map(async (b) => readEvents(await ideas(h, '203.0.113.9', { favorites: FAVS, budget_usd: b }))));
  assert.equal(h.net.count(C3), 2);
});

test('meter: live Qloo calls have a per-visitor cap', async () => {
  const h = makeHarness(env({ QLOO_API_KEY: 'q-test', LIMIT_IP_QLOO: '0' }));
  const ev = (await readEvents(await ideas(h))) as any[];
  assert.equal(h.net.count('hackathon.api.qloo.com'), 0);
  assert.equal(ev.at(-1).code, 'limit', JSON.stringify(ev.at(-1)));
});

test('meter: live model calls are capped in neurons, and the run falls back to the fixed pipeline', async () => {
  const ai = fakeAi();
  const h = makeHarness(env({ AI: ai, LIMIT_IP_NEURONS: '2' }));
  const ev = (await readEvents(await ideas(h))) as any[];
  assert.equal(ai.runs.length, 0, 'the cap is checked before the model is called');
  assert.ok(ev.some((e) => e.t === 'call' && e.tool === 'model' && /daily limit/.test(e.out)), JSON.stringify(ev.filter((e) => e.tool === 'model')));
  assert.equal(ev.at(-1).t, 'done');
});

test('meter: a model call reserves neurons from the prompt size and max_tokens, then settles to what the answer says it cost', async () => {
  const ai = fakeAi((_m, _i, n) => chatBody({ content: 'ok' }, 'stop', n === 1 ? 3.2 : undefined));
  const { svc } = await makeSvc(env({ AI: ai }));
  const used = async () => (await svc.meter.used()).ip as Record<string, number>;
  await chat(svc, { model: '@cf/qwen/qwen3-30b-a3b-fp8', messages: [{ role: 'user', content: 'x'.repeat(300) }], maxTokens: 100 });
  assert.deepEqual([(await used()).ai, (await used()).neurons], [1, 4], 'ceil(3.2) neurons, not the reservation');
  await chat(svc, { model: '@cf/qwen/qwen3-30b-a3b-fp8', messages: [{ role: 'user', content: 'x'.repeat(300) }], maxTokens: 100 });
  const reserved = (await used()).neurons! - 4;
  assert.ok(reserved >= 4 && reserved <= 6, `an answer without usage keeps the reservation (prompt/3 at 4,625 plus 100 tokens at 30,475 per million): ${reserved}`);
});

test('meter: a model that was refused or never ran gives its neurons back; a timeout keeps them', async () => {
  const refuse = fakeAi(() => {
    throw new Error('4006: you have used up your daily free allocation of 10,000 neurons');
  });
  const { svc } = await makeSvc(env({ AI: refuse }));
  await assert.rejects(chat(svc, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }), (e) => e instanceof HttpError && e.status === 429);
  assert.equal(refuse.runs.length, 2, 'one retry');
  const u = (await svc.meter.used()).ip as Record<string, number>;
  assert.deepEqual([u.ai, u.neurons], [2, 0]);
  const slow = fakeAi(() => new Promise(() => {}));
  const t = await makeSvc(env({ AI: slow }));
  await assert.rejects(chat(t.svc, { model: 'm', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 30 }), (e) => e instanceof HttpError && e.status === 0);
  assert.ok(((await t.svc.meter.used()).ip as Record<string, number>).neurons! > 0, 'we cannot know what an abandoned call used');
});

test('config: every billed counter has both caps, per-visitor below global, inside the free quotas', () => {
  const l = loadConfig({} as Env).limits as any;
  for (const k of ['ideas', 'qloo', 'ai', 'neurons', 'tavily', 'channel3', 'orders']) {
    assert.ok(Number.isFinite(l.ip[k]) && Number.isFinite(l.global[k]), k);
    assert.ok(l.ip[k] < l.global[k], `${k}: per-visitor ${l.ip[k]} is not below global ${l.global[k]}`);
  }
  assert.ok(l.global.channel3 * 31 <= 1000, 'Channel3 free plan: 1,000 searches a month');
  assert.ok(l.global.tavily * 31 <= 1000, 'Tavily free plan: 1,000 credits a month, 1 per search');
  assert.ok(l.global.neurons < 10_000, 'Workers AI free allocation: 10,000 neurons a day, so our cap stops first');
});

test('meter: IPv6 visitors are counted per /64, so new addresses in the same network do not reset the allowance', async () => {
  const h = makeHarness(env({ LIMIT_IP_IDEAS: '1' }));
  await readEvents(await ideas(h, '2001:db8:1:2::1'));
  const again = await ideas(h, '2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  assert.equal(again.status, 429);
  await again.text();
  const other = await ideas(h, '2001:db8:1:3::1');
  assert.equal(other.status, 200, 'another /64 is another visitor');
  await readEvents(other);
});

test('meter: a count that is not a finite number of 0 or more is refused, so it cannot switch a cap off', async () => {
  const { svc } = await makeSvc();
  for (const n of [NaN, -5]) await assert.rejects(svc.meter.take({ tokens: n }), LimitError, String(n));
  await svc.meter.take({ tokens: 1 });
  assert.equal((await svc.meter.used()).global.tokens, 1);
});

// ---- bounded work ---------------------------------------------------------------------------------------------------

test('http: an oversized upstream answer is refused, not parsed', async () => {
  const { svc } = await makeSvc();
  svc.fetch = async () => new Response('{"results":[' + '"x",'.repeat(700_000) + '"x"]}', { status: 200 });
  await assert.rejects(callJson(svc, 'tavily', 'https://api.tavily.com/search', {}), (e) => e instanceof HttpError);
});

test('runLoop: at most 8 tool calls of one model turn run, and the model sees a result for each of them', async () => {
  const bodies: any[] = [];
  const ai = async (_u: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? chatReply({ content: null, tool_calls: Array.from({ length: 20 }, (_, k) => toolCall('t', {}, `c${k}`)) }, 'tool_calls') : chatReply({ content: 'DONE' });
  };
  const { svc } = await makeSvc({}, makeNet(), { ai });
  let ran = 0;
  await runLoop(svc, { model: 'm', system: '[task:x]', user: {}, tools: [{ spec: toolSpec('t', 'd', {}, []), run: async () => ++ran }], maxTurns: 2 });
  assert.equal(ran, 8);
  const msgs = bodies[1].messages;
  assert.equal(msgs.find((m: any) => m.role === 'assistant').tool_calls.length, 8);
  assert.equal(msgs.filter((m: any) => m.role === 'tool').length, 8);
});

test('http: a request body is read only up to 8 KB, however much the client sends', async () => {
  const h = makeHarness();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= 4_000_000) return c.close();
      sent += 4096;
      c.enqueue(new Uint8Array(4096).fill(32));
    },
  });
  const res = await h.req('/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit);
  assert.equal(res.status, 400);
  await res.text();
  assert.ok(sent < 64_000, `${sent} bytes read`);
});

// ---- web ------------------------------------------------------------------------------------------------------------

test('http: a POST that is not JSON is refused with 415 before anything runs (no cross-site form or text/plain posts)', async () => {
  const h = makeHarness();
  for (const path of ['/api/ideas', '/api/sample', '/api/checkout']) {
    const res = await h.req(path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ favorites: FAVS, budget_usd: 120 }) });
    assert.equal(res.status, 415, path);
    await res.text();
  }
  assert.equal(h.net.calls.length, 0);
  assert.equal(h.kv._m.size, 0);
});

test('http: every API answer, the NDJSON stream included, carries nosniff, no-referrer and a CSP that forbids framing', async () => {
  const h = makeHarness();
  for (const res of [await h.post('/api/sample', {}), await h.req('/api/status'), await h.req('/api/return?token=x'), await h.req('/api/nope')]) {
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', res.url);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'.*frame-ancestors 'none'/);
    await res.text();
  }
});

// ---- privacy ----------------------------------------------------------------------------------------------------------

test('privacy: logs name the failing service and status, never upstream text that can echo what the visitor typed', async () => {
  const typed = ['Zyxwvu Quuxplorg', 'Flurbonic Vrelts', 'Glorptastic Mnemmons'];
  const h = makeHarness(env({ QLOO_API_KEY: 'q-test' }));
  h.net.intercept = (path) => (path === '/search' ? json({ error: `no entity named ${typed.join(', ')}` }, 500) : undefined);
  const logs: string[] = [];
  const keep = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    await readEvents(await ideas(h, undefined, { favorites: typed.map((text) => ({ text })), budget_usd: 120 }));
  } finally {
    Object.assign(console, keep);
  }
  assert.ok(logs.length > 0, 'the failure is logged');
  assert.ok(logs.every((l) => !/zyxwvu|flurbonic|glorptastic/i.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('qloo') && l.includes('500')), logs.join('\n'));
});
