// Browser helpers for scripts/e2e.mjs: report, viewports, in-page fetch scripting, screenshots, accessibility and layout probes.
import fs from 'node:fs';
import path from 'node:path';

export const APP = path.resolve(new URL('../..', import.meta.url).pathname);
export const EVIDENCE = path.join(APP, 'evidence');
export const FIREFOX = process.env.TOUR_BROWSER === 'firefox'; // the tour also runs in Firefox over WebDriver BiDi; its shots go to an ignored folder
export const SHOTS = path.join(EVIDENCE, FIREFOX ? 'debug/firefox' : 'screens');
export const PORT = 8791;
export const BASE = `http://localhost:${PORT}`;
export const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1 };
export const TABLET = { width: 768, height: 1024, deviceScaleFactor: 1 };
export const MOBILE = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How often the page says "sandbox" in visible text (display:none text is not counted): the receipt names it twice, in the header badge and in the Mode row.
export const sandboxMentions = (page) => page.evaluate(() => (document.body.innerText.match(/sandbox/gi) || []).length);

// ---- report -------------------------------------------------------------------------------------------------------------
export const report = {
  lines: [],
  failed: 0,
  say(s = '') {
    console.log(s);
    this.lines.push(s);
  },
  check(name, ok, detail = '') {
    if (!ok) this.failed++;
    this.say(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
    return !!ok;
  },
};
export const { say, check } = { say: (s) => report.say(s), check: (n, o, d) => report.check(n, o, d) };

// ---- console errors -----------------------------------------------------------------------------------------------------
export const consoleErrors = []; // from our own origin or uncaught: these fail the run
export const thirdParty = []; // failed loads of third-party resources (shop images): the page drops a broken image by itself
export function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    (!url || url.startsWith(BASE) ? consoleErrors : thirdParty).push(`${label}: ${m.text().slice(0, 140)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${label}: uncaught ${String(e.message).slice(0, 140)}`));
}

// ---- scripting the page's fetch -----------------------------------------------------------------------------------------
/** Runs inside every document: scripted API answers (window.__mock["POST /api/x"]), stream control and a layout-shift counter. */
export function pagePatch() {
  const realFetch = window.fetch.bind(window);
  window.__mock = {};
  window.__stream = {};
  window.__cls = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    // layout-shift entries are Chromium only
  }
  const enc = new TextEncoder();
  window.fetch = (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    const key = `${String(init.method || 'GET').toUpperCase()} ${u.pathname}`;
    const m = window.__mock[key];
    if (!m) return realFetch(input, init);
    if (m.reject) return Promise.reject(new TypeError('Failed to fetch'));
    if (m.hang) return new Promise(() => {});
    if (m.events) {
      const st = { sent: 0, ctl: null };
      window.__stream[key] = st;
      const body = new ReadableStream({ start: (c) => { st.ctl = c; } });
      st.release = (n) => {
        for (let i = 0; i < n && st.sent < m.events.length; i++) st.ctl.enqueue(enc.encode(JSON.stringify(m.events[st.sent++]) + '\n'));
        if (st.sent >= m.events.length && m.close !== false) st.ctl.close();
      };
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    }
    return Promise.resolve(new Response(JSON.stringify(m.json ?? {}), { status: m.status || 200, headers: { 'content-type': 'application/json' } }));
  };
}
export const mock = (page, key, spec) => page.evaluate((k, s) => { window.__mock[k] = s; }, key, spec);
export async function release(page, key, n) {
  await page.waitForFunction((k) => window.__stream[k], { timeout: 10000 }, key);
  await page.evaluate((k, c) => window.__stream[k].release(c), key, n);
}

export async function newPage(ctx, viewport, label) {
  const page = await ctx.newPage();
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(pagePatch);
  watch(page, label);
  return page;
}

/** Empty session, empty first screen. */
export async function fresh(page) {
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('about:blank');
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('#fav-input');
}

// ---- screenshots --------------------------------------------------------------------------------------------------------
export const shots = [];
export const strayText = []; // screens that print a JavaScript leftover such as "null" or "NaN" as text
/** Scrolls through the page so lazy images load, waits for fonts and images (bounded), then takes a full-page screenshot. */
export async function shot(page, name) {
  await page.evaluate(async () => {
    const step = Math.max(300, innerHeight - 100);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 110));
    }
    scrollTo(0, 0);
    await document.fonts.ready;
    const pending = [...document.images].filter((i) => !i.complete);
    await Promise.race([
      Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
      new Promise((r) => setTimeout(r, 7000)),
    ]);
  });
  await sleep(250);
  const vp = page.viewport();
  const file = `${name}-${vp.width}.png`;
  const side = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(`${file}: no sideways scroll`, side.sw <= side.cw, `${side.sw} px wide in a ${side.cw} px window`);
  // the whole wordmark (even text that spills out of its box) must clear the badges
  const crowded = await page.evaluate(() => {
    const b = document.querySelector('.brand');
    const g = document.querySelector('.badges');
    if (!b || !g) return false;
    const r = document.createRange();
    r.selectNodeContents(b);
    const a = r.getBoundingClientRect();
    const c = g.getBoundingClientRect();
    return a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;
  });
  check(`${file}: the brand and the badges do not overlap`, !crowded);
  fs.mkdirSync(SHOTS, { recursive: true });
  // As tall as the page, so the sticky bar and the agent panel show in their natural place instead of floating mid-page.
  const tall = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewport({ ...vp, height: Math.min(Math.max(tall, vp.height), 14000) });
  await sleep(250);
  await page.screenshot({ path: path.join(SHOTS, file), fullPage: true });
  await page.setViewport(vp);
  shots.push(file);
  const stray = await page.evaluate(() => (document.body.innerText.match(/\b(null|undefined|NaN|\[object \w+\])/g) || []).slice(0, 3));
  if (stray.length) strayText.push(`${file}: ${stray.join(', ')}`);
}

