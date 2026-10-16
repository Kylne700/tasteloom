import type { CounterName, Limits } from '../types.ts';
import { getJson, putJson, type Store } from './store.ts';

export type Scope = 'ip' | 'global';

export class LimitError extends Error {
  counter: CounterName;
  scope: Scope;
  constructor(counter: CounterName, scope: Scope) {
    super(`daily ${scope} limit reached for ${counter}`);
    this.name = 'LimitError';
    this.counter = counter;
    this.scope = scope;
  }
}

type Counts = Partial<Record<CounterName, number>>;
const TTL = 2 * 24 * 3600;

/**
 * Per-IP and global daily counters. Loaded once per request (2 KV reads), checked in memory, written back once (2 KV writes).
 * No raw IP is stored: the key holds sha256(day + ip). Nothing the user typed is counted or kept.
 */
export class Meter {
  private store: Store;
  private limits: Limits;
  private ipKey: string;
  private globalKey: string;
  private ip: Counts;
  private glob: Counts;
  private dirty = false;

  private constructor(store: Store, limits: Limits, ipKey: string, globalKey: string, ip: Counts, glob: Counts) {
    this.store = store;
    this.limits = limits;
    this.ipKey = ipKey;
    this.globalKey = globalKey;
    this.ip = ip;
    this.glob = glob;
  }

  static async load(store: Store, limits: Limits, ipHash: string, day: string): Promise<Meter> {
    const ipKey = `lim:${day}:i:${ipHash}`;
    const globalKey = `lim:${day}:g`;
    const [ip, glob] = await Promise.all([getJson<Counts>(store, ipKey), getJson<Counts>(store, globalKey)]);
    return new Meter(store, limits, ipKey, globalKey, ip ?? {}, glob ?? {});
  }

  /** Count n calls of a billable service; throws LimitError when the per-IP or global daily cap would be exceeded. */
  take(counter: Exclude<CounterName, 'cents'>, n = 1): void {
    const ipMax = this.limits.ip[counter];
    const gMax = this.limits.global[counter];
    if ((this.ip[counter] ?? 0) + n > ipMax) throw new LimitError(counter, 'ip');
    if ((this.glob[counter] ?? 0) + n > gMax) throw new LimitError(counter, 'global');
    this.ip[counter] = (this.ip[counter] ?? 0) + n;
    this.glob[counter] = (this.glob[counter] ?? 0) + n;
    this.dirty = true;
  }

  /** Global daily cap on the sum of sandbox order totals. */
  takeCents(cents: number): void {
    if ((this.glob.cents ?? 0) + cents > this.limits.dailyCapCents) throw new LimitError('cents', 'global');
    this.glob.cents = (this.glob.cents ?? 0) + cents;
    this.dirty = true;
  }

  /** Give back a reserved amount (order creation failed after the reservation). */
  refundCents(cents: number): void {
    this.glob.cents = Math.max(0, (this.glob.cents ?? 0) - cents);
    this.dirty = true;
  }

  used() {
    return { ip: { ...this.ip }, global: { ...this.glob } };
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await Promise.all([putJson(this.store, this.ipKey, this.ip, TTL), putJson(this.store, this.globalKey, this.glob, TTL)]);
    } catch {
      // best effort: a failed counter write must never break a purchase flow
    }
  }
}
