// The agent: Nemotron proposes, the server disposes. The real app with a fake network and scripted (also hostile) models.
import assert from 'node:assert/strict';
import test from 'node:test';
import { groundedReason, templateReason } from '../src/agent/ideas.ts';
import { runLoop, ToolError, toolSpec, type Tool } from '../src/agent/loop.ts';
import type { FetchFn } from '../src/types.ts';
import { card, chatReply, FAVS, json, makeHarness, makeSvc, readEvents, seedSession, taskOf, toolCall } from './helpers.ts';

const DONE = () => chatReply({ content: 'DONE' });
const calls = (...c: ReturnType<typeof toolCall>[]) => chatReply({ content: null, tool_calls: c }, 'tool_calls');
/** A scripted Nebius: one handler per [task:...] marker; n is the turn of the tool loop (1 for single-shot tasks). Unscripted tasks answer DONE. */
const model =
  (tasks: Record<string, (n: number, body: any) => Response>): FetchFn =>
  async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const n = body.messages.filter((m: any) => m.role === 'assistant').length + 1;
    return (tasks[taskOf(init)] ?? DONE)(n, body);
  };
const run = async (h: ReturnType<typeof makeHarness>, body: unknown = { favorites: FAVS, budget_usd: 120 }) => (await readEvents(await h.post('/api/ideas', body))) as any[];
const channel3Caps = (h: ReturnType<typeof makeHarness>) => h.net.calls.filter((c) => c.host === 'api.trychannel3.com').map((c) => c.body.filters.price.max_price as number);

// ---- gift ideas -----------------------------------------------------------------------------------------------------------

test('ideas: a full run streams its steps, ties each idea to the favourites and stores the cards on the server', async () => {
  const h = makeHarness();
  const ev = await run(h);
  assert.equal(ev[0].t, 'meta');
  assert.deepEqual([ev[0].mocks, ev[0].example, ev[0].budget_cents], [['qloo', 'nebius'], false, 12000]);
  assert.equal(ev.at(-1).t, 'done');
  const ideas = ev.filter((e) => e.t === 'idea');
  assert.ok(ideas.length >= 3 && ideas.length <= 6, `${ideas.length} ideas`);
  const loved = FAVS.map((f) => f.text);
  for (const { idea, cards } of ideas) {
    assert.ok(idea.because.every((b: string) => loved.includes(b)), `${idea.title}: ${idea.because}`);
    assert.ok(cards.length >= (idea.kind === 'experience' ? 1 : 2), idea.title);
    for (const c of cards) {
      assert.equal(c.purchasable, idea.kind === 'product', c.title);
      if (c.purchasable) assert.ok(Number.isInteger(c.price_cents) && c.price_cents > 0 && c.price_cents <= 12000, `${c.title} ${c.price_cents}`);
      else assert.equal(c.price_cents, 0);
    }
  }
  assert.ok(ideas.some((i) => i.idea.kind === 'product'));
  const reasons = ev.find((e) => e.t === 'reasons').reasons;
  for (const { idea } of ideas) assert.ok(groundedReason(reasons[idea.id], idea), reasons[idea.id]);
  const stored = JSON.parse(h.kv._m.get(`s:${ev[0].session}`)!);
  assert.equal(stored.budget_cents, 12000);
  assert.deepEqual(stored.cards.map((c: any) => c.id).sort(), ideas.flatMap((i) => i.cards.map((c: any) => c.id)).sort());
  assert.deepEqual([...new Set(h.net.calls.map((c) => c.host))].sort(), ['api.tavily.com', 'api.trychannel3.com'], 'Qloo and Nebius were fake servers, not the internet');
});

test('ideas: with Nebius down the fixed pipeline still delivers ideas with template reasons', async () => {
  const h = makeHarness({}, { mocks: { nebius: async () => json({ error: 'overloaded' }, 503) } });
  const ev = await run(h);
  assert.deepEqual([ev.at(-1).t, ev.at(-1).tier], ['done', 'template']);
  const ideas = ev.filter((e) => e.t === 'idea');
  assert.ok(ideas.length >= 3);
  const reasons = ev.find((e) => e.t === 'reasons').reasons;
  for (const { idea } of ideas) assert.equal(reasons[idea.id], templateReason(idea));
});

test('ideas: a model that never calls a tool and answers in prose is replaced by the fixed pipeline', async () => {
  const h = makeHarness({}, { mocks: { nebius: model({ ideas: () => chatReply({ content: 'I think they would like tea.' }), picks: () => chatReply({ content: 'no idea' }), reasons: () => chatReply({ content: '```json\n{"reasons": nope}\n```' }) }) } });
  const ev = await run(h);
  assert.deepEqual([ev.at(-1).t, ev.at(-1).tier], ['done', 'pipeline']);
  const ideas = ev.filter((e) => e.t === 'idea');
  assert.ok(ideas.length >= 3);
  const reasons = ev.find((e) => e.t === 'reasons').reasons;
  for (const { idea } of ideas) assert.equal(reasons[idea.id], templateReason(idea));
});

