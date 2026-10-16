import type { Env, Limits } from './types.ts';

// Hosts are fixed in code: PayPal is sandbox only and can never point at the live API.
export const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_APPROVE_HOST = 'https://www.sandbox.paypal.com/';
export const QLOO_BASE = 'https://hackathon.api.qloo.com';
export const NEBIUS_BASE = 'https://api.tokenfactory.nebius.com/v1';
export const TAVILY_BASE = 'https://api.tavily.com';
export const CHANNEL3_BASE = 'https://api.trychannel3.com';

export type Mode = 'live' | 'mock' | 'off';

export interface Config {
  /** Qloo and Nebius fall back to doc-shaped mocks while their key is missing; the UI shows a "demo data" badge. */
  qloo: Mode;
  nebius: Mode;
  tavily: Mode;
  channel3: Mode;
  paypal: Mode;
  keys: { qloo?: string; nebius?: string; tavily?: string; channel3?: string; paypalId?: string; paypalSecret?: string };
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
    nebius: present(env.NEBIUS_API_KEY),
    tavily: present(env.TAVILY_API_KEY),
    channel3: present(env.CHANNEL3_API_KEY),
    paypalId: present(env.PAYPAL_CLIENT_ID),
    paypalSecret: present(env.PAYPAL_CLIENT_SECRET),
  };
  const L = (name: string, d: number) => num(env[`LIMIT_${name}`], d);
  const limits: Limits = {
    ip: { ideas: L('IP_IDEAS', 12), nebius: L('IP_NEBIUS', 80), tavily: L('IP_TAVILY', 40), channel3: L('IP_CHANNEL3', 40), orders: L('IP_ORDERS', 8) },
    global: { ideas: L('GLOBAL_IDEAS', 400), nebius: L('GLOBAL_NEBIUS', 2000), tavily: L('GLOBAL_TAVILY', 300), channel3: L('GLOBAL_CHANNEL3', 150), orders: L('GLOBAL_ORDERS', 200) },
    dailyCapCents: Math.round(L('DAILY_CAP_USD', 2000) * 100),
    maxItems: L('MAX_ITEMS', 6),
    minBudgetCents: 1000,
    maxBudgetCents: Math.round(L('MAX_BUDGET_USD', 500) * 100),
  };
  return {
    qloo: keys.qloo && !force.has('qloo') ? 'live' : 'mock',
    nebius: keys.nebius && !force.has('nebius') ? 'live' : 'mock',
    tavily: keys.tavily ? 'live' : 'off',
    channel3: keys.channel3 ? 'live' : 'off',
    paypal: keys.paypalId && keys.paypalSecret ? 'live' : 'off',
    keys,
    models: {
      agent: present(env.NEBIUS_AGENT_MODEL) ?? 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
      writer: present(env.NEBIUS_WRITER_MODEL) ?? 'nvidia/nemotron-3-super-120b-a12b',
    },
    limits,
    devCache: env.DEV_CACHE === '1',
    publicBase: present(env.PUBLIC_BASE_URL),
  };
}

export const secretsOf = (cfg: Config) => Object.values(cfg.keys);

/** What the browser may learn about the setup: modes only, never keys. */
export function publicStatus(cfg: Config) {
  const mocks = (['qloo', 'nebius'] as const).filter((k) => cfg[k] === 'mock');
  return {
    sandbox: true,
    mocks,
    modes: { qloo: cfg.qloo, nebius: cfg.nebius, tavily: cfg.tavily, channel3: cfg.channel3, paypal: cfg.paypal },
    budget: { min_cents: cfg.limits.minBudgetCents, max_cents: cfg.limits.maxBudgetCents, max_items: cfg.limits.maxItems },
  };
}
