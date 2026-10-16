import { Hono } from 'hono';
import type { Context } from 'hono';
import { HttpError, BudgetError, type Svc, type ServiceName } from './lib/http.ts';
import { LimitError, Meter } from './lib/limits.ts';
import { storeFor } from './lib/store.ts';
import { dayKey, sha256Hex, sleep, errMsg } from './lib/util.ts';
import { loadConfig, publicStatus, secretsOf } from './config.ts';
import { cancelOrder, loadOrder, loadSession, OrderError, publicOrder, saveSession } from './commerce.ts';
import { validOrderId } from './adapters/paypal.ts';
import { InputError, parseIdeasInput, runIdeas } from './agent/ideas.ts';
import { agentCheckout, agentReturn } from './agent/orders.ts';
import { makeNebiusFake } from './mocks/nebius-fake.ts';
import { makeQlooFake, qlooFake } from './mocks/qloo-fake.ts';
import { sampleEvents, sampleSession } from './sample.ts';
import type { Env, FetchFn, StreamEvent } from './types.ts';

export interface Deps {
  fetch?: FetchFn;
  /** test hook: replaces the Qloo and Nebius fake servers */
  mocks?: Partial<Record<ServiceName, FetchFn>>;
  /** test hook: skip the pacing delays of the example replay */
  fast?: boolean;
}

type AppEnv = { Bindings: Env; Variables: { svc: Svc } };

const SUB_BUDGET = 40; // Workers Free: 50 subrequests per invocation

export const LIMIT_MESSAGE = {
  ip: 'You have used up your live lookups for today. Try the example, or come back tomorrow.',
  global: 'The demo has reached its daily limit for live data. Try the example, or come back tomorrow.',
} as const;

