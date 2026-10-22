import { Hono } from 'hono';
import type { Context } from 'hono';
import { HttpError, BudgetError, readText, type Svc, type ServiceName } from './lib/http.ts';
import { LimitError, Meter, meterApi, visitorOf } from './lib/limits.ts';
import { storeFor } from './lib/store.ts';
import { dayKey, sha256Hex, sleep } from './lib/util.ts';
import { loadConfig, publicStatus, secretsOf } from './config.ts';
import { cancelOrder, loadOrder, loadSession, ORDER_MESSAGES, OrderError, publicOrder } from './commerce.ts';
import { validOrderId } from './adapters/paypal.ts';
import { InputError, parseIdeasInput, qlooCallsNeeded, runIdeas } from './agent/ideas.ts';
import { agentCheckout, agentReturn } from './agent/orders.ts';
import { aiBindingFetch } from './adapters/ai.ts';
import { makeAiFake } from './mocks/ai-fake.ts';
import { makeQlooFake, qlooFake } from './mocks/qloo-fake.ts';
import { EXAMPLE_ID, sampleEvents, sampleSession } from './sample.ts';
import type { Env, FetchFn, StreamEvent } from './types.ts';

export interface Deps {
  fetch?: FetchFn;
  /** test hook: replaces the Qloo and model fake servers */
  mocks?: Partial<Record<ServiceName, FetchFn>>;
  /** test hook: skip the pacing delays of the example replay */
  fast?: boolean;
}

type AppEnv = { Bindings: Env; Variables: { svc: Svc } };

const SUB_BUDGET = 40; // Workers Free: 50 subrequests per invocation

export const LIMIT_MESSAGE = {
  ip: 'You have reached today’s allowance for live lookups. The example still works, or come back tomorrow.',
  global: 'The demo has reached its daily budget for live data. The example still works, or come back tomorrow.',
} as const;
/** Same limits, seen from the checkout screen (sandbox orders and the daily spend cap). */
export const ORDER_LIMIT_MESSAGE = {
  ip: 'You have used today’s allowance of sandbox orders. Come back tomorrow.',
  global: 'The demo has reached its daily cap on sandbox orders. Come back tomorrow.',
} as const;

