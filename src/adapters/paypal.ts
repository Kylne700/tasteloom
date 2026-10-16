// PayPal Orders v2, SANDBOX ONLY (host is a constant in config.ts). Guest card checkout: the buyer approves on PayPal's page, no PayPal account needed.
import { PAYPAL_APPROVE_HOST, PAYPAL_BASE } from '../config.ts';
import { callJson, HttpError, type Svc } from '../lib/http.ts';
import { asObject } from '../lib/json.ts';
import { clip, fmtCents, randomId, toCents } from '../lib/util.ts';
import type { OrderLine } from '../types.ts';

const tokenCache = new Map<string, { token: string; exp: number }>();
export const resetPayPalTokenCache = () => tokenCache.clear();

const ORDER_ID = /^[A-Za-z0-9]{8,30}$/;
export const validOrderId = (id: unknown): id is string => typeof id === 'string' && ORDER_ID.test(id);

async function accessToken(svc: Svc): Promise<string> {
  const id = svc.cfg.keys.paypalId;
  const secret = svc.cfg.keys.paypalSecret;
  if (!id || !secret) throw new HttpError('paypal', 0, 'PayPal sandbox credentials are not configured');
  const hit = tokenCache.get(id);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const r = await callJson(svc, 'paypal', `${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    body: 'grant_type=client_credentials',
    headers: { Authorization: 'Basic ' + btoa(`${id}:${secret}`), 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const j = asObject(r.json);
  const token = typeof j?.access_token === 'string' ? j.access_token : '';
  if (!token) throw new HttpError('paypal', r.status, 'PayPal sandbox returned no access token');
  const ttl = typeof j?.expires_in === 'number' ? j.expires_in : 300;
  tokenCache.set(id, { token, exp: Date.now() + ttl * 1000 });
  return token;
}

async function pp(svc: Svc, method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string) {
  const token = await accessToken(svc);
  return callJson(svc, 'paypal', PAYPAL_BASE + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
  });
}

export interface OrderInput {
  lines: OrderLine[];
  total_cents: number;
  sessionId: string;
  returnUrl: string;
  cancelUrl: string;
}

/** Pure: the exact JSON sent to PayPal. Amounts come from the server's own cards, in integer cents. */
export function buildOrderBody(input: OrderInput) {
  const sum = input.lines.reduce((a, l) => a + l.price_cents, 0);
  if (sum !== input.total_cents) throw new Error('order total does not equal the sum of its lines');
  const money = (c: number) => ({ currency_code: 'USD', value: fmtCents(c) });
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: 'gift',
        custom_id: input.sessionId,
        description: 'Tasteloom gift (sandbox demo, nothing ships, no real money)',
        items: input.lines.map((l) => ({
          name: clip(l.title, 120),
          sku: l.id,
          quantity: '1',
          category: 'PHYSICAL_GOODS',
          unit_amount: money(l.price_cents),
        })),
        amount: { ...money(input.total_cents), breakdown: { item_total: money(input.total_cents) } },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Tasteloom (sandbox)',
          locale: 'en-US',
          landing_page: 'GUEST_CHECKOUT',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
    },
  };
}

export interface CreatedOrder {
  id: string;
  status: string;
  approveUrl: string;
}

export async function createOrder(svc: Svc, input: OrderInput): Promise<CreatedOrder> {
  // a fresh PayPal-Request-Id per create call; our own layer reuses the existing order on retries
  const r = await pp(svc, 'POST', '/v2/checkout/orders', buildOrderBody(input), randomId(16));
  const j = asObject(r.json);
  const id = j?.id;
  if (!validOrderId(id)) throw new HttpError('paypal', r.status, 'PayPal sandbox returned no order id');
  const links = Array.isArray(j?.links) ? (j.links as Record<string, unknown>[]) : [];
  const link = links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  let approveUrl = typeof link?.href === 'string' ? link.href : '';
  if (!approveUrl.startsWith(PAYPAL_APPROVE_HOST)) approveUrl = `${PAYPAL_APPROVE_HOST}checkoutnow?token=${id}`;
  return { id, status: String(j?.status ?? 'CREATED'), approveUrl };
}

export interface PayPalOrderView {
  id: string;
  status: string;
  total_cents: number | null;
  currency: string;
  captureId?: string;
  captureStatus?: string;
}

export function parseOrder(json: unknown): PayPalOrderView {
  const j = asObject(json) ?? {};
  const pu = Array.isArray(j.purchase_units) ? asObject(j.purchase_units[0]) : undefined;
  const amount = asObject(pu?.amount);
  const payments = asObject(pu?.payments);
  const cap = Array.isArray(payments?.captures) ? asObject(payments.captures[0]) : undefined;
  return {
    id: String(j.id ?? ''),
    status: String(j.status ?? 'UNKNOWN'),
    total_cents: toCents(amount?.value),
    currency: String(amount?.currency_code ?? ''),
    captureId: typeof cap?.id === 'string' ? cap.id : undefined,
    captureStatus: typeof cap?.status === 'string' ? cap.status : undefined,
  };
}

export async function getOrder(svc: Svc, id: string): Promise<PayPalOrderView> {
  if (!validOrderId(id)) throw new HttpError('paypal', 0, 'invalid order id');
  const r = await pp(svc, 'GET', `/v2/checkout/orders/${id}`);
  return parseOrder(r.json);
}

/** Capture. The caller must already have seen APPROVED for this order and a matching amount. The request id is stable, so a repeat is idempotent. */
export async function captureOrder(svc: Svc, id: string): Promise<PayPalOrderView> {
  if (!validOrderId(id)) throw new HttpError('paypal', 0, 'invalid order id');
  const r = await pp(svc, 'POST', `/v2/checkout/orders/${id}/capture`, {}, `cap-${id}`);
  return parseOrder(r.json);
}

/** Map a PayPal error message to a short human sentence (never shows raw API text to buyers). */
export function humanPayPalError(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (/ORDER_NOT_APPROVED|not yet approved/i.test(m)) return 'The payment was not approved on PayPal yet.';
  if (/INSTRUMENT_DECLINED|declin/i.test(m)) return 'The card was declined. Try the sandbox test card shown above.';
  if (/ORDER_ALREADY_CAPTURED/i.test(m)) return 'This order was already paid.';
  return 'PayPal could not finish the payment. Nothing was charged.';
}
