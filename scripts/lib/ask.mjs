// Phase "ask" of scripts/e2e.mjs: "Ask them without spoiling it", in a real browser at desktop and phone width.
// Every page here talks to the dev server through a recording proxy, so the checks read what a server really receives:
//   - no request carries a reply link's fragment (#loves=…), not in its line, its headers or its body;
//   - the /ask page makes no request of its own, not even after "Make my reply link";
//   - the proxy lets only static files, /api/status and the one search the giver starts through. That search is recorded as sent and answered
//     from the keyless saved example, so no billed service (Qloo, the model, Channel3, Tavily) can be reached from this phase.
import http from 'node:http';
import { decodeLoves } from '../../public/loves.js';
import { BASE, DESKTOP, FIREFOX, MOBILE, audit, check, consoleErrors, fresh, newPage, overflowSweep, say, shot, sleep, tabWalk, waitUrl } from './browser.mjs';

const LOVES = [
  { text: 'עומר אדם', type: 'artist', label: 'Artist' }, // Hebrew
  { text: '千と千尋の神隠し', type: 'movie', label: 'Movie' }, // Japanese
  { text: '🎸 Rock', type: '', label: '' }, // emoji
  { text: 'Kafka on the Shore', type: 'book', label: 'Book' },
];
const PLAIN = LOVES.map(({ text, type }) => ({ text, type }));
const LEAD = 'A friend wants to know what you love lately. Nothing is stored: your answer travels inside the link you send back.';
const FEW_YOU = 'Add at least 3 things you love, so your friend has something to go on.';
const SPOILERS = /gift|paypal|sandbox|budget|surprise|\bbuy\b|shop|product|price/i;
const BAD_LINE = 'That reply link could not be read, so nothing was filled in.';
const SELF_LEAD = 'Name three to five things you love. Nothing is stored: your answer travels inside the link you make.';
const SELF_FEW = 'Add at least 3 things you love, so your link has something to go on.';
const SELF_SENT = 'Send this to whoever buys you gifts. They see what you love, not what you will get.'; // the brief's sentence, word for word
const USAGE = ['ideas', 'qloo', 'ai', 'neurons', 'tavily', 'channel3', 'orders'];
const MINE = [{ text: 'Mine one', type: '' }, { text: 'Mine two', type: 'book' }, { text: 'Mine three', type: 'artist' }];

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
const same = (a, b) => canon(a) === canon(b);
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
const chipsOf = (page) => page.$$eval('ul.chips li.chip', (l) => l.map((li) => [li.querySelector('.chip-text').textContent, li.querySelector('.chip-type')?.textContent || '']));
const frag = (v) => 'loves=' + Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const usage = async () => (await (await fetch(BASE + '/api/status')).json()).usage || {};