export function createApp(deps: Deps = {}) {
  const app = new Hono<AppEnv>();
  // Fake Qloo and model servers (doc-shaped responses) answer while the Qloo key or the AI binding is missing; slightly paced so the step list is readable
  const qlooMock = deps.fast ? qlooFake : makeQlooFake({ delayMs: 250 });
  const aiMock = makeAiFake({ delayMs: deps.fast ? 0 : 450 });

  // every API answer, the NDJSON stream and errors included (static files get theirs from public/_headers)
  app.use('/api/*', async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('Cache-Control', 'no-store');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  });

  app.use('/api/*', async (c, next) => {
    // JSON only: another site can send a form or text/plain post without a CORS preflight, JSON needs one we never grant
    if (c.req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) {
      return c.json({ error: { code: 'bad_input', message: 'Send the request as JSON.' } }, 415);
    }
    const cfg = loadConfig(c.env);
    const store = storeFor(c.env.KV);
    // cf-connecting-ip is always set on Cloudflare; x-forwarded-for only matters under wrangler dev
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    const day = dayKey();
    const ipHash = (await sha256Hex(`${day}:${visitorOf(ip)}`)).slice(0, 16); // no raw IP is ever stored
    const meter = new Meter(meterApi(c.env), cfg.limits, ipHash, day);
    const mocks: Svc['mocks'] = {};
    if (cfg.qloo === 'mock') mocks.qloo = qlooMock;
    if (cfg.ai === 'mock') mocks.ai = aiMock;
    Object.assign(mocks, deps.mocks);
    const direct: Svc['direct'] = cfg.ai === 'live' && c.env.AI ? { ai: aiBindingFetch(c.env.AI) } : {};
    c.set('svc', { cfg, fetch: deps.fetch ?? ((u, i) => fetch(u, i)), store, meter, sub: { left: SUB_BUDGET }, mocks, direct });
    await next();
  });

  app.get('/api/status', async (c) => c.json({ ...publicStatus(c.get('svc').cfg), usage: (await c.get('svc').meter.used()).global }));

  app.post('/api/sample', (c) => {
    const svc = c.get('svc');
    const session = sampleSession();
    return ndjson(c, async (emit) => {
      const mocks = publicStatus(svc.cfg).mocks; // the example is not saved: its id is fixed and the checkout builds it from code
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
      // The caps that block are looked at before the run starts: one that cannot finish is refused whole and spends no Qloo call (demo data costs none).
      // The model never blocks: its cap only switches the run to the fixed pipeline. Shop and web search degrade inside the run.
      if (!svc.mocks.qloo) await svc.meter.ensure({ qloo: qlooCallsNeeded(parsed.value) });
      await svc.meter.take({ ideas: 1 });
    } catch (e) {
      return fail(c, e);
    }
    return ndjson(c, (emit) => runIdeas(svc, parsed.value, emit));
  });

  app.post('/api/checkout', async (c) => {
    const svc = c.get('svc');
    const body = await readJson(c);
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!/^s[0-9a-f]{20}$/.test(sessionId)) return c.json({ error: { code: 'session_expired', message: ORDER_MESSAGES.session_expired } }, 404);
    try {
      const session = sessionId === EXAMPLE_ID ? sampleSession() : await loadSession(svc, sessionId);
      if (!session) throw new OrderError('session_expired', ORDER_MESSAGES.session_expired);
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
    try {
      await agentReturn(c.get('svc'), id);
    } catch (e) {
      if (!(e instanceof LimitError)) throw e; // today's allowance of returns is used up: the receipt shows the order as it stands
    }
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
    console.error('unhandled', logOf(e));
    return c.json({ error: { code: 'internal', message: 'Something went wrong on our side. Please try again.' } }, 500);
  });

  return app;
}

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown> | undefined> {
  const text = await readText(c.req.raw, 8192); // stops after 8 KB, whatever the client sends (Cloudflare accepts 100 MB)
  if (text === undefined) return undefined;
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
  if (e instanceof LimitError) return { status: 429, code: 'limit', message: (e.counter === 'orders' || e.counter === 'cents' ? ORDER_LIMIT_MESSAGE : LIMIT_MESSAGE)[e.scope] };
  if (e instanceof HttpError || e instanceof BudgetError) return { status: 502, code: 'upstream', message: 'Please try again in a minute.' };
  return { status: 500, code: 'internal', message: 'Something went wrong on our side. Please try again.' };
}

/** A failure as logs may show it: kind, service and status, never upstream text (it can echo what the visitor typed). */
function logOf(e: unknown): string {
  if (e instanceof HttpError) return `${e.service} HTTP ${e.status}`;
  return e instanceof Error ? `${e.name} ${e.stack?.split('\n')[1]?.trim() ?? ''}` : typeof e;
}

function fail(c: Context<AppEnv>, e: unknown) {
  const d = describeError(e);
  if (d.status >= 500 || d.code === 'upstream') console.error('request failed:', d.code, logOf(e));
  return c.json({ error: { code: d.code, message: d.message } }, d.status);
}

/** Stream newline-delimited JSON events; the producer runs after the response starts, so the browser sees progress live. */
export function ndjson(c: Context<AppEnv>, producer: (emit: (e: StreamEvent) => void) => Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const emit = (e: StreamEvent) => void w.write(enc.encode(JSON.stringify(e) + '\n')).catch(() => {});
  const job = (async () => {
    try {
      await producer(emit);
    } catch (e) {
      const d = describeError(e);
      console.error('stream failed:', d.code, logOf(e));
      emit({ t: 'error', code: d.code === 'limit' || d.code === 'upstream' || d.code === 'bad_input' ? d.code : 'internal', message: d.message });
    } finally {
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
