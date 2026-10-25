// Reads ../.env.local (one folder above the repository) in code. Values stay in memory: callers must never print them.
import fs from 'node:fs';

export const ENV_FILE = new URL('../../../.env.local', import.meta.url);

/**
 * The file's entries, limited to `keys` when given. A non-empty value in the process environment wins over the file (the dotenv
 * rule), so one key can be passed for a single command: KEY=value npm run contract:qloo. An empty one never hides a file value.
 */
export function loadEnvLocal(keys, { file = ENV_FILE, env: proc = process.env } = {}) {
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && (!keys || keys.includes(m[1]))) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const k of keys ?? Object.keys(env)) if (proc[k]) env[k] = proc[k]; // without `keys`, only names the file lists (the scan checks those)
  return env;
}
