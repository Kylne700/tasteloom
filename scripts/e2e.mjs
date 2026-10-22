// End-to-end check in a real browser (puppeteer-core + /usr/bin/chromium) against `wrangler dev` on port 8791.
//   node scripts/e2e.mjs [live] [tour] [--keep]
// live: the full judge flow with the real Tavily, Channel3 and PayPal sandbox (guest card -> capture COMPLETED); Qloo and the model run on their
//       documented-shape stand-ins unless the Qloo key and the AI binding exist. Costs about 6 Channel3 and 7 Tavily calls per run on a fresh state.
// tour: every screen and error/empty state at 1280, 390 and 768 px, with accessibility, focus, layout-shift and overflow checks. No billed calls.
// --keep reuses .wrangler/e2e-state (and with it the cached Channel3/Tavily answers) so a debugging re-run costs nothing.
// Only a run of both phases writes evidence/e2e.txt; partial runs write evidence/debug/e2e-<phases>.txt. Exit 0 = every check passed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { startDev } from './lib/server.mjs';
import { payAsGuest } from './lib/paypal-guest.mjs';
import { APP, BASE, DESKTOP, EVIDENCE, FIREFOX, MOBILE, PORT, SHOTS, TABLET, audit, check, consoleErrors, fresh, newPage, overflowSweep, report, sandboxMentions, say, shot, shots, sleep, strayText, tabWalk, thirdParty, waitUrl } from './lib/browser.mjs';
import { tourRound } from './lib/tour.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const phases = args.filter((a) => !a.startsWith('--'));
if (!phases.length) phases.push('live', 'tour');
const DEBUG = path.join(EVIDENCE, 'debug');
fs.mkdirSync(DEBUG, { recursive: true });

const api = async (p, init) => {
  const r = await fetch(BASE + p, { redirect: 'manual', ...init });
  let json = null;
  try { json = await r.clone().json(); } catch {}
  return { status: r.status, json, location: r.headers.get('location') };
};
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const money = (c) => `$${(c / 100).toFixed(2)}`;
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
const count = (page, sel) => page.$$eval(sel, (l) => l.length);
const KEY = 'tasteloom.v1';
const LIVE_FAVS = [{ text: 'Kafka on the Shore', type: 'book' }, { text: 'Nujabes', type: 'artist' }, { text: 'Muji', type: '' }, { text: 'Kyoto', type: 'destination' }];
const out = { orderId: null, status: null, captureId: null, usage: null, liveRun: null };

async function tap(page, sel) {
  const el = await page.waitForSelector(sel, { visible: true, timeout: 10000 });
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(100);
  await el.click();
}

