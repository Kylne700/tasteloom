// Reads tasteagent/.env.local in code. Values stay in memory: callers must never print them.
import fs from 'node:fs';

export const ENV_FILE = new URL('../../../.env.local', import.meta.url);

export function loadEnvLocal(keys) {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && (!keys || keys.includes(m[1]))) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
