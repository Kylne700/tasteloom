import type { Env, Limits } from './types.ts';

// Hosts are fixed in code: PayPal is sandbox only and can never point at the live API.
export const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_APPROVE_HOST = 'https://www.sandbox.paypal.com/';
export const QLOO_BASE = 'https://hackathon.api.qloo.com';
export const TAVILY_BASE = 'https://api.tavily.com';
export const CHANNEL3_BASE = 'https://api.trychannel3.com';

export type Mode = 'live' | 'mock' | 'off';

export interface Config {
  /** Qloo (no key) and the model (no AI binding) fall back to doc-shaped mocks; the UI shows a "demo data" badge. */
  qloo: Mode;
  ai: Mode;
  tavily: Mode;
  channel3: Mode;
  paypal: Mode;
  keys: { qloo?: string; tavily?: string; channel3?: string; paypalId?: string; paypalSecret?: string };
  models: { agent: string; writer: string };
  limits: Limits;
  devCache: boolean;
  publicBase?: string;
}

const present = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const num = (v: string | undefined, d: number) => {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function loadConfig(env: Env): Config {
  const force = new Set((env.FORCE_MOCK ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const keys = {
    qloo: present(env.QLOO_API_KEY),
    tavily: present(env.TAVILY_API_KEY),
    channel3: present(env.CHANNEL3_API_KEY),
    paypalId: present(env.PAYPAL_CLIENT_ID),
    paypalSecret: present(env.PAYPAL_CLIENT_SECRET),
  };
  const L = (name: string, d: number) => num(env[`LIMIT_${name}`], d);
  const limits: Limits = {
    // sizes: see "Limits" in the README
    ip: {
      ideas: L('IP_IDEAS', 8),
      qloo: L('IP_QLOO', 60),
      ai: L('IP_AI', 80),
      neurons: L('IP_NEURONS', 1500),
      tavily: L('IP_TAVILY', 16),
      channel3: L('IP_CHANNEL3', 24),
      orders: L('IP_ORDERS', 8),
      returns: L('IP_RETURNS', 20),
    },
    // global: Channel3 and Tavily have about 800 free credits left for 26 days (Oct 23 to Nov 17): 25 a day keeps 20% back; a visitor gets 4 full runs (6 shop and 4 web searches each). The neurons stay under Workers AI's free 10,000 a day
    global: {
      ideas: L('GLOBAL_IDEAS', 100),
      qloo: L('GLOBAL_QLOO', 600),
      ai: L('GLOBAL_AI', 600),
      neurons: L('GLOBAL_NEURONS', 8000),
      tavily: L('GLOBAL_TAVILY', 25),
      channel3: L('GLOBAL_CHANNEL3', 25),
      orders: L('GLOBAL_ORDERS', 100),
      returns: L('GLOBAL_RETURNS', 150),
    },
    dailyCapCents: Math.round(L('DAILY_CAP_USD', 2000) * 100),
    maxItems: L('MAX_ITEMS', 6),
    minBudgetCents: 1000,
    maxBudgetCents: Math.round(L('MAX_BUDGET_USD', 500) * 100),
  };
  return {
    qloo: keys.qloo && !force.has('qloo') ? 'live' : 'mock',
    ai: env.AI && !force.has('ai') ? 'live' : 'mock',
    tavily: keys.tavily ? 'live' : 'off',
    channel3: keys.channel3 ? 'live' : 'off',
    paypal: keys.paypalId && keys.paypalSecret ? 'live' : 'off',
    keys,
    models: {
      agent: present(env.AI_AGENT_MODEL) ?? '@cf/qwen/qwen3-30b-a3b-fp8',
      writer: present(env.AI_WRITER_MODEL) ?? '@cf/qwen/qwen3-30b-a3b-fp8',
    },
    limits,
    devCache: env.DEV_CACHE === '1',
    publicBase: present(env.PUBLIC_BASE_URL),
  };
}

export const secretsOf = (cfg: Config) => Object.values(cfg.keys);

/** What the browser may learn about the setup: modes only, never keys. */
export function publicStatus(cfg: Config) {
  const mocks = (['qloo', 'ai'] as const).filter((k) => cfg[k] === 'mock');
  return {
    sandbox: true,
    mocks,
    modes: { qloo: cfg.qloo, ai: cfg.ai, tavily: cfg.tavily, channel3: cfg.channel3, paypal: cfg.paypal },
    budget: { min_cents: cfg.limits.minBudgetCents, max_cents: cfg.limits.maxBudgetCents, max_items: cfg.limits.maxItems },
  };
}
