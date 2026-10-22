// The contract script's check logic, run against live-shaped fakes (no network, no keys): it passes on good answers and
// fails on a wrong shape, so a real run later can tell "the API differs" from "the script is broken".
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeQlooFake } from '../src/mocks/qloo-fake.ts';
import { makeSvc, qlooContract } from '../scripts/contract-qloo.ts';

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
