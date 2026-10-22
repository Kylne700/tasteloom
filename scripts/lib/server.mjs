// Start `wrangler dev` as a child process in its own process group and stop exactly that group (never pkill by name:
// other agents run wrangler on this machine).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LIVE_DIR } from './live.mjs';

const APP = path.resolve(new URL('../..', import.meta.url).pathname);

// State and log default to the capture folder, outside the repo: the dev server's KV holds live answers.
export async function startDev({ port = 8791, persist = path.join(LIVE_DIR, 'wrangler-state'), vars = {}, fresh = false, log = path.join(LIVE_DIR, 'wrangler.log') } = {}) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  if (fresh) fs.rmSync(path.resolve(APP, persist), { recursive: true, force: true });
  const args = ['wrangler', 'dev', '--port', String(port), '--persist-to', persist, '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const out = fs.openSync(log, 'w');
  const child = spawn('npx', args, { cwd: APP, detached: true, stdio: ['ignore', out, out], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  const base = `http://localhost:${port}`;
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  };
  process.on('exit', stop);
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 90000) {
      stop();
      throw new Error('wrangler dev did not become ready; see ' + log);
    }
    try {
      const r = await fetch(base + '/api/status');
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return { base, stop };
}
