// Model output is untrusted text: parse it tolerantly, and keep only what passes the checks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { diversePicks, groundedReason, parseIdeasInput, templateReason } from '../src/agent/ideas.ts';
import { parseLooseJson, stripThinking } from '../src/lib/json.ts';
import type { Candidate } from '../src/types.ts';

test('parseLooseJson: plain, fenced, prefixed and suffixed JSON', () => {
  const want = { picks: [{ entity_id: 'E1', query: 'a b' }] };
  const body = JSON.stringify(want);
  for (const text of [body, '```json\n' + body + '\n```', '```\n' + body + '\n```', 'Sure! Here you go:\n' + body + '\nHope that helps.', '<think>hmm {not json}</think>\n' + body, '﻿' + body]) {
    assert.deepEqual(parseLooseJson(text), want, text.slice(0, 40));
  }
});

test('parseLooseJson: trailing commas, truncated output and dangling tokens are repaired', () => {
  assert.deepEqual(parseLooseJson('{"a": [1, 2, 3,], "b": {"c": 1,},}'), { a: [1, 2, 3], b: { c: 1 } });
  assert.deepEqual(parseLooseJson('{"reasons": {"i1": "Because they love Muji, this fits", "i2": "Another one"'), { reasons: { i1: 'Because they love Muji, this fits', i2: 'Another one' } });
  assert.deepEqual(parseLooseJson('{"reasons": {"i1": "Complete", "i2": "cut off mid sen'), { reasons: { i1: 'Complete', i2: 'cut off mid sen' } });
  assert.deepEqual(parseLooseJson('{"picks": [{"entity_id": "E1", "query": "x"}, {"entity_id": "E2", "que'), { picks: [{ entity_id: 'E1', query: 'x' }, { entity_id: 'E2' }] });
  assert.deepEqual(parseLooseJson('{"a": 1, "b":'), { a: 1 });
  assert.deepEqual(parseLooseJson('{"a": 1, "b": tru'), { a: 1 });
  assert.deepEqual(parseLooseJson('{"a": [1, 2.5e'), { a: [1] });
});

test('parseLooseJson: garbage is not mistaken for cut-off JSON', () => {
  for (const x of ['{not json', '{"a": 1, "b": nope', '{"a": 1} {"b": ', 'here is {my answer', '[oops']) {
    const v = parseLooseJson(x);
    assert.ok(v === undefined || (typeof v === 'object' && JSON.stringify(v) === '{"a":1}'), `${x} -> ${JSON.stringify(v)}`);
  }
  assert.equal(parseLooseJson('{not json'), undefined);
  assert.equal(parseLooseJson('{"a": 1, "b": nope'), undefined);
  assert.equal(parseLooseJson('[oops'), undefined);
});

test('parseLooseJson: output cut off at any position still yields an object made of values from the original', () => {
  const full = { picks: [{ entity_id: 'E1', query: 'a b' }, { entity_id: 'E2', query: 'c, d' }], reasons: { i1: 'Because they love "Muji", ok', i2: 'n\\a' }, n: 12.5, ok: true, none: null };
  const text = JSON.stringify(full);
  for (let n = 1; n < text.length; n++) {
    const v = parseLooseJson(text.slice(0, n)) as Record<string, unknown> | undefined;
    assert.ok(v && typeof v === 'object', `cut at ${n}: ${text.slice(0, n)}`);
    for (const [k, val] of Object.entries(v)) assert.ok(k in full, `key ${k} at cut ${n}`) || void val;
  }
});

test('parseLooseJson: braces inside strings do not confuse the scan', () => {
  assert.deepEqual(parseLooseJson('Result: {"t": "a } b { c \\" d", "n": 2} done'), { t: 'a } b { c " d', n: 2 });
});

test('parseLooseJson: text without JSON, wrong types and empty input give undefined, never an exception', () => {
  for (const x of ['', 'DONE', 'I could not do that.', '```json\n```', undefined, null, 42, {}, ['x']]) assert.equal(parseLooseJson(x), undefined, String(x));
  assert.equal(parseLooseJson('{"a": nope}'), undefined);
  assert.deepEqual(parseLooseJson('[1, 2'), [1, 2]);
});

test('stripThinking: closed, repeated and unterminated think blocks', () => {
  assert.equal(stripThinking('<think>a</think>Hello<think>b\nc</think> world'), 'Hello world');
  assert.equal(stripThinking('Answer.<think>cut off while thinking'), 'Answer.');
  assert.equal(stripThinking('<THINKING>x</THINKING>ok'), 'ok');
  assert.equal(stripThinking('no blocks'), 'no blocks');
});

// ---- request validation and reason checks -------------------------------------------------------------------------

