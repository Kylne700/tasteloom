import type { Config } from '../config.ts';
import { secretsOf } from '../config.ts';
import type { CounterName, FetchFn } from '../types.ts';
import { errMsg, redact, sha256Hex } from './util.ts';
import { getJson, putJson, type Store } from './store.ts';
import type { Counts, Meter } from './limits.ts';

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

const BILLED: Partial<Record<ServiceName, CounterName>> = {
  qloo: 'qloo',
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
 * mock fetchers (same shapes as the docs, parsed by the same code) cost nothing. `charge` adds to the counters (Nebius tokens).
 */
export async function callJson(svc: Svc, service: ServiceName, url: string, init: RequestInit, timeoutMs = 20000, charge: Counts = {}): Promise<CallResult> {
  const mock = svc.mocks[service];
  let doFetch: FetchFn = svc.fetch;
  let via: 'live' | 'mock' = 'live';
  if (mock) {
    doFetch = mock;
    via = 'mock';
  } else {
    const billed = BILLED[service];
    if (billed) await svc.meter.take({ [billed]: 1, ...charge }); // throws LimitError before any money is spent
    if (svc.sub.left <= 0) throw new BudgetError();
    svc.sub.left--;
  }
  let res: Response;
  let text: string | undefined;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    text = await readText(res, MAX_BODY);
  } catch (e) {
    throw new HttpError(service, 0, redact(`${service} request failed: ${errMsg(e)}`, secretsOf(svc.cfg)));
  }
  if (text === undefined) throw new HttpError(service, 502, `${service} answer is over ${MAX_BODY} bytes`);
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

const MAX_BODY = 2_000_000; // bytes; real answers are far smaller, and a Worker has 128 MB

/** The body as text, or undefined once it passes `max` bytes (the rest is not downloaded). */
export async function readText(res: Pick<Response, 'body'>, max: number): Promise<string | undefined> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(chunks).text();
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
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
