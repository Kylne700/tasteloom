// Money rules: server-side pricing, budget cap, global daily cap, idempotent orders, capture only after approval.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMIT_MESSAGE } from '../src/app.ts';
import { buildOrderBody } from '../src/adapters/paypal.ts';
import { newSession, OrderError, priceOrder, type OrderErrorCode } from '../src/commerce.ts';
import type { Card } from '../src/types.ts';
import { card, makeHarness, seedSession } from './helpers.ts';

const LIM = { maxItems: 6 };
const A = card('pa', 1250);
const B = card('pb', 2400);
const session = (budget: number, extra: Card[] = []) => newSession(budget, [A, B, ...extra]);
const failsWith = (code: OrderErrorCode) => (e: unknown) => e instanceof OrderError && e.code === code;
const orderPosts = (h: ReturnType<typeof makeHarness>) => h.net.calls.filter((c) => c.method === 'POST' && c.path === '/v2/checkout/orders');
const captures = (h: ReturnType<typeof makeHarness>) => h.net.calls.filter((c) => c.path.endsWith('/capture'));

// ---- priceOrder: pure pricing from the stored cards ------------------------------------------------------------------

test('priceOrder: the total is the sum of the stored cards, in integer cents', () => {
  const r = priceOrder(session(10000), ['pa', 'pb'], LIM);
  assert.equal(r.total_cents, 3650);
  assert.deepEqual(r.lines.map((l) => [l.id, l.price_cents, l.title]), [['pa', 1250, 'Item pa'], ['pb', 2400, 'Item pb']]);
});

test('priceOrder: a repeated id is counted once and the budget itself is allowed', () => {
  assert.equal(priceOrder(session(1250), ['pa', 'pa'], LIM).total_cents, 1250);
});

test('priceOrder: rejects bad selections with a specific code', () => {
  const s = session(10000, [card('link', 0, { purchasable: false, source: 'tavily' }), card('priced-link', 1500, { purchasable: false, source: 'tavily' }), card('free', 0), card('frac', 12.5), card('neg', -500)]);
  const cases: [unknown, OrderErrorCode][] = [
    [undefined, 'bad_request'],
    ['pa', 'bad_request'],
    [{ 0: 'pa' }, 'bad_request'],
    [[1], 'bad_request'],
    [[null], 'bad_request'],
    [[], 'empty'],
    [['nope'], 'unknown_item'],
    [['pa', 'nope'], 'unknown_item'],
    [['link'], 'not_purchasable'],
    [['priced-link'], 'not_purchasable'],
    [['free'], 'not_purchasable'],
    [['frac'], 'not_purchasable'],
    [['neg'], 'not_purchasable'],
  ];
  for (const [ids, code] of cases) assert.throws(() => priceOrder(s, ids, LIM), failsWith(code), JSON.stringify(ids));
});

test('priceOrder: too many items and a total above the budget are refused', () => {
  const many = Array.from({ length: 7 }, (_, i) => card('m' + i, 100));
  assert.throws(() => priceOrder(newSession(100000, many), many.map((c) => c.id), LIM), failsWith('too_many'));
  assert.throws(() => priceOrder(session(3649), ['pa', 'pb'], LIM), failsWith('over_budget'));
});

// ---- PayPal order body ---------------------------------------------------------------------------------------------

test('buildOrderBody: guest checkout, capture intent, exact decimal amounts built from cents', () => {
  const lines = [{ id: 'a', title: 'A', shop: 's', price_cents: 110 }, { id: 'b', title: 'B', shop: 's', price_cents: 220 }, { id: 'c', title: 'C', shop: 's', price_cents: 5 }];
  const b = buildOrderBody({ lines, total_cents: 335, sessionId: 's1', returnUrl: 'https://x.example/api/return', cancelUrl: 'https://x.example/api/cancel' });
  const pu = b.purchase_units[0]!;
  assert.equal(b.intent, 'CAPTURE');
  assert.equal(b.payment_source.paypal.experience_context.landing_page, 'GUEST_CHECKOUT');
  assert.equal(b.payment_source.paypal.experience_context.return_url, 'https://x.example/api/return');
  assert.equal(pu.amount.value, '3.35');
  assert.equal(pu.amount.breakdown.item_total.value, '3.35');
  assert.deepEqual(pu.items.map((i) => i.unit_amount.value), ['1.10', '2.20', '0.05']);
  assert.ok(pu.items.every((i) => i.unit_amount.currency_code === 'USD'));
});

test('buildOrderBody: refuses a total that is not the sum of its lines', () => {
  assert.throws(() => buildOrderBody({ lines: [{ id: 'a', title: 'A', shop: 's', price_cents: 100 }], total_cents: 1, sessionId: 's', returnUrl: 'https://x', cancelUrl: 'https://x' }), /sum/);
});

// ---- /api/checkout -------------------------------------------------------------------------------------------------

