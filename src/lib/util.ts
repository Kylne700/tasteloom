// Small helpers that run unchanged in Workers and Node (Web Crypto only).

const HEX = '0123456789abcdef';

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  let out = '';
  for (const b of new Uint8Array(buf)) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

/** Synchronous 32-bit FNV-1a, for deterministic mock data and cache keys (not for security). */
export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function randomId(bytes = 9): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (const b of a) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** USD dollars (number or numeric string) to integer cents; null if not a positive finite amount. */
export function toCents(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return Math.round(n * 100);
}

export const fmtCents = (c: number) => (c / 100).toFixed(2);

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

export function titleCase(s: string): string {
  return s.replace(/\b([a-z])([a-z']*)/g, (_m, a: string, b: string) => a.toUpperCase() + b);
}

/** Only absolute https URLs are ever passed on to the browser. */
export function httpsUrl(u: unknown): string | undefined {
  if (typeof u !== 'string') return undefined;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' ? x.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Remove every configured secret value from a string before it is logged or returned. */
export function redact(s: string, secrets: (string | undefined)[]): string {
  let out = s;
  for (const k of secrets) if (k && k.length >= 6) out = out.split(k).join('[key]');
  return out;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
