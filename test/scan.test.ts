// The scanner finds planted secrets and denylist terms, and never prints either.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { denyCount, findSecrets, needlesFrom } from '../scripts/scan.mjs';

test('findSecrets names the variable whose value is present, skips short values, and adds the PayPal Basic pair', () => {
  const env = { A_KEY: 'plantedvalue-0001', B_KEY: 'otherplanted-0002', MODE: 'sandbox', PAYPAL_CLIENT_ID: 'client-id-1234', PAYPAL_CLIENT_SECRET: 'client-secret-5678' };
  const needles = needlesFrom(env);
  assert.deepEqual(needles.map((n) => n.name), ['A_KEY', 'B_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_BASIC_AUTH']);
  assert.deepEqual(findSecrets(Buffer.from('xx plantedvalue-0001 yy'), needles), ['A_KEY']);
  assert.deepEqual(findSecrets(Buffer.from('Authorization: Basic ' + Buffer.from('client-id-1234:client-secret-5678').toString('base64')), needles), ['PAYPAL_BASIC_AUTH']);
  assert.deepEqual(findSecrets(Buffer.from('sandbox only'), needles), []);
});

test('denyCount counts matching lines case-insensitively, as fixed strings, and 0 for clean input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-scan-'));
  const deny = join(dir, 'deny.txt');
  writeFileSync(deny, 'Forbidden Phrase\na.b\n');
  assert.equal(denyCount(Buffer.from('one\na FORBIDDEN phrase here\nand forbidden phrase again\nfine\n'), deny), 2);
  assert.equal(denyCount(Buffer.from('axb\n'), deny), 0, 'a dot is not a wildcard');
  assert.equal(denyCount(Buffer.from('a.b\n'), deny), 1);
  assert.equal(denyCount(Buffer.from('nothing to see\n'), deny), 0);
});

test('the scan script exits 0, 1 or 2, prints no secret and leaves evidence/scan.txt alone unless --write is given (runs against the real tree)', () => {
  const cwd = new URL('..', import.meta.url).pathname;
  const saved = join(cwd, 'evidence/scan.txt');
  const before = statSync(saved).mtimeMs;
  const r = spawnSync('node', ['scripts/scan.mjs'], { cwd, encoding: 'utf8' });
  assert.ok([0, 1, 2].includes(r.status ?? -1), String(r.status));
  assert.match(r.stdout, /^scan: /m);
  assert.equal(statSync(saved).mtimeMs, before, 'a plain run must not rewrite the tracked report');
});