test('ideas: a hostile model cannot invent ids, lift the price cap or plant prices and links in the reasons', async () => {
  const candidates = (body: any): string[] => {
    const tool = body.messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content)).find((v: any) => Array.isArray(v.candidates));
    return tool ? tool.candidates.map((c: any) => c.id) : [];
  };
  const h = makeHarness(
    {},
    {
      mocks: {
        nebius: model({
          ideas: (n, body) => {
            if (n === 1) return calls(toolCall('qloo_search', { query: 'Muji' }, 'a'), toolCall('qloo_search', { query: 'Nujabes', type: 'artist' }, 'b'), toolCall('qloo_search', { query: 'Kafka on the Shore', type: 'book' }, 'c'));
            if (n === 2) return calls(toolCall('qloo_insights', { target_type: 'brand' }, 'd'), toolCall('qloo_insights', { target_type: 'weapon' }, 'e'));
            if (n === 3) {
              const [first] = candidates(body);
              return calls(
                toolCall('find_products', { entity_id: first, query: 'anything cheap', max_price_usd: 1e9 }, 'f'),
                toolCall('find_products', { entity_id: 'E-INVENTED', query: 'free money' }, 'g'),
                toolCall('delete_everything', { all: true }, 'h'),
              );
            }
            return DONE();
          },
          picks: () => chatReply({ content: JSON.stringify({ picks: [{ entity_id: 'E-INVENTED', query: 'x' }, { entity_id: 'also-not-real', query: 'y' }] }) }),
          reasons: (_n, body) => {
            const ideas = JSON.parse(body.messages[1].content).ideas as { id: string; because: string[] }[];
            const out = Object.fromEntries(ideas.map((i, k) => [i.id, k === 0 ? `Because they love ${i.because[0]}, this is a thoughtful pick.` : k % 2 ? 'Only $5 at https://evil.example/buy now, hurry!' : 'A wonderful present that anybody would adore.']));
            return chatReply({ content: JSON.stringify({ reasons: out }) });
          },
        }),
      },
    },
  );
  const ev = await run(h);
  assert.equal(ev.at(-1).t, 'done', JSON.stringify(ev.at(-1)));
  const ideas = ev.filter((e) => e.t === 'idea');
  assert.ok(ideas.length >= 3);
  assert.ok(ideas.every((i) => i.idea.entity.id !== 'E-INVENTED'));
  assert.ok(channel3Caps(h).every((usd) => usd <= 120), `price caps sent to Channel3: ${channel3Caps(h)}`);
  assert.ok(channel3Caps(h).includes(120), 'the model asked for a cap of a billion dollars and got the buyer\'s budget');
  const prices = ideas.flatMap((i) => i.cards.map((c: any) => c.price_cents));
  assert.ok(prices.every((p: number) => p <= 12000));
  const reasons = ev.find((e) => e.t === 'reasons').reasons;
  for (const { idea } of ideas) {
    const r = reasons[idea.id] as string;
    assert.ok(groundedReason(r, idea), r);
    assert.ok(!/\$|evil|anybody would adore/.test(r), r);
  }
  const first = ideas[0].idea;
  assert.equal(reasons[first.id], `Because they love ${first.because[0]}, this is a thoughtful pick.`, 'a grounded model sentence is kept');
});

test('ideas: names Qloo cannot place end in a plain bad_input error and spend nothing on products', async () => {
  const h = makeHarness({}, { mocks: { qloo: async () => json({ results: [] }) } });
  const last = (await run(h)).at(-1);
  assert.deepEqual([last.t, last.code], ['error', 'bad_input']);
  assert.match(last.message, /None of those names were recognised/);
  assert.equal(h.net.count('api.trychannel3.com') + h.net.count('api.tavily.com'), 0);
});

test('ideas: a catalog that answers with nothing is a step that worked; one that is down is a step that failed', async () => {
  const productCalls = (ev: any[]) => ev.filter((e) => e.t === 'call' && e.tool === 'find_products' && !e.arg.endsWith('(experiences)'));
  const empty = makeHarness();
  empty.net.intercept = (path) => (path === '/v1/search' ? json({ products: [] }) : undefined);
  const worked = productCalls(await run(empty));
  assert.ok(worked.length > 0 && worked.every((c) => c.ok === true && /^0 products/.test(c.out)), JSON.stringify(worked));
  const down = makeHarness();
  down.net.down.add('api.trychannel3.com');
  const failed = productCalls(await run(down));
  assert.ok(failed.length > 0 && failed.every((c) => c.ok === false), JSON.stringify(failed));
});

