// Phase "compare" of scripts/e2e.mjs: the "Same AI, without Qloo" panel under the gift ideas, at desktop 1280 and phone 390.
// Run it with the model on its stand-in (FORCE_MOCK=ai or qloo,ai): the phase reads /api/status first and clicks nothing otherwise.
// The server sees only static files, /api/status, the keyless saved example and POST /api/plain (answered by the stand-in model). No run is
// started: /api/ideas is never called (a finished run is seeded into sessionStorage) and the cap and error states are answered inside the page.
// Three clicks per viewport reach the server, so a --keep rerun can meet the per-visitor cap (LIMIT_IP_PLAIN, 8 a day).
import fs from 'node:fs';
import path from 'node:path';
import { BASE, DESKTOP, MOBILE, SHOTS, audit, check, fresh, mock, newPage, overflowSweep, say, shot, sleep } from './browser.mjs';

const KEY = 'tasteloom.v1';
const PLAIN = 'POST /api/plain';
const PROOF = 'https://github.com/Kylne700/tasteloom#compare-in-the-app';
const BTN = 'Compare: same AI, no Qloo';
const USAGE = ['ideas', 'qloo', 'ai', 'neurons', 'tavily', 'channel3', 'orders'];
const API_OK = ['/api/status', '/api/sample', '/api/plain'];
const LIMIT = 'The daily allowance for this comparison is used up. It starts again at 00:00 UTC.';
const TYPED = [{ text: 'Hayao Miyazaki', type: 'person' }, { text: 'Nujabes', type: 'artist' }, { text: 'Kyoto', type: 'place' }];
const SERVER_TEXT = 'text that only the scripted server answer contains'; // the cap state must show the page's own sentence, not the server's
const NOT_SAID = /hidden gems?|chatgpt|chatbot|better gifts?|\bnever\b|\balways\b/i; // wording the panel must not use

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
const usage = async () => (await (await fetch(BASE + '/api/status')).json()).usage || {};
const wire = (f) => ({ text: f.text, ...(f.type ? { type: f.type } : {}) }); // what the page sends for a favourite
const json = (page) => page.evaluate((k) => sessionStorage.getItem(k), KEY).then(JSON.parse);

async function tapText(page, re) {
  for (const el of await page.$$('button, a')) {
    const t = await el.evaluate((e) => (e.getClientRects().length ? (e.textContent || '').trim().replace(/\s+/g, ' ') : ''));
    if (t && re.test(t)) {
      await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await sleep(80);
      return el.click();
    }
  }
  throw new Error(`no visible control matching ${re}`);
}

/** The panel's one button: 'enter' = focus it and press Enter (returns whether it was fully in view and not under the sticky bar), 'click' = a real click. */
async function tapBtn(page, how) {
  const b = await page.waitForSelector('.compare .btn', { visible: true, timeout: 10000 });
  if (how === 'enter') {
    await b.focus();
    const fit = await b.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); });
    await page.keyboard.press('Enter');
    return fit;
  }
  await b.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(100);
  await b.click();
  return true;
}

/** Known state: clear storage, seed a finished run, reload, go to the ideas screen and wait for the panel. */
async function open(page, st) {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate((k, s) => { sessionStorage.clear(); sessionStorage.setItem(k, JSON.stringify(s)); }, KEY, st);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.evaluate(() => { location.hash = '#/ideas'; });
  await page.waitForSelector('section.compare:not([hidden])', { timeout: 10000 });
}

