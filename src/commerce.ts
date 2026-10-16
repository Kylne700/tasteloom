// Sessions, order pricing and the PayPal order lifecycle. Money rules live here, in one place:
//  - prices come only from the cards the server stored for the session, never from the browser
//  - the total may not exceed the buyer's budget (set when the session started) or the global daily cap
//  - a capture happens only after a fresh PayPal read shows APPROVED with the same amount
import { captureOrder, createOrder, getOrder, humanPayPalError } from './adapters/paypal.ts';
import type { Svc } from './lib/http.ts';
import { getJson, putJson } from './lib/store.ts';
import { randomId, sha256Hex } from './lib/util.ts';
import type { Card, Limits, OrderLine, OrderRecord, OrderStatus, Session } from './types.ts';

const SESSION_TTL = 2 * 3600;
const ORDER_TTL = 7 * 24 * 3600;

export type OrderErrorCode = 'bad_request' | 'empty' | 'too_many' | 'unknown_item' | 'not_purchasable' | 'over_budget' | 'session_expired';

export class OrderError extends Error {
  code: OrderErrorCode;
  constructor(code: OrderErrorCode, message: string) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
  }
}

/** Buyer-facing sentences for every pricing failure. */
export const ORDER_MESSAGES: Record<OrderErrorCode, string> = {
  bad_request: 'Pick at least one item and try again.',
  empty: 'Pick at least one item first.',
  too_many: 'That is more items than one gift order can hold.',
  unknown_item: 'One of those items is no longer available. Go back and pick again.',
  not_purchasable: 'That item is a link to another site and cannot be bought here.',
  over_budget: 'That is over your budget. Remove something and try again.',
  session_expired: 'Your session expired. Start again or try the example.',
};

export const newSession = (budget_cents: number, cards: Card[], example = false): Session => ({
  id: 's' + randomId(10),
  createdAt: Date.now(),
  budget_cents,
  cards,
  example,
});

export const saveSession = (svc: Svc, s: Session) => putJson(svc.store, `s:${s.id}`, s, SESSION_TTL);
export const loadSession = (svc: Svc, id: string) => getJson<Session>(svc.store, `s:${id}`);

/**
 * Build the order from the stored session. Only item ids are read from the request; any client-side price, title or total is ignored by design.
 */
export function priceOrder(session: Session, itemIds: unknown, limits: Pick<Limits, 'maxItems'>): { lines: OrderLine[]; total_cents: number } {
  if (!Array.isArray(itemIds) || itemIds.some((i) => typeof i !== 'string')) throw new OrderError('bad_request', ORDER_MESSAGES.bad_request);
  const ids = [...new Set(itemIds as string[])];
  if (ids.length === 0) throw new OrderError('empty', ORDER_MESSAGES.empty);
  if (ids.length > limits.maxItems) throw new OrderError('too_many', ORDER_MESSAGES.too_many);
  const lines: OrderLine[] = [];
  let total = 0;
  for (const id of ids) {
    const card = session.cards.find((c) => c.id === id);
    if (!card) throw new OrderError('unknown_item', ORDER_MESSAGES.unknown_item);
    if (!card.purchasable || !Number.isInteger(card.price_cents) || card.price_cents <= 0) throw new OrderError('not_purchasable', ORDER_MESSAGES.not_purchasable);
    lines.push({ id: card.id, title: card.title, shop: card.shop, price_cents: card.price_cents });
    total += card.price_cents;
  }
  if (total > session.budget_cents) throw new OrderError('over_budget', ORDER_MESSAGES.over_budget);
  return { lines, total_cents: total };
}

export const loadOrder = (svc: Svc, id: string) => getJson<OrderRecord>(svc.store, `o:${id}`);
const saveOrder = (svc: Svc, o: OrderRecord) => putJson(svc.store, `o:${o.id}`, o, ORDER_TTL);

/** What the browser may see of an order: no approve link internals, no payer data (none is ever stored). */
export function publicOrder(o: OrderRecord) {
  return {
    id: o.id,
    status: o.status,
    lines: o.lines,
    total_cents: o.total_cents,
    currency: o.currency,
    captureId: o.captureId,
    error: o.error,
    trace: o.trace ?? [],
    sandbox: true,
  };
}

