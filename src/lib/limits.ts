import type { CounterName, Env, Limits } from '../types.ts';

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

export type Counts = Partial<Record<CounterName, number>>;
export type Caps = { ip: Counts; global: Counts };
export type Refusal = { counter: CounterName; scope: Scope };
export type Used = { ip: Counts; global: Counts };

/** The synchronous storage a Durable Object gives (`ctx.storage.kv`, SQLite-backed); a Map in tests. */
export interface SyncStore {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  list<T>(): Iterable<[string, T]>;
  delete(key: string): boolean;
}

/**
 * Per-visitor and global daily counters. One Durable Object runs this, and every method is synchronous, so each take is
 * an atomic read-check-write: parallel requests cannot both pass a cap and no count is lost. Keys: `day`, `g` and
 * `i:<visitor hash>`; the hash is sha256(day + IP or IPv6 /64), so no address is stored. Nothing typed is counted.
 */
export class Counter {
  private s: SyncStore;
  constructor(s: SyncStore) {
    this.s = s;
  }

  /** A newer UTC day drops every counter. Days only move forward: a request stamped yesterday counts against today. */
  private roll(day: string): void {
    const cur = this.s.get<string>('day');
    if (cur !== undefined && cur >= day) return;
    for (const [k] of [...this.s.list()]) this.s.delete(k);
    this.s.put('day', day);
  }

  /** All or nothing: adds `want` to the visitor's and the global counters, or adds nothing and names the first cap it would pass. */
  take(day: string, visitor: string, want: Counts, caps: Caps): Refusal | null {
    this.roll(day);
    const key = `i:${visitor}`;
    const ip = this.s.get<Counts>(key) ?? {};
    const g = this.s.get<Counts>('g') ?? {};
    const items = Object.entries(want) as [CounterName, number][];
    for (const [k, n] of items) {
      if (!(Number.isFinite(n) && n >= 0)) return { counter: k, scope: 'global' }; // NaN or a negative count would pass every later check
      // a counter without a cap at one scope (cents has no per-visitor cap) is limited by the other
      if ((ip[k] ?? 0) + n > (caps.ip[k] ?? Infinity)) return { counter: k, scope: 'ip' };
      if ((g[k] ?? 0) + n > (caps.global[k] ?? Infinity)) return { counter: k, scope: 'global' };
    }
    for (const [k, n] of items) {
      ip[k] = (ip[k] ?? 0) + n;
      g[k] = (g[k] ?? 0) + n;
    }
    this.s.put(key, ip);
    this.s.put('g', g);
    return null;
  }

  /** Gives back a reservation whose call never happened (a failed sandbox order). Yesterday's reservations are already gone. */
  give(day: string, visitor: string, back: Counts): void {
    if (this.s.get<string>('day') !== day) return;
    const key = `i:${visitor}`;
    const ip = this.s.get<Counts>(key) ?? {};
    const g = this.s.get<Counts>('g') ?? {};
    for (const [k, n] of Object.entries(back) as [CounterName, number][]) {
      ip[k] = Math.max(0, (ip[k] ?? 0) - n);
      g[k] = Math.max(0, (g[k] ?? 0) - n);
    }
    this.s.put(key, ip);
    this.s.put('g', g);
  }

  used(day: string, visitor: string): Used {
    if (this.s.get<string>('day') !== day) return { ip: {}, global: {} };
    return { ip: this.s.get<Counts>(`i:${visitor}`) ?? {}, global: this.s.get<Counts>('g') ?? {} };
  }
}

/** The meter Durable Object's methods as the Worker calls them (RPC: every call is async). */
export interface MeterApi {
  take(day: string, visitor: string, want: Counts, caps: Caps): Promise<Refusal | null>;
  give(day: string, visitor: string, back: Counts): Promise<void>;
  used(day: string, visitor: string): Promise<Used>;
}

/** One meter for the whole app, so every cap is exact (src/index.ts holds the Durable Object class). */
export const meterApi = (env: Env): MeterApi | undefined => (env.METER ? (env.METER.get(env.METER.idFromName('meter')) as unknown as MeterApi) : undefined);

/** A meter held in memory, for scripts and tests that run outside Workers. */
export function memoryMeterApi(): MeterApi {
  const m = new Map<string, unknown>();
  const c = new Counter({ get: <T>(k: string) => structuredClone(m.get(k)) as T | undefined, put: (k, v) => void m.set(k, structuredClone(v)), list: <T>() => m.entries() as Iterable<[string, T]>, delete: (k) => m.delete(k) });
  return { take: async (...a) => c.take(...a), give: async (...a) => c.give(...a), used: async (...a) => c.used(...a) };
}

/** The request's view of the meter. Takes fail closed: when the counters cannot be reached, the billed call is refused. */
export class Meter {
  private api: MeterApi | undefined;
  private caps: Caps;
  private visitor: string;
  private day: string;
  constructor(api: MeterApi | undefined, limits: Limits, visitor: string, day: string) {
    this.api = api;
    this.caps = { ip: { ...limits.ip }, global: { ...limits.global, cents: limits.dailyCapCents } };
    this.visitor = visitor;
    this.day = day;
  }

  /** Reserves before a billed call; throws LimitError when a cap would be passed or the meter does not answer. */
  async take(want: Counts): Promise<void> {
    let r: Refusal | null;
    try {
      if (!this.api) throw new Error('METER binding missing');
      r = await this.api.take(this.day, this.visitor, want, this.caps);
    } catch (e) {
      // logged so a broken binding is not mistaken for a real cap; the message comes from the runtime, never from a visitor
      console.error('meter unreachable, call refused:', e instanceof Error ? `${e.name}: ${e.message.slice(0, 120)}` : typeof e);
      r = { counter: Object.keys(want)[0] as CounterName, scope: 'global' };
    }
    if (r) throw new LimitError(r.counter, r.scope);
  }

  /** Best effort: a refund that does not arrive only makes the cap stricter. */
  async give(back: Counts): Promise<void> {
    try {
      await this.api?.give(this.day, this.visitor, back);
    } catch {
      // the reservation stays counted
    }
  }

  async used(): Promise<Used> {
    try {
      if (this.api) return await this.api.used(this.day, this.visitor);
    } catch {
      // status only: show nothing rather than fail
    }
    return { ip: {}, global: {} };
  }
}

/** The visitor an IP stands for. IPv6 users usually get a whole /64, so the /64 counts as one visitor. */
export function visitorOf(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip; // IPv4, or IPv4 inside IPv6: one host
  const [head = '', tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':');
}