test('checkout: a tampered client price, title and total are ignored; PayPal gets the server amount', async () => {
  const h = makeHarness();
  const sessionId = await seedSession(h, [A, B], 10000);
  const res = await h.post('/api/checkout', {
    sessionId,
    itemIds: ['pa', 'pb'],
    prices: { pa: 1 },
    total_cents: 1,
    total: '0.01',
    amount: { value: '0.01' },
    lines: [{ id: 'pa', price_cents: 1, title: 'free' }],
  });
  assert.equal(res.status, 200);
  const j = (await res.json()) as any;
  assert.equal(j.total_cents, 3650);
  assert.deepEqual(j.lines.map((l: any) => l.price_cents), [1250, 2400]);
  assert.equal(j.sandbox, true);
  assert.ok(j.approveUrl.startsWith('https://www.sandbox.paypal.com/'));
  const [post] = orderPosts(h);
  assert.equal(post!.body.purchase_units[0].amount.value, '36.50');
  assert.equal(post!.body.payment_source.paypal.experience_context.landing_page, 'GUEST_CHECKOUT');
  assert.ok(post!.headers['PayPal-Request-Id'], 'create call carries a PayPal-Request-Id');
});

test('checkout: a selection above the buyer budget is refused before PayPal is contacted', async () => {
  const h = makeHarness();
  const sessionId = await seedSession(h, [A, B], 3000);
  const res = await h.post('/api/checkout', { sessionId, itemIds: ['pa', 'pb'] });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as any).error.code, 'over_budget');
  assert.equal(h.net.count('api-m.sandbox.paypal.com'), 0);
});

test('checkout: unknown, link-only, empty and malformed selections get 400; a missing session gets 404', async () => {
  const h = makeHarness();
  const sessionId = await seedSession(h, [A, card('lnk', 0, { purchasable: false, source: 'tavily' })], 10000);
  for (const [ids, code] of [[['zzz'], 'unknown_item'], [['lnk'], 'not_purchasable'], [[], 'empty'], ['pa', 'bad_request']] as const) {
    const res = await h.post('/api/checkout', { sessionId, itemIds: ids });
    assert.equal(res.status, 400, code);
    assert.equal(((await res.json()) as any).error.code, code);
  }
  for (const sid of ['s00000000000000000000', 'nope', 42, undefined]) {
    const res = await h.post('/api/checkout', { sessionId: sid, itemIds: ['pa'] });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as any).error.code, 'session_expired');
  }
  assert.equal(h.net.count('api-m.sandbox.paypal.com'), 0);
});

test('checkout: the global daily cap stops further orders; the same selection is reused and costs nothing', async () => {
  const h = makeHarness({ LIMIT_DAILY_CAP_USD: '50' });
  const sessionId = await seedSession(h, [card('c1', 3000), card('c2', 3000)], 10000);
  const first = await h.post('/api/checkout', { sessionId, itemIds: ['c1'] });
  assert.equal(first.status, 200);
  const again = (await (await h.post('/api/checkout', { sessionId, itemIds: ['c1'] })).json()) as any;
  assert.equal(again.reused, true);
  const over = await h.post('/api/checkout', { sessionId, itemIds: ['c2'] });
  assert.equal(over.status, 429);
  const e = ((await over.json()) as any).error;
  assert.deepEqual([e.code, e.message], ['limit', LIMIT_MESSAGE.global]);
  assert.equal(orderPosts(h).length, 1);
});

test('checkout: the reserved cap is given back when PayPal fails', async () => {
  const h = makeHarness({ LIMIT_DAILY_CAP_USD: '30' });
  const sessionId = await seedSession(h, [card('c1', 3000)], 10000);
  h.net.down.add('api-m.sandbox.paypal.com');
  const failed = await h.post('/api/checkout', { sessionId, itemIds: ['c1'] });
  assert.equal(failed.status, 502);
  assert.equal(((await failed.json()) as any).error.code, 'upstream');
  h.net.down.delete('api-m.sandbox.paypal.com');
  assert.equal((await h.post('/api/checkout', { sessionId, itemIds: ['c1'] })).status, 200); // 30.00 fits the 30.00 cap again
});

test('checkout: the per-IP order limit answers 429 with the per-IP message', async () => {
  const h = makeHarness({ LIMIT_IP_ORDERS: '1' });
  const sessionId = await seedSession(h, [A, B], 10000);
  assert.equal((await h.post('/api/checkout', { sessionId, itemIds: ['pa'] })).status, 200);
  const res = await h.post('/api/checkout', { sessionId, itemIds: ['pb'] });
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as any).error.message, LIMIT_MESSAGE.ip);
});

test('checkout: the same selection in any order is one PayPal order', async () => {
  const h = makeHarness();
  const sessionId = await seedSession(h, [A, B], 10000);
  const one = (await (await h.post('/api/checkout', { sessionId, itemIds: ['pa', 'pb'] })).json()) as any;
  const two = (await (await h.post('/api/checkout', { sessionId, itemIds: ['pb', 'pa', 'pa'] })).json()) as any;
  assert.equal(one.reused, false);
  assert.equal(two.reused, true);
  assert.equal(two.orderId, one.orderId);
  assert.equal(orderPosts(h).length, 1);
});