test('ideas: when the first picks match nothing in the catalog, the top-up moves on to other entities instead of repeating them', async () => {
  const h = makeHarness({}, { mocks: { nebius: async () => json({ error: 'overloaded' }, 503) } });
  const empty = new Set<string>(); // the first five different product searches find nothing, as niche real entities often do
  h.net.intercept = (path, init) => {
    if (path !== '/v1/search') return undefined;
    const q = String(JSON.parse(String(init?.body)).query);
    if (empty.size < 5) empty.add(q);
    return empty.has(q) ? json({ products: [] }) : undefined;
  };
  const ev = await run(h);
  const searched = ev.filter((e) => e.t === 'call' && e.tool === 'find_products').map((c) => c.arg);
  assert.equal(new Set(searched).size, searched.length, 'an entity was searched twice: ' + searched.join(' | '));
  assert.ok(searched.length > 5 && searched.length <= 8, 'it should go past the first five entities but stop at 8: ' + searched.join(' | '));
});

test('ideas: Qloo down ends in an upstream error with a plain retry message', async () => {
  const h = makeHarness({}, { mocks: { qloo: async () => json({ message: 'down' }, 503) } });
  const last = (await run(h)).at(-1);
  assert.deepEqual([last.t, last.code], ['error', 'upstream']);
  assert.match(last.message, /try again in a minute/i);
});

test('ideas: bad requests get a 400 with a plain message, touch no upstream and cost no quota', async () => {
  const h = makeHarness({ LIMIT_IP_IDEAS: '1' });
  const send = (raw: string) => h.req('/api/ideas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  const cases = [
    JSON.stringify({ favorites: ['a', 'b'], budget_usd: 50 }),
    JSON.stringify({ favorites: FAVS, budget_usd: 5 }),
    '{not json',
    '[]',
    'null',
    '',
    JSON.stringify({ favorites: FAVS, budget_usd: 50, pad: 'x'.repeat(9000) }),
  ];
  for (const raw of cases) {
    const r = await send(raw);
    assert.equal(r.status, 400, raw.slice(0, 40));
    assert.equal(((await r.json()) as any).error.code, 'bad_input');
  }
  assert.equal(h.net.calls.length, 0);
  const ok = await send(JSON.stringify({ favorites: FAVS, budget_usd: 50 }));
  assert.equal(ok.status, 200);
  await ok.text();
});

test('sample: the cached example replays with no upstream call and its cards can be bought', async () => {
  const h = makeHarness();
  const ev = (await readEvents(await h.post('/api/sample', {}))) as any[];
  assert.deepEqual([ev[0].t, ev[0].example, ev.at(-1).tier], ['meta', true, 'example']);
  assert.equal(h.net.calls.length, 0);
  const buyable = ev.filter((e) => e.t === 'idea').flatMap((e) => e.cards).filter((c: any) => c.purchasable);
  assert.ok(buyable.length >= 4);
  const pick = buyable.slice(0, 2);
  const res = await h.post('/api/checkout', { sessionId: ev[0].session, itemIds: pick.map((c: any) => c.id) });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).total_cents, pick[0].price_cents + pick[1].price_cents);
});

// ---- checkout and return through the agent ----------------------------------------------------------------------------------

const A = card('pa', 2000);
const B = card('pb', 3000);
const X = card('px', 9000);
const orderPosts = (h: ReturnType<typeof makeHarness>) => h.net.calls.filter((c) => c.method === 'POST' && c.path === '/v2/checkout/orders');
const captures = (h: ReturnType<typeof makeHarness>) => h.net.calls.filter((c) => c.path.endsWith('/capture'));
const order = async (h: ReturnType<typeof makeHarness>, id: string) => (await (await h.req(`/api/orders/${id}`)).json()) as any;
async function checkout(h: ReturnType<typeof makeHarness>) {
  const sessionId = await seedSession(h, [A, B, X], 12000);
  const res = await h.post('/api/checkout', { sessionId, itemIds: ['pa', 'pb'] });
  assert.equal(res.status, 200);
  return (await res.json()) as any;
}

test('checkout: Nemotron creates the order when it asks for exactly the selection', async () => {
  const h = makeHarness();
  const j = await checkout(h);
  assert.equal(j.total_cents, 5000);
  assert.equal(orderPosts(h).length, 1);
  assert.ok((await order(h, j.orderId)).trace.some((l: string) => /^Nemotron called create_order: CREATED, total \$50\.00/.test(l)));
});

