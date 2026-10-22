// The state tour: every screen and every error, empty and rare state of the app at 1280 and 390 px (key screens also at 768 px),
// as screenshots in evidence/screens/ plus accessibility, focus, layout-shift and overflow checks. The two states drawn from a live run
// (ideas-live, checkout-live) and any crash picture go to the capture folder outside the repo (scripts/lib/live.mjs), never into evidence/.
// The happy path and the example run use the real server. Rare states (API down, over budget, PayPal cancelled, capture failed, ...)
// are produced by answering the app's own fetch calls inside the page (see pagePatch in browser.mjs), so no real service is touched.
import fs from 'node:fs';
import path from 'node:path';
import { LIVE_DIR, LIVE_SHOTS } from './live.mjs';
import { BASE, FIREFOX, audit, check, cls, fresh, mock, newPage, overflowSweep, release, sandboxMentions, say, shot, sleep, tabWalk } from './browser.mjs';

const KEY = 'tasteloom.v1';
const UPSTREAM_MSG = 'Please try again in a minute.'; // the texts the server sends (src/app.ts, src/commerce.ts)
const LIMIT_MSG = 'You have reached today’s allowance for live lookups. The example still works, or come back tomorrow.';
const LABEL = { COMPLETED: 'Completed', CAPTURE_FAILED: 'Not completed', NOT_APPROVED: 'Not approved yet', CREATED: 'Waiting for approval', CANCELLED: 'Cancelled' };
const ORDER_ID = '7EX35260AB123456C'; // synthetic ids for the scripted receipts
const CAPTURE_ID = '3C679366HH908993F';
const err = (status, code, message) => ({ status, json: { error: { code, message } } });

// ---- small page helpers -------------------------------------------------------------------------------------------------
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
const count = (page, sel) => page.$$eval(sel, (l) => l.length);
const shown = (page, sel) => page.$eval(sel, (e) => e.getClientRects().length > 0 && !e.hidden).catch(() => false);
const until = (page, fn, arg, ms = 20000) => page.waitForFunction(fn, { timeout: ms }, arg);
const hashIs = (page, h) => until(page, (x) => location.hash === x, h, 10000);
/** Visible "Back to ideas" links when the browser has no :has(): drops the :has() rule and applies the @supports fallback unconditionally (a browser without :has() would have invalid-dropped the first and applied the second). */
const backLinksWithoutHas = async (page) => {
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (let i = sheet.cssRules.length - 1; i >= 0; i--) if (sheet.cssRules[i].selectorText?.includes(':has(')) sheet.deleteRule(i);
      for (const r of [...sheet.cssRules]) if (r.conditionText?.includes('selector(:has')) for (const inner of r.cssRules) sheet.insertRule(inner.cssText, sheet.cssRules.length);
    }
  });
  return page.$$eval('.checkout a', (l) => l.filter((a) => /Back to ideas/.test(a.textContent) && a.getClientRects().length).length);
};
/** The buttons of a card or banner: their names and which of them are filled (primary). */
const actionsOf = (page, sel) => page.$$eval(`${sel} > *`, (l) => ({ names: l.map((e) => e.textContent.trim()), filled: l.filter((e) => e.classList.contains('primary')).map((e) => e.textContent.trim()) }));

