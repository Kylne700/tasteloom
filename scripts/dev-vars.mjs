// Writes a gitignored, chmod 600 .dev.vars from ../.env.local (whitelisted keys only); prints key names, never values.
import fs from 'node:fs';
import { loadEnvLocal } from './lib/env.mjs';
const KEYS = ['QLOO_API_KEY', 'NEBIUS_API_KEY', 'TAVILY_API_KEY', 'CHANNEL3_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'];
const out = new URL('../.dev.vars', import.meta.url);
const env = loadEnvLocal(KEYS);
const lines = Object.entries(env).filter(([, v]) => v).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`dev-vars: wrote ${lines.length} key(s) to .dev.vars (chmod 600): ${Object.keys(env).filter((k) => env[k]).join(', ') || 'none'}; missing: ${KEYS.filter((k) => !env[k]).join(', ') || 'none'}`);
