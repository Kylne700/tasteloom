// Key-value store: Cloudflare KV in the Worker, a Map in tests and as a per-isolate fallback when no KV binding exists.
// Sessions, orders and the response cache live here. Spend counters do not: KV has no atomic increment (src/lib/limits.ts).

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSec?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export function kvStore(kv: KVNamespace): Store {
  return {
    get: (k) => kv.get(k),
    // KV needs a TTL of at least 60 s
    put: (k, v, ttl) => kv.put(k, v, ttl ? { expirationTtl: Math.max(60, Math.floor(ttl)) } : undefined),
    delete: (k) => kv.delete(k),
  };
}

export function memoryStore(now: () => number = Date.now): Store {
  const m = new Map<string, { v: string; exp: number }>();
  return {
    async get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (e.exp && e.exp < now()) {
        m.delete(k);
        return null;
      }
      return e.v;
    },
    async put(k, v, ttl) {
      m.set(k, { v, exp: ttl ? now() + ttl * 1000 : 0 });
    },
    async delete(k) {
      m.delete(k);
    },
  };
}

let fallback: Store | undefined;
export function storeFor(kv: KVNamespace | undefined): Store {
  if (kv) return kvStore(kv);
  return (fallback ??= memoryStore());
}

export async function getJson<T>(s: Store, key: string): Promise<T | null> {
  const raw = await s.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const putJson = (s: Store, key: string, value: unknown, ttlSec?: number) => s.put(key, JSON.stringify(value), ttlSec);
