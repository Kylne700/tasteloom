// Start `wrangler dev` as a child process in its own process group and stop exactly that group (never pkill by name:
// other agents run wrangler on this machine).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(new URL('../..', import.meta.url).pathname);

export async function startDev({ port = 8791, persist = '.wrangler/e2e-state', vars = {}, fresh = false, log = '/tmp/ta-wrangler.log' } = {}) {
  if (fresh) fs.rmSync(path.join(APP, persist), { recursive: true, force: true });
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
