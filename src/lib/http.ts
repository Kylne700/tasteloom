import type { Config } from '../config.ts';
import { secretsOf } from '../config.ts';
import type { CounterName, FetchFn } from '../types.ts';
import { errMsg, redact, sha256Hex } from './util.ts';
import { getJson, putJson, type Store } from './store.ts';
import type { Meter } from './limits.ts';

export type ServiceName = 'qloo' | 'nebius' | 'tavily' | 'channel3' | 'paypal';

/** Per-request context handed to every adapter. */
export interface Svc {
  cfg: Config;
  fetch: FetchFn;
  store: Store;
  meter: Meter;
  /** Workers Free allows 50 subrequests per invocation; we stop at 40 */
  sub: { left: number };
  /** mock fetchers keyed by service; used instead of the network while the adapter is in mock mode */
  mocks: Partial<Record<ServiceName, FetchFn>>;
}

export class HttpError extends Error {
  service: ServiceName;
  status: number;
  constructor(service: ServiceName, status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.service = service;
    this.status = status;
  }
}

export class BudgetError extends Error {
  constructor() {
    super('subrequest budget for this request is used up');
    this.name = 'BudgetError';
  }
}

const BILLED: Partial<Record<ServiceName, Exclude<CounterName, 'cents' | 'ideas' | 'orders'>>> = {
  nebius: 'nebius',
  tavily: 'tavily',
  channel3: 'channel3',
};

export interface CallResult {
  status: number;
  json: unknown;
  via: 'live' | 'mock';
}

/**
 * One JSON HTTP call. Real network calls spend the subrequest budget and the per-IP/global counters of billable services;
 * mock fetchers (same shapes as the docs, parsed by the same code) cost nothing.
 */
export async function callJson(svc: Svc, service: ServiceName, url: string, init: RequestInit, timeoutMs = 20000): Promise<CallResult> {
  const mock = svc.mocks[service];
  let doFetch: FetchFn = svc.fetch;
  let via: 'live' | 'mock' = 'live';
  if (mock) {
    doFetch = mock;
    via = 'mock';
  } else {
    const billed = BILLED[service];
    if (billed) svc.meter.take(billed); // throws LimitError before any money is spent
    if (svc.sub.left <= 0) throw new BudgetError();
    svc.sub.left--;
  }
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new HttpError(service, 0, redact(`${service} request failed: ${errMsg(e)}`, secretsOf(svc.cfg)));
  }
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.status >= 400) {
    throw new HttpError(service, res.status, redact(`${service} HTTP ${res.status}: ${text.slice(0, 200)}`, secretsOf(svc.cfg)));
  }
  return { status: res.status, json, via };
}

/**
 * Cache a parsed (small) adapter result in KV. Always on for Tavily and Channel3 (tight call budgets);
 * for Qloo and Nebius only with DEV_CACHE=1. Cache failures never break a request.
 */
export async function cached<T>(svc: Svc, service: ServiceName, keyParts: unknown, ttlSec: number, fn: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const useCache = !svc.mocks[service] && (service === 'tavily' || service === 'channel3' || svc.cfg.devCache);
  if (!useCache) return { value: await fn(), hit: false };
  const key = `c:${service}:${(await sha256Hex(JSON.stringify(keyParts))).slice(0, 32)}`;
  try {
    const hit = await getJson<{ v: T }>(svc.store, key);
    if (hit) return { value: hit.v, hit: true };
  } catch {
    // fall through to a live call
  }
  const value = await fn();
  try {
    await putJson(svc.store, key, { v: value }, ttlSec);
  } catch {
    // KV write quota reached: serve the live result anyway
  }
  return { value, hit: false };
}