// ---- live ---------------------------------------------------------------------------------------------------------------
async function live(browser) {
  say('LIVE FLOW (desktop 1280x800): real Channel3, Tavily and PayPal sandbox; Qloo and the model on stand-ins unless the Qloo key and the AI binding exist');
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);
  const page = await newPage(ctx, DESKTOP, 'live');
  const before = (await api('/api/status')).json;
  say(`  modes: ${JSON.stringify(before.modes)}; mocks: ${before.mocks.join(',') || 'none'}`);

  // 1. first screen -> favourites by keyboard -> budget -> submit
  await fresh(page);
  for (const f of LIVE_FAVS) {
    await page.focus('#fav-input');
    await page.keyboard.type(f.text);
    await page.select('#fav-type', f.type);
    await page.focus('#fav-input');
    await page.keyboard.press('Enter');
  }
  await page.focus('#budget');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); // a triple click does not select inside a number input
  await page.keyboard.type('120');
  check('live/home: four favourites entered, budget 120', (await count(page, 'ul.chips li.chip')) === 4 && (await page.$eval('#budget', (e) => e.value)) === '120');
  await tap(page, 'button[type=submit]');

  // 2. the agent works: first idea appears, then the run finishes (or fails visibly)
  const first = await page.waitForSelector('.ideas-list article.idea:not(.skeleton), section.panel.bad', { timeout: 150000 }).catch(() => null);
  check('live/ideas: the first idea card arrived (or the run failed visibly)', !!first && !(await first.evaluate((e) => e.matches('section.panel.bad'))), first ? '' : 'timeout after 150 s');
  await shot(page, 'live-ideas-running');
  const end = await page.waitForFunction(() => /Done in/.test(document.querySelector('.agent-status')?.textContent || '') ? 'done' : document.querySelector('section.panel.bad[role=alert] h2')?.textContent || false, { timeout: 150000, polling: 500 }).then((h) => h.jsonValue(), () => 'timeout');
  if (end !== 'done') {
    check('live/ideas: the run finished', false, `ended with: ${end}`);
    await page.screenshot({ path: path.join(DEBUG, 'live-ideas-failed.png'), fullPage: true });
    return;
  }
  await sleep(500);
  const stored = JSON.parse(await page.evaluate((k) => sessionStorage.getItem(k), KEY));
  out.liveRun = stored;
  fs.writeFileSync(path.join(DEBUG, 'live-run.json'), JSON.stringify(stored)); // third-party product data: stays in the ignored debug folder
  const ideas = stored.run.ideas;
  const cards = ideas.flatMap((i) => i.cards);
  const buyable = cards.filter((c) => c.purchasable);
  const mode = await page.evaluate(() => document.querySelector('.agent-status')?.textContent.replace(/\s+/g, ' ').trim());
  say(`  run: ${ideas.length} ideas, ${cards.length} cards (${buyable.length} buyable, ${cards.filter((c) => c.kind === 'link').length} link-only), tier ${stored.run.tier}, ${mode}`);
  check('live/ideas: at least 3 ideas, each with a reason ("Because they love ..." or the overall-taste line)', ideas.length >= 3 && (await page.$$eval('.ideas-list article.idea .because', (l) => l.length > 0 && l.every((e) => /Because they love|overall taste/.test(e.textContent)))), `${ideas.length} ideas`);
  check('live/ideas: real product cards from Channel3 with a title, a price in dollars, a shop and an https link', buyable.length >= 2 && buyable.every((c) => c.title && c.price_cents > 0 && c.shop) && (await page.$$eval('ul.cards li.card[data-kind=product]', (l) => l.length >= 2 && l.every((e) => /\$\d/.test(e.querySelector('.price')?.textContent || '') && /^https:/.test(e.querySelector('a.shop-link')?.href || '')))), `${buyable.length} buyable`);
  check('live/ideas: the demo-data note and badge show while Qloo/the model run on stand-ins', before.mocks.length === 0 || (/Demo data/.test((await text(page, '.demo-note')) || '') && (await page.$eval('#demo-badge', (e) => !e.hidden))));
  await audit(page, 'live/ideas');
  await shot(page, 'live-ideas-done');

  // 3. pick items, review
  const picked = [];
  for (const b of await page.$$('ul.cards li.card[data-kind=product] button.pick')) {
    if (picked.length >= 2) break;
    if (!/^Add to gift/.test(await b.evaluate((e) => e.getAttribute('aria-label') || ''))) continue;
    await b.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(100);
    await b.click();
    picked.push(await b.evaluate((e) => (e.getAttribute('aria-label') || '').replace(/^[^:]*:\s*/, '')));
  }
  await sleep(250);
  const sel = JSON.parse(await page.evaluate((k) => sessionStorage.getItem(k), KEY)).selected;
  const priced = sel.map((id) => cards.find((c) => c.id === id));
  const total = priced.reduce((a, c) => a + c.price_cents, 0);
  check('live/ideas: two cards picked, bar and meter follow, and the total is within the budget', picked.length === 2 && sel.length === 2 && total <= 12000 && /2/.test((await text(page, '.bar-count')) || ''), `${money(total)} of $120.00`);
  await tap(page, '.bar .btn.primary');
  await page.waitForFunction(() => location.hash === '#/checkout' && document.querySelector('h1')?.textContent === 'Checkout', { timeout: 8000 }); // the hash changes before the router draws the screen
  check('live/checkout: heading, both items, the total and the sandbox label', (await text(page, 'h1')) === 'Checkout' && (await count(page, '.summary li.line')) === 2 && (await text(page, 'button.pay-btn')).includes(money(total).slice(1)) && /Sandbox, no real money/.test(await text(page, '.sandbox-note')), await text(page, 'button.pay-btn'));
  await page.click('dl.testcard button.copy');
  await sleep(250);
  check('live/checkout: copy button puts the test card number on the clipboard', (await page.evaluate(() => navigator.clipboard.readText()).catch(() => '')) === '4005519200000004');
  await audit(page, 'live/checkout');
  await shot(page, 'live-checkout');

  // 4. pay, then cancel on PayPal's side: the order is cancelled and the gift is still there
  await tap(page, 'button.pay-btn');
  await waitUrl(page, /sandbox\.paypal\.com/, 60000);
  const token1 = new URL(page.url()).searchParams.get('token');
  check('live/pay: "Pay with PayPal" opens PayPal\'s sandbox page with a new order', !!token1 && /^[A-Z0-9]{10,}$/.test(token1), token1 || '');
  await page.goto(`${BASE}/api/cancel?token=${encodeURIComponent(token1)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => location.hash.startsWith('#/checkout') && document.querySelector('.note.info'), { timeout: 8000 });
  const o1 = (await api(`/api/orders/${token1}`)).json;
  check('live/cancel: cancelling on PayPal returns to checkout with the note, the gift kept, and the order marked CANCELLED', /nothing was charged/.test((await text(page, '.note.info')) || '') && (await count(page, '.summary li.line')) === 2 && o1?.status === 'CANCELLED', `order ${token1} -> ${o1?.status}`);
  await shot(page, 'live-checkout-cancelled');

  // 5. pay again: a new order, guest card on PayPal's page, back to the receipt
  await tap(page, 'button.pay-btn');
  await waitUrl(page, /sandbox\.paypal\.com/, 60000);
  const approveUrl = page.url();
  const token2 = new URL(approveUrl).searchParams.get('token');
  check('live/pay: paying again after a cancel creates a different order', !!token2 && token2 !== token1, `${token1} -> ${token2}`);
  let paid = await payAsGuest(page, approveUrl, BASE + '/', { log: () => {}, shot: (p, n) => p.screenshot({ path: path.join(DEBUG, `${n}.png`) }) });
  if (!paid.ok) {
    say(`  guest payment attempt 1 did not return (${paid.note.slice(0, 120)}); retrying once`);
    paid = await payAsGuest(page, approveUrl, BASE + '/', { log: () => {}, shot: (p, n) => p.screenshot({ path: path.join(DEBUG, `${n}-retry.png`) }) });
  }
  check('live/pay: PayPal sandbox guest card (no account created) returns to the app', paid.ok, paid.ok ? '' : paid.note.slice(0, 160));
  if (!paid.ok) return;

  // 6. receipt
  await waitUrl(page, /#\/receipt\/[A-Za-z0-9]+$/, 60000);
  await page.waitForSelector('.status-pill', { timeout: 60000 });
  const id = new URL(page.url()).hash.split('/').pop();
  const status = await page.$eval('.status-pill', (e) => e.dataset.status);
  const facts = (await text(page, '.facts')) || '';
  const o2 = (await api(`/api/orders/${id}`)).json;
  out.orderId = id; out.status = status; out.captureId = o2?.captureId || null;
  say(`  ORDER ${id} STATUS ${status} CAPTURE ${out.captureId} TOTAL ${money(o2?.total_cents || 0)} ${o2?.currency}`);
  check('live/receipt: order confirmed - order id equals the PayPal order, status COMPLETED, payment id shown', id === token2 && status === 'COMPLETED' && (await text(page, 'h1')) === 'Order confirmed' && facts.includes(id) && !!out.captureId && facts.includes(out.captureId), `${id} ${status}`);
  check('live/receipt: total and items on the receipt equal the picks; sandbox named twice (badge and Mode row), no real money', facts.includes(money(total)) && (await count(page, '.receipt .lines li.line')) === 2 && (await sandboxMentions(page)) === 2 && /PayPal sandbox, no real money/.test(facts), money(total));
  check('live/receipt: the server record agrees (COMPLETED, sandbox, same total and items, one capture)', o2?.status === 'COMPLETED' && o2.sandbox === true && o2.total_cents === total && o2.lines.length === 2 && o2.lines.every((l) => sel.includes(l.id)));
  check('live/receipt: the step bar ticks all three steps and "Start a new gift" is the one filled button', (await count(page, '#steps li.done')) === 3 && (await page.$$eval('.receipt-actions .btn.primary', (l) => l.map((e) => e.textContent.trim()))).join('|') === 'Start a new gift');
  await audit(page, 'live/receipt');
  await tabWalk(page, 'live/receipt');
  await page.evaluate(() => scrollTo(0, 0));
  await shot(page, 'live-receipt');
  const again = await api(`/api/return?token=${id}`);
  const o3 = (await api(`/api/orders/${id}`)).json;
  check('live/receipt: opening the return link again does not capture twice (same status and payment id)', again.status === 302 && /#\/receipt\//.test(again.location || '') && o3?.status === 'COMPLETED' && o3.captureId === out.captureId);

  // 7. the same receipt on a tablet and a phone (a free GET)
  for (const vp of [TABLET, MOBILE]) {
    const c2 = await browser.createBrowserContext();
    const p2 = await newPage(c2, vp, `live-receipt-${vp.width}`);
    await p2.goto(`${BASE}/#/receipt/${id}`, { waitUntil: 'load' });
    await p2.waitForSelector('.status-pill', { timeout: 15000 });
    check(`live/receipt at ${vp.width}px: confirmed, no horizontal scrolling`, (await p2.$eval('.status-pill', (e) => e.dataset.status)) === 'COMPLETED' && (await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)));
    await shot(p2, 'live-receipt');
    await c2.close();
  }

  // 8. the server refuses tampered and oversize orders over HTTP (the unit tests cover the arithmetic; this is the same code behind the real route)
  const session = stored.run.sessionId;
  const bad = await post('/api/checkout', { sessionId: 's' + '0'.repeat(20), itemIds: [sel[0]] });
  check('live/api: an unknown or expired session is refused (404 session_expired)', bad.status === 404 && bad.json?.error?.code === 'session_expired', `${bad.status} ${bad.json?.error?.code}`);
  const unknown = await post('/api/checkout', { sessionId: session, itemIds: ['not-a-card'] });
  check('live/api: an item id the server never saved is refused', unknown.status >= 400 && unknown.status < 500 && !!unknown.json?.error?.code, `${unknown.status} ${unknown.json?.error?.code}`);
  const tamper = await post('/api/checkout', { sessionId: session, itemIds: [sel[0]], price_cents: 1, total_cents: 1, lines: [{ id: sel[0], price_cents: 1 }] });
  const one = priced[0].price_cents;
  check('live/api: a tampered client price is ignored: the order total comes from the server\'s own card', tamper.status === 200 && tamper.json?.total_cents === one, `sent 1 cent, server ${tamper.json?.total_cents} vs card ${one}`);
  const all = buyable.slice(0, 6);
  const sum = all.reduce((a, c) => a + c.price_cents, 0);
  if (sum > 12000) {
    const over = await post('/api/checkout', { sessionId: session, itemIds: all.map((c) => c.id) });
    check('live/api: a total above the buyer\'s cap is refused before PayPal is called (over_budget)', over.status >= 400 && over.json?.error?.code === 'over_budget', `${over.status} ${over.json?.error?.code}, total ${money(sum)} vs $120.00`);
  } else say(`  NOT VERIFIED over HTTP: the ${all.length} buyable cards sum to ${money(sum)}, within the $120 cap (the unit tests cover the over-cap refusal)`);

  const after = (await api('/api/status')).json;
  out.usage = Object.fromEntries(['ideas', 'qloo', 'ai', 'neurons', 'tavily', 'channel3', 'orders'].map((k) => [k, (after.usage?.[k] ?? 0) - (before.usage?.[k] ?? 0)]));
  say(`  billed calls this live phase (counter deltas): ${JSON.stringify(out.usage)}`);
  check('live: the meter counted the run, and spend stayed inside the stage budget (Channel3 <= 20, Tavily <= 30 for one run)', out.usage.ideas >= 1 && out.usage.channel3 <= 20 && out.usage.tavily <= 30, JSON.stringify(out.usage));
  await ctx.close();
}