test('checkout: a model that asks for other items still gets exactly the buyer\'s selection, created by the server', async () => {
  const h = makeHarness({}, { mocks: { nebius: model({ checkout: () => calls(toolCall('create_order', { item_ids: ['pa', 'pb', 'px'] })) }) } });
  const j = await checkout(h);
  assert.equal(j.total_cents, 5000);
  assert.equal(orderPosts(h).length, 1, 'one order, not one per attempt');
  assert.equal(orderPosts(h)[0]!.body.purchase_units[0].amount.value, '50.00');
  const trace = (await order(h, j.orderId)).trace as string[];
  assert.ok(trace.some((l) => /^Server created the order directly/.test(l)));
  assert.ok(!trace.some((l) => /Nemotron called create_order/.test(l)));
});

test('checkout: a model outage never blocks the payment', async () => {
  const h = makeHarness({}, { mocks: { nebius: async () => json({ error: 'down' }, 503) } });
  const j = await checkout(h);
  assert.equal(j.total_cents, 5000);
  assert.equal(orderPosts(h).length, 1);
});

test('return: a model that calls capture_order at once cannot capture an order PayPal has not approved', async () => {
  let id = '';
  const h = makeHarness({}, { mocks: { nebius: model({ return: (n) => (n === 1 ? calls(toolCall('capture_order', { order_id: id })) : DONE()) }) } });
  id = (await checkout(h)).orderId;
  await h.req(`/api/return?token=${id}`);
  assert.equal(captures(h).length, 0);
  const o = await order(h, id);
  assert.equal(o.status, 'NOT_APPROVED');
  assert.ok(o.trace.some((l: string) => /^Nemotron called capture_order: NOT_APPROVED/.test(l)), o.trace.join(' | '));
});

test('return: get_order and capture_order for another order id are refused; the server finishes only the real, approved order', async () => {
  let id = '';
  const other = 'OTHERORDER123456';
  const h = makeHarness({}, { mocks: { nebius: model({ return: (n) => (n === 1 ? calls(toolCall('get_order', { order_id: other }, 'a'), toolCall('capture_order', { order_id: other }, 'b')) : DONE()) }) } });
  id = (await checkout(h)).orderId;
  h.net.orders.get(id)!.status = 'APPROVED';
  await h.req(`/api/return?token=${id}`);
  assert.ok(h.net.calls.every((c) => !c.path.includes(other)), 'PayPal was never asked about the other order');
  assert.equal(captures(h).length, 1);
  assert.ok(captures(h)[0]!.path.includes(id));
  assert.equal((await order(h, id)).status, 'COMPLETED');
});

// ---- the tool loop ----------------------------------------------------------------------------------------------------------

const echo: Tool = {
  spec: toolSpec('echo', 'echo a value', { v: { type: 'string' } }, ['v']),
  run: async (a) => {
    if (a.v === 'bad') throw new ToolError('v is not allowed');
    if (a.v === 'boom') throw new Error('boom');
    return { v: a.v };
  },
};
const loop = async (nebius: FetchFn, o: Partial<Parameters<typeof runLoop>[1]> = {}) => {
  const { svc } = await makeSvc({}, undefined, { nebius });
  return runLoop(svc, { model: 'm', system: '[task:t]', user: {}, tools: [echo], maxTurns: 5, ...o });
};

test('runLoop: a ToolError goes back to the model, which can correct itself', async () => {
  const lastMsg: string[] = [];
  const res = await loop(
    model({
      t: (n, body) => {
        lastMsg.push(body.messages.at(-1).content);
        return n === 1 ? calls(toolCall('echo', { v: 'bad' })) : n === 2 ? calls(toolCall('echo', { v: 'good' })) : DONE();
      },
    }),
  );
  assert.deepEqual(res, { turns: 3, calls: 2, bad: 1, stopped: 'done' });
  assert.match(lastMsg[1]!, /v is not allowed/);
  assert.match(lastMsg[2]!, /"v":"good"/);
});

test('runLoop: unknown tools and non-object arguments count as bad, and three bad calls stop the loop', async () => {
  const res = await loop(model({ t: (n) => (n === 1 ? calls(toolCall('nope', {}, 'a'), toolCall('echo', '"just a string"', 'b')) : calls(toolCall('nope2', {}, 'c'))) }));
  assert.deepEqual(res, { turns: 2, calls: 0, bad: 3, stopped: 'bad_calls' });
});

test('runLoop: stopAfter ends right after that tool, and max_turns bounds a model that never stops', async () => {
  const always = model({ t: () => calls(toolCall('echo', { v: 'again' })) });
  assert.deepEqual(await loop(always, { stopAfter: ['echo'] }), { turns: 1, calls: 1, bad: 0, stopped: 'stop_after' });
  assert.deepEqual(await loop(always, { maxTurns: 3 }), { turns: 3, calls: 3, bad: 0, stopped: 'max_turns' });
});

test('runLoop: a bug in a handler is raised, not hidden as a bad call', async () => {
  await assert.rejects(loop(model({ t: () => calls(toolCall('echo', { v: 'boom' })) })), /boom/);
});