async function findByText(page, re, scope = 'button, a, [role=switch]') {
  for (const el of await page.$$(scope)) {
    const t = await el.evaluate((e) => (e.getClientRects().length ? (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ') : ''));
    if (t && re.test(t)) return el;
  }
  return null;
}
/** A real mouse or touch click on the first visible control whose name matches. */
async function tapText(page, re, scope) {
  const el = await findByText(page, re, scope);
  if (!el) throw new Error(`no visible control matching ${re}`);
  await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await sleep(80);
  await el.click();
}
async function addChip(page, f) {
  await page.focus('#fav-input');
  await page.keyboard.type(f.text);
  await page.select('#fav-type', f.type || '');
  await page.focus('#fav-input');
  await page.keyboard.press('Enter');
}
async function setBudget(page, v) {
  await page.focus('#budget');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); // a triple click does not select inside a number input
  await page.keyboard.type(String(v));
}
/** Clicks the first n "Add to gift" buttons; returns how many were added. */
async function pickCards(page, n) {
  let k = 0;
  for (const b of await page.$$('ul.cards li.card button.pick')) {
    if (k >= n) break;
    if (!/^Add to gift/.test(await b.evaluate((e) => e.getAttribute('aria-label') || ''))) continue;
    await b.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(80);
    await b.click();
    k++;
  }
  return k;
}

// ---- data for the scripted states ---------------------------------------------------------------------------------------
function fixtures(sample) {
  const meta = sample.find((e) => e.t === 'meta');
  // the saved example has no type hints; give its favourites some so the chips and their hints can be shown and checked
  const HINT = { 'Hario V60': 'brand', 'Kafka on the Shore': 'book', Nujabes: 'artist', 'Stardew Valley': 'video_game', Kyoto: 'destination' };
  const FAVS = meta.favorites.map((f) => ({ text: f.text, ...((f.type || HINT[f.text]) ? { type: f.type || HINT[f.text] } : {}) }));
  // the same events as a live run would send: not flagged as the saved example, Qloo and the model on demo data
  const live = sample.map((e) => (e.t === 'meta' ? { ...e, example: false, mocks: ['qloo', 'ai'] } : e.t === 'done' ? { t: 'done', tier: 'agent' } : e));
  const nth = (t, n) => { let k = 0; return live.findIndex((e) => e.t === t && ++k === n); };
  return {
    FAVS,
    live,
    firstIdea: nth('idea', 1),
    secondIdea: nth('idea', 2),
    // stops right after the second idea: the later steps never ran, so the step list must not look finished
    partial: [...live.slice(0, nth('idea', 2) + 1), { t: 'error', code: 'upstream', message: UPSTREAM_MSG }],
    // the model's daily allowance was used up (or it did not answer): the run still finishes, with fixed steps and template reasons
    noModel: live.map((e) => (e.t === 'done' ? { t: 'done', tier: 'template' } : e)),
    // a service's daily cap was reached during the run: it finishes with what it has and the page names the service
    limited: live.map((e) => (e.t === 'done' ? { t: 'done', tier: 'agent', limited: ['channel3', 'tavily'] } : e)),
    empty: [{ ...live[0], budget_cents: 5000 }, { t: 'phase', id: 'taste', label: 'Reading their taste with Qloo', state: 'running' }, { t: 'done', tier: 'agent' }],
  };
}

const purchasable = (done) => done.run.ideas.flatMap((i) => i.cards).filter((c) => c.purchasable);
const withRun = (done, { budget_cents, selected }) => ({ ...done, run: { ...done.run, ...(budget_cents ? { budget_cents } : {}) }, selected });

/** Reset the page to a known state: clear storage, seed sessionStorage, then script some API answers and go to a route. */
async function open(c, hash = '#/', { st = null, mocks = {}, search = '' } = {}) {
  const { page } = c;
  await page.goto(`${BASE}/${search}`, { waitUntil: 'load' });
  await page.evaluate((k, s) => { sessionStorage.clear(); if (s) sessionStorage.setItem(k, JSON.stringify(s)); }, KEY, st);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('h1');
  for (const [k, v] of Object.entries(mocks)) await mock(page, k, v);
  if (hash !== '#/') await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('h1');
}

const order = (c, status, over = {}) => {
  const lines = purchasable(c.done).slice(0, 2).map((x) => ({ id: x.id, title: x.title, shop: x.shop, price_cents: x.price_cents }));
  return { id: ORDER_ID, status, lines, total_cents: lines.reduce((a, l) => a + l.price_cents, 0), currency: 'USD', captureId: status === 'COMPLETED' ? CAPTURE_ID : null, error: null, trace: ['Priced the order from the saved product cards', 'Created the order in the PayPal sandbox', status === 'COMPLETED' ? 'Captured the approved payment' : 'Waited for the approval'], sandbox: true, ...over };
};
const receipt = (c, key, status, over, wantH1, { gift = false, filled, banner = null } = {}) => ({
  key,
  tablet: status === 'COMPLETED',
  async run() {
    await open(c, '#/', { st: gift ? { ...c.done, selected: purchasable(c.done).slice(0, 2).map((x) => x.id) } : c.done });
    await mock(c.page, `GET /api/orders/${ORDER_ID}`, { json: order(c, status, over) });
    await c.page.evaluate((h) => { location.hash = h; }, `#/receipt/${ORDER_ID}`);
    await c.page.waitForFunction((t) => document.querySelector('h1')?.textContent === t, { timeout: 8000 }, wantH1).catch(() => {});
    check(`${c.name}/${key}: heading "${wantH1}" and the order id shown`, (await text(c.page, 'h1')) === wantH1 && (await text(c.page, '.facts')).includes(ORDER_ID), await text(c.page, 'h1'));
    check(`${c.name}/${key}: status pill says "${LABEL[status]}" (the raw ${status} stays in the page data only), the page names the sandbox twice (header badge, Mode row), once more only where the server's own error text says it`, (await text(c.page, '.status-pill')) === LABEL[status] && (await c.page.$eval('.status-pill', (e) => e.dataset.status)) === status && (await text(c.page, '.facts')).includes('PayPal sandbox, no real money') && (await sandboxMentions(c.page)) === 2 + (/sandbox/i.test(over?.error || '') ? 1 : 0));
    const card = (await text(c.page, '.receipt-card')) || '';
    check(`${c.name}/${key}: no raw codes in the text and "Nothing was charged" is said at most once`, !/[A-Z]{3,}_[A-Z_]{3,}/.test(card) && (card.match(/Nothing was charged/g) || []).length <= (status === 'COMPLETED' ? 0 : 1), card.slice(0, 80));
    const doneSteps = await count(c.page, '#steps li.done');
    check(`${c.name}/${key}: the step bar ${status === 'COMPLETED' ? 'ticks all three steps' : 'keeps Checkout as the current step instead of ticking it'}`, status === 'COMPLETED' ? doneSteps === 3 : doneSteps === 2 && (await text(c.page, '#steps li.current')).startsWith('3'), `${doneSteps} done, current ${await text(c.page, '#steps li.current')}`);
    const acts = await actionsOf(c.page, '.receipt-actions');
    check(`${c.name}/${key}: exactly one filled button ("${filled}") among ${acts.names.join(', ')}`, acts.filled.join('|') === filled, acts.filled.join(','));
    const note = await text(c.page, '.receipt-body .note');
    check(`${c.name}/${key}: ${banner ? 'the failure reason is shown once, in plain words' : 'no extra banner repeats the subtitle'}`, banner ? note === banner : note === null, note || 'none');
    if (status === 'COMPLETED') {
      check(`${c.name}/${key}: payment id, total and both items on the receipt`, (await text(c.page, '.facts')).includes(CAPTURE_ID) && (await count(c.page, '.receipt .lines li.line')) === 2);
      await c.audit('receipt');
      if (c.sweep) await overflowSweep(c.page, `${c.name}/receipt`);
      await tabWalk(c.page, `${c.name}/receipt`);
    }
    await c.snap();
  },
});

// ---- the states ---------------------------------------------------------------------------------------------------------
function states(fx) {
  const S = [];
  const add = (key, tablet, run) => S.push({ key, tablet, run });

  add('home-empty', true, async (c) => {
    const { page } = c;
    await fresh(page);
    check(`${c.name}/home: heading, title and focus on the heading`, (await text(page, 'h1')) === 'Gifts that understand them' && (await page.title()) === 'Gifts that understand them · Tasteloom' && (await page.evaluate(() => document.activeElement?.tagName)) === 'H1', await page.title());
    const status = await page.evaluate(() => fetch('/api/status').then((r) => r.json()));
    check(`${c.name}/home: the "Demo data" badge is shown exactly while a mock is active`, (await shown(page, '#demo-badge')) === (status.mocks.length > 0), `mocks: ${status.mocks.join(',') || 'none'}`);
    check(`${c.name}/home: sandbox label in the header, three steps with step 1 current`, /sandbox/i.test((await text(page, '.pill.sandbox')) || '') && (await count(page, '#steps li.step')) === 3 && (await text(page, '#steps li.current')).startsWith('1'), await text(page, '#steps li.current'));
    check(`${c.name}/home: no third-party image on the first screen`, await page.evaluate(() => [...document.images].every((i) => new URL(i.src).origin === location.origin)));
    await c.audit('home');
    if (c.sweep) await overflowSweep(page, `${c.name}/home`);
    await tabWalk(page, `${c.name}/home`);
    await fresh(page);
    await c.snap();
  });

  add('home-filled', false, async (c) => {
    const { page } = c;
    await fresh(page);
    for (const f of fx.FAVS.slice(0, 4)) await addChip(page, f);
    await setBudget(page, 120);
    check(`${c.name}/home: four chips with their type hints, count line and budget`, (await count(page, 'ul.chips li.chip')) === 4 && /^4 of 5 added/.test(await text(page, '#fav-count')) && (await page.$eval('#budget', (e) => e.value)) === '120', await text(page, '#fav-count'));
    check(`${c.name}/home: the chips show the type hint the user chose`, (await page.$$eval('ul.chips li.chip .chip-type', (l) => l.length)) >= 3);
    await c.snap();
    await addChip(page, fx.FAVS[4]);
    check(`${c.name}/home: a fifth chip is accepted`, (await count(page, 'ul.chips li.chip')) === 5 && /^5 of 5 added/.test(await text(page, '#fav-count')), await text(page, '#fav-count'));
    await addChip(page, { text: 'One too many' });
    check(`${c.name}/home: a sixth chip is refused with a plain sentence`, (await count(page, 'ul.chips li.chip')) === 5 && (await text(page, '#fav-error')) === 'You can add up to 5. Remove one to add another.', await text(page, '#fav-error'));
    await page.focus('#fav-input');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.click('ul.chips li.chip:last-child button.chip-x');
    check(`${c.name}/home: removing a chip works and the count follows`, (await count(page, 'ul.chips li.chip')) === 4 && /^4 of 5 added/.test(await text(page, '#fav-count')), await text(page, '#fav-count'));
  });

  add('home-error-favs', false, async (c) => {
    const { page } = c;
    await fresh(page);
    await addChip(page, { text: 'Muji' });
    await addChip(page, { text: 'muji' });
    check(`${c.name}/home: a repeated favourite is refused`, /already added/i.test((await text(page, '#fav-error')) || ''), await text(page, '#fav-error'));
    await page.keyboard.press('Backspace');
    await tapText(page, /^Find gift ideas$/);
    await sleep(250);
    check(`${c.name}/home: fewer than three favourites gives a clear error and stays on the first screen`, /at least 3/.test((await text(page, '#fav-error')) || '') && (await page.evaluate(() => location.hash)) !== '#/ideas', await text(page, '#fav-error'));
    await c.snap();
  });

  add('home-error-budget', false, async (c) => {
    const { page } = c;
    await fresh(page);
    for (const f of fx.FAVS.slice(0, 3)) await addChip(page, f);
    await setBudget(page, 5);
    await tapText(page, /^Find gift ideas$/);
    await sleep(250);
    check(`${c.name}/home: a budget below $10 gives a clear error and stays on the first screen`, /at least \$10/.test((await text(page, '#budget-error')) || '') && (await page.evaluate(() => location.hash)) !== '#/ideas', await text(page, '#budget-error'));
    await c.snap();
  });

  // one scripted stream gives three states: early (skeletons), mid (two ideas) and stopped early
  add('ideas-running-early', true, async (c) => {
    const { page } = c;
    const key = 'POST /api/ideas';
    await open(c, '#/', { st: { favorites: fx.FAVS, budget: 120 }, mocks: { [key]: { events: fx.partial } } });
    await cls(page, true);
    await tapText(page, /^Find gift ideas$/);
    await release(page, key, fx.firstIdea);
    await sleep(500);
    check(`${c.name}/ideas: while running, the heading, step 2, a running phase, tool calls and skeleton cards`, (await text(page, 'h1')) === 'Gift ideas' && (await count(page, '.phases li.phase[data-state=running]')) >= 1 && (await count(page, '.calls li.call')) >= 3 && (await count(page, '.idea.skeleton')) >= 1 && (await text(page, '#steps li.current')).startsWith('2'));
    check(`${c.name}/ideas: the demo-data note is shown for a run on mocks`, /Demo data/.test((await text(page, '.demo-note')) || ''), (await text(page, '.demo-note') || '').slice(0, 60));
    await c.audit('ideas running');
    await c.snap();
    c.stream = { key, n: fx.firstIdea };
  });

  add('ideas-running-mid', false, async (c) => {
    const { page } = c;
    await release(page, c.stream.key, fx.secondIdea + 1 - c.stream.n);
    await sleep(600);
    check(`${c.name}/ideas: two idea cards have arrived and the loading placeholders for the others remain`, (await count(page, '.ideas-list article.idea:not(.skeleton)')) === 2 && (await count(page, '.idea.skeleton')) >= 1);
    c.stream.n = fx.secondIdea + 1;
    // wide screens: the step list scrolls in its own panel and follows the newest step while the page itself stays put
    const f = await page.$eval('.agent', (a) => {
      const last = [...a.querySelectorAll('li.call')].at(-1)?.getBoundingClientRect();
      const box = a.getBoundingClientRect();
      return { wide: matchMedia('(min-width: 1000px)').matches, scrolls: a.scrollHeight > a.clientHeight + 4, visible: !!last && last.top >= box.top - 1 && last.bottom <= box.bottom + 1, pageY: scrollY };
    });
    if (f.wide) check(`${c.name}/ideas: while running, the step panel scrolls to show the newest step and the page does not move`, f.scrolls && f.visible && f.pageY === 0, JSON.stringify(f));
    if (!FIREFOX) {
      const shift = await cls(page);
      check(`${c.name}/ideas: layout shift while steps and ideas stream in is at most 0.1`, shift <= 0.1, `CLS ${shift}`);
    }
    await c.snap();
  });

  add('ideas-error-partial', false, async (c) => {
    const { page } = c;
    await release(page, c.stream.key, fx.partial.length - c.stream.n);
    await page.waitForSelector('section.panel.warn[role=alert]', { timeout: 8000 });
    const acts = await actionsOf(page, 'section.panel.warn .panel-actions');
    const body = (await text(page, 'section.panel.warn .panel-body p')) || '';
    check(`${c.name}/ideas: stopping early keeps the ideas, says so, and offers to try again`, (await text(page, 'section.panel.warn h2')) === 'The agent stopped early' && (await count(page, '.ideas-list article.idea:not(.skeleton)')) >= 2 && acts.names.join('|') === 'Try again|Try an example', `${await text(page, 'section.panel.warn h2')} / ${acts.names.join(', ')}`);
    check(`${c.name}/ideas: stopping early has no filled button (the Review and pay bar stays the main action) and its text does not say "try again" twice`, acts.filled.length === 0 && !/try again/i.test(body) && body.length > 20, `${acts.filled.join(',')} / ${body}`);
    check(`${c.name}/ideas: no placeholder is left spinning after the error`, (await count(page, '.idea.skeleton')) === 0 && (await count(page, '.phases li.phase[data-state=running]')) === 0);
    check(`${c.name}/ideas: the step list tells the truth (unfinished steps are not ticked) and the status says Stopped`, (await count(page, '.phases li.phase[data-state=done]')) < (await count(page, '.phases li.phase')) && (await count(page, '.phases li.phase[data-state=error]')) >= 1 && (await text(page, '.agent-status')) === 'Stopped', await text(page, '.agent-status'));
    check(`${c.name}/ideas: the error card is in the first screens, not below an opened trace`, (await page.$eval('section.panel.warn', (e) => e.getBoundingClientRect().top + scrollY)) < 1100 && (await page.$eval('.agent', (e) => e.dataset.open)) === String(await page.evaluate(() => matchMedia('(min-width: 1000px)').matches)));
    await c.audit('ideas partial');
    await c.snap();
    // a reload while a run is in progress cannot resume it: back to the first screen with the favourites still there
  });

  add('ideas-example', true, async (c) => {
    const { page } = c;
    await fresh(page);
    await cls(page, true);
    await tapText(page, /^Try an example$/);
    await hashIs(page, '#/ideas');
    await until(page, () => document.title === 'Gift ideas · Tasteloom' && document.activeElement?.tagName === 'H1', null, 5000).catch(() => {}); // the router runs on the hashchange event, a moment after the hash changes
    check(`${c.name}/ideas: the page title and focus follow the route`, (await page.title()) === 'Gift ideas · Tasteloom' && (await page.evaluate(() => document.activeElement?.tagName)) === 'H1', await page.title());
    await until(page, () => /Done in/.test(document.querySelector('.agent-status')?.textContent || ''), null, 60000);
    await sleep(400);
    c.done = JSON.parse(await page.evaluate((k) => sessionStorage.getItem(k), KEY));
    const buyable = purchasable(c.done).length;
    check(`${c.name}/ideas: example run finished with ideas, product cards and the saved-example note`, c.done.run.ideas.length >= 3 && buyable >= 4 && (await shown(page, '.example-note')), `${c.done.run.ideas.length} ideas, ${buyable} buyable cards`);
    check(`${c.name}/ideas: each idea says why ("Because they love ..." or the overall-taste line)`, await page.$$eval('.ideas-list article.idea:not(.skeleton) .because', (l) => l.length > 0 && l.every((e) => /Because they love|overall taste/.test(e.textContent))));
    check(`${c.name}/ideas: each product card shows a price, a shop and a link that opens safely`, await page.$$eval('ul.cards li.card[data-kind=product]', (l) => l.length > 0 && l.every((e) => /\$\d/.test(e.querySelector('.price')?.textContent || '') && e.querySelector('.shop')?.textContent && /^https:/.test(e.querySelector('a.shop-link')?.href || '') && /noopener/.test(e.querySelector('a.shop-link')?.rel || ''))));
    const shift = await cls(page);
    if (!FIREFOX) check(`${c.name}/ideas: layout shift while the example loads is at most 0.1`, shift <= 0.1, `CLS ${shift}`); // Firefox has no layout-shift entries: not measured there
    await c.audit('ideas');
    if (c.sweep) await overflowSweep(page, `${c.name}/ideas`);
    await tabWalk(page, `${c.name}/ideas`, 140);
    await c.snap();
  });

  add('ideas-selected', true, async (c) => {
    const { page } = c;
    await open(c, '#/ideas', { st: c.done });
    check(`${c.name}/ideas: "Review and pay" is disabled until something is picked`, await page.$eval('.bar .btn.primary', (e) => e.disabled || e.getAttribute('aria-disabled') === 'true'));
    const k = await pickCards(page, 2);
    await sleep(200);
    const now = await page.$eval('.bar div.meter[role=meter]', (e) => Number(e.getAttribute('aria-valuenow'))).catch(() => NaN);
    check(`${c.name}/ideas: two picks update the card state, the bar count and the budget meter`, k === 2 && (await count(page, 'ul.cards li.card[data-selected="true"]')) === 2 && /2/.test((await text(page, '.bar-count')) || '') && now > 0, `${await text(page, '.bar-count')}, meter ${now}`);
    check(`${c.name}/ideas: "Review and pay" is now enabled`, !(await page.$eval('.bar .btn.primary', (e) => e.disabled)));
    await c.snap();
    check(`${c.name}/ideas: the picks survive a reload`, await (async () => { await page.reload({ waitUntil: 'load' }); await page.waitForSelector('ul.cards'); return (await count(page, 'ul.cards li.card[data-selected="true"]')) === 2; })());
  });

  add('ideas-over-budget', false, async (c) => {
    const cheapest = purchasable(c.done).sort((a, b) => a.price_cents - b.price_cents)[0];
    await open(c, '#/ideas', { st: withRun(c.done, { budget_cents: cheapest.price_cents + 300, selected: [cheapest.id] }) });
    const labels = await c.page.$$eval('ul.cards li.card button.pick', (l) => l.map((b) => b.getAttribute('aria-label') || ''));
    check(`${c.name}/ideas: cards that would break the budget say "Over budget" and cannot be added`, labels.some((l) => /^Over budget/.test(l)) && labels.filter((l) => /^Add to gift/.test(l)).length === 0, labels.map((l) => l.split(':')[0]).join(' | ').slice(0, 120));
    await c.snap();
  });

  add('ideas-gift-full', false, async (c) => {
    const ids = purchasable(c.done).slice(0, 6).map((x) => x.id);
    await open(c, '#/ideas', { st: withRun(c.done, { budget_cents: 50000, selected: ids }) });
    const labels = await c.page.$$eval('ul.cards li.card button.pick', (l) => l.map((b) => b.getAttribute('aria-label') || ''));
    check(`${c.name}/ideas: with six picked the others say "Gift is full"`, ids.length === 6 && labels.some((l) => /^Gift is full/.test(l)) && labels.filter((l) => /^Add to gift/.test(l)).length === 0, `${ids.length} picked`);
    await c.snap();
  });

  add('ideas-images-off', true, async (c) => {
    const { page } = c;
    await open(c, '#/ideas', { st: c.done, search: '?images=off' });
    const off = await page.evaluate(() => ({ attr: document.documentElement.dataset.images, shown: [...document.querySelectorAll('.media img')].filter((i) => i.getClientRects().length && getComputedStyle(i).display !== 'none').length, sw: document.querySelector('button.switch')?.getAttribute('aria-checked') }));
    check(`${c.name}/ideas: ?images=off hides every product image and the switch says off`, off.attr === 'off' && off.shown === 0 && off.sw === 'false', JSON.stringify(off));
    await c.snap();
  });

  add('ideas-images-default', true, async (c) => {
    // privacy: a shop's image server sees the visitor's IP, so no third-party image may load before the switch is turned on
    const { page } = c;
    const asked = [];
    const seen = (r) => r.resourceType() === 'image' && !r.url().startsWith(BASE) && asked.push(new URL(r.url()).host);
    page.on('request', seen);
    await open(c, '#/ideas', { st: c.done });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(600);
    const before = { asked: asked.length, src: await page.evaluate(() => document.querySelectorAll('.media img[src], .thumb img[src]').length) };
    await page.click('button.switch');
    const after = await page.evaluate(() => document.querySelectorAll('.media img[src]').length);
    page.off('request', seen);
    check(`${c.name}/ideas: a fresh visit asks no shop for an image until the images switch is turned on`, before.asked === 0 && before.src === 0 && after > 0, `${before.asked} third-party image requests and ${before.src} image sources before the switch, ${after} sources after`);
  });

  const ideasError = (key, label, spec, title, buttons, filled) =>
    add(key, key === 'ideas-error-limit', async (c) => {
      const { page } = c;
      await open(c, '#/', { st: { favorites: fx.FAVS, budget: 120 }, mocks: { 'POST /api/ideas': spec } });
      await tapText(page, /^Find gift ideas$/);
      await page.waitForSelector('section.panel[role=alert]', { timeout: 8000 });
      await sleep(300);
      const got = await actionsOf(page, 'section.panel[role=alert] .panel-actions');
      const body = (await text(page, 'section.panel[role=alert] .panel-body p')) || '';
      check(`${c.name}/ideas: ${label}: title "${title}" with a plain message and the actions ${buttons.join(', ')}`, (await text(page, 'section.panel[role=alert] h2')) === title && got.names.join('|') === buttons.join('|') && (await count(page, '.idea.skeleton')) === 0, `${await text(page, 'section.panel[role=alert] h2')} / ${got.names.join(', ')}`);
      check(`${c.name}/ideas: ${label}: one filled button ("${filled}") and a message that does not repeat the title`, got.filled.join('|') === filled && body.length > 10 && !body.toLowerCase().includes(title.toLowerCase()), `${got.filled.join(',')} / ${body}`);
      check(`${c.name}/ideas: ${label}: the status row says Stopped, in the same red as the card icon`, (await text(page, '.agent-status')) === 'Stopped' && (await page.evaluate(() => getComputedStyle(document.querySelector('.agent-status svg')).color === getComputedStyle(document.querySelector('section.panel.bad .panel-icon')).color)), await text(page, '.agent-status'));
      if (key === 'ideas-error-limit') await c.audit('ideas error');
      await c.snap();
    });
  ideasError('ideas-error-network', 'server unreachable', { reject: true }, 'We could not reach the server', ['Try again', 'Try an example'], 'Try again');
  ideasError('ideas-error-limit', 'daily limit reached', err(429, 'limit', LIMIT_MSG), 'Live lookups are used up for now', ['Try an example'], 'Try an example');
  ideasError('ideas-error-upstream', 'a service is down', err(502, 'upstream', UPSTREAM_MSG), 'A service we depend on is not answering', ['Try again', 'Try an example'], 'Try again');
  ideasError('ideas-error-bad-input', 'input refused by the server', err(400, 'bad_input', 'Nothing we found fits that budget. Try a higher budget or different favourites.'), 'Nothing to suggest yet', ['Change favourites', 'Try an example'], 'Change favourites');

  add('ideas-empty', false, async (c) => {
    const { page } = c;
    await open(c, '#/', { st: { favorites: fx.FAVS, budget: 50 }, mocks: { 'POST /api/ideas': { events: fx.empty } } });
    await tapText(page, /^Find gift ideas$/);
    await release(page, 'POST /api/ideas', fx.empty.length);
    await page.waitForFunction(() => /No ideas to show/.test(document.body.textContent), { timeout: 8000 });
    const acts = await actionsOf(page, 'section.panel .panel-actions');
    check(`${c.name}/ideas: no results gives an explanation and two ways forward, one of them filled`, acts.names.join('|') === 'Change favourites|Try an example' && acts.filled.join('|') === 'Change favourites', acts.names.join(', '));
    check(`${c.name}/ideas: the status row says "Finished without ideas" instead of a green Done`, (await text(page, '.agent-status')) === 'Finished without ideas' && (await page.$eval('.agent-status', (e) => e.dataset.state)) === 'empty', await text(page, '.agent-status'));
    await c.snap();
  });

  add('ideas-no-model', false, async (c) => {
    const { page } = c;
    await open(c, '#/', { st: { favorites: fx.FAVS, budget: 120 }, mocks: { 'POST /api/ideas': { events: fx.noModel } } });
    await tapText(page, /^Find gift ideas$/);
    await release(page, 'POST /api/ideas', fx.noModel.length);
    await page.waitForSelector('.tier-note', { timeout: 8000 });
    check(`${c.name}/ideas: when the model did not take part, a plain note says so and the ideas are still there`, /did not take part/.test((await text(page, '.tier-note')) || '') && (await count(page, '.ideas-list .idea:not(.skeleton)')) >= 1, (await text(page, '.tier-note') || '').slice(0, 80));
  });

  add('ideas-limited', false, async (c) => {
    const { page } = c;
    await open(c, '#/', { st: { favorites: fx.FAVS, budget: 120 }, mocks: { 'POST /api/ideas': { events: fx.limited } } });
    await tapText(page, /^Find gift ideas$/);
    await release(page, 'POST /api/ideas', fx.limited.length);
    await page.waitForSelector('.tier-note', { timeout: 8000 });
    const t = (await text(page, '.tier-note')) || '';
    check(`${c.name}/ideas: when a service refused calls because its daily cap was reached, a plain note names it and the ideas are still there`, /Channel3 and Tavily ran out/.test(t) && (await count(page, '.ideas-list .idea:not(.skeleton)')) >= 1, t.slice(0, 90));
  });

  const two = (c) => purchasable(c.done).slice(0, 2);
  const ckSt = (c) => ({ ...c.done, selected: two(c).map((x) => x.id) });
  const total = (c) => two(c).reduce((a, x) => a + x.price_cents, 0);

  add('checkout', true, async (c) => {
    const { page } = c;
    await open(c, '#/checkout', { st: ckSt(c) });
    check(`${c.name}/checkout: heading, title, step 3, both items and the totals`, (await text(page, 'h1')) === 'Checkout' && (await page.title()) === 'Checkout · Tasteloom' && (await text(page, '#steps li.current')).startsWith('3') && (await count(page, '.summary li.line')) === 2 && /Total/.test(await text(page, 'dl.totals')), await text(page, 'dl.totals'));
    check(`${c.name}/checkout: the sandbox label and the working test card are on screen`, /Sandbox, no real money/.test(await text(page, '.sandbox-note')) && (await text(page, 'dl.testcard')).includes('4005 5192 0000 0004') && (await text(page, 'dl.testcard')).includes('12/30') && (await text(page, 'dl.testcard')).includes('123'));
    check(`${c.name}/checkout: the only filled button on the screen is Pay (the way back is an outline button)`, (await page.$$eval('main .btn.primary, main button.primary', (l) => l.map((e) => e.textContent.trim()))).join('|').startsWith('Pay ') && (await page.$$eval('main .btn.primary', (l) => l.length)) === 1);
    check(`${c.name}/checkout: the pay button names the exact total`, new RegExp(`Pay \\$${(total(c) / 100).toFixed(2).replace('.', '\\.')} with PayPal`).test(await text(page, 'button.pay-btn')), await text(page, 'button.pay-btn'));
    const payTop = () => page.evaluate(() => Math.round(document.querySelector('button.pay-btn').getBoundingClientRect().top + scrollY));
    const payBefore = await payTop();
    await page.click('dl.testcard button.copy');
    await sleep(250);
    const payAfter = await payTop();
    check(`${c.name}/checkout: pressing Copy moves nothing on the page (the label changes, the layout does not)`, payAfter === payBefore, `Pay button at ${payBefore} px, then ${payAfter} px`);
    if (c.clip) {
      const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e.message}`);
      check(`${c.name}/checkout: "Copy card number" puts the test card on the clipboard and says Copied`, clip === '4005519200000004' && /Copied/.test(await text(page, 'dl.testcard .tc-row:first-child button.copy')), clip.length > 20 ? 'unexpected' : clip);
    }
    const back = await page.waitForFunction(() => document.querySelector('dl.testcard button.copy').textContent.trim() === 'Copy', { timeout: 4000 }).then(() => true, () => false);
    check(`${c.name}/checkout: the Copied label goes back to Copy by itself`, back);
    await page.mouse.move(0, 0); // the screenshot shows the resting state, not a hovered button
    await c.audit('checkout');
    if (c.sweep) await overflowSweep(page, `${c.name}/checkout`);
    await tabWalk(page, `${c.name}/checkout`);
    await page.evaluate(() => scrollTo(0, 0));
    await c.snap();
    await page.click('.summary li.line:first-child button.icon-btn');
    await sleep(200);
    check(`${c.name}/checkout: removing an item updates the list, the total and the pay button`, (await count(page, '.summary li.line')) === 1 && (await text(page, 'button.pay-btn')).includes((((total(c) - two(c)[0].price_cents) / 100).toFixed(2))), await text(page, 'button.pay-btn'));
  });

  const pay = (key, spec, probe) =>
    add(key, false, async (c) => {
      const { page } = c;
      await open(c, '#/checkout', { st: ckSt(c), mocks: { 'POST /api/checkout': typeof spec === 'function' ? spec(c) : spec } });
      await tapText(page, /with PayPal$/);
      await probe(c);
      if (key === 'checkout-error-upstream') await c.audit('checkout error');
      await c.snap();
      if (key.startsWith('checkout-error-')) {
        const n = await backLinksWithoutHas(page);
        check(`${c.name}/checkout: ${key.replace('checkout-error-', '')}: with no :has() support (rule dropped, @supports fallback applied) there is still exactly one "Back to ideas"`, n === 1, `${n} visible`);
      }
    });
  pay('checkout-loading', { hang: true }, async (c) => {
    await c.page.waitForSelector('button.pay-btn[aria-busy="true"]', { timeout: 5000 });
    check(`${c.name}/checkout: while the order is created the button is busy and disabled, and a status line says so`, (await c.page.$eval('button.pay-btn', (e) => e.disabled)) && /Creating your order/.test(await text(c.page, '.pay-status')) && /Opening PayPal/.test(await text(c.page, 'button.pay-btn')));
  });
  pay('checkout-mismatch', (c) => ({ json: { orderId: ORDER_ID, approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`, total_cents: total(c) + 500, lines: two(c).map((x, i) => ({ id: x.id, title: x.title, shop: x.shop, price_cents: x.price_cents + (i === 0 ? 500 : 0) })), reused: false, sandbox: true } }), async (c) => {
    await c.page.waitForSelector('.note.warn', { timeout: 5000 });
    const money = (n) => `$${(n / 100).toFixed(2)}`;
    const note = (await text(c.page, '.note.warn')) || '';
    check(`${c.name}/checkout: a different server total is explained before leaving, naming both amounts`, note.includes(money(total(c) + 500)) && note.includes(money(total(c))) && /server/i.test(note), note);
    check(`${c.name}/checkout: the list, the Total row and the button all show the server's price, so nothing contradicts the note`, (await text(c.page, 'dl.totals .row.total')).includes(money(total(c) + 500)) && (await text(c.page, '.summary li.line:first-child .line-price')) === money(two(c)[0].price_cents + 500) && (await text(c.page, 'button.pay-btn')) === `Pay ${money(total(c) + 500)} with PayPal`, `${await text(c.page, 'dl.totals .row.total')} / ${await text(c.page, 'button.pay-btn')}`);
    check(`${c.name}/checkout: the button label stays on one line`, await c.page.$eval('button.pay-btn', (e) => e.getBoundingClientRect().height < 80));
  });
  // When paying again can work, the Pay button stays the one filled button and the banner has outline buttons only;
  // when it cannot, Pay is switched off (with a line saying why) and the banner has exactly one filled button.
  const backLinks = (page) => page.$$eval('.checkout a', (l) => l.filter((a) => /Back to ideas/.test(a.textContent) && a.getClientRects().length).length);
  const payError = (key, spec, title, actions, filled) =>
    pay(key, spec, async (c) => {
      await c.page.waitForSelector('section.panel.bad[role=alert]', { timeout: 5000 });
      const got = await actionsOf(c.page, 'section.panel.bad .panel-actions');
      const body = (await text(c.page, 'section.panel.bad .panel-body p')) || '';
      const payOff = await c.page.$eval('button.pay-btn', (e) => e.disabled);
      const backs = await backLinks(c.page);
      check(`${c.name}/checkout: ${key.replace('checkout-error-', '')}: one "Back to ideas" on the screen, not two`, backs === 1, `${backs} visible`);
      check(`${c.name}/checkout: ${key.replace('checkout-error-', '')}: title "${title}" and actions ${actions.join(', ')}`, (await text(c.page, 'section.panel.bad h2')) === title && got.names.join('|') === actions.join('|'), `${await text(c.page, 'section.panel.bad h2')} / ${got.names.join(', ')}`);
      check(`${c.name}/checkout: ${key.replace('checkout-error-', '')}: ${filled ? `one filled button ("${filled}") and Pay is switched off with a reason` : 'Pay stays the one filled button and stays on'}; the message does not repeat the title`, got.filled.join('|') === (filled || '') && payOff === !!filled && (!filled || (await text(c.page, '.pay-status')).startsWith('Paying is off')) && body.length > 10 && !body.toLowerCase().includes(title.toLowerCase()), `${got.filled.join(',')} / pay off ${payOff} / ${body}`);
    });
  payError('checkout-error-upstream', err(502, 'upstream', UPSTREAM_MSG), 'PayPal is not answering', ['Try again', 'Back to ideas'], '');
  // Over budget: the page counts for itself first (Pay is off, the numbers say by how much); the server can still refuse, and removing items clears it.
  add('checkout-error-over-budget', false, async (c) => {
    const { page } = c;
    const three = purchasable(c.done).slice(0, 3);
    const sum = three.reduce((a, x) => a + x.price_cents, 0);
    const dear = [...three].sort((a, b) => b.price_cents - a.price_cents);
    await open(c, '#/checkout', { st: withRun(c.done, { budget_cents: sum - 500, selected: three.map((x) => x.id) }) });
    const got = await actionsOf(page, 'section.panel.bad .panel-actions');
    const over = (await text(page, 'dl.totals .row.over')) || '';
    check(`${c.name}/checkout: over budget: one "Back to ideas" on the screen, not two`, (await backLinks(page)) === 1);
    check(`${c.name}/checkout: over budget (counted on the page): the banner, the "Over budget by" row and the Pay button agree`, (await text(page, 'section.panel.bad h2')) === 'That is over your budget' && over.includes('$5.00') && (await text(page, 'section.panel.bad .panel-body p')).includes('$5.00') && got.names.join('|') === 'Back to ideas' && got.filled.join('|') === 'Back to ideas' && (await page.$eval('button.pay-btn', (e) => e.disabled)) && (await text(page, '.pay-status')) === 'Paying is off until the gift fits your budget.', `${over} / ${got.names.join(', ')}`);
    await c.audit('checkout over budget');
    await c.snap();
    await page.click(`.summary li.line:nth-child(${three.findIndex((x) => x.id === dear[0].id) + 1}) button.icon-btn`);
    await sleep(200);
    check(`${c.name}/checkout: removing the dearest item clears the over-budget banner and switches Pay on`, dear[0].price_cents >= 500 && (await count(page, 'section.panel.bad')) === 0 && !(await page.$eval('button.pay-btn', (e) => e.disabled)) && (await text(page, '.pay-status')) === '', `removed ${dear[0].price_cents} cents`);
    // the server can still refuse (its own count wins): Pay stays off until something is removed
    await mock(page, 'POST /api/checkout', err(422, 'over_budget', 'The server counts more than your budget allows. Remove an item or pick cheaper ones.'));
    await tapText(page, /with PayPal$/);
    await page.waitForSelector('section.panel.bad[role=alert]', { timeout: 5000 });
    const refused = await actionsOf(page, 'section.panel.bad .panel-actions');
    check(`${c.name}/checkout: when the server refuses a total, Pay is off with a reason and "Back to ideas" is the one filled button`, (await page.$eval('button.pay-btn', (e) => e.disabled)) && refused.filled.join('|') === 'Back to ideas' && /^Paying is off/.test(await text(page, '.pay-status')));
    const noHas = await backLinksWithoutHas(page);
    check(`${c.name}/checkout: over budget: with no :has() support there is still exactly one "Back to ideas"`, noHas === 1, `${noHas} visible`);
    await page.click('.summary li.line:first-child button.icon-btn');
    await sleep(200);
    check(`${c.name}/checkout: removing an item clears a refusal that removing can fix`, (await count(page, 'section.panel.bad')) === 0 && !(await page.$eval('button.pay-btn', (e) => e.disabled)), `${await count(page, '.summary li.line')} item left`);
  });
  payError('checkout-error-session', err(404, 'session_expired', 'The saved prices are gone, so this gift cannot be ordered. Start over, or try the example.'), 'Your session expired', ['Start over', 'Try an example'], 'Start over');
  payError('checkout-error-network', { reject: true }, 'We could not reach the server', ['Try again', 'Back to ideas'], '');

  add('checkout-cancelled', false, async (c) => {
    await open(c, '#/checkout?cancelled=1', { st: ckSt(c) });
    check(`${c.name}/checkout: after cancelling on PayPal the page says nothing was charged and keeps the gift`, /nothing was charged/.test((await text(c.page, '.note.info')) || '') && (await count(c.page, '.summary li.line')) === 2, await text(c.page, '.note.info'));
    await c.snap();
  });

  add('receipt-loading', false, async (c) => {
    await open(c, '#/', { st: c.done, mocks: { [`GET /api/orders/${ORDER_ID}`]: { hang: true } } });
    await c.page.evaluate((h) => { location.hash = h; }, `#/receipt/${ORDER_ID}`);
    await sleep(400);
    check(`${c.name}/receipt: while loading it says so, shows a placeholder and does not tick the last step`, (await text(c.page, 'h1')) === 'Getting your receipt' && (await count(c.page, '.sk-card')) === 1 && (await count(c.page, '#steps li.done')) === 2 && (await text(c.page, '#steps li.current')).startsWith('3'));
    await c.snap();
  });
  // built lazily: they need c.done for the item lines
  const DECLINED = 'The card was declined. Go back to checkout and use the sandbox test card.';
  S.push({ key: 'receipt-completed', tablet: true, build: (c) => receipt(c, 'receipt-completed', 'COMPLETED', {}, 'Order confirmed', { filled: 'Start a new gift' }) });
  S.push({ key: 'receipt-capture-failed', tablet: false, build: (c) => receipt(c, 'receipt-capture-failed', 'CAPTURE_FAILED', { error: DECLINED }, 'Payment not completed', { filled: 'Check and try again', banner: DECLINED }) });
  S.push({ key: 'receipt-not-approved', tablet: false, build: (c) => receipt(c, 'receipt-not-approved', 'NOT_APPROVED', { error: 'The payment was not approved on PayPal yet.' }, 'Payment not approved yet', { gift: true, filled: 'Back to checkout' }) });
  S.push({ key: 'receipt-created', tablet: false, build: (c) => receipt(c, 'receipt-created', 'CREATED', {}, 'Waiting for your approval on PayPal', { filled: 'I approved it, check again' }) });
  S.push({ key: 'receipt-cancelled', tablet: false, build: (c) => receipt(c, 'receipt-cancelled', 'CANCELLED', {}, 'Payment cancelled', { filled: 'Start a new gift' }) });

  add('receipt-not-found', false, async (c) => {
    await open(c, '#/', { st: c.done, mocks: { [`GET /api/orders/${ORDER_ID}`]: err(404, 'not_found', 'Order not found.') } });
    await c.page.evaluate((h) => { location.hash = h; }, `#/receipt/${ORDER_ID}`);
    await c.page.waitForFunction(() => document.querySelector('h1')?.textContent !== 'Getting your receipt', { timeout: 8000 });
    const acts = await actionsOf(c.page, '.receipt-actions');
    check(`${c.name}/receipt: an unknown order says so, offers a new start as the one filled button, and the last step is not ticked`, (await text(c.page, 'h1')) === 'We could not find that order' && acts.names.join('|') === 'Start a new gift' && acts.filled.join('|') === 'Start a new gift' && (await count(c.page, '#steps li.done')) === 2, await text(c.page, 'h1'));
    await c.snap();
  });
  add('receipt-error', false, async (c) => {
    await open(c, '#/', { st: c.done, mocks: { [`GET /api/orders/${ORDER_ID}`]: { reject: true } } });
    await c.page.evaluate((h) => { location.hash = h; }, `#/receipt/${ORDER_ID}`);
    await c.page.waitForFunction(() => document.querySelector('h1')?.textContent !== 'Getting your receipt', { timeout: 8000 });
    const acts = await actionsOf(c.page, '.receipt-actions');
    check(`${c.name}/receipt: a network failure says so, with Try again as the one filled button and a plain reason under the heading`, (await text(c.page, 'h1')) === 'We could not load your receipt' && acts.names.join('|') === 'Try again|Start a new gift' && acts.filled.join('|') === 'Try again' && (await text(c.page, '.receipt-card .lead')) === 'Check your connection and try again.', `${acts.names.join(', ')} / ${await text(c.page, '.receipt-card .lead')}`);
    await c.snap();
  });

  S.push({ key: 'ideas-live', tablet: true, live: true, run: async (c) => { await open(c, '#/ideas', { st: c.liveRun }); await c.audit('ideas live'); await c.snap(); } });
  S.push({ key: 'checkout-live', tablet: true, live: true, run: async (c) => { await open(c, '#/checkout', { st: c.liveRun }); await c.audit('checkout live'); await c.snap(); } });
  // The same checkout with the photos hidden: the before/after pictures in evidence/ are made from this (shop photos are third-party and stay out of tracked files).
  add('checkout-images-off', false, async (c) => {
    await open(c, '#/checkout', { st: ckSt(c), search: '?images=off' });
    const shown = await c.page.evaluate(() => [...document.querySelectorAll('.thumb img')].filter((i) => i.getClientRects().length && getComputedStyle(i).display !== 'none').length);
    check(`${c.name}/checkout: ?images=off hides the line photos`, (await text(c.page, 'h1')) === 'Checkout' && shown === 0, `${shown} shown`);
    await c.snap();
  });
  return S;
}