/** /ask has no nav and its brand is plain text: nothing on the page leads on to the gift home page. */
async function plainBrand(page, L) {
  const r = await page.evaluate(() => ({ hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')), brand: document.querySelector('header .brand')?.tagName, text: document.querySelector('header .brand')?.textContent.trim(), navs: document.querySelectorAll('nav').length }));
  check(`${L}: the header brand "Tasteloom" is plain text (no link, no nav) and the page links nowhere but its skip link`, r.brand === 'DIV' && r.text === 'Tasteloom' && r.navs === 0 && r.hrefs.join() === '#main', JSON.stringify(r));
}

/** A recording reverse proxy in front of the dev server: an allowlist, not a filter (see the top of this file). */
async function startProxy() {
  const log = []; // everything the browser sent: request line, raw headers, body
  const blocked = []; // refused by the allowlist (must stay empty)
  const searches = []; // POST /api/ideas, answered from the saved example
  const outside = []; // requests the browser made to any other address (the proxy cannot see those)
  let origin = '';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    res.on('error', () => {}); // the browser may leave mid-stream (the page is closed while the saved example streams)
    const entry = { method: req.method, url: req.url, headers: req.rawHeaders.join('\n'), body };
    log.push(entry);
    const p = req.url.split('?')[0];
    let to = req.url;
    let payload = body;
    if (req.method === 'POST' && p === '/api/ideas') {
      searches.push(entry);
      to = '/api/sample';
      payload = '{}';
    } else if (!(req.method === 'GET' && (!p.startsWith('/api/') || p === '/api/status'))) {
      blocked.push(entry);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refused by the e2e allowlist');
      return;
    }
    try {
      const post = req.method === 'POST';
      const r = await fetch(BASE + to, { method: post ? 'POST' : 'GET', headers: { 'content-type': req.headers['content-type'] || 'text/plain', accept: req.headers.accept || '*/*' }, body: post ? payload : undefined, redirect: 'manual' });
      const headers = {};
      for (const [k, v] of r.headers) if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) headers[k] = k === 'location' ? v.replace(BASE, origin) : v;
      res.writeHead(r.status, headers);
      if (r.body) for await (const c of r.body) { if (res.destroyed) break; res.write(c); }
      res.end();
    } catch {
      res.destroy(); // the browser went away mid-stream, or the dev server did
    }
  });
  await new Promise((r) => server.listen(0, r));
  origin = `http://localhost:${server.address().port}`;
  return { origin, log, blocked, searches, outside, close: () => { server.closeAllConnections(); server.close(); } };
}

