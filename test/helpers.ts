// Test harness: the real app with a Map-backed KV, the Qloo and Nebius fake servers (default, as in production without keys)
// and one fake "internet" for Channel3, Tavily and the PayPal sandbox, built from synthetic doc-shaped JSON.
import { createApp } from '../src/app.ts';
import { resetPayPalTokenCache } from '../src/adapters/paypal.ts';
import type { Env, FetchFn, StreamEvent } from '../src/types.ts';

export function fakeKV() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    _m: m,
  } as unknown as KVNamespace & { _m: Map<string, string> };
}

const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface Net {
  fetch: FetchFn;
  calls: { host: string; path: string; body?: any }[];
  /** PayPal sandbox order states by id: set to 'APPROVED' to simulate the buyer approving */
  orders: Map<string, { status: string; amount: string; currency: string; captured?: string }>;
  count(host: string): number;
  /** make one host answer with an HTTP error */
  down: Set<string>;
}

export function makeNet(): Net {
  const calls: Net['calls'] = [];
  const orders: Net['orders'] = new Map();
  const down = new Set<string>();
  let seq = 0;
  const f: FetchFn = async (input, init) => {
    const u = new URL(input);
    let body: any;
    try {
      body = init?.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init?.body;
    } catch {
      body = undefined;
    }
    calls.push({ host: u.host, path: u.pathname, body });
    if (down.has(u.host)) return j({ message: 'down' }, 503);
    if (u.host === 'api.trychannel3.com') {
      const q = String(body?.query ?? 'item');
      const max = Number(body?.filters?.price?.max_price ?? 1000);
      const prices = [12.5, 24, 39.99, 48, 80, 150];
      const products = prices.map((p, k) => ({
        id: `ch3-${q.replace(/\W+/g, '-')}-${k}`,
        title: `${q} ${['notebook', 'mug', 'print', 'set', 'edition', 'box'][k]}`,
        brands: [{ name: 'Example' }],
        images: [{ url: `https://img.example/${k}.jpg`, is_main_image: true }],
        offers: [{ url: `https://buy.example/${q.replace(/\W+/g, '-')}/${k}`, domain: `shop-${'abcdef'[k % 3]}.example`, price: { price: p, currency: 'USD' }, availability: 'InStock', condition: 'new' }],
      }));
      return j({ products: products.filter((x) => x.offers[0]!.price.price <= max).slice(0, Number(body?.limit ?? 6)) });
    }
    if (u.host === 'api.tavily.com') {
      const q = String(body?.query ?? '');
      return j({ results: [0, 1, 2].map((k) => ({ title: `${q.slice(0, 40)} page ${k}`, url: `https://tours-${k}.example/p?q=${k}`, content: `About ${q.slice(0, 30)}. Tickets from $${20 + k}.`, raw_content: `# ${q}\nPrice $${20 + k}.00` })) });
    }
    if (u.host === 'api-m.sandbox.paypal.com') {
      if (u.pathname === '/v1/oauth2/token') return j({ access_token: 'tok-test', expires_in: 3000 });
      if (u.pathname === '/v2/checkout/orders' && init?.method === 'POST') {
        const id = `ORD${String(++seq).padStart(10, '0')}`;
        const a = body.purchase_units[0].amount;
        orders.set(id, { status: 'PAYER_ACTION_REQUIRED', amount: a.value, currency: a.currency_code });
        return j({ id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] }, 201);
      }
      const m = /^\/v2\/checkout\/orders\/([A-Za-z0-9]+)(\/capture)?$/.exec(u.pathname);
      const o = m ? orders.get(m[1]!) : undefined;
      if (!m || !o) return j({ name: 'RESOURCE_NOT_FOUND' }, 404);
      if (m[2]) {
        if (o.status !== 'APPROVED') return j({ name: 'ORDER_NOT_APPROVED' }, 422);
        o.status = 'COMPLETED';
        o.captured = `CAP${m[1]}`;
      }
      return j({
        id: m[1],
        status: o.status,
        purchase_units: [{ amount: { value: o.amount, currency_code: o.currency }, payments: o.captured ? { captures: [{ id: o.captured, status: 'COMPLETED' }] } : undefined }],
      });
    }
    return j({ message: 'unexpected host ' + u.host }, 404);
  };
  return { fetch: f, calls, orders, down, count: (h) => calls.filter((c) => c.host === h).length };
}

export function makeHarness(extraEnv: Partial<Env> = {}) {
  resetPayPalTokenCache();
  const net = makeNet();
  const kv = fakeKV();
  const app = createApp({ fetch: net.fetch, fast: true });
  const env = { KV: kv, TAVILY_API_KEY: 'tv-test', CHANNEL3_API_KEY: 'c3-test', PAYPAL_CLIENT_ID: 'pp-id', PAYPAL_CLIENT_SECRET: 'pp-secret', ...extraEnv } as Env;
  const req = (path: string, init?: RequestInit) => app.request('http://localhost:8791' + path, init, env);
  const post = (path: string, body: unknown) => req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, net, kv, env, req, post };
}

export async function readEvents(res: Response): Promise<StreamEvent[]> {
  const text = await res.text();
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as StreamEvent);
}

export const FAVS = [
  { text: 'Kafka on the Shore', type: 'book' },
  { text: 'Nujabes', type: 'artist' },
  { text: 'Muji' },
];
