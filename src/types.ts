// Shared types. Kept free of runtime code so Node can strip them for tests and scripts.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** The Workers AI binding (wrangler.jsonc "ai"); the real one is `env.AI`. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** Worker bindings and vars. Secrets come from .dev.vars locally (generated from ../.env.local) or `wrangler secret` in production. */
export interface Env {
  KV?: KVNamespace;
  /** the spend meter (src/lib/limits.ts); without it every billed call is refused */
  METER?: DurableObjectNamespace;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
  /** Cloudflare Workers AI; without it the model is a fake and the page says "demo data" */
  AI?: AiBinding;
  QLOO_API_KEY?: string;
  TAVILY_API_KEY?: string;
  CHANNEL3_API_KEY?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  /** comma list of adapters to force into mock mode, e.g. "qloo,ai" (qloo and ai only) */
  FORCE_MOCK?: string;
  /** "1" caches upstream responses in KV (development only, spares the Tavily and Channel3 budgets) */
  DEV_CACHE?: string;
  /** absolute origin used for PayPal return and cancel URLs; defaults to the request origin */
  PUBLIC_BASE_URL?: string;
  AI_AGENT_MODEL?: string;
  AI_WRITER_MODEL?: string;
  // optional limit overrides, see config.ts
  [k: `LIMIT_${string}`]: string | undefined;
}

/** Daily counters. `ai` counts model calls and `neurons` the Workers AI neurons they use (reserved from an estimate, settled by the answer); `returns` counts returns from PayPal that still had work to do; `cents` is the sum of sandbox order totals. */
export type CounterName = 'ideas' | 'qloo' | 'ai' | 'neurons' | 'tavily' | 'channel3' | 'orders' | 'returns' | 'cents';

export interface Limits {
  ip: Record<Exclude<CounterName, 'cents'>, number>;
  global: Record<Exclude<CounterName, 'cents'>, number>;
  dailyCapCents: number;
  maxItems: number;
  minBudgetCents: number;
  maxBudgetCents: number;
}

/** A product or experience card. Only the server's copy is ever used for pricing. */
export interface Card {
  id: string;
  ideaId: string;
  title: string;
  /** integer cents in USD; 0 when unknown (experience links) */
  price_cents: number;
  currency: 'USD';
  shop: string;
  url: string;
  image?: string;
  /** true only for cards with a structured price from a catalog (Channel3 or the recorded sample) */
  purchasable: boolean;
  source: 'channel3' | 'tavily' | 'sample';
  snippet?: string;
  /** informational Tavily check of the shop page; never used for pricing */
  priceCheck?: { state: 'confirmed' | 'unknown'; url?: string };
}

export interface Idea {
  id: string;
  kind: 'product' | 'experience';
  title: string;
  entity: { id: string; name: string; type: string };
  /** names of the favourites that Qloo explainability links to this entity */
  because: string[];
  reason: string;
  cardIds: string[];
}

export interface Session {
  id: string;
  createdAt: number;
  budget_cents: number;
  cards: Card[];
  example?: boolean;
}

export interface OrderLine {
  id: string;
  title: string;
  shop: string;
  price_cents: number;
}

export type OrderStatus = 'CREATED' | 'APPROVED' | 'COMPLETED' | 'CANCELLED' | 'CAPTURE_FAILED' | 'NOT_APPROVED';

export interface OrderRecord {
  id: string;
  sessionId: string;
  itemIds: string[];
  lines: OrderLine[];
  total_cents: number;
  currency: 'USD';
  status: OrderStatus;
  error?: string;
  captureId?: string;
  /** short lines describing which agent tools ran for this order, e.g. "create_order -> CREATED" */
  trace?: string[];
  approveUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface Seed {
  id: string;
  name: string;
  type: string;
}

export interface Candidate {
  id: string;
  name: string;
  type: string;
  /** seed ids with explainability scores (0-1), strongest first */
  because: { seedId: string; score: number }[];
  /** true when Qloo returned explainability data for this entity */
  explained: boolean;
}

export type StreamEvent =
  | { t: 'meta'; session: string; budget_cents: number; mocks: string[]; example: boolean; asOf?: string; favorites?: { text: string; type?: string }[] }
  | { t: 'phase'; id: string; label: string; state: 'running' | 'done' | 'skipped' | 'error'; note?: string }
  | { t: 'call'; tool: string; arg: string; ms: number; ok: boolean; out: string; via: 'live' | 'mock' | 'cache' }
  | { t: 'taste'; seeds: { id: string; name: string; type: string }[] }
  | { t: 'idea'; idea: Idea; cards: Card[] }
  | { t: 'reasons'; reasons: Record<string, string> }
  | { t: 'check'; cardId: string; state: 'confirmed' | 'unknown'; url?: string }
  | { t: 'done'; ideas: number; cards: number; tier: 'tools' | 'pipeline' | 'template' | 'example'; limited?: CounterName[] } // limited: services that refused a call during the run because their daily cap was reached
  | { t: 'error'; code: 'limit' | 'upstream' | 'bad_input' | 'internal'; message: string };
