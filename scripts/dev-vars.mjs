// Writes a gitignored, chmod 600 .dev.vars from ../.env.local (whitelisted keys only); prints key names, never values.
import fs from 'node:fs';
const KEYS = ['QLOO_API_KEY', 'NEBIUS_API_KEY', 'TAVILY_API_KEY', 'CHANNEL3_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'];
const src = new URL('../../.env.local', import.meta.url);
const out = new URL('../.dev.vars', import.meta.url);
const env = {};
if (fs.existsSync(src)) {
  for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && KEYS.includes(m[1])) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const lines = Object.entries(env).filter(([, v]) => v).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`dev-vars: wrote ${lines.length} key(s) to .dev.vars (chmod 600): ${Object.keys(env).filter((k) => env[k]).join(', ') || 'none'}; missing: ${KEYS.filter((k) => !env[k]).join(', ') || 'none'}`);