/** Everything the checks read from the panel at one moment. */
const view = (page) => page.evaluate(() => {
  const s = document.querySelector('section.compare');
  const last = [...document.querySelectorAll('.ideas-list article.idea')].at(-1);
  const t = (sel) => s?.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
  const h = s?.querySelector('h2');
  const hr = h?.getBoundingClientRect();
  const li = [...(s?.querySelectorAll('.compare-list li') ?? [])];
  return {
    shown: !!s && !s.hidden && s.getClientRects().length > 0,
    after: !!(last && s && last.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING),
    h2: h?.textContent ?? null,
    lead: t('.compare-lead'), wait: t('.compare-wait'), problem: t('.compare-problem'), count: t('.compare-count'), demo: t('.demo-note'), note: t('.compare-note'),
    buttons: [...(s?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
    gifts: li.map((x) => x.querySelector('.compare-gift')?.firstChild?.textContent ?? ''),
    whys: li.map((x) => x.querySelector('.compare-why')?.textContent ?? ''),
    tags: [...(s?.querySelectorAll('.compare-tag') ?? [])].map((x) => x.textContent),
    links: [...(s?.querySelectorAll('a') ?? [])].map((a) => ({ href: a.href, target: a.target, rel: a.rel })),
    focus: document.activeElement?.id || document.activeElement?.tagName,
    headClear: !!h && hr.top >= 0 && hr.bottom <= innerHeight && h.contains(document.elementFromPoint(hr.left + 4, hr.top + hr.height / 2)),
    live: document.getElementById('live')?.textContent ?? null,
    text: s?.textContent.replace(/\s+/g, ' ').trim() ?? '',
  };
});

/** Tab from the panel heading: every control it reaches inside the panel shows a focus ring (outline of 2 px or more, or a shadow). */
async function rings(page, L) {
  await page.evaluate(() => document.getElementById('compare-h').focus());
  const stops = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e?.closest('section.compare')) return null;
      const cs = getComputedStyle(e);
      return { name: (e.textContent || '').trim().slice(0, 24), ring: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || cs.boxShadow !== 'none' };
    });
    if (!s) break;
    stops.push(s);
  }
  check(`${L}: Tab from the heading reaches the panel's controls, each with a visible focus ring`, stops.length >= 1 && stops.every((s) => s.ring), JSON.stringify(stops));
}

/** A picture of the panel alone (evidence/screens/, ignored by git). */
async function pic(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const el = await page.$('section.compare');
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await el.screenshot({ path: path.join(SHOTS, `compare-${name}-${page.viewport().width}.png`) });
}