// ---- behaviours that are not a single screen ----------------------------------------------------------------------------
async function journeys(c, fx) {
  const { page } = c;
  say(`  journeys (${c.name})`);
  // 1. keyboard only: first screen -> ideas -> pick -> checkout
  const key = 'POST /api/ideas';
  await fresh(page);
  await mock(page, key, { events: fx.live });
  const tabTo = async (pred, arg, max = 120) => {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(pred, arg)) return true;
    }
    return false;
  };
  const gotInput = await tabTo((id) => document.activeElement?.id === id, 'fav-input', 20);
  for (const f of fx.FAVS.slice(0, 3)) {
    await page.keyboard.type(f.text);
    await page.keyboard.press(f === fx.FAVS[1] ? 'Comma' : 'Enter');
  }
  check(`${c.name}/keyboard: Tab reaches the favourites field; Enter and comma add chips`, gotInput && (await count(page, 'ul.chips li.chip')) === 3, `${await count(page, 'ul.chips li.chip')} chips`);
  const gotBudget = await tabTo((id) => document.activeElement?.id === id, 'budget', 30);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.type('120');
  await page.keyboard.press('Enter');
  const started = await hashIs(page, '#/ideas').then(() => true, () => false);
  check(`${c.name}/keyboard: Tab reaches the budget; Enter in it submits`, gotBudget && started);
  if (started) {
    await release(page, key, fx.live.length);
    await until(page, () => /Done in/.test(document.querySelector('.agent-status')?.textContent || ''), null, 20000);
    const gotPick = await tabTo(() => document.activeElement?.matches('button.pick') && /^Add to gift/.test(document.activeElement.getAttribute('aria-label') || ''), null, 200);
    await page.keyboard.press('Enter');
    await sleep(150);
    check(`${c.name}/keyboard: a product card can be reached and picked with Tab and Enter`, gotPick && (await count(page, 'ul.cards li.card[data-selected="true"]')) === 1);
    const gotReview = await tabTo(() => document.activeElement?.matches('.bar .btn.primary'), null, 200);
    await page.keyboard.press('Enter');
    const atCheckout = await hashIs(page, '#/checkout').then(() => true, () => false);
    await until(page, () => document.activeElement?.tagName === 'H1', null, 3000).catch(() => {}); // the hash changes before the router's hashchange handler runs
    const active = await page.evaluate(() => document.activeElement?.tagName);
    check(`${c.name}/keyboard: "Review and pay" opens checkout and moves focus to its heading`, gotReview && atCheckout && active === 'H1', `reached ${gotReview}, checkout ${atCheckout}, focus on ${active}`);
    // 2. browser back and forward keep the picks
    await page.goBack();
    await hashIs(page, '#/ideas').catch(() => {});
    await sleep(300);
    check(`${c.name}/history: Back from checkout returns to the ideas with the pick kept`, (await text(page, 'h1')) === 'Gift ideas' && (await count(page, 'ul.cards li.card[data-selected="true"]')) === 1, await page.evaluate(() => location.hash));
    await page.goForward();
    await hashIs(page, '#/checkout').catch(() => {});
    check(`${c.name}/history: Forward returns to checkout`, (await text(page, 'h1')) === 'Checkout');
  }
  // 3. a reload during a run cannot resume it: back to the first screen, favourites kept (typed through the UI, so the app's own save is tested)
  await fresh(page);
  await mock(page, key, { events: fx.live, close: false });
  for (const f of fx.FAVS.slice(0, 3)) await addChip(page, f);
  await setBudget(page, 120);
  await tapText(page, /^Find gift ideas$/);
  await release(page, key, 3);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('h1');
  await sleep(300);
  check(`${c.name}/reload: reloading during a run returns to the first screen and keeps the favourites`, (await text(page, 'h1')) === 'Gifts that understand them' && (await count(page, 'ul.chips li.chip')) === 3, `${await text(page, 'h1')}, ${await count(page, 'ul.chips li.chip')} chips`);
}

