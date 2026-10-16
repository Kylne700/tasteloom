// Shared types. Kept free of runtime code so Node can strip them for tests and scripts.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Worker bindings and vars. Secrets come from .dev.vars locally (generated from ../.env.local) or `wrangler secret` in production. */
export interface Env {
  KV?: KVNamespace;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
  QLOO_API_KEY?: string;
  NEBIUS_API_KEY?: string;
  TAVILY_API_KEY?: string;
  CHANNEL3_API_KEY?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  /** comma list of adapters to force into mock mode, e.g. "qloo,nebius" (qloo and nebius only) */
  FORCE_MOCK?: string;
  /** "1" caches upstream responses in KV (development only, spares the Tavily and Channel3 budgets) */
  DEV_CACHE?: string;
  /** absolute origin used for PayPal return and cancel URLs; defaults to the request origin */
  PUBLIC_BASE_URL?: string;
  NEBIUS_AGENT_MODEL?: string;
  NEBIUS_WRITER_MODEL?: string;
  // optional limit overrides, see config.ts
  [k: `LIMIT_${string}`]: string | undefined;
}

export type CounterName = 'ideas' | 'nebius' | 'tavily' | 'channel3' | 'orders' | 'cents';

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
  priceCheck?: { state: 'confirmed' | 'differs' | 'unknown'; pagePrice_cents?: number; url?: string };
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
  | { t: 'meta'; session: string; budget_cents: number; mocks: string[]; example: boolean; asOf?: string }
  | { t: 'phase'; id: string; label: string; state: 'running' | 'done' | 'skipped' | 'error'; note?: string }
  | { t: 'call'; tool: string; arg: string; ms: number; ok: boolean; out: string; via: 'live' | 'mock' | 'cache' }
  | { t: 'taste'; seeds: { id: string; name: string; type: string }[] }
  | { t: 'idea'; idea: Idea; cards: Card[] }
  | { t: 'reasons'; reasons: Record<string, string> }
  | { t: 'done'; ideas: number; cards: number; tier: 'tools' | 'pipeline' | 'template' | 'example' }
  | { t: 'error'; code: 'limit' | 'upstream' | 'bad_input' | 'internal'; message: string };
