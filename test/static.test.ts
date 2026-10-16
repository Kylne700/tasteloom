// What ships to the browser and to Cloudflare: page basics, no HTML-injection sinks, strict CSP, worker config, licence.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const html = read('public/index.html');
const jsFiles = readdirSync(new URL('public/', root)).filter((f) => f.endsWith('.js'));

test('index.html: language, title, viewport, skip link, landmarks and labelled navigation', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>[^<]{5,}<\/title>/);
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.match(viewport, /width=device-width/);
  assert.doesNotMatch(viewport, /user-scalable=no|maximum-scale/, 'zoom must stay possible');
  assert.match(html, /<a class="skip" href="#main">/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.match(html, /<nav [^>]*aria-label="[^"]+"/);
  assert.match(html, /role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/);
  assert.match(html, /<noscript>/);
  for (const img of html.match(/<img\b[^>]*>/g) ?? []) assert.match(img, /\balt="/, img);
});

test('index.html: no inline script or style, no inline handlers, nothing loaded from another origin', () => {
  for (const s of html.match(/<script\b[^>]*>/g) ?? []) assert.match(s, /\bsrc="\/[^"]+"/, s);
  assert.ok(!/<script\b[^>]*>\s*\S/.test(html.replace(/<script\b[^>]*src=[^>]*><\/script>/g, '')), 'inline script body');
  assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=/i);
  for (const m of html.matchAll(/\b(?:src|href)="([^"]*)"/g)) assert.match(m[1]!, /^(\/|#)/, `external reference ${m[1]}`);
});

test('public scripts: no HTML-injection or dynamic-code sinks, and no URLs except the ones the page needs', () => {
  assert.ok(jsFiles.length >= 7, jsFiles.join(','));
  const allowedUrls = ['https://www.sandbox.paypal.com/', 'http://www.w3.org/2000/svg'];
  for (const f of jsFiles) {
    const src = read('public/' + f);
    assert.doesNotMatch(src, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\b|setTimeout\(\s*['"`]|setInterval\(\s*['"`]/, f);
    for (const u of src.match(/https?:\/\/[^\s'"`)]+/g) ?? []) assert.ok(allowedUrls.includes(u), `${f}: ${u}`);
  }
});

test('public: only text assets and one SVG icon, so no third-party logo or image ships with the UI', () => {
  const files = readdirSync(new URL('public/', root));
  for (const f of files) assert.match(f, /\.(html|js|css|svg)$|^_headers$/, f);
  assert.deepEqual(files.filter((f) => f.endsWith('.svg')), ['favicon.svg']);
});

test('_headers: strict CSP without unsafe-inline or unsafe-eval, plus the usual hardening headers', () => {
  const headers = read('public/_headers');
  const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? '';
  const d = Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).filter((x) => x[0]).map(([k, ...v]) => [k, v.join(' ')]));
  assert.equal(d['default-src'], "'self'");
  assert.equal(d['script-src'], "'self'");
  assert.equal(d['style-src'], "'self'");
  assert.equal(d['connect-src'], "'self'");
  assert.equal(d['object-src'], "'none'");
  assert.equal(d['base-uri'], "'none'");
  assert.equal(d['frame-ancestors'], "'none'");
  assert.equal(d['form-action'], "'self'");
  assert.match(d['img-src']!, /^'self' https: data:$/, 'product images come from shop CDNs over https');
  assert.doesNotMatch(csp, /unsafe-|\*/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});

test('wrangler.jsonc: static assets with the API run first, a KV binding and no secrets in the file', () => {
  const w = JSON.parse(read('wrangler.jsonc'));
  assert.equal(w.assets.directory, './public');
  assert.equal(w.assets.binding, 'ASSETS');
  assert.deepEqual(w.assets.run_worker_first, ['/api/*']);
  assert.equal(w.kv_namespaces[0].binding, 'KV');
  assert.deepEqual(w.vars, {});
  assert.doesNotMatch(read('wrangler.jsonc'), /secret|api[_-]?key|token/i);
});

test('repository hygiene: keys and local state are ignored, one runtime dependency, MIT licence', () => {
  const ignore = read('.gitignore').split('\n');
  for (const line of ['.env*', '.dev.vars', 'node_modules/', '.wrangler/', '.build/']) assert.ok(ignore.includes(line), line);
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['hono']);
  assert.equal(pkg.license, 'MIT');
  for (const s of ['dev', 'test', 'typecheck', 'build', 'e2e', 'contract:qloo', 'contract:nebius', 'scan']) assert.ok(pkg.scripts[s], s);
  assert.match(read('LICENSE'), /^MIT License/);
});