const LIM = { minBudgetCents: 1000, maxBudgetCents: 50000 };
const ok = (body: Record<string, unknown>) => {
  const r = parseIdeasInput(body, LIM);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const bad = (body: Record<string, unknown> | undefined) => {
  const r = parseIdeasInput(body, LIM);
  assert.ok(!r.ok);
  return r.message;
};

test('parseIdeasInput: 3 to 5 distinct favourites, cleaned text, known type hints only', () => {
  const v = ok({ favorites: [{ text: '  Kafka\non the   Shore\u0007 ', type: 'book' }, { text: 'nujabes', type: 'not-a-type' }, 'Muji', { text: 'NUJABES' }, { text: '' }, { text: 7 }], budget_usd: 120.4 });
  assert.deepEqual(v, { favorites: [{ text: 'Kafka on the Shore', type: 'book' }, { text: 'nujabes' }, { text: 'Muji' }], budget_cents: 12040 });
  assert.equal(ok({ favorites: ['a1', 'b2', 'c3', 'd4', 'e5'], budget_usd: 50 }).favorites.length, 5);
  assert.equal(ok({ favorites: [{ text: 'x'.repeat(200) }, 'b', 'c'], budget_usd: 50 }).favorites[0]!.text.length, 80);
});

test('parseIdeasInput: wrong counts and budgets are refused with a plain sentence', () => {
  assert.equal(bad({ favorites: ['a', 'b'], budget_usd: 50 }), 'Add 3 to 5 things they love.');
  assert.equal(bad({ favorites: ['a', 'b', 'c', 'd', 'e', 'f'], budget_usd: 50 }), 'Add 3 to 5 things they love.');
  assert.equal(bad({ favorites: ['a', 'a', 'A'], budget_usd: 50 }), 'Add 3 to 5 things they love.');
  assert.equal(bad(undefined), 'Add 3 to 5 things they love.');
  assert.equal(bad({ favorites: 'abc', budget_usd: 50 }), 'Add 3 to 5 things they love.');
  const f = ['a', 'b', 'c'];
  for (const budget of [9.99, 500.01, -5, 0, NaN, 'x', null, undefined, Infinity]) assert.equal(bad({ favorites: f, budget_usd: budget }), 'Pick a budget between $10 and $500.', String(budget));
  assert.equal(ok({ favorites: f, budget_usd: '25' }).budget_cents, 2500);
  assert.equal(ok({ favorites: f, budget_usd: 10 }).budget_cents, 1000);
  assert.equal(ok({ favorites: f, budget_usd: 500 }).budget_cents, 50000);
});

test('groundedReason: a model reason must name a linked favourite and may not quote prices or links', () => {
  const idea = { because: ['Nujabes', 'Muji'] };
  assert.ok(groundedReason('Because they love Nujabes, this vinyl is a natural fit.', idea));
  assert.ok(groundedReason('MUJI fans tend to love this kind of quiet design.', idea));
  assert.ok(!groundedReason('A lovely gift that anyone would enjoy a lot.', idea), 'names nobody');
  assert.ok(!groundedReason('Because they love Muji, this costs only $5 today.', idea));
  assert.ok(!groundedReason('Because they love Muji, see https://evil.example for more.', idea));
  assert.ok(!groundedReason('Because they love Muji, see www.evil.example for more.', idea));
  assert.ok(!groundedReason('Muji fan.', idea), 'too short');
  assert.ok(!groundedReason('Because they love Muji, ' + 'x'.repeat(260), idea), 'too long');
  assert.ok(groundedReason('This fits their overall taste in quiet things.', { because: [] }));
});

test('templateReason: the tags Qloo gives both, or only that Qloo links them, or that it fits the overall taste', () => {
  const e = { id: 'E', name: 'Hario', type: 'brand' };
  assert.equal(templateReason({ because: ['Muji'], entity: e }), 'Qloo links Muji to Hario.');
  assert.equal(templateReason({ because: ['Muji', 'Nujabes'], entity: e }), 'Qloo links Muji to Hario.', 'only the strongest favourite is named');
  assert.equal(templateReason({ because: ['Muji', 'Nujabes'], entity: e, shared: ['Japan'] }), 'Qloo tags both Muji and Hario as Japan.');
  assert.equal(templateReason({ because: ['Muji'], entity: e, shared: ['Japan', 'Calm', 'Design'] }), 'Qloo tags both Muji and Hario as Japan, Calm and Design.');
  assert.equal(templateReason({ because: ['Muji'], entity: e, shared: [] }), 'Qloo links Muji to Hario.');
  assert.match(templateReason({ because: [], entity: e }), /overall taste/);
  assert.match(templateReason({ because: [], entity: e, shared: ['Japan'] }), /overall taste/, 'no strongest favourite, so nothing to share with');
});

test('diversePicks: mixes types, strongest Qloo link first, no duplicates', () => {
  const c = (id: string, type: string, score: number): Candidate => ({ id, name: id, type, because: score ? [{ seedId: 's', score }] : [], explained: score > 0 });
  const picks = diversePicks([c('b1', 'brand', 0.2), c('b2', 'brand', 0.9), c('k1', 'book', 0.5), c('p1', 'place', 0.1), c('a1', 'artist', 0.4), c('x1', 'movie', 0.9)], 5);
  assert.deepEqual(picks.map((p) => p.id), ['b2', 'k1', 'a1', 'p1', 'x1']);
  assert.deepEqual(diversePicks([c('b1', 'brand', 0.2), c('b2', 'brand', 0.9), c('k1', 'book', 0.5)], 3).map((p) => p.id), ['b2', 'k1', 'b1'], 'second round when types run out');
  assert.equal(new Set(picks.map((p) => p.id)).size, picks.length);
  assert.deepEqual(diversePicks([], 3), []);
});