test('checkout: an approve link that is not on the sandbox host is replaced', async () => {
  const h = makeHarness();
  h.net.intercept = (path, init) =>
    init?.method === 'POST' && path === '/v2/checkout/orders'
      ? new Response(JSON.stringify({ id: 'EVIL000000001', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://evil.example/pay' }] }), { status: 201 })
      : undefined;
  const sessionId = await seedSession(h, [A], 10000);
  const j = (await (await h.post('/api/checkout', { sessionId, itemIds: ['pa'] })).json()) as any;
  assert.equal(j.approveUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=EVIL000000001');
});

// ---- return from PayPal: capture only after APPROVED ------------------------------------------------------------------

async function createdOrder(h: ReturnType<typeof makeHarness>, cards = [A], ids = ['pa']) {
  const sessionId = await seedSession(h, cards, 10000);
  const j = (await (await h.post('/api/checkout', { sessionId, itemIds: ids })).json()) as any;
  return j.orderId as string;
}
const receipt = async (h: ReturnType<typeof makeHarness>, id: string) => (await (await h.req(`/api/orders/${id}`)).json()) as any;

test('return: nothing is captured before the buyer approved on PayPal', async () => {
  const h = makeHarness();
  const id = await createdOrder(h);
  const res = await h.req(`/api/return?token=${id}&PayerID=X`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/#/receipt/${id}`);
  const r = await receipt(h, id);
  assert.equal(r.status, 'NOT_APPROVED');
  assert.equal(captures(h).length, 0);
});

test('return: an approved order is captured exactly once and shows its capture id', async () => {
  const h = makeHarness();
  const id = await createdOrder(h);
  h.net.orders.get(id)!.status = 'APPROVED';
  await h.req(`/api/return?token=${id}`);
  await h.req(`/api/return?token=${id}`); // a reload of the return URL must not charge twice
  const r = await receipt(h, id);
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.captureId, 'CAP' + id);
  assert.equal(r.total_cents, 1250);
  assert.equal(captures(h).length, 1);
  assert.equal(captures(h)[0]!.headers['PayPal-Request-Id'], 'cap-' + id);
  assert.ok(r.trace.some((t: string) => /capture_order/.test(t)), 'the receipt says which tools ran');
});

test('return: an amount that differs from the stored order is never captured', async () => {
  const h = makeHarness();
  const id = await createdOrder(h);
  const po = h.net.orders.get(id)!;
  po.status = 'APPROVED';
  po.amount = '1.00';
  await h.req(`/api/return?token=${id}`);
  const r = await receipt(h, id);
  assert.equal(r.status, 'CAPTURE_FAILED');
  assert.match(r.error, /does not match/);
  assert.equal(captures(h).length, 0);
});

test('return: a declined capture is reported in plain words and keeps the order', async () => {
  const h = makeHarness();
  const id = await createdOrder(h);
  h.net.orders.get(id)!.status = 'APPROVED';
  h.net.intercept = (path) => (path.endsWith('/capture') ? new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] }), { status: 422 }) : undefined);
  await h.req(`/api/return?token=${id}`);
  const r = await receipt(h, id);
  assert.equal(r.status, 'CAPTURE_FAILED');
  assert.match(r.error, /declined/);
  assert.doesNotMatch(JSON.stringify(r), /INSTRUMENT_DECLINED|UNPROCESSABLE/);
  // the buyer can try again: after PayPal accepts it the same order completes
  h.net.intercept = undefined;
  await h.req(`/api/return?token=${id}`);
  assert.equal((await receipt(h, id)).status, 'COMPLETED');
});

test('cancel: an unpaid order is cancelled and goes back to checkout; a paid one is untouched', async () => {
  const h = makeHarness();
  const unpaid = await createdOrder(h);
  const res = await h.req(`/api/cancel?token=${unpaid}`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/#/checkout?cancelled=1');
  assert.equal((await receipt(h, unpaid)).status, 'CANCELLED');

  const paid = await createdOrder(h, [B], ['pb']);
  h.net.orders.get(paid)!.status = 'APPROVED';
  await h.req(`/api/return?token=${paid}`);
  await h.req(`/api/cancel?token=${paid}`);
  assert.equal((await receipt(h, paid)).status, 'COMPLETED');
});

test('return and receipt: junk tokens and unknown orders are handled', async () => {
  const h = makeHarness();
  const res = await h.req('/api/return?token=%3Cscript%3E', { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/#/receipt/unknown');
  assert.equal((await h.req('/api/orders/ABCDEFGH12345')).status, 404);
  assert.equal((await h.req('/api/orders/..%2F..%2Fx')).status, 404);
  assert.equal(h.net.count('api-m.sandbox.paypal.com'), 0);
});

test('the browser view of an order carries no approve link, session id or payer data', async () => {
  const h = makeHarness();
  const id = await createdOrder(h);
  const raw = JSON.stringify(await receipt(h, id));
  assert.doesNotMatch(raw, /approveUrl|sandbox\.paypal\.com|sessionId|payer/i);
});