export interface CheckoutResult {
  order: OrderRecord;
  reused: boolean;
}

/** Create (or reuse) the PayPal sandbox order for exactly the buyer's selection. */
export async function startCheckout(svc: Svc, session: Session, itemIds: unknown, urls: { returnUrl: string; cancelUrl: string }): Promise<CheckoutResult> {
  const { lines, total_cents } = priceOrder(session, itemIds, svc.cfg.limits);
  const sel = lines.map((l) => l.id).sort().join(',');
  const ptrKey = `chk:${session.id}:${(await sha256Hex(sel)).slice(0, 16)}`;
  const existingId = await svc.store.get(ptrKey);
  if (existingId) {
    const existing = await loadOrder(svc, existingId);
    if (existing && existing.status === 'CREATED') return { order: existing, reused: true };
  }
  svc.meter.take('orders');
  svc.meter.takeCents(total_cents); // reserve against the global daily cap before PayPal is called
  let created;
  try {
    created = await createOrder(svc, { lines, total_cents, sessionId: session.id, ...urls });
  } catch (e) {
    svc.meter.refundCents(total_cents);
    throw e;
  }
  const now = Date.now();
  const order: OrderRecord = {
    id: created.id,
    sessionId: session.id,
    itemIds: lines.map((l) => l.id),
    lines,
    total_cents,
    currency: 'USD',
    status: 'CREATED',
    approveUrl: created.approveUrl,
    createdAt: now,
    updatedAt: now,
  };
  await saveOrder(svc, order);
  await svc.store.put(ptrKey, order.id, 24 * 3600);
  return { order, reused: false };
}

async function setStatus(svc: Svc, o: OrderRecord, status: OrderStatus, extra: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const next = { ...o, ...extra, status, updatedAt: Date.now() };
  await saveOrder(svc, next);
  return next;
}

/** Append short lines saying which agent tools ran for this order (shown on the receipt). */
export async function addTrace(svc: Svc, id: string, ...lines: string[]): Promise<void> {
  const o = lines.length ? await loadOrder(svc, id) : null;
  if (o) await saveOrder(svc, { ...o, trace: [...(o.trace ?? []), ...lines].slice(-8) });
}

export async function cancelOrder(svc: Svc, id: string): Promise<OrderRecord | null> {
  const o = await loadOrder(svc, id);
  if (!o) return null;
  return o.status === 'CREATED' ? setStatus(svc, o, 'CANCELLED') : o;
}

/**
 * After the buyer returns from PayPal: read the order fresh, capture only if it is APPROVED for the stored amount.
 * Safe to call twice (a completed order is returned as is; PayPal capture uses a stable request id).
 */
export async function finishOrder(svc: Svc, id: string): Promise<OrderRecord | null> {
  const o = await loadOrder(svc, id);
  if (!o) return null;
  if (o.status === 'COMPLETED' || o.status === 'CANCELLED') return o;
  try {
    const view = await getOrder(svc, id);
    if (view.status === 'COMPLETED') return setStatus(svc, o, 'COMPLETED', { captureId: view.captureId, error: undefined });
    if (view.status !== 'APPROVED') return setStatus(svc, o, 'NOT_APPROVED', { error: 'The payment was not approved on PayPal yet.' });
    if (view.total_cents !== o.total_cents || view.currency !== 'USD') {
      return setStatus(svc, o, 'CAPTURE_FAILED', { error: 'The amount on PayPal does not match your gift, so nothing was charged.' });
    }
    const cap = await captureOrder(svc, id);
    if (cap.status === 'COMPLETED') return setStatus(svc, o, 'COMPLETED', { captureId: cap.captureId, error: undefined });
    return setStatus(svc, o, 'CAPTURE_FAILED', { error: 'PayPal did not complete the payment. Nothing was charged.' });
  } catch (e) {
    return setStatus(svc, o, 'CAPTURE_FAILED', { error: humanPayPalError(e) });
  }
}
