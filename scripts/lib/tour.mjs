// The state tour: every screen and every error, empty and rare state of the app at 1280 and 390 px (key screens also at 768 px),
// as screenshots in evidence/screens/ plus accessibility, focus, layout-shift and overflow checks. The two states drawn from a live run
// (ideas-live, checkout-live) and any crash picture go to the capture folder outside the repo (scripts/lib/live.mjs), never into evidence/.
// The happy path and the example run use the real server. Rare states (API down, over budget, PayPal cancelled, capture failed, ...)
// are produced by answering the app's own fetch calls inside the page (see pagePatch in browser.mjs), so no real service is touched.
import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE } from '../../public/example.js';
import { LIVE_DIR, LIVE_SHOTS } from './live.mjs';
import { BASE, FIREFOX, audit, check, cls, fresh, mock, newPage, overflowSweep, release, sandboxMentions, say, shot, sleep, tabWalk } from './browser.mjs';

const KEY = 'tasteloom.v1';
const UPSTREAM_MSG = 'Please try again in a minute.'; // the texts the server sends (src/app.ts, src/commerce.ts)
const LIMIT_MSG = 'You have reached today’s allowance for live lookups. The saved example still works, or come back tomorrow.';
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
  // What the server sends when the shop search (channel3) or the web search (tavily) is over its daily cap (src/agent/ideas.ts): the idea stays,
  // flagged, with no cards. `shopFrom` = how many product ideas still found their items before the shop cap; `web` = place ideas lose their links.
  const capped = (events, { shopFrom = Infinity, web = false }) => {
    let products = 0;
    const gone = new Set();
    return events
      .map((e) => {
        if (e.t !== 'idea') return e;
        const counter = e.idea.kind === 'experience' ? (web ? 'tavily' : null) : ++products > shopFrom ? 'channel3' : null;
        if (!counter) return e;
        e.cards.forEach((card) => gone.add(card.id));
        return { ...e, idea: { ...e.idea, cardIds: [], paused: counter }, cards: [] };
      })
      .filter((e) => e.t !== 'check' || !gone.has(e.cardId));
  };
  const ended = (limited) => (e) => (e.t === 'done' ? { t: 'done', tier: 'agent', limited } : e);
  return {
    FAVS,
    live,
    firstIdea: nth('idea', 1),
    secondIdea: nth('idea', 2),
    // stops right after the second idea: the later steps never ran, so the step list must not look finished
    partial: [...live.slice(0, nth('idea', 2) + 1), { t: 'error', code: 'upstream', message: UPSTREAM_MSG }],
    // the model's daily allowance was used up (or it did not answer): the run still finishes, with fixed steps and template reasons
    noModel: live.map((e) => (e.t === 'done' ? { t: 'done', tier: 'template' } : e)),
    // shop search ran out after the first product idea: the later product ideas come from Qloo alone, without buy buttons
    limited: capped(live, { shopFrom: 1 }).map(ended(['channel3'])),
    // both searches were over their cap from the start: every idea is kept, nothing can be bought, so there is no Review and pay bar
    limitedAll: capped(live, { shopFrom: 0, web: true }).map(ended(['channel3', 'tavily'])),
    // web search was over its cap: the buy buttons stay, their price checks say they were paused, the place idea has no links
    limitedWeb: capped(live, { web: true }).map((e) => (e.t === 'check' ? { t: 'check', cardId: e.cardId, state: 'paused' } : ended(['tavily'])(e))),
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
    const lede = await page.evaluate(() => {
      const [h1, p, lead] = ['h1', '.principle', '.taste .lead'].map((q) => document.querySelector(q));
      const before = (a, b) => !!(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { text: p?.textContent.trim(), order: before(h1, p) && before(p, lead), count: document.querySelectorAll('.principle').length };
    });
    check(`${c.name}/home: one principle line sits right under the heading, before the lead`, lede.text === 'No age, no gender, no account: only what they love.' && lede.order && lede.count === 1, JSON.stringify(lede));
    const form = await page.$eval('form', (f) => ({ ids: [...f.querySelectorAll('input:not([readonly]), select, textarea:not([readonly])')].map((e) => e.id).sort().join(), words: [...f.querySelectorAll('label')].map((l) => l.textContent).concat([...f.querySelectorAll('[placeholder]')].map((e) => e.getAttribute('placeholder'))).join(' | ') }));
    check(`${c.name}/home: the principle is true of the form: its only fields are the favourites (name, type) and the budget, and no label asks for an age, gender, account or email`, form.ids === 'budget,fav-input,fav-type' && !/\b(age|gender|sex|birth\w*|relationship|account|e-?mail|password)\b/i.test(form.words), `${form.ids}; ${form.words}`);
    const own = await page.$$eval('a[href="/ask?for=me"]', (l) => l.map((a) => `${a.textContent.trim()}|${a.closest('form') ? 'in the form' : 'outside the form'}`));
    check(`${c.name}/home: one small link "Make your own taste link" to /ask?for=me, outside the form`, own.join() === 'Make your own taste link|outside the form', own.join());
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

  // "Run a live example": the fixed set is posted like a typed run, the page says it is the example set (also after an error), and "Try again" posts the same set
  add('home-live-example', true, async (c) => {
    const { page } = c;
    const key = 'POST /api/ideas';
    const body = JSON.stringify({ favorites: EXAMPLE.favorites, budget_usd: EXAMPLE.budget });
    const events = fx.live.map((e) => (e.t === 'meta' ? { ...e, favorites: EXAMPLE.favorites, budget_cents: EXAMPLE.budget * 100 } : e));
    await open(c, '#/', { mocks: { [key]: { events: [events[0], { t: 'error', code: 'upstream', message: UPSTREAM_MSG }] } } });
    await page.evaluate(() => { // what the page posts, recorded on top of the scripted fetch
      window.__posted = [];
      const f = window.fetch;
      window.fetch = (i, init) => { if (init && init.body) window.__posted.push(String(init.body)); return f(i, init); };
    });
    const ways = await page.$$eval('#ask-btn, form .actions button, .hint button', (l) => l.map((b) => b.textContent.trim()));
    check(`${c.name}/home: the ways in are all named: Ask them, Find gift ideas, Run a live example and Replay the saved example`, ways.join('|') === 'Ask them|Find gift ideas|Run a live example|Replay the saved example', ways.join('|'));
    check(`${c.name}/home: the lead names both ways to start`, /three to five things they love, or send them a link and let them tell you/.test((await text(page, '.taste .lead')) || ''));
    await tapText(page, /^Run a live example$/);
    await release(page, key, 2);
    await until(page, () => !!document.querySelector('section.panel.bad, section.panel.warn'), null, 8000);
    const posts = await page.evaluate(() => window.__posted);
    check(`${c.name}/home: "Run a live example" posts the fixed example set and its budget, like a typed run`, posts.length === 1 && posts[0] === body, posts[0]);
    const acts = await page.$$eval('section.panel .panel-actions .btn', (l) => l.map((b) => b.textContent.trim()));
    check(`${c.name}/ideas: when the example run fails, the saved example is offered first, Try again second, and the page still says it is the example set`, acts.join('|') === 'Replay the saved example|Try again' && /^Example set\./.test((await text(page, '.example-note')) || ''), `${acts.join('|')} / ${await text(page, '.example-note')}`);
    await mock(page, key, { events });
    await tapText(page, /^Try again$/);
    await release(page, key, fx.firstIdea + 1);
    await sleep(500);
    const after = await page.evaluate(() => ({
      posts: window.__posted,
      pills: [...document.querySelectorAll('.loves .pill-soft')].map((p) => p.textContent.trim()).join('|'),
      budget: document.querySelector('.loves .budget')?.textContent.trim(),
      notes: [...document.querySelectorAll('.example-note')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    }));
    check(`${c.name}/ideas: "Try again" posts the same example set again`, after.posts.length === 2 && after.posts[1] === body, `${after.posts.length} posts`);
    check(`${c.name}/ideas: the page shows the example favourites and budget, and one note saying they were picked for the demo, not typed, and that the search is a normal one`,
      after.pills === EXAMPLE.favorites.map((f) => f.text).join('|') && after.budget === `Budget $${EXAMPLE.budget}.00` && after.notes.length === 1 && /^Example set\. The favourites and the budget above were picked for this demo, not typed by you\. The search is a normal one, within the same daily limits as any other\.$/.test(after.notes[0]), `${after.pills} / ${after.budget} / ${after.notes.join(' // ')}`);
    await c.audit('ideas live example');
    await c.snap();
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForSelector('#fav-input');
    check(`${c.name}/home: back on the first screen the example favourites are filled in, ready to change`, (await page.$$eval('ul.chips li.chip', (l) => l.length)) === EXAMPLE.favorites.length && (await page.$eval('#budget', (e) => Number(e.value))) === EXAMPLE.budget);
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
    check(`${c.name}/ideas: stopping early keeps the ideas, says so, and offers to try again`, (await text(page, 'section.panel.warn h2')) === 'The agent stopped early' && (await count(page, '.ideas-list article.idea:not(.skeleton)')) >= 2 && acts.names.join('|') === 'Replay the saved example|Try again', `${await text(page, 'section.panel.warn h2')} / ${acts.names.join(', ')}`); // a service is down: the saved example comes first (75bb9a0)
    check(`${c.name}/ideas: stopping early has no filled button (the Review and pay bar stays the main action) and its text does not say "try again" twice`, acts.filled.length === 0 && !/try again/i.test(body) && body.length > 20, `${acts.filled.join(',')} / ${body}`);
    check(`${c.name}/ideas: no placeholder is left spinning after the error`, (await count(page, '.idea.skeleton')) === 0 && (await count(page, '.phases li.phase[data-state=running]')) === 0);
    check(`${c.name}/ideas: the step list tells the truth (unfinished steps are not ticked) and the status says Stopped`, (await count(page, '.phases li.phase[data-state=done]')) < (await count(page, '.phases li.phase')) && (await count(page, '.phases li.phase[data-state=error]')) >= 1 && (await text(page, '.agent-status')) === 'Stopped', await text(page, '.agent-status'));
    check(`${c.name}/ideas: the error card is in the first screens, not below an opened trace`, (await page.$eval('section.panel.warn', (e) => e.getBoundingClientRect().top + scrollY)) < 1100 && (await page.$eval('.agent', (e) => e.dataset.open)) === String(await page.evaluate(() => matchMedia('(min-width: 1000px)').matches)));
    await c.audit('ideas partial');
    await c.snap();
    // a reload while a run is in progress cannot resume it: back to the first screen with the favourites still there
  });

  // gifts before experiences (addIdea in public/ideas.js): the first idea's first card has an Add button, and the ideas read gifts then experiences (an article with no data-kind fails)
  const giftsFirst = (page) => page.$$eval('.ideas-list article.idea:not(.skeleton)', (l) => l.length > 0 && /^Add to gift/.test(l[0].querySelector('li.card button.pick')?.getAttribute('aria-label') || '') && /^(product,)+(experience,)*$/.test(l.map((e) => e.dataset.kind + ',').join('')));

  add('ideas-example', true, async (c) => {
    const { page } = c;
    await fresh(page);
    await cls(page, true);
    await tapText(page, /^Replay the saved example$/);
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
    check(`${c.name}/ideas: gifts come first: the first card has an "Add to gift" button and no gift idea comes after an experience`, await giftsFirst(page));
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
    check(`${c.name}/ideas: a restored run has the same order: gifts first, the first card has an "Add to gift" button`, await giftsFirst(page));
    check(`${c.name}/ideas: "Review and pay" is disabled until something is picked`, await page.$eval('.bar .btn.primary', (e) => e.disabled || e.getAttribute('aria-disabled') === 'true'));
    const k = await pickCards(page, 2);
    await sleep(200);
    const now = await page.$eval('.bar div.meter[role=meter]', (e) => Number(e.getAttribute('aria-valuenow'))).catch(() => NaN);
    check(`${c.name}/ideas: two picks update the card state, the bar count and the budget meter`, k === 2 && (await count(page, 'ul.cards li.card[data-selected="true"]')) === 2 && /2/.test((await text(page, '.bar-count')) || '') && now > 0, `${await text(page, '.bar-count')}, meter ${now}`);
    check(`${c.name}/ideas: "Review and pay" is now enabled`, !(await page.$eval('.bar .btn.primary', (e) => e.disabled)));
    await c.snap();
    check(`${c.name}/ideas: the picks survive a reload`, await (async () => { await page.reload({ waitUntil: 'load' }); await page.waitForSelector('ul.cards'); return (await count(page, 'ul.cards li.card[data-selected="true"]')) === 2; })());
  });

  add('ideas-evidence', true, async (c) => {
    const { page } = c;
    // Invented numbers and tags: a card shows exactly what its idea event carries from Qloo, and nothing when the event carries nothing.
    const extra = [{ shares: [62, 25, 13], shared: ['Calm', 'Jazz'] }, { shares: [100, 0], shared: [] }, {}];
    const ideas = c.done.run.ideas.map((x, i) => ({ ...x, idea: { ...x.idea, because: ['Nujabes', 'Muji', 'Kafka on the Shore'].slice(0, i === 2 ? 1 : 3), ...(extra[i] ?? {}) } }));
    await open(c, '#/ideas', { st: { ...c.done, run: { ...c.done.run, ideas } } });
    await page.waitForSelector('article.idea .evidence');
    const rows = await page.$$eval('article.idea:not(.skeleton)', (l) => l.map((a) => [...a.querySelectorAll('.evidence')].map((e) => e.textContent)));
    const entity = ideas[0].idea.entity.name;
    check(`${c.name}/ideas: a card shows how Qloo splits its link by favourite (adding up to 100%) and the tags Qloo gives both`, rows[0]?.length === 2 && rows[0][0] === 'How Qloo splits its link to this idea (adds up to 100%): 62% Nujabes · 25% Muji · 13% Kafka on the Shore' && rows[0][1] === `Tags Qloo gives to both Nujabes and ${entity}: Calm · Jazz`, JSON.stringify(rows[0]));
    check(`${c.name}/ideas: a split with one favourite left shows nothing, and neither does an idea that carries no Qloo evidence`, rows[1]?.length === 0 && rows[2]?.length === 0, JSON.stringify(rows.slice(1, 3)));
    check(`${c.name}/ideas: the evidence is quieter than the reason`, await page.$eval('article.idea', (a) => parseFloat(getComputedStyle(a.querySelector('.evidence')).fontSize) < parseFloat(getComputedStyle(a.querySelector('.reason')).fontSize)));
    await c.audit('ideas evidence');
    await c.snap();
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

  const ideasError = (key, label, spec, title, buttons, filled, ends = '') =>
    add(key, key === 'ideas-error-limit', async (c) => {
      const { page } = c;
      await open(c, '#/', { st: { favorites: fx.FAVS, budget: 120 }, mocks: { 'POST /api/ideas': spec } });
      await tapText(page, /^Find gift ideas$/);
      await page.waitForSelector('section.panel[role=alert]', { timeout: 8000 });
      await sleep(300);
      const got = await actionsOf(page, 'section.panel[role=alert] .panel-actions');
      const body = (await text(page, 'section.panel[role=alert] .panel-body p')) || '';
      check(`${c.name}/ideas: ${label}: title "${title}" with a plain message and the actions ${buttons.join(', ')}`, (await text(page, 'section.panel[role=alert] h2')) === title && got.names.join('|') === buttons.join('|') && (await count(page, '.idea.skeleton')) === 0, `${await text(page, 'section.panel[role=alert] h2')} / ${got.names.join(', ')}`);
      check(`${c.name}/ideas: ${label}: one filled button ("${filled}") and a message that does not repeat the title${ends ? ` and ends with "${ends}"` : ''}`, got.filled.join('|') === filled && body.length > 10 && !body.toLowerCase().includes(title.toLowerCase()) && body.endsWith(ends), `${got.filled.join(',')} / ${body}`);
      check(`${c.name}/ideas: ${label}: the status row says Stopped, in the same red as the card icon`, (await text(page, '.agent-status')) === 'Stopped' && (await page.evaluate(() => getComputedStyle(document.querySelector('.agent-status svg')).color === getComputedStyle(document.querySelector('section.panel.bad .panel-icon')).color)), await text(page, '.agent-status'));
      if (key === 'ideas-error-limit') await c.audit('ideas error');
      await c.snap();
    });
  ideasError('ideas-error-network', 'server unreachable', { reject: true }, 'We could not reach the server', ['Try again', 'Replay the saved example'], 'Try again');
  ideasError('ideas-error-limit', 'daily limit reached', err(429, 'limit', LIMIT_MSG), 'Live lookups are used up for now', ['Replay the saved example'], 'Replay the saved example');
  ideasError('ideas-error-upstream', 'a service is down', err(502, 'upstream', UPSTREAM_MSG), 'A service we depend on is not answering', ['Replay the saved example', 'Try again'], 'Replay the saved example', 'The saved example always works.');
  ideasError('ideas-error-bad-input', 'input refused by the server', err(400, 'bad_input', 'Nothing we found fits that budget. Try a higher budget or different favourites.'), 'Nothing to suggest yet', ['Change favourites', 'Replay the saved example'], 'Change favourites');

  add('ideas-empty', false, async (c) => {
    const { page } = c;
    await open(c, '#/', { st: { favorites: fx.FAVS, budget: 50 }, mocks: { 'POST /api/ideas': { events: fx.empty } } });
    await tapText(page, /^Find gift ideas$/);
    await release(page, 'POST /api/ideas', fx.empty.length);
    await page.waitForFunction(() => /No ideas to show/.test(document.body.textContent), { timeout: 8000 });
    const acts = await actionsOf(page, 'section.panel .panel-actions');
    check(`${c.name}/ideas: no results gives an explanation and two ways forward, one of them filled`, acts.names.join('|') === 'Change favourites|Replay the saved example' && acts.filled.join('|') === 'Change favourites', acts.names.join(', '));
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

  /** Plays one scripted run to its end and returns the header note. */
  const playLimited = async (c, events) => {
    const { page } = c;
    await open(c, '#/', { st: { favorites: fx.FAVS, budget: 120 }, mocks: { 'POST /api/ideas': { events } } });
    await tapText(page, /^Find gift ideas$/);
    await release(page, 'POST /api/ideas', events.length);
    await page.waitForSelector('.tier-note', { timeout: 8000 });
    return (await text(page, '.tier-note')) || '';
  };
  const readyReasons = (page) => count(page, '.reason[data-state=ready]');

  add('ideas-limited', false, async (c) => {
    const { page } = c;
    const t = await playLimited(c, fx.limited);
    check(`${c.name}/ideas: when shop search ran out mid-run, a plain note says it is paused until 00:00 UTC and the example still works`, /Shop search is paused until 00:00 UTC/.test(t) && /saved example always works/.test(t) && !/Web search/.test(t), t.slice(0, 120));
    check(`${c.name}/ideas: the product ideas after the cap say "No buy button", keep their reasons, and the first idea keeps its buy buttons and the Review and pay bar`, (await count(page, '.idea .note.paused')) === 2 && /No buy button: shop search is paused until 00:00 UTC/.test((await text(page, '.idea .note.paused')) || '') && (await count(page, 'ul.cards li.card button.pick')) === 3 && (await shown(page, '.bar')) && (await readyReasons(page)) === (await count(page, '.ideas-list .idea:not(.skeleton)')), `${await count(page, '.idea .note.paused')} paused, ${await count(page, 'button.pick')} buy buttons`);
    await c.snap();
  });

  add('ideas-limited-all', true, async (c) => {
    const { page } = c;
    const t = await playLimited(c, fx.limitedAll);
    check(`${c.name}/ideas: with both searches over their cap, the note says so for each and the example still works`, /Shop search is paused until 00:00 UTC/.test(t) && /Web search is paused until 00:00 UTC/.test(t) && /saved example always works/.test(t), t.slice(0, 120));
    const notes = await page.$$eval('.idea .note.paused', (l) => l.map((e) => e.textContent.trim()));
    check(`${c.name}/ideas: every idea stays with its reason and says what is paused (three "No buy button", one "No links"); nothing can be bought, so no buy buttons and no Review and pay bar`, notes.filter((n) => /^No buy button: shop search is paused until 00:00 UTC\.$/.test(n)).length === 3 && notes.filter((n) => /^No links: web search is paused until 00:00 UTC\.$/.test(n)).length === 1 && (await readyReasons(page)) === 4 && (await count(page, 'button.pick')) === 0 && !(await shown(page, '.bar')), `${notes.length} notes, ${await count(page, 'button.pick')} buy buttons`);
    await c.audit('ideas limited');
    await c.snap();
  });

  add('ideas-limited-prices', false, async (c) => {
    const { page } = c;
    const t = await playLimited(c, fx.limitedWeb);
    check(`${c.name}/ideas: when web search ran out, the note says prices were not checked and place links are missing`, /Web search is paused until 00:00 UTC/.test(t) && /prices were not checked/.test(t) && !/Shop search/.test(t), t.slice(0, 120));
    check(`${c.name}/ideas: the buy buttons stay and each price line says its check was paused, not that the price matches`, (await count(page, 'button.pick')) === 9 && (await count(page, '.check[data-state=paused]')) === 3 && (await count(page, '.check[data-state=confirmed]')) === 0 && /^Price check paused until 00:00 UTC$/.test((await text(page, '.check[data-state=paused]')) || '') && (await count(page, '.idea .note.paused')) === 1, `${await count(page, 'button.pick')} buy buttons, ${await count(page, '.check[data-state=paused]')} paused lines`);
    await c.snap();
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
  payError('checkout-error-session', err(404, 'session_expired', 'The saved prices are gone, so this gift cannot be ordered. Start over, or replay the saved example.'), 'Your session expired', ['Start over', 'Replay the saved example'], 'Start over');
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
  // The same checkout with the photos hidden: the before/after pictures in evidence/first-build/ are made from this (shop photos are third-party and stay out of tracked files).
  add('checkout-images-off', false, async (c) => {
    await open(c, '#/checkout', { st: ckSt(c), search: '?images=off' });
    const shown = await c.page.evaluate(() => [...document.querySelectorAll('.thumb img')].filter((i) => i.getClientRects().length && getComputedStyle(i).display !== 'none').length);
    check(`${c.name}/checkout: ?images=off hides the line photos`, (await text(c.page, 'h1')) === 'Checkout' && shown === 0, `${shown} shown`);
    await c.snap();
  });

  // "Copy note": one true sentence to send along with an idea, built from the favourites its card names (spelled out here, not imported from public/note.js).
  const noteOf = (names) => `I picked this because you love ${names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}.\n\n`;
  const MEMORY = 'Add one memory only you can write.';
  add('ideas-copy-note', false, async (c) => {
    const { page } = c;
    await open(c, '#/ideas', { st: c.done });
    await page.waitForSelector('article.idea:not(.skeleton) .because');
    const ideas = await page.$$eval('article.idea:not(.skeleton)', (l) => l.map((a) => ({ title: a.querySelector('h2').textContent, names: [...a.querySelectorAll('.because.named .pill-soft')].map((e) => e.textContent), label: a.querySelector('.note-row button.copy')?.getAttribute('aria-label') ?? null })));
    const arts = await page.$$('article.idea:not(.skeleton)');
    // three cards that name a favourite, with notes that differ from their neighbours' (so a copy that did nothing cannot pass for the last one); prefer one that names two or three
    const named = ideas.map((_, k) => k).filter((k) => ideas[k].names.length);
    const note = (k) => noteOf(ideas[k].names);
    const a = named[0];
    const b = named.find((k) => ideas[k].names.length > 1 && note(k) !== note(a)) ?? named.find((k) => note(k) !== note(a));
    const f = named.find((k) => k !== a && k !== b) ?? b;
    check(`${c.name}/ideas: every idea that names a favourite has a "Copy note" button named after it, and no other idea has one`, a >= 0 && b > -1 && ideas.every((i) => i.label === (i.names.length ? `Copy note: ${i.title}` : null)), ideas.map((i) => `${i.names.length}:${i.label}`).join(' | ').slice(0, 200));
    check(`${c.name}/ideas: "${MEMORY}" is not on screen until a note is copied`, !(await page.evaluate(() => document.body.innerText.includes('Add one memory'))));

    // the hero line: "Because they love X" is the largest text of a card that names a favourite (type scale only, no new colour)
    const hero = await page.$$eval('article.idea:not(.skeleton)', (l) => l.filter((x) => x.querySelector('.because.named')).map((x) => { const px = (q) => parseFloat(getComputedStyle(x.querySelector(q)).fontSize); return { label: px('.because-lbl'), pill: px('.because.named .pill-soft'), title: px('h2'), reason: px('.reason'), kind: px('.kind') }; }));
    check(`${c.name}/ideas: on every card that names a favourite, "Because they love X" is bigger than the title, the reason and the kind label`, hero.length > 0 && hero.every((x) => x.label > x.title && x.pill > x.title && x.label > x.reason && x.label > x.kind), JSON.stringify(hero[0]));

    // Chromium without the clipboard permission (every round but the desktop one) records the write instead; the desktop round reads the real clipboard back
    const rec = !c.clip;
    if (rec) await page.evaluate(() => { window.__clip = []; navigator.clipboard.writeText = async (t) => { window.__clip.push(t); }; });
    const clipboard = () => (rec ? page.evaluate(() => window.__clip.at(-1) ?? null) : page.evaluate(() => navigator.clipboard.readText()));
    const pressed = async (k, key) => {
      if (rec) await page.evaluate(() => { window.__clip = []; });
      const before = await clipboard();
      await (await arts[k].$('.note-row button.copy')).focus();
      await page.keyboard.press(key);
      let got = before;
      for (let i = 0; i < 20 && got === before; i++) { await sleep(100); got = await clipboard(); }
      return got; // still `before` when nothing was copied
    };
    const how = rec ? 'recorded write' : 'real clipboard';
    const entered = await pressed(a, 'Enter');
    check(`${c.name}/ideas: Enter on a focused "Copy note" button copies "${note(a).trim()}" and a blank line (${how})`, entered === note(a), JSON.stringify(entered));
    const spaced = await pressed(b, 'Space');
    check(`${c.name}/ideas: Space on another card's button copies that card's note, which names ${ideas[b].names.length} favourite${ideas[b].names.length > 1 ? 's, all of them' : ''} (${how})`, spaced === note(b), JSON.stringify(spaced));
    await sleep(150);
    const done = await arts[a].$eval('.note-row', (r) => ({ status: r.querySelector('.note-status').textContent, shown: !r.querySelector('.note-status').hidden, boxHidden: r.querySelector('.note-box').hidden }));
    check(`${c.name}/ideas: after the copy the card says "Copied. ${MEMORY}" (the live region carries the last card's words)`, done.shown && done.boxHidden && done.status === `Copied. ${MEMORY}` && (await text(page, '#live')) === `Copied. ${MEMORY}`, `${done.status} / ${await text(page, '#live')}`);

    // no clipboard at all (the API refuses, the old copy command fails too): the note shows in a box to copy by hand
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; document.execCommand = () => false; });
    await (await arts[f].$('.note-row button.copy')).focus();
    await page.keyboard.press('Enter');
    await sleep(250);
    const fb = await arts[f].$eval('.note-row', (r) => { const box = r.querySelector('.note-box'); return { shown: !box.hidden && box.getClientRects().length > 0, readOnly: box.readOnly, value: box.value, label: box.getAttribute('aria-label'), focused: document.activeElement === box, all: box.selectionStart === 0 && box.selectionEnd === box.value.length, status: r.querySelector('.note-status').textContent, statusShown: !r.querySelector('.note-status').hidden, below: box.getBoundingClientRect().top >= r.querySelector('.note-status').getBoundingClientRect().bottom - 1 }; });
    check(`${c.name}/ideas: when copying fails, the note shows in a focused, selected, read-only box that has a name, below the Ctrl+C line (which says "below") and the memory line`, fb.shown && fb.below && fb.readOnly && fb.value === note(f) && fb.label === `Note for ${ideas[f].title}` && fb.focused && fb.all && fb.statusShown && fb.status === `Could not copy by itself. Press Ctrl+C to copy the note below. ${MEMORY}`, JSON.stringify(fb));
    await c.audit('ideas copy note');
    if (c.sweep) await overflowSweep(page, `${c.name}/ideas copy note`);
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
      if (!c.done && !['home-empty', 'home-filled', 'home-error-favs', 'home-error-budget', 'ideas-running-early', 'ideas-running-mid', 'ideas-error-partial', 'ideas-example', 'home-live-example'].includes(s.key)) throw new Error('needs the example run first');
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