/** Runs the whole tour in one viewport. `round` = { name, vp, full, sweep, clip }. */
export async function tourRound(browser, round, sample, liveRun) {
  const fx = fixtures(sample);
  const ctx = await browser.createBrowserContext();
  if (round.clip) await ctx.overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);
  const page = await newPage(ctx, round.vp, round.name);
  const list = states(fx);
  const c = { page, name: round.name, sweep: round.sweep, clip: round.clip, done: null, liveRun, stream: null };
  say(`TOUR ${round.name} ${round.vp.width}x${round.vp.height}: ${round.full ? 'every state' : 'key screens'}`);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if ((!round.full && !s.tablet) || (s.live && !liveRun)) continue;
    if (process.env.TOUR_STATES && !process.env.TOUR_STATES.split(',').includes(s.key)) continue; // debugging aid: run only these states
    c.audit = (label) => audit(page, `${round.name}/${label}`);
    c.snap = () => shot(page, `${String(i + 1).padStart(2, '0')}-${s.key}`, s.live ? LIVE_SHOTS : undefined);
    const step = s.build ? s.build(c) : s;
    try {
      if (!c.done && !['home-empty', 'home-filled', 'home-error-favs', 'home-error-budget', 'ideas-running-early', 'ideas-running-mid', 'ideas-error-partial', 'ideas-example'].includes(s.key)) throw new Error('needs the example run first');
      await step.run(c);
    } catch (e) {
      check(`${round.name}/${s.key}: state completed without an unexpected error`, false, String(e.message).slice(0, 160));
      try { fs.mkdirSync(LIVE_DIR, { recursive: true }); await page.screenshot({ path: path.join(LIVE_DIR, `crash-${round.name}-${s.key}.png`) }); } catch {}
    }
  }
  if (round.full && c.done) {
    try { await journeys(c, fx); } catch (e) { check(`${round.name}/journeys completed without an unexpected error`, false, String(e.message).slice(0, 160)); }
  }
  await ctx.close();
}