async function tracked(ctx, vp, label, proxy) {
  const page = await newPage(ctx, vp, label);
  page.on('request', (r) => { if (/^https?:/.test(r.url()) && !r.url().startsWith(proxy.origin)) proxy.outside.push(r.url().replace(/#.*/, '#…')); });
  return page;
}

// ---- the giver's first screen: the link to send ---------------------------------------------------------------------------
async function giverPanel(ctx, vp, proxy) {
  const L = `ask/giver ${vp.width}`;
  const page = await tracked(ctx, vp, L, proxy);
  await fresh(page, proxy.origin);
  const closed = (await page.$$('button.link-btn')).length === 1 && (await text(page, 'button.link-btn')) === 'Not sure what they love? Ask them' && (await page.$eval('button.link-btn', (e) => e.getAttribute('aria-expanded'))) === 'false' && (await page.$eval('#ask-panel', (e) => e.hidden));
  check(`${L}: one short link "Not sure what they love? Ask them" on the favourites step, closed at first`, closed);
  check(`${L}: the link sits in the favourites field`, await page.$eval('#ask-panel', (e) => !!e.closest('.field')?.querySelector('#fav-input')));
  await page.click('button.link-btn');
  const open = (await page.$eval('button.link-btn', (e) => e.getAttribute('aria-expanded'))) === 'true' && (await page.$eval('#ask-panel', (e) => !e.hidden));
  const link = await page.$eval('#ask-panel .link-box', (e) => e.value);
  const inputs = await page.$$eval('#ask-panel input, #ask-panel textarea, #ask-panel select', (l) => l.map((e) => `${e.type}${e.readOnly ? ' readonly' : ''}`));
  check(`${L}: it opens a link to send, ${proxy.origin}/ask, with no name, no email, no account`, open && link === `${proxy.origin}/ask` && inputs.join() === 'text readonly', `${link}; fields: ${inputs.join()}`);
  if (!FIREFOX) {
    await page.click('#ask-panel .btn.copy');
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e.message}`);
    check(`${L}: "Copy" puts the link on the clipboard and says Copied`, clip === link && /Copied/.test(await text(page, '#ask-panel .btn.copy')), `${clip}`);
  }
  const hasShare = (await page.$$eval('#ask-panel button', (l) => l.some((b) => b.textContent.trim() === 'Share')));
  check(`${L}: a Share button shows exactly where the browser has Web Share`, hasShare === (await page.evaluate(() => typeof navigator.share === 'function')), `Share button ${hasShare}`);
  await audit(page, `${L} with the link open`);
  if (vp === DESKTOP) await overflowSweep(page, `${L} with the link open`);
  await shot(page, 'ask-giver-panel');
  await page.close();
}

// ---- the friend's page ---------------------------------------------------------------------------------------------------
async function friendRound(ctx, vp, proxy) {
  const L = `ask/friend ${vp.width}`;
  const page = await tracked(ctx, vp, L, proxy);
  const from = proxy.log.length;
  const res = await page.goto(`${proxy.origin}/ask`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#fav-input');
  const hd = res.headers();
  check(`${L}: /ask comes with the site's security headers (script-src 'self', no inline code, no referrer)`, res.status() === 200 && /script-src 'self'/.test(hd['content-security-policy'] || '') && hd['referrer-policy'] === 'no-referrer', `${res.status()}`);
  await sleep(500);
  const loaded = proxy.log.length;
  const assets = proxy.log.slice(from, loaded);
  check(`${L}: the page loads from static files only (${assets.length} requests, none to /api)`, assets.length > 0 && assets.every((e) => e.method === 'GET' && !e.url.startsWith('/api/')), assets.map((e) => e.url).join(' '));
  check(`${L}: a friend's page never loads the taste-link words (own.js)`, assets.every((e) => !e.url.includes('own.js')), assets.map((e) => e.url).join(' '));
  check(`${L}: the one line of copy is the brief's, word for word`, (await text(page, '.lead')) === LEAD, `${await text(page, '.lead')}`);
  await plainBrand(page, L);
  const seen = await page.evaluate(() => [document.title, document.querySelector('meta[name=description]')?.content, document.body.innerText, ...[...document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')].flatMap((e) => [e.getAttribute('aria-label'), e.title, e.getAttribute('alt'), e.getAttribute('placeholder')])].filter(Boolean).join('\n'));
  check(`${L}: nothing on the page (title, description, text, labels) mentions a gift, PayPal, a sandbox, a budget or shopping`, !SPOILERS.test(seen), (seen.match(SPOILERS) || [''])[0]);
  check(`${L}: the field speaks to the friend ("Things you love", "Your favourites will show up here")`, (await text(page, 'label[for=fav-input]')) === 'Things you love' && (await page.$eval('ul.chips', (el) => getComputedStyle(el, '::before').content)) === '"Your favourites will show up here"', await page.$eval('ul.chips', (el) => getComputedStyle(el, '::before').content));
  await audit(page, `${L} empty`, '1011');
  await tabWalk(page, L);
  if (vp === DESKTOP) await overflowSweep(page, L); // the sweep drops phone emulation, which reloads the page
  await shot(page, 'ask-friend-empty');

  await page.click('form button[type=submit]');
  check(`${L}: "Make my reply link" with nothing added asks for three, in the friend's words`, (await text(page, '#fav-error')) === FEW_YOU, `${await text(page, '#fav-error')}`);
  check(`${L}: the form never submits to the server (same address, no request)`, page.url() === `${proxy.origin}/ask` && proxy.log.length === loaded, page.url());

  for (const l of LOVES) {
    await page.type('#fav-input', l.text);
    if (l.type) await page.select('#fav-type', l.type);
    await page.click('.add-row .btn');
  }
  check(`${L}: Hebrew, Japanese and emoji favourites are added with their type hints`, same(await chipsOf(page), LOVES.map((l) => [l.text, l.label])) && (await text(page, '#fav-count')) === '4 of 5 added.', JSON.stringify(await chipsOf(page)));
  await page.click('form button[type=submit]');
  await page.waitForSelector('.result:not([hidden]) .link-box', { visible: true });
  const url = await page.$eval('.result .link-box', (e) => e.value);
  const fragment = url.slice(url.indexOf('#') + 1);
  const dec = decodeLoves(fragment);
  check(`${L}: the reply link is ${proxy.origin}/#loves=… and reads back as exactly what was typed`, url.startsWith(`${proxy.origin}/#loves=`) && dec.ok && same(dec.items, PLAIN), `${url.length} characters`);
  check(`${L}: focus moves to the "Your reply link" heading, and the page says who can read the link`, (await page.evaluate(() => document.activeElement?.id)) === 'result-h' && /Anyone who has this link can read your answer/.test(await text(page, '.result')));
  if (!FIREFOX) {
    await page.click('.result .btn.copy');
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e.message}`);
    check(`${L}: "Copy" puts the reply link on the clipboard and says Copied`, clip === url && /Copied/.test(await text(page, '.result .btn.copy')), clip === url ? '' : `${clip}`);
  }
  await audit(page, `${L} with the reply link`, '1011');
  await shot(page, 'ask-friend-reply');
  const kept = await page.evaluate(() => [sessionStorage.length, localStorage.length, document.cookie.length]);
  check(`${L}: nothing is kept in the browser (no session or local storage, no cookie)`, kept.join() === '0,0,0', kept.join());
  await page.click('ul.chips li.chip:first-child .chip-x');
  check(`${L}: changing the list takes the old link off the page`, await page.$eval('.result', (e) => e.hidden));
  check(`${L}: no request after the page loaded, through typing, two links and a copy`, proxy.log.length === loaded, `${proxy.log.length - loaded} extra`);
  await page.close();
  return { url, fragment };
}

// ---- the taste link: from the home page to /ask?for=me, then the link opened like any reply (the home page's principle line is checked in the tour) ----
async function selfRound(ctx, giverCtx, vp, proxy) {
  const L = `ask/self ${vp.width}`;
  const page = await tracked(ctx, vp, L, proxy);
  await fresh(page, proxy.origin);
  const links = await page.$$eval('a[href="/ask?for=me"]', (l) => l.map((a) => `${a.textContent.trim()}|in form: ${!!a.closest('form')}`));
  check(`${L}: one small link "Make your own taste link" to /ask?for=me, outside the form`, links.join() === 'Make your own taste link|in form: false', links.join());
  await sleep(600); // the home page's own status request has landed
  const from = proxy.log.length;
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('a[href="/ask?for=me"]')]);
  await page.waitForSelector('#fav-input');
  await sleep(500);
  const loaded = proxy.log.length;
  const assets = proxy.log.slice(from, loaded);
  check(`${L}: the link opens ${proxy.origin}/ask?for=me from static files only, and the taste-link words (own.js) load`, page.url() === `${proxy.origin}/ask?for=me` && assets.every((e) => e.method === 'GET' && !e.url.startsWith('/api/')) && assets.some((e) => e.url === '/own.js'), assets.map((e) => e.url).join(' '));
  check(`${L}: heading, title and the one line of copy are the taste link's own`, (await text(page, 'h1')) === 'Make your own taste link' && (await page.title()) === 'Tasteloom: your taste link' && (await text(page, '.lead')) === SELF_LEAD, `${await text(page, '.lead')}`);
  await plainBrand(page, L);
  await audit(page, `${L} empty`, '1011');
  await tabWalk(page, L);
  await shot(page, 'ask-self-empty');

  await page.click('form button[type=submit]');
  check(`${L}: "Make my taste link" with nothing added asks for three, in its own words`, (await text(page, '#fav-error')) === SELF_FEW, `${await text(page, '#fav-error')}`);
  for (const l of LOVES) {
    await page.type('#fav-input', l.text);
    if (l.type) await page.select('#fav-type', l.type);
    await page.click('.add-row .btn');
  }
  await page.click('form button[type=submit]');
  await page.waitForSelector('.result:not([hidden]) .link-box', { visible: true });
  const url = await page.$eval('.result .link-box', (e) => e.value);
  const fragment = url.slice(url.indexOf('#') + 1);
  const dec = decodeLoves(fragment);
  check(`${L}: the taste link is ${proxy.origin}/#loves=… (the reply format) and reads back as exactly what was typed`, url.startsWith(`${proxy.origin}/#loves=`) && dec.ok && same(dec.items, PLAIN), `${url.length} characters`);
  check(`${L}: the result is headed "Your taste link", says the brief's sentence word for word, and focus is on the heading`, (await text(page, '#result-h')) === 'Your taste link' && (await text(page, '.result-lead')) === SELF_SENT && (await page.evaluate(() => document.activeElement?.id)) === 'result-h', `${await text(page, '.result-lead')}`);
  if (!FIREFOX) {
    await page.click('.result .btn.copy');
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e.message}`);
    check(`${L}: "Copy" puts the taste link on the clipboard and says Copied`, clip === url && /Copied/.test(await text(page, '.result .btn.copy')), clip === url ? '' : `${clip}`);
  }
  await audit(page, `${L} with the link`, '1011');
  await shot(page, 'ask-self-reply');
  const kept = await page.evaluate(() => [sessionStorage.length, localStorage.length, document.cookie.length]);
  check(`${L}: nothing is kept in the browser (no session or local storage, no cookie)`, kept.join() === '0,0,0', kept.join());
  check(`${L}: no request after the page loaded, through typing, the link and a copy`, proxy.log.length === loaded, `${proxy.log.length - loaded} extra`);
  await page.close();

  const g = await tracked(giverCtx, vp, `${L} opened`, proxy);
  await g.goto(url, { waitUntil: 'load' });
  await g.waitForSelector('ul.chips li.chip');
  const notes = await g.$$eval('.note', (l) => l.map((e) => `${e.className}|${e.textContent.trim()}`));
  check(`${L}: whoever buys the gifts opens the taste link like any reply: favourites filled in, one line says so, fragment gone`, same(await chipsOf(g), LOVES.map((l) => [l.text, l.label])) && notes.join() === 'note info|Filled from their reply' && g.url() === `${proxy.origin}/`, `${notes.join(' || ')} ${g.url().replace(/#.*/, '#…')}`);
  await g.close();
  return { fragment };
}

// ---- the giver opens the reply ---------------------------------------------------------------------------------------------
async function giverOpens(ctx, vp, proxy, reply) {
  const L = `ask/reply ${vp.width}`;
  const page = await tracked(ctx, vp, L, proxy);
  await page.goto(reply.url, { waitUntil: 'load' });
  await page.waitForSelector('ul.chips li.chip');
  check(`${L}: the fragment is gone from the address bar`, page.url() === `${proxy.origin}/`, page.url().replace(/#.*/, '#…'));
  check(`${L}: the favourites and their type hints are filled in`, same(await chipsOf(page), LOVES.map((l) => [l.text, l.label])) && (await text(page, '#fav-count')) === '4 of 5 added.', JSON.stringify(await chipsOf(page)));
  const notes = await page.$$eval('.note', (l) => l.map((e) => `${e.className}|${e.textContent.trim()}`));
  check(`${L}: one line says "Filled from their reply"`, notes.length === 1 && notes[0] === 'note info|Filled from their reply', notes.join(' || '));
  await audit(page, `${L} prefilled`);
  await shot(page, 'ask-giver-prefilled');

  const sent = proxy.searches.length;
  await page.click('form button[type=submit]'); // "Find gift ideas": the usual search, with the default budget
  const t0 = Date.now();
  while (proxy.searches.length === sent && Date.now() - t0 < 20000) await sleep(200);
  const body = proxy.searches[sent] ? JSON.parse(proxy.searches[sent].body) : null;
  const want = { favorites: LOVES.map((l) => ({ text: l.text, ...(l.type ? { type: l.type } : {}) })), budget_usd: 100 };
  check(`${L}: the usual search runs from the filled-in list (one POST /api/ideas with exactly the friend's favourites)`, proxy.searches.length === sent + 1 && same(body, want), JSON.stringify(body)?.slice(0, 160));
  await page.goto('about:blank'); // stops the saved-example stream
  await page.close();
}

// ---- extras at desktop width: the other ways in, bad input, the share sheet ------------------------------------------------
async function homeWith(page, proxy, favorites) {
  await page.goto(`${proxy.origin}/`, { waitUntil: 'load' });
  await page.evaluate((f) => sessionStorage.setItem('tasteloom.v1', JSON.stringify({ favorites: f, budget: 100 })), favorites);
  await page.goto('about:blank');
  await page.goto(`${proxy.origin}/`, { waitUntil: 'load' });
  await page.waitForSelector('ul.chips li.chip');
}
const inTab = async (page, fragment) => {
  await page.evaluate((f) => { location.hash = `#${f}`; }, fragment);
  await page.waitForFunction(() => location.hash === '' && !!document.querySelector('.note'), { timeout: 5000 });
};

async function extras(ctx, proxy) {
  const L = 'ask/extras 1280';
  const page = await tracked(ctx, DESKTOP, L, proxy);

  // the reply arrives while the giver is already on the page (a hash change, no reload)
  await homeWith(page, proxy, MINE);
  const two = [{ text: 'Nujabes', type: 'artist' }, { text: '宮崎駿', type: '' }];
  await inTab(page, frag(two));
  const notes = await page.$$eval('.note', (l) => l.map((e) => e.textContent.trim()));
  check(`${L}: a reply that arrives in the open tab fills in the list, takes the fragment away, and says so`, same(await chipsOf(page), [['Nujabes', 'Artist'], ['宮崎駿', '']]) && page.url() === `${proxy.origin}/` && same(notes, ['Filled from their reply']), `${page.url().replace(/#.*/, '#…')} ${notes.join(' || ')}`);
  check(`${L}: a reply with fewer than three is filled in, and the screen asks for the rest`, /^2 of 5 added\. Add 1 more/.test(await text(page, '#fav-count')), `${await text(page, '#fav-count')}`);

  // bad input: ignored, one plain line, the giver's own list untouched, the fragment still removed
  const bad = {
    'not base64': 'loves=!!!',
    'not JSON': frag('not json'),
    'an unknown type': frag([{ text: 'a', type: 'gadget' }]),
    'six favourites': frag(Array.from({ length: 6 }, (_, i) => ({ text: `f${i}` }))),
    'a favourite of 81 characters': frag([{ text: 'x'.repeat(81) }]),
    'a fragment far over the length cap': `loves=${'A'.repeat(5000)}`,
    'a duplicate favourite': frag([{ text: 'Same' }, { text: 'same' }]),
  };
  for (const [name, f] of Object.entries(bad)) {
    await homeWith(page, proxy, MINE);
    await inTab(page, f);
    const lines = await page.$$eval('.note', (l) => l.map((e) => `${e.className}|${e.textContent.trim()}`));
    check(`${L}: ${name}: ignored with one plain line, own favourites untouched, fragment removed`, lines.length === 1 && lines[0] === `note warn|${BAD_LINE}` && same(await chipsOf(page), MINE.map((m) => [m.text, { book: 'Book', artist: 'Artist', '': '' }[m.type]])) && page.url() === `${proxy.origin}/`, lines.join(' || '));
  }
  // the same on a fresh load, then a screenshot of the line
  await page.goto('about:blank');
  await page.goto(`${proxy.origin}/#loves=!!!`, { waitUntil: 'load' });
  await page.waitForSelector('.note');
  check(`${L}: a bad reply on a fresh load shows the same single line and leaves the address clean`, (await text(page, '.note')) === BAD_LINE && (await page.$$('.note')).length === 1 && page.url() === `${proxy.origin}/`);
  await shot(page, 'ask-giver-badreply');

  // the share sheet, stubbed: it gets the link, and closing it without sharing is not an error
  await page.close();
  const sp = await tracked(ctx, DESKTOP, `${L} share`, proxy);
  await sp.evaluateOnNewDocument(() => {
    window.__shared = [];
    window.__shareMode = 'ok';
    navigator.share = async (d) => {
      window.__shared.push(d);
      if (window.__shareMode === 'abort') throw new DOMException('closed', 'AbortError');
    };
  });
  await fresh(sp, proxy.origin);
  await sp.click('button.link-btn');
  const shareBtn = await sp.$$('#ask-panel .linkrow button');
  const labels = await Promise.all(shareBtn.map((b) => b.evaluate((e) => e.textContent.trim())));
  check(`${L}: with Web Share present, the panel offers Share`, labels.includes('Share'), labels.join());
  const share = shareBtn[labels.indexOf('Share')];
  await share.click();
  const first = await sp.evaluate(() => window.__shared);
  check(`${L}: Share hands over the link to send and a short line with no hint of the gift`, first.length === 1 && first[0].url === `${proxy.origin}/ask` && typeof first[0].text === 'string' && first[0].text.length > 0 && !SPOILERS.test(first[0].text), JSON.stringify(first));
  const errorsBefore = consoleErrors.length;
  await sp.evaluate(() => { window.__shareMode = 'abort'; });
  await share.click();
  await sleep(300);
  check(`${L}: closing the share sheet without sharing raises no error`, consoleErrors.length === errorsBefore && (await sp.evaluate(() => window.__shared.length)) === 2);
  await sp.close();
}

/** Reads the server's side of everything: the log of what the browser sent. */
function serverView(proxy, fragments) {
  const raw = proxy.log.map((e) => `${e.method} ${e.url}\n${e.headers}\n${e.body}`).join('\n----\n');
  const payloads = fragments.map((f) => f.slice('loves='.length));
  const hits = [];
  if (/loves(=|%3d)/i.test(raw)) hits.push('"loves="');
  for (const p of payloads) if (raw.includes(p)) hits.push('a reply payload');
  const hashed = proxy.log.filter((e) => e.url.includes('#'));
  const roots = proxy.log.filter((e) => e.method === 'GET' && e.url === '/').length;
  check(`ask/server: none of ${proxy.log.length} requests carries a reply link, in its line, headers or body (${payloads.length} real links made, ${roots} page loads of "/" seen)`, hits.length === 0 && hashed.length === 0 && roots >= 2, hits.join(', ') + (hashed.length ? ` ${hashed.length} request lines with a #` : ''));
  const kinds = { static: 0, status: 0, search: proxy.searches.length };
  for (const e of proxy.log) if (e.url === '/api/status') kinds.status++; else if (!e.url.startsWith('/api/')) kinds.static++;
  check('ask/server: the browser made no request to any other address (no third party, no beacon)', proxy.outside.length === 0, proxy.outside.slice(0, 3).join(' '));
  check('ask/server: only static files, /api/status and the giver\'s searches were sent; the allowlist refused nothing', proxy.blocked.length === 0 && kinds.static + kinds.status + kinds.search === proxy.log.length, `${JSON.stringify(kinds)}; refused ${proxy.blocked.map((e) => `${e.method} ${e.url}`).join(', ') || 'none'}`);
}

export async function ask(browser) {
  say('ASK THEM WITHOUT SPOILING IT (desktop 1280 and phone 390, through a recording proxy; no billed service can be reached)');
  const proxy = await startProxy();
  const before = await usage();
  const friendCtx = await browser.createBrowserContext();
  const giverCtx = await browser.createBrowserContext();
  try {
    if (!FIREFOX) for (const c of [friendCtx, giverCtx]) await c.overridePermissions(proxy.origin, ['clipboard-read', 'clipboard-write']);
    const fragments = [];
    for (const vp of [DESKTOP, MOBILE]) {
      await giverPanel(giverCtx, vp, proxy);
      const reply = await friendRound(friendCtx, vp, proxy);
      fragments.push(reply.fragment);
      await giverOpens(giverCtx, vp, proxy, reply);
      fragments.push((await selfRound(friendCtx, giverCtx, vp, proxy)).fragment);
    }
    await extras(giverCtx, proxy);
    serverView(proxy, fragments);
    const after = await usage();
    const delta = Object.fromEntries(USAGE.map((k) => [k, (after[k] ?? 0) - (before[k] ?? 0)]));
    check('ask: no billed call was counted by the dev server (Qloo, model, Channel3, Tavily, orders, runs: all zero)', USAGE.every((k) => delta[k] === 0), JSON.stringify(delta));
  } finally {
    await friendCtx.close().catch(() => {});
    await giverCtx.close().catch(() => {});
    proxy.close();
  }
}