async function round(browser, vp, name) {
  const ctx = await browser.createBrowserContext();
  const page = await newPage(ctx, vp, name);
  const mine = [];
  page.on('request', (r) => { if (r.url().startsWith(BASE + '/api/')) mine.push({ path: new URL(r.url()).pathname, body: r.postData() }); });
  const sent = () => mine.filter((r) => r.path === '/api/plain');
  const L = `${name}/compare`;
  const settle = (sel) => page.waitForSelector(sel, { timeout: 10000 }).then(() => sleep(250)); // the live region fills 30 ms after the text changes
  let v;

  // 1. the saved example (the path of a run that has just finished)
  await fresh(page);
  await tapText(page, /^Try an example$/);
  await page.waitForFunction(() => /Done in/.test(document.querySelector('.agent-status')?.textContent || ''), { timeout: 60000 });
  await sleep(400);
  const done = await json(page);
  v = await view(page);
  check(`${L}/example: the panel appears under the ideas with its heading, one button and a lead that says what the click sends`, v.shown && v.after && v.h2 === 'Same AI, without Qloo' && v.buttons.join('|') === BTN && v.lead === 'Ask the same AI model for gift ideas from the example’s favourites, with no Qloo data. The click sends only the favourites and the budget.', JSON.stringify({ shown: v.shown, after: v.after, h2: v.h2, buttons: v.buttons, lead: v.lead }));
  check(`${L}/example: nothing is sent before the click`, sent().length === 0, `${sent().length} requests`);
  await pic(page, 'idle');
  const fit = await tapBtn(page, name === 'desktop' ? 'enter' : 'click');
  if (name === 'desktop') check(`${L}/example: the button is fully in view and not under the sticky bar when it takes focus`, fit);
  await settle('.compare-count');
  v = await view(page);
  const body = JSON.parse(sent()[0]?.body ?? 'null');
  check(`${L}/example: one click sends one POST /api/plain holding the favourites and the budget and nothing else`, sent().length === 1 && canon(body) === canon({ favorites: done.run.favorites.map(wire), budget_usd: done.run.budget_cents / 100 }), `${sent().length} requests, ${sent()[0]?.body}`);
  check(`${L}/example: four plain ideas with a reason each; the count line matches the two tagged ones`, v.gifts.length === 4 && v.whys.every(Boolean) && v.tags.length === 2 && v.tags.every((t) => t === 'names a favourite') && v.count === '2 of 4 name one of the example’s favourites.' && v.gifts[0] === `Framed poster of ${done.run.favorites[0].text}`, JSON.stringify({ count: v.count, tags: v.tags, gifts: v.gifts }));
  check(`${L}/example: it says this is demo data, that the ideas above are a recording, and why the favourites are tagged`, /^Demo data: no AI model is connected on this server/.test(v.demo ?? '') && /saved recording/.test(v.note) && /does not offer the favourites themselves as ideas/.test(v.note), `${v.demo} | ${v.note}`);
  check(`${L}/example: one link to the measurement that opens safely in a new tab, and no second button once the ideas are in`, v.links.length === 1 && v.links[0].href === PROOF && v.links[0].target === '_blank' && /noopener/.test(v.links[0].rel) && /noreferrer/.test(v.links[0].rel) && v.buttons.length === 0, JSON.stringify({ links: v.links, buttons: v.buttons }));
  check(`${L}/example: focus is on the panel heading, in view and not under the sticky bar, and the count line was announced`, v.focus === 'compare-h' && v.headClear && v.live === v.count, JSON.stringify({ focus: v.focus, clear: v.headClear, live: v.live }));
  check(`${L}/example: no word the panel must not use`, !NOT_SAID.test(v.text), v.text.match(NOT_SAID)?.[0] ?? '');
  check(`${L}/example: the answer is kept on the run (sessionStorage), so coming back costs no call`, (await json(page)).run.plain?.ideas?.length === 4);
  await audit(page, `${L}/example`);
  if (name === 'desktop') await overflowSweep(page, `${L}/example`);
  await rings(page, `${L}/example`);
  await shot(page, 'compare-example');
  await pic(page, 'result-example');
  // a reload, and a trip to the first screen and back, show the kept answer with no second request
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.compare-count', { timeout: 10000 });
  const again = await view(page);
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Gifts that understand them', { timeout: 10000 });
  await page.evaluate(() => history.back());
  await page.waitForSelector('.compare-count', { timeout: 10000 });
  const back = await view(page);
  check(`${L}/example: after a reload and after a trip to the first screen and back, the same ideas show with no new request and no button`, sent().length === 1 && [again, back].every((x) => x.count === v.count && x.gifts.join() === v.gifts.join() && x.buttons.length === 0), `${sent().length} requests, ${again.count} / ${back.count}`);

  // 2. a finished run of typed favourites (a person among them, a budget with cents)
  const typed = { ...done, favorites: TYPED, budget: 49.99, selected: [], run: { ...done.run, example: false, mocks: ['qloo', 'ai'], favorites: TYPED, budget_cents: 4999, plain: undefined } };
  await open(page, typed);
  v = await view(page);
  check(`${L}/typed: the lead names the favourites you typed`, v.shown && v.lead === 'Ask the same AI model for gift ideas from the favourites you typed, with no Qloo data. The click sends only the favourites and the budget.', v.lead ?? '');
  await pic(page, 'idle-typed');
  let n = sent().length;
  await tapBtn(page, 'click');
  await settle('.compare-count');
  v = await view(page);
  check(`${L}/typed: the request holds the typed favourites with their types and the budget 49.99, nothing else`, sent().length === n + 1 && canon(JSON.parse(sent()[n]?.body ?? 'null')) === canon({ favorites: TYPED, budget_usd: 49.99 }), sent()[n]?.body ?? 'no request');
  check(`${L}/typed: two of four ideas name a typed favourite and say so; no recording sentence`, v.count === '2 of 4 name a favourite you typed.' && v.tags.length === 2 && v.tags.every((t) => t === 'names your favourite') && v.gifts[0] === 'Framed poster of Hayao Miyazaki' && v.gifts[1] === 'Illustrated book about Nujabes' && /^Same model, only the favourites you typed, no taste data\./.test(v.note) && !/recording/.test(v.note), JSON.stringify({ count: v.count, tags: v.tags, note: v.note }));
  check(`${L}/typed: no word the panel must not use`, !NOT_SAID.test(v.text), v.text.match(NOT_SAID)?.[0] ?? '');
  await audit(page, `${L}/typed`);
  await pic(page, 'result-typed');

  // 3. the daily allowance is used up (the server answers 429 "limit")
  await open(page, typed);
  await mock(page, PLAIN, { status: 429, json: { error: { code: 'limit', message: SERVER_TEXT } } });
  await tapBtn(page, 'click');
  await settle('.compare-problem');
  v = await view(page);
  check(`${L}/cap: the page says the allowance is used up in its own words, offers no retry and links to the measurement`, v.problem === LIMIT && !v.text.includes(SERVER_TEXT) && v.buttons.length === 0 && v.links.length === 1 && v.links[0].href === PROOF, JSON.stringify({ problem: v.problem, buttons: v.buttons }));
  check(`${L}/cap: focus is on the panel heading and the sentence was announced`, v.focus === 'compare-h' && v.headClear && v.live === LIMIT, JSON.stringify({ focus: v.focus, live: v.live }));
  await audit(page, `${L}/cap`);
  await rings(page, `${L}/cap`);
  await pic(page, 'cap');

  // 4. the AI service fails (502), then Try again reaches the stand-in
  await open(page, typed);
  await mock(page, PLAIN, { status: 502, json: { error: { code: 'upstream', message: 'Please try again in a minute.' } } });
  await tapBtn(page, 'click');
  await settle('.compare-problem');
  v = await view(page);
  check(`${L}/error: one calm sentence, a Try again button and the link; focus on the heading, sentence announced`, v.problem === 'The plain ideas could not be fetched. Please try again in a minute.' && v.buttons.join('|') === 'Try again' && v.links.length === 1 && v.focus === 'compare-h' && v.live === v.problem, JSON.stringify({ problem: v.problem, buttons: v.buttons, focus: v.focus }));
  await audit(page, `${L}/error`);
  await rings(page, `${L}/error`);
  await pic(page, 'error');
  await mock(page, PLAIN, null); // the next call goes to the server's stand-in model
  n = sent().length;
  await tapBtn(page, 'click');
  await settle('.compare-count');
  v = await view(page);
  check(`${L}/error: Try again asks once more and shows the ideas`, sent().length === n + 1 && v.count === '2 of 4 name a favourite you typed.' && !v.problem && v.buttons.length === 0, `${sent().length - n} requests, ${v.count}`);

  // 5. while the model is answering
  await open(page, typed);
  await mock(page, PLAIN, { hang: true });
  await tapBtn(page, 'click');
  await settle('.compare-wait');
  v = await view(page);
  check(`${L}/wait: the wait line replaces the button, focus stays on the heading and the wait was announced`, /^Asking the AI model/.test(v.wait ?? '') && v.buttons.length === 0 && v.focus === 'compare-h' && v.live === 'Asking the AI model for gift ideas without Qloo.', JSON.stringify({ wait: v.wait, buttons: v.buttons, focus: v.focus, live: v.live }));
  await pic(page, 'wait');

  await ctx.close();
  return { plain: sent().length, paths: [...new Set(mine.map((r) => r.path))] };
}

