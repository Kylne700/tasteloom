// The contract scripts' check logic, run against documented-shape fakes (no network, no keys): it passes on good answers and
// fails on a wrong shape, so a real run later can tell "the API differs" from "the script is broken".
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeQlooFake } from '../src/mocks/qloo-fake.ts';
import { makeSvc, qlooContract } from '../scripts/contract-qloo.ts';
import { nebiusContract } from '../scripts/contract-nebius.ts';

const ok = (checks: [string, boolean][]) => checks.every(([, passed]) => passed);

test('contract:qloo passes on doc-shaped answers, within 5 calls, and fails on a different shape', async () => {
  let calls = 0;
  const fake = makeQlooFake();
  const svc = await makeSvc({ QLOO_API_KEY: 'k' }, (u, i) => (calls++, fake(u, i)));
  const good = await qlooContract(svc);
  assert.equal(good.failure, '');
  assert.ok(good.checks.length >= 9 && ok(good.checks), JSON.stringify(good.checks.filter(([, p]) => !p)));
  assert.ok(calls <= 5 && svc.sub.left === 5 - calls, `${calls} calls`);

  const wrong = await qlooContract(await makeSvc({ QLOO_API_KEY: 'k' }, async () => Response.json({ results: [] })));
  assert.ok(!ok(wrong.checks) || wrong.failure, 'an empty answer must not pass');
});

test('contract:qloo stops at the call cap instead of spending more', async () => {
  const fake = makeQlooFake();
  const svc = await makeSvc({ QLOO_API_KEY: 'k' }, fake, 2);
  const r = await qlooContract(svc);
  assert.match(r.failure, /subrequest budget/);
});

/** An OpenAI-compatible server in the documented shape. */
const openai = (opts: { tools?: boolean; models?: string[] } = {}) => async (url: string, init?: RequestInit) => {
  if (url.endsWith('/models')) return Response.json({ object: 'list', data: (opts.models ?? ['nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', 'nvidia/nemotron-3-super-120b-a12b']).map((id) => ({ id, object: 'model' })) });
  const body = JSON.parse(String(init?.body));
  const msg = body.tools && opts.tools !== false
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"v":"ping"}' } }] }
    : { role: 'assistant', content: body.messages[0].content.includes('"picks"') ? '```json\n{"picks":[{"entity_id":"E1","query":"a b"}]}\n```' : '{"reasons":{"i1":"Because."}}' };
  return Response.json({ id: 'x', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } });
};

test('contract:nebius passes on the documented shape, within 5 calls', async () => {
  const svc = await makeSvc({ NEBIUS_API_KEY: 'k' }, openai());
  const r = await nebiusContract(svc);
  assert.equal(r.failure, '');
  assert.ok(r.checks.length >= 6 && ok(r.checks), JSON.stringify(r.checks.filter(([, p]) => !p)));
  assert.equal(svc.sub.left, 5 - 4, 'one list request and three chat requests');
});

test('contract:nebius reports a missing model, a model that ignores tools and an unreachable list', async () => {
  const missing = await nebiusContract(await makeSvc({ NEBIUS_API_KEY: 'k' }, openai({ models: ['nvidia/other', 'nvidia/nemotron-x'] })));
  assert.ok(missing.checks.some(([n, p]) => /listed/.test(n) && !p));
  const noTools = await nebiusContract(await makeSvc({ NEBIUS_API_KEY: 'k' }, openai({ tools: false })));
  assert.ok(noTools.checks.some(([n, p]) => /tool calling/.test(n) && !p));
  const noList = await nebiusContract(await makeSvc({ NEBIUS_API_KEY: 'k' }, async (u, i) => (u.endsWith('/models') ? new Response('nope', { status: 404 }) : openai()(u, i))));
  assert.ok(noList.notes.some((n) => /could not list models/.test(n)) && ok(noList.checks), 'chat checks still decide');
  const down = await nebiusContract(await makeSvc({ NEBIUS_API_KEY: 'k' }, async () => new Response('{}', { status: 401 })));
  assert.ok(down.failure);
});