// ---- tour ---------------------------------------------------------------------------------------------------------------
async function tour(browser) {
  const before = (await api('/api/status')).json.usage || {};
  const res = await fetch(BASE + '/api/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const sample = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('tour: the saved example streams meta, events and a done event without a key', res.ok && sample[0]?.t === 'meta' && sample.at(-1)?.t === 'done' && sample.length > 30, `${sample.length} events`);
  let liveRun = out.liveRun;
  if (!liveRun) {
    try { liveRun = JSON.parse(fs.readFileSync(path.join(DEBUG, 'live-run.json'), 'utf8')); } catch {}
  }
  const rounds = [
    { name: 'desktop', vp: DESKTOP, full: true, sweep: true, clip: !FIREFOX }, // Firefox cannot be granted the clipboard permission over WebDriver BiDi: its copy checks stay out
    { name: 'mobile', vp: MOBILE, full: true, sweep: false, clip: false },
    { name: 'tablet', vp: TABLET, full: false, sweep: false, clip: false },
    { name: 'narrow', vp: { width: 320, height: 640, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, full: false, sweep: false, clip: false }, // smallest phones: key screens, with the no-sideways-scroll check
  ];
  for (const r of rounds) if (!process.env.TOUR_ROUNDS || process.env.TOUR_ROUNDS.split(',').includes(r.name)) await tourRound(browser, r, sample, liveRun); // TOUR_ROUNDS, TOUR_STATES: debugging aids
  const after = (await api('/api/status')).json.usage || {};
  const spent = ['qloo', 'ai', 'tavily', 'channel3'].map((k) => (after[k] ?? 0) - (before[k] ?? 0));
  check('tour: no billed call (Qloo, the model, Tavily, Channel3) was made by the tour', spent.every((n) => n === 0), `deltas ${spent.join('/')}`);
}

// ---- main ---------------------------------------------------------------------------------------------------------------
const t0 = Date.now();
let srv;
let browser;
try {
  spawnSync('node', ['scripts/dev-vars.mjs'], { cwd: APP, stdio: 'inherit' }); // writes .dev.vars from ../.env.local, prints key names only
  say(`e2e ${new Date().toISOString()} phases: ${phases.join(', ')}${keep ? ' (kept state)' : ''}`);
  srv = await startDev({ port: PORT, persist: '.wrangler/e2e-state', fresh: !keep });
  browser = FIREFOX
    ? await puppeteer.launch({ browser: 'firefox', executablePath: '/usr/bin/firefox', headless: true, protocol: 'webDriverBiDi' })
    : await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  say(`browser: ${await browser.version()}`);
  if (phases.includes('live') && phases.includes('tour')) fs.rmSync(SHOTS, { recursive: true, force: true }); // a full run starts from an empty folder
  for (const ph of phases) {
    try {
      if (ph === 'live') await live(browser);
      else if (ph === 'tour') await tour(browser);
      else check(`unknown phase ${ph}`, false);
    } catch (e) {
      check(`${ph}: finished without an unexpected error`, false, String(e.stack || e).split('\n').slice(0, 3).join(' | ').slice(0, 300));
    }
  }
  check('no console errors or uncaught exceptions from the app (all pages, all states)', consoleErrors.length === 0, `${consoleErrors.length}`);
  check(`no stray "null", "undefined", "NaN" or "[object ...]" text on any of the ${shots.length} screenshotted screens`, strayText.length === 0, strayText.slice(0, 3).join(' | '));
  for (const e of consoleErrors.slice(0, 8)) say(`    console error: ${e}`);
  say(`  third-party resource failures (shop images the page drops by itself, not app errors): ${thirdParty.length}`);
} catch (e) {
  report.failed++;
  say(`FAIL  e2e setup: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (srv) srv.stop();
}

say('');
say(`SCREENSHOTS ${shots.length} in evidence/screens/`);
if (out.orderId) say(`SANDBOX ORDER ${out.orderId} ${out.status} (payment id ${out.captureId})`);
const pass = report.lines.filter((l) => /^ {2}PASS /.test(l)).length;
say(`RESULT ${report.failed === 0 ? 'PASS' : 'FAIL'}: ${pass} checks passed, ${report.failed} failed, ${Math.round((Date.now() - t0) / 1000)} s`);
const full = phases.includes('live') && phases.includes('tour');
fs.writeFileSync(full ? path.join(EVIDENCE, 'e2e.txt') : path.join(DEBUG, `e2e-${phases.join('-')}.txt`), report.lines.join('\n') + '\n');
process.exit(report.failed === 0 ? 0 : 1);