export function createApp(deps: Deps = {}) {
  const app = new Hono<AppEnv>();
  // Fake Qloo and Nebius servers (doc-shaped responses) answer while those keys are missing; slightly paced so the step list is readable
  const qlooMock = deps.fast ? qlooFake : makeQlooFake({ delayMs: 250 });
  const nebiusMock = makeNebiusFake({ delayMs: deps.fast ? 0 : 450 });

  app.use('/api/*', async (c, next) => {
    const cfg = loadConfig(c.env);
    const store = storeFor(c.env.KV);
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    const day = dayKey();
    const ipHash = (await sha256Hex(`${day}:${ip}`)).slice(0, 16); // no raw IP is ever stored
    const meter = await Meter.load(store, cfg.limits, ipHash, day);
    const mocks: Svc['mocks'] = {};
    if (cfg.qloo === 'mock') mocks.qloo = qlooMock;
    if (cfg.nebius === 'mock') mocks.nebius = nebiusMock;
    Object.assign(mocks, deps.mocks);
    c.set('svc', { cfg, fetch: deps.fetch ?? ((u, i) => fetch(u, i)), store, meter, sub: { left: SUB_BUDGET }, mocks });
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
    await c.get('svc').meter.flush();
  });

  app.get('/api/status', (c) => c.json({ ...publicStatus(c.get('svc').cfg), usage: c.get('svc').meter.used().global }));

  app.post('/api/sample', (c) => {
    const svc = c.get('svc');
    const session = sampleSession();
    return ndjson(c, svc, async (emit) => {
      await saveSession(svc, session);
      const mocks = publicStatus(svc.cfg).mocks;
      for (const step of sampleEvents(session, mocks)) {
        if (!deps.fast) await sleep(step.delay);
        emit(step.e);
      }
    });
  });

  app.post('/api/ideas', async (c) => {
    const svc = c.get('svc');
    const parsed = parseIdeasInput(await readJson(c), svc.cfg.limits);
    if (!parsed.ok) return c.json({ error: { code: 'bad_input', message: parsed.message } }, 400);
    try {
      svc.meter.take('ideas');
    } catch (e) {
      return fail(c, e);
    }
    return ndjson(c, svc, (emit) => runIdeas(svc, parsed.value, emit));
  });

  app.post('/api/checkout', async (c) => {
    const svc = c.get('svc');
    const body = await readJson(c);
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!/^s[0-9a-f]{20}$/.test(sessionId)) return c.json({ error: { code: 'session_expired', message: 'Your session expired. Start again or try the example.' } }, 404);
    try {
      const session = await loadSession(svc, sessionId);
      if (!session) throw new OrderError('session_expired', 'Your session expired. Start again or try the example.');
      // Only item ids are read from the request. Any price, title or total a client sends is ignored.
      const base = svc.cfg.publicBase ?? new URL(c.req.url).origin;
      const { order, reused } = await agentCheckout(svc, session, body?.itemIds, { returnUrl: `${base}/api/return`, cancelUrl: `${base}/api/cancel` });
      return c.json({ orderId: order.id, approveUrl: order.approveUrl, total_cents: order.total_cents, lines: order.lines, reused, sandbox: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/api/orders/:id', async (c) => {
    const id = c.req.param('id');
    const o = validOrderId(id) ? await loadOrder(c.get('svc'), id) : null;
    return o ? c.json(publicOrder(o)) : c.json({ error: { code: 'not_found', message: 'We could not find that order.' } }, 404);
  });

  // PayPal sends the buyer here after approval (?token=<order id>&PayerID=...). Capture happens only here, only after APPROVED.
  app.get('/api/return', async (c) => {
    const id = c.req.query('token') ?? '';
    if (!validOrderId(id)) return c.redirect('/#/receipt/unknown', 302);
    await agentReturn(c.get('svc'), id);
    return c.redirect(`/#/receipt/${id}`, 302);
  });

  app.get('/api/cancel', async (c) => {
    const id = c.req.query('token') ?? '';
    if (validOrderId(id)) await cancelOrder(c.get('svc'), id);
    return c.redirect('/#/checkout?cancelled=1', 302);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
    return c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404);
  });

  app.onError((e, c) => {
    console.error('unhandled', errMsg(e).slice(0, 200));
    return c.json({ error: { code: 'internal', message: 'Something went wrong on our side. Please try again.' } }, 500);
  });

  return app;
}

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown> | undefined> {
  const text = await c.req.text();
  if (text.length > 8192) return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Human message and status for an error; raw upstream text never reaches the browser. */
export function describeError(e: unknown): { status: 400 | 404 | 429 | 502 | 500; code: string; message: string } {
  if (e instanceof InputError) return { status: 400, code: 'bad_input', message: e.message };
  if (e instanceof OrderError) return { status: e.code === 'session_expired' ? 404 : 400, code: e.code, message: e.message };
  if (e instanceof LimitError) return { status: 429, code: 'limit', message: LIMIT_MESSAGE[e.scope] };
  if (e instanceof HttpError || e instanceof BudgetError) return { status: 502, code: 'upstream', message: 'A service we depend on is not answering right now. Try the example, or try again in a minute.' };
  return { status: 500, code: 'internal', message: 'Something went wrong on our side. Please try again.' };
}

function fail(c: Context<AppEnv>, e: unknown) {
  const d = describeError(e);
  if (d.status >= 500 || d.code === 'upstream') console.error('request failed:', d.code, errMsg(e).slice(0, 200));
  return c.json({ error: { code: d.code, message: d.message } }, d.status);
}

/** Stream newline-delimited JSON events; the producer runs after the response starts, so the browser sees progress live. */
export function ndjson(c: Context<AppEnv>, svc: Svc, producer: (emit: (e: StreamEvent) => void) => Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const emit = (e: StreamEvent) => void w.write(enc.encode(JSON.stringify(e) + '\n')).catch(() => {});
  const job = (async () => {
    try {
      await producer(emit);
    } catch (e) {
      const d = describeError(e);
      console.error('stream failed:', d.code, errMsg(e).slice(0, 200));
      emit({ t: 'error', code: d.code === 'limit' || d.code === 'upstream' || d.code === 'bad_input' ? d.code : 'internal', message: d.message });
    } finally {
      await svc.meter.flush();
      await w.close().catch(() => {});
    }
  })();
  try {
    c.executionCtx.waitUntil(job);
  } catch {
    // no execution context outside Workers (unit tests): the promise simply runs on
  }
  return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}

export { secretsOf };