// ---- probes -------------------------------------------------------------------------------------------------------------
export async function waitUrl(page, re, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(page.url())) return page.url();
    await sleep(250);
  }
  throw new Error(`timed out waiting for a URL matching ${re}; at ${page.url().replace(/\?.*/, '')}`);
}

/** Labels, language, title, headings, ids, alt text and touch-target size of what is on screen now. */
export async function audit(page, label) {
  const r = await page.evaluate(() => {
    const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const nameOf = (el) => {
      const lb = el.getAttribute('aria-labelledby');
      return (el.getAttribute('aria-label') || (lb && lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ')) || (el.labels ? [...el.labels].map((l) => l.textContent).join(' ') : '') || el.textContent || el.getAttribute('title') || '').trim();
    };
    const ctl = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=switch],[role=button]')].filter(vis);
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    const heads = [...document.querySelectorAll('h1,h2,h3')].map((h) => Number(h.tagName[1]));
    const box = (el) => el.getBoundingClientRect();
    return {
      lang: document.documentElement.lang,
      title: document.title,
      nameless: ctl.filter((el) => !nameOf(el)).map((el) => el.outerHTML.slice(0, 70)),
      small: ctl.filter((el) => (box(el).width < 24 || box(el).height < 24) && !(el.tagName === 'A' && el.closest('p, li'))).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(box(el).width)}x${Math.round(box(el).height)}`),
      dupIds: ids.filter((id, i) => ids.indexOf(id) !== i),
      imgsNoAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).length,
      h1: [...document.querySelectorAll('h1')].filter(vis).length,
      headingSkips: heads.filter((n, i) => i > 0 && n - heads[i - 1] > 1).length,
      // a header or footer inside an article or section is not a page landmark (the idea cards have their own header)
      landmarks: ['main', 'nav', 'header', 'footer'].map((t) => [...document.querySelectorAll(t)].filter((e) => !['header', 'footer'].includes(t) || !e.parentElement.closest('article, aside, main, nav, section')).length).join(''),
      liveRegion: !!document.querySelector('[role=status][aria-live]'),
    };
  });
  check(`${label}: lang and a page title`, r.lang === 'en' && r.title.length > 8, `${r.lang}, "${r.title}"`);
  check(`${label}: every control has an accessible name`, r.nameless.length === 0, r.nameless.slice(0, 3).join(' | '));
  check(`${label}: one visible h1, no skipped heading levels, no duplicate ids, every img has alt`, r.h1 === 1 && r.headingSkips === 0 && r.dupIds.length === 0 && r.imgsNoAlt === 0, `h1 ${r.h1}, skips ${r.headingSkips}, duplicate ids ${r.dupIds.join(',')}, img without alt ${r.imgsNoAlt}`);
  check(`${label}: touch targets at least 24x24 px (inline links excepted)`, r.small.length === 0, r.small.slice(0, 4).join(', '));
  check(`${label}: header, nav, main, footer landmarks and a live region`, r.landmarks === '1111' && r.liveRegion, r.landmarks);
}

/** Presses Tab through the page; every stop must show a focus ring (outline of 2 px or more, or a box shadow). */
export async function tabWalk(page, label, max = 90) {
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  const stops = [];
  const weak = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const cs = getComputedStyle(el);
      const name = (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 28);
      const r = el.getBoundingClientRect();
      return { key: `${el.tagName}#${el.id}.${String(el.className).slice(0, 30)}|${name}|${Math.round(r.top + scrollY)}|${Math.round(r.left)}`, name, ring: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || cs.boxShadow !== 'none', onScreen: r.width > 0 && r.height > 0 };
    });
    if (!s) break;
    if (stops.length && s.key === stops[0].key) break; // wrapped around
    stops.push(s);
    if (!s.ring) weak.push(s.name);
  }
  check(`${label}: ${stops.length} keyboard stops, each with a visible focus ring`, stops.length >= 3 && weak.length === 0, weak.slice(0, 4).join(', '));
  return stops;
}

/** No horizontal scrolling from phone to wide desktop; restores the viewport afterwards. */
export async function overflowSweep(page, label) {
  const keep = page.viewport();
  const bad = [];
  for (const w of [320, 360, 390, 768, 1024, 1280, 1440]) {
    await page.setViewport({ width: w, height: 800, deviceScaleFactor: 1 });
    await sleep(150);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    if (o.sw > o.cw) bad.push(`${w}px: ${o.sw} > ${o.cw}`);
  }
  await page.setViewport(keep);
  check(`${label}: no horizontal scrolling from 320 to 1440 px wide`, bad.length === 0, bad.join('; '));
}

/** Layout shift accumulated since the last reset (Chromium layout-shift entries, user-input shifts excluded). */
export const cls = (page, reset = false) => page.evaluate((r) => { const v = window.__cls; if (r) window.__cls = 0; return Math.round(v * 1000) / 1000; }, reset);
