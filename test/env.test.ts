// scripts/lib/env.mjs reads a file and the process environment; here both are made-up values in a temp folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadEnvLocal } from '../scripts/lib/env.mjs';

const state = new URL('../.wrangler/', import.meta.url).pathname; // git-ignored local state, so the test touches nothing outside the app
fs.mkdirSync(state, { recursive: true });
const dir = fs.mkdtempSync(path.join(state, 'env-test-'));
const file = path.join(dir, 'env');
fs.writeFileSync(file, ['QLOO_API_KEY=', 'TAVILY_API_KEY="from-file"', 'export CHANNEL3_API_KEY=file-three', 'OTHER=ignored', ''].join('\n'));

test('loadEnvLocal: a non-empty process value wins over the file, an empty one does not', () => {
  const env = loadEnvLocal(['QLOO_API_KEY', 'TAVILY_API_KEY', 'CHANNEL3_API_KEY'], { file, env: { QLOO_API_KEY: 'from-env', TAVILY_API_KEY: '', CHANNEL3_API_KEY: undefined } });
  assert.deepEqual(env, { QLOO_API_KEY: 'from-env', TAVILY_API_KEY: 'from-file', CHANNEL3_API_KEY: 'file-three' });
});

test('loadEnvLocal: only the asked-for names are returned, and without a list only names the file has', () => {
  assert.deepEqual(loadEnvLocal(['OTHER_NAME'], { file, env: { OTHER_NAME: 'x', HOME: 'h' } }), { OTHER_NAME: 'x' });
  const all = loadEnvLocal(undefined, { file, env: { QLOO_API_KEY: 'from-env', HOME: '/h', PATH: '/bin' } });
  assert.deepEqual(Object.keys(all).sort(), ['CHANNEL3_API_KEY', 'OTHER', 'QLOO_API_KEY', 'TAVILY_API_KEY']);
  assert.equal(all.QLOO_API_KEY, 'from-env');
});

test('loadEnvLocal: with no file the process values still count', () => {
  assert.deepEqual(loadEnvLocal(['QLOO_API_KEY'], { file: path.join(dir, 'missing'), env: { QLOO_API_KEY: 'v' } }), { QLOO_API_KEY: 'v' });
  assert.deepEqual(loadEnvLocal(['QLOO_API_KEY'], { file: path.join(dir, 'missing'), env: {} }), {});
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