export async function compare(browser) {
  say('COMPARE ("Same AI, without Qloo" under the results, desktop 1280 and phone 390; the model on its stand-in, no billed service can be reached)');
  const st = await (await fetch(BASE + '/api/status')).json();
  const mocked = (st.mocks || []).includes('ai');
  check('compare: the dev server runs the model on its stand-in (start it with FORCE_MOCK=ai or qloo,ai), so no click can reach Workers AI', mocked, `mocks: ${(st.mocks || []).join(',') || 'none'}`);
  if (!mocked) return; // nothing is clicked
  const before = await usage();
  let plain = 0;
  const paths = new Set();
  for (const [vp, name] of [[DESKTOP, 'desktop'], [MOBILE, 'mobile']]) {
    const r = await round(browser, vp, name);
    plain += r.plain;
    r.paths.forEach((p) => paths.add(p));
  }
  const after = await usage();
  const delta = Object.fromEntries([...USAGE, 'plain'].map((k) => [k, (after[k] ?? 0) - (before[k] ?? 0)]));
  check('compare: no billed call was counted (Qloo, model, neurons, Channel3, Tavily, runs, orders: all zero)', USAGE.every((k) => delta[k] === 0), JSON.stringify(delta));
  check('compare: the plain counter moved once per click that reached the server, and no other API route was used but status, sample and plain', delta.plain === plain && plain > 0 && [...paths].every((p) => API_OK.includes(p)), `${plain} clicks reached the server; counter +${delta.plain}; routes ${[...paths].join(', ')}`);
}
