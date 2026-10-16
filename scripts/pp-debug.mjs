import puppeteer from 'puppeteer-core';
import { startDev } from './lib/server.mjs';
const srv = await startDev({ fresh: true });
let browser;
try {
  const res = await fetch(srv.base + '/api/sample', { method: 'POST' });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const meta = events.find((e) => e.t === 'meta'); const idea = events.find((e) => e.t === 'idea');
  const pick = [...idea.cards].sort((a, b) => a.price_cents - b.price_cents).slice(0, 2).map((c) => c.id);
  const cj = await (await fetch(srv.base + '/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: meta.session, itemIds: pick }) })).json();
  browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 1400 });
  await page.goto(cj.approveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input[name=cardnumber], input[name=login_email]', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 4000));
  const info = await page.evaluate(() => ({
    country: document.querySelector('select[name=country]')?.value,
    buttons: [...document.querySelectorAll('button')].filter((e) => e.offsetParent).map((e) => e.innerText.trim()),
    boxes: [...document.querySelectorAll('input[type=checkbox]')].map((e) => ({ id: e.id, checked: e.checked, vis: !!e.offsetParent, near: (e.closest('div,label')?.parentElement?.innerText || '').slice(0, 120).replace(/\s+/g, ' ') })),
    lang: document.documentElement.lang,
  }));
  console.log(JSON.stringify(info, null, 1));
  await page.screenshot({ path: 'evidence/debug/pp-form.png' });
} catch (e) { console.log('ERR', e.message); } finally { await browser?.close(); srv.stop(); }
