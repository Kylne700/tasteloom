// Secret and privacy scan. Prints counts only: a hit names the variable (never the value) and the file path.
//  1. Every value in ../.env.local (plus the PayPal Basic-auth pair) must be absent from the git tree, git history, built assets and logs.
//  2. No line of ../../tools/privacy-denylist.txt may appear there either (case-insensitive fixed strings, i.e. `grep -c -i -F -f`),
//     in commit metadata or in file names. The list itself is never printed.
// Exit code: 0 clean, 1 hits found, 2 could not run (no .env.local or no denylist: NOT VERIFIED).
// Prints only. `--write` also saves the report as evidence/scan.txt: the test suite runs this script too, and no check may rewrite a tracked file.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvLocal } from './lib/env.mjs';
import { LIVE_DIR } from './lib/live.mjs';

const APP = new URL('..', import.meta.url).pathname;
const DENY = path.resolve(APP, '../../tools/privacy-denylist.txt');
const MIN_SECRET_LEN = 8; // shorter values (modes, flags) would match ordinary words

/** Names of the env entries (never values) whose value appears in the buffer. */
export function findSecrets(buf, needles) {
  return needles.filter((n) => buf.includes(n.value)).map((n) => n.name);
}

/** Lines of the buffer that contain any line of the denylist file (grep -c -i -F -f semantics). */
export function denyCount(input, denyFile) {
  const r = spawnSync('grep', ['-c', '-i', '-F', '-f', denyFile], { input, maxBuffer: 1 << 30 });
  if (r.status === 2) throw new Error('grep failed');
  return Number(String(r.stdout).trim() || 0);
}

export function needlesFrom(env) {
  const out = Object.entries(env).filter(([, v]) => v.length >= MIN_SECRET_LEN).map(([name, value]) => ({ name, value }));
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) out.push({ name: 'PAYPAL_BASIC_AUTH', value: Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64') });
  return out;
}

const git = (...args) => spawnSync('git', args, { cwd: APP, maxBuffer: 1 << 30 });
function walk(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];
}

if (import.meta.main) {
  const out = [];
  const say = (s) => (console.log(s), out.push(s));
  const env = loadEnvLocal();
  const patterns = fs.existsSync(DENY) ? fs.readFileSync(DENY, 'utf8').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '') : null;
  if (!Object.keys(env).length || !patterns) {
    say(`scan: NOT VERIFIED. ${Object.keys(env).length ? '' : '.env.local has no entries. '}${patterns ? '' : 'The privacy denylist file is missing.'}`);
    process.exit(2);
  }
  const needles = needlesFrom(env);
  const bad = patterns.filter((l) => l.trim() === '' || l.includes('\r')).length;
  say(`scan: ${needles.length} secret value(s) from .env.local checked (entries shorter than ${MIN_SECRET_LEN} characters skipped); denylist has ${patterns.length} pattern(s), ${bad} unusable (empty or CR)`);

  const tree = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').stdout.toString().split('\0').filter(Boolean);
  const groups = {
    'git tree (tracked + untracked, not ignored)': tree.map((f) => path.join(APP, f)).filter((f) => fs.existsSync(f)),
    'built assets (.build/)': walk(path.join(APP, '.build')),
    'ignored local output (evidence/debug/, evidence/screens/)': [...walk(path.join(APP, 'evidence/debug')), ...walk(path.join(APP, 'evidence/screens'))],
    'capture folder outside the repo (dev server log and state)': walk(LIVE_DIR),
  };
  let secretHits = 0;
  let denyHits = 0;
  for (const [label, files] of Object.entries(groups)) {
    let s = 0;
    let d = 0;
    const where = [];
    for (const f of files) {
      const buf = fs.readFileSync(f);
      const names = findSecrets(buf, needles);
      const lines = denyCount(buf, DENY);
      s += names.length;
      d += lines;
      if (names.length) where.push(`${path.relative(APP, f)}: secret ${names.join(',')}`);
      if (lines) where.push(`${path.relative(APP, f)}: ${lines} denylist line(s)`);
    }
    secretHits += s;
    denyHits += d;
    say(`  ${label}: ${files.length} file(s), secret hits ${s}, denylist lines ${d}`);
    for (const w of where.slice(0, 20)) say('    ' + w);
  }

  const history = git('log', '--all', '-p', '--no-color', '--format=fuller').stdout;
  const hs = findSecrets(history, needles);
  const hd = denyCount(history, DENY);
  const nm = denyCount(Buffer.from(tree.join('\n')), DENY);
  secretHits += hs.length;
  denyHits += hd + nm;
  say(`  git history and commit metadata (${history.length} bytes of log): secret hits ${hs.length}${hs.length ? ' (' + hs.join(',') + ')' : ''}, denylist lines ${hd}`);
  say(`  file names (${tree.length}): denylist lines ${nm}`);

  const tracked = git('ls-files').stdout.toString().split('\n');
  const dv = path.join(APP, '.dev.vars');
  const hygiene = {
    'no .env* or .dev.vars file is tracked': !tracked.some((f) => /(^|\/)\.env|(^|\/)\.dev\.vars/.test(f)),
    '.dev.vars is git-ignored': git('check-ignore', '-q', '.dev.vars').status === 0,
    '.dev.vars is mode 600 (or absent)': !fs.existsSync(dv) || (fs.statSync(dv).mode & 0o777) === 0o600,
  };
  for (const [k, ok] of Object.entries(hygiene)) say(`  ${ok ? 'PASS' : 'FAIL'}  ${k}`);

  const clean = secretHits === 0 && denyHits === 0 && bad === 0 && Object.values(hygiene).every(Boolean);
  say(`scan: ${clean ? 'PASS' : 'FAIL'} (secret hits ${secretHits}, denylist lines ${denyHits}, unusable patterns ${bad})`);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.join(APP, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(APP, 'evidence/scan.txt'), out.join('\n') + '\n');
  }
  process.exit(clean ? 0 : 1);
}
